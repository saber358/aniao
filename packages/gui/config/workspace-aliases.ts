import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const logger = console;

/*
 * ========================================================================
 * 步骤1：统一开发构建与测试使用的官方内核入口
 * ========================================================================
 * 数据源：本包固定版本的 Pi SDK；仓库内核源码保持独立。
 * 操作：
 *   1) 解析已安装的官方发布包，避免工作区旧版本混入桌面宿主
 *   2) 子路径先于根入口登记，开发、打包与测试共用映射
 */
logger.info("开始解析桌面 Pi 内核入口");
export const kernelDirectory = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
// 1.1 使用本包的模块解析位置，所有 Pi 入口均来自固定的 1.4.0 发布包。
const subpathAliases = [
	["providers", "all"],
	["api", "openai-completions"],
	["utils", "retry"],
].map(([subpath, entry]) => ({
	find: `@earendil-works/pi-ai/${subpath}`,
	replacement: dirname(fileURLToPath(import.meta.resolve(`@earendil-works/pi-ai/${subpath}/${entry}`))),
}));
export const workspaceAliases = [
	{ find: "@harness/pi-kernel/mcp-runtime", replacement: join(kernelDirectory, "dist/extensions/mcp/runtime.js") },
	{ find: "@harness/pi-kernel/prompt-templates", replacement: join(kernelDirectory, "dist/core/prompt-templates.js") },
	{ find: "@harness/pi-kernel/auth-storage", replacement: join(kernelDirectory, "dist/core/auth-storage.js") },
	{ find: "@harness/pi-kernel/theme", replacement: join(kernelDirectory, "dist/modes/interactive/theme/theme.js") },
	...subpathAliases,
	...[
		"@earendil-works/pi-ai/providers/all",
		"@earendil-works/pi-ai/compat",
		"@earendil-works/pi-ai/models",
		"@earendil-works/pi-ai/oauth",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-tui",
		"@earendil-works/pi-coding-agent",
	].map((find) => ({ find, replacement: fileURLToPath(import.meta.resolve(find)) })),
];
logger.info("桌面 Pi 内核入口解析完成");
