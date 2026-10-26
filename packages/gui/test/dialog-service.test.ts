import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogService } from "../src/host/dialog-service.ts";

const logger = { info: vi.fn() };

/*
 * ========================================================================
 * 步骤1：验证交互关联、取消与资源释放
 * ========================================================================
 * 数据源：可控时钟、AbortSignal 与宿主内回调，不启动窗口。
 * 操作：
 *   1) 类型错误和迟到回复不能完成其他请求
 *   2) 超时、外部取消和宿主退出均清理计时器及监听
 */
describe("DialogService", () => {
	afterEach(() => vi.useRealTimers());
	it("validates choices and rejects duplicate or stale replies", async () => {
		logger.info("开始验证交互回复关联");
		const dialogs = new DialogService(logger, vi.fn());
		try {
			const pending = dialogs.show({
				scope: "extension",
				kind: "select",
				title: "选择",
				options: [{ value: "a", label: "中文" }],
			});
			const id = dialogs.requests[0].id;
			expect(() => dialogs.reply({ id, cancelled: false, value: true })).toThrow("类型无效");
			expect(() => dialogs.reply({ id, cancelled: false, value: "b" })).toThrow("选择已失效");
			expect(dialogs.requests).toHaveLength(1);
			dialogs.reply({ id, cancelled: false, value: "a" });
			expect(await pending).toBe("a");
			expect(() => dialogs.reply({ id, cancelled: false, value: "a" })).toThrow("交互已结束");
			expect(dialogs.requests).toEqual([]);
		} finally {
			dialogs.dispose();
			logger.info("交互回复关联验证完成");
		}
	});
	it("settles cancellation and timeout once and removes all resources on disposal", async () => {
		logger.info("开始验证交互取消和超时");
		vi.useFakeTimers();
		const dialogs = new DialogService(logger, vi.fn());
		const signal = new AbortController();
		const removed = vi.spyOn(signal.signal, "removeEventListener");
		try {
			const pending = dialogs.show(
				{ scope: "extension", kind: "confirm", title: "取消" },
				{ signal: signal.signal, timeout: 50 },
			);
			signal.abort();
			expect(await pending).toBeUndefined();
			expect(removed).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
			const expired = dialogs.show({ scope: "oauth", kind: "input", title: "超时" }, { timeout: 20 });
			await vi.advanceTimersByTimeAsync(21);
			expect(await expired).toBeUndefined();
			const closing = dialogs.show({ scope: "extension", kind: "editor", title: "退出" });
			dialogs.dispose();
			expect(await closing).toBeUndefined();
			expect(dialogs.requests).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			dialogs.dispose();
			logger.info("交互取消和超时验证完成");
		}
	});
});
