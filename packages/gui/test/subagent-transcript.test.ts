import { describe, expect, it } from "vitest";
import { parseSubagentTranscript } from "../src/shared/subagent-transcript.ts";

describe("parseSubagentTranscript", () => {
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
