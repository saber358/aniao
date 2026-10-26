import { z } from "zod";
import { DRAFT_TEXT_LIMIT } from "./input-limits.ts";

export const parallelJobStatusSchema = z.enum(["queued", "running", "completed", "failed", "canceled", "interrupted"]);

export const parallelJobSchema = z.object({
	id: z.string().uuid(),
	cwd: z.string().max(4096),
	executionCwd: z.string().max(4096).optional(),
	branch: z.string().max(200).optional(),
	title: z.string().max(200),
	prompt: z.string().max(DRAFT_TEXT_LIMIT),
	status: parallelJobStatusSchema,
	sessionId: z.string().max(512).optional(),
	error: z.string().max(8192).optional(),
	result: z.string().max(8000).optional(),
	createdAt: z.number().int().nonnegative(),
	startedAt: z.number().int().nonnegative().optional(),
	finishedAt: z.number().int().nonnegative().optional(),
});

export const parallelStartSchema = z.object({
	cwd: z.string().min(1).max(4096),
	text: z.string().trim().min(1).max(DRAFT_TEXT_LIMIT),
});

export const parallelCancelSchema = z.object({
	id: z.string().uuid(),
});

export const parallelOpenSchema = z.object({
	id: z.string().uuid(),
});

export type ParallelJobStatus = z.infer<typeof parallelJobStatusSchema>;
export type ParallelJob = z.infer<typeof parallelJobSchema>;
export type ParallelStart = z.infer<typeof parallelStartSchema>;
export type ParallelCancel = z.infer<typeof parallelCancelSchema>;
export type ParallelOpen = z.infer<typeof parallelOpenSchema>;
