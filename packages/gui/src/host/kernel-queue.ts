import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expandPromptTemplate } from "@harness/pi-kernel/prompt-templates";
import type { Logger } from "../shared/logger.ts";

type UserMessage = Extract<AgentMessage, { role: "user" }>;
interface PendingQueue {
	messages: AgentMessage[];
}
interface QueueInternals {
	_steeringMessages: string[];
	_followUpMessages: string[];
	_emitQueueUpdate(): void;
	_throwIfExtensionCommand(text: string): void;
	_tryExecuteExtensionCommand(text: string): Promise<boolean>;
	_runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: "interactive",
		behavior: "steer" | "followUp",
	): Promise<{ text: string; images?: ImageContent[] } | undefined>;
	_expandSkillCommand(text: string): string;
}

/*
 * ========================================================================
 * 步骤1：核对固定 Pi 1.4.0 的待消费队列
 * ========================================================================
 * 数据源：SDK 展示队列与 Agent 实际待消费对象。
 * 操作：
 *   1) 内部访问集中在此边界，结构不匹配时拒绝修改
 *   2) 展示队列可能含在途前缀，只允许修改仍在核心队列的对象
 */
function inspectQueue(session: AgentSession, mode: "steering" | "followUp", logger: Logger) {
	logger.info("开始核对内核待消费队列");
	try {
		// 1.1 校验结构后才进入版本相关接口，保留扩展自定义消息。
		const internals = session as unknown as QueueInternals;
		const pending: unknown = Reflect.get(session.agent, `${mode}Queue`);
		const texts = mode === "steering" ? internals._steeringMessages : internals._followUpMessages;
		if (
			!pending ||
			typeof pending !== "object" ||
			!Array.isArray(Reflect.get(pending, "messages")) ||
			!Array.isArray(texts) ||
			!texts.every((text) => typeof text === "string") ||
			typeof internals._emitQueueUpdate !== "function"
		)
			throw new Error("Pi 队列结构已变化，请检查内核适配");
		const queue = pending as PendingQueue;
		const users = queue.messages.filter((message): message is UserMessage => message.role === "user");
		const offset = texts.length - users.length;
		if (offset < 0 || users.some((message, index) => messageText(message) !== texts[offset + index]))
			throw new Error("队列正在交接，请稍后重试");
		return { internals, queue, texts, users, offset };
	} finally {
		logger.info("内核待消费队列核对结束");
	}
}

function messageText(message: UserMessage): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
}

export function captureQueuedMessage(session: AgentSession, index: number, logger: Logger): UserMessage {
	const state = inspectQueue(session, "followUp", logger);
	const message = state.users[index - state.offset];
	if (!message) throw new Error("排队消息已开始处理，请核对聊天记录");
	return message;
}

/*
 * ========================================================================
 * 步骤2：准备单条输入，不重跑其余队列
 * ========================================================================
 * 数据源：用户正文、附件与同版 SDK 输入处理器。
 * 操作：1) 编辑时拒绝即时命令；2) 保留输入钩子、技能和模板展开。
 */
export async function prepareQueuedInput(
	session: AgentSession,
	text: string,
	mode: "steer" | "followUp",
	logger: Logger,
	options: { images?: ImageContent[]; allowImmediateCommand?: boolean } = {},
): Promise<UserMessage | undefined> {
	logger.info("开始准备单条排队输入");
	try {
		// 2.1 准备阶段不修改任何队列，处理失败时原条目完整保留。
		const { internals } = inspectQueue(session, "followUp", logger);
		if (
			[internals._throwIfExtensionCommand, internals._runInputHandlers, internals._expandSkillCommand].some(
				(method) => typeof method !== "function",
			)
		)
			throw new Error("Pi 输入接口已变化，请检查内核适配");
		if (text.startsWith("/") && options.allowImmediateCommand) {
			if (typeof internals._tryExecuteExtensionCommand !== "function")
				throw new Error("Pi 命令接口已变化，请检查内核适配");
			if (await internals._tryExecuteExtensionCommand(text)) return undefined;
		}
		if (text.startsWith("/")) internals._throwIfExtensionCommand(text);
		const input = await internals._runInputHandlers(text, options.images, "interactive", mode);
		if (!input) return undefined;
		const expanded = expandPromptTemplate(internals._expandSkillCommand(input.text), [...session.promptTemplates]);
		if (!expanded.trim() || expanded.length > 1_000_000) throw new Error("展开后的排队消息为空或超过长度上限");
		return {
			role: "user",
			timestamp: Date.now(),
			content: [{ type: "text", text: expanded }, ...(input.images ?? [])],
		};
	} finally {
		logger.info("单条排队输入准备结束");
	}
}

/*
 * ========================================================================
 * 步骤4：同步追加已经准备并保存的输入
 * ========================================================================
 * 数据源：宿主完成状态复核后的用户消息。
 * 操作：1) 此处不等待扩展，也不启动新任务；2) 投影安装后再通知订阅者。
 */
export function commitQueuedInput(
	session: AgentSession,
	message: UserMessage,
	mode: "steer" | "followUp",
	logger: Logger,
): () => void {
	logger.info("开始提交单条排队输入");
	try {
		// 4.1 复用核心同步队列入口，禁止迟到输入转成新的 prompt。
		const state = inspectQueue(session, mode === "steer" ? "steering" : "followUp", logger);
		if (mode === "steer") session.agent.steer(message);
		else session.agent.followUp(message);
		state.texts.push(messageText(message));
		return () => state.internals._emitQueueUpdate();
	} finally {
		logger.info("单条排队输入提交结束");
	}
}

/*
 * ========================================================================
 * 步骤3：同步提交单条变更，绝不重建整个活队列
 * ========================================================================
 * 数据源：准备前捕获的原生对象身份。
 * 操作：
 *   1) 写前保存结束后重验目标仍待消费，检查与修改之间不等待
 *   2) 保留其他消息、附件和顺序，展示映射安装后再通知 SDK 订阅者
 */
export function commitQueuedChange(
	session: AgentSession,
	original: UserMessage,
	action: "remove" | "edit" | "steer",
	logger: Logger,
	edited?: UserMessage,
): () => void {
	logger.info("开始提交单条队列变更");
	try {
		// 3.1 已被 drain 的对象即使仍显示在 SDK 字符串数组，也不能再次入队。
		const source = inspectQueue(session, "followUp", logger);
		const userIndex = source.users.indexOf(original);
		if (userIndex < 0) throw new Error("排队消息已开始处理，请核对聊天记录");
		const coreIndex = source.queue.messages.indexOf(original);
		const displayIndex = source.offset + userIndex;
		const steering = action === "steer" ? inspectQueue(session, "steering", logger) : undefined;
		if (action === "edit") {
			if (!edited) throw new Error("编辑内容尚未准备");
			source.queue.messages.splice(coreIndex, 1, edited);
			source.texts.splice(displayIndex, 1, messageText(edited));
		} else {
			source.queue.messages.splice(coreIndex, 1);
			source.texts.splice(displayIndex, 1);
			if (steering) {
				steering.queue.messages.push(original);
				steering.texts.push(messageText(original));
			}
		}
		return () => source.internals._emitQueueUpdate();
	} finally {
		logger.info("单条队列变更提交结束");
	}
}
