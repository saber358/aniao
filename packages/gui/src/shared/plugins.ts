import { z } from "zod";

const pluginSource = z.string().trim().min(1).max(4096);
const pluginPath = z.string().min(1).max(4096);

export const pluginScopeSchema = z.enum(["user", "project"]);

export const pluginPackageSchema = z
	.object({
		source: pluginSource,
		scope: pluginScopeSchema,
		installed: z.boolean(),
		path: pluginPath.optional(),
	})
	.strict();

export const pluginPackageListSchema = z.array(pluginPackageSchema).max(200);

export const pluginListRequestSchema = z.object({ cwd: pluginPath }).strict();

export const pluginInstallRequestSchema = z.object({ cwd: pluginPath, source: pluginSource }).strict();

export const pluginRemoveRequestSchema = z
	.object({ cwd: pluginPath, source: pluginSource, scope: pluginScopeSchema })
	.strict();

export interface PluginCatalogItem {
	id: string;
	name: string;
	source: string;
	description: string;
	author: string;
	type: "extension" | "skill" | "package";
	icon: string;
}

export type PluginPackage = z.infer<typeof pluginPackageSchema>;
export type PluginScope = z.infer<typeof pluginScopeSchema>;

/*
 * 精选条目只负责展示和安装入口；版本与兼容性仍由 Pi 包管理器解析。
 * 这里不把 npm 搜索结果直接当作可信插件。
 */
export const PLUGIN_CATALOG: readonly PluginCatalogItem[] = [
	{
		id: "pi-mcp-adapter",
		name: "MCP Adapter",
		source: "npm:pi-mcp-adapter",
		description: "连接任意 MCP Server，把 MCP 工具暴露给当前会话。",
		author: "nicopreme",
		type: "extension",
		icon: "i-lucide-plug",
	},
	{
		id: "pi-web-access",
		name: "Web Access",
		source: "npm:pi-web-access",
		description: "网页搜索、URL 读取、PDF 和视频内容分析。",
		author: "nicopreme",
		type: "extension",
		icon: "i-lucide-globe",
	},
	{
		id: "pi-subagents",
		name: "Subagents",
		source: "npm:pi-subagents",
		description: "把任务委派给子 Agent，支持脚本化多 Agent 工作流。",
		author: "nicopreme",
		type: "extension",
		icon: "i-lucide-bot",
	},
	{
		id: "pi-lens",
		name: "Pi Lens",
		source: "npm:pi-lens",
		description: "实时 LSP、lint、格式化和类型检查反馈。",
		author: "apmantza",
		type: "extension",
		icon: "i-lucide-scan-search",
	},
	{
		id: "rpiv-todo",
		name: "Todo",
		source: "npm:@juicesharp/rpiv-todo",
		description: "给模型一个可持久化的 todo 列表，并在会话中实时显示。",
		author: "juicesharp",
		type: "extension",
		icon: "i-lucide-list-checks",
	},
	{
		id: "plannotator",
		name: "Plan Review",
		source: "npm:@plannotator/pi-extension",
		description: "交互式计划审查、消息批注和代码/PR 审查。",
		author: "plannotator",
		type: "package",
		icon: "i-lucide-notebook-pen",
	},
	{
		id: "pi-goal-x",
		name: "Goal X",
		source: "npm:pi-goal-x",
		description: "为 Pi 增加长期目标、进度跟踪和完成审计。",
		author: "tmonk",
		type: "extension",
		icon: "i-lucide-target",
	},
	{
		id: "langfuse",
		name: "Langfuse Observability",
		source: "npm:@langfuse/pi-observability-plugin",
		description: "把提示词、模型调用和工具调用追踪到 Langfuse。",
		author: "Langfuse",
		type: "extension",
		icon: "i-lucide-chart-no-axes-combined",
	},
	{
		id: "postman",
		name: "Postman API Skills",
		source: "npm:@postman/postman-plugin",
		description: "Postman 的 API 工程技能和接口调试工作流。",
		author: "Postman",
		type: "skill",
		icon: "i-lucide-send",
	},
];
