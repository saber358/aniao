import { type BrowserWindow, type Event, type Session, session, WebContentsView } from "electron";
import { resolveAppAction } from "../domain/app-keybindings.ts";
import {
	type BrowserAction,
	type BrowserLayout,
	type BrowserNavigate,
	type BrowserState,
	normalizeBrowserUrl,
} from "../shared/browser.ts";
import type { Logger } from "../shared/logger.ts";

/*
 * ========================================================================
 * 步骤1：建立与工作台隔离的原生网页视图
 * ========================================================================
 * 数据源：专属浏览器 Session、主窗和受限浏览命令。
 * 操作：1) 不加载工作台 preload；2) 标签身份匹配后才允许操作视图。
 */
export class BrowserService {
	private readonly window: BrowserWindow;
	private readonly logger: Logger;
	private readonly publish: (state: BrowserState) => void;
	private readonly browserSession: Session;
	private view?: WebContentsView;
	private state?: BrowserState;
	private layout?: BrowserLayout;
	private ready = false;
	private committedUrl = "";
	private navigation = 0;
	private allowFile = false;
	private disposed = false;

	constructor(window: BrowserWindow, logger: Logger, publish: (state: BrowserState) => void) {
		this.window = window;
		this.logger = logger;
		this.publish = publish;
		logger.info("开始准备隔离浏览器会话");
		// 1.1 网页登录存储独立于工作台，所有设备和系统权限默认拒绝。
		this.browserSession = session.fromPartition("persist:harness-browser");
		this.browserSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
		this.browserSession.setPermissionCheckHandler(() => false);
		this.browserSession.on("will-download", this.onDownload);
		window.webContents.on("did-start-loading", this.onWorkbenchReload);
		window.once("closed", this.dispose);
		logger.info("隔离浏览器会话准备结束");
	}

	create(id: string): BrowserState {
		this.logger.info("开始创建内置网页视图");
		try {
			if (this.disposed || this.window.isDestroyed()) throw new Error("工作台已关闭");
			if (this.state?.id === id && this.view && !this.view.webContents.isDestroyed()) return { ...this.state };
			this.closeCurrent();
			// 1.2 禁用 Node、子窗口 preload 和 WebView，网页不能调用业务 IPC。
			const view = new WebContentsView({
				webPreferences: {
					session: this.browserSession,
					contextIsolation: true,
					sandbox: true,
					nodeIntegration: false,
					nodeIntegrationInSubFrames: false,
					webviewTag: false,
					webSecurity: true,
					allowRunningInsecureContent: false,
					safeDialogs: true,
					disableDialogs: true,
				},
			});
			this.view = view;
			this.state = {
				id,
				url: "",
				title: "",
				loading: false,
				canGoBack: false,
				canGoForward: false,
				error: null,
				notice: null,
			};
			// 1.6 后台新标签也需要有效视口；显示后由真实右栏布局覆盖。
			view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
			view.setVisible(false);
			this.window.contentView.addChildView(view);
			this.connect(view);
			return { ...this.state };
		} finally {
			this.logger.info("内置网页视图创建结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤2：根据真实导航事件更新地址、历史和加载状态
	 * ========================================================================
	 * 数据源：Chromium 主框架事件与用户地址输入。
	 * 操作：1) 防止旧加载覆盖新导航；2) 失败可重试，取消不伪装成网络错误。
	 */
	navigate(request: BrowserNavigate): void {
		const url = normalizeBrowserUrl(request.url);
		this.allowFile = false;
		this.loadUrl(request.id, url);
	}

	navigateFile(request: { id: string; url: string }): void {
		this.allowFile = true;
		this.loadUrl(request.id, request.url);
	}

	private loadUrl(id: string, url: string): void {
		const view = this.owned(id);
		this.logger.info("开始加载内置网页");
		try {
			const sequence = ++this.navigation;
			this.ready = false;
			this.update({ url, title: "", loading: true, error: null, notice: null });
			// 2.1 不等待完整网页，地址栏的停止按钮在加载期间仍可用。
			void view.webContents.loadURL(url).catch((reason: unknown) => {
				if (this.view !== view || sequence !== this.navigation || view.webContents.isDestroyed()) return;
				if (reason instanceof Error && reason.message.includes("ERR_ABORTED")) return;
				this.update({ loading: false, error: "网页加载失败，请检查地址或网络后重试。" });
			});
		} finally {
			this.logger.info("内置网页加载请求结束");
		}
	}

	action(request: BrowserAction): void {
		const view = this.owned(request.id);
		this.logger.info("开始处理内置浏览器操作");
		try {
			// 2.2 历史由 Chromium 持有，不在 Renderer 中复制一份历史栈。
			const contents = view.webContents;
			if (request.action === "stop") {
				++this.navigation;
				contents.stop();
				this.update({ loading: false, error: this.ready ? null : "页面加载已停止，可点击刷新重试。" });
			} else if (request.action === "reload" && this.state?.url) {
				if (this.state.error || !contents.getURL()) this.navigate({ id: request.id, url: this.state.url });
				else contents.reload();
			} else if (request.action === "back" && contents.navigationHistory.canGoBack()) {
				contents.navigationHistory.goBack();
			} else if (request.action === "forward" && contents.navigationHistory.canGoForward()) {
				contents.navigationHistory.goForward();
			}
		} finally {
			this.logger.info("内置浏览器操作处理结束");
		}
	}

	setLayout(layout: BrowserLayout): void {
		if (this.state?.id !== layout.id || !this.view) return;
		// 3.1 CSS 像素转换为窗口坐标并裁到主窗范围，隐藏标签不能覆盖聊天。
		this.layout = layout;
		this.applyLayout();
	}

	close(id: string): void {
		if (this.state?.id === id) this.closeCurrent();
	}

	/*
	 * ========================================================================
	 * 步骤3：同步原生视图布局并回收网页进程
	 * ========================================================================
	 * 数据源：可见标签的页面占位区域、弹窗遮挡和窗口生命周期。
	 * 操作：1) 隐藏时保留页面状态；2) 关闭、刷新工作台和退出时释放视图。
	 */
	readonly dispose = (): void => {
		if (this.disposed) return;
		this.logger.info("开始回收内置浏览器");
		try {
			this.disposed = true;
			this.closeCurrent();
			this.browserSession.removeListener("will-download", this.onDownload);
			// 窗口关闭事件触发时，webContents 可能已经随 BrowserWindow 一起销毁。
			if (!this.window.isDestroyed()) {
				this.window.webContents.removeListener("did-start-loading", this.onWorkbenchReload);
			}
			this.window.removeListener("closed", this.dispose);
		} catch (error) {
			this.logger.info(`内置浏览器回收失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.logger.info("内置浏览器回收结束");
		}
	};

	private owned(id: string): WebContentsView {
		if (this.state?.id !== id || !this.view || this.view.webContents.isDestroyed()) throw new Error("浏览器标签已关闭");
		return this.view;
	}
	getState(): BrowserState | undefined {
		return this.state ? { ...this.state } : undefined;
	}
	getContents(id: string): Electron.WebContents {
		return this.owned(id).webContents;
	}

	private connect(view: WebContentsView): void {
		const contents = view.webContents;
		const update = (patch: Partial<Omit<BrowserState, "id">>): void => {
			if (this.view === view) this.update(patch);
		};
		// 1.3 普通新窗口链接在当前标签打开，拒绝脚本、文件与系统协议。
		contents.setWindowOpenHandler(({ url }) => {
			if (this.state && this.view === view) {
				try {
					this.navigate({ id: this.state.id, url });
				} catch {
					update({ notice: "该链接不是 HTTP 或 HTTPS 网页。" });
				}
			}
			return { action: "deny" };
		});
		contents.on("will-attach-webview", (event) => event.preventDefault());
		// 1.5 网页获得焦点后，已登记的工作台快捷键仍交给原入口处理。
		contents.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown" || input.isAutoRepeat || (!input.control && !input.meta)) return;
			const action = resolveAppAction(
				{ key: input.key, ctrlKey: input.control, metaKey: input.meta, altKey: input.alt, shiftKey: input.shift },
				undefined,
				this.logger,
			);
			if (!action) return;
			event.preventDefault();
			this.window.webContents.focus();
			this.window.webContents.sendInputEvent({
				type: "keyDown",
				keyCode: input.key,
				modifiers: input.control ? ["control"] : ["meta"],
			});
		});
		contents.on("will-frame-navigate", (event) => {
			if (this.view === view) this.guardNavigation(event, event.url, event.isMainFrame);
		});
		contents.on("will-redirect", (event) => {
			if (this.view === view) this.guardNavigation(event, event.url, event.isMainFrame);
		});
		contents.on("did-start-navigation", (event) => {
			if (!event.isMainFrame || this.view !== view) return;
			if (!event.isSameDocument) this.ready = false;
			update({ url: event.url.slice(0, 8192), loading: true, error: null, notice: null });
		});
		contents.on("dom-ready", () => {
			if (this.view !== view) return;
			this.ready = true;
			update({ title: contents.getTitle().slice(0, 4096) });
		});
		contents.on("did-navigate", () => {
			if (this.view !== view) return;
			this.committedUrl = contents.getURL().slice(0, 8192);
			update({ url: this.committedUrl });
		});
		contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
			if (!isMainFrame || this.view !== view) return;
			this.committedUrl = url.slice(0, 8192);
			update({ url: this.committedUrl, loading: false });
		});
		contents.on("page-title-updated", (_event, title) => update({ title: title.slice(0, 4096) }));
		contents.on("did-stop-loading", () => update({ loading: false }));
		contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
			if (!isMainFrame || code === -3 || this.state?.url !== url) return;
			update({ loading: false, error: `网页加载失败（${description.slice(0, 160)}），请检查地址或网络后重试。` });
		});
		contents.on("render-process-gone", () => update({ loading: false, error: "网页进程已退出，请刷新重试。" }));
	}

	private guardNavigation(event: Event, url: string, mainFrame: boolean): void {
		if (this.allowFile && url.startsWith("file:")) return;
		try {
			normalizeBrowserUrl(url);
		} catch {
			event.preventDefault();
			if (mainFrame)
				this.update({
					loading: false,
					notice: "已阻止非 HTTP 或 HTTPS 网页链接。",
					error: this.ready ? null : "网页跳转被阻止，请输入 HTTP 或 HTTPS 网址。",
				});
		}
	}

	private update(patch: Partial<Omit<BrowserState, "id">>): void {
		if (!this.state || !this.view || this.view.webContents.isDestroyed()) return;
		this.state = {
			...this.state,
			...patch,
			canGoBack: this.view.webContents.navigationHistory.canGoBack(),
			canGoForward: this.view.webContents.navigationHistory.canGoForward(),
		};
		this.applyLayout();
		this.publish({ ...this.state });
	}

	private applyLayout(): void {
		if (!this.view || !this.state) return;
		const layout = this.layout;
		if (!layout || !layout.visible || !this.ready || this.state.error || this.window.isDestroyed()) {
			this.view.setVisible(false);
			return;
		}
		const scale = this.window.webContents.getZoomFactor();
		const [width, height] = this.window.getContentSize();
		const x = Math.min(width, Math.round(layout.x * scale));
		const y = Math.min(height, Math.round(layout.y * scale));
		const bounds = {
			x,
			y,
			width: Math.min(width - x, Math.round(layout.width * scale)),
			height: Math.min(height - y, Math.round(layout.height * scale)),
		};
		this.view.setBounds(bounds);
		this.view.setVisible(bounds.width > 0 && bounds.height > 0);
	}

	private closeCurrent(): void {
		const view = this.view;
		this.view = undefined;
		this.state = undefined;
		this.layout = undefined;
		this.ready = false;
		this.committedUrl = "";
		this.allowFile = false;
		++this.navigation;
		if (!view) return;
		if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
		if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
	}

	private readonly onWorkbenchReload = (): void => this.closeCurrent();
	private readonly onDownload = (
		event: Event,
		_item?: Electron.DownloadItem,
		contents?: Electron.WebContents,
	): void => {
		if (contents && contents !== this.view?.webContents) return;
		// 1.4 下载交给系统浏览器，内置网页不能静默写入本机文件。
		event.preventDefault();
		this.ready = Boolean(this.committedUrl);
		this.update({
			url: this.committedUrl || this.state?.url || "",
			loading: false,
			notice: "请在系统浏览器中打开此页面后下载文件。",
		});
	};
}
