import { createLogger } from "../shared/logger.ts";
import { INITIAL_WINDOW_SIZE } from "../shared/startup.ts";

const logger = createLogger("startup-renderer");

/*
 * ========================================================================
 * 步骤1：展示品牌动效并响应真实启动状态
 * ========================================================================
 * 数据源：系统主题、本机外观偏好与启动页有限通信。
 * 操作：1) CSS 独立于 Vue 加载；2) 收到就绪事实才结束启动页。
 */
logger.info("开始展示启动动画");
// 1.1 同源外观偏好与主工作台一致，浏览器预览可指定主题。
const previewTheme = new URLSearchParams(location.search).get("theme");
let theme: string | null = null;
try {
	theme = localStorage.getItem("pi-gui-theme");
} catch {
	logger.info("启动页无法读取外观偏好，使用系统主题");
}
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => {
	document.documentElement.classList.toggle(
		"dark",
		previewTheme === "dark" || (previewTheme !== "light" && (theme === "dark" || (!theme && systemTheme.matches))),
	);
};
applyTheme();
systemTheme.addEventListener("change", applyTheme);

// 1.2 无桌面桥时只展示启动页，不伪造文件或会话能力。
const bridge = window.harnessStartup;
document.documentElement.style.setProperty("--startup-preview-width", `${INITIAL_WINDOW_SIZE.width}px`);
document.documentElement.style.setProperty("--startup-preview-height", `${INITIAL_WINDOW_SIZE.height}px`);
document.documentElement.classList.toggle("preview", !bridge);
const close = document.querySelector<HTMLButtonElement>(".startup-close");
if (close) {
	close.hidden = !bridge;
	close.addEventListener("click", () => bridge?.close());
}
let leaving = false;
let exitTimer: ReturnType<typeof setTimeout> | undefined;
const release = bridge?.subscribe((event) => {
	if (event === "leave") {
		if (leaving) return;
		leaving = true;
		document.documentElement.classList.add("leaving");
		// 1.3 减少动态效果时直接确认，否则仅等待短退场过渡。
		exitTimer = setTimeout(() => bridge.left(), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
	} else {
		const status = document.getElementById("startup-status");
		if (status) status.textContent = event === "restoring" ? "正在恢复工作区" : "正在准备工作台";
	}
});
bridge?.ready();
window.addEventListener(
	"pagehide",
	() => {
		clearTimeout(exitTimer);
		release?.();
		systemTheme.removeEventListener("change", applyTheme);
		logger.info("启动动画展示结束");
	},
	{ once: true },
);
