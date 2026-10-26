import type { Logger } from "../shared/logger.ts";
import { PROJECT_PATH_LIMIT, PROJECT_QUERY_LIMIT } from "../shared/project-files.ts";

export interface FileCompletion {
	source: string;
	cursor: number;
	start: number;
	end: number;
	query: string;
}

/*
 * ========================================================================
 * 步骤1：定位光标所属的文件引用片段
 * ========================================================================
 * 数据源：输入区文字与 UTF-16 选择位置，不读取文件或解析提示词内容。
 * 操作：
 *   1) 只接受空白后的 @，排除邮箱、选择范围和超过查询上限的片段
 *   2) 引号内支持空格；右侧替换范围有界，不越过行或完整引用
 */
export function readFileCompletion(
	source: string,
	cursor: number,
	selectionEnd: number,
	logger: Logger,
): FileCompletion | null {
	logger.info("开始定位文件补全片段");
	try {
		// 1.1 浏览器选择位置与字符串切片共用 UTF-16 坐标。
		if (!Number.isSafeInteger(cursor) || cursor !== selectionEnd || cursor < 0 || cursor > source.length) return null;
		for (let start = cursor - 1; start >= Math.max(0, cursor - PROJECT_QUERY_LIMIT - 2); start--) {
			if (source[start] !== "@" || (start > 0 && !/\s/u.test(source[start - 1]))) continue;
			const quoted = source[start + 1] === '"';
			const query = source.slice(start + (quoted ? 2 : 1), cursor);
			if (query.length > PROJECT_QUERY_LIMIT || /["\p{Cc}]/u.test(query) || (!quoted && /\s/u.test(query))) continue;
			// 1.2 无闭合引号时只替换已输入前缀，保留右侧可能仍属正文的文字。
			let end = cursor;
			const limit = Math.min(source.length, start + PROJECT_PATH_LIMIT + 3);
			if (quoted) {
				for (let index = cursor; index < limit && !/[\r\n]/u.test(source[index]); index++) {
					if (source[index] === '"') {
						end = index + 1;
						break;
					}
				}
			} else {
				while (end < limit && !/\s/u.test(source[end])) end++;
				if (end < source.length && !/\s/u.test(source[end])) return null;
				if (source.slice(start + 1, end).includes('"')) return null;
			}
			return { source, cursor, start, end, query };
		}
		return null;
	} finally {
		logger.info("文件补全片段定位结束");
	}
}

/*
 * ========================================================================
 * 步骤2：在仍然有效的片段中插入校验后的路径
 * ========================================================================
 * 数据源：原草稿快照、片段坐标与主进程重新校验后的单个相对路径。
 * 操作：
 *   1) 草稿或坐标变化时拒绝替换，保留片段前后的原文
 *   2) 使用与原生引用相同的 JSON 引号，不把路径交给 shell
 */
export function applyFileCompletion(source: string, target: FileCompletion, path: string, logger: Logger): string {
	logger.info("开始替换文件补全片段");
	try {
		// 2.1 重新推导范围，不信任先前保存的坐标或未确认的草稿。
		const current = readFileCompletion(source, target.cursor, target.cursor, logger);
		if (
			source !== target.source ||
			!current ||
			current.start !== target.start ||
			current.end !== target.end ||
			current.query !== target.query
		)
			throw new Error("草稿已变化，未替换文件引用，请重新选择");
		const suffix = source.slice(target.end);
		const separator = /^\s/u.test(suffix) ? "" : " ";
		return `${source.slice(0, target.start)}@${JSON.stringify(path)}${separator}${suffix}`;
	} finally {
		logger.info("文件补全片段替换结束");
	}
}
