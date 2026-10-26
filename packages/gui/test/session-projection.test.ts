import { describe, expect, it, vi } from "vitest";
import { SessionProjection } from "../src/domain/session-projection.ts";
import { commandEnvelopeSchema, type SessionEvent, snapshotSchema } from "../src/shared/protocol.ts";
import { snapshot } from "./fixtures.ts";

const logger = { info: vi.fn() };

/*
 * ========================================================================
 * 步骤1：验证跨进程序号和累计快照语义
 * ========================================================================
 * 数据源：交错消息、工具进度与不同宿主代次。
 * 操作：
 *   1) 验证重复和缺口不会污染状态
 *   2) 验证工具累计输出不重复拼接
 */
describe("SessionProjection", () => {
	it("replaces cumulative tool output and preserves immutable earlier views", () => {
		const projection = new SessionProjection(snapshot(), logger);
		const tool = {
			id: "tool-1",
			messageId: "message-1",
			name: "bash",
			input: "pwd",
			output: "C:",
			truncated: false,
			state: "running" as const,
		};
		const event: SessionEvent = {
			sessionId: "session-1",
			generation: "host-1",
			seq: 1,
			event: { type: "tool", tool },
		};
		expect(projection.apply(event)).toBe("applied");
		const earlier = projection.value;
		projection.apply({
			...event,
			seq: 2,
			event: { type: "tool", tool: { ...tool, output: "C:/workspace", state: "succeeded" } },
		});
		expect(projection.value.tools).toHaveLength(1);
		expect(projection.value.tools[0].output).toBe("C:/workspace");
		expect(earlier.tools[0].output).toBe("C:");
	});

	it("rejects stale, duplicate and out-of-order events without advancing the cursor", () => {
		const projection = new SessionProjection(snapshot(), logger);
		const event: SessionEvent = {
			sessionId: "session-1",
			generation: "host-1",
			seq: 1,
			event: { type: "run", run: { phase: "working" } },
		};
		expect(projection.apply({ ...event, generation: "old-host" })).toBe("stale");
		expect(projection.apply({ ...event, sessionId: "other-session" })).toBe("stale");
		expect(projection.apply({ ...event, seq: 3 })).toBe("gap");
		expect(projection.value.seq).toBe(0);
		expect(projection.apply(event)).toBe("applied");
		expect(projection.apply(event)).toBe("stale");
		expect(projection.value.seq).toBe(1);
	});

	it("copies the installed snapshot and accepts only validated command payloads", () => {
		const initial = snapshot();
		const projection = new SessionProjection(initial, logger);
		initial.title = "external mutation";
		expect(projection.value.title).toBe("新对话");
		expect(snapshotSchema.safeParse({ ...snapshot(), version: 2 }).success).toBe(false);
		expect(
			commandEnvelopeSchema.safeParse({
				requestId: "r",
				sessionId: "s",
				generation: "g",
				command: { type: "prompt", text: "   " },
			}).success,
		).toBe(false);
	});
});
