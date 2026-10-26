import { describe, expect, it } from "vitest";
import { toChatView } from "../src/renderer/adapters/chat-view.ts";

/*
 * ========================================================================
 * 步骤1：验证没有正文的消息仍有真实展示内容
 * ========================================================================
 * 数据源：仅含工具调用或失败结果的助手消息。
 * 操作：
 *   1) 工具数据归到所属消息，不追加占位正文
 *   2) 错误与工具状态保留原始语义
 */
describe("chat view adapter", () => {
	it("keeps tool-only and error-only assistant messages visible to the UI library", () => {
		const tool = {
			id: "tool-1",
			messageId: "assistant-1",
			name: "read",
			input: "{}",
			output: "",
			truncated: false,
			state: "interrupted" as const,
		};
		const messages = toChatView(
			[
				{ id: "assistant-1", role: "assistant", blocks: [] },
				{ id: "assistant-2", role: "assistant", blocks: [], error: "Model rejected" },
			],
			[tool],
		);
		expect(messages[0].parts).toEqual([{ type: "data-tool", data: tool }]);
		expect(messages[1].parts).toEqual([{ type: "data-error", data: "Model rejected" }]);
		expect(messages[0].metadata?.copyText).toBe("");
		expect(messages[1].metadata?.copyText).toBe("Model rejected");
	});

	it("copies the original Markdown and whitespace without reasoning or tool output", () => {
		const raw = "中文 **正文**\n\n```ts\n\tconst ready = true;\n```\n";
		const messages = toChatView(
			[
				{
					id: "a",
					role: "assistant",
					blocks: [
						{ kind: "thinking", text: "不属于正文的推理" },
						{ kind: "text", text: raw },
					],
				},
				{ id: "u", role: "user", blocks: [{ kind: "text", text: "  中文\n保留空白  " }] },
			],
			[],
		);
		expect(messages[0].metadata?.copyText).toBe(raw);
		expect(messages[1].metadata?.copyText).toBe("  中文\n保留空白  ");
	});

	it("does not offer a truncated snapshot as a complete message", () => {
		const [message] = toChatView(
			[{ id: "a", role: "assistant", blocks: [{ kind: "text", text: "仅是正文片段" }], textTruncated: true }],
			[],
		);
		expect(message.metadata?.copyText).toBe("");
		expect(message.metadata?.textTruncated).toBe(true);
		expect(message.parts).toEqual([{ type: "text", text: "仅是正文片段" }]);
	});

	it("keeps completed reasoning, text and tools in message order", () => {
		const read = {
			id: "tool-1",
			messageId: "assistant-1",
			name: "read",
			input: "{}",
			output: "",
			truncated: false,
			state: "succeeded" as const,
		};
		const edit = {
			id: "tool-2",
			messageId: "assistant-2",
			name: "edit",
			input: "{}",
			output: "",
			truncated: false,
			state: "succeeded" as const,
		};
		const messages = toChatView(
			[
				{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "做个任务" }] },
				{
					id: "assistant-1",
					role: "assistant",
					blocks: [
						{ kind: "thinking", text: "先想一下" },
						{ kind: "text", text: "先读取文件" },
					],
				},
				{
					id: "assistant-2",
					role: "assistant",
					blocks: [
						{ kind: "thinking", text: "继续处理" },
						{ kind: "text", text: "读完了，现在修改" },
					],
				},
				{ id: "assistant-3", role: "assistant", blocks: [{ kind: "text", text: "已经完成" }] },
			],
			[read, edit],
		);
		expect(messages[1]?.parts.map((part) => part.type)).toEqual(["reasoning", "text", "data-tool"]);
		expect(messages[1]?.parts[1]).toEqual({ type: "text", text: "先读取文件" });
		expect(messages[2]?.parts.map((part) => part.type)).toEqual(["reasoning", "text", "data-tool"]);
		expect(messages[2]?.parts[1]).toEqual({ type: "text", text: "读完了，现在修改" });
		expect(messages[3]?.parts).toEqual([{ type: "text", text: "已经完成" }]);
	});

	it("keeps running reasoning, text and tools inline", () => {
		const tool = {
			id: "tool-1",
			messageId: "assistant-1",
			name: "bash",
			input: JSON.stringify({ command: "Check header chip removal" }),
			output: "",
			truncated: false,
			state: "running" as const,
		};
		const messages = toChatView(
			[
				{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "做个任务" }] },
				{
					id: "assistant-1",
					role: "assistant",
					blocks: [
						{ kind: "thinking", text: "先想一下" },
						{ kind: "text", text: "处理中" },
					],
				},
			],
			[tool],
			{ running: true },
		);
		expect(messages[1]?.parts.map((part) => part.type)).toEqual(["reasoning", "text", "data-tool"]);
		expect(messages[1]?.parts[2]).toMatchObject({
			type: "data-tool",
			data: { state: "running", name: "bash" },
		});
	});

	it("keeps the latest running reasoning inline", () => {
		const render = (thinking: string) =>
			toChatView(
				[
					{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "分析一下" }] },
					{ id: "assistant-1", role: "assistant", blocks: [{ kind: "thinking", text: thinking }] },
				],
				[],
				{ running: true },
			)[1]?.parts[0];

		expect(render("第一段\n第二段")).toEqual({ type: "reasoning", text: "第一段\n第二段" });
		expect(render("更新后的思考")).toEqual({ type: "reasoning", text: "更新后的思考" });
	});

	it("does not synthesize a process row before the first assistant chunk", () => {
		const messages = toChatView([{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "开始分析" }] }], [], {
			running: true,
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
	});

	it("keeps running assistant text without a process row", () => {
		const messages = toChatView(
			[
				{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "开始分析" }] },
				{ id: "assistant-1", role: "assistant", blocks: [{ kind: "text", text: "最终回答" }] },
			],
			[],
			{ running: true },
		);
		expect(messages[1]?.parts).toEqual([{ type: "text", text: "最终回答" }]);
	});

	it("groups completed turns behind a collapsible work header", () => {
		const tool = {
			id: "tool-1",
			messageId: "assistant-1",
			name: "read",
			input: "{}",
			output: "",
			truncated: false,
			state: "succeeded" as const,
		};
		const messages = toChatView(
			[
				{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "做个任务" }] },
				{
					id: "assistant-1",
					role: "assistant",
					blocks: [
						{ kind: "thinking", text: "先想一下" },
						{ kind: "text", text: "先读取文件" },
					],
				},
				{ id: "assistant-2", role: "assistant", blocks: [{ kind: "text", text: "已经完成" }] },
			],
			[tool],
			{ collapseTurns: true, lastDurationMs: 18_000 },
		);
		expect(messages[1]?.parts).toEqual([{ type: "data-turn", data: { turnId: "user-1", durationMs: 18_000 } }]);
		expect(messages[1]?.metadata).toMatchObject({ turnId: "user-1" });
		expect(messages[2]?.metadata).toMatchObject({ turnId: "user-1", turnProcess: true });
		expect(messages[2]?.parts.map((part) => part.type)).toEqual(["reasoning", "text", "data-tool"]);
		expect(messages[3]?.parts).toEqual([{ type: "text", text: "已经完成" }]);
		expect(messages[3]?.metadata?.copyText).toBe("已经完成");
	});

	it("keeps a running turn inline without a completed work header", () => {
		const messages = toChatView(
			[
				{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "做个任务" }] },
				{ id: "assistant-1", role: "assistant", blocks: [{ kind: "text", text: "处理中" }] },
			],
			[],
			{ collapseTurns: true, running: true },
		);
		expect(messages).toHaveLength(3);
		expect(messages[1]?.parts).toEqual([{ type: "data-turn", data: { turnId: "user-1", running: true } }]);
		expect(messages[2]?.parts).toEqual([{ type: "text", text: "处理中" }]);
	});

	it("summarizes edited files after a completed turn", () => {
		const edit = {
			id: "tool-edit",
			messageId: "assistant-1",
			name: "edit",
			input: JSON.stringify({
				path: "C:\\repo\\packages\\gui\\src\\app.ts",
				edits: [
					{ oldText: "a\nb\nc\nd", newText: "a" },
					{ oldText: "x\ny", newText: "x\nz" },
				],
			}),
			output: "ok",
			truncated: false,
			state: "succeeded" as const,
		};
		const write = {
			id: "tool-write",
			messageId: "assistant-1",
			name: "write",
			input: JSON.stringify({ path: "C:\\repo\\README.md", content: "one\ntwo" }),
			output: "ok",
			truncated: false,
			state: "succeeded" as const,
		};
		const messages = toChatView(
			[
				{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "改文件" }] },
				{ id: "assistant-1", role: "assistant", blocks: [{ kind: "text", text: "完成" }] },
			],
			[edit, write],
			{ cwd: "C:\\repo" },
		);
		expect(messages[1]?.parts.at(-1)).toEqual({
			type: "data-edits",
			data: {
				files: [
					{ path: "packages/gui/src/app.ts", additions: 1, deletions: 4 },
					{ path: "README.md", additions: 2, deletions: 0 },
				],
				additions: 3,
				deletions: 4,
			},
		});
	});

	it("does not show edited files while the turn is still running", () => {
		const edit = {
			id: "tool-edit",
			messageId: "assistant-1",
			name: "edit",
			input: JSON.stringify({ path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }),
			output: "",
			truncated: false,
			state: "succeeded" as const,
		};
		const messages = toChatView(
			[
				{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "改文件" }] },
				{ id: "assistant-1", role: "assistant", blocks: [{ kind: "text", text: "处理中" }] },
			],
			[edit],
			{ running: true },
		);
		expect(messages[1]?.parts.some((part) => part.type === "data-edits")).toBe(false);
	});
});
