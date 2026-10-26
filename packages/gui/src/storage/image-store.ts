import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { imageBatchSchema, imageDataSchema, imageIdSchema, imageIdsSchema } from "../shared/image-schema.ts";
import {
	IMAGE_BASE64_LIMIT,
	IMAGE_BYTES_LIMIT,
	IMAGE_COUNT_LIMIT,
	IMAGE_DIMENSION_LIMIT,
	IMAGE_PIXEL_LIMIT,
} from "../shared/images.ts";
import type { Logger } from "../shared/logger.ts";
import { writeJsonAtomically } from "./atomic-json.ts";

const blobSchema = z.object({ data: imageDataSchema });

function validateDimensions(width: number, height: number): void {
	if (
		!width ||
		!height ||
		width > IMAGE_DIMENSION_LIMIT ||
		height > IMAGE_DIMENSION_LIMIT ||
		width * height > IMAGE_PIXEL_LIMIT
	)
		throw new Error("图片尺寸过大，最长边不能超过 8192 像素，总像素不能超过 1600 万");
}

export function imageIdentity(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

/*
 * ========================================================================
 * 步骤1：在解码前约束 PNG 文件和像素尺寸
 * ========================================================================
 * 数据源：有界文件字节；不根据扩展名信任内容。
 * 操作：
 *   1) 检查 PNG 签名和 IHDR，拒绝过大尺寸与其他格式
 *   2) 完整解码由 Electron 接口完成，存储与宿主不依赖 Electron
 */
export function validatePng(bytes: Buffer, logger: Logger): void {
	logger.info("开始校验 PNG 图片边界");
	try {
		if (bytes.length > IMAGE_BYTES_LIMIT) throw new Error("每张图片不能超过 3 MiB");
		if (
			bytes.length < 33 ||
			!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
			bytes.readUInt32BE(8) !== 13 ||
			bytes.toString("ascii", 12, 16) !== "IHDR"
		)
			throw new Error("请选择有效的 PNG 图片");
		validateDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
	} finally {
		logger.info("PNG 图片边界校验结束");
	}
}

/*
 * ========================================================================
 * 步骤3：在原生解码前核对 JPEG 帧头
 * ========================================================================
 * 数据源：有界文件字节，不信任扩展名和 MIME。
 * 操作：
 *   1) 按段长度跳过元数据，识别基线、扩展顺序与渐进帧
 *   2) 在扫描数据前检查帧尺寸，截断或不支持的帧整批拒绝
 */
export function validateImageInput(bytes: Buffer, logger: Logger): void {
	logger.info("开始校验图片输入格式");
	try {
		// 3.1 PNG 继续复用规范内容校验，JPEG 只解析有界帧头。
		if (bytes.length > IMAGE_BYTES_LIMIT) throw new Error("每张图片不能超过 3 MiB");
		if (bytes.length >= 8 && bytes[0] === 137) {
			validatePng(bytes, logger);
			return;
		}
		if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
			let offset = 2;
			while (offset < bytes.length && bytes[offset] === 255) {
				while (bytes[offset] === 255) offset++;
				const marker = bytes[offset++];
				if (marker === 217 || marker === 218 || offset + 2 > bytes.length) break;
				const length = bytes.readUInt16BE(offset);
				if (length < 2 || offset + length > bytes.length) break;
				// 3.2 帧头不完整或含未知组件时不交给解码器分配像素。
				if (marker >= 192 && marker <= 194) {
					if (length < 11 || bytes[offset + 2] !== 8 || length !== 8 + 3 * bytes[offset + 7]) break;
					validateDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
					return;
				}
				offset += length;
			}
		}
		throw new Error("请选择有效的 PNG 或 JPEG 图片");
	} finally {
		logger.info("图片输入格式校验结束");
	}
}

async function readLimited(path: string, limit: number): Promise<Buffer> {
	const file = await open(path, "r").catch(() => {
		throw new Error("图片文件已失效或不可访问");
	});
	try {
		const details = await file.stat();
		if (!details.isFile()) throw new Error("请选择图片文件");
		if (details.size > limit) throw new Error("图片文件超过大小上限");
		// 1.1 固定读入上限，即使文件在 stat 后增长也不产生无界读取。
		const buffer = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < buffer.length) {
			const result = await file.read(buffer, length, buffer.length - length, length);
			if (!result.bytesRead) break;
			length += result.bytesRead;
		}
		if (length > limit) throw new Error("图片文件超过大小上限");
		return buffer.subarray(0, length);
	} finally {
		await file.close();
	}
}

/*
 * ========================================================================
 * 步骤2：按会话保存不可变图片内容
 * ========================================================================
 * 数据源：用户选择、粘贴或拖放的 PNG / JPEG，草稿只持有内容摘要。
 * 操作：
 *   1) 全批检查并解码后原子保存，文件内容不随每次草稿编辑重复写入
 *   2) 读取时核对摘要与 PNG 边界，不接受任意路径或跨会话身份
 */
export class ImageStore {
	private readonly directory: string;
	private readonly logger: Logger;
	constructor(directory: string, logger: Logger) {
		this.directory = directory;
		this.logger = logger;
	}

	private scope(cwd: string, sessionId: string): string {
		return join(this.directory, `images-${createHash("sha256").update(`${cwd}\0${sessionId}`).digest("hex")}`);
	}

	async importFiles(
		cwd: string,
		sessionId: string,
		paths: string[],
		normalize: (bytes: Buffer) => Buffer,
	): Promise<string[]> {
		return this.importSources(cwd, sessionId, paths, (path) => readLimited(path, IMAGE_BYTES_LIMIT), normalize);
	}

	async importData(
		cwd: string,
		sessionId: string,
		data: string[],
		normalize: (bytes: Buffer) => Buffer,
	): Promise<string[]> {
		return this.importSources(
			cwd,
			sessionId,
			imageBatchSchema.parse(data),
			async (value) => Buffer.from(value, "base64"),
			normalize,
		);
	}

	private async importSources<T>(
		cwd: string,
		sessionId: string,
		sources: T[],
		read: (source: T) => Promise<Buffer>,
		normalize: (bytes: Buffer) => Buffer,
	): Promise<string[]> {
		this.logger.info("开始保存所选图片");
		try {
			// 2.1 先校验整批，任何无效图片都不返回部分选择。
			if (sources.length > IMAGE_COUNT_LIMIT) throw new Error("每次最多选择 4 张图片");
			const images = new Map<string, string>();
			for (const source of sources) {
				const original = await read(source);
				validateImageInput(original, this.logger);
				const bytes = normalize(original);
				validatePng(bytes, this.logger);
				const data = bytes.toString("base64");
				images.set(imageIdentity(data), data);
			}
			// 2.2 失败可能留下无引用内容，但不会留下半写草稿或删除已有图片。
			for (const [id, data] of images)
				await writeJsonAtomically(this.scope(cwd, sessionId), `${id}.json`, { data }, this.logger);
			return [...images.keys()];
		} finally {
			this.logger.info("所选图片保存结束");
		}
	}

	async read(cwd: string, sessionId: string, imageId: string): Promise<string> {
		this.logger.info("开始读取会话图片");
		try {
			// 2.3 摘要不是路径；文件长度、内容格式和摘要必须同时匹配。
			const id = imageIdSchema.parse(imageId);
			const bytes = await readLimited(join(this.scope(cwd, sessionId), `${id}.json`), IMAGE_BASE64_LIMIT + 64);
			let data: string;
			try {
				data = blobSchema.parse(JSON.parse(bytes.toString("utf8"))).data;
			} catch {
				throw new Error("图片内容已损坏，请重新选择");
			}
			if (imageIdentity(data) !== id) throw new Error("图片内容已损坏，请重新选择");
			validatePng(Buffer.from(data, "base64"), this.logger);
			return data;
		} finally {
			this.logger.info("会话图片读取结束");
		}
	}

	async readMany(
		cwd: string,
		sessionId: string,
		ids: string[],
	): Promise<Array<{ type: "image"; mimeType: "image/png"; data: string }>> {
		const images: Array<{ type: "image"; mimeType: "image/png"; data: string }> = [];
		for (const id of imageIdsSchema.parse(ids))
			images.push({ type: "image", mimeType: "image/png", data: await this.read(cwd, sessionId, id) });
		return images;
	}
}
