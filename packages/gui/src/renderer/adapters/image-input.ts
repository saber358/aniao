import {
	IMAGE_BYTES_LIMIT,
	IMAGE_COUNT_LIMIT,
	IMAGE_INPUT_EXTENSIONS,
	IMAGE_INPUT_MIME_TYPES,
} from "../../shared/images.ts";
import type { Logger } from "../../shared/logger.ts";

/*
 * ========================================================================
 * 步骤1：把用户事件中的图片文件转成有界内容批次
 * ========================================================================
 * 数据源：浏览器 paste / drop 事件提供的 File，不读取路径或远程 URL。
 * 操作：
 *   1) 整批核对格式提示、数量和大小后才读取，逐张编码避免并行占用
 *   2) MIME 与扩展名只作早期提示，主进程仍核对内容并完整解码
 */
export async function readImageFiles(files: readonly File[], logger: Logger): Promise<string[]> {
	logger.info("开始读取输入区图片文件");
	try {
		// 1.1 无效混选整批拒绝，普通文件不被自动转成引用或提示词。
		if (!files.length) throw new Error("未读取到图片文件");
		if (files.length > IMAGE_COUNT_LIMIT) throw new Error("每次最多添加 4 张图片");
		if (
			files.some((file) =>
				file.type
					? !IMAGE_INPUT_MIME_TYPES.includes(file.type)
					: !IMAGE_INPUT_EXTENSIONS.includes(file.name.split(".").at(-1)?.toLowerCase() ?? ""),
			)
		)
			throw new Error("粘贴和拖放仅支持 PNG 或 JPEG 图片，项目文件请使用引用文件");
		if (files.some((file) => !file.size || file.size > IMAGE_BYTES_LIMIT))
			throw new Error("图片不能为空，每张不能超过 3 MiB");
		const data: string[] = [];
		for (const file of files) {
			// 1.2 复查读取结果，分块转换避免把整图字节展开到调用栈。
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (bytes.byteLength !== file.size || bytes.byteLength > IMAGE_BYTES_LIMIT)
				throw new Error("图片内容已变化，请重新添加");
			const pieces: string[] = [];
			for (let start = 0; start < bytes.length; start += 32768)
				pieces.push(String.fromCharCode(...bytes.subarray(start, start + 32768)));
			data.push(btoa(pieces.join("")));
		}
		return data;
	} finally {
		logger.info("输入区图片文件读取结束");
	}
}
