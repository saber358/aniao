import { z } from "zod";

export const worktreeCreateSchema = z.object({
	cwd: z.string().min(1).max(4096),
	branch: z.string().min(1).max(120),
	baseRef: z.string().min(1).max(200).default("HEAD"),
});

export const worktreeRemoveSchema = z.object({
	cwd: z.string().min(1).max(4096),
	path: z.string().min(1).max(4096),
	expectedHead: z.string().max(128),
});

export interface GitWorktree {
	path: string;
	head: string;
	branch?: string;
	detached: boolean;
	bare: boolean;
	current: boolean;
}

export type WorktreeCreate = z.infer<typeof worktreeCreateSchema>;
export type WorktreeRemove = z.infer<typeof worktreeRemoveSchema>;
