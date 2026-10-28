// 1.1 启动动画与初始化工作台共用外框尺寸，避免交接时窗口突然放大。
export const INITIAL_WINDOW_SIZE = { width: 1320, height: 880 } as const;

export const STARTUP_CHANNELS = {
	ready: "harness:startup:ready",
	close: "harness:startup:close",
	stage: "harness:startup:stage",
	leave: "harness:startup:leave",
	left: "harness:startup:left",
	workbenchReady: "harness:workbench:ready",
} as const;

export type StartupStage = "preparing" | "restoring";

export interface StartupBridge {
	ready(): void;
	close(): void;
	left(): void;
	subscribe(listener: (event: StartupStage | "leave") => void): () => void;
}
