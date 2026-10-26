import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupWindow } from "../src/main/startup-window.ts";
import { STARTUP_CHANNELS } from "../src/shared/startup.ts";

const { listeners } = vi.hoisted(() => ({ listeners: new Map<string, Set<(event: Electron.IpcMainEvent) => void>>() }));
vi.mock("electron", () => ({
	BrowserWindow: vi.fn(function BrowserWindow() {
		return new FakeWindow();
	}),
	nativeTheme: { shouldUseDarkColors: false },
	ipcMain: {
		on: (name: string, handler: (event: Electron.IpcMainEvent) => void) => {
			const entries = listeners.get(name) ?? new Set();
			entries.add(handler);
			listeners.set(name, entries);
		},
		removeListener: (name: string, handler: (event: Electron.IpcMainEvent) => void) =>
			listeners.get(name)?.delete(handler),
	},
}));

const windows: FakeWindow[] = [];
const logger = { info: vi.fn() };

class FakeWindow extends EventEmitter {
	readonly webContents = Object.assign(new EventEmitter(), {
		mainFrame: {},
		send: vi.fn(),
		setWindowOpenHandler: vi.fn(),
		session: { setPermissionRequestHandler: vi.fn() },
	});
	readonly show = vi.fn();
	readonly focus = vi.fn();
	private destroyed = false;

	constructor() {
		super();
		windows.push(this);
	}

	async loadURL(): Promise<void> {
		this.emit("ready-to-show");
	}

	async loadFile(): Promise<void> {
		this.emit("ready-to-show");
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}

	destroy(): void {
		this.destroyed = true;
	}
}

function signal(channel: string, window: FakeWindow, frame: object = window.webContents.mainFrame): void {
	const event = { sender: window.webContents, senderFrame: frame } as unknown as Electron.IpcMainEvent;
	for (const listener of listeners.get(channel) ?? []) listener(event);
}

/*
 * ========================================================================
 * 步骤1：验证启动交接的身份、时序和退出边界
 * ========================================================================
 * 数据源：离线窗口事件、主窗首屏确认与虚拟时钟。
 * 操作：1) 未就绪不露出主窗；2) 退出与超时不会触发迟到窗口。
 */
describe("startup window", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		windows.length = 0;
		listeners.clear();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("waits for the owned main frame and splash exit before showing the workbench", async () => {
		logger.info("开始验证启动窗口身份与交接时序");
		const quit = vi.fn();
		const startup = new StartupWindow("/app/main", logger, quit);
		const splash = windows[0];
		const main = new FakeWindow();
		try {
			// 1.1 启动页先显示；其他窗口和子 frame 不能冒充首屏就绪。
			await startup.open();
			startup.connect(main as unknown as BrowserWindow);
			const revealing = startup.reveal();
			expect(splash.show).toHaveBeenCalledOnce();
			signal(STARTUP_CHANNELS.workbenchReady, splash);
			signal(STARTUP_CHANNELS.workbenchReady, main, {});
			await Promise.resolve();
			expect(main.show).not.toHaveBeenCalled();
			// 1.2 主窗确认后仍先等启动页短退场，不能被外部页面提前结束。
			signal(STARTUP_CHANNELS.workbenchReady, main);
			await Promise.resolve();
			expect(splash.webContents.send).toHaveBeenCalledWith(STARTUP_CHANNELS.leave);
			signal(STARTUP_CHANNELS.left, main);
			await Promise.resolve();
			expect(main.show).not.toHaveBeenCalled();
			signal(STARTUP_CHANNELS.left, splash);
			await revealing;
			expect(main.show).toHaveBeenCalledOnce();
			expect(splash.isDestroyed()).toBe(true);
			expect(quit).not.toHaveBeenCalled();
			expect([...listeners.values()].every((entries) => entries.size === 0)).toBe(true);
		} finally {
			startup.dispose();
			logger.info("启动窗口身份与交接时序验证结束");
		}
	});

	it("cancels pending handoff and releases timers when the application closes", async () => {
		logger.info("开始验证启动中关闭");
		const quit = vi.fn();
		const startup = new StartupWindow("/app/main", logger, quit);
		const splash = windows[0];
		const main = new FakeWindow();
		try {
			// 1.3 只有启动窗口可请求关闭；退出后的确认不能显示隐藏主窗。
			startup.connect(main as unknown as BrowserWindow);
			const revealing = startup.reveal();
			signal(STARTUP_CHANNELS.close, main);
			expect(quit).not.toHaveBeenCalled();
			signal(STARTUP_CHANNELS.close, splash);
			expect(quit).toHaveBeenCalledOnce();
			startup.dispose();
			signal(STARTUP_CHANNELS.workbenchReady, main);
			await revealing;
			await vi.runAllTimersAsync();
			expect(main.show).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			expect(startup.focus()).toBe(false);
		} finally {
			startup.dispose();
			logger.info("启动中关闭验证结束");
		}
	});

	it("accepts an early main-ready signal and bounds a missing exit acknowledgement", async () => {
		logger.info("开始验证快速启动和退场兜底");
		const startup = new StartupWindow("/app/main", logger, vi.fn());
		const main = new FakeWindow();
		try {
			// 1.4 就绪可以早于 loadURL 返回，不额外等待完整品牌动画。
			startup.connect(main as unknown as BrowserWindow);
			signal(STARTUP_CHANNELS.workbenchReady, main);
			const revealing = startup.reveal();
			await vi.advanceTimersByTimeAsync(249);
			expect(main.show).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await revealing;
			expect(main.show).toHaveBeenCalledOnce();
		} finally {
			startup.dispose();
			logger.info("快速启动和退场兜底验证结束");
		}
	});

	it("rejects a missing workbench ready signal without exposing a blank main window", async () => {
		logger.info("开始验证首屏加载超时");
		const startup = new StartupWindow("/app/main", logger, vi.fn());
		const main = new FakeWindow();
		try {
			// 1.5 首屏未确认必须报告失败，不能无限显示动画或露出空白窗口。
			startup.connect(main as unknown as BrowserWindow);
			const rejected = expect(startup.reveal()).rejects.toThrow("工作台界面未能完成加载");
			await vi.advanceTimersByTimeAsync(15_000);
			await rejected;
			expect(main.show).not.toHaveBeenCalled();
		} finally {
			startup.dispose();
			logger.info("首屏加载超时验证结束");
		}
	});
});
