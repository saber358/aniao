import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, reactive } from "vue";
import { useSubagentDetails } from "../../src/renderer/composables/use-subagent-details.ts";
import type { DesktopBridge } from "../../src/shared/protocol.ts";
import type { SubagentInspection } from "../../src/shared/subagents.ts";

const logger = { info: vi.fn() };
const reply: SubagentInspection = {
	kind: "pi-subagents.inspect-reply",
	version: 1,
	requestId: "request",
	asyncId: "run",
	childId: "step:0",
	status: "running",
	task: "检查文件",
};

/*
 * ========================================================================
 * 步骤1：验证右栏异步状态、部分失败和轮询清理
 * ========================================================================
 * 数据源：真实 Vue watch、受控宿主回复与虚拟时钟。
 * 操作：1) 保留成功来源；2) 丢弃旧标签结果且不堆积轮询。
 */
describe("subagent details view", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	it("keeps transcript content and reports inspection errors instead of an empty state", async () => {
		logger.info("开始验证右栏部分失败");
		const target = reactive({ runId: "run", childId: "step:0", active: true });
		const port = {
			inspectSubagent: vi
				.fn<DesktopBridge["inspectSubagent"]>()
				.mockRejectedValueOnce(new Error("查询失败"))
				.mockResolvedValue({ ...reply, status: "paused" }),
			readSubagentTranscript: vi.fn<DesktopBridge["readSubagentTranscript"]>().mockResolvedValue("转录正文"),
		};
		const scope = effectScope();
		const view = scope.run(() => useSubagentDetails(() => target, port, logger));
		if (!view) throw new Error("视图未建立");
		try {
			// 1.1 一个来源失败不清空另一个来源；重试成功后清除错误。
			await vi.advanceTimersByTimeAsync(0);
			expect(view.transcript.value).toBe("转录正文");
			expect(view.error.value).toBe("查询失败");
			view.refresh();
			await vi.advanceTimersByTimeAsync(0);
			expect(view.inspection.value?.task).toBe("检查文件");
			expect(view.error.value).toBeNull();
			target.active = false;
			await nextTick();
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			scope.stop();
			logger.info("右栏部分失败验证完成");
		}
	});
	it("drops late target replies and does not poll again after disposal", async () => {
		logger.info("开始验证右栏迟到回复");
		let finish: (value: SubagentInspection) => void = () => {};
		const target = reactive({ runId: "run", childId: "step:0", active: true });
		const port = {
			inspectSubagent: vi
				.fn<DesktopBridge["inspectSubagent"]>()
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finish = resolve;
						}),
				)
				.mockResolvedValue({ ...reply, childId: "step:1", task: "第二个任务" }),
			readSubagentTranscript: vi.fn<DesktopBridge["readSubagentTranscript"]>().mockResolvedValue(null),
		};
		const scope = effectScope();
		const view = scope.run(() => useSubagentDetails(() => target, port, logger));
		if (!view) throw new Error("视图未建立");
		try {
			// 1.2 慢请求不产生重叠轮询，切换后只安装新目标结果。
			await vi.advanceTimersByTimeAsync(7500);
			expect(port.inspectSubagent).toHaveBeenCalledTimes(1);
			target.childId = "step:1";
			await nextTick();
			await vi.advanceTimersByTimeAsync(0);
			finish(reply);
			await vi.advanceTimersByTimeAsync(0);
			expect(view.inspection.value?.task).toBe("第二个任务");
			scope.stop();
			await vi.advanceTimersByTimeAsync(10000);
			expect(port.inspectSubagent).toHaveBeenCalledTimes(2);
		} finally {
			scope.stop();
			logger.info("右栏迟到回复验证完成");
		}
	});
});
