import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentHost } from "../src/host/agent-host.ts";
import { PlanJournal } from "../src/host/plan-journal.ts";
import { QueueJournal } from "../src/host/queue-journal.ts";
import type { CommandEnvelope, GuiCommand } from "../src/shared/protocol.ts";
import { ImageStore } from "../src/storage/image-store.ts";
import { pngFixture } from "./image-fixture.ts";
import { createHarness, getUserTexts, type Harness } from "./sdk-harness.ts";

const logger = { info: vi.fn() };

async function createHost(harness: Harness) {
	const journal = new QueueJournal(
		join(harness.tempDir, "journal"),
		harness.tempDir,
		harness.session.sessionId,
		logger,
	);
	await journal.load();
	const images = new ImageStore(join(harness.tempDir, "images"), logger);
	const host = new AgentHost(
		{
			session: harness.session,
			services: { modelRuntime: harness.modelRuntime },
			dispose: async () => {},
		},
		logger,
		journal,
		images,
		new PlanJournal(join(harness.tempDir, "plans"), harness.tempDir, harness.session.sessionId, logger),
		harness.authStorage,
	);
	const envelope = (command: GuiCommand): CommandEnvelope => ({
		requestId: crypto.randomUUID(),
		sessionId: host.snapshot.sessionId,
		generation: host.snapshot.generation,
		command,
	});
	return { host, journal, envelope, images };
}

/*
 * ========================================================================
 * 步骤1：验证宿主在准备、失败与空闲状态下的取消边界
 * ========================================================================
 * 数据源：真实 SDK harness；仅延迟 prompt 的准备结果。
 * 操作：
 *   1) 准备阶段拒绝停止，不发布虚假的 stopping
 *   2) 准备失败恢复空闲，迟到的旧会话命令不能运行
 */
describe("AgentHost command boundaries", () => {
	it("binds startup dialogs before accepting work and honors extension transition cancellation", async () => {
		logger.info("开始验证扩展生命周期交互");
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						await ctx.ui.input("启动输入");
					});
					pi.on("session_before_switch", async (_event, ctx) => ({
						cancel: !(await ctx.ui.confirm("切换确认", "继续？")),
					}));
				},
			],
		});
		const { host, envelope } = await createHost(harness);
		try {
			const initializing = host.initialize();
			await vi.waitFor(() => expect(host.snapshot.dialogs[0]?.title).toBe("启动输入"));
			await expect(host.dispatch(envelope({ type: "prompt", text: "不能绕过交互" }))).rejects.toThrow("当前交互");
			const startupId = host.snapshot.dialogs[0].id;
			await host.dispatch(envelope({ type: "reply", reply: { id: startupId, cancelled: true } }));
			await initializing;
			expect(host.snapshot.run.phase).toBe("idle");
			const transitioning = expect(host.beforeTransition({ type: "new" })).rejects.toThrow("扩展已取消");
			await vi.waitFor(() => expect(host.snapshot.dialogs[0]?.title).toBe("切换确认"));
			await host.dispatch(
				envelope({ type: "reply", reply: { id: host.snapshot.dialogs[0].id, cancelled: false, value: false } }),
			);
			await transitioning;
			expect(host.snapshot.dialogs).toEqual([]);
			await expect(
				host.dispatch(envelope({ type: "reply", reply: { id: startupId, cancelled: true } })),
			).rejects.toThrow("交互已结束");
		} finally {
			await host.dispose();
			harness.cleanup();
			logger.info("扩展生命周期交互验证完成");
		}
	});
	/*
	 * ========================================================================
	 * 步骤2：验证图片队列保留内容身份与 SDK 消费顺序
	 * ========================================================================
	 * 数据源：真实 SDK、离线模型与同文不同附件的队列。
	 * 操作：
	 *   1) 排队和引导均收到图片，重复正文不串附件
	 *   2) 写前记录在接受前保存，正常收束后清理已消费记录
	 */
	it("preserves images in both SDK queues without assigning them to repeated text", async () => {
		logger.info("开始验证图片排队与引导");
		const harness = await createHarness();
		const model = harness.session.model;
		if (!model) throw new Error("Fixture model missing");
		vi.spyOn(harness.session, "model", "get").mockReturnValue({ ...model, input: ["text", "image"] });
		const { host, envelope, images, journal } = await createHost(harness);
		let release = () => {};
		let entered = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		harness.setResponses([
			async () => {
				entered();
				await gate;
				return fauxAssistantMessage("原回答");
			},
			fauxAssistantMessage("引导回答"),
			fauxAssistantMessage("图片回答"),
			fauxAssistantMessage("文字回答"),
		]);
		try {
			const imageIds = await images.importData(
				host.snapshot.cwd,
				harness.session.sessionId,
				[pngFixture],
				(bytes) => bytes,
			);
			const running = host.dispatch(envelope({ type: "prompt", text: "原任务" }));
			await ready;
			await host.dispatch(envelope({ type: "enqueue", mode: "followUp", text: "相同正文", imageIds }));
			await host.dispatch(envelope({ type: "enqueue", mode: "followUp", text: "相同正文" }));
			await host.dispatch(envelope({ type: "enqueue", mode: "steer", text: "引导图片", imageIds }));
			expect(host.snapshot.queue.followUp).toEqual([{ text: "相同正文", imageIds }, { text: "相同正文" }]);
			expect(host.snapshot.queue.steering).toEqual([{ text: "引导图片", imageIds }]);
			expect(journal.interrupted.followUp[0].imageIds).toEqual(imageIds);
			release();
			await running;
			const users = harness.session.messages.filter((message) => message.role === "user");
			expect(getUserTexts(harness)).toEqual(["原任务", "引导图片", "相同正文", "相同正文"]);
			expect(
				users.map((message) =>
					typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "image").length,
				),
			).toEqual([0, 1, 1, 0]);
			expect(journal.count).toBe(0);
		} finally {
			release();
			await host.dispose();
			harness.cleanup();
			logger.info("图片排队与引导验证完成");
		}
	});
	it("loads session-scoped image content into prompt options and rejects missing images before the SDK", async () => {
		logger.info("开始验证宿主图片提交");
		const harness = await createHarness();
		const model = harness.session.model;
		if (!model) throw new Error("Fixture model missing");
		vi.spyOn(harness.session, "model", "get").mockReturnValue({ ...model, input: ["text", "image"] });
		const { host, envelope, images } = await createHost(harness);
		const prompt = vi.spyOn(harness.session, "prompt").mockResolvedValue();
		try {
			const file = join(harness.tempDir, "image.png");
			await writeFile(file, Buffer.from(pngFixture, "base64"));
			const imageIds = await images.importFiles(host.snapshot.cwd, harness.session.sessionId, [file], (bytes) => bytes);
			await host.dispatch(envelope({ type: "prompt", text: "看图", imageIds }));
			expect(prompt).toHaveBeenCalledWith("看图", {
				source: "interactive",
				images: [{ type: "image", mimeType: "image/png", data: pngFixture }],
			});
			await expect(
				host.dispatch(envelope({ type: "prompt", text: "看图", imageIds: ["f".repeat(64)] })),
			).rejects.toThrow("已失效");
			expect(prompt).toHaveBeenCalledTimes(1);
			expect(host.snapshot.run.phase).toBe("idle");
		} finally {
			await host.dispose();
			harness.cleanup();
			logger.info("宿主图片提交验证完成");
		}
	});

	it("rejects image input for a text-only model without invoking prompt", async () => {
		logger.info("开始验证模型图片能力边界");
		const harness = await createHarness();
		const model = harness.session.model;
		if (!model) throw new Error("Fixture model missing");
		vi.spyOn(harness.session, "model", "get").mockReturnValue({ ...model, input: ["text"] });
		const { host, envelope } = await createHost(harness);
		const prompt = vi.spyOn(harness.session, "prompt");
		try {
			await expect(
				host.dispatch(envelope({ type: "prompt", text: "看图", imageIds: ["a".repeat(64)] })),
			).rejects.toThrow("不支持图片");
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			await host.dispose();
			harness.cleanup();
			logger.info("模型图片能力边界验证完成");
		}
	});
	it("rejects abort during preflight and returns to idle when preflight fails", async () => {
		logger.info("开始验证准备阶段取消");
		const harness = await createHarness();
		const { host, envelope } = await createHost(harness);
		let rejectPrompt: (error: Error) => void = () => {};
		vi.spyOn(harness.session, "prompt").mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectPrompt = reject;
				}),
		);
		try {
			// 1.1 宿主开始准备，但 SDK 尚无可取消的运行。
			const running = host.dispatch(envelope({ type: "prompt", text: "任务" }));
			expect(host.snapshot.run.phase).toBe("preparing");
			await expect(host.dispatch(envelope({ type: "abort" }))).rejects.toThrow("正在准备");
			expect(host.snapshot.run.phase).toBe("preparing");
			rejectPrompt(new Error("preflight rejected"));
			await expect(running).rejects.toThrow("preflight rejected");
			expect(host.snapshot.run.phase).toBe("idle");
			await host.dispatch(envelope({ type: "abort" }));
			expect(host.snapshot.run.phase).toBe("idle");
		} finally {
			await host.dispose();
			harness.cleanup();
			logger.info("准备阶段取消验证完成");
		}
	});

	it("rejects stale generations before invoking the SDK", async () => {
		logger.info("开始验证旧宿主身份");
		const harness = await createHarness();
		const { host } = await createHost(harness);
		const prompt = vi.spyOn(harness.session, "prompt");
		try {
			// 1.2 会话相同也不能复用上一宿主的代次。
			await expect(
				host.dispatch({
					requestId: "stale",
					sessionId: host.snapshot.sessionId,
					generation: "previous-host",
					command: { type: "prompt", text: "任务" },
				}),
			).rejects.toThrow("会话已更换");
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			await host.dispose();
			harness.cleanup();
			logger.info("旧宿主身份验证完成");
		}
	});

	it("uses the SDK steering and follow-up queues and journals before acknowledging", async () => {
		logger.info("开始验证真实 SDK 队列");
		const harness = await createHarness();
		const { host, envelope } = await createHost(harness);
		let enter = () => {};
		let release = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				enter();
				await gate;
				return fauxAssistantMessage("初次完成");
			},
			fauxAssistantMessage("引导完成"),
			fauxAssistantMessage("后续完成"),
		]);
		try {
			const running = host.dispatch(envelope({ type: "prompt", text: "原任务" }));
			await entered;
			await host.dispatch(envelope({ type: "enqueue", mode: "followUp", text: "后续任务" }));
			await host.dispatch(envelope({ type: "enqueue", mode: "steer", text: "先检查边界" }));
			expect(host.snapshot.queue).toMatchObject({
				steering: [{ text: "先检查边界" }],
				followUp: [{ text: "后续任务" }],
			});
			const interrupted = new QueueJournal(
				join(harness.tempDir, "journal"),
				harness.tempDir,
				harness.session.sessionId,
				logger,
			);
			await interrupted.load();
			expect(interrupted.recovery).toEqual({ steering: [{ text: "先检查边界" }], followUp: [{ text: "后续任务" }] });
			release();
			await running;
			expect(getUserTexts(harness)).toEqual(["原任务", "先检查边界", "后续任务"]);
			expect(host.snapshot.queue).toMatchObject({ steering: [], followUp: [] });
			const settled = new QueueJournal(
				join(harness.tempDir, "journal"),
				harness.tempDir,
				harness.session.sessionId,
				logger,
			);
			await settled.load();
			expect(settled.count).toBe(0);
		} finally {
			release();
			await host.dispose();
			harness.cleanup();
			logger.info("真实 SDK 队列验证完成");
		}
	});

	it("rejects queue writes that fail or arrive after the running task settles", async () => {
		logger.info("开始验证迟到入队和保存失败");
		const harness = await createHarness();
		const { host, journal, envelope } = await createHost(harness);
		let enter = () => {};
		let release = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				enter();
				await gate;
				return fauxAssistantMessage("完成");
			},
		]);
		const prompt = vi.spyOn(harness.session, "prompt");
		try {
			const running = host.dispatch(envelope({ type: "prompt", text: "原任务" }));
			await entered;
			const save = vi.spyOn(journal, "prepare").mockRejectedValueOnce(new Error("disk full"));
			await expect(host.dispatch(envelope({ type: "enqueue", mode: "followUp", text: "不能丢失" }))).rejects.toThrow(
				"disk full",
			);
			expect(harness.session.pendingMessageCount).toBe(0);
			save.mockRestore();
			const prepare = journal.prepare.bind(journal);
			vi.spyOn(journal, "prepare").mockImplementationOnce(async (id, mode, text) => {
				await prepare(id, mode, text);
				release();
				await harness.session.waitForIdle();
			});
			await expect(host.dispatch(envelope({ type: "enqueue", mode: "followUp", text: "迟到输入" }))).rejects.toThrow(
				"收束",
			);
			await running;
			expect(prompt).toHaveBeenCalledTimes(1);
			expect(getUserTexts(harness)).toEqual(["原任务"]);
		} finally {
			release();
			await host.dispose();
			harness.cleanup();
			logger.info("迟到入队和保存失败验证完成");
		}
	});

	it("stops without consuming follow-ups and keeps them available for manual recovery", async () => {
		logger.info("开始验证停止不消费后续任务");
		const harness = await createHarness();
		const { host, journal, envelope } = await createHost(harness);
		let enter = () => {};
		let release = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				enter();
				await gate;
				return fauxAssistantMessage("当前回答");
			},
			fauxAssistantMessage("后续任务不应运行"),
		]);
		try {
			const running = host.dispatch(envelope({ type: "prompt", text: "原任务" }));
			await entered;
			await host.dispatch(envelope({ type: "enqueue", mode: "followUp", text: "留待核对" }));
			const stopping = host.dispatch(envelope({ type: "abort" }));
			release();
			await stopping;
			await running;
			expect(getUserTexts(harness)).toEqual(["原任务"]);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(host.snapshot.queue).toMatchObject({ followUp: [], recovery: { followUp: [{ text: "留待核对" }] } });
			expect(journal.recovery.followUp).toEqual([{ text: "留待核对" }]);
			await expect(host.dispatch(envelope({ type: "prompt", text: "不能绕过恢复" }))).rejects.toThrow("恢复或清空");
			await host.dispatch(envelope({ type: "clearQueue" }));
			expect(host.snapshot.queue.recovery.followUp).toEqual([]);
		} finally {
			release();
			await host.dispose();
			harness.cleanup();
			logger.info("停止不消费后续任务验证完成");
		}
	});

	it("releases the adapter and runtime even when the final queue checkpoint fails", async () => {
		logger.info("开始验证保存失败后的资源释放");
		const harness = await createHarness();
		const { host, journal } = await createHost(harness);
		const release = vi.spyOn(host.adapter, "dispose");
		vi.spyOn(journal, "checkpoint").mockRejectedValueOnce(new Error("disk full"));
		try {
			await expect(host.dispose()).rejects.toThrow("disk full");
			expect(release).toHaveBeenCalledOnce();
		} finally {
			harness.cleanup();
			logger.info("保存失败后的资源释放验证完成");
		}
	});
});
