import type { Node } from "@comark/vue";
import { createLogger } from "../../shared/logger.ts";

const logger = createLogger("markdown-view");

/*
 * ========================================================================
 * 步骤1：从代码 AST 提取文本
 * ========================================================================
 * 数据源：Comark 代码节点，Shiki 只把文本拆成高亮 span。
 * 操作：
 *   1) 按节点顺序保留原始空白、换行和实体文本
 *   2) 忽略标签、属性与注释，不复制工具栏文字
 */
export function codeText(node: Node): string {
	logger.info("开始提取代码正文");
	try {
		// 1.1 Comark 已移除围栏前的结构换行，不补造代码内容。
		function visit(current: Node): string {
			if (typeof current === "string") return current;
			if (current[0] === null) return "";
			return (current.slice(2) as Node[]).map(visit).join("");
		}
		return visit(node);
	} finally {
		logger.info("代码正文提取结束");
	}
}
