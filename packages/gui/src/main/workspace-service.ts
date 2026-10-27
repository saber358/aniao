import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ImageImport, ImageRead } from "../shared/images.ts";
import type { Logger } from "../shared/logger.ts";
import type { PluginPackage, PluginScope } from "../shared/plugins.ts";
import type {
	ProjectFileMatches,
	ProjectFileReference,
	ProjectFileSearch,
	ProjectFileSelection,
} from "../shared/project-files.ts";
import type { AgentPort, CommandEnvelope, PortNotification, SessionSnapshot } from "../shared/protocol.ts";
import type {
	Draft,
	DraftWrite,
	ForkSelection,
	ProjectSummary,
	SessionChange,
	SessionItem,
	SessionLibrary,
	SessionSummary,
	SessionTarget,
} from "../shared/workspace.ts";
import { projectFileReferenceSchema, projectFileSearchSchema } from "../shared/workspace.ts";
import { searchProjectFiles } from "./file-search.ts";
import { resolveProjectFiles } from "./project-files.ts";
import type { WorkspaceStore } from "./workspace-store.ts";
import { WorktreeService } from "./worktree-service.ts";

export interface ManagedHost extends AgentPort {
	readonly isClosed: boolean;
	getSnapshot(): Promise<SessionSnapshot>;
	listSessions(): Promise<SessionSummary[]>;
	getForkDraft(): Promise<string | undefined>;
	getImage(imageId: string): Promise<string>;
	prepareTransition(target: SessionTarget): Promise<void>;
	renameSession(sessionId: string, title: string): Promise<void>;
	listPlugins?(): Promise<PluginPackage[]>;
	installPlugin?(source: string): Promise<PluginPackage[]>;
	removePlugin?(source: string, scope: PluginScope): Promise<PluginPackage[]>;
	readSubagentOutput?(runId: string, childId?: string): Promise<string | null>;
	readSubagentTranscript?(runId: string, childId?: string): Promise<string | null>;
	close(): Promise<void>;
}

/*
 * ========================================================================
 * 步骤1：协调宿主切换、历史组织与草稿边界
 * ========================================================================
 * 数据源：SDK 宿主、桌面索引和用户已选择的项目。
 * 操作：
 *   1) 切换互斥，初始化失败时保留当前宿主
 *   2) 会话 ID 在当前项目中查证，Renderer 不提交文件路径
 */
export class WorkspaceService {
	private readonly store: WorkspaceStore;
	private readonly createHost: (cwd: string, target: SessionTarget) => ManagedHost;
	private readonly logger: Logger;
	private host: ManagedHost | null = null;
	private nextHost?: ManagedHost;
	private closed = false;
	private releaseHost?: () => void;
	private changing = false;
	private pendingCommands = 0;
	private fileSearch?: AbortController;
	private readonly listeners = new Set<(event: PortNotification) => void>();

	constructor(store: WorkspaceStore, createHost: (cwd: string, target: SessionTarget) => ManagedHost, logger: Logger) {
		this.store = store;
		this.createHost = createHost;
		this.logger = logger;
	}

	subscribe(listener: (event: PortNotification) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async restore(): Promise<void> {
		this.logger.info("开始恢复最近工作区");
		try {
			const active = await this.store.active();
			if (!active) return;
			const saved = (await this.store.sessions(active.cwd)).find((item) => item.id === active.id);
			await this.attach(
				active.cwd,
				saved
					? { type: "session", id: saved.id, allowCreate: !saved.persisted, title: saved.title }
					: { type: "recent" },
			);
		} finally {
			this.logger.info("最近工作区恢复结束");
		}
	}

	async attach(cwd: string, target: SessionTarget = { type: "recent" }, expectedHost = this.host): Promise<void> {
		if (this.closed) throw new Error("桌面工作区已关闭");
		if (this.changing || this.pendingCommands > 0) throw new Error("请等待当前操作结束");
		if (this.host !== expectedHost) throw new Error("工作区已切换，请重新选择会话");
		this.fileSearch?.abort();
		this.changing = true;
		this.logger.info("开始切换工作区会话");
		try {
			// 1.1 SDK 未收束前不替换活动宿主。
			if (this.host && !this.host.isClosed && (await this.host.getSnapshot()).run.phase !== "idle")
				throw new Error("请先停止当前任务");
			if (this.host && !this.host.isClosed) await this.getLibrary();
			if (this.host && !this.host.isClosed) await this.host.prepareTransition(target);
			if (this.closed) throw new Error("桌面工作区已关闭");
			const normalized = await realpath(cwd);
			if (!(await stat(normalized)).isDirectory()) throw new Error("项目目录已失效");
			if (this.closed) throw new Error("桌面工作区已关闭");
			const next = this.createHost(normalized, target);
			this.nextHost = next;
			try {
				const current = await next.getSnapshot();
				const entries = await next.listSessions();
				const summary = entries.find((item) => item.id === current.sessionId);
				if (this.closed || next.isClosed) throw new Error("桌面工作区已关闭");
				if (!summary) throw new Error("活动会话未进入宿主索引");
				if (target.type === "fork") {
					const text = await next.getForkDraft();
					if (!text || !summary.persisted || summary.id === target.sourceId || summary.parentId !== target.sourceId)
						throw new Error("分支结果无效，已保留原会话");
					// 1.3 新草稿先保存，索引最后切换；失败不关闭原宿主。
					await this.store.saveDraft(normalized, { sessionId: summary.id, revision: 0, text });
				}
				await this.store.rememberProject(normalized);
				await this.store.rememberSessions(normalized, entries);
				await this.store.remember(normalized, { ...summary, pinned: false, archived: false }, true);
			} catch (error) {
				await next.close();
				throw error;
			}
			this.releaseHost?.();
			await this.host?.close();
			if (this.closed) {
				await next.close();
				throw new Error("桌面工作区已关闭");
			}
			this.host = next;
			this.releaseHost = next.subscribe((event) => {
				for (const listener of this.listeners) listener(event);
			});
		} finally {
			this.nextHost = undefined;
			this.changing = false;
			this.logger.info("工作区会话切换结束");
		}
	}

	async getSnapshot(): Promise<SessionSnapshot | null> {
		return this.host ? this.host.getSnapshot() : null;
	}

	/*
	 * ========================================================================
	 * 步骤7：锁定活动宿主后修改并重载资源
	 * ========================================================================
	 * 数据源：当前空闲会话与配置服务事务。
	 * 操作：1) 文件写入前拒绝忙碌状态；2) 重载期间允许扩展交互回复。
	 */
	async changeResources<T>(operation: (reload: () => Promise<void>) => Promise<T>): Promise<T> {
		if (this.closed || this.changing || this.pendingCommands > 0) throw new Error("请等待当前操作结束");
		this.changing = true;
		const host = this.host;
		this.logger.info("开始修改工作区资源配置");
		try {
			// 7.1 未连接项目时只保存全局配置，下次创建会话会读取新配置。
			const snapshot = host ? await host.getSnapshot() : null;
			if (host?.isClosed) throw new Error("会话已断开，请重新打开项目");
			if (snapshot && (snapshot.run.phase !== "idle" || snapshot.dialogs.length || snapshot.authentication.flow))
				throw new Error("请等待当前任务或交互结束后再修改 MCP");
			if (snapshot?.plan && !["off", "completed"].includes(snapshot.plan.phase))
				throw new Error("请先批准或取消当前计划，再修改 MCP");
			if (this.closed) throw new Error("桌面工作区已关闭");
			return await operation(async () => {
				// 7.2 复用长命令通道；主进程互斥在配置落盘前已经建立。
				if (!host || !snapshot) return;
				if (this.closed || host.isClosed || this.host !== host) throw new Error("会话已更换，请重新打开项目");
				await host.dispatch({
					requestId: randomUUID(),
					sessionId: snapshot.sessionId,
					generation: snapshot.generation,
					command: { type: "reloadResources" },
				});
			});
		} finally {
			this.changing = false;
			this.logger.info("工作区资源配置修改结束");
		}
	}

	async listPlugins(): Promise<PluginPackage[]> {
		if (!this.host?.listPlugins || this.host.isClosed) throw new Error("请先连接项目");
		return this.host.listPlugins();
	}

	async installPlugin(source: string): Promise<PluginPackage[]> {
		if (!this.host?.installPlugin || this.host.isClosed) throw new Error("请先连接项目");
		return this.host.installPlugin(source);
	}

	async removePlugin(source: string, scope: PluginScope): Promise<PluginPackage[]> {
		if (!this.host?.removePlugin || this.host.isClosed) throw new Error("请先连接项目");
		return this.host.removePlugin(source, scope);
	}

	async readSubagentOutput(runId: string, childId?: string): Promise<string | null> {
		if (!this.host?.readSubagentOutput || this.host.isClosed) throw new Error("请先连接项目");
		return this.host.readSubagentOutput(runId, childId);
	}

	async readSubagentTranscript(runId: string, childId?: string): Promise<string | null> {
		if (!this.host?.readSubagentTranscript || this.host.isClosed) throw new Error("请先连接项目");
		return this.host.readSubagentTranscript(runId, childId);
	}

	async dispatch(envelope: CommandEnvelope): Promise<void> {
		if (
			!this.host ||
			(this.changing && !["reply", "cancelLogin", "abort", "dismissNotice"].includes(envelope.command.type))
		)
			throw new Error("请先连接项目");
		this.pendingCommands++;
		try {
			await this.host.dispatch(envelope);
		} finally {
			this.pendingCommands--;
		}
	}

	async getLibrary(): Promise<SessionLibrary | null> {
		if (!this.host) return null;
		const host = this.host;
		const snapshot = await host.getSnapshot();
		const entries = await host.listSessions();
		const saved = await this.store.sessions(snapshot.cwd);
		// 1.2 已落盘会话以 SDK 为准；尚未发送的空会话由桌面索引保留身份。
		const result = new Map<string, SessionItem>(saved.filter((item) => !item.persisted).map((item) => [item.id, item]));
		for (const entry of entries) {
			const preferences = saved.find((item) => item.id === entry.id);
			result.set(entry.id, {
				...entry,
				pinned: preferences?.pinned ?? false,
				archived: preferences?.archived ?? false,
			});
		}
		const active = result.get(snapshot.sessionId);
		if (active && host === this.host) await this.store.remember(snapshot.cwd, active);
		return {
			cwd: snapshot.cwd,
			sessions: [...result.values()].sort(
				(a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
			),
		};
	}

	async getProjects(): Promise<ProjectSummary[]> {
		const cwds = await this.store.projects();
		const active = await this.store.active();
		const projects: ProjectSummary[] = [];
		for (const cwd of cwds) {
			const sessions = await this.store.sessions(cwd);
			sessions.sort(
				(a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
			);
			const savedName = await this.store.projectName(cwd);
			projects.push({ cwd, name: savedName ?? (basename(cwd) || cwd), sessions: sessions.slice(0, 20) });
		}
		projects.sort((a, b) => {
			const activeOrder = Number(b.cwd === active?.cwd) - Number(a.cwd === active?.cwd);
			if (activeOrder !== 0) return activeOrder;
			return (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0) || a.cwd.localeCompare(b.cwd);
		});
		return projects;
	}

	async openWorkspace(cwd: string): Promise<void> {
		/*
		 * ========================================================================
		 * 步骤6：打开已知项目或当前仓库的工作树
		 * ========================================================================
		 * 数据源：桌面索引与 Git 实际工作树列表。
		 * 操作：1) 新工作树先核对仓库归属；2) 成功关联后才写入索引。
		 */
		this.logger.info("开始打开工作区或工作树");
		try {
			// 6.1 未登记目录只接受当前仓库已经创建的真实工作树。
			const expectedHost = this.host;
			const normalized = await realpath(cwd);
			const known = (await this.store.projects()).includes(normalized);
			if (!known) {
				const current = await this.getSnapshot();
				if (!current) throw new Error("请先连接项目");
				const worktrees = await new WorktreeService().list(current.cwd);
				if (!worktrees.some((tree) => resolve(tree.path) === resolve(normalized)))
					throw new Error("目录不是当前仓库的工作树");
			}
			// 6.2 attach 保持原有切换互斥和失败回退，新工作树建立独立会话。
			await this.attach(normalized, { type: known ? "recent" : "new" }, expectedHost);
		} finally {
			this.logger.info("工作区或工作树打开结束");
		}
	}

	async renameWorkspace(cwd: string, name: string): Promise<void> {
		if (!(await this.store.projects()).includes(cwd)) throw new Error("项目不在工作区列表中");
		await this.store.renameProject(cwd, name);
	}

	async removeWorkspace(cwd: string): Promise<void> {
		if (!(await this.store.projects()).includes(cwd)) throw new Error("项目不在工作区列表中");
		if (this.changing || this.pendingCommands > 0) throw new Error("请等待当前操作结束");
		const snapshot = this.host && !this.host.isClosed ? await this.getSnapshot() : null;
		if (snapshot?.cwd === cwd) {
			if (snapshot.run.phase !== "idle") throw new Error("请先停止当前任务");
			const host = this.host;
			this.host = null;
			this.releaseHost?.();
			this.releaseHost = undefined;
			await host?.close();
		}
		await this.store.removeProject(cwd);
	}

	async newSessionAt(cwd: string): Promise<void> {
		if (!(await this.store.projects()).includes(cwd)) throw new Error("项目不在工作区列表中");
		await this.attach(cwd, { type: "new" });
	}

	async openSessionAt(cwd: string, sessionId: string): Promise<void> {
		const saved = await this.store.findSession(sessionId);
		if (!saved || saved.cwd !== cwd) throw new Error("会话已不在该项目中");
		await this.attach(cwd, {
			type: "session",
			id: saved.id,
			allowCreate: !saved.persisted,
			title: saved.title,
		});
	}

	async openParallelSession(cwd: string, sessionId: string): Promise<void> {
		const expectedHost = this.host;
		if (!(await this.store.projects()).includes(cwd)) await this.store.rememberProject(cwd);
		await this.attach(cwd, { type: "session", id: sessionId, allowCreate: false }, expectedHost);
	}

	async openSession(sessionId: string): Promise<void> {
		const expectedHost = this.host;
		const saved = await this.store.findSession(sessionId);
		const current = await this.getSnapshot();
		if (saved && (!current || current.cwd !== saved.cwd)) {
			await this.attach(
				saved.cwd,
				{
					type: "session",
					id: saved.id,
					allowCreate: !saved.persisted,
					title: saved.title,
				},
				expectedHost,
			);
			return;
		}
		const library = await this.getLibrary();
		const entry = library?.sessions.find((item) => item.id === sessionId);
		if (!library || !entry) throw new Error("会话已不在当前项目中");
		const latest = await this.getSnapshot();
		if (latest?.sessionId === sessionId) return;
		await this.attach(
			library.cwd,
			{
				type: "session",
				id: entry.id,
				allowCreate: !entry.persisted,
				title: entry.title,
			},
			expectedHost,
		);
	}

	async newSession(): Promise<void> {
		const expectedHost = this.host;
		const snapshot = await this.getSnapshot();
		if (!snapshot) throw new Error("请先打开项目");
		await this.attach(snapshot.cwd, { type: "new" }, expectedHost);
	}

	/*
	 * ========================================================================
	 * 步骤2：核对分支选择并准备接替宿主
	 * ========================================================================
	 * 数据源：当前会话、宿主代次和原生消息入口，不接受文件路径。
	 * 操作：
	 *   1) 拒绝旧窗口选择、助手消息和未提供的分支入口
	 *   2) 复用切换互斥与先保存后接替流程，原会话保持独立
	 */
	async forkSession(selection: ForkSelection): Promise<void> {
		this.logger.info("开始处理会话分支选择");
		try {
			// 2.1 等待查询时若有其他会话切换，attach 的宿主身份校验再次拒绝。
			const expectedHost = this.host;
			const snapshot = await this.getSnapshot();
			if (!snapshot || selection.sessionId !== snapshot.sessionId || selection.generation !== snapshot.generation)
				throw new Error("会话已更换，请刷新后重新选择分支");
			if (!snapshot.messages.some((message) => message.role === "user" && message.forkEntryId === selection.entryId))
				throw new Error("这条消息暂不可分支，请刷新会话后重试");
			await this.attach(
				snapshot.cwd,
				{ type: "fork", sourceId: snapshot.sessionId, entryId: selection.entryId },
				expectedHost,
			);
		} finally {
			this.logger.info("会话分支选择处理结束");
		}
	}

	async updateSession(change: SessionChange): Promise<void> {
		if (this.changing || this.pendingCommands > 0) throw new Error("请等待当前操作结束");
		this.changing = true;
		this.logger.info("开始更新会话组织");
		try {
			const library = await this.getLibrary();
			const entry = library?.sessions.find((item) => item.id === change.sessionId);
			if (!library || !entry || !this.host) throw new Error("会话已不在当前项目中");
			if ((await this.host.getSnapshot()).run.phase !== "idle") throw new Error("请等待当前任务结束");
			await this.store.remember(library.cwd, entry);
			if (change.title && (entry.persisted || (await this.host.getSnapshot()).sessionId === entry.id))
				await this.host.renameSession(entry.id, change.title);
			await this.store.update(library.cwd, change);
		} finally {
			this.changing = false;
			this.logger.info("会话组织更新结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤3：把文件选择绑定到当前空闲会话
	 * ========================================================================
	 * 数据源：会话身份、宿主代次和原生文件选择回调。
	 * 操作：
	 *   1) 选择期间阻止命令和会话切换，不接受 Renderer 指定路径
	 *   2) 返回前再次核对宿主与状态，拒绝断连或旧代次结果
	 */
	async selectProjectFiles(
		selection: ProjectFileSelection,
		choose: (cwd: string) => Promise<string[]>,
	): Promise<string[]> {
		return this.withSelection(selection, async (snapshot) =>
			resolveProjectFiles(snapshot.cwd, await choose(snapshot.cwd), this.logger),
		);
	}

	/*
	 * ========================================================================
	 * 步骤5：查询候选并重新验证选中的项目引用
	 * ========================================================================
	 * 数据源：当前宿主持有的 cwd、会话身份及有界相对路径。
	 * 操作：
	 *   1) 新查询取消上一轮扫描，查询前后核对活动宿主与空闲状态
	 *   2) 选择不信任旧候选，复用原生选择的互斥与真实路径检查
	 */
	async searchProjectFiles(input: ProjectFileSearch): Promise<ProjectFileMatches> {
		const selection = projectFileSearchSchema.parse(input);
		if (this.changing || this.pendingCommands > 0) throw new Error("请等待当前操作结束");
		const host = this.host;
		if (!host || host.isClosed) throw new Error("请先连接项目");
		this.fileSearch?.abort();
		const search = new AbortController();
		this.fileSearch = search;
		this.logger.info("开始处理项目文件查询");
		try {
			// 5.1 查询不占用会话切换锁；切换会中止扫描，返回前仍拒绝旧身份。
			const snapshot = await host.getSnapshot();
			search.signal.throwIfAborted();
			if (snapshot.sessionId !== selection.sessionId || snapshot.generation !== selection.generation)
				throw new Error("会话已更换，请重新搜索文件");
			if (snapshot.run.phase !== "idle") throw new Error("请先停止当前任务");
			const result = await searchProjectFiles(snapshot.cwd, selection.query, this.logger, search.signal);
			const current = await host.getSnapshot();
			search.signal.throwIfAborted();
			if (
				this.host !== host ||
				host.isClosed ||
				this.changing ||
				current.sessionId !== selection.sessionId ||
				current.generation !== selection.generation ||
				current.cwd !== snapshot.cwd ||
				current.run.phase !== "idle"
			)
				throw new Error("会话状态已变化，请重新搜索文件");
			return result;
		} finally {
			if (this.fileSearch === search) this.fileSearch = undefined;
			this.logger.info("项目文件查询处理结束");
		}
	}

	async validateProjectFiles(input: ProjectFileReference): Promise<string[]> {
		const selection = projectFileReferenceSchema.parse(input);
		// 5.2 相对路径只能在服务持有的 cwd 中解析，用户选择后再次验证真实归属。
		return this.withSelection(selection, (snapshot) =>
			resolveProjectFiles(
				snapshot.cwd,
				selection.paths.map((path) => join(snapshot.cwd, path)),
				this.logger,
			),
		);
	}

	async selectImages(
		selection: ProjectFileSelection,
		choose: () => Promise<string[]>,
		normalize: (bytes: Buffer) => Buffer,
	): Promise<string[]> {
		return this.withSelection(
			selection,
			async (snapshot) => {
				if (!snapshot.configuration.model?.supportsImages) throw new Error("当前模型不支持图片，请先切换模型");
				return this.store.images.importFiles(snapshot.cwd, snapshot.sessionId, await choose(), normalize);
			},
			true,
		);
	}

	async importImages(input: ImageImport, normalize: (bytes: Buffer) => Buffer): Promise<string[]> {
		return this.withSelection(
			input,
			async (snapshot) => {
				// 3.3 粘贴与拖放只提交图片内容，复用相同互斥、能力检查和存储。
				if (!snapshot.configuration.model?.supportsImages) throw new Error("当前模型不支持图片，请先切换模型");
				return this.store.images.importData(snapshot.cwd, snapshot.sessionId, input.data, normalize);
			},
			true,
		);
	}

	private async withSelection<T>(
		selection: ProjectFileSelection,
		operation: (snapshot: SessionSnapshot) => Promise<T>,
		allowWorking = false,
	): Promise<T> {
		if (this.changing || (this.pendingCommands > 0 && !allowWorking)) throw new Error("请等待当前操作结束");
		const host = this.host;
		if (!host || host.isClosed) throw new Error("请先连接项目");
		this.changing = true;
		this.logger.info("开始选择项目文件引用");
		try {
			// 3.1 互斥在读取快照前建立，不能让发送穿过选择准备阶段。
			const snapshot = await host.getSnapshot();
			if (snapshot.sessionId !== selection.sessionId || snapshot.generation !== selection.generation)
				throw new Error("会话已更换，请重新选择文件");
			if (snapshot.dialogs.length || snapshot.authentication.flow?.phase === "working")
				throw new Error("请先完成当前交互");
			if (snapshot.run.phase !== "idle" && !(allowWorking && snapshot.run.phase === "working"))
				throw new Error("请先停止当前任务");
			const result = await operation(snapshot);
			// 3.2 对话框或文件系统等待期间，宿主可能退出；迟到结果不写入新草稿。
			const current = await host.getSnapshot();
			if (
				this.host !== host ||
				host.isClosed ||
				current.sessionId !== selection.sessionId ||
				current.generation !== selection.generation ||
				current.cwd !== snapshot.cwd ||
				(current.run.phase !== "idle" && !(allowWorking && current.run.phase === "working"))
			)
				throw new Error("会话状态已变化，请重新选择文件");
			return result;
		} finally {
			this.changing = false;
			this.logger.info("项目文件引用选择结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤4：只读取当前会话的已知图片
	 * ========================================================================
	 * 数据源：草稿内容库或当前 SDK 历史，不接受文件路径。
	 * 操作：
	 *   1) 请求前后核对活动宿主身份
	 *   2) 草稿与历史通过不同来源读取，跨会话结果不回传
	 */
	async readImage(input: ImageRead): Promise<string> {
		this.logger.info("开始读取图片预览");
		try {
			// 4.1 预览可以发生在流式期间，但不能跨宿主或代次。
			const host = this.host;
			if (!host || host.isClosed) throw new Error("请先连接项目");
			const snapshot = await host.getSnapshot();
			if (snapshot.sessionId !== input.sessionId || snapshot.generation !== input.generation)
				throw new Error("图片不属于当前会话");
			const url =
				input.source === "draft"
					? `data:image/png;base64,${await this.store.images.read(snapshot.cwd, snapshot.sessionId, input.imageId)}`
					: await host.getImage(input.imageId);
			if (host !== this.host || host.isClosed) throw new Error("会话已更换，请刷新图片");
			return url;
		} finally {
			this.logger.info("图片预览读取结束");
		}
	}

	async loadDraft(sessionId: string): Promise<Draft> {
		const active = await this.store.active();
		if (!active || active.id !== sessionId) throw new Error("草稿不属于当前会话");
		return this.store.loadDraft(active.cwd, sessionId);
	}

	async saveDraft(input: DraftWrite): Promise<Draft> {
		const active = await this.store.active();
		if (!active || active.id !== input.sessionId) throw new Error("草稿不属于当前会话");
		return this.store.saveDraft(active.cwd, input);
	}

	async close(): Promise<void> {
		this.logger.info("开始关闭桌面工作区");
		this.closed = true;
		try {
			this.fileSearch?.abort();
			this.releaseHost?.();
			await this.nextHost?.close();
			await this.host?.close();
			await this.store.flush();
			this.listeners.clear();
		} finally {
			this.logger.info("桌面工作区关闭结束");
		}
	}
}
