import { z } from "zod";

export const SUBAGENT_STATUS_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const subagentIdSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9_-]+$/u);

export const subagentOutputRequestSchema = z
	.object({ runId: subagentIdSchema, childId: subagentIdSchema.optional() })
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
