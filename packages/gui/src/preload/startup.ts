import { contextBridge, ipcRenderer } from "electron";
import { createLogger } from "../shared/logger.ts";
import { STARTUP_CHANNELS, type StartupBridge } from "../shared/startup.ts";

const logger = createLogger("startup-preload");

/*
 * ========================================================================
 * 步骤1：为启动页暴露独立的有限通信
 * ========================================================================
 * 数据源：启动窗口的固定生命周期通道。
 * 操作：1) 只允许就绪、关闭和退场确认；2) 不提供项目或认证端口。
 */
logger.info("开始安装启动页通信");
// 1.1 启动页不加载桌面业务桥与 SDK 协议校验器。
const bridge: StartupBridge = {
	ready: () => ipcRenderer.send(STARTUP_CHANNELS.ready),
	close: () => ipcRenderer.send(STARTUP_CHANNELS.close),
	left: () => ipcRenderer.send(STARTUP_CHANNELS.left),
	subscribe: (listener) => {
		const stage = (_event: Electron.IpcRendererEvent, value: unknown) => {
			if (value === "preparing" || value === "restoring") listener(value);
		};
		const leave = () => listener("leave");
		ipcRenderer.on(STARTUP_CHANNELS.stage, stage);
		ipcRenderer.on(STARTUP_CHANNELS.leave, leave);
		return () => {
			ipcRenderer.removeListener(STARTUP_CHANNELS.stage, stage);
			ipcRenderer.removeListener(STARTUP_CHANNELS.leave, leave);
		};
	},
};
contextBridge.exposeInMainWorld("harnessStartup", bridge);
logger.info("启动页通信安装完成");
