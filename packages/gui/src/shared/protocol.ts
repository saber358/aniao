import { z } from "zod";
import type { BrowserPort } from "./browser.ts";
import { builtinCallSchema, builtinResultSchema } from "./builtin-mcp.ts";
import { CLIPBOARD_TEXT_LIMIT, type ClipboardPort } from "./clipboard.ts";
import type { DataStatisticsPort } from "./data-statistics.ts";
import type { EditAction } from "./edit.ts";
import type { GitDiff, GitDiffRequest, GitMutationRequest, GitStatus } from "./git.ts";
import type { GitWorktree, WorktreeCreate, WorktreeRemove } from "./git-worktree.ts";
import {
	type GoalReadRequest,
	type GoalSnapshot,
	goalActionSchema,
	goalReadRequestSchema,
	goalSnapshotSchema,
} from "./goals.ts";
import { imageIdSchema, imageIdsSchema, imageUrlSchema, toolImageIdsSchema } from "./image-schema.ts";
import type { ImagesPort } from "./images.ts";
import { DRAFT_TEXT_LIMIT } from "./input-limits.ts";
import { authenticationSchema, dialogReplySchema, dialogRequestSchema, extensionStateSchema } from "./interactions.ts";
import type { McpPort } from "./mcp.ts";
import { mcpConnectionSchema } from "./mcp.ts";
import type { ParallelCancel, ParallelJob, ParallelOpen, ParallelStart } from "./parallel.ts";
import { planStateSchema } from "./plan.ts";
import type { PluginPackage, PluginScope } from "./plugins.ts";
import { pluginPackageListSchema, pluginScopeSchema } from "./plugins.ts";
import type {
	ProjectDirectory,
	ProjectDirectoryRequest,
	ProjectFileContent,
	ProjectFilePreview,
	ProjectReadRequest,
} from "./project-browser.ts";
import type { ProjectFilesPort } from "./project-files.ts";
import { customProviderInputSchema } from "./provider.ts";
import { queueModeSchema, queueStateSchema } from "./queue.ts";
import { resourceSnapshotSchema } from "./resources.ts";
import type { ScheduleCreate, ScheduledSnapshot, SchedulePause } from "./schedule.ts";
import { type SubagentInspection, subagentInspectionSchema, subagentOutputRequestSchema } from "./subagents.ts";
import type {
	TerminalClose,
	TerminalCreate,
	TerminalEvent,
	TerminalResize,
	TerminalSession,
	TerminalWrite,
} from "./terminal.ts";
import type { UpdatePort } from "./update.ts";
import {
	draftSchema,
	type SessionIdentity,
	type SessionRuntime,
	sessionIdSchema,
	sessionRuntimeSchema,
	sessionSummarySchema,
	sessionTargetSchema,
	sessionTitleSchema,
	type WorkspacePort,
} from "./workspace.ts";

/*
 * ========================================================================
 * 步骤1：定义可序列化的桌面业务协议
 * ========================================================================
 * 数据源：宿主归一化后的 Pi 消息和运行事实。
 * 操作：
 *   1) 用同一 schema 推导类型并校验跨进程数据
 *   2) 不暴露 SDK、Electron、Vue 对象或认证读取接口
 */
// 1.1 文本和标识设定传输上限，工具完整结果仍由 Pi 会话保存。
const identifier = z.string().min(1).max(4096);
export const clipboardTextSchema = z.string().min(1).max(CLIPBOARD_TEXT_LIMIT);
export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const runStateSchema = z.object({
	phase: z.enum([
		"idle",
		"initializing",
		"preparing",
		"working",
		"waiting",
		"stopping",
		"compacting",
		"retrying",
		"settling",
	]),
	detail: z.string().max(8192).optional(),
});
export const messageSchema = z.object({
	id: identifier,
	forkEntryId: sessionIdSchema.optional(),
	timestamp: z.number().optional(),
	textTruncated: z.boolean().optional(),
	streaming: z.boolean().optional(),
	imageIds: imageIdsSchema.optional(),
	role: z.enum(["user", "assistant"]),
	blocks: z.array(
		z.object({
			kind: z.enum(["text", "thinking"]),
			text: z.string().max(2_000_000),
			durationMs: z.number().nonnegative().optional(),
		}),
	),
	error: z.string().max(8192).optional(),
});
export const toolSchema = z.object({
	id: identifier,
	messageId: identifier,
	name: identifier,
	input: z.string().max(65536),
	output: z.string().max(262144),
	truncated: z.boolean(),
	state: z.enum(["running", "succeeded", "failed", "interrupted"]),
	imageIds: toolImageIdsSchema.optional(),
});
export const modelSchema = z.object({
	key: identifier,
	provider: identifier,
	providerName: identifier.optional(),
	name: identifier,
	available: z.boolean(),
	supportsImages: z.boolean().optional(),
});
export const configurationSchema = z.object({
	model: modelSchema.nullable(),
	models: z.array(modelSchema).max(20000),
	customProviders: z.array(identifier).max(200).optional(),
	thinking: thinkingLevelSchema,
	thinkingLevels: z.array(thinkingLevelSchema),
});
export const contextUsageSchema = z.object({
	tokens: z.number().int().nonnegative().nullable(),
	contextWindow: z.number().int().positive(),
	percent: z.number().min(0).nullable(),
});

// 1.2 快照版本、宿主代次、序号各自独立，重连以快照为准。
export const snapshotSchema = z.object({
	version: z.literal(1),
	sessionId: identifier,
	generation: identifier,
	seq: z.number().int().nonnegative(),
	cwd: identifier,
	title: z.string().max(4096),
	messages: z.array(messageSchema),
	tools: z.array(toolSchema),
	run: runStateSchema,
	configuration: configurationSchema,
	queue: queueStateSchema,
	dialogs: z.array(dialogRequestSchema).max(8),
	authentication: authenticationSchema,
	extensions: extensionStateSchema,
	resources: resourceSnapshotSchema.optional(),
	plan: planStateSchema.optional(),
	contextUsage: contextUsageSchema.optional(),
});
export const commandSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("prompt"),
		text: z.string().trim().min(1).max(DRAFT_TEXT_LIMIT),
		imageIds: imageIdsSchema.optional(),
		plan: z.boolean().optional(),
	}),
	z
		.object({
			type: z.literal("enqueue"),
			mode: queueModeSchema,
			text: z.string().trim().min(1).max(DRAFT_TEXT_LIMIT),
			imageIds: imageIdsSchema.optional(),
		})
		.strict(),
	z.object({ type: z.literal("clearQueue") }),
	z.object({ type: z.literal("reloadResources") }),
	z.object({ type: z.literal("abort") }),
	z.object({ type: z.literal("setModel"), key: identifier }),
	z.object({ type: z.literal("setThinking"), level: thinkingLevelSchema }),
	z.object({ type: z.literal("setApiKey"), provider: identifier, key: z.string().trim().min(1).max(16384) }),
	z.object({ type: z.literal("saveProvider"), provider: customProviderInputSchema }),
	z.object({ type: z.literal("goalCommand"), action: goalActionSchema, goalId: z.string().min(1).max(200) }),
	z.object({
		type: z.literal("queueAction"),
		action: z.enum(["steer", "remove", "edit"]),
		itemId: z.string().uuid(),
		text: z.string().min(1).max(1_000_000).optional(),
	}),
	z.object({ type: z.literal("deleteProvider"), provider: identifier }),
	z.object({ type: z.literal("login"), provider: identifier }),
	z.object({ type: z.literal("logout"), provider: identifier }),
	z.object({ type: z.literal("approvePlan"), text: z.string().trim().min(1).max(200_000) }),
	z.object({ type: z.literal("editPlan"), text: z.string().max(200_000) }),
	z.object({ type: z.literal("rejectPlan") }),
	z.object({ type: z.literal("dismissPlan") }),
	z.object({ type: z.literal("cancelLogin") }),
	z.object({ type: z.literal("reply"), reply: dialogReplySchema }),
	z.object({ type: z.literal("dismissNotice"), id: z.string().uuid() }),
]);
export const commandEnvelopeSchema = z.object({
	requestId: identifier,
	sessionId: identifier,
	generation: identifier,
	command: commandSchema,
});
export const eventEnvelopeSchema = z.object({
	sessionId: identifier,
	generation: identifier,
	seq: z.number().int().positive(),
	event: z.discriminatedUnion("type", [
		z.object({ type: z.literal("message"), message: messageSchema }),
		z.object({ type: z.literal("tool"), tool: toolSchema }),
		z.object({ type: z.literal("run"), run: runStateSchema }),
		z.object({ type: z.literal("configuration"), configuration: configurationSchema }),
		z.object({ type: z.literal("resources"), resources: resourceSnapshotSchema }),
		z.object({ type: z.literal("title"), title: z.string().max(200) }),
		z.object({ type: z.literal("queue"), queue: queueStateSchema }),
		z.object({ type: z.literal("dialogs"), dialogs: z.array(dialogRequestSchema).max(8) }),
		z.object({ type: z.literal("authentication"), authentication: authenticationSchema }),
		z.object({ type: z.literal("extensions"), extensions: extensionStateSchema }),
		z.object({ type: z.literal("plan"), plan: planStateSchema }),
		z.object({ type: z.literal("contextUsage"), contextUsage: contextUsageSchema }),
	]),
});
export const notificationSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("event"), value: eventEnvelopeSchema }),
	z.object({
		type: z.literal("disconnected"),
		reason: z.string().max(8192),
		sessionId: identifier.optional(),
		generation: identifier.optional(),
	}),
	z.object({ type: z.literal("sessions"), sessions: z.array(sessionRuntimeSchema).max(20000) }),
]);

// 1.3 宿主 RPC 与业务事件共用校验，但不混用请求编号与事件序号。
export const hostRequestSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("builtinResult"), id: identifier, value: builtinResultSchema }),
	z.object({ type: z.literal("mcpStatus"), id: identifier }),
	goalReadRequestSchema.extend({ type: z.literal("goals"), id: identifier }),
	subagentOutputRequestSchema.extend({ type: z.literal("subagentInspection"), id: identifier }),
	z.object({ type: z.literal("transition"), id: identifier, target: sessionTargetSchema }),
	z.object({ type: z.literal("image"), id: identifier, imageId: imageIdSchema }),
	z.object({ type: z.literal("snapshot"), id: identifier }),
	z.object({ type: z.literal("history"), id: identifier }),
	z.object({
		type: z.literal("renameSession"),
		id: identifier,
		cwd: z.string().min(1).max(4096),
		sessionId: sessionIdSchema,
		title: sessionTitleSchema,
	}),
	z.object({ type: z.literal("command"), id: identifier, value: commandEnvelopeSchema }),
	z.object({
		type: z.literal("subagentOutput"),
		id: identifier,
		runId: identifier,
		childId: identifier.optional(),
	}),
	z.object({
		type: z.literal("subagentTranscript"),
		id: identifier,
		runId: identifier,
		childId: identifier.optional(),
	}),
	z.object({
		type: z.literal("plugins"),
		id: identifier,
		action: z.enum(["list", "install", "remove"]),
		source: z.string().trim().min(1).max(4096).optional(),
		scope: pluginScopeSchema.optional(),
	}),
	z.object({ type: z.literal("shutdown"), id: identifier }),
]);
export const hostResponseSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("builtinCancel"), id: identifier }),
	z.object({ type: z.literal("builtinCall"), id: identifier, value: builtinCallSchema }),
	z.object({ type: z.literal("mcpStatus"), id: identifier, value: z.array(mcpConnectionSchema).max(200) }),
	z.object({ type: z.literal("goals"), id: identifier, value: goalSnapshotSchema }),
	z.object({ type: z.literal("subagentInspection"), id: identifier, value: subagentInspectionSchema }),
	z.object({ type: z.literal("image"), id: identifier, url: imageUrlSchema }),
	z.object({ type: z.literal("ready"), forkDraft: draftSchema.shape.text.min(1).optional() }),
	z.object({ type: z.literal("event"), value: eventEnvelopeSchema }),
	z.object({ type: z.literal("snapshot"), id: identifier, value: snapshotSchema }),
	z.object({ type: z.literal("history"), id: identifier, value: z.array(sessionSummarySchema).max(20000) }),
	z.object({ type: z.literal("plugins"), id: identifier, value: pluginPackageListSchema }),
	z.object({ type: z.literal("subagentOutput"), id: identifier, value: z.string().max(500_000).nullable() }),
	z.object({
		type: z.literal("subagentTranscript"),
		id: identifier,
		value: z.string().max(2_000_000).nullable(),
	}),
	z.object({ type: z.literal("result"), id: identifier }),
	z.object({ type: z.literal("error"), id: identifier, message: z.string().max(8192) }),
]);

export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type ToolActivity = z.infer<typeof toolSchema>;
export type ContextUsage = z.infer<typeof contextUsageSchema>;
export type Configuration = z.infer<typeof configurationSchema>;
export type SessionSnapshot = z.infer<typeof snapshotSchema>;
export type GuiCommand = z.infer<typeof commandSchema>;
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type SessionEvent = z.infer<typeof eventEnvelopeSchema>;
export type PortNotification = z.infer<typeof notificationSchema>;
export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostResponse = z.infer<typeof hostResponseSchema>;

// 1.4 初始化占用会话入口，但没有任务；所有运行标记共用这个判断。
export function isTaskRunning(phase: SessionSnapshot["run"]["phase"]): boolean {
	return phase !== "idle" && phase !== "initializing";
}

export interface AgentPort {
	getSnapshot(): Promise<SessionSnapshot | null>;
	dispatch(command: CommandEnvelope): Promise<void>;
	subscribe(listener: (notification: PortNotification) => void): () => void;
}

export interface GitPort {
	gitStatus(cwd: string): Promise<GitStatus>;
	gitDiff(request: GitDiffRequest): Promise<GitDiff>;
	gitMutate(request: GitMutationRequest): Promise<GitStatus>;
}

export interface TerminalPort {
	terminalCreate(request: TerminalCreate): Promise<TerminalSession>;
	terminalWrite(request: TerminalWrite): void;
	terminalResize(request: TerminalResize): void;
	terminalClose(request: TerminalClose): void;
	subscribeTerminal(listener: (event: TerminalEvent) => void): () => void;
}

export interface WorktreePort {
	listWorktrees(cwd: string): Promise<GitWorktree[]>;
	createWorktree(request: WorktreeCreate): Promise<GitWorktree>;
	removeWorktree(request: WorktreeRemove): Promise<GitWorktree[]>;
}

export interface ProjectBrowserPort {
	listDirectory(request: ProjectDirectoryRequest): Promise<ProjectDirectory>;
	readProjectFile(request: ProjectReadRequest): Promise<ProjectFileContent>;
	previewProjectFile(request: ProjectReadRequest): Promise<ProjectFilePreview>;
}

export interface ParallelPort {
	listParallelJobs(): Promise<ParallelJob[]>;
	startParallelJob(request: ParallelStart): Promise<ParallelJob>;
	cancelParallelJob(request: ParallelCancel): Promise<ParallelJob | null>;
	openParallelJob(request: ParallelOpen): Promise<void>;
}

export interface SchedulePort {
	listSchedules(): Promise<ScheduledSnapshot>;
	createSchedule(request: ScheduleCreate): Promise<ScheduledSnapshot>;
	pauseSchedule(request: SchedulePause): Promise<ScheduledSnapshot>;
	runScheduleNow(id: string): Promise<ScheduledSnapshot>;
	deleteSchedule(id: string): Promise<ScheduledSnapshot>;
}

export interface DesktopBridge
	extends AgentPort,
		DataStatisticsPort,
		WorkspacePort,
		ClipboardPort,
		ProjectFilesPort,
		ImagesPort,
		GitPort,
		TerminalPort,
		WorktreePort,
		ProjectBrowserPort,
		ParallelPort,
		SchedulePort,
		BrowserPort,
		McpPort,
		UpdatePort {
	openProject(): Promise<boolean>;
	getSessionSnapshot(identity: SessionIdentity): Promise<SessionSnapshot | null>;
	getSessionRuntimes(): Promise<SessionRuntime[]>;
	newSession(): Promise<void>;
	openExternal(url: string): Promise<void>;
	openConfig(): Promise<void>;
	openSkillsDirectory(): Promise<void>;
	listPlugins(cwd: string): Promise<PluginPackage[]>;
	installPlugin(cwd: string, source: string): Promise<PluginPackage[]>;
	removePlugin(cwd: string, source: string, scope: PluginScope): Promise<PluginPackage[]>;
	readSubagentOutput(runId: string, childId?: string): Promise<string | null>;
	readSubagentTranscript(runId: string, childId?: string): Promise<string | null>;
	inspectSubagent(runId: string, childId?: string): Promise<SubagentInspection>;
	readGoals(request: GoalReadRequest): Promise<GoalSnapshot>;
	edit(action: EditAction): Promise<void>;
	minimizeWindow(): void;
	toggleMaximizeWindow(): void;
	closeWindow(): void;
}

export const IPC_CHANNELS = {
	usageStatistics: "pi-gui:usage-statistics",
	archiveSnapshot: "pi-gui:archive-snapshot",
	archivePolicy: "pi-gui:archive-policy",
	archiveRestore: "pi-gui:archive-restore",
	archiveDelete: "pi-gui:archive-delete",
	snapshot: "pi-gui:snapshot",
	sessionSnapshot: "pi-gui:session-snapshot",
	sessionRuntimes: "pi-gui:session-runtimes",
	command: "pi-gui:command",
	notification: "pi-gui:notification",
	openProject: "pi-gui:open-project",
	newSession: "pi-gui:new-session",
	openExternal: "pi-gui:open-external",
	openConfig: "pi-gui:open-config",
	edit: "pi-gui:edit",
	browserCreate: "pi-gui:browser-create",
	browserNavigate: "pi-gui:browser-navigate",
	browserNavigateFile: "pi-gui:browser-navigate-file",
	browserAction: "pi-gui:browser-action",
	browserLayout: "pi-gui:browser-layout",
	browserClose: "pi-gui:browser-close",
	browserEvent: "pi-gui:browser-event",
	browserPresentation: "pi-gui:browser-presentation",
	mcpReconnect: "pi-gui:mcp-reconnect",
	windowMinimize: "pi-gui:window-minimize",
	windowToggleMaximize: "pi-gui:window-toggle-maximize",
	windowClose: "pi-gui:window-close",
	gitStatus: "pi-gui:git-status",
	gitDiff: "pi-gui:git-diff",
	gitMutate: "pi-gui:git-mutate",
	terminalCreate: "pi-gui:terminal-create",
	terminalWrite: "pi-gui:terminal-write",
	terminalResize: "pi-gui:terminal-resize",
	terminalClose: "pi-gui:terminal-close",
	terminalEvent: "pi-gui:terminal-event",
	worktreeList: "pi-gui:worktree-list",
	worktreeCreate: "pi-gui:worktree-create",
	worktreeRemove: "pi-gui:worktree-remove",
	directoryList: "pi-gui:directory-list",
	projectFileRead: "pi-gui:project-file-read",
	projectFilePreview: "pi-gui:project-file-preview",
	parallelList: "pi-gui:parallel-list",
	parallelStart: "pi-gui:parallel-start",
	parallelCancel: "pi-gui:parallel-cancel",
	parallelOpen: "pi-gui:parallel-open",
	scheduleList: "pi-gui:schedule-list",
	scheduleCreate: "pi-gui:schedule-create",
	schedulePause: "pi-gui:schedule-pause",
	scheduleRun: "pi-gui:schedule-run",
	scheduleDelete: "pi-gui:schedule-delete",
	updateState: "pi-gui:update-state",
	updateCheck: "pi-gui:update-check",
	updateDownload: "pi-gui:update-download",
	updateInstall: "pi-gui:update-install",
	updateEvent: "pi-gui:update-event",
	mcpList: "pi-gui:mcp-list",
	mcpSave: "pi-gui:mcp-save",
	mcpRemove: "pi-gui:mcp-remove",
	mcpToggle: "pi-gui:mcp-toggle",
	openSkills: "pi-gui:open-skills",
	pluginsList: "pi-gui:plugins-list",
	pluginsInstall: "pi-gui:plugins-install",
	pluginsRemove: "pi-gui:plugins-remove",
	subagentOutput: "pi-gui:subagent-output",
	subagentTranscript: "pi-gui:subagent-transcript",
	subagentInspection: "pi-gui:subagent-inspection",
	goalsRead: "pi-gui:goals-read",
	library: "pi-gui:library",
	projects: "pi-gui:projects",
	openWorkspace: "pi-gui:open-workspace",
	renameWorkspace: "pi-gui:rename-workspace",
	removeWorkspace: "pi-gui:remove-workspace",
	newSessionAt: "pi-gui:new-session-at",
	openSession: "pi-gui:open-session",
	openSessionAt: "pi-gui:open-session-at",
	forkSession: "pi-gui:fork-session",
	updateSession: "pi-gui:update-session",
	loadDraft: "pi-gui:load-draft",
	saveDraft: "pi-gui:save-draft",
	writeClipboard: "pi-gui:write-clipboard",
	selectProjectFiles: "pi-gui:select-project-files",
	searchProjectFiles: "pi-gui:search-project-files",
	validateProjectFiles: "pi-gui:validate-project-files",
	selectImages: "pi-gui:select-images",
	importImages: "pi-gui:import-images",
	readImage: "pi-gui:read-image",
} as const;
