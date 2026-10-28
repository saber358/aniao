import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ArchivePolicy, ArchiveSelection, ArchiveSnapshot } from "../shared/data-statistics.ts";
import type { GoalReadRequest, GoalSnapshot } from "../shared/goals.ts";
import type { ImageImport, ImageRead } from "../shared/images.ts";
import type { Logger } from "../shared/logger.ts";
import type { McpConnection } from "../shared/mcp.ts";
import type { PluginPackage, PluginScope } from "../shared/plugins.ts";
import type {
	ProjectFileMatches,
	ProjectFileReference,
	ProjectFileSearch,
	ProjectFileSelection,
} from "../shared/project-files.ts";
import type { AgentPort, CommandEnvelope, PortNotification, SessionSnapshot } from "../shared/protocol.ts";
import { isTaskRunning } from "../shared/protocol.ts";
import type { SubagentInspection } from "../shared/subagents.ts";
import type {
	Draft,
	DraftWrite,
	ForkSelection,
	ProjectSummary,
	SessionChange,
	SessionIdentity,
	SessionLibrary,
	SessionRuntime,
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
	renameSession(sessionId: string, title: string, cwd: string): Promise<void>;
	listPlugins?(): Promise<PluginPackage[]>;
	installPlugin?(source: string): Promise<PluginPackage[]>;
	removePlugin?(source: string, scope: PluginScope): Promise<PluginPackage[]>;
	readSubagentOutput?(runId: string, childId?: string): Promise<string | null>;
	readSubagentTranscript?(runId: string, childId?: string): Promise<string | null>;
	inspectSubagent?(runId: string, childId?: string): Promise<SubagentInspection>;
	readGoals?(request: GoalReadRequest): Promise<GoalSnapshot>;
	getMcpStatus?(): Promise<McpConnection[]>;
	close(): Promise<void>;
}

interface HostedSession {
	host: ManagedHost;
	runtime: SessionRuntime;
	phase: SessionSnapshot["run"]["phase"];
	seq: number;
	pending: number;
	dialogs: boolean;
	failed: boolean;
	release: () => void;
	resourcesRevision: number;
	reloading?: Promise<void>;
}

/*
 * ========================================================================
 * 步骤1：协调宿主切换、历史组织与草稿边界
 * ========================================================================
 * 数据源：SDK 宿主、桌面索引和用户已选择的项目。
 * 操作：
 *   1) 切换互斥，初始化失败时保留当前宿主
 *   2) 会话 ID 在已登记工作区中查证，Renderer 不提交文件路径
 */
export class WorkspaceService {
	private readonly store: WorkspaceStore;
	private readonly createHost: (cwd: string, target: SessionTarget) => ManagedHost;
	private readonly logger: Logger;
	private host: ManagedHost | null = null;
	private nextHost?: ManagedHost;
	private closed = false;
	private readonly hosts = new Map<ManagedHost, HostedSession>();
	private readonly recentHosts = new Map<string, ManagedHost>();
	private changing = false;
	private resourcesRevision = 0;
	private get pendingCommands(): number {
		return this.host ? (this.hosts.get(this.host)?.pending ?? 0) : 0;
	}
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
		if (this.changing) throw new Error("请等待当前操作结束");
		if (this.host !== expectedHost) throw new Error("工作区已切换，请重新选择会话");
		this.fileSearch?.abort();
		this.changing = true;
		this.logger.info("开始切换工作区会话");
		try {
			// 1.1 导航不替换运行时；只有分支需要来源会话的生命周期检查。
			if (target.type === "fork" && this.host && !this.host.isClosed) {
				if ((await this.host.getSnapshot()).run.phase !== "idle") throw new Error("请先停止当前任务再创建分支");
				await this.host.prepareTransition(target);
			}
			if (this.host && !this.host.isClosed) await this.getLibrary();
			if (this.closed) throw new Error("桌面工作区已关闭");
			const normalized = await realpath(cwd);
			if (!(await stat(normalized)).isDirectory()) throw new Error("项目目录已失效");
			if (this.closed) throw new Error("桌面工作区已关闭");
			const retained =
				target.type === "session"
					? [...this.hosts.values()].find(
							(entry) =>
								entry.runtime.cwd === normalized && entry.runtime.sessionId === target.id && !entry.host.isClosed,
						)?.host
					: target.type === "recent"
						? this.recentHosts.get(normalized)
						: undefined;
			const next = retained && !retained.isClosed ? retained : this.createHost(normalized, target);
			const created = next !== retained;
			this.nextHost = next;
			let current: SessionSnapshot;
			try {
				current = await next.getSnapshot();
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
				// 1.4 先订阅再补读快照，覆盖历史查询和索引保存期间漏收的状态。
				if (!this.hosts.has(next)) await this.trackHost(next, current);
			} catch (error) {
				if (created) await next.close();
				throw error;
			}
			if (this.closed) {
				if (created) await next.close();
				throw new Error("桌面工作区已关闭");
			}
			// 1.2 每个会话只持有一个宿主；恢复已有会话直接复用，不重启其任务或 Goal。
			this.host = next;
			this.recentHosts.set(normalized, next);
			this.publishRuntimes();
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
	 * 步骤8：保留独立会话宿主并按身份路由事件
	 * ========================================================================
	 * 数据源：每个 utilityProcess 的会话身份、运行阶段与交互事件。
	 * 操作：1) 订阅后补读快照并拒绝旧状态；2) 后台退出只标记对应会话。
	 */
	private async trackHost(host: ManagedHost, snapshot: SessionSnapshot): Promise<void> {
		this.logger.info("开始登记独立会话宿主");
		let entry: HostedSession | undefined;
		try {
			for (const previous of this.hosts.values()) {
				if (
					previous.host.isClosed &&
					previous.runtime.cwd === snapshot.cwd &&
					previous.runtime.sessionId === snapshot.sessionId
				) {
					previous.release();
					this.hosts.delete(previous.host);
				}
			}
			// 8.1 只缓存导航所需状态；完整消息由各会话自己的 SDK 和 Controller 持有。
			const tracked: HostedSession = {
				resourcesRevision: this.resourcesRevision,
				host,
				pending: 0,
				dialogs: snapshot.dialogs.length > 0,
				failed: snapshot.messages.at(-1)?.error !== undefined,
				phase: snapshot.run.phase,
				seq: snapshot.seq,
				release: () => {},
				runtime: {
					cwd: snapshot.cwd,
					sessionId: snapshot.sessionId,
					generation: snapshot.generation,
					title: snapshot.title,
					running: isTaskRunning(snapshot.run.phase),
					attention: snapshot.dialogs.length > 0 || snapshot.messages.at(-1)?.error !== undefined,
					connected: true,
				},
			};
			entry = tracked;
			const observed = { run: snapshot.seq, dialogs: snapshot.seq, title: snapshot.seq, failed: snapshot.seq };
			this.hosts.set(host, tracked);
			tracked.release = host.subscribe((notification) => {
				const entry = tracked;
				if (this.closed) return;
				let update = false;
				if (notification.type === "disconnected") {
					entry.runtime = { ...entry.runtime, connected: false, running: false, attention: true };
					notification = { ...notification, sessionId: entry.runtime.sessionId, generation: entry.runtime.generation };
					update = true;
				} else if (notification.type === "event") {
					if (
						notification.value.sessionId !== entry.runtime.sessionId ||
						notification.value.generation !== entry.runtime.generation ||
						notification.value.seq <= entry.seq
					)
						return;
					entry.seq = notification.value.seq;
					const event = notification.value.event;
					if (event.type === "run") {
						observed.run = entry.seq;
						entry.phase = event.run.phase;
						if (entry.phase === "preparing") {
							entry.failed = false;
							observed.failed = entry.seq;
						}
						entry.runtime = {
							...entry.runtime,
							running: !host.isClosed && entry.runtime.connected && isTaskRunning(entry.phase),
							attention: entry.dialogs || entry.failed,
						};
						update = true;
					} else if (event.type === "dialogs") {
						observed.dialogs = entry.seq;
						entry.dialogs = event.dialogs.length > 0;
						entry.runtime = { ...entry.runtime, attention: entry.dialogs || entry.failed };
						update = true;
					} else if (event.type === "title") {
						observed.title = entry.seq;
						entry.runtime = { ...entry.runtime, title: event.title };
						update = true;
					} else if (event.type === "message" && event.message.error) {
						observed.failed = entry.seq;
						entry.failed = true;
						entry.runtime = { ...entry.runtime, attention: true };
						update = true;
					}
				}
				for (const listener of this.listeners) listener(notification);
				if (update) this.publishRuntimes();
			});
			// 8.4 各字段分别核对序号；新标题不妨碍补回订阅前漏收的任务结束。
			const latest = await host.getSnapshot();
			if (this.closed || host.isClosed) throw new Error("桌面工作区已关闭");
			if (latest.sessionId !== tracked.runtime.sessionId || latest.generation !== tracked.runtime.generation)
				throw new Error("会话身份已变化，请重新打开会话");
			tracked.seq = Math.max(tracked.seq, latest.seq);
			if (latest.seq >= observed.run) tracked.phase = latest.run.phase;
			if (latest.seq >= observed.dialogs) tracked.dialogs = latest.dialogs.length > 0;
			if (latest.seq >= observed.failed) tracked.failed = latest.messages.at(-1)?.error !== undefined;
			tracked.runtime = {
				...tracked.runtime,
				title: latest.seq >= observed.title ? latest.title : tracked.runtime.title,
				running: tracked.runtime.connected && isTaskRunning(tracked.phase),
				attention: tracked.dialogs || tracked.failed,
			};
		} catch (error) {
			entry?.release();
			this.hosts.delete(host);
			throw error;
		} finally {
			this.logger.info("独立会话宿主登记结束");
		}
	}

	getSessionRuntimes(): SessionRuntime[] {
		return [...this.hosts.values()].map((entry) => ({
			...entry.runtime,
			connected: !entry.host.isClosed && entry.runtime.connected,
		}));
	}

	private publishRuntimes(): void {
		const notification: PortNotification = { type: "sessions", sessions: this.getSessionRuntimes() };
		for (const listener of this.listeners) listener(notification);
	}

	async getSessionSnapshot(identity: SessionIdentity): Promise<SessionSnapshot | null> {
		this.logger.info("开始读取指定会话快照");
		try {
			// 8.2 只接受本次应用持有的宿主身份，不允许用会话 ID 打开任意磁盘路径。
			const entry = [...this.hosts.values()].find(
				(entry) => entry.runtime.sessionId === identity.sessionId && entry.runtime.generation === identity.generation,
			);
			if (!entry || entry.host.isClosed) throw new Error("会话宿主已退出，请重新打开该会话");
			return await entry.host.getSnapshot();
		} finally {
			this.logger.info("指定会话快照读取结束");
		}
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
				this.resourcesRevision++;
				if (!host || !snapshot) return;
				if (this.closed || host.isClosed || this.host !== host) throw new Error("会话已更换，请重新打开项目");
				await host.dispatch({
					requestId: randomUUID(),
					sessionId: snapshot.sessionId,
					generation: snapshot.generation,
					command: { type: "reloadResources" },
				});
				const active = this.hosts.get(host);
				if (active) active.resourcesRevision = this.resourcesRevision;
			});
		} finally {
			this.changing = false;
			this.logger.info("工作区资源配置修改结束");
			await Promise.allSettled([...this.hosts.values()].map((entry) => this.refreshHostResources(entry)));
		}
	}

	/*
	 * ========================================================================
	 * 步骤11：让已打开的其他会话同步全局 MCP 配置
	 * ========================================================================
	 * 数据源：全局资源修订、每个宿主的空闲事实与配置快照。
	 * 操作：1) 空闲会话即时重载；2) 忙碌会话收束后重载，下一任务前强制核对。
	 */
	private async refreshHostResources(entry: HostedSession): Promise<void> {
		if (entry.reloading) return entry.reloading;
		if (
			this.closed ||
			this.changing ||
			entry.host.isClosed ||
			entry.resourcesRevision === this.resourcesRevision ||
			entry.pending
		)
			return;
		const revision = this.resourcesRevision;
		entry.reloading = (async () => {
			this.logger.info("开始同步会话 MCP 配置");
			try {
				const state = await entry.host.getSnapshot();
				if (
					state.run.phase !== "idle" ||
					state.dialogs.length ||
					state.authentication.flow ||
					(state.plan && !["off", "completed"].includes(state.plan.phase))
				)
					return;
				await entry.host.dispatch({
					requestId: randomUUID(),
					sessionId: state.sessionId,
					generation: state.generation,
					command: { type: "reloadResources" },
				});
				entry.resourcesRevision = revision;
			} finally {
				this.logger.info("会话 MCP 配置同步结束");
			}
		})();
		try {
			await entry.reloading;
		} finally {
			entry.reloading = undefined;
		}
	}
	async getMcpStatus(): Promise<McpConnection[]> {
		const host = this.host;
		if (!host?.getMcpStatus || host.isClosed) return [];
		const status = await host.getMcpStatus();
		return this.host === host && !host.isClosed ? status : [];
	}

	async listPlugins(): Promise<PluginPackage[]> {
		if (!this.host?.listPlugins || this.host.isClosed) throw new Error("请先连接项目");
		return this.host.listPlugins();
	}
	async readGoals(request: GoalReadRequest): Promise<GoalSnapshot> {
		this.logger.info("开始读取工作区目标");
		try {
			// 1.7 不允许 Renderer 指定其他项目；切换后丢弃旧宿主回复。
			const host = this.host;
			if (!host?.readGoals || host.isClosed) throw new Error("请先连接项目");
			const snapshot = await host.getSnapshot();
			if (
				snapshot.cwd !== request.cwd ||
				snapshot.sessionId !== request.sessionId ||
				snapshot.generation !== request.generation
			)
				throw new Error("会话已更换，请刷新目标状态");
			const value = await host.readGoals(request);
			if (host !== this.host || host.isClosed) throw new Error("会话已更换，请刷新目标状态");
			return value;
		} finally {
			this.logger.info("工作区目标读取结束");
		}
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
	async inspectSubagent(runId: string, childId?: string): Promise<SubagentInspection> {
		this.logger.info("开始读取当前会话子智能体详情");
		try {
			// 1.6 请求完成后再次核对宿主，拒绝切换项目后迟到的结果。
			const host = this.host;
			if (!host?.inspectSubagent || host.isClosed) throw new Error("请先连接项目");
			const value = await host.inspectSubagent(runId, childId);
			if (host !== this.host || host.isClosed) throw new Error("会话已更换，请重新打开子智能体");
			return value;
		} finally {
			this.logger.info("当前会话子智能体详情读取结束");
		}
	}

	async dispatch(envelope: CommandEnvelope): Promise<void> {
		const entry = [...this.hosts.values()].find(
			(entry) => entry.runtime.sessionId === envelope.sessionId && entry.runtime.generation === envelope.generation,
		);
		if (
			!entry ||
			entry.host.isClosed ||
			(this.changing && !["reply", "cancelLogin", "abort", "dismissNotice"].includes(envelope.command.type))
		)
			throw new Error("请先连接项目");
		if (["prompt", "approvePlan"].includes(envelope.command.type)) {
			await this.refreshHostResources(entry);
			if (entry.resourcesRevision !== this.resourcesRevision)
				throw new Error("MCP 配置更新待生效，请先处理当前交互或计划");
		}
		entry.pending++;
		try {
			// 8.3 命令从提交到完成始终绑定原宿主，切换页面不改变其归属。
			await entry.host.dispatch(envelope);
		} finally {
			entry.pending--;
			entry.runtime = {
				...entry.runtime,
				running: !entry.host.isClosed && entry.runtime.connected && isTaskRunning(entry.phase),
			};
			if (!this.closed) this.publishRuntimes();
			if (!this.closed)
				void this.refreshHostResources(entry).catch(() => this.logger.info("会话 MCP 更新失败，下次任务前重试"));
		}
	}

	async getLibrary(): Promise<SessionLibrary | null> {
		if (!this.host) return null;
		const host = this.host;
		const snapshot = await host.getSnapshot();
		const entries = await host.listSessions();
		// 1.2 摘要刷新保留索引顺序；打开、恢复和修改时间变化都不置顶。
		await this.store.rememberSessions(snapshot.cwd, entries);
		const sessions = await this.store.sessions(snapshot.cwd);
		return {
			cwd: snapshot.cwd,
			sessions: sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned)),
		};
	}

	async getProjects(): Promise<ProjectSummary[]> {
		const cwds = await this.store.projects();
		const projects: ProjectSummary[] = [];
		for (const cwd of cwds) {
			const sessions = await this.store.sessions(cwd);
			sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned));
			const savedName = await this.store.projectName(cwd);
			projects.push({ cwd, name: savedName ?? (basename(cwd) || cwd), sessions });
		}
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
		const entries = [...this.hosts.values()].filter((entry) => entry.runtime.cwd === cwd);
		for (const entry of entries) {
			if (!entry.host.isClosed && ((await entry.host.getSnapshot()).run.phase !== "idle" || entry.pending))
				throw new Error("该工作区仍有运行中的会话，请先停止任务");
		}
		for (const entry of entries) {
			entry.release();
			await entry.host.close();
			this.hosts.delete(entry.host);
		}
		if (snapshot?.cwd === cwd) this.host = null;
		this.recentHosts.delete(cwd);
		this.publishRuntimes();
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
		const current = this.host?.isClosed ? null : await this.getSnapshot();
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
		const snapshot = this.host?.isClosed ? this.hosts.get(this.host)?.runtime : await this.getSnapshot();
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

	/*
	 * ========================================================================
	 * 步骤9：按目标会话归属更新各工作区组织信息
	 * ========================================================================
	 * 数据源：已登记会话与对应宿主，不信任界面传入的磁盘路径。
	 * 操作：1) 重命名路由到目标宿主或已保存历史；2) 置顶归档只更新索引。
	 */
	async updateSession(change: SessionChange): Promise<void> {
		if (this.closed || this.changing) throw new Error("请等待当前操作结束");
		this.changing = true;
		this.logger.info("开始更新会话组织");
		try {
			// 9.1 目标目录取自桌面索引，操作其他工作区不切换当前会话。
			const entry = await this.store.findSession(change.sessionId);
			if (!entry) throw new Error("会话已不在工作区列表中");
			const retained = [...this.hosts.values()].find(
				(item) => item.runtime.sessionId === change.sessionId && item.runtime.cwd === entry.cwd && !item.host.isClosed,
			);
			// 9.2 只有目标会话重命名需要等待任务；其他会话运行不影响组织操作。
			if (change.title && retained && (retained.pending || (await retained.host.getSnapshot()).run.phase !== "idle"))
				throw new Error("请等待该会话任务结束后重命名");
			if (change.title && (entry.persisted || retained)) {
				const owner = retained?.host ?? [...this.hosts.keys()].find((host) => !host.isClosed);
				if (!owner) throw new Error("请先连接项目");
				await owner.renameSession(entry.id, change.title, entry.cwd);
			}
			// 9.3 未落盘且未打开的空会话只改索引，下次打开时恢复名称。
			await this.store.update(entry.cwd, change);
		} finally {
			this.changing = false;
			this.logger.info("会话组织更新结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤10：管理跨工作区归档与自动清理候选
	 * ========================================================================
	 * 数据源：原子桌面索引、实时宿主和用户明确选中的身份。
	 * 操作：1) 自动归档跳过置顶和非空闲会话；2) 删除前再次核对全部目标。
	 */
	async getArchiveSnapshot(): Promise<ArchiveSnapshot> {
		const names = new Map<string, string>();
		for (const cwd of await this.store.projects())
			names.set(cwd, (await this.store.projectName(cwd)) ?? (basename(cwd) || "未归类"));
		return {
			policy: await this.store.archivePolicy(),
			sessions: (await this.store.allSessions())
				.filter((item) => item.archived)
				.map((item) => ({
					...item,
					projectName: names.get(item.cwd) ?? (basename(item.cwd) || "未归类"),
					running: [...this.hosts.values()].some(
						(host) =>
							host.runtime.sessionId === item.id && !host.host.isClosed && (host.phase !== "idle" || host.pending > 0),
					),
				})),
		};
	}
	async saveArchivePolicy(policy: ArchivePolicy): Promise<ArchiveSnapshot> {
		await this.store.setArchivePolicy(policy);
		await this.autoArchive();
		return this.getArchiveSnapshot();
	}
	async autoArchive(now = Date.now()): Promise<void> {
		if (this.closed || this.changing) return;
		this.changing = true;
		this.logger.info("开始扫描自动归档候选");
		try {
			const policy = await this.store.archivePolicy();
			if (!policy.enabled) return;
			// 10.1 用磁盘摘要中的最后活动时间；宿主最新快照保护正在运行或交互的会话。
			const protectedIds = new Set<string>();
			for (const entry of this.hosts.values()) {
				if (entry.host.isClosed) continue;
				const state = await entry.host.getSnapshot();
				if (entry.pending || state.run.phase !== "idle" || state.dialogs.length) protectedIds.add(state.sessionId);
			}
			const cutoff = now - policy.retentionDays * 86400000;
			const restoredAt = await this.store.archiveRestoredAt();
			const ids = (await this.store.allSessions())
				.filter(
					(item) =>
						!item.archived &&
						!item.pinned &&
						Math.max(item.updatedAt, restoredAt[item.id] ?? 0) < cutoff &&
						!protectedIds.has(item.id),
				)
				.map((item) => item.id);
			if (ids.length) {
				await this.store.setArchived(ids, true);
				this.publishRuntimes();
			}
		} finally {
			this.changing = false;
			this.logger.info("自动归档候选扫描结束");
		}
	}
	async restoreArchived(selection: ArchiveSelection): Promise<ArchiveSnapshot> {
		if (this.closed || this.changing) throw new Error("请等待当前操作结束");
		this.changing = true;
		this.logger.info("开始恢复归档会话");
		try {
			const entries = await this.store.allSessions();
			if (selection.sessionIds.some((id) => !entries.some((item) => item.id === id && item.archived)))
				throw new Error("部分会话已不在归档中，请刷新");
			await this.store.setArchived(selection.sessionIds, false);
			this.publishRuntimes();
			return await this.getArchiveSnapshot();
		} finally {
			this.changing = false;
			this.logger.info("归档会话恢复结束");
		}
	}
	async deleteArchived(
		selection: ArchiveSelection,
		removeHistory: (cwd: string, sessionId: string) => Promise<void>,
	): Promise<ArchiveSnapshot> {
		if (this.closed || this.changing) throw new Error("请等待当前操作结束");
		this.changing = true;
		this.logger.info("开始删除用户确认的归档会话");
		try {
			const ids = new Set(selection.sessionIds);
			const entries = (await this.store.allSessions()).filter((item) => ids.has(item.id));
			if (entries.length !== ids.size || entries.some((item) => !item.archived))
				throw new Error("部分会话已不在归档中，请刷新");
			const hosts = [...this.hosts.values()].filter((entry) => ids.has(entry.runtime.sessionId));
			// 10.2 先检查全部目标，再开始任何文件操作，避免混入运行会话后只删半批。
			for (const entry of hosts) {
				if (!entry.host.isClosed && (entry.pending || (await entry.host.getSnapshot()).run.phase !== "idle"))
					throw new Error("选中的会话仍在运行，请结束后再删除");
			}
			for (const entry of hosts) {
				entry.release();
				await entry.host.close();
				this.hosts.delete(entry.host);
				if (this.host === entry.host) this.host = null;
				if (this.recentHosts.get(entry.runtime.cwd) === entry.host) this.recentHosts.delete(entry.runtime.cwd);
			}
			for (const item of entries) {
				if (item.persisted) await removeHistory(item.cwd, item.id);
				await this.store.forgetSession(item.id);
			}
			return await this.getArchiveSnapshot();
		} finally {
			this.changing = false;
			this.publishRuntimes();
			this.logger.info("用户确认的归档会话删除结束");
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
		const entry = [...this.hosts.values()].find((entry) => entry.runtime.sessionId === sessionId);
		if (!entry) throw new Error("草稿不属于已打开会话");
		return this.store.loadDraft(entry.runtime.cwd, sessionId);
	}

	async saveDraft(input: DraftWrite): Promise<Draft> {
		const entry = [...this.hosts.values()].find((entry) => entry.runtime.sessionId === input.sessionId);
		if (!entry) throw new Error("草稿不属于已打开会话");
		return this.store.saveDraft(entry.runtime.cwd, input);
	}

	async close(): Promise<void> {
		this.logger.info("开始关闭桌面工作区");
		this.closed = true;
		try {
			this.fileSearch?.abort();
			for (const entry of this.hosts.values()) entry.release();
			const hosts = new Set([...this.hosts.keys(), ...(this.nextHost ? [this.nextHost] : [])]);
			const results = await Promise.allSettled([...hosts].map((host) => host.close()));
			this.hosts.clear();
			this.recentHosts.clear();
			await this.store.flush();
			this.listeners.clear();
			if (results.some((result) => result.status === "rejected"))
				throw new Error("部分会话保存失败，已关闭其他会话，请核对恢复记录");
		} finally {
			this.logger.info("桌面工作区关闭结束");
		}
	}
}
