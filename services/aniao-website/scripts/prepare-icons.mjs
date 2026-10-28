import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const logger = console;
/*
 * ========================================================================
 * 步骤1：从已安装图标库提取官网图标
 * ========================================================================
 * 数据源：仓库固定版本 Lucide Iconify 数据，不手绘替代产品图标。
 * 操作：1) 仅提取页面使用的图标；2) 保存本地 sprite，线上不依赖图标 CDN。
 */
logger.info("开始准备官网图标");
try {
	const data = JSON.parse(
		await readFile(fileURLToPath(import.meta.resolve("@iconify-json/lucide/icons.json")), "utf8"),
	);
	const names = [
		"arrow-up-right",
		"arrow-right",
		"arrow-down",
		"download",
		"terminal",
		"monitor",
		"chevron-down",
		"menu",
		"x",
		"sparkles",
		"layers-2",
		"workflow",
		"puzzle",
		"check",
		"git-branch",
		"copy",
		"external-link",
		"shield-check",
		"play",
	];
	// 1.1 图标仍使用官方路径，只组合为可缓存的本地资源。
	const symbols = names.map((name) => {
		const icon = data.icons[name];
		if (!icon) throw new Error(`图标不存在：${name}`);
		return `<symbol id="${name}" viewBox="0 0 ${data.width ?? 24} ${data.height ?? 24}">${icon.body}</symbol>`;
	});
	await mkdir(new URL("../public/assets/", import.meta.url), { recursive: true });
	await writeFile(
		new URL("../public/assets/icons.svg", import.meta.url),
		`<svg xmlns="http://www.w3.org/2000/svg">${symbols.join("")}</svg>\n`,
	);
	await writeFile(
		new URL("../public/assets/favicon.svg", import.meta.url),
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" color="#3768e0">${data.icons.sparkles.body}</svg>\n`,
	);
} finally {
	logger.info("官网图标准备结束");
}
