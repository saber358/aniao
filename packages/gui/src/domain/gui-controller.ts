import { IMAGE_COUNT_LIMIT, type ImagesPort } from "../shared/images.ts";
import { DRAFT_TEXT_LIMIT } from "../shared/input-limits.ts";
import type { Logger } from "../shared/logger.ts";
import type { ProjectFileReference, ProjectFilesPort } from "../shared/project-files.ts";
import type { AgentPort, GuiCommand, PortNotification, SessionSnapshot } from "../shared/protocol.ts";
import type { DraftPort } from "../shared/workspace.ts";
import { applyFileCompletion, type FileCompletion } from "./file-completion.ts";
import { queueItems } from "./queue-view.ts";
import { SessionProjection } from "./session-projection.ts";

export interface GuiState {
	snapshot: SessionSnapshot | null;
	connection: "connecting" | "connected" | "disconnected";
	draft: string;
	submitting: boolean;
	error: string | null;
	draftStatus: "loading" | "saved" | "saving" | "error";
	draftError: string | null;
	queueBusy: boolean;
	selectingFiles: boolean;
	imageIds: string[];
}

/*
 * ========================================================================
 * 步骤1：协调业务命令、订阅与快照恢复
 * ========================================================================
 * 数据源：可替换的 AgentPort；状态供界面订阅。
 * 操作：
 *   1) 先订阅后取快照，缓冲连接期间的事件
 *   2) 发现序号缺口时只拉取一次快照，不自动重发命令
 */
export class GuiController {
	private readonly port: AgentPort;
	private readonly logger: Logger;
	private readonly listeners = new Set<(state: GuiState) => void>();
	private projection: SessionProjection | null = null;
	private unsubscribe?: () => void;
	private syncing?: Promise<void>;
	private buffered: PortNotification[] = [];
	private disposed = false;
	private pendingDraft: { text: string; imageIds: string[]; accepted: boolean; kind: "prompt" | "enqueue" } | null =
		null;
	private restoredQueue?: { sessionId: string; source: string; draft: string; images: string };
	private clearingQueue = false;
	private readonly workspace: DraftPort & ProjectFilesPort & ImagesPort;
	private draftSessionId = "";
	private draftRevision = 0;
	private savedDraft = "";
	private savedImageIds: string[] = [];
	private savingDraft?: Promise<boolean>;
	private state: GuiState = {
		snapshot: null,
		connection: "connecting",
		draft: "",
		submitting: false,
		error: null,
		draftStatus: "loading",
		draftError: null,
		queueBusy: false,
		selectingFiles: false,
		imageIds: [],
	};

	constructor(port: AgentPort, logger: Logger, workspace: DraftPort & ProjectFilesPort & ImagesPort) {
		this.port = port;
		this.logger = logger;
		this.workspace = workspace;
	}

	get value(): GuiState {
		return this.state;
	}

	subscribe(listener: (state: GuiState) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => {
			this.listeners.delete(listener);
		};
	}

	setDraft(draft: string): void {
		if (this.state.draftStatus === "loading" || !this.draftSessionId) return;
		this.publish({ draft });
		void this.flushDraft();
	}

	/*
	 * ========================================================================
	 * 步骤3：串行保存当前草稿
	 * ========================================================================
	 * 数据源：当前会话输入与主进程修订号。
	 * 操作：
	 *   1) 在途写入合并后续输入，成功后才更新保存基线
	 *   2) 保存失败保留编辑内容，切换前必须等待保存结果
	 */
	async flushDraft(): Promise<boolean> {
		if (this.savingDraft) return this.savingDraft;
		if (!this.draftSessionId) return true;
		if (this.savedDraft === this.state.draft && this.savedImageIds.join() === this.state.imageIds.join()) {
			this.publish({ draftStatus: "saved", draftError: null });
			return true;
		}
		this.logger.info("开始持久化输入草稿");
		this.publish({ draftStatus: "saving", draftError: null });
		this.savingDraft = Promise.resolve().then(async () => {
			try {
				// 3.1 保存同一会话最新内容，不为每次按键并行发起写入。
				while (this.savedDraft !== this.state.draft || this.savedImageIds.join() !== this.state.imageIds.join()) {
					const text = this.state.draft;
					const imageIds = this.state.imageIds;
					const saved = await this.workspace.saveDraft({
						sessionId: this.draftSessionId,
						text,
						revision: this.draftRevision,
						...(imageIds.length ? { imageIds } : {}),
					});
					this.draftRevision = saved.revision;
					this.savedDraft = text;
					this.savedImageIds = imageIds;
				}
				this.publish({ draftStatus: "saved" });
				return true;
			} catch (error) {
				this.publish({ draftStatus: "error", draftError: error instanceof Error ? error.message : "草稿保存失败" });
				return false;
			} finally {
				this.savingDraft = undefined;
				this.logger.info("输入草稿持久化结束");
			}
		});
		return this.savingDraft;
	}

	async connect(): Promise<void> {
		this.logger.info("开始连接会话端口");
		try {
			// 1.1 安装唯一订阅，Renderer 重载可重新读取宿主在途状态。
			this.unsubscribe ??= this.port.subscribe((notification) => {
				if (this.syncing) this.buffered.push(notification);
				else this.receive(notification);
			});
			await this.refresh();
		} finally {
			this.logger.info("会话端口连接结束");
		}
	}

	async refresh(): Promise<void> {
		if (this.disposed) return;
		if (this.syncing) return this.syncing;
		this.logger.info("开始同步会话快照");
		// 1.2 在微任务内发起查询，保证同步返回的端口也先进入缓冲状态。
		this.syncing = Promise.resolve()
			.then(async () => {
				try {
					const snapshot = await this.port.getSnapshot();
					if (this.disposed) return;
					if (snapshot && snapshot.sessionId !== this.draftSessionId) {
						if (!(await this.flushDraft())) throw new Error("草稿尚未保存，已保留当前输入");
						this.publish({ draftStatus: "loading" });
						const draft = await this.workspace.loadDraft(snapshot.sessionId);
						if (this.disposed) return;
						this.draftSessionId = snapshot.sessionId;
						this.draftRevision = draft.revision;
						this.savedDraft = draft.text;
						this.savedImageIds = draft.imageIds ?? [];
						this.publish({ draft: draft.text, imageIds: this.savedImageIds, draftStatus: "saved", draftError: null });
					}
					this.projection = snapshot ? new SessionProjection(snapshot, this.logger) : null;
					this.publish({ snapshot: this.projection?.value ?? null, connection: "connected", error: null });
				} catch (error) {
					if (!this.disposed) {
						const message = error instanceof Error ? error.message : String(error);
						this.publish({
							connection: "disconnected",
							error: message,
							...(this.state.draftStatus === "loading" ? { draftStatus: "error", draftError: message } : {}),
						});
					}
				}
			})
			.finally(() => {
				this.syncing = undefined;
				const buffered = this.buffered;
				this.buffered = [];
				for (const notification of buffered) this.receive(notification);
				this.logger.info("会话快照同步结束");
			});
		return this.syncing;
	}

	private receive(notification: PortNotification): void {
		if (this.disposed) return;
		// 1.3 连接故障独立于运行结果；保留草稿供用户核对。
		if (notification.type === "disconnected") {
			this.publish({ connection: "disconnected", error: notification.reason });
			return;
		}
		if (!this.projection) return;
		const result = this.projection.apply(notification.value);
		if (result === "gap") {
			void this.refresh();
			return;
		}
		if (result === "applied") {
			const event = notification.value.event;
			if (
				event.type === "message" &&
				event.message.role === "user" &&
				this.pendingDraft &&
				this.pendingDraft.kind === "prompt" &&
				!this.pendingDraft.accepted
			) {
				this.pendingDraft.accepted = true;
				// 图片在首个助手消息前可能尚未落盘，保留草稿直到 SDK 调用正常收束。
				if (!this.pendingDraft.imageIds.length) {
					this.clearAcceptedDraft(this.pendingDraft);
					this.pendingDraft = null;
				}
				this.publish({ submitting: false });
			}
			this.publish({ snapshot: this.projection.value });
		}
	}

	/*
	 * ========================================================================
	 * 步骤2：提交带会话身份的命令
	 * ========================================================================
	 * 数据源：当前快照和输入草稿。
	 * 操作：
	 *   1) 阻止重复发送与旧会话命令
	 *   2) 只在用户消息已进入会话或命令成功后清理原草稿
	 */
	async send(command: GuiCommand): Promise<boolean> {
		const snapshot = this.state.snapshot;
		if (!snapshot || this.state.connection !== "connected" || this.disposed) return false;
		if (this.state.draftStatus === "loading" || this.state.selectingFiles) return false;
		const isSubmission = command.type === "prompt" || command.type === "enqueue";
		if (isSubmission && (snapshot.dialogs.length || snapshot.authentication.flow?.phase === "working")) return false;
		if (isSubmission && this.state.imageIds.length) {
			if (!snapshot.configuration.model?.supportsImages) {
				this.publish({ error: "当前模型不支持图片，请先切换模型" });
				return false;
			}
		}
		if (isSubmission && (this.state.submitting || this.state.queueBusy)) return false;
		if (command.type === "prompt" && snapshot.run.phase !== "idle") return false;
		if (command.type === "enqueue" && snapshot.run.phase !== "working") return false;
		if (command.type === "clearQueue" && (this.clearingQueue || snapshot.run.phase !== "idle")) return false;
		this.logger.info("开始提交界面命令");
		if (command.type === "clearQueue") {
			this.clearingQueue = true;
			this.publish({ queueBusy: true });
		}
		const submission = isSubmission
			? { text: command.text, imageIds: this.state.imageIds, accepted: false, kind: command.type }
			: null;
		if (submission) {
			this.pendingDraft = submission;
			this.publish({ submitting: true, error: null });
		} else this.publish({ error: null });
		try {
			// 2.4 图片发送前保存草稿；准备失败或进程退出后仍有本地恢复依据。
			if (submission?.imageIds.length) {
				if (!(await this.flushDraft())) return false;
				const current = this.value;
				if (
					this.disposed ||
					current.connection !== "connected" ||
					current.snapshot?.sessionId !== snapshot.sessionId ||
					current.snapshot.generation !== snapshot.generation ||
					current.snapshot.run.phase !== (command.type === "enqueue" ? "working" : "idle")
				)
					throw new Error("会话状态已变化，图片未发送");
			}
			// 2.1 请求身份由业务层产生，传输层不重试有副作用的操作。
			const envelope = {
				requestId: crypto.randomUUID(),
				sessionId: snapshot.sessionId,
				generation: snapshot.generation,
				command: isSubmission && submission?.imageIds.length ? { ...command, imageIds: submission.imageIds } : command,
			};
			// 2.2 contextBridge 在进入 preload 前克隆参数；Vue reactive Proxy 不能跨桥。
			const plain = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
			await this.port.dispatch(plain);
			// 2.3 用户可能已编辑新草稿，不能覆盖新输入。
			if (submission && (!submission.accepted || submission.imageIds.length)) this.clearAcceptedDraft(submission);
			return true;
		} catch (error) {
			if (!this.disposed) {
				this.publish({ error: error instanceof Error ? error.message : String(error) });
			}
			return false;
		} finally {
			if (command.type === "clearQueue") {
				this.clearingQueue = false;
				this.publish({ queueBusy: false });
			}
			if (submission && this.pendingDraft === submission) {
				this.pendingDraft = null;
				this.publish({ submitting: false });
			}
			this.logger.info("界面命令提交结束");
		}
	}

	private clearAcceptedDraft(submission: { text: string; imageIds: string[] }): void {
		if (this.state.draft !== submission.text || this.state.imageIds.join() !== submission.imageIds.join()) return;
		this.publish({ draft: "", imageIds: [] });
		void this.flushDraft();
	}

	/*
	 * ========================================================================
	 * 步骤4：先保存恢复输入，再清空待处理消息
	 * ========================================================================
	 * 数据源：当前会话队列、待核对恢复记录和现有草稿。
	 * 操作：
	 *   1) 合并输入后等待草稿持久化，失败时保留原队列
	 *   2) 清空失败可重试同一恢复，不重复附加相同内容
	 */
	async restoreQueue(): Promise<boolean> {
		const snapshot = this.state.snapshot;
		if (
			!snapshot ||
			snapshot.run.phase !== "idle" ||
			this.state.submitting ||
			this.state.queueBusy ||
			this.state.selectingFiles ||
			this.state.connection !== "connected"
		)
			return false;
		const items = queueItems(snapshot.queue);
		const text = items.map((item) => item.text).join("\n\n");
		const source = JSON.stringify(items);
		if (!text) return false;
		this.logger.info("开始恢复待处理输入");
		this.publish({ queueBusy: true });
		try {
			// 4.1 相同恢复的失败重试只重试清空，用户新输入仍完整保留。
			const previous = this.restoredQueue;
			if (
				previous?.sessionId !== snapshot.sessionId ||
				previous.source !== source ||
				previous.draft !== this.state.draft ||
				previous.images !== this.state.imageIds.join()
			) {
				const imageIds = [...new Set([...this.state.imageIds, ...items.flatMap((item) => item.imageIds ?? [])])];
				const draft = [this.state.draft, text].filter(Boolean).join("\n\n");
				if (imageIds.length > IMAGE_COUNT_LIMIT || draft.length > DRAFT_TEXT_LIMIT) {
					this.publish({ error: "恢复内容超过草稿上限，请先整理草稿或清空队列" });
					return false;
				}
				this.publish({ draft, imageIds });
				this.restoredQueue = { sessionId: snapshot.sessionId, source, draft, images: imageIds.join() };
			}
			if (!(await this.flushDraft())) return false;
			return await this.send({ type: "clearQueue" });
		} finally {
			this.publish({ queueBusy: false });
			this.logger.info("待处理输入恢复结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤5：把项目文件引用合并到最新草稿
	 * ========================================================================
	 * 数据源：受限桌面选择端口与当前会话的最新输入。
	 * 操作：
	 *   1) 选择期间阻止提交；取消、旧身份和超限结果不改输入
	 *   2) 保留原有空白，转义引用路径，复用串行草稿保存而不自动发送
	 */
	async referenceProjectFiles(reference?: ProjectFileReference, completion?: FileCompletion): Promise<boolean> {
		const snapshot = this.state.snapshot;
		if (
			!snapshot ||
			this.disposed ||
			this.state.connection !== "connected" ||
			this.state.draftStatus === "loading" ||
			this.draftSessionId !== snapshot.sessionId ||
			snapshot.run.phase !== "idle" ||
			this.state.submitting ||
			this.state.queueBusy ||
			this.state.selectingFiles
		)
			return false;
		if (reference && (reference.sessionId !== snapshot.sessionId || reference.generation !== snapshot.generation)) {
			this.publish({ error: "会话已更换，未添加文件引用" });
			return false;
		}
		this.logger.info("开始把项目文件加入草稿");
		this.publish({ selectingFiles: true, error: null });
		try {
			// 5.3 行内补全必须保留请求时的完整草稿，并且只允许选择一条路径。
			if (completion && (!reference || reference.paths.length !== 1 || completion.source !== this.state.draft))
				throw new Error("草稿已变化，未替换文件引用，请重新选择");
			// 5.1 原生选择只传身份；搜索选择仅传相对候选，主进程重新核对真实归属。
			const paths = reference
				? await this.workspace.validateProjectFiles(reference)
				: await this.workspace.selectProjectFiles({ sessionId: snapshot.sessionId, generation: snapshot.generation });
			if (this.disposed || !paths.length) return false;
			const state = this.value;
			const current = state.snapshot;
			if (
				state.connection !== "connected" ||
				state.draftStatus === "loading" ||
				current?.sessionId !== snapshot.sessionId ||
				current.generation !== snapshot.generation ||
				current.run.phase !== "idle" ||
				this.draftSessionId !== snapshot.sessionId
			)
				throw new Error("会话状态已变化，未添加文件引用");
			// 5.2 读取返回时的最新输入，整批检查长度后才更新；JSON 转义只用于文本。
			const draft = this.state.draft;
			const separator = draft && !draft.endsWith("\n") ? "\n" : "";
			const text = completion
				? applyFileCompletion(draft, completion, paths[0], this.logger)
				: `${draft}${separator}${paths.map((path) => `@${JSON.stringify(path)}`).join("\n")}\n`;
			if (text.length > DRAFT_TEXT_LIMIT) throw new Error("草稿超过长度上限，未添加文件引用");
			this.setDraft(text);
			await this.flushDraft();
			return true;
		} catch (error) {
			this.publish({ error: error instanceof Error ? error.message : "项目文件引用失败，请重试" });
			return false;
		} finally {
			this.publish({ selectingFiles: false });
			this.logger.info("项目文件草稿处理结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤6：把已保存图片加入会话草稿
	 * ========================================================================
	 * 数据源：本地选择端口或 Renderer 提供的有界内容读取器。
	 * 操作：
	 *   1) 读取内容前建立选择互斥，复用会话代次和串行草稿保存
	 *   2) 取消与超限不改草稿，存储失败保留可见引用，不自动发送
	 */
	async attachImages(readImages?: () => Promise<string[]>): Promise<boolean> {
		const snapshot = this.state.snapshot;
		if (this.disposed) return false;
		if (
			!snapshot ||
			this.state.connection !== "connected" ||
			this.state.selectingFiles ||
			this.state.submitting ||
			this.state.queueBusy ||
			this.state.draftStatus === "loading" ||
			!!snapshot.dialogs.length ||
			snapshot.authentication.flow?.phase === "working" ||
			!["idle", "working"].includes(snapshot.run.phase)
		) {
			this.publish({ error: "当前状态暂不可添加图片，请等待操作结束并连接项目" });
			return false;
		}
		if (!snapshot.configuration.model?.supportsImages) {
			this.publish({ error: "当前模型不支持图片，请先切换模型" });
			return false;
		}
		this.logger.info("开始添加图片草稿");
		this.publish({ selectingFiles: true, error: null });
		try {
			// 6.1 读取器在互斥建立后调用；粘贴和拖放不使用本地文件路径。
			const selection = { sessionId: snapshot.sessionId, generation: snapshot.generation };
			const data = readImages ? await readImages() : undefined;
			if (this.disposed || data?.length === 0) return false;
			if (
				this.state.connection !== "connected" ||
				this.state.snapshot?.sessionId !== selection.sessionId ||
				this.state.snapshot.generation !== selection.generation ||
				!["idle", "working"].includes(this.state.snapshot.run.phase)
			)
				throw new Error("会话状态已变化，未添加图片");
			const ids = data
				? await this.workspace.importImages({ ...selection, data })
				: await this.workspace.selectImages(selection);
			if (this.disposed || !ids.length) return false;
			const state = this.value;
			if (
				state.snapshot?.sessionId !== snapshot.sessionId ||
				state.snapshot.generation !== snapshot.generation ||
				!["idle", "working"].includes(state.snapshot.run.phase) ||
				state.connection !== "connected" ||
				this.draftSessionId !== snapshot.sessionId
			)
				throw new Error("会话状态已变化，未添加图片");
			const imageIds = [...new Set([...state.imageIds, ...ids])];
			if (imageIds.length > IMAGE_COUNT_LIMIT) throw new Error("每份草稿最多添加 4 张图片");
			this.publish({ imageIds });
			await this.flushDraft();
			return true;
		} catch (error) {
			this.publish({ error: error instanceof Error ? error.message : "图片添加失败，请重试" });
			return false;
		} finally {
			this.publish({ selectingFiles: false });
			this.logger.info("图片草稿添加结束");
		}
	}

	removeImage(imageId: string): void {
		this.logger.info("开始移除草稿图片");
		try {
			// 6.2 只移除当前草稿引用，保留历史与内容库，不删除文件。
			if (this.disposed || this.state.draftStatus === "loading" || this.state.selectingFiles) return;
			this.publish({ imageIds: this.state.imageIds.filter((id) => id !== imageId) });
			void this.flushDraft();
		} finally {
			this.logger.info("草稿图片移除结束");
		}
	}

	dispose(): void {
		this.logger.info("开始释放界面订阅");
		// 2.3 关闭界面只释放订阅，不停止独立宿主。
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.buffered = [];
		this.listeners.clear();
		this.logger.info("界面订阅释放完成");
	}

	private publish(patch: Partial<GuiState>): void {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener(this.state);
	}
}
