import type { DesktopBridge } from "../shared/protocol.ts";
import type { StartupBridge } from "../shared/startup.ts";
declare global {
	interface Window {
		piDesktop: DesktopBridge;
		harnessStartup?: StartupBridge;
		harnessWorkbenchReady?: () => void;
	}
}
