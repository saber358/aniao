import { z } from "zod";

export const SUBAGENT_STATUS_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
export const SUBAGENT_INSPECT_PREFIX = "PI_SUBAGENT_INSPECT_JSON:";
export const SUBAGENT_INSPECT_WIDGET = "subagent-inspect";
const subagentIdSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9_-]+$/u);

export const subagentOutputRequestSchema = z
	.object({
		runId: subagentIdSchema,
		childId: z
			.string()
			.min(1)
			.max(256)
			.regex(/^(?!-)[^\s\p{Cc}]+$/u)
			.optional(),
	})
	.strict();

const subagentStateSchema = z.enum([
	"queued",
	"running",
	"complete",
	"failed",
	"partial",
	"paused",
	"stopped",
	"rejected",
]);

/*
 * ========================================================================
 * 步骤1：校验插件官方详情回复
 * ========================================================================
 * 数据源：pi-subagents.inspect-reply v1，不接受文件路径或终端组件。
 * 操作：1) 保留任务、消息和实际模型；2) 限制字段与消息数量。
 */
export const subagentInspectionSchema = z.object({
	kind: z.literal("pi-subagents.inspect-reply"),
	version: z.literal(1),
	requestId: z.string().min(1).max(64),
	asyncId: z.string().min(1).max(256).optional(),
	childId: z.string().min(1).max(256).optional(),
	status: subagentStateSchema.optional(),
	label: z.string().max(160).optional(),
	task: z.string().max(2000).optional(),
	messages: z
		.array(
			z.object({
				role: z.string().max(64),
				kind: z.enum(["text", "toolCall", "toolResult"]),
				text: z.string().max(1000),
				name: z.string().max(160).optional(),
				isError: z.boolean().optional(),
			}),
		)
		.max(200)
		.optional(),
	finalOutput: z.string().max(8000).optional(),
	resolvedModel: z.object({ provider: z.string().max(64), model: z.string().max(160) }).optional(),
	truncated: z
		.object({ task: z.boolean(), messages: z.number().int().nonnegative(), finalOutput: z.boolean() })
		.optional(),
	error: z
		.object({
			code: z.enum(["invalid_request", "not_found", "foreign_session", "stale", "no_active_session", "internal"]),
			message: z.string().max(4096),
		})
		.optional(),
});
export type SubagentInspection = z.infer<typeof subagentInspectionSchema>;

const subagentActivitySchema = z
	.object({
		state: z.string().max(128).optional(),
		currentTool: z.string().max(256).optional(),
		lastActivityAt: z.number().optional(),
		currentToolStartedAt: z.number().optional(),
		turnCount: z.number().int().nonnegative().optional(),
		toolCount: z.number().int().nonnegative().optional(),
	})
	.passthrough();

export interface SubagentNode {
	id: string;
	kind: string;
	label: string;
	state: z.infer<typeof subagentStateSchema>;
	startedAt?: number;
	updatedAt?: number;
	endedAt?: number;
	activity?: z.infer<typeof subagentActivitySchema>;
	agent?: string;
	model?: string;
	thinking?: string;
	children?: SubagentNode[];
}

export const subagentNodeSchema: z.ZodType<SubagentNode> = z.lazy(() =>
	z
		.object({
			id: z.string().min(1).max(256),
			kind: z.string().min(1).max(64),
			label: z.string().max(512),
			state: subagentStateSchema,
			startedAt: z.number().optional(),
			updatedAt: z.number().optional(),
			endedAt: z.number().optional(),
			activity: subagentActivitySchema.optional(),
			agent: z.string().max(256).optional(),
			model: z.string().max(512).optional(),
			thinking: z.string().max(64).optional(),
			children: z.array(subagentNodeSchema).max(100).optional(),
		})
		.passthrough(),
);

export const subagentSnapshotSchema = z
	.object({
		kind: z.literal("pi-subagents.async-status-snapshot"),
		version: z.literal(1),
		generatedAt: z.number(),
		runs: z.array(subagentNodeSchema).max(20),
	})
	.passthrough();

export type SubagentSnapshot = z.infer<typeof subagentSnapshotSchema>;

export function isSubagentActive(node: SubagentNode): boolean {
	// 终态节点不再等待；即使插件保留了未清理的子节点，也不能把失败任务算作运行中。
	if (node.state !== "queued" && node.state !== "running") return false;
	return node.children?.length ? node.children.some(isSubagentActive) : true;
}

export function hasActiveSubagents(snapshot: SubagentSnapshot | undefined): boolean {
	return snapshot?.runs.some(isSubagentActive) ?? false;
}

export function countSubagents(snapshot: SubagentSnapshot | undefined): { active: number; total: number } {
	let active = 0;
	let total = 0;
	const visit = (node: SubagentNode) => {
		total += 1;
		if (isSubagentActive(node)) active += 1;
		for (const child of node.children ?? []) visit(child);
	};
	for (const run of snapshot?.runs ?? []) visit(run);
	return { active, total };
}
