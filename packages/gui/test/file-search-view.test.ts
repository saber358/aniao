import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, shallowRef } from "vue";
import { useFileSearch } from "../src/renderer/composables/use-file-search.ts";
import type { ProjectFileMatches, ProjectFileSearch } from "../src/shared/project-files.ts";

const logger = { info: vi.fn() };
const input = { sessionId: "session", generation: "host", query: "src" };

/*
 * ========================================================================
 * 步骤1：验证搜索展示只接受当前查询结果
 * ========================================================================
 * 数据源：Vue effect scope、可控查询 Promise 和虚拟计时器。
 * 操作：
 *   1) 快速输入只查询最后一项，相同身份对象重建不重复搜索
 *   2) 关闭、换代和销毁丢弃旧结果，失败允许显式重试
 */
describe("file search view", () => {
	afterEach(() => {
		vi.useRealTimers();
	});
	it("debounces typing and does not reload unchanged primitive query values", async () => {
		logger.info("开始验证文件搜索输入合并");
		vi.useFakeTimers();
		const selection = shallowRef<ProjectFileSearch | null>(input);
		const search = vi.fn(async () => ({ paths: ["src/file.ts"], incomplete: false }));
		const scope = effectScope();
		const view = scope.run(() => useFileSearch(() => selection.value, search, logger));
		if (!view) throw new Error("Search view missing");
		try {
			selection.value = { ...input, query: "source" };
			await nextTick();
			await vi.advanceTimersByTimeAsync(181);
			expect(search).toHaveBeenCalledTimes(1);
			expect(search).toHaveBeenCalledWith({ ...input, query: "source" });
			selection.value = { ...selection.value };
			await nextTick();
			await vi.advanceTimersByTimeAsync(181);
			expect(search).toHaveBeenCalledTimes(1);
			expect(view.matches.value.paths).toEqual(["src/file.ts"]);
		} finally {
			scope.stop();
			logger.info("文件搜索输入合并验证完成");
		}
	});

	it("discards late results after a new query, closing, changing generation or disposal", async () => {
		logger.info("开始验证文件搜索迟到结果");
		vi.useFakeTimers();
		for (const action of ["query", "close", "generation", "dispose"]) {
			const selection = shallowRef<ProjectFileSearch | null>(input);
			let finish: (result: ProjectFileMatches) => void = () => {};
			const search = vi.fn(
				() =>
					new Promise<ProjectFileMatches>((resolve) => {
						finish = resolve;
					}),
			);
			const scope = effectScope();
			const view = scope.run(() => useFileSearch(() => selection.value, search, logger));
			if (!view) throw new Error("Search view missing");
			try {
				await vi.advanceTimersByTimeAsync(181);
				if (action === "dispose") scope.stop();
				else
					selection.value =
						action === "close"
							? null
							: { ...input, ...(action === "query" ? { query: "next" } : { generation: "next" }) };
				await nextTick();
				finish({ paths: ["old-file.ts"], incomplete: true });
				await nextTick();
				expect(view.matches.value.paths).toEqual([]);
			} finally {
				scope.stop();
			}
		}
		logger.info("文件搜索迟到结果验证完成");
	});

	it("retries errors and does not dispatch empty or excessive queries", async () => {
		logger.info("开始验证文件搜索重试");
		vi.useFakeTimers();
		const selection = shallowRef<ProjectFileSearch | null>(input);
		const search = vi
			.fn()
			.mockRejectedValueOnce(new Error("unavailable"))
			.mockResolvedValue({ paths: ["file.ts"], incomplete: false });
		const scope = effectScope();
		const view = scope.run(() => useFileSearch(() => selection.value, search, logger));
		if (!view) throw new Error("Search view missing");
		try {
			await vi.advanceTimersByTimeAsync(181);
			expect(view.error.value).toContain("可重试");
			expect(view.loading.value).toBe(false);
			view.retry();
			await nextTick();
			await vi.advanceTimersByTimeAsync(181);
			expect(view.matches.value.paths).toEqual(["file.ts"]);
			for (const query of ["", " ", "x".repeat(201)]) {
				selection.value = { ...input, query };
				await nextTick();
				await vi.advanceTimersByTimeAsync(181);
			}
			expect(search).toHaveBeenCalledTimes(2);
			expect(view.error.value).toContain("200 字符");
		} finally {
			scope.stop();
			logger.info("文件搜索重试验证完成");
		}
	});
});
