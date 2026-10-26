import { join } from "node:path";
import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import type { Logger } from "../shared/logger.ts";
import { PRODUCT_NAME } from "../shared/product.ts";
import { STARTUP_CHANNELS, type StartupStage } from "../shared/startup.ts";

const READY_TIMEOUT_MS = 60_000;
const RELOAD_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 250;

/*
 * ========================================================================
 * 步骤1：先展示轻量品牌窗口，再交接真实工作台
 * ========================================================================
 * 数据源：本地启动页、主窗口首屏确认和受限 IPC。
 * 操作：1) 不加载 Vue 或 SDK；2) 主窗就绪才退场，取消时阻止迟到显示。
 */
export class StartupWindow {
	private readonly window: BrowserWindow;
	private readonly directory: string;
	private readonly logger: Logger;
	private readonly requestQuit: () => void;
	private main?: BrowserWindow;
	private stage: StartupStage = "preparing";
	private disposed = false;
	private mainReady = false;
	private resolveReady?: (ready: boolean) => void;
	private resolveExit?: () => void;
	private readyTimer?: ReturnType<typeof setTimeout>;
	private reloadTimer?: ReturnType<typeof setTimeout>;
	private exitTimer?: ReturnType<typeof setTimeout>;

	constructor(directory: string, logger: Logger, requestQuit: () => void) {
		this.directory = directory;
		this.logger = logger;
		this.requestQuit = requestQuit;
		this.window = new BrowserWindow({
			width: 480,
			height: 320,
			useContentSize: true,
			show: false,
			frame: false,
			resizable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			title: PRODUCT_NAME,
			backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b1c" : "#f9fafb",
			webPreferences: {
				preload: join(directory, "../preload/startup.cjs"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		});
		this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		this.window.webContents.on("will-navigate", (event) => event.preventDefault());
		this.window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
		this.window.once("ready-to-show", () => {
			if (!this.disposed) this.window.show();
		});
		this.window.on("close", (event) => {
			if (this.disposed) return;
			event.preventDefault();
			this.requestQuit();
		});
		ipcMain.on(STARTUP_CHANNELS.ready, this.onReady);
		ipcMain.on(STARTUP_CHANNELS.close, this.onClose);
		ipcMain.on(STARTUP_CHANNELS.left, this.onLeft);
		ipcMain.on(STARTUP_CHANNELS.workbenchReady, this.onWorkbenchReady);
	}

	async open(): Promise<void> {
		this.logger.info("开始加载启动窗口");
		try {
			// 1.1 开发与打包模式使用同一份独立启动页。
			if (process.env.ELECTRON_RENDERER_URL) {
				await this.window.loadURL(new URL("startup.html", process.env.ELECTRON_RENDERER_URL).href);
			} else {
				await this.window.loadFile(join(this.directory, "../renderer/startup.html"));
			}
		} catch (error) {
			if (!this.disposed) throw error;
		} finally {
			this.logger.info("启动窗口加载结束");
		}
	}

	connect(main: BrowserWindow): void {
		this.main = main;
	}

	setStage(stage: StartupStage): void {
		this.stage = stage;
		if (!this.disposed) this.window.webContents.send(STARTUP_CHANNELS.stage, stage);
	}

	focus(): boolean {
		if (this.disposed) return false;
		this.window.show();
		this.window.focus();
		return true;
	}

	async reveal(): Promise<void> {
		/*
		 * ========================================================================
		 * 步骤2：等待首屏事实，再结束短退场动画
		 * ========================================================================
		 * 数据源：指定主窗口的首屏确认与启动页退场确认。
		 * 操作：1) 拒绝其他页面确认；2) 等待有上限，取消不再显示主窗。
		 */
		this.logger.info("开始交接启动窗口");
		try {
			if (this.disposed || !this.main || this.main.isDestroyed()) return;
			// 2.1 不以固定动画时长代替工作台就绪。
			const ready =
				this.mainReady ||
				(await new Promise<boolean>((resolve, reject) => {
					this.resolveReady = resolve;
					this.readyTimer = setTimeout(
						() => reject(new Error("工作台界面未能完成加载，请重新启动应用")),
						READY_TIMEOUT_MS,
					);
					// 1.1 开发态首屏偶发卡在模块加载；一次可见前的重载可以恢复。
					this.reloadTimer = setTimeout(() => {
						if (this.mainReady || this.disposed || !this.main || this.main.isDestroyed()) return;
						this.logger.info("工作台首屏未就绪，重新加载主窗口");
						this.main.webContents.reload();
					}, RELOAD_TIMEOUT_MS);
				}));
			clearTimeout(this.readyTimer);
			if (!ready || this.disposed || this.main.isDestroyed()) return;
			// 2.2 减少动态效果由启动页立即确认；页面失效时也不会无限等待。
			await new Promise<void>((resolve) => {
				this.resolveExit = resolve;
				this.exitTimer = setTimeout(resolve, EXIT_TIMEOUT_MS);
				this.window.webContents.send(STARTUP_CHANNELS.leave);
			});
			if (this.disposed || this.main.isDestroyed()) return;
			this.main.show();
			this.dispose();
		} finally {
			clearTimeout(this.readyTimer);
			clearTimeout(this.reloadTimer);
			clearTimeout(this.exitTimer);
			this.logger.info("启动窗口交接结束");
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.logger.info("开始回收启动窗口");
		try {
			// 2.3 退出时唤醒等待，但不把退出视为首屏就绪。
			this.disposed = true;
			clearTimeout(this.readyTimer);
			clearTimeout(this.reloadTimer);
			clearTimeout(this.exitTimer);
			this.resolveReady?.(false);
			this.resolveExit?.();
			ipcMain.removeListener(STARTUP_CHANNELS.ready, this.onReady);
			ipcMain.removeListener(STARTUP_CHANNELS.close, this.onClose);
			ipcMain.removeListener(STARTUP_CHANNELS.left, this.onLeft);
			ipcMain.removeListener(STARTUP_CHANNELS.workbenchReady, this.onWorkbenchReady);
			if (!this.window.isDestroyed()) this.window.destroy();
		} finally {
			this.logger.info("启动窗口回收结束");
		}
	}

	private readonly onReady = (event: Electron.IpcMainEvent): void => {
		if (this.owns(event, this.window)) this.setStage(this.stage);
	};
	private readonly onClose = (event: Electron.IpcMainEvent): void => {
		if (this.owns(event, this.window)) this.requestQuit();
	};
	private readonly onLeft = (event: Electron.IpcMainEvent): void => {
		if (this.owns(event, this.window)) this.resolveExit?.();
	};
	private readonly onWorkbenchReady = (event: Electron.IpcMainEvent): void => {
		if (!this.main || !this.owns(event, this.main)) return;
		this.mainReady = true;
		clearTimeout(this.reloadTimer);
		this.resolveReady?.(true);
	};

	private owns(event: Electron.IpcMainEvent, window: BrowserWindow): boolean {
		return !this.disposed && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
	}
}
