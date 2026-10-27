import { z } from "zod";
import { imageBatchSchema, imageIdSchema, imageIdsSchema } from "./image-schema.ts";
import { DRAFT_TEXT_LIMIT } from "./input-limits.ts";
import { PROJECT_FILE_LIMIT, PROJECT_PATH_LIMIT, PROJECT_QUERY_LIMIT } from "./project-files.ts";

/*
 * ========================================================================
 * 步骤1：定义历史管理与草稿端口
 * ========================================================================
 * 数据源：SDK 会话摘要与桌面偏好，不传递会话文件路径。
 * 操作：
 *   1) 历史选择只使用会话身份，目录由桌面持有
 *   2) 草稿使用修订号，拒绝旧界面覆盖新内容
 */
export const sessionIdSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const sessionTitleSchema = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.regex(/^[^\r\n]*$/);
export const sessionSummarySchema = z.object({
	id: sessionIdSchema,
	parentId: sessionIdSchema.optional(),
	title: z.string().max(200),
	preview: z.string().max(500),
	updatedAt: z.number().int().nonnegative(),
	messageCount: z.number().int().nonnegative(),
	persisted: z.boolean(),
});
export const sessionItemSchema = sessionSummarySchema.extend({ pinned: z.boolean(), archived: z.boolean() });
export const librarySchema = z.object({
	cwd: z.string().min(1).max(4096),
	sessions: z.array(sessionItemSchema).max(20000),
});
export const projectSummarySchema = z.object({
	cwd: z.string().min(1).max(4096),
	name: z.string().min(1).max(200),
	sessions: z.array(sessionItemSchema).max(100),
});
export const workspacePathSchema = z.string().min(1).max(4096);
export const sessionIdentitySchema = z
	.object({ sessionId: sessionIdSchema, generation: z.string().min(1).max(4096) })
	.strict();
export const sessionRuntimeSchema = sessionIdentitySchema.extend({
	cwd: workspacePathSchema,
	title: z.string().max(4096),
	running: z.boolean(),
	attention: z.boolean(),
	connected: z.boolean(),
});
export type SessionIdentity = z.infer<typeof sessionIdentitySchema>;
export type SessionRuntime = z.infer<typeof sessionRuntimeSchema>;
export const workspaceNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[^\r\n]*$/);
export const sessionAtSchema = z.object({ cwd: workspacePathSchema, sessionId: sessionIdSchema });
export const workspaceRenameSchema = z.object({ cwd: workspacePathSchema, name: workspaceNameSchema });
export const sessionChangeSchema = z
	.object({
		sessionId: sessionIdSchema,
		title: sessionTitleSchema.optional(),
		pinned: z.boolean().optional(),
		archived: z.boolean().optional(),
	})
	.refine((value) => value.title !== undefined || value.pinned !== undefined || value.archived !== undefined);
export const draftSchema = z.object({
	text: z.string().max(DRAFT_TEXT_LIMIT),
	revision: z.number().int().nonnegative(),
	imageIds: imageIdsSchema.optional(),
});
export const draftWriteSchema = draftSchema.extend({ sessionId: sessionIdSchema });
export const forkSelectionSchema = z.object({
	sessionId: sessionIdSchema,
	generation: z.string().min(1).max(4096),
	entryId: sessionIdSchema,
});
export const projectFileSelectionSchema = z
	.object({ sessionId: sessionIdSchema, generation: z.string().min(1).max(4096) })
	.strict();
export const imageReadSchema = projectFileSelectionSchema.extend({
	imageId: imageIdSchema,
	source: z.enum(["draft", "message"]),
});
export const imageImportSchema = projectFileSelectionSchema.extend({ data: imageBatchSchema });
export const projectFilePathsSchema = z
	.array(
		z
			.string()
			.min(1)
			.max(PROJECT_PATH_LIMIT)
			.refine(
				(path) =>
					!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(path) &&
					!path.includes("\\") &&
					!path.startsWith("/") &&
					!/^[A-Za-z]:/.test(path) &&
					!path.split("/").some((part) => !part || part === "." || part === ".."),
			),
	)
	.max(PROJECT_FILE_LIMIT);
export const projectFileSearchSchema = projectFileSelectionSchema.extend({
	query: z
		.string()
		.trim()
		.max(PROJECT_QUERY_LIMIT)
		.regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u),
});
export const projectFileMatchesSchema = z.object({ paths: projectFilePathsSchema, incomplete: z.boolean() }).strict();
export const projectFileReferenceSchema = projectFileSelectionSchema.extend({ paths: projectFilePathsSchema.min(1) });
export const sessionTargetSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("recent") }),
	z.object({ type: z.literal("new") }),
	z.object({
		type: z.literal("session"),
		id: sessionIdSchema,
		allowCreate: z.boolean(),
		title: sessionTitleSchema.optional(),
	}),
	z.object({ type: z.literal("fork"), sourceId: sessionIdSchema, entryId: sessionIdSchema }),
]);

export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionItem = z.infer<typeof sessionItemSchema>;
export type SessionLibrary = z.infer<typeof librarySchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type SessionChange = z.infer<typeof sessionChangeSchema>;
export type SessionTarget = z.infer<typeof sessionTargetSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type DraftWrite = z.infer<typeof draftWriteSchema>;
export type ForkSelection = z.infer<typeof forkSelectionSchema>;

export interface DraftPort {
	loadDraft(sessionId: string): Promise<Draft>;
	saveDraft(input: DraftWrite): Promise<Draft>;
}

export interface WorkspacePort extends DraftPort {
	getLibrary(): Promise<SessionLibrary | null>;
	getProjects(): Promise<ProjectSummary[]>;
	openWorkspace(cwd: string): Promise<void>;
	renameWorkspace(cwd: string, name: string): Promise<void>;
	removeWorkspace(cwd: string): Promise<void>;
	newSessionAt(cwd: string): Promise<void>;
	openSession(sessionId: string): Promise<void>;
	openSessionAt(cwd: string, sessionId: string): Promise<void>;
	forkSession(selection: ForkSelection): Promise<void>;
	updateSession(change: SessionChange): Promise<void>;
}
