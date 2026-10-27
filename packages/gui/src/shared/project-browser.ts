import { z } from "zod";

// 文件列表与标签使用同一组图片格式，预览仍由主进程读取项目内文件。
export const PROJECT_IMAGE_PATTERN = /\.(?:png|jpe?g|gif|webp|svg)$/i;

export const projectDirectorySchema = z.object({
	cwd: z.string().min(1).max(4096),
	path: z.string().max(4096).default(""),
});

export const projectReadSchema = z.object({
	cwd: z.string().min(1).max(4096),
	path: z.string().min(1).max(4096),
});

export interface ProjectEntry {
	name: string;
	path: string;
	type: "file" | "directory";
}

export interface ProjectDirectory {
	path: string;
	entries: ProjectEntry[];
	truncated: boolean;
}

export interface ProjectFileContent {
	path: string;
	text: string;
	binary: boolean;
	truncated: boolean;
}

export type ProjectFilePreview =
	| { kind: "text"; path: string; text: string; truncated: boolean }
	| { kind: "document"; path: string; text: string; format: string }
	| { kind: "image"; path: string; dataUrl: string }
	| { kind: "pdf"; path: string; url: string }
	| { kind: "unsupported"; path: string };

export type ProjectDirectoryRequest = z.infer<typeof projectDirectorySchema>;
export type ProjectReadRequest = z.infer<typeof projectReadSchema>;
