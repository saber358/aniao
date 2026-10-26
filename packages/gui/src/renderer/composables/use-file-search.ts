import { ref, shallowRef, watch } from "vue";
import type { Logger } from "../../shared/logger.ts";
import { PROJECT_QUERY_LIMIT, type ProjectFileMatches, type ProjectFileSearch } from "../../shared/project-files.ts";

/*
 * ========================================================================
 * 步骤1：把有限文件查询接入搜索界面
 * ========================================================================
 * 数据源：弹窗当前身份与查询文本，不持有文件系统或目录索引。
 * 操作：
 *   1) 延迟查询合并快速输入，查询变化时立即撤下旧候选
 *   2) 关闭、换代和销毁时丢弃迟到结果，失败保留重试入口
 */
export function useFileSearch(
	input: () => ProjectFileSearch | null,
	search: (input: ProjectFileSearch) => Promise<ProjectFileMatches>,
	logger: Logger,
) {
	const matches = shallowRef<ProjectFileMatches>({ paths: [], incomplete: false });
	const loading = ref(false);
	const error = ref("");
	const revision = ref(0);
	watch(
		[() => input()?.sessionId, () => input()?.generation, () => input()?.query, revision],
		(_value, _previous, onCleanup) => {
			const selection = input();
			let current = true;
			matches.value = { paths: [], incomplete: false };
			error.value = "";
			loading.value = false;
			if (!selection?.query.trim()) return;
			if (selection.query.length > PROJECT_QUERY_LIMIT) {
				error.value = "搜索内容不能超过 200 字符";
				return;
			}
			loading.value = true;
			// 1.1 计时器和在途结果共用本轮有效标记，旧回调不能清除新查询状态。
			const timer = setTimeout(async () => {
				logger.info("开始读取文件搜索候选");
				try {
					const result = await search(selection);
					if (current) matches.value = result;
				} catch {
					if (current) error.value = "文件搜索失败，可重试或使用原生文件选择";
				} finally {
					if (current) loading.value = false;
					logger.info("文件搜索候选读取结束");
				}
			}, 180);
			onCleanup(() => {
				current = false;
				clearTimeout(timer);
			});
		},
		{ immediate: true },
	);
	return {
		matches,
		loading,
		error,
		retry: () => {
			revision.value++;
		},
	};
}
