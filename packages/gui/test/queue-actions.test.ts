import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentHost } from "../src/host/agent-host.ts";
import { PlanJournal } from "../src/host/plan-journal.ts";
import { QueueJournal } from "../src/host/queue-journal.ts";
import type { GuiCommand } from "../src/shared/protocol.ts";
import { ImageStore } from "../src/storage/image-store.ts";
import { pngFixture } from "./image-fixture.ts";
import { createHarness, getUserTexts } from "./sdk-harness.ts";

const logger = { info: vi.fn() };
function gate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/*
 * ========================================================================
 * 步骤1：让真实 SDK 在可控消费边界调整队列
 * ========================================================================
 * 数据源：同版内核、离线模型与独立图片和写前记录。
 * 操作：1) 暂停根请求及首条后续回复；2) 全程不访问真实服务商。
 */
async function fixture(extensions?: InlineExtension[]) {
	logger.info("开始创建队列并发回归环境");
	const h = await createHarness({ extensionFactories: extensions });
	const journal = new QueueJournal(join(h.tempDir, "queue"), h.tempDir, h.session.sessionId, logger);
	await journal.load();
	const images = new ImageStore(join(h.tempDir, "images"), logger);
	const host = new AgentHost(
		{ session: h.session, services: { modelRuntime: h.modelRuntime }, dispose: async () => {} },
		logger,
		journal,
		images,
		new PlanJournal(join(h.tempDir, "plans"), h.tempDir, h.session.sessionId, logger),
		h.authStorage,
	);
	const send = (command: GuiCommand) =>
		host.dispatch({
			requestId: crypto.randomUUID(),
			sessionId: host.snapshot.sessionId,
			generation: host.snapshot.generation,
			command,
		});
	const root = gate();
	const first = gate();
	const rootEntered = gate();
	const firstEntered = gate();
	h.setResponses([
		async () => {
			rootEntered.release();
			await root.promise;
			return fauxAssistantMessage("root done");
		},
		async () => {
			firstEntered.release();
			await first.promise;
			return fauxAssistantMessage("first done");
		},
		fauxAssistantMessage("second done"),
		fauxAssistantMessage("third done"),
	]);
	const running = send({ type: "prompt", text: "root" });
	await rootEntered.promise;
	logger.info("队列并发回归环境创建完成");
	return {
		h,
		host,
		journal,
		images,
		send,
		root,
		first,
		firstEntered,
		running,
		async close() {
			root.release();
			first.release();
			await running;
			await host.dispose();
			h.cleanup();
		},
	};
}

describe("queue mutation with real SDK", () => {
	/*
	 * ========================================================================
	 * 步骤2：验证扩展回调后的附件与停止边界
	 * ========================================================================
	 * 数据源：可控输入扩展、真实待消费队列与图片内容库。
	 * 操作：1) 附件变换同步恢复记录；2) 迟到回调不能启动或追加任务。
	 */
	it("keeps edited image transformations consistent with recovery and the core message", async () => {
		logger.info("开始验证编辑图片变换");
		const f = await fixture([
			(pi) => {
				pi.on("input", (event) => {
					if (event.text === "drop-images") return { action: "transform", text: "removed images", images: [] };
					if (event.text === "add-images")
						return {
							action: "transform",
							text: "added images",
							images: [{ type: "image", mimeType: "image/png", data: pngFixture }],
						};
					if (event.text === "unsupported-images")
						return {
							action: "transform",
							text: "invalid image",
							images: [{ type: "image", mimeType: "image/jpeg", data: pngFixture }],
						};
				});
			},
		]);
		try {
			// 2.1 图片先删除再由扩展添加，所有引用均跟随实际消息变化。
			const model = f.h.session.model;
			if (!model) throw new Error("model missing");
			vi.spyOn(f.h.session, "model", "get").mockReturnValue({ ...model, input: ["text", "image"] });
			const imageIds = await f.images.importData(
				f.host.snapshot.cwd,
				f.h.session.sessionId,
				[pngFixture],
				(bytes) => bytes,
			);
			await f.send({ type: "enqueue", mode: "followUp", text: "A", imageIds });
			const itemId = f.host.snapshot.queue.followUp[0].id as string;
			await f.send({ type: "queueAction", action: "edit", itemId, text: "drop-images" });
			expect(f.host.snapshot.queue.followUp[0]).toEqual({ id: itemId, text: "removed images" });
			expect(f.journal.interrupted.followUp).toEqual([{ text: "removed images" }]);
			await f.send({ type: "queueAction", action: "edit", itemId, text: "add-images" });
			expect(f.host.snapshot.queue.followUp[0]).toEqual({ id: itemId, text: "added images", imageIds });
			expect(f.journal.interrupted.followUp).toEqual([{ text: "added images", imageIds }]);
			await expect(f.send({ type: "queueAction", action: "edit", itemId, text: "unsupported-images" })).rejects.toThrow(
				"PNG",
			);
			expect(f.host.snapshot.queue.followUp[0].text).toBe("added images");
			f.root.release();
			f.first.release();
			await f.running;
			expect(getUserTexts(f.h)).toEqual(["root", "added images"]);
			const message = f.h.session.messages.filter((entry) => entry.role === "user")[1];
			expect(
				typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "image"),
			).toEqual([{ type: "image", mimeType: "image/png", data: pngFixture }]);
		} finally {
			await f.close();
			logger.info("编辑图片变换验证结束");
		}
	});

	it.each(["settle", "stop"])(
		"rejects asynchronous input arriving after %s without starting another run",
		async (action) => {
			logger.info("开始验证异步输入迟到");
			const entered = gate();
			const waiting = gate();
			const f = await fixture([
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "late-input") return;
						entered.release();
						await waiting.promise;
						return { action: "continue" };
					});
				},
			]);
			try {
				// 2.2 在输入钩子内部暂停，允许模型先收束或用户先停止。
				const rejected = expect(f.send({ type: "enqueue", mode: "followUp", text: "late-input" })).rejects.toThrow(
					"收束或暂停",
				);
				await entered.promise;
				const stopping = action === "stop" ? f.send({ type: "abort" }) : undefined;
				f.root.release();
				if (action === "settle") await vi.waitFor(() => expect(f.h.session.isStreaming).toBe(false));
				waiting.release();
				await rejected;
				await stopping;
				await f.running;
				expect(getUserTexts(f.h)).toEqual(["root"]);
				expect(f.host.snapshot.queue.followUp).toEqual([]);
				expect(f.journal.count).toBe(0);
			} finally {
				waiting.release();
				await f.close();
				logger.info("异步输入迟到验证结束");
			}
		},
	);

	it("preserves immediate extension commands without adding recovery entries", async () => {
		logger.info("开始验证即时扩展命令");
		const invoked = vi.fn();
		const f = await fixture([(pi) => pi.registerCommand("offline-status", { handler: invoked })]);
		try {
			// 2.3 普通输入保留 SDK 即时命令语义，但不生成虚假的排队记录。
			await f.send({ type: "enqueue", mode: "followUp", text: "/offline-status" });
			expect(invoked).toHaveBeenCalledTimes(1);
			expect(f.host.snapshot.queue.followUp).toEqual([]);
			expect(f.journal.count).toBe(0);
		} finally {
			await f.close();
			logger.info("即时扩展命令验证结束");
		}
	});

	it("does not replay A when A is consumed during removal of B", async () => {
		logger.info("开始验证消费期间删除不重放");
		const f = await fixture();
		try {
			// 1.1 写前保存期间让 A 被消费，B 仍待处理；提交只删除 B。
			await f.send({ type: "enqueue", mode: "followUp", text: "A" });
			await f.send({ type: "enqueue", mode: "followUp", text: "B" });
			const itemId = f.host.snapshot.queue.followUp[1].id as string;
			const amend = f.journal.amend.bind(f.journal);
			vi.spyOn(f.journal, "amend").mockImplementationOnce(async (...args) => {
				const undo = await amend(...args);
				f.root.release();
				await f.firstEntered.promise;
				return undo;
			});
			await f.send({ type: "queueAction", action: "remove", itemId });
			f.first.release();
			await f.running;
			expect(getUserTexts(f.h)).toEqual(["root", "A"]);
			expect(f.journal.count).toBe(0);
		} finally {
			await f.close();
			logger.info("消费期间删除不重放验证完成");
		}
	});

	it("edits the original B after A leaves and rejects the identity after B is removed", async () => {
		logger.info("开始验证编辑身份不会随数组下标移动");
		const f = await fixture();
		try {
			// 1.2 编辑开始于 A/B/C，保存发生于 B/C，仍只改 B。
			for (const text of ["A", "B", "C"]) await f.send({ type: "enqueue", mode: "followUp", text });
			const itemId = f.host.snapshot.queue.followUp[1].id as string;
			f.root.release();
			await f.firstEntered.promise;
			await f.send({ type: "queueAction", action: "edit", itemId, text: "edited B" });
			expect(f.host.snapshot.queue.followUp.map((item) => item.text)).toEqual(["edited B", "C"]);
			await f.send({ type: "queueAction", action: "remove", itemId });
			await expect(f.send({ type: "queueAction", action: "edit", itemId, text: "stale" })).rejects.toThrow("已不存在");
			f.first.release();
			await f.running;
			expect(getUserTexts(f.h)).toEqual(["root", "A", "C"]);
		} finally {
			await f.close();
			logger.info("编辑稳定身份验证完成");
		}
	});

	it("keeps A/B/C when an extension command or persistence rejects the edit", async () => {
		logger.info("开始验证编辑失败保留完整队列");
		const invoked = vi.fn();
		const f = await fixture([(pi) => pi.registerCommand("audit-noqueue", { handler: invoked })]);
		try {
			// 1.3 失败发生于任何变更之前，后续 C 和恢复文件都不能丢失。
			for (const text of ["A", "B", "C"]) await f.send({ type: "enqueue", mode: "followUp", text });
			const itemId = f.host.snapshot.queue.followUp[1].id as string;
			await expect(f.send({ type: "queueAction", action: "edit", itemId, text: "/audit-noqueue" })).rejects.toThrow(
				"cannot be queued",
			);
			expect(invoked).not.toHaveBeenCalled();
			vi.spyOn(f.journal, "amend").mockRejectedValueOnce(new Error("disk full"));
			await expect(f.send({ type: "queueAction", action: "edit", itemId, text: "changed" })).rejects.toThrow(
				"disk full",
			);
			expect(f.host.snapshot.queue.followUp.map((item) => item.text)).toEqual(["A", "B", "C"]);
			expect(f.journal.interrupted.followUp.map((item) => item.text)).toEqual(["A", "B", "C"]);
			f.root.release();
			f.first.release();
			await f.running;
			expect(getUserTexts(f.h)).toEqual(["root", "A", "B", "C"]);
		} finally {
			await f.close();
			logger.info("编辑失败保留队列验证完成");
		}
	});

	it("rejects consumed targets and rolls back the write-ahead edit", async () => {
		logger.info("开始验证迟到编辑拒绝与记录回滚");
		const f = await fixture();
		try {
			await f.send({ type: "enqueue", mode: "followUp", text: "A" });
			await f.send({ type: "enqueue", mode: "followUp", text: "B" });
			const itemId = f.host.snapshot.queue.followUp[0].id as string;
			const amend = f.journal.amend.bind(f.journal);
			vi.spyOn(f.journal, "amend").mockImplementationOnce(async (...args) => {
				const undo = await amend(...args);
				f.root.release();
				await f.firstEntered.promise;
				return undo;
			});
			await expect(f.send({ type: "queueAction", action: "edit", itemId, text: "edited A" })).rejects.toThrow(
				"开始处理",
			);
			expect(f.journal.interrupted.followUp.map((item) => item.text)).toEqual(["A", "B"]);
			f.first.release();
			await f.running;
			expect(getUserTexts(f.h)).toEqual(["root", "A", "B"]);
		} finally {
			await f.close();
			logger.info("迟到编辑与回滚验证完成");
		}
	});

	it("rejects an in-flight core message even before its message_start is delivered", async () => {
		logger.info("开始验证已取走但尚未展示的消息");
		const f = await fixture();
		try {
			await f.send({ type: "enqueue", mode: "followUp", text: "A" });
			const itemId = f.host.snapshot.queue.followUp[0].id as string;
			// 1.4 模拟核心已 drain、SDK 展示尚未撤下的交接窗口。
			f.h.session.agent.clearFollowUpQueue();
			await expect(f.send({ type: "queueAction", action: "remove", itemId })).rejects.toThrow("开始处理");
			expect(f.journal.interrupted.followUp.map((item) => item.text)).toEqual(["A"]);
		} finally {
			await f.close();
			logger.info("在途核心消息边界验证完成");
		}
	});

	it("serializes mutations and preserves originals if stop crosses the journal write", async () => {
		logger.info("开始验证连点和停止交错");
		const f = await fixture();
		const saving = gate();
		const entered = gate();
		try {
			await f.send({ type: "enqueue", mode: "followUp", text: "A" });
			const itemId = f.host.snapshot.queue.followUp[0].id as string;
			const amend = f.journal.amend.bind(f.journal);
			vi.spyOn(f.journal, "amend").mockImplementationOnce(async (...args) => {
				entered.release();
				await saving.promise;
				return amend(...args);
			});
			const editing = expect(f.send({ type: "queueAction", action: "edit", itemId, text: "edited A" })).rejects.toThrow(
				"暂停",
			);
			await entered.promise;
			await expect(f.send({ type: "queueAction", action: "remove", itemId })).rejects.toThrow("尚未结束");
			const stopping = f.send({ type: "abort" });
			saving.release();
			f.root.release();
			f.first.release();
			await editing;
			await stopping;
			await f.running;
			expect(getUserTexts(f.h)).toEqual(["root"]);
			expect(f.host.snapshot.queue.recovery.followUp.map((item) => item.text)).toEqual(["A"]);
		} finally {
			saving.release();
			await f.close();
			logger.info("连点和停止交错验证完成");
		}
	});

	it("moves one repeated-text message with images without reprocessing the other", async () => {
		logger.info("开始验证引导附件身份");
		const f = await fixture();
		try {
			const model = f.h.session.model;
			if (!model) throw new Error("model missing");
			vi.spyOn(f.h.session, "model", "get").mockReturnValue({ ...model, input: ["text", "image"] });
			const imageIds = await f.images.importData(
				f.host.snapshot.cwd,
				f.h.session.sessionId,
				[pngFixture],
				(bytes) => bytes,
			);
			await f.send({ type: "enqueue", mode: "followUp", text: "same", imageIds });
			await f.send({ type: "enqueue", mode: "followUp", text: "same" });
			const itemId = f.host.snapshot.queue.followUp[0].id as string;
			const untouched = f.host.snapshot.queue.followUp[1].id;
			await f.send({ type: "queueAction", action: "steer", itemId });
			expect(f.host.snapshot.queue.steering[0]).toMatchObject({ id: itemId, imageIds });
			expect(f.host.snapshot.queue.followUp[0]).toEqual({ id: untouched, text: "same" });
			f.root.release();
			f.first.release();
			await f.running;
			expect(getUserTexts(f.h)).toEqual(["root", "same", "same"]);
			const users = f.h.session.messages.filter((message) => message.role === "user");
			expect(
				users.map((message) =>
					typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "image").length,
				),
			).toEqual([0, 1, 0]);
		} finally {
			await f.close();
			logger.info("引导附件身份验证完成");
		}
	});
});
