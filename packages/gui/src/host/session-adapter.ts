import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SessionProjection } from "../domain/session-projection.ts";
import { imageDataSchema } from "../shared/image-schema.ts";
import { IMAGE_BASE64_LIMIT, IMAGE_COUNT_LIMIT } from "../shared/images.ts";
import type { AuthenticationState, DialogRequest, ExtensionState } from "../shared/interactions.ts";
import type { Logger } from "../shared/logger.ts";
import type { PlanState } from "../shared/plan.ts";
import type { ChatMessage, Configuration, SessionEvent, SessionSnapshot, ToolActivity } from "../shared/protocol.ts";
import type { QueueContent, QueueItem, QueueMode } from "../shared/queue.ts";
import { imageIdentity, validatePng } from "../storage/image-store.ts";
import { buildResources } from "./resources.ts";
import { getForkTargets } from "./session-fork.ts";

type ViewEvent = SessionEvent["event"];

/*
 * ========================================================================
 * 步骤1：将 SDK 事实转换为独立的界面协议
 * ========================================================================
 * 数据源：AgentSessionEvent 与原生会话历史。
 * 操作：
 *   1) 累计快照立即复制，避免 SDK 可变对象越过进程边界
 *   2) 只合并可替代的进度，结束事件和收束事件保持顺序
 */
export class SessionAdapter {
	private readonly logger: Logger;
	private readonly projection: SessionProjection;
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly pending = new Map<string, ViewEvent>();
	private readonly unsubscribe: () => void;
	private timer?: ReturnType<typeof setTimeout>;
	private messageCounter = 0;
	private activeMessageId = "";
	private activeAssistantMessageId = "";
	private thinkingStartedAt?: number;
	private readonly thinkingDurations = new Map<number, number>();
	private preparing = false;
	private readonly session: AgentSession;
	private disposed = false;
	private readonly deferSettlement: boolean;
	private promptActive = false;
	private readonly userMessageIds = new Map<AgentMessage, string>();
	private readonly imageSources = new Map<string, string>();
	private imageEnqueue?: { mode: QueueMode; imageIds: string[] };
	private planRequested = false;
	private planExecuting = false;

	setImageEnqueue(value?: { mode: QueueMode; imageIds: string[] }): void {
		this.imageEnqueue = value;
	}

	getImage(imageId: string): string {
		const data = this.imageSources.get(imageId);
		if (!data) throw new Error("图片已不在当前会话中，请刷新");
		return `data:image/png;base64,${data}`;
	}

	constructor(session: AgentSession, configuration: Configuration, logger: Logger, deferSettlement = false) {
		this.session = session;
		this.logger = logger;
		this.deferSettlement = deferSettlement;
		logger.info("开始订阅 SDK 会话");
		this.restoreThinkingDurations();
		const initial: SessionSnapshot = {
			version: 1,
			sessionId: session.sessionId,
			generation: randomUUID(),
			seq: 0,
			cwd: session.sessionManager.getCwd(),
			title: this.sessionTitle(),
			messages: [],
			tools: [],
			run: { phase: session.isStreaming ? "working" : "idle" },
			configuration,
			dialogs: [],
			authentication: { providers: [], flow: null },
			extensions: { notices: [], statuses: [], widgets: [], supported: [] },
			resources: buildResources(session),
			plan: { phase: "off", text: "" },
			...(session.getContextUsage() ? { contextUsage: session.getContextUsage() } : {}),
			queue: {
				steering: session.getSteeringMessages().map((text) => ({ text })),
				followUp: session.getFollowUpMessages().map((text) => ({ text })),
				recovery: { steering: [], followUp: [] },
				error: null,
			},
		};
		// 1.1 从同一活动分支恢复消息和工具，避免另存一份聊天记录。
		for (const message of session.messages) {
			const view = this.messageView(message, `message-${++this.messageCounter}`);
			if (view) initial.messages.push(view);
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall" && view)
						initial.tools.push({
							id: block.id,
							messageId: view.id,
							name: block.name,
							input: this.argumentsText(block.arguments),
							output: "",
							truncated: false,
							state: "interrupted",
						});
				}
			} else if (message.role === "toolResult") {
				const tool = initial.tools.find((item) => item.id === message.toolCallId);
				if (tool)
					Object.assign(tool, this.outputView(message.content), {
						state: message.isError ? "failed" : "succeeded",
					});
			}
		}
		this.projection = new SessionProjection(initial, logger);
		this.syncForkTargets();
		this.unsubscribe = session.subscribe((event) => this.receive(event));
		logger.info("SDK 会话订阅完成");
	}

	get snapshot(): SessionSnapshot {
		this.flush();
		return this.projection.value;
	}

	subscribe(listener: (event: SessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	updateConfiguration(configuration: Configuration): void {
		this.flush();
		this.publish({ type: "configuration", configuration });
	}
	updateDialogs(dialogs: DialogRequest[]): void {
		this.flush();
		this.publish({ type: "dialogs", dialogs });
	}
	updateAuthentication(authentication: AuthenticationState): void {
		this.flush();
		this.publish({ type: "authentication", authentication });
	}
	updateExtensions(extensions: ExtensionState): void {
		this.flush();
		this.publish({ type: "extensions", extensions });
	}

	beginPlan(): void {
		this.planRequested = true;
		this.planExecuting = false;
		this.flush();
		this.publish({ type: "plan", plan: { phase: "drafting", text: "" } });
	}

	approvePlan(text: string): void {
		this.planRequested = false;
		this.planExecuting = true;
		this.flush();
		this.publish({ type: "plan", plan: { phase: "executing", text } });
	}

	clearPlan(): void {
		this.planRequested = false;
		this.planExecuting = false;
		this.flush();
		this.publish({ type: "plan", plan: { phase: "off", text: "" } });
	}

	restorePlan(plan: PlanState): void {
		/*
		 * ========================================================================
		 * 步骤4：安装恢复或中断的计划状态
		 * ========================================================================
		 * 数据源：宿主验证的计划记录；不恢复在途执行标记。
		 * 操作：1) 清除旧运行标记；2) 发布待用户核对的状态。
		 */
		this.logger.info("开始安装恢复计划");
		try {
			// 4.1 重启和停止不能沿用上一轮执行完成判断。
			this.planRequested = false;
			this.planExecuting = false;
			this.flush();
			this.publish({ type: "plan", plan });
		} finally {
			this.logger.info("恢复计划安装结束");
		}
	}

	updateQueueRecovery(recovery: QueueContent, error: string | null = null): void {
		this.flush();
		this.publish({ type: "queue", queue: { ...this.projection.value.queue, recovery, error } });
	}

	private receive(event: AgentSessionEvent): void {
		if (this.disposed) return;
		// 1.2 先处理累计进度；关键事件前同步冲刷，保持序号连续。
		if (event.type === "message_update") {
			if (
				event.message.role === "assistant" &&
				this.thinkingStartedAt === undefined &&
				event.message.content.some((block) => block.type === "thinking" && block.thinking.trim() !== "")
			) {
				this.thinkingStartedAt = Date.now();
			}
			const message = this.messageView(
				event.message,
				this.activeMessageId,
				event.message.role === "assistant" &&
					event.message.content.some((block) => block.type === "text" && block.text.trim() !== ""),
			);
			if (message) this.queue(`message:${message.id}`, { type: "message", message });
			return;
		}
		if (event.type === "tool_execution_update") {
			const tool = this.projection.value.tools.find((item) => item.id === event.toolCallId);
			if (tool)
				this.queue(`tool:${tool.id}`, {
					type: "tool",
					tool: { ...tool, ...this.outputView(event.partialResult.content) },
				});
			return;
		}
		this.flush();
		switch (event.type) {
			case "queue_update":
				this.publish({
					type: "queue",
					queue: {
						...this.projection.value.queue,
						steering: this.projectQueue(event.steering, this.projection.value.queue.steering, "steer"),
						followUp: this.projectQueue(event.followUp, this.projection.value.queue.followUp, "followUp"),
					},
				});
				break;
			case "message_start": {
				this.activeMessageId = `message-${++this.messageCounter}`;
				if (event.message.role === "assistant") {
					this.activeAssistantMessageId = this.activeMessageId;
					this.thinkingStartedAt = undefined;
				}
				const message = this.messageView(event.message, this.activeMessageId);
				if (message) this.publish({ type: "message", message });
				if (event.message.role === "user") this.publish({ type: "title", title: this.sessionTitle(event.message) });
				break;
			}
			case "message_end": {
				if (event.message.role === "assistant" && this.thinkingStartedAt !== undefined) {
					const durationMs = Date.now() - this.thinkingStartedAt;
					const timestamp = event.message.timestamp;
					this.thinkingStartedAt = undefined;
					if (!this.thinkingDurations.has(timestamp)) {
						this.thinkingDurations.set(timestamp, durationMs);
						try {
							this.session.sessionManager.appendCustomEntry("gui-thinking-duration", {
								timestamp,
								durationMs,
							});
						} catch {
							this.logger.info("思考时长持久化失败");
						}
					}
				}
				const message = this.messageView(event.message, this.activeMessageId);
				if (message) this.publish({ type: "message", message });
				break;
			}
			case "tool_execution_start":
				this.publish({
					type: "tool",
					tool: {
						id: event.toolCallId,
						messageId: this.activeAssistantMessageId,
						name: event.toolName,
						input: this.argumentsText(event.args),
						output: "",
						truncated: false,
						state: "running",
					},
				});
				break;
			case "tool_execution_end": {
				const tool = this.projection.value.tools.find((item) => item.id === event.toolCallId);
				if (tool)
					this.publish({
						type: "tool",
						tool: {
							...tool,
							...this.outputView(event.result.content),
							state: event.isError ? "failed" : "succeeded",
						},
					});
				break;
			}
			case "agent_start":
				this.preparing = false;
				this.publish({ type: "run", run: { phase: "working" } });
				break;
			case "compaction_start":
				if (!this.preparing) this.publish({ type: "run", run: { phase: "compacting" } });
				break;
			case "auto_retry_start":
				this.publish({
					type: "run",
					run: { phase: "retrying", detail: `重试 ${event.attempt}/${event.maxAttempts}` },
				});
				break;
			case "compaction_end":
			case "auto_retry_end":
				if (!this.preparing) this.publish({ type: "run", run: { phase: "working" } });
				break;
			case "agent_settled": {
				if (!this.deferSettlement) this.syncForkTargets();
				const final = [...this.session.messages].reverse().find((item) => item.role === "assistant");
				const failed =
					final?.role === "assistant" &&
					(final.errorMessage || final.stopReason === "error" || final.stopReason === "aborted");
				if ((this.planRequested || this.planExecuting) && failed) {
					this.restorePlan({
						phase: "interrupted",
						text: this.projection.value.plan?.text || this.lastAssistantText(),
						reason: "任务失败或已取消，请核对结果后再处理计划",
					});
				}
				if (this.planRequested) {
					this.planRequested = false;
					this.publish({ type: "plan", plan: { phase: "awaiting", text: this.lastAssistantText() } });
				} else if (this.planExecuting) {
					this.planExecuting = false;
					this.publish({
						type: "plan",
						plan: { phase: "completed", text: this.projection.value.plan?.text ?? "" },
					});
				}
				const contextUsage = this.session.getContextUsage();
				if (contextUsage) this.publish({ type: "contextUsage", contextUsage });
				this.publish({ type: "run", run: { phase: this.deferSettlement && this.promptActive ? "settling" : "idle" } });
				break;
			}
			case "session_info_changed":
				this.publish({ type: "title", title: this.sessionTitle() });
				break;
		}
	}

	private sessionTitle(incoming?: AgentMessage): string {
		const name = this.session.sessionManager.getSessionName();
		if (name) return name.slice(0, 200);
		const user = this.session.messages.find((message) => message.role === "user") ?? incoming;
		if (!user || user.role !== "user") return "新对话";
		const text =
			typeof user.content === "string"
				? user.content
				: user.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join(" ");
		return text.replace(/[\r\n]+/g, " ").slice(0, 200) || "新对话";
	}

	private lastAssistantText(): string {
		const message = [...this.session.messages].reverse().find((item) => item.role === "assistant");
		if (!message || message.role !== "assistant") return "";
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		return text.slice(0, 200_000);
	}

	/*
	 * ========================================================================
	 * 步骤3：保留 SDK 队列条目的图片身份
	 * ========================================================================
	 * 数据源：SDK 顺序队列和图片专用 steer / followUp 同步入队区间。
	 * 操作：
	 *   1) 消费从队首撤下条目，追加只补新条目，不按重复正文匹配
	 *   2) 图片只关联本次同步追加，不把 base64 放入快照
	 */
	private projectQueue(texts: readonly string[], previous: QueueItem[], mode: QueueMode): QueueItem[] {
		this.logger.info("开始同步队列图片身份");
		try {
			// 3.1 SDK 两类队列各自保持 FIFO；同步追加区间不运行扩展输入回调。
			const retained = previous.slice(Math.max(0, previous.length - texts.length));
			return texts.map((text, index) => ({
				text,
				...(retained[index]?.imageIds ? { imageIds: retained[index].imageIds } : {}),
				...(this.imageEnqueue?.mode === mode && index === texts.length - 1 && texts.length > previous.length
					? { imageIds: this.imageEnqueue.imageIds }
					: {}),
			}));
		} finally {
			this.logger.info("队列图片身份同步结束");
		}
	}

	beginPrompt(): void {
		this.logger.info("开始准备任务");
		this.promptActive = true;
		this.preparing = true;
		this.flush();
		this.publish({ type: "run", run: { phase: "preparing" } });
		this.logger.info("任务准备状态已发布");
	}

	endPrompt(): void {
		this.logger.info("开始清理任务准备状态");
		this.promptActive = false;
		// 1.3 preflight 失败不会产生 agent_settled；等待子 Agent 后 phase 也不是 settling。
		// 只要还没有回到 idle，就必须在这里收束，否则前端会永久停在 settling/waiting。
		if (this.preparing || this.deferSettlement || this.projection.value.run.phase !== "idle") {
			this.preparing = false;
			this.flush();
			this.syncForkTargets();
			this.publish({ type: "run", run: { phase: "idle" } });
		}
		this.logger.info("任务准备状态清理完成");
	}

	markStopping(): void {
		this.flush();
		this.publish({ type: "run", run: { phase: "stopping" } });
	}

	markWaiting(detail = "等待子智能体完成"): void {
		this.publish({ type: "run", run: { phase: "waiting", detail } });
	}

	private restoreThinkingDurations(): void {
		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "gui-thinking-duration") continue;
			const data = entry.data;
			if (typeof data !== "object" || data === null) continue;
			const timestamp = (data as { timestamp?: unknown }).timestamp;
			const durationMs = (data as { durationMs?: unknown }).durationMs;
			if (typeof timestamp === "number" && typeof durationMs === "number" && durationMs >= 0) {
				this.thinkingDurations.set(timestamp, durationMs);
			}
		}
	}

	private messageView(message: AgentMessage, id: string, streaming = false): ChatMessage | null {
		if (message.role !== "user" && message.role !== "assistant") return null;
		if (message.role === "user") this.userMessageIds.set(message, id);
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const blocks: ChatMessage["blocks"] = [];
		const imageIds: string[] = [];
		for (const block of content) {
			if (block.type === "text") blocks.push({ kind: "text", text: block.text.slice(0, 2_000_000) });
			else if (block.type === "thinking")
				blocks.push({
					kind: "thinking",
					text: block.thinking.slice(0, 2_000_000),
					...(this.thinkingDurations.has(message.timestamp)
						? { durationMs: this.thinkingDurations.get(message.timestamp) }
						: {}),
				});
			else if (block.type === "image") {
				// 1.5 图片负载按需读取，不随每条消息快照传输；旧会话不支持的格式明确占位。
				try {
					if (
						block.mimeType !== "image/png" ||
						block.data.length > IMAGE_BASE64_LIMIT ||
						imageIds.length >= IMAGE_COUNT_LIMIT
					)
						throw new Error("unsupported image");
					if (!imageDataSchema.safeParse(block.data).success) throw new Error("invalid image data");
					validatePng(Buffer.from(block.data, "base64"), this.logger);
					const imageId = imageIdentity(block.data);
					this.imageSources.set(imageId, block.data);
					if (!imageIds.includes(imageId)) imageIds.push(imageId);
				} catch {
					blocks.push({ kind: "text", text: "[图片附件暂不支持预览]" });
				}
			}
		}
		return {
			id,
			timestamp: message.timestamp,
			role: message.role,
			...(streaming ? { streaming: true } : {}),
			blocks,
			...(imageIds.length ? { imageIds } : {}),
			// 1.4 展示截断必须可见；复制不能把快照片段当成完整正文。
			...(content.some((block) => block.type === "text" && block.text.length > 2_000_000)
				? { textTruncated: true }
				: {}),
			...(message.role === "assistant" && message.errorMessage ? { error: message.errorMessage.slice(0, 8192) } : {}),
		};
	}

	/*
	 * ========================================================================
	 * 步骤2：在 SDK 消息落入分支后补充分支入口
	 * ========================================================================
	 * 数据源：message_end 保存的对象身份与已落盘的原生分支。
	 * 操作：
	 *   1) message_end 早于 SDK appendMessage，等待任务收束再关联
	 *   2) 只更新变化的消息；显示 ID 与原生 entry ID 分开保存
	 */
	private syncForkTargets(): void {
		this.logger.info("开始同步消息分支入口");
		try {
			// 2.1 重复正文仍由各自的原生对象定位，不能互相覆盖。
			const targets = getForkTargets(this.session, this.logger);
			const ids = new Map([...this.userMessageIds].map(([message, id]) => [id, targets.get(message)?.entryId]));
			for (const message of this.projection.value.messages) {
				const entryId = ids.get(message.id);
				if (message.role === "user" && message.forkEntryId !== entryId)
					this.publish({ type: "message", message: { ...message, forkEntryId: entryId } });
			}
		} finally {
			this.logger.info("消息分支入口同步结束");
		}
	}

	private outputView(content: Array<{ type: string; text?: string }>): Pick<ToolActivity, "output" | "truncated"> {
		const text = content.map((block) => (block.type === "text" ? (block.text ?? "") : "[非文本结果]")).join("\n");
		return { output: text.slice(-262144), truncated: text.length > 262144 };
	}

	private argumentsText(value: unknown): string {
		try {
			return (JSON.stringify(value, null, 2) ?? "").slice(0, 65536);
		} catch {
			return "[参数无法序列化]";
		}
	}

	private queue(key: string, event: ViewEvent): void {
		this.pending.set(key, event);
		if (this.pending.size >= 128) this.flush();
		else this.timer ??= setTimeout(() => this.flush(), 32);
	}

	private flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const events = [...this.pending.values()];
		this.pending.clear();
		for (const event of events) this.publish(event);
	}

	private publish(event: ViewEvent): void {
		if (this.disposed) return;
		const snapshot = this.projection.value;
		const envelope: SessionEvent = {
			sessionId: snapshot.sessionId,
			generation: snapshot.generation,
			seq: snapshot.seq + 1,
			event,
		};
		this.projection.apply(envelope);
		for (const listener of this.listeners) listener(envelope);
	}

	dispose(): void {
		this.logger.info("开始释放 SDK 会话适配器");
		// 1.3 结束订阅和进度计时器；SDK 的生命周期由宿主持有。
		this.disposed = true;
		this.unsubscribe();
		clearTimeout(this.timer);
		this.pending.clear();
		this.listeners.clear();
		this.userMessageIds.clear();
		this.imageSources.clear();
		this.logger.info("SDK 会话适配器释放完成");
	}
}
