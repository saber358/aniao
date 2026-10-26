import { describe, expect, it, vi } from "vitest";
import { readImageFiles } from "../src/renderer/adapters/image-input.ts";
import { IMAGE_BYTES_LIMIT } from "../src/shared/images.ts";
import { pngFixture } from "./image-fixture.ts";

const logger = { info: vi.fn() };

/*
 * ========================================================================
 * 步骤1：验证事件文件的有界读取与编码
 * ========================================================================
 * 数据源：真实 File 对象和可控读取失败，不访问系统剪贴板。
 * 操作：
 *   1) PNG / JPEG 识别只作为早期提示，保留完整字节供主进程验证
 *   2) 整批元数据先检查，大小、数量、读取失败不产生部分批次
 */
describe("Image event files", () => {
	it("encodes PNG bytes exactly and accepts PNG filenames when the browser omits the MIME", async () => {
		logger.info("开始验证图片事件文件编码");
		try {
			const file = new File([Buffer.from(pngFixture, "base64")], "中文 图片.png", { type: "image/png" });
			const unnamedMime = new File([Buffer.from(pngFixture, "base64")], "中文 图片.PNG");
			const jpeg = new File([Buffer.from(pngFixture, "base64")], "相机.JPEG", { type: "image/jpeg" });
			const jpegName = new File([Buffer.from(pngFixture, "base64")], "相机.JPG");
			expect(await readImageFiles([file, unnamedMime, jpeg, jpegName], logger)).toEqual(Array(4).fill(pngFixture));
			const binary = Uint8Array.from({ length: 128 * 1024 }, (_value, index) => index % 256);
			expect(await readImageFiles([new File([binary], "large.png", { type: "image/png" })], logger)).toEqual([
				Buffer.from(binary).toString("base64"),
			]);
		} finally {
			logger.info("图片事件文件编码验证完成");
		}
	});

	it("rejects unsupported, empty, excessive or oversized batches before reading any file", async () => {
		logger.info("开始验证图片事件元数据边界");
		try {
			const valid = new File([Buffer.from(pngFixture, "base64")], "valid.png", { type: "image/png" });
			const read = vi.spyOn(valid, "arrayBuffer");
			for (const invalid of [
				new File(["gif"], "fake.png", { type: "image/gif" }),
				new File(["text"], "source.ts"),
				new File([], "empty.png", { type: "image/png" }),
				new File([new Uint8Array(IMAGE_BYTES_LIMIT + 1)], "huge.png", { type: "image/png" }),
			]) {
				await expect(readImageFiles([valid, invalid], logger)).rejects.toThrow();
			}
			await expect(readImageFiles(Array(5).fill(valid), logger)).rejects.toThrow("最多添加");
			await expect(readImageFiles([], logger)).rejects.toThrow("未读取到");
			expect(read).not.toHaveBeenCalled();
		} finally {
			logger.info("图片事件元数据边界验证完成");
		}
	});

	it("does not return a partial batch when a file fails or changes during reading", async () => {
		logger.info("开始验证图片事件读取失败");
		try {
			const valid = new File([Buffer.from(pngFixture, "base64")], "valid.png", { type: "image/png" });
			const changed = new File(["png"], "changed.png", { type: "image/png" });
			const read = vi.spyOn(changed, "arrayBuffer").mockRejectedValueOnce(new Error("file unavailable"));
			await expect(readImageFiles([valid, changed], logger)).rejects.toThrow("file unavailable");
			read.mockResolvedValueOnce(new ArrayBuffer(100));
			await expect(readImageFiles([valid, changed], logger)).rejects.toThrow("内容已变化");
		} finally {
			logger.info("图片事件读取失败验证完成");
		}
	});
});
