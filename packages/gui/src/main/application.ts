import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	Menu,
	Notification,
	nativeImage,
	nativeTheme,
	shell,
} from "electron";
import {
	browserActionSchema,
	browserIdSchema,
	browserLayoutSchema,
	browserNavigateFileSchema,
	browserNavigateSchema,
} from "../shared/browser.ts";
import { editActionSchema } from "../shared/edit.ts";
import { gitDiffRequestSchema, gitMutationRequestSchema, gitStatusRequestSchema } from "../shared/git.ts";
import { worktreeCreateSchema, worktreeRemoveSchema } from "../shared/git-worktree.ts";
import { goalReadRequestSchema } from "../shared/goals.ts";
import { IMAGE_INPUT_EXTENSIONS } from "../shared/images.ts";
import { createLogger } from "../shared/logger.ts";
import { mcpServerInputSchema, mcpServerNameSchema } from "../shared/mcp.ts";
import { parallelCancelSchema, parallelOpenSchema, parallelStartSchema } from "../shared/parallel.ts";
import { pluginInstallRequestSchema, pluginListRequestSchema, pluginRemoveRequestSchema } from "../shared/plugins.ts";
import { PRODUCT_NAME } from "../shared/product.ts";
import { projectDirectorySchema, projectReadSchema } from "../shared/project-browser.ts";
import { clipboardTextSchema, commandEnvelopeSchema, IPC_CHANNELS } from "../shared/protocol.ts";
import { scheduleCreateSchema, scheduleIdSchema, schedulePauseSchema } from "../shared/schedule.ts";
import { INITIAL_WINDOW_SIZE } from "../shared/startup.ts";
import { subagentOutputRequestSchema } from "../shared/subagents.ts";
import {
	terminalCloseSchema,
	terminalCreateSchema,
	terminalResizeSchema,
	terminalWriteSchema,
} from "../shared/terminal.ts";
import {
	draftWriteSchema,
	forkSelectionSchema,
	imageImportSchema,
	imageReadSchema,
	projectFileReferenceSchema,
	projectFileSearchSchema,
	projectFileSelectionSchema,
	sessionAtSchema,
	sessionChangeSchema,
	sessionIdentitySchema,
	sessionIdSchema,
	workspacePathSchema,
	workspaceRenameSchema,
} from "../shared/workspace.ts";
import { BrowserService } from "./browser-service.ts";
import { resolveAgentDirectory, seedDefaultProvider } from "./default-provider.ts";
import { previewProjectFile } from "./file-preview.ts";
import { GitService } from "./git-service.ts";
import { McpService } from "./mcp-service.ts";
import { ParallelScheduler } from "./parallel-scheduler.ts";
import { ProjectBrowser } from "./project-browser.ts";
import { PtyService } from "./pty-service.ts";
import { ScheduleService } from "./schedule-service.ts";
import { StartupWindow } from "./startup-window.ts";
import { UpdateService } from "./update-service.ts";
import { UtilityHostClient } from "./utility-host-client.ts";
import { WorkspaceService } from "./workspace-service.ts";
import { WorkspaceStore } from "./workspace-store.ts";
import { WorktreeService } from "./worktree-service.ts";

const logger = createLogger("desktop");

/*
 * ========================================================================
 * 步骤1：组合窗口、受限传输和桌面工作区服务
 * ========================================================================
 * 数据源：用户目录选择、主窗口 IPC 与工作区索引。
 * 操作：
 *   1) 校验主窗口与 main frame，参数从 unknown 解析
 *   2) 会话与草稿交给可单测服务，入口只管理桌面资源
 */
export async function startApplication(): Promise<void> {
	logger.info("开始初始化桌面工作区");
	const userDataDirectory = app.commandLine.getSwitchValue("user-data-dir");
	if (userDataDirectory) app.setPath("userData", userDataDirectory);
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}
	await app.whenReady();
	Menu.setApplicationMenu(null);
	const directory = dirname(fileURLToPath(import.meta.url));
	/*
	 * ========================================================================
	 * 步骤4：先展示启动页，并提前建立退出清理
	 * ========================================================================
	 * 数据源：本地启动页与随后创建的桌面服务。
	 * 操作：1) 初始化期间也可关闭；2) 迟到的恢复结果不再显示窗口。
	 */
	logger.info("开始准备启动窗口生命周期");
	const startup = new StartupWindow(directory, logger, () => app.quit());
	const cleanup: Array<() => void | Promise<void>> = [() => startup.dispose()];
	let mainWindow: BrowserWindow | undefined;
	let quitting = false;
	let shutdownPromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		quitting = true;
		// 4.1 每个服务独立清理，单项失败不能跳过其余宿主。
		shutdownPromise = Promise.allSettled(cleanup.map((close) => Promise.resolve().then(close))).then((results) => {
			if (results.some((result) => result.status === "rejected")) logger.info("退出时部分数据保存失败，请核对恢复记录");
		});
		return shutdownPromise;
	};
	app.on("before-quit", (event) => {
		if (quitting) return;
		event.preventDefault();
		void shutdown().finally(() => app.quit());
	});
	app.on("window-all-closed", () => {
		if (!quitting) app.quit();
	});
	app.on("second-instance", () => {
		if (quitting) return;
		if (startup.focus() || !mainWindow || mainWindow.isDestroyed()) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
	});
	await startup.open();
	logger.info("启动窗口生命周期准备结束");
	if (quitting) return;
	// 1.0 开发和安装包均读取同版官方 SDK 资源，不使用仓库旧内核目录。
	const sdkDirectory =
		process.env.PI_PACKAGE_DIR ??
		(app.isPackaged
			? join(process.resourcesPath, "sdk")
			: join(directory, "../../node_modules/@earendil-works/pi-coding-agent"));
	const defaultsFile =
		process.env.ANIAO_DEFAULT_PROVIDER_FILE ??
		(app.isPackaged ? join(process.resourcesPath, "defaults", "provider.json") : "");
	try {
		await seedDefaultProvider(resolveAgentDirectory(), defaultsFile, logger);
	} catch (error) {
		logger.info(`默认 Provider 写入失败：${error instanceof Error ? error.message : "未知错误"}`);
	}
	if (quitting) return;
	const store = new WorkspaceStore(join(app.getPath("userData"), "workspace"), logger);
	const workspace = new WorkspaceService(
		store,
		(cwd, target) =>
			new UtilityHostClient(
				join(directory, "host.mjs"),
				cwd,
				target,
				logger,
				sdkDirectory,
				join(app.getPath("userData"), "workspace"),
			),
		logger,
	);
	cleanup.push(() => workspace.close());
	const git = new GitService();
	const pty = new PtyService();
	cleanup.push(() => pty.disposeAll());
	const worktrees = new WorktreeService();
	const projectBrowser = new ProjectBrowser();
	const mcp = new McpService(logger);
	const parallel = new ParallelScheduler(
		join(app.getPath("userData"), "parallel", "jobs.json"),
		(cwd) =>
			new UtilityHostClient(
				join(directory, "host.mjs"),
				cwd,
				{ type: "new" },
				logger,
				sdkDirectory,
				join(app.getPath("userData"), "workspace"),
			),
		async (job) => {
			/*
			 * ========================================================================
			 * 步骤3：为后台任务创建独立工作树
			 * ========================================================================
			 * 数据源：来源项目当前 HEAD 与已持久化任务 ID。
			 * 操作：1) 生成唯一分支；2) 返回实际目录，失败不使用共享目录。
			 */
			logger.info("开始准备后台任务工作树");
			try {
				// 3.1 工作树和分支保留，结果由用户核对后手动清理。
				const tree = await worktrees.create({ cwd: job.cwd, branch: `codex/task-${job.id}`, baseRef: "HEAD" });
				return { cwd: tree.path, branch: tree.branch };
			} finally {
				logger.info("后台任务工作树准备结束");
			}
		},
	);
	cleanup.push(() => parallel.close());
	await parallel.initialize();
	if (quitting) return;
	const schedule = new ScheduleService(
		join(app.getPath("userData"), "schedule", "tasks.json"),
		parallel,
		(title, body) => {
			if (Notification.isSupported()) new Notification({ title, body }).show();
		},
	);
	cleanup.push(() => schedule.close());
	await schedule.initialize();
	if (quitting) return;
	const window = new BrowserWindow({
		...INITIAL_WINDOW_SIZE,
		minWidth: 1100,
		minHeight: 720,
		title: PRODUCT_NAME,
		show: false,
		frame: false,
		autoHideMenuBar: true,
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b1c" : "#ffffff",
		webPreferences: {
			preload: join(directory, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			backgroundThrottling: false,
		},
	});
	mainWindow = window;
	startup.connect(window);
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event) => {
		event.preventDefault();
	});
	window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	const browser = new BrowserService(window, logger, (state) => {
		if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.browserEvent, state);
	});
	cleanup.push(() => browser.dispose());
	workspace.subscribe((notification) => {
		if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.notification, notification);
	});
	const updateService = new UpdateService(logger, shutdown, (state) => {
		if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.updateEvent, state);
	});
	const verifySender = (event: Electron.IpcMainInvokeEvent) => {
		if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
			throw new Error("不允许的桌面调用来源");
	};
	const verifyWindowSender = (event: Electron.IpcMainEvent) =>
		event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
	ipcMain.on(IPC_CHANNELS.windowMinimize, (event) => {
		if (verifyWindowSender(event)) window.minimize();
	});
	ipcMain.on(IPC_CHANNELS.windowToggleMaximize, (event) => {
		if (!verifyWindowSender(event)) return;
		if (window.isMaximized()) window.unmaximize();
		else window.maximize();
	});
	ipcMain.on(IPC_CHANNELS.windowClose, (event) => {
		if (verifyWindowSender(event)) window.close();
	});
	// 6.1 仅工作台主框架能创建、导航和放置网页，外部网页无法伪造调用。
	ipcMain.handle(IPC_CHANNELS.browserCreate, (event, input: unknown) => {
		verifySender(event);
		return browser.create(browserIdSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.browserNavigate, (event, input: unknown) => {
		verifySender(event);
		browser.navigate(browserNavigateSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.browserNavigateFile, async (event, input: unknown) => {
		verifySender(event);
		const request = browserNavigateFileSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("只能打开当前工作区的文件");
		const file = await projectBrowser.resolveFile({ cwd: request.cwd, path: request.path });
		browser.navigateFile({ id: request.id, url: pathToFileURL(file.target).href });
	});
	ipcMain.handle(IPC_CHANNELS.browserAction, (event, input: unknown) => {
		verifySender(event);
		browser.action(browserActionSchema.parse(input));
	});
	ipcMain.on(IPC_CHANNELS.browserLayout, (event, input: unknown) => {
		if (!verifyWindowSender(event)) return;
		const layout = browserLayoutSchema.safeParse(input);
		if (layout.success) browser.setLayout(layout.data);
	});
	ipcMain.on(IPC_CHANNELS.browserClose, (event, input: unknown) => {
		if (!verifyWindowSender(event)) return;
		const id = browserIdSchema.safeParse(input);
		if (id.success) browser.close(id.data);
	});
	/*
	 * ========================================================================
	 * 步骤5：将用户编辑操作交给当前窗口
	 * ========================================================================
	 * 数据源：主窗口固定动作与 Chromium 当前焦点、选择和撤销记录。
	 * 操作：1) 核对来源与白名单；2) 原生处理剪贴板，不向界面返回内容。
	 */
	ipcMain.handle(IPC_CHANNELS.edit, (event, input: unknown) => {
		verifySender(event);
		const action = editActionSchema.parse(input);
		logger.info("开始处理原生编辑操作");
		try {
			// 5.1 schema 限定可调用的方法，保留输入事件和原生撤销历史。
			window.webContents[action]();
		} finally {
			logger.info("原生编辑操作处理结束");
		}
	});
	ipcMain.handle(IPC_CHANNELS.gitStatus, async (event, input: unknown) => {
		verifySender(event);
		const request = gitStatusRequestSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("工程面板只能查看当前工作区");
		return git.status(request.cwd);
	});
	ipcMain.handle(IPC_CHANNELS.gitDiff, async (event, input: unknown) => {
		verifySender(event);
		const request = gitDiffRequestSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("工程面板只能查看当前工作区");
		return git.diff(request);
	});
	ipcMain.handle(IPC_CHANNELS.gitMutate, async (event, input: unknown) => {
		verifySender(event);
		const request = gitMutationRequestSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("工程面板只能查看当前工作区");
		return git.mutate(request);
	});
	ipcMain.handle(IPC_CHANNELS.terminalCreate, async (event, input: unknown) => {
		verifySender(event);
		const request = terminalCreateSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("终端只能打开当前工作区");
		return pty.create(request, (terminalEvent) => {
			if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.terminalEvent, terminalEvent);
		});
	});
	ipcMain.on(IPC_CHANNELS.terminalWrite, (event, input: unknown) => {
		if (!verifyWindowSender(event)) return;
		const request = terminalWriteSchema.safeParse(input);
		if (request.success) pty.write(request.data);
	});
	ipcMain.on(IPC_CHANNELS.terminalResize, (event, input: unknown) => {
		if (!verifyWindowSender(event)) return;
		const request = terminalResizeSchema.safeParse(input);
		if (request.success) pty.resize(request.data);
	});
	ipcMain.on(IPC_CHANNELS.terminalClose, (event, input: unknown) => {
		if (!verifyWindowSender(event)) return;
		const request = terminalCloseSchema.safeParse(input);
		if (request.success) pty.close(request.data);
	});
	ipcMain.handle(IPC_CHANNELS.worktreeList, async (event, input: unknown) => {
		verifySender(event);
		const request = gitStatusRequestSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("工作树只能查看当前工作区");
		return worktrees.list(request.cwd);
	});
	ipcMain.handle(IPC_CHANNELS.worktreeCreate, async (event, input: unknown) => {
		verifySender(event);
		const request = worktreeCreateSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("工作树只能创建在当前工作区");
		return worktrees.create(request);
	});
	ipcMain.handle(IPC_CHANNELS.worktreeRemove, async (event, input: unknown) => {
		verifySender(event);
		const request = worktreeRemoveSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("工作树只能移除当前工作区");
		return worktrees.remove(request);
	});
	ipcMain.handle(IPC_CHANNELS.directoryList, async (event, input: unknown) => {
		verifySender(event);
		const request = projectDirectorySchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("文件面板只能查看当前工作区");
		return projectBrowser.list(request);
	});
	ipcMain.handle(IPC_CHANNELS.projectFileRead, async (event, input: unknown) => {
		verifySender(event);
		const request = projectReadSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("文件面板只能查看当前工作区");
		return projectBrowser.read(request);
	});
	ipcMain.handle(IPC_CHANNELS.projectFilePreview, async (event, input: unknown) => {
		verifySender(event);
		const request = projectReadSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("文件预览只能查看当前工作区");
		const file = await projectBrowser.resolveFile(request);
		return previewProjectFile(file.target, file.path);
	});
	ipcMain.handle(IPC_CHANNELS.parallelList, (event) => {
		verifySender(event);
		return parallel.list();
	});
	ipcMain.handle(IPC_CHANNELS.parallelStart, async (event, input: unknown) => {
		verifySender(event);
		const request = parallelStartSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("并行任务只能使用当前工作区");
		return parallel.start(request);
	});
	ipcMain.handle(IPC_CHANNELS.parallelCancel, async (event, input: unknown) => {
		verifySender(event);
		return parallel.cancel(parallelCancelSchema.parse(input).id);
	});
	ipcMain.handle(IPC_CHANNELS.parallelOpen, async (event, input: unknown) => {
		verifySender(event);
		const job = parallel.get(parallelOpenSchema.parse(input).id);
		if (!job?.sessionId) throw new Error("该任务还没有可打开的会话");
		if (job.status === "running" || job.status === "queued") throw new Error("请等待后台任务结束后再打开会话");
		await workspace.openParallelSession(job.executionCwd ?? job.cwd, job.sessionId);
	});
	ipcMain.handle(IPC_CHANNELS.scheduleList, (event) => {
		verifySender(event);
		return schedule.list();
	});
	ipcMain.handle(IPC_CHANNELS.scheduleCreate, async (event, input: unknown) => {
		verifySender(event);
		const request = scheduleCreateSchema.parse(input);
		const current = await workspace.getSnapshot();
		if (!current || current.cwd !== request.cwd) throw new Error("定时任务只能使用当前工作区");
		return schedule.create(request);
	});
	ipcMain.handle(IPC_CHANNELS.schedulePause, async (event, input: unknown) => {
		verifySender(event);
		const request = schedulePauseSchema.parse(input);
		return schedule.pause(request.id, request.paused);
	});
	ipcMain.handle(IPC_CHANNELS.scheduleRun, async (event, input: unknown) => {
		verifySender(event);
		return schedule.runNow(scheduleIdSchema.parse(input).id);
	});
	ipcMain.handle(IPC_CHANNELS.scheduleDelete, async (event, input: unknown) => {
		verifySender(event);
		return schedule.remove(scheduleIdSchema.parse(input).id);
	});
	// 1.1 参数与 sender 校验始终留在 IPC 边界。
	ipcMain.handle(IPC_CHANNELS.snapshot, (event) => {
		verifySender(event);
		return workspace.getSnapshot();
	});
	ipcMain.handle(IPC_CHANNELS.sessionSnapshot, (event, input: unknown) => {
		verifySender(event);
		return workspace.getSessionSnapshot(sessionIdentitySchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.sessionRuntimes, (event) => {
		verifySender(event);
		return workspace.getSessionRuntimes();
	});
	ipcMain.handle(IPC_CHANNELS.command, (event, input: unknown) => {
		verifySender(event);
		return workspace.dispatch(commandEnvelopeSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.library, (event) => {
		verifySender(event);
		return workspace.getLibrary();
	});
	ipcMain.handle(IPC_CHANNELS.projects, (event) => {
		verifySender(event);
		return workspace.getProjects();
	});
	ipcMain.handle(IPC_CHANNELS.openWorkspace, (event, input: unknown) => {
		verifySender(event);
		return workspace.openWorkspace(workspacePathSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.renameWorkspace, (event, input: unknown) => {
		verifySender(event);
		const rename = workspaceRenameSchema.parse(input);
		return workspace.renameWorkspace(rename.cwd, rename.name);
	});
	ipcMain.handle(IPC_CHANNELS.removeWorkspace, (event, input: unknown) => {
		verifySender(event);
		return workspace.removeWorkspace(workspacePathSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.newSessionAt, (event, input: unknown) => {
		verifySender(event);
		return workspace.newSessionAt(workspacePathSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.openSessionAt, (event, input: unknown) => {
		verifySender(event);
		const selection = sessionAtSchema.parse(input);
		return workspace.openSessionAt(selection.cwd, selection.sessionId);
	});
	ipcMain.handle(IPC_CHANNELS.openSession, (event, input: unknown) => {
		verifySender(event);
		return workspace.openSession(sessionIdSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.forkSession, (event, input: unknown) => {
		verifySender(event);
		return workspace.forkSession(forkSelectionSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.updateSession, (event, input: unknown) => {
		verifySender(event);
		return workspace.updateSession(sessionChangeSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.loadDraft, (event, input: unknown) => {
		verifySender(event);
		return workspace.loadDraft(sessionIdSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.saveDraft, (event, input: unknown) => {
		verifySender(event);
		return workspace.saveDraft(draftWriteSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.newSession, (event) => {
		verifySender(event);
		return workspace.newSession();
	});
	ipcMain.handle(IPC_CHANNELS.writeClipboard, (event, input: unknown) => {
		verifySender(event);
		logger.info("开始复制用户选定文本");
		try {
			// 1.2 只写入点击时提交的文本，不读取系统剪贴板，不记录内容。
			clipboard.writeText(clipboardTextSchema.parse(input));
		} finally {
			logger.info("用户选定文本复制结束");
		}
	});
	ipcMain.handle(IPC_CHANNELS.selectProjectFiles, (event, input: unknown) => {
		verifySender(event);
		return workspace.selectProjectFiles(projectFileSelectionSchema.parse(input), async (cwd) => {
			// 1.3 目录只作起点；用户跨目录选择仍须通过真实路径归属检查。
			const selected = await dialog.showOpenDialog(window, {
				title: "引用项目文件",
				buttonLabel: "引用文件",
				defaultPath: cwd,
				properties: ["openFile", "multiSelections", "dontAddToRecent"],
			});
			return selected.canceled ? [] : selected.filePaths;
		});
	});
	ipcMain.handle(IPC_CHANNELS.selectImages, (event, input: unknown) => {
		verifySender(event);
		return workspace.selectImages(
			projectFileSelectionSchema.parse(input),
			async () => {
				const selected = await dialog.showOpenDialog(window, {
					title: "添加图片",
					buttonLabel: "添加图片",
					filters: [{ name: "PNG / JPEG 图片", extensions: IMAGE_INPUT_EXTENSIONS }],
					properties: ["openFile", "multiSelections", "dontAddToRecent"],
				});
				return selected.canceled ? [] : selected.filePaths;
			},
			normalizePng,
		);
	});
	ipcMain.handle(IPC_CHANNELS.searchProjectFiles, (event, input: unknown) => {
		verifySender(event);
		return workspace.searchProjectFiles(projectFileSearchSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.validateProjectFiles, (event, input: unknown) => {
		verifySender(event);
		return workspace.validateProjectFiles(projectFileReferenceSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.importImages, (event, input: unknown) => {
		verifySender(event);
		return workspace.importImages(imageImportSchema.parse(input), normalizePng);
	});
	ipcMain.handle(IPC_CHANNELS.readImage, (event, input: unknown) => {
		verifySender(event);
		return workspace.readImage(imageReadSchema.parse(input));
	});
	ipcMain.handle(IPC_CHANNELS.openProject, async (event) => {
		verifySender(event);
		const selected = await dialog.showOpenDialog(window, { title: "打开并信任项目", properties: ["openDirectory"] });
		if (selected.canceled || !selected.filePaths[0]) return false;
		await workspace.attach(selected.filePaths[0]);
		return true;
	});
	ipcMain.handle(IPC_CHANNELS.openExternal, async (event, input: unknown) => {
		verifySender(event);
		if (typeof input !== "string" || input.length > 8192) throw new Error("链接无效");
		const url = new URL(input);
		if (!["https:", "http:", "mailto:"].includes(url.protocol)) throw new Error("不支持的链接协议");
		await shell.openExternal(url.href);
	});
	ipcMain.handle(IPC_CHANNELS.openConfig, async (event) => {
		verifySender(event);
		const directory = resolveAgentDirectory();
		const file = join(directory, "models.json");
		await mkdir(directory, { recursive: true });
		if (!existsSync(file)) await writeFile(file, "{}\n", { encoding: "utf8", mode: 0o600 });
		const error = await shell.openPath(file);
		if (error) throw new Error("无法打开配置文件");
	});
	ipcMain.handle(IPC_CHANNELS.openSkills, async (event) => {
		verifySender(event);
		const directory = join(resolveAgentDirectory(), "skills");
		await mkdir(directory, { recursive: true });
		const error = await shell.openPath(directory);
		if (error) throw new Error("无法打开技能目录");
	});
	ipcMain.handle(IPC_CHANNELS.pluginsList, async (event, input: unknown) => {
		verifySender(event);
		pluginListRequestSchema.parse(input);
		return workspace.listPlugins();
	});
	ipcMain.handle(IPC_CHANNELS.pluginsInstall, async (event, input: unknown) => {
		verifySender(event);
		const request = pluginInstallRequestSchema.parse(input);
		return workspace.installPlugin(request.source);
	});
	ipcMain.handle(IPC_CHANNELS.pluginsRemove, async (event, input: unknown) => {
		verifySender(event);
		const request = pluginRemoveRequestSchema.parse(input);
		return workspace.removePlugin(request.source, request.scope);
	});
	ipcMain.handle(IPC_CHANNELS.subagentOutput, async (event, input: unknown) => {
		verifySender(event);
		const request = subagentOutputRequestSchema.parse(input);
		return workspace.readSubagentOutput(request.runId, request.childId);
	});
	ipcMain.handle(IPC_CHANNELS.subagentInspection, async (event, input: unknown) => {
		verifySender(event);
		const request = subagentOutputRequestSchema.parse(input);
		logger.info("开始转发子智能体详情查询");
		try {
			// 1.8 查询只交给当前宿主，不接受 Renderer 指定会话目录。
			return await workspace.inspectSubagent(request.runId, request.childId);
		} finally {
			logger.info("子智能体详情查询转发结束");
		}
	});
	ipcMain.handle(IPC_CHANNELS.subagentTranscript, async (event, input: unknown) => {
		verifySender(event);
		const request = subagentOutputRequestSchema.parse(input);
		return workspace.readSubagentTranscript(request.runId, request.childId);
	});
	ipcMain.handle(IPC_CHANNELS.goalsRead, async (event, input: unknown) => {
		verifySender(event);
		const request = goalReadRequestSchema.parse(input);
		return workspace.readGoals(request);
	});
	ipcMain.handle(IPC_CHANNELS.mcpList, async (event) => {
		verifySender(event);
		return mcp.list();
	});
	ipcMain.handle(IPC_CHANNELS.mcpSave, async (event, input: unknown) => {
		verifySender(event);
		const request = mcpServerInputSchema.parse(input);
		return workspace.changeResources((reload) => mcp.save(request, reload));
	});
	ipcMain.handle(IPC_CHANNELS.mcpRemove, async (event, name: unknown) => {
		verifySender(event);
		const parsedName = mcpServerNameSchema.parse(name);
		return workspace.changeResources((reload) => mcp.remove(parsedName, reload));
	});
	ipcMain.handle(IPC_CHANNELS.mcpToggle, async (event, name: unknown, enabled: unknown) => {
		verifySender(event);
		const parsedName = mcpServerNameSchema.parse(name);
		if (typeof enabled !== "boolean") throw new Error("MCP 启停状态无效");
		return workspace.changeResources((reload) => mcp.setEnabled(parsedName, enabled, reload));
	});
	ipcMain.handle(IPC_CHANNELS.updateState, async (event) => {
		verifySender(event);
		return updateService.current;
	});
	ipcMain.handle(IPC_CHANNELS.updateCheck, async (event) => {
		verifySender(event);
		return updateService.check();
	});
	// 1.3 下载只接受主窗口的显式请求，不与版本检查合并。
	ipcMain.handle(IPC_CHANNELS.updateDownload, async (event) => {
		verifySender(event);
		return updateService.download();
	});
	ipcMain.handle(IPC_CHANNELS.updateInstall, async (event) => {
		verifySender(event);
		await updateService.install();
	});
	// 1.2 恢复失败保留索引和草稿，界面提示用户后仍允许选择其他项目。
	let startupError = "";
	startup.setStage("restoring");
	try {
		await workspace.restore();
	} catch (error) {
		startupError = error instanceof Error ? error.message : "最近工作区恢复失败";
		logger.info("最近工作区恢复失败，等待重新选择项目");
	}
	if (quitting) return;
	try {
		// 4.2 前台保留启动页，真实初始快照与首屏绘制完成后再显示工作台。
		if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
		else await window.loadFile(join(directory, "../renderer/index.html"));
		await startup.reveal();
	} catch (error) {
		if (quitting) return;
		throw error;
	}
	if (quitting) return;
	if (startupError)
		void dialog.showMessageBox(window, { type: "warning", title: "工作区恢复失败", message: startupError });
	schedule.start();
	updateService.start();
	logger.info("桌面工作区初始化完成");
}

/*
 * ========================================================================
 * 步骤2：统一解码图片输入并生成规范 PNG
 * ========================================================================
 * 数据源：内容库已检查字节、签名与像素上限的 PNG / JPEG。
 * 操作：
 *   1) 原生选择、粘贴和拖放共用完整解码，不信任 MIME 或文件名
 *   2) 仅返回重编码字节，不记录图片内容
 */
function normalizePng(bytes: Buffer): Buffer {
	logger.info("开始规范化 PNG 图片");
	try {
		// 2.1 解码失败整批拒绝，编码结果仍由内容库复查上限。
		const decoded = nativeImage.createFromBuffer(bytes);
		if (decoded.isEmpty()) throw new Error("图片无法解码，请重新选择 PNG 或 JPEG 文件");
		return decoded.toPNG();
	} finally {
		logger.info("PNG 图片规范化结束");
	}
}
