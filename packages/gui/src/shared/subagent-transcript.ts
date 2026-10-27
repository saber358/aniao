import { createLogger } from "./logger.ts";
import type { ChatMessage, ToolActivity } from "./protocol.ts";
import type { SubagentInspection } from "./subagents.ts";

const logger = createLogger("subagent-transcript");

/*
 * ========================================================================
 * 步骤1：把官方详情窗口还原为聊天和工具记录
 * ========================================================================
 * 数据源：插件已校验的 messages、task 与 finalOutput。
 * 操作：1) 缺少完整转录时仍展示可归属的详情；2) 工具结果按顺序和名称关联。
 */
export function parseSubagentInspection(source: SubagentInspection): {
	messages: ChatMessage[];
	tools: ToolActivity[];
} {
	logger.info("开始解析子智能体官方详情");
	try {
		// 1.1 保留插件消息顺序，不伪造思考过程或执行工具。
		const messages: ChatMessage[] = [];
		const tools: ToolActivity[] = [];
		let assistantId: string | undefined;
		for (const [index, message] of (source.messages ?? []).entries()) {
			if (message.kind === "text" && (message.role === "user" || message.role === "assistant")) {
				const id = `inspection-${index}`;
				messages.push({ id, role: message.role, blocks: [{ kind: "text", text: message.text }] });
				assistantId = message.role === "assistant" ? id : undefined;
			} else if (message.kind === "toolCall" || message.kind === "toolResult" || message.role === "toolResult") {
				if (!assistantId) {
					assistantId = `inspection-assistant-${index}`;
					messages.push({ id: assistantId, role: "assistant", blocks: [] });
				}
				const name = message.name ?? "tool";
				const isResult = message.kind === "toolResult" || message.role === "toolResult";
				const pending = isResult
					? [...tools].reverse().find((tool) => (!message.name || tool.name === name) && tool.state === "running")
					: undefined;
				if (pending) {
					pending.output = message.text;
					pending.state = message.isError ? "failed" : "succeeded";
				} else
					tools.push({
						id: `inspection-tool-${index}`,
						messageId: assistantId,
						name,
						input: message.kind === "toolCall" ? message.text : "",
						output: isResult ? message.text : "",
						truncated: false,
						state: message.kind === "toolCall" ? "running" : message.isError ? "failed" : "succeeded",
					});
			}
		}
		// 1.2 任务和最终结果只补缺，避免与消息窗口重复。
		if (
			source.task &&
			!messages.some((message) => message.role === "user" && message.blocks.some((block) => block.text === source.task))
		)
			messages.unshift({ id: "inspection-task", role: "user", blocks: [{ kind: "text", text: source.task }] });
		if (
			source.finalOutput &&
			!messages.some(
				(message) =>
					message.role === "assistant" &&
					message.blocks.some((block) => block.kind === "text" && block.text === source.finalOutput),
			)
		)
			messages.push({
				id: "inspection-output",
				role: "assistant",
				blocks: [{ kind: "text", text: source.finalOutput }],
			});
		if (source.status && source.status !== "queued" && source.status !== "running")
			for (const tool of tools) if (tool.state === "running") tool.state = "interrupted";
		return { messages, tools };
	} finally {
		logger.info("子智能体官方详情解析结束");
	}
}

interface TranscriptRecord {
	recordType?: string;
	role?: string;
	ts?: number;
	message?: {
		role?: string;
		content?: Array<{
			type?: string;
			text?: string;
			thinking?: string;
			id?: string;
			name?: string;
			arguments?: unknown;
			toolCallId?: string;
			isError?: boolean;
		}>;
	};
	text?: string;
	toolCallId?: string;
	toolName?: string;
	argsPayload?: string;
	isError?: boolean;
}

/*
 * 只还原展示所需的消息与工具，不执行转录中的任何指令。
 * 子智能体转录是普通 JSONL，损坏行直接跳过。
 */
export function parseSubagentTranscript(source: string): { messages: ChatMessage[]; tools: ToolActivity[] } {
	const messages: ChatMessage[] = [];
	const tools: ToolActivity[] = [];
	const toolsById = new Map<string, ToolActivity>();
	let currentAssistant: string | undefined;
	for (const [index, line] of source.split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		let record: TranscriptRecord;
		try {
			record = JSON.parse(line) as TranscriptRecord;
		} catch {
			continue;
		}
		if (record.recordType === "tool_start") {
			const id = record.toolCallId ?? `tool-${index}`;
			if (!toolsById.has(id)) {
				const tool: ToolActivity = {
					id,
					messageId: currentAssistant ?? "transcript",
					name: record.toolName || "tool",
					input: record.argsPayload?.slice(0, 65_536) ?? "",
					output: "",
					truncated: false,
					state: "running",
				};
				toolsById.set(id, tool);
				tools.push(tool);
			}
			continue;
		}
		if (record.recordType === "tool_end") {
			const tool = record.toolCallId ? toolsById.get(record.toolCallId) : undefined;
			if (tool) tool.state = record.isError ? "failed" : "succeeded";
			continue;
		}
		if (record.recordType !== "message") continue;
		if (record.role === "user" && record.text) {
			messages.push({
				id: `user-${index}`,
				role: "user",
				...(record.ts ? { timestamp: record.ts } : {}),
				blocks: [{ kind: "text", text: record.text }],
			});
			continue;
		}
		if (record.role === "toolResult") {
			const tool = record.toolCallId ? toolsById.get(record.toolCallId) : undefined;
			if (tool) {
				tool.output = record.text?.slice(0, 262_144) ?? "";
				tool.state = record.isError ? "failed" : "succeeded";
			}
			continue;
		}
		if (record.role !== "assistant" || !record.message?.content) continue;
		const id = `assistant-${index}`;
		currentAssistant = id;
		const blocks: ChatMessage["blocks"] = [];
		for (const block of record.message.content) {
			if (block.type === "text" && block.text) blocks.push({ kind: "text", text: block.text });
			else if (block.type === "thinking" && block.thinking) blocks.push({ kind: "thinking", text: block.thinking });
			else if (block.type === "toolCall" && block.id) {
				if (!toolsById.has(block.id)) {
					const tool: ToolActivity = {
						id: block.id,
						messageId: id,
						name: block.name ?? "tool",
						input: JSON.stringify(block.arguments ?? {}, null, 2).slice(0, 65_536),
						output: "",
						truncated: false,
						state: "running",
					};
					toolsById.set(block.id, tool);
					tools.push(tool);
				}
			}
		}
		if (blocks.length || record.text || record.message.content.some((block) => block.type === "toolCall"))
			messages.push({
				id,
				role: "assistant",
				...(record.ts ? { timestamp: record.ts } : {}),
				blocks: blocks.length ? blocks : [{ kind: "text", text: record.text ?? "" }],
			});
	}
	return { messages, tools };
}
