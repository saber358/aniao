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
