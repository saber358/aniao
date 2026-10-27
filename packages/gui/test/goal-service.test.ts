import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostGoalService } from "../src/host/goal-service.ts";
import { goalSnapshotSchema } from "../src/shared/goals.ts";
import { createHarness } from "./sdk-harness.ts";

const logger = { info: vi.fn() };
interface TestTask {
	id: string;
	title: string;
	status: "pending" | "complete" | "skipped";
	subtasks?: TestTask[];
	verificationContract?: string;
}
const goalRecord = () => ({
	id: "goal-1",
	objective: "实现功能\n补充测试",
	status: "active",
	autoContinue: true,
	sisyphus: false,
	skipAuditor: false,
	usage: { tokensUsed: 12300, activeSeconds: 95 },
	currentTaskId: "t2",
	taskList: {
		tasks: [
			{ id: "t1", title: "准备", status: "complete" },
			{ id: "t2", title: "开发", status: "pending", subtasks: [{ id: "t2a", title: "测试", status: "pending" }] },
		] as TestTask[],
	},
});

/*
 * ========================================================================
 * 步骤1：建立真实 SDK 的只读目标接口替身
 * ========================================================================
 * 数据源：内存目标记录、当前会话树和隔离设置目录。
 * 操作：1) 不创建实际持久目标；2) 官方工具结构与宿主解析使用真实边界。
 */
async function setup() {
	logger.info("开始创建目标读取测试会话");
	const record = goalRecord();
	const read = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "目标摘要" }],
		details: { version: 3, goal: record },
	}));
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "get_goal",
					label: "Get Goal",
					description: "Read goal",
					parameters: Type.Object({}),
					execute: read,
				});
			},
		],
	});
	const config = join(harness.tempDir, "goal-settings.json");
	vi.stubEnv("PI_GOAL_SETTINGS_FILE", config);
	vi.stubEnv("PI_GOAL_GLOBAL_SETTINGS_FILE", join(harness.tempDir, "global-goal-settings.json"));
	await harness.session.bindExtensions({ mode: "rpc" });
	const service = new HostGoalService(harness.session, logger);
	await service.bind();
	logger.info("目标读取测试会话创建结束");
	return { ...harness, record, read, config, service };
}

/*
 * ========================================================================
 * 步骤2：验证目标展示的会话隔离与字段边界
 * ========================================================================
 * 数据源：真实 SessionManager 分支与结构化 get_goal 回复。
 * 操作：1) 焦点只能来自当前分支；2) 完成状态与长内容不丢失或越界。
 */
describe("HostGoalService reads", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	it("shows a bound goal immediately and uses only the active branch focus", async () => {
		logger.info("开始验证目标焦点隔离");
		const state = await setup();
		try {
			// 2.1 没有绑定时不调用插件，其他会话有目标也不会自动显示。
			expect((await state.service.read()).goals).toEqual([]);
			expect(state.read).not.toHaveBeenCalled();
			const focus = state.sessionManager.appendCustomEntry("pi-goal-focus", { version: 1, focusedGoalId: "goal-1" });
			const snapshot = await state.service.read();
			expect(snapshot.goals[0]).toMatchObject({
				id: "goal-1",
				status: "running",
				currentTask: { id: "t2" },
				progress: { completed: 1, total: 2, percentage: 50 },
			});
			state.sessionManager.appendCustomEntry("pi-goal-focus", { version: 1, focusedGoalId: null });
			expect((await state.service.read()).goals).toEqual([]);
			state.sessionManager.branch(focus);
			expect((await state.service.read()).goals[0].id).toBe("goal-1");
		} finally {
			state.cleanup();
			logger.info("目标焦点隔离验证结束");
		}
	});
	it("preserves complete status and computes the effective auditor preference", async () => {
		logger.info("开始验证目标状态和审计");
		const state = await setup();
		try {
			// 2.2 全局禁用可被项目显式开启覆盖，目标自身禁用始终生效。
			state.sessionManager.appendCustomEntry("pi-goal-focus", { version: 1, focusedGoalId: "goal-1" });
			await writeFile(join(state.tempDir, "global-goal-settings.json"), JSON.stringify({ disabled: true }));
			state.record.status = "complete";
			let goal = (await state.service.read()).goals[0];
			expect(goal).toMatchObject({ status: "complete", auditor: false });
			expect(goal.currentTask).toBeUndefined();
			await writeFile(state.config, JSON.stringify({ disabled: false }));
			goal = (await state.service.read()).goals[0];
			expect(goal.auditor).toBe(true);
			state.record.skipAuditor = true;
			expect((await state.service.read()).goals[0].auditor).toBe(false);
		} finally {
			state.cleanup();
			logger.info("目标状态和审计验证结束");
		}
	});
	it("bounds legal long fields and task trees without losing the goal", async () => {
		logger.info("开始验证目标展示边界");
		const state = await setup();
		try {
			// 2.3 原文保留在插件，截断标识和省略号都纳入展示契约。
			state.sessionManager.appendCustomEntry("pi-goal-focus", { version: 1, focusedGoalId: "goal-1" });
			state.record.objective = "中".repeat(22000);
			state.record.taskList.tasks = Array.from({ length: 501 }, (_, index) => ({
				id: `t${index}`,
				title: "题".repeat(2001),
				status: "pending",
				verificationContract: "证".repeat(8100),
			}));
			const snapshot = await state.service.read();
			expect(goalSnapshotSchema.safeParse(snapshot).success).toBe(true);
			expect(snapshot.goals[0]).toMatchObject({ truncated: true });
			expect(snapshot.goals[0].tasks).toHaveLength(500);
			expect(snapshot.goals[0].tasks[0].title).toHaveLength(2000);
			expect(state.record.taskList.tasks[0].title).toHaveLength(2001);
		} finally {
			state.cleanup();
			logger.info("目标展示边界验证结束");
		}
	});
	it("rejects unrelated goal replies and malformed settings instead of showing another goal", async () => {
		logger.info("开始验证目标协议拒绝");
		const state = await setup();
		try {
			// 2.4 不匹配的数据不可被当成当前会话目标。
			state.sessionManager.appendCustomEntry("pi-goal-focus", { version: 1, focusedGoalId: "other-goal" });
			await expect(state.service.read()).rejects.toThrow("不属于当前会话");
			state.sessionManager.appendCustomEntry("pi-goal-focus", { version: 1, focusedGoalId: "goal-1" });
			await writeFile(state.config, "{broken");
			await expect(state.service.read()).rejects.toThrow("格式无效");
		} finally {
			state.cleanup();
			logger.info("目标协议拒绝验证结束");
		}
	});
});
