import { describe, expect, it, vi } from "vitest";
import { GuiController } from "../src/domain/gui-controller.ts";
import { FakeAgentPort, snapshot } from "./fixtures.ts";
import { pngFixture } from "./image-fixture.ts";

const logger = { info: vi.fn() };
const imageId = "a".repeat(64);
function imagePort(): FakeAgentPort {
	const port = new FakeAgentPort();
	const current = snapshot();
	const model = { key: "test/image", provider: "test", name: "Image model", available: true, supportsImages: true };
	port.current = { ...current, configuration: { ...current.configuration, model, models: [model] } };
	return port;
}

/*
 * ========================================================================
 * 步骤1：验证图片草稿的恢复与发送确认
 * ========================================================================
 * 数据源：可控图片选择、串行草稿端口与迟到命令结果。
 * 操作：
 *   1) 图片引用先保存，失败与中断保留输入，不自动发送
 *   2) 任务收束后才清理未改动草稿，文本队列不能默默丢弃图片
 */
describe("GUI image drafts", () => {
	/*
	 * ========================================================================
	 * 步骤2：验证图片队列恢复先保存后清空
	 * ========================================================================
	 * 数据源：队列图片身份、已有草稿与可控保存失败。
	 * 操作：
	 *   1) 失败重试不重复附加文字，图片继续复用内容库
	 *   2) 合并超出四张时保留草稿与队列，不降级成纯文本
	 */
	it("restores queued images atomically with text and refuses oversized draft merges", async () => {
		logger.info("开始验证图片队列草稿恢复");
		const port = imagePort();
		if (!port.current) throw new Error("Fixture missing");
		port.current.queue.recovery.followUp = [{ text: "图片任务", imageIds: [imageId] }];
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		try {
			controller.setDraft("原草稿");
			await controller.flushDraft();
			const save = vi.spyOn(port, "saveDraft").mockRejectedValueOnce(new Error("disk full"));
			expect(await controller.restoreQueue()).toBe(false);
			expect(port.commands).toEqual([]);
			expect(controller.value.imageIds).toEqual([imageId]);
			save.mockRestore();
			expect(await controller.restoreQueue()).toBe(true);
			expect(port.drafts.get("session-1")).toMatchObject({ text: "原草稿\n\n图片任务", imageIds: [imageId] });
			port.current.queue.recovery.followUp = [
				{ text: "超限任务", imageIds: ["b", "c", "d", "e"].map((value) => value.repeat(64)) },
			];
			await controller.refresh();
			expect(await controller.restoreQueue()).toBe(false);
			expect(controller.value.error).toContain("草稿上限");
			expect(port.commands).toHaveLength(1);
			expect(controller.value.imageIds).toEqual([imageId]);
		} finally {
			controller.dispose();
			logger.info("图片队列草稿恢复验证完成");
		}
	});
	it("imports event content into the existing draft without sending and deduplicates native attachments", async () => {
		logger.info("开始验证图片事件草稿复用");
		const port = imagePort();
		vi.spyOn(port, "selectImages").mockResolvedValue([imageId]);
		const imported = vi.spyOn(port, "importImages").mockResolvedValue([imageId]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("  原有中文说明\n");
		await controller.attachImages();
		expect(await controller.attachImages(async () => [pngFixture])).toBe(true);
		expect(imported).toHaveBeenCalledWith({ sessionId: "session-1", generation: "host-1", data: [pngFixture] });
		expect(controller.value.imageIds).toEqual([imageId]);
		expect(controller.value.draft).toBe("  原有中文说明\n");
		expect(port.drafts.get("session-1")?.imageIds).toEqual([imageId]);
		expect(port.commands).toEqual([]);
		controller.dispose();
		logger.info("图片事件草稿复用验证完成");
	});

	it("locks submissions before reading event files and merges into the latest text afterward", async () => {
		logger.info("开始验证图片事件读取互斥");
		const port = imagePort();
		const imported = vi.spyOn(port, "importImages").mockResolvedValue([imageId]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("原说明");
		let finish: (data: string[]) => void = () => {};
		const adding = controller.attachImages(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		expect(controller.value.selectingFiles).toBe(true);
		expect(imported).not.toHaveBeenCalled();
		expect(await controller.send({ type: "prompt", text: "原说明" })).toBe(false);
		expect(await controller.attachImages()).toBe(false);
		controller.setDraft("更新后的说明");
		finish([pngFixture]);
		expect(await adding).toBe(true);
		expect(controller.value.selectingFiles).toBe(false);
		expect(port.drafts.get("session-1")).toMatchObject({ text: "更新后的说明", imageIds: [imageId] });
		controller.dispose();
		logger.info("图片事件读取互斥验证完成");
	});

	it("discards event content if the view is disposed or the host changes while files are read", async () => {
		logger.info("开始验证图片事件迟到结果");
		for (const dispose of [true, false]) {
			const port = imagePort();
			const imported = vi.spyOn(port, "importImages");
			const controller = new GuiController(port, logger, port);
			await controller.connect();
			let finish: (data: string[]) => void = () => {};
			const adding = controller.attachImages(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			if (dispose) controller.dispose();
			else {
				if (port.current) port.current = { ...port.current, generation: "next" };
				await controller.refresh();
			}
			finish([pngFixture]);
			expect(await adding).toBe(false);
			expect(imported).not.toHaveBeenCalled();
			expect(controller.value.imageIds).toEqual([]);
			controller.dispose();
		}
		logger.info("图片事件迟到结果验证完成");
	});

	it("retains the existing draft after read or import failures and releases selection exclusion", async () => {
		logger.info("开始验证图片事件失败恢复");
		const port = imagePort();
		const imported = vi
			.spyOn(port, "importImages")
			.mockRejectedValueOnce(new Error("decode failed"))
			.mockResolvedValue([imageId]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("不可丢失的说明");
		expect(
			await controller.attachImages(async () => {
				throw new Error("read failed");
			}),
		).toBe(false);
		expect(imported).not.toHaveBeenCalled();
		expect(await controller.attachImages(async () => [pngFixture])).toBe(false);
		expect(controller.value.imageIds).toEqual([]);
		expect(controller.value.draft).toBe("不可丢失的说明");
		expect(controller.value.selectingFiles).toBe(false);
		expect(await controller.attachImages(async () => [pngFixture])).toBe(true);
		controller.dispose();
		logger.info("图片事件失败恢复验证完成");
	});

	it("does not read event files for text models or while a run is retrying", async () => {
		logger.info("开始验证图片事件读取前置条件");
		const port = imagePort();
		const read = vi.fn(async () => [pngFixture]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		if (port.current) port.current = { ...port.current, run: { phase: "retrying" } };
		await controller.refresh();
		expect(await controller.attachImages(read)).toBe(false);
		port.current = snapshot();
		await controller.refresh();
		expect(await controller.attachImages(read)).toBe(false);
		expect(controller.value.error).toContain("不支持图片");
		expect(read).not.toHaveBeenCalled();
		controller.dispose();
		logger.info("图片事件读取前置条件验证完成");
	});
	it("does not dispatch after disposal while the image draft save is being awaited", async () => {
		logger.info("开始验证图片发送前销毁");
		const port = imagePort();
		vi.spyOn(port, "selectImages").mockResolvedValue([imageId]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("保留原输入");
		await controller.attachImages();
		const sending = controller.send({ type: "prompt", text: "保留原输入" });
		controller.dispose();
		expect(await sending).toBe(false);
		expect(port.commands).toEqual([]);
		expect(port.drafts.get("session-1")?.imageIds).toEqual([imageId]);
		logger.info("图片发送前销毁验证完成");
	});
	it("deduplicates attachments and restores them through the regular draft channel", async () => {
		logger.info("开始验证图片草稿恢复");
		const port = imagePort();
		vi.spyOn(port, "selectImages").mockResolvedValue([imageId]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("中文说明");
		expect(await controller.attachImages()).toBe(true);
		expect(await controller.attachImages()).toBe(true);
		expect(controller.value.imageIds).toEqual([imageId]);
		expect(port.commands).toEqual([]);
		controller.dispose();
		const restored = new GuiController(port, logger, port);
		await restored.connect();
		expect(restored.value.imageIds).toEqual([imageId]);
		expect(restored.value.draft).toBe("中文说明");
		restored.removeImage(imageId);
		await restored.flushDraft();
		expect(port.drafts.get("session-1")?.imageIds).toBeUndefined();
		expect(restored.value.draft).toBe("中文说明");
		restored.dispose();
		logger.info("图片草稿恢复验证完成");
	});

	it("keeps accepted image input until the run finishes and preserves it after a host failure", async () => {
		logger.info("开始验证图片发送中断恢复");
		const port = imagePort();
		vi.spyOn(port, "selectImages").mockResolvedValue([imageId]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("看图");
		await controller.attachImages();
		let fail: (error: Error) => void = () => {};
		port.execute = () =>
			new Promise((_resolve, reject) => {
				fail = reject;
			});
		const sending = controller.send({ type: "prompt", text: "看图" });
		await vi.waitFor(() => expect(port.commands).toHaveLength(1));
		expect(port.commands[0].command).toEqual({ type: "prompt", text: "看图", imageIds: [imageId] });
		port.emit({
			type: "event",
			value: {
				sessionId: "session-1",
				generation: "host-1",
				seq: 1,
				event: {
					type: "message",
					message: { id: "user", role: "user", blocks: [{ kind: "text", text: "看图" }], imageIds: [imageId] },
				},
			},
		});
		expect(controller.value.imageIds).toEqual([imageId]);
		expect(controller.value.draft).toBe("看图");
		fail(new Error("host exited"));
		expect(await sending).toBe(false);
		expect(port.drafts.get("session-1")?.imageIds).toEqual([imageId]);
		controller.dispose();
		logger.info("图片发送中断恢复验证完成");
	});

	it("clears a completed image submission but does not erase newer text or attachment edits", async () => {
		logger.info("开始验证图片提交清理边界");
		const port = imagePort();
		vi.spyOn(port, "selectImages").mockResolvedValue([imageId]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("已完成输入");
		await controller.attachImages();
		expect(await controller.send({ type: "prompt", text: "已完成输入" })).toBe(true);
		expect(controller.value.imageIds).toEqual([]);
		expect(controller.value.draft).toBe("");
		controller.setDraft("旧说明");
		await controller.attachImages();
		let finish = () => {};
		port.execute = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const sending = controller.send({ type: "prompt", text: "旧说明" });
		await vi.waitFor(() => expect(port.commands).toHaveLength(2));
		controller.setDraft("新的独立说明");
		finish();
		await sending;
		expect(controller.value.draft).toBe("新的独立说明");
		expect(controller.value.imageIds).toEqual([imageId]);
		controller.dispose();
		logger.info("图片提交清理边界验证完成");
	});

	it("retains unsaved attachments and refuses to send until persistence succeeds", async () => {
		logger.info("开始验证图片保存失败");
		const port = imagePort();
		vi.spyOn(port, "selectImages").mockResolvedValue([imageId]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("不能丢失");
		await controller.flushDraft();
		const save = vi.spyOn(port, "saveDraft").mockRejectedValue(new Error("disk full"));
		await controller.attachImages();
		expect(controller.value.imageIds).toEqual([imageId]);
		expect(await controller.send({ type: "prompt", text: "不能丢失" })).toBe(false);
		expect(port.commands).toEqual([]);
		save.mockRestore();
		expect(await controller.flushDraft()).toBe(true);
		controller.dispose();
		logger.info("图片保存失败验证完成");
	});

	it("queues persisted images while working and rejects text-only models", async () => {
		logger.info("开始验证图片队列与模型边界");
		const port = imagePort();
		vi.spyOn(port, "selectImages").mockResolvedValue([imageId]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("看图");
		await controller.attachImages();
		if (port.current) port.current = { ...port.current, run: { phase: "working" } };
		await controller.refresh();
		expect(await controller.send({ type: "enqueue", mode: "followUp", text: "看图" })).toBe(true);
		expect(port.commands[0].command).toEqual({ type: "enqueue", mode: "followUp", text: "看图", imageIds: [imageId] });
		expect(controller.value.imageIds).toEqual([]);
		controller.setDraft("再看图");
		expect(await controller.attachImages()).toBe(true);
		port.current = snapshot();
		await controller.refresh();
		expect(await controller.send({ type: "prompt", text: "看图" })).toBe(false);
		expect(controller.value.error).toContain("不支持图片");
		expect(controller.value.imageIds).toEqual([imageId]);
		expect(port.commands).toHaveLength(1);
		controller.dispose();
		logger.info("图片队列与模型边界验证完成");
	});

	it("leaves input unchanged when image selection is cancelled, oversized or stale", async () => {
		logger.info("开始验证图片选择失败边界");
		const port = imagePort();
		const choose = vi.spyOn(port, "selectImages");
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("原草稿");
		expect(await controller.attachImages()).toBe(false);
		choose.mockResolvedValueOnce(["a", "b", "c", "d", "e"]);
		expect(await controller.attachImages()).toBe(false);
		expect(controller.value.imageIds).toEqual([]);
		let finish: (ids: string[]) => void = () => {};
		choose.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const selecting = controller.attachImages();
		if (port.current) port.current = { ...port.current, generation: "next-host" };
		await controller.refresh();
		finish([imageId]);
		expect(await selecting).toBe(false);
		expect(controller.value.imageIds).toEqual([]);
		expect(controller.value.draft).toBe("原草稿");
		controller.dispose();
		logger.info("图片选择失败边界验证完成");
	});
});
