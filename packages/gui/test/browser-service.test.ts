import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContentsViewConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserService } from "../src/main/browser-service.ts";
import { browserActionSchema, browserLayoutSchema, normalizeBrowserUrl } from "../src/shared/browser.ts";

const { partition } = vi.hoisted(() => ({ partition: vi.fn() }));
vi.mock("electron", () => ({
	session: { fromPartition: partition },
	WebContentsView: vi.fn(function WebContentsView(options: WebContentsViewConstructorOptions) {
		return new FakeView(options);
	}),
}));

const id = "40cbb848-6d53-4abd-a717-19874a2fd8ac";
const otherId = "3ce14896-5e80-4d20-b018-e62c0819ed47";
const logger = { info: vi.fn() };
const views: FakeView[] = [];
const browserSession = Object.assign(new EventEmitter(), {
	setPermissionRequestHandler: vi.fn(),
	setPermissionCheckHandler: vi.fn(),
});

class FakeContents extends EventEmitter {
	url = "";
	destroyed = false;
	readonly navigationHistory = {
		canGoBack: vi.fn(() => false),
		canGoForward: vi.fn(() => false),
		goBack: vi.fn(),
		goForward: vi.fn(),
	};
	readonly loadURL = vi.fn(async (url: string) => {
		this.url = url;
	});
	readonly stop = vi.fn();
	readonly reload = vi.fn();
	readonly close = vi.fn(() => {
		this.destroyed = true;
	});
	readonly setWindowOpenHandler = vi.fn();
	isDestroyed(): boolean {
		return this.destroyed;
	}
	getURL(): string {
		return this.url;
	}
	getTitle(): string {
		return "离线网页";
	}
}

class FakeView {
	readonly webContents = new FakeContents();
	readonly setVisible = vi.fn();
	readonly setBounds = vi.fn();
	readonly options: WebContentsViewConstructorOptions;
	constructor(options: WebContentsViewConstructorOptions) {
		this.options = options;
		views.push(this);
	}
}

class FakeWindow extends EventEmitter {
	readonly webContents = Object.assign(new EventEmitter(), { getZoomFactor: () => 1.25 });
	readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
	getContentSize(): [number, number] {
		return [1100, 720];
	}
	isDestroyed(): boolean {
		return false;
	}
}

/*
 * ========================================================================
 * 步骤1：验证网页地址和有限命令边界
 * ========================================================================
 * 数据源：常用网站、本地开发地址和不可信协议。
 * 操作：1) 保留查询和片段；2) 拒绝凭据、控制字符和越界布局。
 */
describe("embedded browser URL boundary", () => {
	it("normalizes websites and local development addresses", () => {
		logger.info("开始验证网页地址归一化");
		try {
			// 1.1 HTTPS 网站和 HTTP 本地服务按预期补全协议。
			expect(normalizeBrowserUrl(" example.com/a?q=1#part ")).toBe("https://example.com/a?q=1#part");
			expect(normalizeBrowserUrl("localhost:5173/start")).toBe("http://localhost:5173/start");
			expect(normalizeBrowserUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
			expect(normalizeBrowserUrl("[::1]:3000/")).toBe("http://[::1]:3000/");
			expect(normalizeBrowserUrl("//example.com/path")).toBe("https://example.com/path");
			expect(normalizeBrowserUrl("http://192.168.1.2:8080/")).toBe("http://192.168.1.2:8080/");
		} finally {
			logger.info("网页地址归一化验证结束");
		}
	});
	it("rejects non-web URLs, credentials and malformed inputs", () => {
		logger.info("开始验证不可信网页地址");
		try {
			// 1.2 拒绝读文件、运行脚本和唤起本机协议。
			for (const input of [
				"",
				"file:///C:/private",
				"javascript:alert(1)",
				"data:text/html,hi",
				"mailto:a@example.com",
				"ftp://example.com",
				"https://name:secret@example.com",
				"https://exam\nple.com",
				"https://",
				"a".repeat(8193),
			]) {
				expect(() => normalizeBrowserUrl(input)).toThrow();
			}
			expect(browserActionSchema.safeParse({ id, action: "executeJavaScript" }).success).toBe(false);
			expect(
				browserLayoutSchema.safeParse({ id, visible: true, x: 0, y: 0, width: Infinity, height: -1 }).success,
			).toBe(false);
		} finally {
			logger.info("不可信网页地址验证结束");
		}
	});
});

/*
 * ========================================================================
 * 步骤2：验证原生网页隔离、状态和资源生命周期
 * ========================================================================
 * 数据源：离线网页事件、可见区域和替换后的标签身份。
 * 操作：1) 隐藏不销毁页面；2) 旧导航、下载和退出不能越过业务边界。
 */
describe("embedded browser lifecycle", () => {
	beforeEach(() => {
		views.length = 0;
		vi.clearAllMocks();
		browserSession.removeAllListeners();
		partition.mockReturnValue(browserSession);
	});

	it("isolates remote pages and denies device permissions", () => {
		logger.info("开始验证网页隔离");
		const window = new FakeWindow();
		const service = new BrowserService(window as unknown as BrowserWindow, logger, vi.fn());
		try {
			service.create(id);
			// 2.1 原生网页无 preload 和 Node，不与主窗共享 Session。
			expect(partition).toHaveBeenCalledWith("persist:harness-browser");
			expect(views[0].options.webPreferences).toMatchObject({
				session: browserSession,
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false,
				webviewTag: false,
				webSecurity: true,
			});
			expect(views[0].options.webPreferences?.preload).toBeUndefined();
			const reply = vi.fn();
			browserSession.setPermissionRequestHandler.mock.calls[0][0]({}, "media", reply);
			expect(reply).toHaveBeenCalledWith(false);
			expect(browserSession.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
			expect(() => service.navigate({ id, url: "file:///C:/private" })).toThrow();
			expect(views[0].webContents.loadURL).not.toHaveBeenCalled();
		} finally {
			service.dispose();
			logger.info("网页隔离验证结束");
		}
	});

	it("clips native bounds and preserves pages while hidden", () => {
		logger.info("开始验证浏览器布局与隐藏");
		const service = new BrowserService(new FakeWindow() as unknown as BrowserWindow, logger, vi.fn());
		try {
			service.create(id);
			service.navigate({ id, url: "localhost:3000" });
			const view = views[0];
			service.setLayout({ id, visible: true, x: 800, y: 100, width: 600, height: 800 });
			expect(view.setVisible).toHaveBeenLastCalledWith(false);
			// 2.2 未就绪不显示，实际像素按缩放换算后裁到窗口范围。
			view.webContents.emit("dom-ready");
			expect(view.setBounds).toHaveBeenLastCalledWith({ x: 1000, y: 125, width: 100, height: 595 });
			expect(view.setVisible).toHaveBeenLastCalledWith(true);
			service.setLayout({ id, visible: false, x: 0, y: 0, width: 300, height: 400 });
			expect(view.setVisible).toHaveBeenLastCalledWith(false);
			expect(view.webContents.close).not.toHaveBeenCalled();
			service.setLayout({ id, visible: true, x: 0, y: 0, width: 300, height: 400 });
			expect(view.setVisible).toHaveBeenLastCalledWith(true);
			expect(view.webContents.loadURL).toHaveBeenCalledOnce();
		} finally {
			service.dispose();
			logger.info("浏览器布局与隐藏验证结束");
		}
	});

	it("ignores stale identities and events after a tab is replaced", async () => {
		logger.info("开始验证旧浏览器标签隔离");
		const publish = vi.fn();
		const service = new BrowserService(new FakeWindow() as unknown as BrowserWindow, logger, publish);
		try {
			service.create(id);
			const old = views[0];
			let rejectOld: (reason: Error) => void = () => {};
			old.webContents.loadURL.mockReturnValueOnce(
				new Promise((_resolve, reject) => {
					rejectOld = reject;
				}),
			);
			service.navigate({ id, url: "https://old.example" });
			service.create(otherId);
			const current = views[1];
			publish.mockClear();
			// 2.3 迟到失败、标题和关闭请求不能污染新标签。
			old.webContents.emit("page-title-updated", {}, "old title");
			old.webContents.emit("did-stop-loading");
			old.webContents.emit("will-redirect", { url: "file:///C:/private", isMainFrame: true, preventDefault: vi.fn() });
			rejectOld(new Error("old network error"));
			await Promise.resolve();
			service.close(id);
			expect(publish).not.toHaveBeenCalled();
			expect(current.webContents.close).not.toHaveBeenCalled();
			expect(() => service.action({ id, action: "reload" })).toThrow("浏览器标签已关闭");
			expect(old.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
		} finally {
			service.dispose();
			logger.info("旧浏览器标签隔离验证结束");
		}
	});

	it("blocks unsafe page navigation and redirects without opening system protocols", () => {
		logger.info("开始验证网页导航边界");
		const publish = vi.fn();
		const service = new BrowserService(new FakeWindow() as unknown as BrowserWindow, logger, publish);
		try {
			service.create(id);
			const contents = views[0].webContents;
			for (const eventName of ["will-frame-navigate", "will-redirect"]) {
				const event = { url: "file:///C:/private", isMainFrame: true, preventDefault: vi.fn() };
				contents.emit(eventName, event);
				expect(event.preventDefault).toHaveBeenCalledOnce();
			}
			// 2.4 target=_blank 复用当前网页，非法协议只报告提示。
			const open = contents.setWindowOpenHandler.mock.calls[0][0];
			expect(open({ url: "https://example.com" })).toEqual({ action: "deny" });
			expect(contents.loadURL).toHaveBeenLastCalledWith("https://example.com/");
			expect(open({ url: "custom:run" })).toEqual({ action: "deny" });
			expect(publish.mock.lastCall?.[0].notice).toBeTruthy();
		} finally {
			service.dispose();
			logger.info("网页导航边界验证结束");
		}
	});

	it("handles network failure, explicit retry, history and stopping", () => {
		logger.info("开始验证网页失败恢复与历史");
		const publish = vi.fn();
		const service = new BrowserService(new FakeWindow() as unknown as BrowserWindow, logger, publish);
		try {
			service.create(id);
			service.navigate({ id, url: "localhost:3000" });
			const contents = views[0].webContents;
			contents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://localhost:3000/", true);
			expect(publish.mock.lastCall?.[0].error).toContain("ERR_CONNECTION_REFUSED");
			service.action({ id, action: "reload" });
			expect(contents.loadURL).toHaveBeenCalledTimes(2);
			expect(publish.mock.lastCall?.[0].error).toBeNull();
			contents.emit("dom-ready");
			contents.navigationHistory.canGoBack.mockReturnValue(true);
			contents.navigationHistory.canGoForward.mockReturnValue(true);
			service.action({ id, action: "back" });
			service.action({ id, action: "forward" });
			expect(contents.navigationHistory.goBack).toHaveBeenCalledOnce();
			expect(contents.navigationHistory.goForward).toHaveBeenCalledOnce();
			service.action({ id, action: "stop" });
			expect(contents.stop).toHaveBeenCalledOnce();
			expect(publish.mock.lastCall?.[0].loading).toBe(false);
		} finally {
			service.dispose();
			logger.info("网页失败恢复与历史验证结束");
		}
	});

	it("restores the committed page when a link becomes a download", () => {
		logger.info("开始验证下载链接保留原网页");
		const publish = vi.fn();
		const service = new BrowserService(new FakeWindow() as unknown as BrowserWindow, logger, publish);
		try {
			service.create(id);
			service.navigate({ id, url: "http://localhost:3000/page" });
			const contents = views[0].webContents;
			contents.emit("did-navigate");
			contents.emit("dom-ready");
			service.setLayout({ id, visible: true, x: 0, y: 0, width: 300, height: 400 });
			// 2.6 下载不是新文档，取消文件写入后恢复仍存活的原页面。
			contents.emit("did-start-navigation", {
				isMainFrame: true,
				isSameDocument: false,
				url: "http://localhost:3000/file",
			});
			browserSession.emit("will-download", { preventDefault: vi.fn() });
			expect(publish.mock.lastCall?.[0]).toMatchObject({
				url: "http://localhost:3000/page",
				loading: false,
				error: null,
			});
			expect(views[0].setVisible).toHaveBeenLastCalledWith(true);
		} finally {
			service.dispose();
			logger.info("下载链接保留原网页验证结束");
		}
	});

	it("cancels page downloads and releases views on reload and shutdown", () => {
		logger.info("开始验证浏览器下载与资源释放");
		const window = new FakeWindow();
		const publish = vi.fn();
		const service = new BrowserService(window as unknown as BrowserWindow, logger, publish);
		try {
			service.create(id);
			const download = { preventDefault: vi.fn() };
			browserSession.emit("will-download", download);
			expect(download.preventDefault).toHaveBeenCalledOnce();
			expect(publish.mock.lastCall?.[0].notice).toContain("系统浏览器");
			// 2.5 主窗刷新和反复 dispose 均只回收各自的视图一次。
			window.webContents.emit("did-start-loading");
			expect(views[0].webContents.close).toHaveBeenCalledOnce();
			service.create(otherId);
			service.dispose();
			service.dispose();
			expect(views[1].webContents.close).toHaveBeenCalledOnce();
			expect(browserSession.listenerCount("will-download")).toBe(0);
			expect(window.webContents.listenerCount("did-start-loading")).toBe(0);
			expect(() => service.create(id)).toThrow("工作台已关闭");
		} finally {
			service.dispose();
			logger.info("浏览器下载与资源释放验证结束");
		}
	});
});
