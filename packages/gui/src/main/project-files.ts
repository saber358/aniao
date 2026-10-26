import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { Logger } from "../shared/logger.ts";
import { PROJECT_FILE_LIMIT, PROJECT_PATH_LIMIT } from "../shared/project-files.ts";
import { projectFilePathsSchema } from "../shared/workspace.ts";

/*
 * ========================================================================
 * 步骤1：把原生文件选择转换为项目引用
 * ========================================================================
 * 数据源：主进程持有的项目目录和原生对话框结果，不读取文件正文。
 * 操作：
 *   1) 解析真实路径后检查归属，拒绝越界链接、目录和失效文件
 *   2) 全部通过后返回去重相对路径，失败不返回部分结果
 */
export async function resolveProjectFiles(cwd: string, paths: readonly string[], logger: Logger): Promise<string[]> {
	logger.info("开始校验项目文件引用");
	try {
		// 1.1 先限制数量和输入字符，取消选择不访问文件系统。
		if (paths.length > PROJECT_FILE_LIMIT) throw new Error(`每次最多引用 ${PROJECT_FILE_LIMIT} 个项目文件`);
		if (!paths.length) return [];
		if (
			paths.some((path) => !isAbsolute(path) || path.length > PROJECT_PATH_LIMIT || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(path))
		)
			throw new Error("文件路径无效，请重新选择");
		const root = await realpath(cwd).catch(() => {
			throw new Error("项目目录已失效");
		});
		if (!(await stat(root)).isDirectory()) throw new Error("项目目录已失效");
		const selected = new Set<string>();
		for (const path of paths) {
			// 1.2 不用字符串前缀判断目录；realpath 同时解析 symlink 和 junction。
			const resolved = await realpath(path).catch(() => {
				throw new Error("所选文件已失效或不可访问，请重新选择");
			});
			const local = relative(root, resolved);
			if (isAbsolute(local) || local.split(sep).includes("..")) throw new Error("只能引用当前项目内的文件");
			const details = await stat(resolved).catch(() => {
				throw new Error("所选文件已失效或不可访问，请重新选择");
			});
			if (!details.isFile()) throw new Error("请选择项目文件，不能引用目录或特殊文件");
			selected.add(local.split(sep).join("/"));
		}
		// 1.3 最终结果保持有界，不把绝对路径或不可表示的名称送入 Renderer。
		const result = projectFilePathsSchema.safeParse([...selected]);
		if (!result.success) throw new Error("文件路径无效，请重新选择");
		return result.data;
	} finally {
		logger.info("项目文件引用校验结束");
	}
}
