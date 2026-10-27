import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, reactive } from "vue";
import { useGoals } from "../../src/renderer/composables/use-goals.ts";
import type { GoalSnapshot, GoalView } from "../../src/shared/goals.ts";
import type { DesktopBridge } from "../../src/shared/protocol.ts";

const logger = { info: vi.fn() };
const goal: GoalView = {
	id: "goal-1",
	title: "当前会话目标",
	objective: "当前会话目标",
	status: "running",
	autoContinue: true,
	sisyphus: false,
	auditor: true,
	usage: { tokensUsed: 0, activeSeconds: 0 },
	tasks: [],
};
const snapshot: GoalSnapshot = { goals: [goal], generatedAt: 1 };

/*
 * ========================================================================
 * 步骤1：核对启动恢复、会话切换和迟到数据
 * ========================================================================
 * 数据源：真实 Vue watch、隔离端口和虚拟时钟。
 * 操作：1) 绑定会话立即显示，无绑定会话为空；2) 切换和销毁后不安装旧回复。
 */
describe("goal view session isolation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	it("shows existing goals on startup and clears the bar synchronously when switching", async () => {
		logger.info("开始验证目标启动和切换显示");
		const target = reactive({ cwd: "C:/project", sessionId: "bound", generation: "host-1" });
		const port = {
			readGoals: vi
				.fn<DesktopBridge["readGoals"]>()
				.mockImplementation(async (request) =>
					request.sessionId === "bound" ? snapshot : { goals: [], generatedAt: 2 },
				),
		};
		const scope = effectScope();
		const view = scope.run(() =>
			useGoals(
				() => target,
				port,
				vi.fn(async () => true),
				logger,
			),
		);
		if (!view) throw new Error("视图未建立");
		try {
			// 1.1 不需要先切换一次，已有绑定立即显示。
			await vi.advanceTimersByTimeAsync(0);
			expect(view.goals.value[0].id).toBe("goal-1");
			target.sessionId = "unbound";
			expect(view.goals.value).toEqual([]);
			await vi.advanceTimersByTimeAsync(0);
			expect(view.goals.value).toEqual([]);
			target.sessionId = "bound";
			await vi.advanceTimersByTimeAsync(0);
			expect(view.goals.value[0].id).toBe("goal-1");
		} finally {
			scope.stop();
			logger.info("目标启动和切换显示验证结束");
		}
	});
	it("drops a late response from the previous host generation", async () => {
		logger.info("开始验证目标迟到回复");
		let finish: (snapshot: GoalSnapshot) => void = () => {};
		const target = reactive({ cwd: "C:/project", sessionId: "session", generation: "old" });
		const port = {
			readGoals: vi
				.fn<DesktopBridge["readGoals"]>()
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finish = resolve;
						}),
				)
				.mockResolvedValue({ goals: [], generatedAt: 2 }),
		};
		const scope = effectScope();
		const view = scope.run(() =>
			useGoals(
				() => target,
				port,
				vi.fn(async () => true),
				logger,
			),
		);
		if (!view) throw new Error("视图未建立");
		try {
			// 1.2 同会话 ID 换宿主也要丢弃旧回复，不能只比较 sessionId。
			await vi.advanceTimersByTimeAsync(0);
			target.generation = "new";
			await nextTick();
			await vi.advanceTimersByTimeAsync(0);
			finish(snapshot);
			await vi.advanceTimersByTimeAsync(0);
			expect(view.goals.value).toEqual([]);
			scope.stop();
			await vi.advanceTimersByTimeAsync(10000);
			expect(port.readGoals).toHaveBeenCalledTimes(2);
		} finally {
			scope.stop();
			logger.info("目标迟到回复验证结束");
		}
	});
	it("preserves content across read failures and keeps action busy across polling", async () => {
		logger.info("开始验证目标失败提示和控制等待");
		const target = { cwd: "C:/project", sessionId: "session", generation: "host" };
		let complete: (accepted: boolean) => void = () => {};
		const control = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					complete = resolve;
				}),
		);
		const port = { readGoals: vi.fn<DesktopBridge["readGoals"]>().mockResolvedValue(snapshot) };
		const scope = effectScope();
		const view = scope.run(() => useGoals(() => target, port, control, logger));
		if (!view) throw new Error("视图未建立");
		try {
			// 1.3 确认等待超过十秒且经过多次刷新，按钮仍不能重复提交。
			await vi.advanceTimersByTimeAsync(0);
			const pending = view.act("delete");
			await vi.advanceTimersByTimeAsync(12500);
			expect(view.pendingAction.value).toBe("delete");
			await view.act("pause");
			expect(control).toHaveBeenCalledTimes(1);
			complete(true);
			await pending;
			expect(view.pendingAction.value).toBeNull();
			port.readGoals.mockRejectedValueOnce(new Error("读取失败"));
			await view.refresh();
			expect(view.goals.value[0].id).toBe("goal-1");
			expect(view.error.value).toBe("读取失败");
			await view.refresh();
			expect(view.error.value).toBeNull();
		} finally {
			complete(false);
			scope.stop();
			logger.info("目标失败提示和控制等待验证结束");
		}
	});
});
