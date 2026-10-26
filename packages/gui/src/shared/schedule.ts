import { z } from "zod";
import { DRAFT_TEXT_LIMIT } from "./input-limits.ts";
import { parallelJobStatusSchema } from "./parallel.ts";

export const scheduledTaskSchema = z.object({
	id: z.string().uuid(),
	cwd: z.string().max(4096),
	title: z.string().max(200),
	prompt: z.string().max(DRAFT_TEXT_LIMIT),
	everyMinutes: z.number().int().min(5).max(10080),
	catchUp: z.boolean(),
	paused: z.boolean(),
	createdAt: z.number().int().nonnegative(),
	nextRunAt: z.number().int().nonnegative(),
	lastRunAt: z.number().int().nonnegative().optional(),
});

export const scheduledRunSchema = z.object({
	id: z.string().uuid(),
	taskId: z.string().uuid(),
	jobId: z.string().uuid().optional(),
	status: parallelJobStatusSchema,
	createdAt: z.number().int().nonnegative(),
	finishedAt: z.number().int().nonnegative().optional(),
	result: z.string().max(8000).optional(),
	error: z.string().max(8192).optional(),
});

export const scheduledSnapshotSchema = z.object({
	tasks: z.array(scheduledTaskSchema).max(50),
	runs: z.array(scheduledRunSchema).max(200),
	now: z.number().int().nonnegative(),
});

export const scheduleCreateSchema = z.object({
	cwd: z.string().min(1).max(4096),
	title: z.string().trim().max(200).optional(),
	text: z.string().trim().min(1).max(DRAFT_TEXT_LIMIT),
	everyMinutes: z.number().int().min(5).max(10080),
	catchUp: z.boolean().default(false),
});

export const schedulePauseSchema = z.object({
	id: z.string().uuid(),
	paused: z.boolean(),
});

export const scheduleIdSchema = z.object({
	id: z.string().uuid(),
});

export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;
export type ScheduledRun = z.infer<typeof scheduledRunSchema>;
export type ScheduledSnapshot = z.infer<typeof scheduledSnapshotSchema>;
export type ScheduleCreate = z.infer<typeof scheduleCreateSchema>;
export type SchedulePause = z.infer<typeof schedulePauseSchema>;
