import { z } from "zod";

export const goalStatusSchema = z.enum(["running", "idle", "paused", "blocked", "budget_limited", "complete"]);

export const goalTaskStatusSchema = z.enum(["pending", "complete", "skipped"]);

export const goalTaskViewSchema = z.object({
	id: z.string().min(1).max(200),
	title: z.string().min(1).max(2000),
	status: goalTaskStatusSchema,
	depth: z.number().int().min(0).max(20),
	current: z.boolean(),
	verificationContract: z.string().max(8000).optional(),
	evidence: z.string().max(8000).optional(),
});

export const goalViewSchema = z.object({
	id: z.string().min(1).max(200),
	title: z.string().min(1).max(500),
	objective: z.string().min(1).max(20_000),
	status: goalStatusSchema,
	autoContinue: z.boolean(),
	sisyphus: z.boolean(),
	auditor: z.boolean(),
	usage: z.object({
		tokensUsed: z.number().int().nonnegative(),
		activeSeconds: z.number().int().nonnegative(),
	}),
	progress: z
		.object({
			completed: z.number().int().nonnegative(),
			total: z.number().int().nonnegative(),
			percentage: z.number().min(0).max(100),
		})
		.optional(),
	currentTask: z.object({ id: z.string().max(200), title: z.string().max(2000) }).optional(),
	tasks: z.array(goalTaskViewSchema).max(500),
	verificationContract: z.string().max(20_000).optional(),
	pauseReason: z.string().max(8000).optional(),
	activePath: z.string().max(1000).optional(),
	updatedAt: z.string().max(100).optional(),
});

export const goalSnapshotSchema = z.object({
	goals: z.array(goalViewSchema).max(20),
	generatedAt: z.number().int().nonnegative(),
});

export const goalReadRequestSchema = z
	.object({ cwd: z.string().min(1).max(4096), sessionId: z.string().min(1).max(200) })
	.strict();

export type GoalStatus = z.infer<typeof goalStatusSchema>;
export type GoalTaskStatus = z.infer<typeof goalTaskStatusSchema>;
export type GoalTaskView = z.infer<typeof goalTaskViewSchema>;
export type GoalView = z.infer<typeof goalViewSchema>;
export type GoalSnapshot = z.infer<typeof goalSnapshotSchema>;
