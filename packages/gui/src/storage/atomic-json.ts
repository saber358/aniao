import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../shared/logger.ts";

/*
 * ========================================================================
 * 步骤1：同步临时文件后原子替换 JSON
 * ========================================================================
 * 数据源：调用方已校验的桌面元数据，不记录业务内容。
 * 操作：
 *   1) 独占创建临时文件，写入并同步后替换正式文件
 *   2) 成功或失败都清理本次临时文件，原文件不被半写覆盖
 */
export async function writeJsonAtomically(
	directory: string,
	name: string,
	value: unknown,
	logger: Logger,
): Promise<void> {
	logger.info("开始原子保存桌面数据");
	const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
	try {
		// 1.1 临时文件和目标文件保持在同一目录。
		await mkdir(directory, { recursive: true });
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(value), "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, join(directory, name));
	} finally {
		try {
			await unlink(temporary).catch((error: unknown) => {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			});
		} finally {
			logger.info("桌面数据原子保存结束");
		}
	}
}
