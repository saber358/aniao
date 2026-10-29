import { type BrowserWindow, type Event, Menu, nativeImage, Tray } from "electron";
import type { Logger } from "../shared/logger.ts";
import { PRODUCT_NAME } from "../shared/product.ts";

const TRAY_ICON_PNG =
	"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";

/*
 * ========================================================================
 * 步骤1：建立主窗口的系统托盘入口
 * ========================================================================
 * 数据源：已就绪主窗口、本地 PNG 图标和应用退出状态。
 * 操作：1) 托盘菜单提供打开与退出；2) 托盘创建失败时保留原有退出路径。
 */
export class WindowTray {
	private readonly window: BrowserWindow;
	private readonly logger: Logger;
	private readonly isQuitting: () => boolean;
	private tray?: Tray;
	private disposed = false;

	constructor(window: BrowserWindow, logger: Logger, isQuitting: () => boolean, requestQuit: () => void) {
		this.window = window;
		this.logger = logger;
		this.isQuitting = isQuitting;
		logger.info("开始建立系统托盘");
		try {
			// 1.1 图标随主进程打包，安装版和开发版不依赖外部文件。
			const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, "base64"));
			if (image.isEmpty()) throw new Error("托盘图标无法解码");
			const tray = new Tray(image.resize({ width: 24, height: 24 }));
			this.tray = tray;
			tray.setToolTip(PRODUCT_NAME);
			tray.setContextMenu(
				Menu.buildFromTemplate([
					{ label: `打开 ${PRODUCT_NAME}`, click: this.restore },
					{ type: "separator" },
					{ label: "退出", click: requestQuit },
				]),
			);
			// 1.2 点击或双击恢复同一窗口，右键菜单交给系统托盘。
			tray.on("click", this.restore);
			tray.on("double-click", this.restore);
			window.on("close", this.onClose);
			window.once("closed", this.dispose);
		} catch (error) {
			this.tray?.destroy();
			this.tray = undefined;
			logger.info(`系统托盘不可用，关闭窗口将退出应用：${error instanceof Error ? error.message : "未知错误"}`);
		} finally {
			logger.info("系统托盘建立结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤2：关闭时收起窗口并保留正在运行的会话
	 * ========================================================================
	 * 数据源：主窗口关闭事件与应用退出状态。
	 * 操作：1) 普通关闭只隐藏；2) 退出和更新安装不拦截。
	 */
	private readonly onClose = (event: Event): void => {
		if (this.disposed || this.isQuitting() || !this.tray || this.tray.isDestroyed()) return;
		this.logger.info("开始将主窗口收起到托盘");
		try {
			// 2.1 保留原生窗口、网页、终端和会话宿主，避免触发关闭清理。
			event.preventDefault();
			this.window.hide();
		} finally {
			this.logger.info("主窗口收起到托盘结束");
		}
	};

	/*
	 * ========================================================================
	 * 步骤3：从托盘或再次启动恢复原窗口
	 * ========================================================================
	 * 数据源：仍保留的原生窗口和最小化状态。
	 * 操作：1) 还原后显示并聚焦；2) 退出期间不重新显示。
	 */
	readonly restore = (): void => {
		if (this.disposed || this.isQuitting() || this.window.isDestroyed()) return;
		this.logger.info("开始从托盘恢复主窗口");
		try {
			// 3.1 不重建窗口和页面，继续使用原有会话与草稿。
			if (this.window.isMinimized()) this.window.restore();
			this.window.show();
			this.window.focus();
		} finally {
			this.logger.info("主窗口从托盘恢复结束");
		}
	};

	/*
	 * ========================================================================
	 * 步骤4：退出时回收托盘与窗口监听
	 * ========================================================================
	 * 数据源：应用统一清理流程或主窗口已关闭事件。
	 * 操作：1) 清理可重复调用；2) 释放托盘后允许窗口正常销毁。
	 */
	readonly dispose = (): void => {
		if (this.disposed) return;
		this.logger.info("开始回收系统托盘");
		try {
			// 4.1 卸载关闭拦截，避免退出或更新时被重新收起。
			this.disposed = true;
			this.window.removeListener("close", this.onClose);
			this.window.removeListener("closed", this.dispose);
			if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
			this.tray = undefined;
		} finally {
			this.logger.info("系统托盘回收结束");
		}
	};
}
