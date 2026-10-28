const logger = console;
document.documentElement.classList.add("js");

/*
 * ========================================================================
 * 步骤1：保持导航与内容在不同设备可用
 * ========================================================================
 * 数据源：页面锚点、移动导航和系统减少动态效果偏好。
 * 操作：1) 菜单状态可被辅助设备识别；2) 内容只做轻量渐入，不阻止下载。
 */
logger.info("开始绑定官网交互");
try {
	// 1.1 移动菜单使用原生按钮，点击链接或 Esc 后关闭。
	const toggle = document.querySelector(".menu-toggle");
	const nav = document.querySelector(".main-nav");
	function setMenu(open) {
		nav.classList.toggle("open", open);
		toggle.setAttribute("aria-expanded", String(open));
		toggle.setAttribute("aria-label", open ? "收起导航" : "展开导航");
	}
	toggle.addEventListener("click", () => setMenu(toggle.getAttribute("aria-expanded") !== "true"));
	nav.querySelectorAll("a").forEach((link) => {
		link.addEventListener("click", () => setMenu(false));
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
			setMenu(false);
			toggle.focus();
		}
	});
	// 1.2 观察器只控制呈现，脚本关闭时内容仍默认显示。
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries)
				if (entry.isIntersecting) {
					entry.target.classList.add("visible");
					observer.unobserve(entry.target);
				}
		},
		{ threshold: 0.08 },
	);
	document.querySelectorAll(".reveal").forEach((element) => {
		observer.observe(element);
	});
} finally {
	logger.info("官网交互绑定结束");
}

/*
 * ========================================================================
 * 步骤2：复制明确的 Linux 安装命令
 * ========================================================================
 * 数据源：页面中的固定安装命令与用户本次点击。
 * 操作：1) 只写入剪贴板；2) 不自动执行命令，失败时提示手动复制。
 */
const copyButton = document.querySelector(".copy-command");
const toast = document.querySelector("#site-toast");
let toastTimer;
copyButton.addEventListener("click", async () => {
	logger.info("开始复制 Linux 安装命令");
	try {
		// 2.1 复制操作不携带认证，也不触发文件下载或系统命令。
		await navigator.clipboard.writeText(document.querySelector("#linux-command").textContent);
		toast.textContent = "安装命令已复制";
	} catch {
		toast.textContent = "请选中安装命令，手动复制";
	} finally {
		clearTimeout(toastTimer);
		toast.classList.add("visible");
		toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
		logger.info("Linux 安装命令复制结束");
	}
});
