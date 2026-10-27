import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { SessionAdapter } from "../src/host/session-adapter.ts";
import { eventEnvelopeSchema, isTaskRunning, type SessionEvent } from "../src/shared/protocol.ts";
import { snapshot } from "./fixtures.ts";
import { pngFixture } from "./image-fixture.ts";
import { createHarness } from "./sdk-harness.ts";

const logger = { info: vi.fn() };

/*
 * ========================================================================
 * 步骤1：用真实 SDK 与离线 provider 验证 GUI 适配
 * ========================================================================
 * 数据源：仓库 harness 和 faux provider，不使用网络或认证密钥。
 * 操作：
 *   1) 运行真实工具往返，核对累计输出和消息身份
 *   2) 核对事件连续、快照可恢复与 agent_settled 的收束语义
 */
describe("SessionAdapter with real AgentSession", () => {
	it("keeps initialization separate without hiding work started before it finishes", async () => {
		logger.info("开始验证初始化不会覆盖真实运行");
		const harness = await createHarness();
		const adapter = new SessionAdapter(harness.session, snapshot().configuration, logger, true);
		let enter = () => {};
		let finish = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		harness.setResponses([
			async () => {
				enter();
				await gate;
				return fauxAssistantMessage("扩展任务完成");
			},
		]);
		try {
			// 1.3 初始化本身不消费模型响应，真实 SDK agent_start 才进入运行。
			adapter.beginInitialization();
			expect(adapter.snapshot.run.phase).toBe("initializing");
			expect(isTaskRunning(adapter.snapshot.run.phase)).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(1);
			const running = harness.session.prompt("扩展恢复任务");
			await entered;
			adapter.endInitialization();
			expect(adapter.snapshot.run.phase).toBe("working");
			adapter.beginInitialization();
			expect(adapter.snapshot.run.phase).toBe("working");
			finish();
			await running;
			expect(adapter.snapshot.run.phase).toBe("idle");
		} finally {
			finish();
			adapter.dispose();
			harness.cleanup();
			logger.info("初始化不会覆盖真实运行验证结束");
		}
	});
	it("keeps image bytes out of snapshots and serves only current session image identities", async () => {
		logger.info("开始验证历史图片按需读取");
		const harness = await createHarness();
		harness.session.agent.state.messages = [
			{
				role: "user",
				timestamp: 1,
				content: [
					{ type: "text", text: "看图" },
					{ type: "image", mimeType: "image/png", data: pngFixture },
				],
			},
			{ role: "user", timestamp: 2, content: [{ type: "image", mimeType: "image/png", data: `${pngFixture} ` }] },
		];
		const adapter = new SessionAdapter(harness.session, snapshot().configuration, logger);
		try {
			const current = adapter.snapshot;
			const id = current.messages[0].imageIds?.[0];
			if (!id) throw new Error("Image identity missing");
			expect(JSON.stringify(current)).not.toContain(pngFixture);
			expect(adapter.getImage(id)).toBe(`data:image/png;base64,${pngFixture}`);
			expect(current.messages[1].imageIds).toBeUndefined();
			expect(current.messages[1].blocks[0].text).toContain("暂不支持预览");
			expect(() => adapter.getImage("f".repeat(64))).toThrow("当前会话");
		} finally {
			adapter.dispose();
			harness.cleanup();
			logger.info("历史图片按需读取验证完成");
		}
	});
	it("projects a complete tool roundtrip with cumulative output and ordered envelopes", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "progress",
					label: "Progress",
					description: "Report progress",
					parameters: Type.Object({}),
					execute: async (_id, _args, _signal, onUpdate) => {
						onUpdate?.({ content: [{ type: "text", text: "first" }], details: {} });
						onUpdate?.({ content: [{ type: "text", text: "first + second" }], details: {} });
						return { content: [{ type: "text", text: "complete" }], details: {} };
					},
				},
			],
		});
		const adapter = new SessionAdapter(harness.session, snapshot().configuration, logger);
		const events: SessionEvent[] = [];
		adapter.subscribe((event) => events.push(event));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("progress", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("任务完成"),
		]);
		try {
			await harness.session.prompt("运行工具");
			const current = adapter.snapshot;
			expect(current.title).toBe("运行工具");
			expect(current.messages.filter((message) => message.role === "user")).toHaveLength(1);
			expect(current.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
			expect(new Set(current.messages.map((message) => message.id)).size).toBe(3);
			expect(current.tools).toHaveLength(1);
			expect(current.tools[0]).toMatchObject({ output: "complete", state: "succeeded" });
			expect(current.tools[0].messageId).toBe(current.messages[1].id);
			expect(current.run.phase).toBe("idle");
			expect(
				events.every((event, index) => event.seq === index + 1 && eventEnvelopeSchema.safeParse(event).success),
			).toBe(true);
			expect(events.at(-1)?.event).toEqual({ type: "run", run: { phase: "idle" } });
		} finally {
			adapter.dispose();
			harness.cleanup();
		}
	});

	it("keeps historical tool calls unfinished when no result was saved", async () => {
		const harness = await createHarness();
		const message = fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" });
		harness.session.agent.state.messages = [message];
		const adapter = new SessionAdapter(harness.session, snapshot().configuration, logger);
		try {
			expect(adapter.snapshot.tools[0]).toMatchObject({
				messageId: adapter.snapshot.messages[0].id,
				state: "interrupted",
				output: "",
			});
			expect(adapter.snapshot.run.phase).toBe("idle");
		} finally {
			adapter.dispose();
			harness.cleanup();
		}
	});

	it("restores existing messages without creating another conversation store", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("已有回答")]);
		try {
			await harness.session.prompt("已有问题");
			const adapter = new SessionAdapter(harness.session, snapshot().configuration, logger);
			expect(adapter.snapshot.messages).toHaveLength(2);
			expect(adapter.snapshot.messages[1].blocks[0].text).toBe("已有回答");
			adapter.dispose();
		} finally {
			harness.cleanup();
		}
	});

	it("associates duplicate user messages with their native entries after persistence and reload", async () => {
		logger.info("开始验证重复消息原生身份");
		const harness = await createHarness();
		const adapter = new SessionAdapter(harness.session, snapshot().configuration, logger, true);
		harness.setResponses([
			fauxAssistantMessage("第一答"),
			fauxAssistantMessage("第二答"),
			fauxAssistantMessage("第三答"),
		]);
		try {
			for (let index = 0; index < 3; index++) {
				adapter.beginPrompt();
				await harness.session.prompt("重复正文");
				adapter.endPrompt();
			}
			const entries = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user");
			const users = adapter.snapshot.messages.filter((message) => message.role === "user");
			expect(users.map((message) => message.forkEntryId)).toEqual([undefined, entries[1].id, entries[2].id]);
			const restored = new SessionAdapter(harness.session, snapshot().configuration, logger);
			try {
				expect(
					restored.snapshot.messages.filter((message) => message.role === "user").map((message) => message.forkEntryId),
				).toEqual([undefined, entries[1].id, entries[2].id]);
			} finally {
				restored.dispose();
			}
		} finally {
			adapter.dispose();
			harness.cleanup();
			logger.info("重复消息原生身份验证完成");
		}
	});

	it("marks a clipped body so the renderer cannot copy it as complete content", async () => {
		logger.info("开始验证正文截断标记");
		const harness = await createHarness();
		harness.session.agent.state.messages = [fauxAssistantMessage("x".repeat(2_000_001))];
		const adapter = new SessionAdapter(harness.session, snapshot().configuration, logger);
		try {
			const [message] = adapter.snapshot.messages;
			expect(message.textTruncated).toBe(true);
			expect(message.blocks[0].text).toHaveLength(2_000_000);
		} finally {
			adapter.dispose();
			harness.cleanup();
			logger.info("正文截断标记验证完成");
		}
	});

	it("settles a waiting run when the main prompt finishes", async () => {
		const harness = await createHarness();
		const adapter = new SessionAdapter(harness.session, snapshot().configuration, logger);
		try {
			adapter.markWaiting();
			expect(adapter.snapshot.run.phase).toBe("waiting");
			adapter.endPrompt();
			expect(adapter.snapshot.run.phase).toBe("idle");
		} finally {
			adapter.dispose();
			harness.cleanup();
		}
	});
});
