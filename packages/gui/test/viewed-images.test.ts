import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SessionAdapter } from "../src/host/session-adapter.ts";
import { toChatView } from "../src/renderer/adapters/chat-view.ts";
import { imageUrlSchema } from "../src/shared/image-schema.ts";
import { snapshotSchema, type ToolActivity } from "../src/shared/protocol.ts";
import { snapshot } from "./fixtures.ts";
import { pngFixture } from "./image-fixture.ts";
import { createHarness } from "./sdk-harness.ts";

const logger = { info: vi.fn() };
const firstImage = "a".repeat(64);
const secondImage = "b".repeat(64);
const thirdImage = "c".repeat(64);

/*
 * ========================================================================
 * 步骤1：验证图片事实穿过 SDK、快照和步骤映射
 * ========================================================================
 * 数据源：真实离线 SDK、原生图片读取与工具历史。
 * 操作：1) 图片负载不进入快照；2) 只有实际成功的图片结果使用查看步骤。
 */
describe("viewed image steps", () => {
	it("preserves native read images in live events and restored history without embedding their bytes", async () => {
		logger.info("开始验证真实图片读取与历史恢复");
		const harness = await createHarness();
		const adapter = new SessionAdapter(harness.session, snapshot().configuration, logger);
		await writeFile(join(harness.tempDir, "截图.png"), Buffer.from(pngFixture, "base64"));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "截图.png" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("图片查看完成"),
		]);
		try {
			// 1.1 正式 read 工具实际返回图片，快照只持有可查询的身份。
			await harness.session.prompt("查看截图");
			const current = adapter.snapshot;
			const imageId = current.tools[0].imageIds?.[0];
			if (!imageId) throw new Error("SDK 图片结果没有进入快照");
			expect(current.tools[0].state).toBe("succeeded");
			expect(JSON.stringify(current)).not.toContain(pngFixture);
			expect(snapshotSchema.safeParse(current).success).toBe(true);
			expect(adapter.getImage(imageId)).toBe(`data:image/png;base64,${pngFixture}`);
			const restored = new SessionAdapter(harness.session, snapshot().configuration, logger);
			try {
				expect(restored.snapshot.tools[0].imageIds).toEqual([imageId]);
				expect(restored.getImage(imageId)).toBe(adapter.getImage(imageId));
			} finally {
				restored.dispose();
			}
		} finally {
			adapter.dispose();
			harness.cleanup();
			logger.info("真实图片读取与历史恢复验证结束");
		}
	});
	it("keeps more than four tool images and rejects invalid MIME or base64 data", async () => {
		logger.info("开始验证工具图片格式与数量边界");
		const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
		const harness = await createHarness();
		const call = fauxToolCall("read", {});
		harness.session.agent.state.messages = [
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: "read",
				isError: false,
				timestamp: 1,
				content: [
					...Array.from({ length: 5 }, () => ({ type: "image" as const, mimeType: "image/png", data: pngFixture })),
					{ type: "image" as const, mimeType: "image/gif", data: gif },
					{ type: "image" as const, mimeType: "image/svg+xml", data: "PHN2Zy8+" },
					{ type: "image" as const, mimeType: "image/png", data: `${pngFixture} ` },
				],
			},
		];
		const adapter = new SessionAdapter(harness.session, snapshot().configuration, logger);
		try {
			// 1.2 工具输出不继承用户草稿四张上限，重复查看仍保留次数。
			const ids = adapter.snapshot.tools[0].imageIds ?? [];
			expect(ids).toHaveLength(6);
			expect(new Set(ids).size).toBe(2);
			expect(adapter.getImage(ids[5])).toBe(`data:image/gif;base64,${gif}`);
			expect(imageUrlSchema.safeParse(adapter.getImage(ids[5])).success).toBe(true);
			expect(imageUrlSchema.safeParse("data:image/svg+xml;base64,PHN2Zy8+").success).toBe(false);
			expect(snapshotSchema.safeParse(adapter.snapshot).success).toBe(true);
		} finally {
			adapter.dispose();
			harness.cleanup();
			logger.info("工具图片格式与数量边界验证结束");
		}
	});
	it.each([false, true])("groups adjacent image reads and preserves other steps (collapsed: %s)", (collapseTurns) => {
		logger.info("开始验证图片步骤分组与顺序");
		try {
			const tools: ToolActivity[] = [
				{
					id: "one",
					messageId: "a",
					name: "read",
					input: "{}",
					output: "",
					truncated: false,
					state: "succeeded",
					imageIds: [firstImage],
				},
				{
					id: "two",
					messageId: "a",
					name: "read",
					input: "{}",
					output: "",
					truncated: false,
					state: "succeeded",
					imageIds: [secondImage, firstImage],
				},
				{
					id: "text",
					messageId: "a",
					name: "read",
					input: JSON.stringify({ path: "说明.txt" }),
					output: "text",
					truncated: false,
					state: "succeeded",
				},
				{
					id: "three",
					messageId: "a",
					name: "read",
					input: "{}",
					output: "",
					truncated: false,
					state: "succeeded",
					imageIds: [thirdImage],
				},
			];
			// 1.3 图片连续分组，普通文件读取仍打断分组并保持原位置。
			const messages = toChatView(
				[
					{ id: "u", role: "user", blocks: [{ kind: "text", text: "查看" }] },
					{ id: "a", role: "assistant", blocks: [] },
				],
				tools,
				{ collapseTurns },
			);
			const parts = messages
				.flatMap((message) => message.parts)
				.filter((part) => part.type !== "text" && part.type !== "data-turn");
			expect(parts).toEqual([
				{ type: "data-viewedImages", data: { id: "one", imageIds: [firstImage, secondImage, firstImage] } },
				{ type: "data-tool", data: tools[2] },
				{ type: "data-viewedImages", data: { id: "three", imageIds: [thirdImage] } },
			]);
			expect(tools[0].imageIds).toEqual([firstImage]);
		} finally {
			logger.info("图片步骤分组与顺序验证结束");
		}
	});
	it("does not turn failed, pending or extension-only image paths into completed views", () => {
		logger.info("开始验证图片查看的成功边界");
		try {
			const tools: ToolActivity[] = [
				{
					id: "pending",
					messageId: "a",
					name: "read",
					input: JSON.stringify({ path: "image.png" }),
					output: "",
					truncated: false,
					state: "running",
				},
				{
					id: "failed",
					messageId: "a",
					name: "read",
					input: "{}",
					output: "error",
					truncated: false,
					state: "failed",
					imageIds: [firstImage],
				},
				{
					id: "text",
					messageId: "a",
					name: "read",
					input: JSON.stringify({ path: "fake.png" }),
					output: "not an image",
					truncated: false,
					state: "succeeded",
				},
			];
			// 1.4 文件后缀和失败结果不能冒充成功查看。
			const messages = toChatView([{ id: "a", role: "assistant", blocks: [] }], tools, { running: true });
			expect(messages[0].parts).toEqual(tools.map((tool) => ({ type: "data-tool", data: tool })));
		} finally {
			logger.info("图片查看的成功边界验证结束");
		}
	});
});
