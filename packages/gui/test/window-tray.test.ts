import { EventEmitter } from "node:events";
import { type BrowserWindow, Menu, nativeImage, Tray } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowTray } from "../src/main/window-tray.ts";

vi.mock("electron", () => ({
	Tray: vi.fn(function Tray() {
		return new FakeTray();
	}),
	Menu: { buildFromTemplate: vi.fn((items) => items) },
	nativeImage: {
		createFromBuffer: vi.fn(() => ({
			isEmpty: () => false,
			resize: () => ({}),
		})),
	},
}));

const logger = { info: vi.fn() };
const trays: FakeTray[] = [];
let window: FakeWindow;
let service: WindowTray | undefined;
let quitting: boolean;
let quit = vi.fn<() => void>();

class FakeTray extends EventEmitter {
	readonly setToolTip = vi.fn();
	readonly setContextMenu = vi.fn();
	readonly destroy = vi.fn(() => {
		this.destroyed = true;
	});
	private destroyed = false;

	constructor() {
		super();
		trays.push(this);
	}

	isDestroyed(): boolean {
		return this.destroyed;
	}
}

class FakeWindow extends EventEmitter {
	visible = true;
	minimized = false;
	destroyed = false;
	readonly hide = vi.fn(() => {
		this.visible = false;
	});
	readonly show = vi.fn(() => {
		this.visible = true;
	});
	readonly focus = vi.fn();
	readonly restore = vi.fn(() => {
		this.minimized = false;
	});

	isDestroyed(): boolean {
		return this.destroyed;
	}

	isMinimized(): boolean {
		return this.minimized;
	}

	close(): void {
		const event = { preventDefault: vi.fn() };
		this.emit("close", event);
		if (event.preventDefault.mock.calls.length) return;
		this.destroyed = true;
		this.emit("closed");
	}
}

function createTray(): WindowTray {
	service = new WindowTray(window as unknown as BrowserWindow, logger, () => quitting, quit);
	return service;
}

function selectMenu(label: string): void {
	const action = vi.mocked(Menu.buildFromTemplate).mock.calls[0]?.[0].find((item) => item.label === label)?.click;
	if (!action) throw new Error(`缺少托盘菜单：${label}`);
	Reflect.apply(action, undefined, []);
}

/*
 * ========================================================================
 * 步骤1：验证收起、恢复与真正退出的生命周期
 * ========================================================================
 * 数据源：离线原生窗口与托盘替身，不访问用户会话或系统托盘。
 * 操作：1) 关闭不销毁窗口；2) 退出、更新清理和失败时不困住隐藏窗口。
 */
describe("window tray", () => {
	beforeEach(() => {
		logger.info("开始验证主窗口托盘生命周期");
		// 1.1 每项使用独立窗口和退出状态，避免残留监听影响后续用例。
		window = new FakeWindow();
		quitting = false;
		quit = vi.fn<() => void>();
		trays.length = 0;
	});

	afterEach(() => {
		service?.dispose();
		service = undefined;
		vi.clearAllMocks();
		logger.info("主窗口托盘生命周期验证结束");
	});

	it("keeps the same window alive when closing repeatedly", () => {
		createTray();
		// 1.2 多次关闭只隐藏窗口，不触发真正退出。
		for (let count = 0; count < 3; count++) window.close();
		expect(window.visible).toBe(false);
		expect(window.destroyed).toBe(false);
		expect(quit).not.toHaveBeenCalled();
		expect(trays[0].isDestroyed()).toBe(false);
		expect(trays[0].setToolTip).toHaveBeenCalledWith("Aniao Harness");
		expect(window.listenerCount("close")).toBe(1);
	});

	it.each(["click", "double-click"])("restores a minimized window on tray %s", (event) => {
		createTray();
		// 1.3 从任务栏最小化后关闭，托盘仍能还原并聚焦原窗口。
		window.minimized = true;
		window.close();
		trays[0].emit(event);
		expect(window.minimized).toBe(false);
		expect(window.visible).toBe(true);
		expect(window.destroyed).toBe(false);
		expect(window.restore).toHaveBeenCalledOnce();
		expect(window.focus).toHaveBeenCalledOnce();
		expect(window.restore.mock.invocationCallOrder[0]).toBeLessThan(window.show.mock.invocationCallOrder[0]);
	});

	it("opens from its menu and routes exit through application shutdown", () => {
		createTray();
		window.close();
		// 1.4 打开菜单只恢复窗口；退出动作调用应用的统一退出入口。
		selectMenu("打开 Aniao Harness");
		expect(window.visible).toBe(true);
		expect(quit).not.toHaveBeenCalled();
		quit.mockImplementation(() => {
			quitting = true;
			window.close();
		});
		selectMenu("退出");
		expect(quit).toHaveBeenCalledOnce();
		expect(window.destroyed).toBe(true);
		expect(trays[0].destroy).toHaveBeenCalledOnce();
	});

	it("does not hide or restore while quitting or installing an update", () => {
		const tray = createTray();
		quitting = true;
		// 1.5 更新安装预先进入退出状态，窗口必须能够正常关闭。
		tray.restore();
		window.close();
		expect(window.destroyed).toBe(true);
		expect(window.hide).not.toHaveBeenCalled();
		expect(window.show).not.toHaveBeenCalled();
		expect(trays[0].destroy).toHaveBeenCalledOnce();
	});

	it("removes the tray and close interception once during cleanup", () => {
		const tray = createTray();
		window.close();
		// 1.6 重复清理和迟到点击不重新显示窗口，不阻止最终关闭。
		tray.dispose();
		tray.dispose();
		trays[0].emit("click");
		tray.restore();
		expect(window.visible).toBe(false);
		expect(window.listenerCount("close")).toBe(0);
		expect(window.listenerCount("closed")).toBe(0);
		expect(trays[0].destroy).toHaveBeenCalledOnce();
		window.close();
		expect(window.destroyed).toBe(true);
	});

	it("releases the tray after the window is destroyed externally", () => {
		createTray();
		// 1.7 外部销毁也释放托盘，迟到激活不能恢复已销毁窗口。
		window.destroyed = true;
		window.emit("closed");
		trays[0].emit("double-click");
		expect(trays[0].destroy).toHaveBeenCalledOnce();
		expect(window.show).not.toHaveBeenCalled();
		expect(window.listenerCount("close")).toBe(0);
	});

	it("preserves close-to-quit if the system tray cannot be created", () => {
		vi.mocked(Tray).mockImplementationOnce(() => {
			throw new Error("tray unavailable");
		});
		createTray();
		// 1.8 系统不支持托盘时不能隐藏到不存在的入口。
		window.close();
		expect(window.destroyed).toBe(true);
		expect(window.hide).not.toHaveBeenCalled();
	});

	it("preserves close-to-quit if its bundled icon cannot be decoded", () => {
		vi.mocked(nativeImage.createFromBuffer).mockReturnValueOnce({
			isEmpty: () => true,
		} as ReturnType<typeof nativeImage.createFromBuffer>);
		createTray();
		// 1.9 图标损坏时不创建空白托盘，也不拦截关闭。
		window.close();
		expect(Tray).not.toHaveBeenCalled();
		expect(window.destroyed).toBe(true);
		expect(window.hide).not.toHaveBeenCalled();
	});

	it("does not hide when the native tray has already been destroyed", () => {
		createTray();
		// 1.10 原生图标提前失效后保留可退出路径。
		trays[0].destroy();
		window.close();
		expect(window.destroyed).toBe(true);
		expect(window.hide).not.toHaveBeenCalled();
		expect(trays[0].destroy).toHaveBeenCalledOnce();
	});
});
