import type { ChatMessage, ToolActivity } from "./protocol.ts";

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
				if (record.isError) tool.state = "failed";
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
						state: "succeeded",
					};
					toolsById.set(block.id, tool);
					tools.push(tool);
				}
			}
		}
		if (blocks.length || record.text)
			messages.push({
				id,
				role: "assistant",
				...(record.ts ? { timestamp: record.ts } : {}),
				blocks: blocks.length ? blocks : [{ kind: "text", text: record.text ?? "" }],
			});
	}
	return { messages, tools };
}
