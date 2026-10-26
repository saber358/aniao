import type { UIMessage } from "ai";
import { createLogger } from "../../shared/logger.ts";
import type { ChatMessage, ToolActivity } from "../../shared/protocol.ts";
import type { SubagentSnapshot } from "../../shared/subagents.ts";

export type ProcessOperation = "analyzing" | "command" | "tool";
export type ProcessStepKind = "thinking" | "command" | "edit" | "write" | "read" | "search" | "tool";

export interface ProcessStep {
	id: string;
	kind: ProcessStepKind;
	label: string;
	detail: string;
	title: string;
	state?: ToolActivity["state"];
}

export interface ProcessSummary {
	turnId: string;
	stepCount: number;
	toolCount: number;
	steps: ProcessStep[];
	reasoning: string[];
	tools: ToolActivity[];
	running: boolean;
	operation?: ProcessOperation;
	detail?: string;
	durationMs?: number;
	note?: string;
	thinking?: { preview: string; title: string };
}

export interface EditedFile {
	path: string;
	additions: number;
	deletions: number;
}

export interface EditedFilesSummary {
	files: EditedFile[];
	additions: number;
	deletions: number;
}

export interface CreatedFile {
	path: string;
	name: string;
	extension: string;
	kind: "document" | "spreadsheet" | "presentation" | "image" | "code" | "file";
}

export interface CreatedFilesSummary {
	files: CreatedFile[];
}

export interface TurnHeaderData {
	turnId: string;
	durationMs?: number;
	running?: boolean;
}

export type ChatViewMessage = UIMessage<
	{
		copyText: string;
		forkEntryId?: string;
		textTruncated?: boolean;
		imageIds?: string[];
		streaming?: boolean;
		turnId?: string;
		turnProcess?: boolean;
		thinkingDurations?: Record<string, number>;
	},
	{
		tool: ToolActivity;
		error: string;
		process: ProcessSummary;
		edits: EditedFilesSummary;
		files: CreatedFilesSummary;
		turn: TurnHeaderData;
		subagent: SubagentSnapshot;
	}
>;
interface Turn {
	userIndex?: number;
	indices: number[];
}
const logger = createLogger("chat-view");

/*
 * ========================================================================
 * 步骤1：适配第三方聊天展示类型
 * ========================================================================
 * 数据源：独立的 GUI 消息快照。
 * 操作：
 *   1) AI SDK 类型仅存在于 Renderer，不调用其运行时
 *   2) 消息身份与原始内容块顺序保持不变
 *   3) 已完成的回合把思考和工具收进一个过程摘要，运行中的回合保留过程
 */
export function toChatView(
	messages: ChatMessage[],
	tools: ToolActivity[],
	options: { running?: boolean; lastDurationMs?: number; cwd?: string; collapseTurns?: boolean } = {},
): ChatViewMessage[] {
	if (options.collapseTurns) return toCollapsedChatView(messages, tools, options);
	logger.info("开始适配聊天视图");
	// 1.1 只有字段映射；请求、队列与状态不交给 UI 组件管理。
	const toolsByMessage = new Map<string, ToolActivity[]>();
	for (const tool of tools) {
		const group = toolsByMessage.get(tool.messageId) ?? [];
		group.push(tool);
		toolsByMessage.set(tool.messageId, group);
	}
	const turns = groupTurns(messages);
	const lastTurn = turns.at(-1);
	const editTargets = new Map<number, EditedFilesSummary>();
	for (const turn of turns) {
		if (turn.userIndex === undefined) continue;
		const ids = new Set(turn.indices.map((index) => messages[index]?.id).filter((id): id is string => !!id));
		const turnTools = tools.filter((tool) => ids.has(tool.messageId));
		const running = options.running === true && turn === lastTurn;
		if (running) continue;
		const edited = collectEditedFiles(turnTools, options.cwd);
		if (edited) {
			const target = [...turn.indices].reverse().find((index) => messages[index]?.role === "assistant");
			if (target !== undefined) editTargets.set(target, edited);
		}
	}
	const view = messages
		.map((message, index): ChatViewMessage => {
			const parts: ChatViewMessage["parts"] = message.blocks.map((block) => ({
				type: block.kind === "thinking" ? "reasoning" : "text",
				text: block.text,
			}));
			// 1.3 工具与错误使用真实 data part，让没有正文的助手消息也能展示。
			for (const tool of toolsByMessage.get(message.id) ?? []) parts.push({ type: "data-tool", data: tool });
			if (message.error) parts.push({ type: "data-error", data: message.error });
			const edited = editTargets.get(index);
			if (edited) parts.push({ type: "data-edits", data: edited });
			const copyText =
				message.blocks
					.filter((block) => block.kind === "text")
					.map((block) => block.text)
					.join("\n\n") ||
				message.error ||
				"";
			return {
				id: message.id,
				role: message.role,
				parts,
				metadata: {
					copyText: message.textTruncated ? "" : copyText,
					forkEntryId: message.forkEntryId,
					textTruncated: message.textTruncated,
					imageIds: message.imageIds,
					streaming: message.streaming,
				},
			};
		})
		.filter((message) => message.parts.length > 0);
	logger.info("聊天视图适配完成");
	return view;
}

function toCollapsedChatView(
	messages: ChatMessage[],
	tools: ToolActivity[],
	options: { running?: boolean; lastDurationMs?: number; cwd?: string },
): ChatViewMessage[] {
	const toolsByMessage = new Map<string, ToolActivity[]>();
	for (const tool of tools) {
		const group = toolsByMessage.get(tool.messageId) ?? [];
		group.push(tool);
		toolsByMessage.set(tool.messageId, group);
	}
	const turns = groupTurns(messages);
	const lastTurn = turns.at(-1);
	const view: ChatViewMessage[] = [];
	for (const turn of turns) {
		if (turn.userIndex !== undefined) {
			const message = messages[turn.userIndex];
			if (message) view.push(baseMessage(message, toolsByMessage));
		}
		const assistantIndices = turn.indices.filter((index) => messages[index]?.role === "assistant");
		if (assistantIndices.length === 0) continue;
		const running = options.running === true && turn === lastTurn;
		if (running) {
			const turnId = turn.userIndex !== undefined ? messages[turn.userIndex]?.id : `turn-${assistantIndices[0]}`;
			if (turnId) {
				view.push({
					id: `turn-header-${turnId}`,
					role: "assistant",
					parts: [{ type: "data-turn", data: { turnId, running: true } }],
					metadata: { copyText: "", turnId },
				});
			}
			for (const index of assistantIndices) {
				const message = messages[index];
				if (message) view.push(baseMessage(message, toolsByMessage));
			}
			continue;
		}
		const turnId = turn.userIndex !== undefined ? messages[turn.userIndex]?.id : `turn-${assistantIndices[0]}`;
		if (!turnId) continue;
		const finalIndex = [...assistantIndices].reverse().find((index) => {
			const message = messages[index];
			return (
				!!message?.error || message?.blocks.some((block) => block.kind === "text" && block.text.trim() !== "") === true
			);
		});
		const processParts: ChatViewMessage["parts"] = [];
		const thinkingDurations: Record<string, number> = {};
		for (const index of assistantIndices) {
			const message = messages[index];
			if (!message) continue;
			for (const block of message.blocks) {
				if (block.kind === "thinking") {
					processParts.push({ type: "reasoning", text: block.text });
					if (block.durationMs !== undefined) thinkingDurations[block.text] = block.durationMs;
				} else if (block.kind === "text" && index !== finalIndex) processParts.push({ type: "text", text: block.text });
			}
			for (const tool of toolsByMessage.get(message.id) ?? []) {
				processParts.push({ type: "data-tool", data: tool });
			}
			if (message.error && index !== finalIndex) processParts.push({ type: "data-error", data: message.error });
		}
		view.push({
			id: `turn-header-${turnId}`,
			role: "assistant",
			parts: [
				{
					type: "data-turn",
					data: {
						turnId,
						...(turn === lastTurn && options.lastDurationMs ? { durationMs: options.lastDurationMs } : {}),
					},
				},
			],
			metadata: { copyText: "", turnId },
		});
		if (processParts.length > 0) {
			view.push({
				id: `turn-process-${turnId}`,
				role: "assistant",
				parts: processParts,
				metadata: { copyText: "", turnId, turnProcess: true, thinkingDurations },
			});
		}
		if (finalIndex === undefined) continue;
		const answer = messages[finalIndex];
		if (!answer) continue;
		const text = answer.blocks
			.filter((block) => block.kind === "text")
			.map((block) => block.text)
			.join("\n\n")
			.trim();
		const answerParts: ChatViewMessage["parts"] = text ? [{ type: "text", text }] : [];
		if (answer.error) answerParts.push({ type: "data-error", data: answer.error });
		const turnTools = tools.filter((tool) => assistantIndices.some((index) => messages[index]?.id === tool.messageId));
		const created = collectCreatedFiles(turnTools, options.cwd);
		if (created) answerParts.push({ type: "data-files", data: created });
		const edited = collectEditedFiles(turnTools, options.cwd);
		if (edited) answerParts.push({ type: "data-edits", data: edited });
		view.push({
			id: `turn-answer-${turnId}`,
			role: "assistant",
			parts: answerParts,
			metadata: {
				copyText: text || answer.error || "",
				turnId,
			},
		});
	}
	return view;
}

function baseMessage(message: ChatMessage, toolsByMessage: Map<string, ToolActivity[]>): ChatViewMessage {
	const parts: ChatViewMessage["parts"] = message.blocks.map((block) => ({
		type: block.kind === "thinking" ? "reasoning" : "text",
		text: block.text,
	}));
	for (const tool of toolsByMessage.get(message.id) ?? []) parts.push({ type: "data-tool", data: tool });
	if (message.error) parts.push({ type: "data-error", data: message.error });
	const thinkingDurations: Record<string, number> = {};
	for (const block of message.blocks) {
		if (block.kind === "thinking" && block.durationMs !== undefined) thinkingDurations[block.text] = block.durationMs;
	}
	const copyText =
		message.blocks
			.filter((block) => block.kind === "text")
			.map((block) => block.text)
			.join("\n\n") ||
		message.error ||
		"";
	return {
		id: message.id,
		role: message.role,
		parts,
		metadata: {
			copyText: message.textTruncated ? "" : copyText,
			forkEntryId: message.forkEntryId,
			textTruncated: message.textTruncated,
			imageIds: message.imageIds,
			streaming: message.streaming,
			thinkingDurations,
		},
	};
}

function collectCreatedFiles(tools: ToolActivity[], cwd: string | undefined): CreatedFilesSummary | undefined {
	const files = new Map<string, CreatedFile>();
	for (const tool of tools) {
		if (tool.name !== "write" || tool.state !== "succeeded") continue;
		const parsed = parseInput(tool.input);
		if (!parsed) continue;
		const path = inputPath(parsed);
		if (!path) continue;
		const display = relativeDisplayPath(path, cwd);
		const name = display.split("/").at(-1) ?? display;
		const extension = name.includes(".") ? (name.split(".").at(-1) ?? "").toUpperCase() : "";
		files.set(display, { path: display, name, extension, kind: createdFileKind(extension.toLowerCase()) });
	}
	if (files.size === 0) return undefined;
	return { files: [...files.values()] };
}

function createdFileKind(extension: string): CreatedFile["kind"] {
	if (["doc", "docx", "odt", "rtf", "pdf", "md", "txt"].includes(extension)) return "document";
	if (["xls", "xlsx", "csv", "ods"].includes(extension)) return "spreadsheet";
	if (["ppt", "pptx", "odp"].includes(extension)) return "presentation";
	if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) return "image";
	if (
		[
			"ts",
			"tsx",
			"js",
			"jsx",
			"vue",
			"css",
			"scss",
			"html",
			"json",
			"py",
			"go",
			"rs",
			"java",
			"c",
			"cpp",
			"h",
			"hpp",
			"sh",
			"yml",
			"yaml",
		].includes(extension)
	)
		return "code";
	return "file";
}

function collectEditedFiles(tools: ToolActivity[], cwd: string | undefined): EditedFilesSummary | undefined {
	const files = new Map<string, EditedFile>();
	for (const tool of tools) {
		if (tool.state !== "succeeded") continue;
		const parsed = parseInput(tool.input);
		if (!parsed) continue;
		const path = inputPath(parsed);
		if (!path) continue;
		const display = relativeDisplayPath(path, cwd);
		let additions = 0;
		let deletions = 0;
		if (tool.name === "edit") {
			if (!Array.isArray(parsed.edits)) continue;
			for (const edit of parsed.edits) {
				if (!isRecord(edit)) continue;
				const oldText = typeof edit.oldText === "string" ? edit.oldText : undefined;
				const newText = typeof edit.newText === "string" ? edit.newText : undefined;
				if (oldText === undefined || newText === undefined) continue;
				const stats = lineStats(oldText, newText);
				additions += stats.additions;
				deletions += stats.deletions;
			}
		} else if (tool.name === "write") {
			const content = typeof parsed.content === "string" ? parsed.content : "";
			additions = countLines(content);
		} else {
			continue;
		}
		if (additions === 0 && deletions === 0) continue;
		const previous = files.get(display);
		files.set(display, {
			path: display,
			additions: (previous?.additions ?? 0) + additions,
			deletions: (previous?.deletions ?? 0) + deletions,
		});
	}
	if (files.size === 0) return undefined;
	const list = [...files.values()];
	return {
		files: list,
		additions: list.reduce((total, file) => total + file.additions, 0),
		deletions: list.reduce((total, file) => total + file.deletions, 0),
	};
}

function parseInput(input: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(input);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function inputPath(parsed: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "file"]) {
		const value = parsed[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return undefined;
}

function relativeDisplayPath(path: string, cwd: string | undefined): string {
	const normalized = path.replace(/\\/g, "/");
	const root = cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
	if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
	return normalized;
}

function countLines(text: string): number {
	return text === "" ? 0 : text.replace(/\r\n/g, "\n").split("\n").length;
}

function lineStats(oldText: string, newText: string): { additions: number; deletions: number } {
	const oldLines = oldText === "" ? [] : oldText.replace(/\r\n/g, "\n").split("\n");
	const newLines = newText === "" ? [] : newText.replace(/\r\n/g, "\n").split("\n");
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
		oldEnd -= 1;
		newEnd -= 1;
	}
	const before = oldLines.slice(start, oldEnd);
	const after = newLines.slice(start, newEnd);
	if (before.length === 0 || after.length === 0) {
		return { additions: after.length, deletions: before.length };
	}
	if (before.length * after.length > 4_000_000) return { additions: after.length, deletions: before.length };
	const width = after.length + 1;
	const table = new Uint32Array((before.length + 1) * width);
	for (let left = 1; left <= before.length; left += 1) {
		for (let right = 1; right <= after.length; right += 1) {
			table[left * width + right] =
				before[left - 1] === after[right - 1]
					? table[(left - 1) * width + right - 1] + 1
					: Math.max(table[(left - 1) * width + right], table[left * width + right - 1]);
		}
	}
	let additions = 0;
	let deletions = 0;
	let left = before.length;
	let right = after.length;
	while (left > 0 || right > 0) {
		if (left === 0) {
			additions += 1;
			right -= 1;
		} else if (right === 0) {
			deletions += 1;
			left -= 1;
		} else if (before[left - 1] === after[right - 1]) {
			left -= 1;
			right -= 1;
		} else if (table[(left - 1) * width + right] >= table[left * width + right - 1]) {
			deletions += 1;
			left -= 1;
		} else {
			additions += 1;
			right -= 1;
		}
	}
	return { additions, deletions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function groupTurns(messages: ChatMessage[]): Turn[] {
	const turns: Turn[] = [{ indices: [] }];
	for (const [index, message] of messages.entries()) {
		if (message.role === "user") {
			turns.push({ userIndex: index, indices: [index] });
			continue;
		}
		turns.at(-1)?.indices.push(index);
	}
	return turns;
}
