import { z } from "zod";

export const gitStatusRequestSchema = z.object({
	cwd: z.string().min(1).max(4096),
});

export const gitDiffRequestSchema = z.object({
	cwd: z.string().min(1).max(4096),
	path: z.string().min(1).max(4096),
	originalPath: z.string().min(1).max(4096).optional(),
	staged: z.boolean(),
});

export const gitMutationRequestSchema = z.object({
	cwd: z.string().min(1).max(4096),
	path: z.string().min(1).max(4096),
	originalPath: z.string().min(1).max(4096).optional(),
	action: z.enum(["stage", "unstage", "discard"]),
	expectedHead: z.string().max(128),
	expectedIndex: z.string().length(1),
	expectedWorktree: z.string().length(1),
	expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
});

export interface GitFileChange {
	path: string;
	originalPath?: string;
	index: string;
	worktree: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
}

export interface GitStatus {
	root: string;
	head: string;
	branch: string;
	ahead: number;
	behind: number;
	files: GitFileChange[];
}

export interface GitDiff {
	version: string;
	path: string;
	originalPath?: string;
	original: string;
	modified: string;
	binary: boolean;
	truncated: boolean;
}

export type GitStatusRequest = z.infer<typeof gitStatusRequestSchema>;
export type GitDiffRequest = z.infer<typeof gitDiffRequestSchema>;
export type GitMutationRequest = z.infer<typeof gitMutationRequestSchema>;
