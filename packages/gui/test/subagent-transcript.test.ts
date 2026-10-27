import { describe, expect, it } from "vitest";
import { parseSubagentInspection, parseSubagentTranscript } from "../src/shared/subagent-transcript.ts";

describe("parseSubagentTranscript", () => {
	it("keeps tool-only assistant messages visible and waits for actual tool completion", () => {
		const logger = console;
		logger.info("开始验证工具专用消息状态");
		try {
			// 2.2 工具调用声明不是执行成功，只有结束记录才能进入成功态。
			const message = JSON.stringify({
				recordType: "message",
				role: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "only-tool", name: "read", arguments: { path: "a.ts" } }],
				},
			});
			const running = parseSubagentTranscript(message);
			expect(running.messages).toHaveLength(1);
			expect(running.tools[0]).toMatchObject({ messageId: running.messages[0].id, state: "running" });
			const finished = parseSubagentTranscript(
				`${message}\n${JSON.stringify({ recordType: "tool_end", toolCallId: "only-tool", isError: false })}`,
			);
			expect(finished.tools[0].state).toBe("succeeded");
		} finally {
			logger.info("工具专用消息状态验证完成");
		}
	});
	/*
	 * ========================================================================
	 * 步骤2：验证没有完整文件时的官方详情展示
	 * ========================================================================
	 * 数据源：任务、消息窗口与工具调用/结果。
	 * 操作：1) 正确关联工具结果；2) 不把缺少结果的调用伪装成成功。
	 */
	it("renders official inspection messages and final output without transcript files", () => {
		const logger = console;
		logger.info("开始验证官方详情展示");
		try {
			// 2.1 以官方消息顺序关联工具，最终输出只在正文缺失时补入。
			const parsed = parseSubagentInspection({
				kind: "pi-subagents.inspect-reply",
				version: 1,
				requestId: "request",
				status: "complete",
				task: "检查任务",
				finalOutput: "检查完成",
				messages: [
					{ role: "assistant", kind: "toolCall", name: "read", text: '{"path":"a.ts"}' },
					{ role: "toolResult", kind: "text", text: "文件内容" },
					{ role: "assistant", kind: "toolCall", name: "bash", text: "npm run check" },
				],
			});
			expect(parsed.messages[0]).toMatchObject({ role: "user", blocks: [{ text: "检查任务" }] });
			expect(parsed.messages.at(-1)).toMatchObject({ role: "assistant", blocks: [{ text: "检查完成" }] });
			expect(parsed.tools).toMatchObject([
				{ name: "read", output: "文件内容", state: "succeeded" },
				{ name: "bash", state: "interrupted" },
			]);
		} finally {
			logger.info("官方详情展示验证完成");
		}
	});
	it("rebuilds assistant text, tool calls and tool results without system records", () => {
		const lines = [
			{
				recordType: "message",
				role: "user",
				ts: 1,
				text: "检查文件",
				message: { role: "user", content: [{ type: "text", text: "检查文件" }] },
			},
			{ recordType: "message", role: "system", message: { role: "system", content: "" } },
			{
				recordType: "message",
				role: "assistant",
				ts: 2,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "开始检查" },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
					],
				},
			},
			{ recordType: "tool_start", toolCallId: "call-1", toolName: "read", argsPayload: '{"path":"a.ts"}' },
			{ recordType: "tool_end", toolCallId: "call-1", toolName: "read", isError: false },
			{
				recordType: "message",
				role: "toolResult",
				toolCallId: "call-1",
				text: "内容",
				message: { role: "toolResult", content: [{ type: "text", text: "内容" }] },
			},
		];
		const parsed = parseSubagentTranscript(lines.map((line) => JSON.stringify(line)).join("\n"));
		expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(parsed.messages[1].blocks[0]).toEqual({ kind: "text", text: "开始检查" });
		expect(parsed.tools).toHaveLength(1);
		expect(parsed.tools[0]).toMatchObject({ id: "call-1", name: "read", output: "内容", state: "succeeded" });
	});
});
