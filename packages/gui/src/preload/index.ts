import { contextBridge, ipcRenderer } from "electron";
import {
	browserActionSchema,
	browserIdSchema,
	browserLayoutSchema,
	browserNavigateFileSchema,
	browserNavigateSchema,
	browserStateSchema,
} from "../shared/browser.ts";
import {
	archivePolicySchema,
	archiveSelectionSchema,
	archiveSnapshotSchema,
	usageSnapshotSchema,
} from "../shared/data-statistics.ts";
import { editActionSchema } from "../shared/edit.ts";
import { gitDiffRequestSchema, gitMutationRequestSchema, gitStatusRequestSchema } from "../shared/git.ts";
import { worktreeCreateSchema, worktreeRemoveSchema } from "../shared/git-worktree.ts";
import { goalReadRequestSchema, goalSnapshotSchema } from "../shared/goals.ts";
import { imageIdsSchema, imageUrlSchema } from "../shared/image-schema.ts";
import { createLogger } from "../shared/logger.ts";
import { mcpServerInputSchema, mcpServerNameSchema, mcpServerSummarySchema } from "../shared/mcp.ts";
import { parallelCancelSchema, parallelOpenSchema, parallelStartSchema } from "../shared/parallel.ts";
import {
	pluginInstallRequestSchema,
	pluginListRequestSchema,
	pluginPackageListSchema,
	pluginRemoveRequestSchema,
} from "../shared/plugins.ts";
import { projectDirectorySchema, projectReadSchema } from "../shared/project-browser.ts";
import {
	clipboardTextSchema,
	commandEnvelopeSchema,
	type DesktopBridge,
	IPC_CHANNELS,
	notificationSchema,
	snapshotSchema,
} from "../shared/protocol.ts";
import { scheduleCreateSchema, scheduleIdSchema, schedulePauseSchema } from "../shared/schedule.ts";
import { STARTUP_CHANNELS } from "../shared/startup.ts";
import { subagentInspectionSchema, subagentOutputRequestSchema } from "../shared/subagents.ts";
import {
	terminalCloseSchema,
	terminalCreateSchema,
	terminalEventSchema,
	terminalResizeSchema,
	terminalWriteSchema,
} from "../shared/terminal.ts";
import { updateStateSchema } from "../shared/update.ts";
import {
	draftSchema,
	draftWriteSchema,
	forkSelectionSchema,
	imageImportSchema,
	imageReadSchema,
	librarySchema,
	projectFileMatchesSchema,
	projectFilePathsSchema,
	projectFileReferenceSchema,
	projectFileSearchSchema,
	projectFileSelectionSchema,
	projectSummarySchema,
	sessionAtSchema,
	sessionChangeSchema,
	sessionIdentitySchema,
	sessionIdSchema,
	sessionRuntimeSchema,
	workspacePathSchema,
	workspaceRenameSchema,
} from "../shared/workspace.ts";

const logger = createLogger("preload");

/*
 * ========================================================================
 * 步骤1：暴露有限业务能力
 * ========================================================================
 * 数据源：受限 IPC 通道；不暴露 ipcRenderer 本身。
 * 操作：
 *   1) 双向校验业务负载
 *   2) 为每个订阅返回对应释放函数
 */
logger.info("开始安装桌面业务桥");
const bridge: DesktopBridge = {
	getUsageStatistics: async () => usageSnapshotSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.usageStatistics)),
	getArchiveSnapshot: async () => archiveSnapshotSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.archiveSnapshot)),
	saveArchivePolicy: async (policy) =>
		archiveSnapshotSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.archivePolicy, archivePolicySchema.parse(policy)),
		),
	restoreArchived: async (selection) =>
		archiveSnapshotSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.archiveRestore, archiveSelectionSchema.parse(selection)),
		),
	deleteArchived: async (selection) =>
		archiveSnapshotSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.archiveDelete, archiveSelectionSchema.parse(selection)),
		),
	// 1.1 快照和事件从 unknown 校验，不能把宿主对象直接带入页面。
	getSnapshot: async () => snapshotSchema.nullable().parse(await ipcRenderer.invoke(IPC_CHANNELS.snapshot)),
	getSessionSnapshot: async (identity) =>
		snapshotSchema
			.nullable()
			.parse(await ipcRenderer.invoke(IPC_CHANNELS.sessionSnapshot, sessionIdentitySchema.parse(identity))),
	getSessionRuntimes: async () =>
		sessionRuntimeSchema
			.array()
			.max(20000)
			.parse(await ipcRenderer.invoke(IPC_CHANNELS.sessionRuntimes)),
	dispatch: async (command) => {
		// 1.2 Zod 已校验；再做一次 JSON 归一化，避免 Vue reactive Proxy 进入 structured clone。
		const envelope = JSON.parse(JSON.stringify(commandEnvelopeSchema.parse(command))) as unknown;
		await ipcRenderer.invoke(IPC_CHANNELS.command, envelope);
	},
	subscribe: (listener) => {
		const receive = (_event: Electron.IpcRendererEvent, input: unknown) => {
			const parsed = notificationSchema.safeParse(input);
			if (parsed.success) listener(parsed.data);
			else listener({ type: "disconnected", reason: "界面消息协议不匹配" });
		};
		ipcRenderer.on(IPC_CHANNELS.notification, receive);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.notification, receive);
		};
	},
	// 1.2 目录选择由主进程持有，不给 Renderer 通用路径读取能力。
	openProject: async () => (await ipcRenderer.invoke(IPC_CHANNELS.openProject)) === true,
	newSession: async () => {
		await ipcRenderer.invoke(IPC_CHANNELS.newSession);
	},
	openExternal: async (url) => {
		await ipcRenderer.invoke(IPC_CHANNELS.openExternal, url);
	},
	openConfig: async () => {
		await ipcRenderer.invoke(IPC_CHANNELS.openConfig);
	},
	openSkillsDirectory: async () => {
		await ipcRenderer.invoke(IPC_CHANNELS.openSkills);
	},
	listPlugins: async (cwd) =>
		pluginPackageListSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.pluginsList, pluginListRequestSchema.parse({ cwd })),
		),
	installPlugin: async (cwd, source) =>
		pluginPackageListSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.pluginsInstall, pluginInstallRequestSchema.parse({ cwd, source })),
		),
	removePlugin: async (cwd, source, scope) =>
		pluginPackageListSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.pluginsRemove, pluginRemoveRequestSchema.parse({ cwd, source, scope })),
		),
	readSubagentOutput: async (runId, childId) => {
		const input = subagentOutputRequestSchema.parse({ runId, ...(childId ? { childId } : {}) });
		const value = await ipcRenderer.invoke(IPC_CHANNELS.subagentOutput, input);
		return typeof value === "string" ? value : null;
	},
	inspectSubagent: async (runId, childId) => {
		logger.info("开始请求子智能体详情");
		try {
			// 1.7 官方详情使用统一目标校验和结构化回复，不把路径暴露给页面。
			const input = subagentOutputRequestSchema.parse({ runId, childId });
			return subagentInspectionSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.subagentInspection, input));
		} finally {
			logger.info("子智能体详情请求结束");
		}
	},
	readSubagentTranscript: async (runId, childId) => {
		const input = subagentOutputRequestSchema.parse({ runId, ...(childId ? { childId } : {}) });
		const value = await ipcRenderer.invoke(IPC_CHANNELS.subagentTranscript, input);
		return typeof value === "string" ? value : null;
	},
	readGoals: async (request) =>
		goalSnapshotSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.goalsRead, goalReadRequestSchema.parse(request))),
	// 1.5 编辑命令只携带固定动作，系统剪贴板内容不经过业务桥。
	edit: async (action) => {
		await ipcRenderer.invoke(IPC_CHANNELS.edit, editActionSchema.parse(action));
	},
	// 1.6 网页视图只暴露地址、固定动作和布局，不提供网页脚本或原生对象。
	browserCreate: async (id) =>
		browserStateSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.browserCreate, browserIdSchema.parse(id))),
	browserNavigate: async (request) => {
		await ipcRenderer.invoke(IPC_CHANNELS.browserNavigate, browserNavigateSchema.parse(request));
	},
	browserNavigateFile: async (request) => {
		await ipcRenderer.invoke(IPC_CHANNELS.browserNavigateFile, browserNavigateFileSchema.parse(request));
	},
	browserAction: async (request) => {
		await ipcRenderer.invoke(IPC_CHANNELS.browserAction, browserActionSchema.parse(request));
	},
	browserLayout: (request) => ipcRenderer.send(IPC_CHANNELS.browserLayout, browserLayoutSchema.parse(request)),
	browserClose: (id) => ipcRenderer.send(IPC_CHANNELS.browserClose, browserIdSchema.parse(id)),
	subscribeBrowser: (listener) => {
		const receive = (_event: Electron.IpcRendererEvent, input: unknown) => {
			const parsed = browserStateSchema.safeParse(input);
			if (parsed.success) listener(parsed.data);
		};
		ipcRenderer.on(IPC_CHANNELS.browserEvent, receive);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.browserEvent, receive);
	},
	getUpdateState: async () => updateStateSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.updateState)),
	checkForUpdates: async () => updateStateSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.updateCheck)),
	// 1.4 下载通过独立受限通道发起，返回状态仍需校验。
	downloadUpdate: async () => updateStateSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.updateDownload)),
	installUpdate: async () => {
		await ipcRenderer.invoke(IPC_CHANNELS.updateInstall);
	},
	subscribeUpdate: (listener) => {
		const receive = (_event: Electron.IpcRendererEvent, input: unknown) => {
			const parsed = updateStateSchema.safeParse(input);
			if (parsed.success) listener(parsed.data);
		};
		ipcRenderer.on(IPC_CHANNELS.updateEvent, receive);
		return () => {
			ipcRenderer.removeListener(IPC_CHANNELS.updateEvent, receive);
		};
	},
	listMcpServers: async () =>
		mcpServerSummarySchema
			.array()
			.max(200)
			.parse(await ipcRenderer.invoke(IPC_CHANNELS.mcpList)),
	saveMcpServer: async (request) =>
		mcpServerSummarySchema
			.array()
			.max(200)
			.parse(await ipcRenderer.invoke(IPC_CHANNELS.mcpSave, mcpServerInputSchema.parse(request))),
	removeMcpServer: async (name) =>
		mcpServerSummarySchema
			.array()
			.max(200)
			.parse(await ipcRenderer.invoke(IPC_CHANNELS.mcpRemove, mcpServerNameSchema.parse(name))),
	setMcpServerEnabled: async (name, enabled) =>
		mcpServerSummarySchema
			.array()
			.max(200)
			.parse(await ipcRenderer.invoke(IPC_CHANNELS.mcpToggle, mcpServerNameSchema.parse(name), Boolean(enabled))),
	getLibrary: async () => librarySchema.nullable().parse(await ipcRenderer.invoke(IPC_CHANNELS.library)),
	getProjects: async () =>
		projectSummarySchema
			.array()
			.max(500)
			.parse(await ipcRenderer.invoke(IPC_CHANNELS.projects)),
	openWorkspace: async (cwd) => {
		await ipcRenderer.invoke(IPC_CHANNELS.openWorkspace, workspacePathSchema.parse(cwd));
	},
	renameWorkspace: async (cwd, name) => {
		await ipcRenderer.invoke(IPC_CHANNELS.renameWorkspace, workspaceRenameSchema.parse({ cwd, name }));
	},
	removeWorkspace: async (cwd) => {
		await ipcRenderer.invoke(IPC_CHANNELS.removeWorkspace, workspacePathSchema.parse(cwd));
	},
	newSessionAt: async (cwd) => {
		await ipcRenderer.invoke(IPC_CHANNELS.newSessionAt, workspacePathSchema.parse(cwd));
	},
	openSessionAt: async (cwd, sessionId) => {
		await ipcRenderer.invoke(IPC_CHANNELS.openSessionAt, sessionAtSchema.parse({ cwd, sessionId }));
	},
	openSession: async (sessionId) => {
		await ipcRenderer.invoke(IPC_CHANNELS.openSession, sessionIdSchema.parse(sessionId));
	},
	forkSession: async (selection) => {
		await ipcRenderer.invoke(IPC_CHANNELS.forkSession, forkSelectionSchema.parse(selection));
	},
	updateSession: async (change) => {
		await ipcRenderer.invoke(IPC_CHANNELS.updateSession, sessionChangeSchema.parse(change));
	},
	loadDraft: async (sessionId) =>
		draftSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.loadDraft, sessionIdSchema.parse(sessionId))),
	saveDraft: async (input) =>
		draftSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.saveDraft, draftWriteSchema.parse(input))),
	writeClipboard: async (text) => {
		await ipcRenderer.invoke(IPC_CHANNELS.writeClipboard, clipboardTextSchema.parse(text));
	},
	selectProjectFiles: async (selection) =>
		projectFilePathsSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.selectProjectFiles, projectFileSelectionSchema.parse(selection)),
		),
	searchProjectFiles: async (input) =>
		projectFileMatchesSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.searchProjectFiles, projectFileSearchSchema.parse(input)),
		),
	validateProjectFiles: async (input) =>
		projectFilePathsSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.validateProjectFiles, projectFileReferenceSchema.parse(input)),
		),
	selectImages: async (selection) =>
		imageIdsSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.selectImages, projectFileSelectionSchema.parse(selection)),
		),
	importImages: async (input) =>
		imageIdsSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.importImages, imageImportSchema.parse(input))),
	readImage: async (input) =>
		imageUrlSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.readImage, imageReadSchema.parse(input))),
	minimizeWindow: () => ipcRenderer.send(IPC_CHANNELS.windowMinimize),
	toggleMaximizeWindow: () => ipcRenderer.send(IPC_CHANNELS.windowToggleMaximize),
	closeWindow: () => ipcRenderer.send(IPC_CHANNELS.windowClose),
	gitStatus: async (cwd) => ipcRenderer.invoke(IPC_CHANNELS.gitStatus, gitStatusRequestSchema.parse({ cwd })),
	gitDiff: async (request) => ipcRenderer.invoke(IPC_CHANNELS.gitDiff, gitDiffRequestSchema.parse(request)),
	gitMutate: async (request) => ipcRenderer.invoke(IPC_CHANNELS.gitMutate, gitMutationRequestSchema.parse(request)),
	terminalCreate: async (request) =>
		ipcRenderer.invoke(IPC_CHANNELS.terminalCreate, terminalCreateSchema.parse(request)),
	terminalWrite: (request) => ipcRenderer.send(IPC_CHANNELS.terminalWrite, terminalWriteSchema.parse(request)),
	terminalResize: (request) => ipcRenderer.send(IPC_CHANNELS.terminalResize, terminalResizeSchema.parse(request)),
	terminalClose: (request) => ipcRenderer.send(IPC_CHANNELS.terminalClose, terminalCloseSchema.parse(request)),
	subscribeTerminal: (listener) => {
		const receive = (_event: Electron.IpcRendererEvent, input: unknown) => {
			const parsed = terminalEventSchema.safeParse(input);
			if (parsed.success) listener(parsed.data);
		};
		ipcRenderer.on(IPC_CHANNELS.terminalEvent, receive);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalEvent, receive);
	},
	listWorktrees: async (cwd) => ipcRenderer.invoke(IPC_CHANNELS.worktreeList, gitStatusRequestSchema.parse({ cwd })),
	createWorktree: async (request) =>
		ipcRenderer.invoke(IPC_CHANNELS.worktreeCreate, worktreeCreateSchema.parse(request)),
	removeWorktree: async (request) =>
		ipcRenderer.invoke(IPC_CHANNELS.worktreeRemove, worktreeRemoveSchema.parse(request)),
	listDirectory: async (request) =>
		ipcRenderer.invoke(IPC_CHANNELS.directoryList, projectDirectorySchema.parse(request)),
	readProjectFile: async (request) =>
		ipcRenderer.invoke(IPC_CHANNELS.projectFileRead, projectReadSchema.parse(request)),
	previewProjectFile: async (request) =>
		ipcRenderer.invoke(IPC_CHANNELS.projectFilePreview, projectReadSchema.parse(request)),
	listParallelJobs: async () => ipcRenderer.invoke(IPC_CHANNELS.parallelList),
	startParallelJob: async (request) =>
		ipcRenderer.invoke(IPC_CHANNELS.parallelStart, parallelStartSchema.parse(request)),
	cancelParallelJob: async (request) =>
		ipcRenderer.invoke(IPC_CHANNELS.parallelCancel, parallelCancelSchema.parse(request)),
	openParallelJob: async (request) => ipcRenderer.invoke(IPC_CHANNELS.parallelOpen, parallelOpenSchema.parse(request)),
	listSchedules: async () => ipcRenderer.invoke(IPC_CHANNELS.scheduleList),
	createSchedule: async (request) =>
		ipcRenderer.invoke(IPC_CHANNELS.scheduleCreate, scheduleCreateSchema.parse(request)),
	pauseSchedule: async (request) => ipcRenderer.invoke(IPC_CHANNELS.schedulePause, schedulePauseSchema.parse(request)),
	runScheduleNow: async (id) => ipcRenderer.invoke(IPC_CHANNELS.scheduleRun, scheduleIdSchema.parse({ id })),
	deleteSchedule: async (id) => ipcRenderer.invoke(IPC_CHANNELS.scheduleDelete, scheduleIdSchema.parse({ id })),
};
contextBridge.exposeInMainWorld("piDesktop", bridge);
// 1.3 首次界面就绪只通知主进程，不携带业务负载。
contextBridge.exposeInMainWorld("harnessWorkbenchReady", () => ipcRenderer.send(STARTUP_CHANNELS.workbenchReady));
logger.info("桌面业务桥安装完成");
