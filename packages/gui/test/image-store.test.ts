import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "../src/main/workspace-store.ts";
import { IMAGE_BASE64_LIMIT, IMAGE_BYTES_LIMIT } from "../src/shared/images.ts";
import { imageImportSchema } from "../src/shared/workspace.ts";
import { ImageStore, imageIdentity, validateImageInput, validatePng } from "../src/storage/image-store.ts";
import { pngFixture } from "./image-fixture.ts";

const logger = { info: vi.fn() };
const directories: string[] = [];

/*
 * ========================================================================
 * 步骤1：验证图片内容库与草稿引用的持久化
 * ========================================================================
 * 数据源：有界 PNG 字节、独立临时目录和损坏存储。
 * 操作：
 *   1) 原文件移除后仍能读取，其他项目或会话不能读取同一身份
 *   2) 无效整批、像素上限、损坏摘要与旧修订不会覆盖原草稿
 */
describe("ImageStore", () => {
	/*
	 * ========================================================================
	 * 步骤3：验证 JPEG 输入在解码前受到同等边界约束
	 * ========================================================================
	 * 数据源：最小帧头与可控规范化回调；完整解码另由 Electron 验收。
	 * 操作：
	 *   1) 顺序与渐进帧可归一化为相同 PNG 身份
	 *   2) 截断、异常段长、无帧头与超大像素在解码前拒绝
	 */
	it("validates JPEG frame boundaries before normalization and stores canonical PNG identities", async () => {
		logger.info("开始验证 JPEG 帧边界与内容归一化");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-images-"));
			directories.push(directory);
			const store = new ImageStore(join(directory, "state"), logger);
			// 3.1 帧前含一个 APP 段；测试只证明头部检查，回调模拟原生解码。
			const jpeg = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, 0, 32, 0, 64, 1, 1, 17, 0]);
			const normalize = vi.fn(() => Buffer.from(pngFixture, "base64"));
			const ids = await store.importData("cwd", "s", [jpeg.toString("base64"), pngFixture], normalize);
			expect(ids).toEqual([imageIdentity(pngFixture)]);
			jpeg[9] = 194;
			expect(() => validateImageInput(jpeg, logger)).not.toThrow();
			for (const invalid of [
				jpeg.subarray(0, 17),
				Buffer.from([255, 216, 255, 224, 255, 255]),
				Buffer.from([255, 216, 255, 218, 0, 2]),
			])
				expect(() => validateImageInput(invalid, logger)).toThrow("有效的 PNG 或 JPEG");
			jpeg.writeUInt16BE(8193, 15);
			normalize.mockClear();
			await expect(store.importData("cwd", "s", [jpeg.toString("base64")], normalize)).rejects.toThrow("尺寸过大");
			expect(normalize).not.toHaveBeenCalled();
		} finally {
			logger.info("JPEG 帧边界与内容归一化验证完成");
		}
	});
	afterEach(async () => {
		for (const directory of directories.splice(0)) {
			if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("pi-gui-images-"))
				throw new Error("Unexpected temporary directory");
			await rm(directory, { recursive: true, force: true });
		}
	});
	/*
	 * ========================================================================
	 * 步骤2：验证粘贴与拖放内容复用图片库
	 * ========================================================================
	 * 数据源：有界 base64 批次、原生文件与可控解码回调。
	 * 操作：
	 *   1) 不同入口产生相同内容身份，图片可脱离原文件恢复
	 *   2) 传输、像素和解码失败均在返回身份前整批拒绝
	 */
	it("imports transferred content through the same canonical identities as native files", async () => {
		logger.info("开始验证传入图片内容复用");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-images-"));
			directories.push(directory);
			const file = join(directory, "native.png");
			await writeFile(file, Buffer.from(pngFixture, "base64"));
			const state = join(directory, "state");
			const store = new ImageStore(state, logger);
			const nativeIds = await store.importFiles("cwd", "s", [file], (bytes) => bytes);
			const ids = await store.importData("cwd", "s", [pngFixture, pngFixture], (bytes) => bytes);
			expect(ids).toEqual(nativeIds);
			await unlink(file);
			expect(await new ImageStore(state, logger).read("cwd", "s", ids[0])).toBe(pngFixture);
			expect((await readdir(state, { recursive: true })).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		} finally {
			logger.info("传入图片内容复用验证完成");
		}
	});

	it("bounds transfer payloads before decoding and rejects mixed or oversized batches without storing them", async () => {
		logger.info("开始验证图片传输批次边界");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-images-"));
			directories.push(directory);
			const state = join(directory, "state");
			const store = new ImageStore(state, logger);
			const normalize = vi.fn((bytes: Buffer) => bytes);
			const selection = { sessionId: "s", generation: "host" };
			for (const data of [[], Array(5).fill(pngFixture), ["bad!"], ["A".repeat(IMAGE_BASE64_LIMIT + 4)]]) {
				expect(imageImportSchema.safeParse({ ...selection, data }).success).toBe(false);
				await expect(store.importData("cwd", "s", data, normalize)).rejects.toThrow();
			}
			expect(normalize).not.toHaveBeenCalled();
			await expect(store.importData("cwd", "s", [pngFixture, "bm90IGEgcG5n"], normalize)).rejects.toThrow("有效的 PNG");
			await expect(readdir(state)).rejects.toThrow();
			const huge = Buffer.from(pngFixture, "base64");
			huge.writeUInt32BE(8193, 16);
			normalize.mockClear();
			await expect(store.importData("cwd", "s", [huge.toString("base64")], normalize)).rejects.toThrow("尺寸过大");
			expect(normalize).not.toHaveBeenCalled();
		} finally {
			logger.info("图片传输批次边界验证完成");
		}
	});

	it("rejects decode failures and checks the normalized output before persistence", async () => {
		logger.info("开始验证传入图片解码失败");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-images-"));
			directories.push(directory);
			const state = join(directory, "state");
			const store = new ImageStore(state, logger);
			await expect(
				store.importData("cwd", "s", [pngFixture], () => {
					throw new Error("decode failed");
				}),
			).rejects.toThrow("decode failed");
			await expect(
				store.importData("cwd", "s", [pngFixture], () => Buffer.alloc(IMAGE_BYTES_LIMIT + 1)),
			).rejects.toThrow("不能超过");
			await expect(readdir(state)).rejects.toThrow();
		} finally {
			logger.info("传入图片解码失败验证完成");
		}
	});
	it("accepts the exact transfer byte limit without exceeding the validation stack", async () => {
		logger.info("开始验证图片传输上限内有效输入");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-images-"));
			directories.push(directory);
			const store = new ImageStore(join(directory, "state"), logger);
			const bytes = Buffer.alloc(IMAGE_BYTES_LIMIT);
			Buffer.from(pngFixture, "base64").copy(bytes);
			const [id] = await store.importData("cwd", "s", [bytes.toString("base64")], () =>
				Buffer.from(pngFixture, "base64"),
			);
			expect(await store.read("cwd", "s", id)).toBe(pngFixture);
		} finally {
			logger.info("图片传输上限内有效输入验证完成");
		}
	});
	it("stores canonical content once per identity and reads independently of the source file", async () => {
		logger.info("开始验证图片内容恢复");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-images-"));
			directories.push(directory);
			const file = join(directory, "中文 图片.png");
			await writeFile(file, Buffer.from(pngFixture, "base64"));
			const state = join(directory, "state");
			const store = new ImageStore(state, logger);
			const [id] = await store.importFiles("cwd", "session", [file, file], (bytes) => bytes);
			expect(id).toBe(imageIdentity(pngFixture));
			await unlink(file);
			const restored = new ImageStore(state, logger);
			expect(await restored.read("cwd", "session", id)).toBe(pngFixture);
			await expect(restored.read("other", "session", id)).rejects.toThrow("已失效");
			await expect(restored.read("cwd", "other", id)).rejects.toThrow("已失效");
			expect((await readdir(state, { recursive: true })).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		} finally {
			logger.info("图片内容恢复验证完成");
		}
	});
	it("rejects invalid batches before persistence and bounds file size, dimensions and counts", async () => {
		logger.info("开始验证图片输入边界");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-images-"));
			directories.push(directory);
			const valid = join(directory, "valid.png");
			const invalid = join(directory, "fake.png");
			await writeFile(valid, Buffer.from(pngFixture, "base64"));
			await writeFile(invalid, "not an image");
			const state = join(directory, "state");
			const store = new ImageStore(state, logger);
			await expect(store.importFiles("cwd", "s", [valid, invalid], (bytes) => bytes)).rejects.toThrow("有效的 PNG");
			await expect(readdir(state)).rejects.toThrow();
			await expect(store.importFiles("cwd", "s", Array(5).fill(valid), (bytes) => bytes)).rejects.toThrow("最多选择");
			await writeFile(invalid, Buffer.alloc(IMAGE_BYTES_LIMIT + 1));
			await expect(store.importFiles("cwd", "s", [invalid], (bytes) => bytes)).rejects.toThrow("大小上限");
			const huge = Buffer.from(pngFixture, "base64");
			huge.writeUInt32BE(8193, 16);
			expect(() => validatePng(huge, logger)).toThrow("尺寸过大");
			huge.writeUInt32BE(5000, 16);
			huge.writeUInt32BE(5000, 20);
			expect(() => validatePng(huge, logger)).toThrow("尺寸过大");
		} finally {
			logger.info("图片输入边界验证完成");
		}
	});
	it("rejects corrupted content and path-shaped identities without repairing stored data", async () => {
		logger.info("开始验证图片内容完整性");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-images-"));
			directories.push(directory);
			const file = join(directory, "valid.png");
			await writeFile(file, Buffer.from(pngFixture, "base64"));
			const store = new ImageStore(join(directory, "state"), logger);
			const [id] = await store.importFiles("cwd", "s", [file], (bytes) => bytes);
			const folder = (await readdir(join(directory, "state")))[0];
			await writeFile(join(directory, "state", folder, `${id}.json`), JSON.stringify({ data: "AAAA" }));
			await expect(store.read("cwd", "s", id)).rejects.toThrow("内容已损坏");
			await writeFile(join(directory, "state", folder, `${id}.json`), `invalid-json-${pngFixture}`);
			await expect(store.read("cwd", "s", id)).rejects.toThrow("图片内容已损坏，请重新选择");
			await expect(store.read("cwd", "s", "../secret")).rejects.toThrow();
		} finally {
			logger.info("图片内容完整性验证完成");
		}
	});
	it("persists image-only draft edits with revisions and removes references without deleting content", async () => {
		logger.info("开始验证图片草稿修订");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-images-"));
			directories.push(directory);
			await mkdir(join(directory, "state"));
			const store = new WorkspaceStore(join(directory, "state"), logger);
			const imageIds = [imageIdentity(pngFixture)];
			await store.saveDraft("cwd", { sessionId: "s", revision: 0, text: "说明", imageIds });
			expect(await new WorkspaceStore(join(directory, "state"), logger).loadDraft("cwd", "s")).toEqual({
				text: "说明",
				revision: 1,
				imageIds,
			});
			await expect(store.saveDraft("cwd", { sessionId: "s", revision: 0, text: "旧内容" })).rejects.toThrow("其他界面");
			expect(await store.saveDraft("cwd", { sessionId: "s", revision: 1, text: "说明" })).toEqual({
				text: "说明",
				revision: 2,
			});
		} finally {
			logger.info("图片草稿修订验证完成");
		}
	});
});
