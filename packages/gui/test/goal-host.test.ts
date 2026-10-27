import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHost } from "../src/host/agent-host.ts";
import { PlanJournal } from "../src/host/plan-journal.ts";
import { QueueJournal } from "../src/host/queue-journal.ts";
import type { GoalAction } from "../src/shared/goals.ts";
import { ImageStore } from "../src/storage/image-store.ts";
import { createHarness } from "./sdk-harness.ts";

const logger = { info: vi.fn() };

/*
 * ========================================================================
 * 步骤1：建立带注册路由的真实 SDK 宿主
 * ========================================================================
 * 数据源：内存目标、正式扩展命令和真实交互服务。
 * 操作：1) 只修改隔离设置；2) 不调用模型或真实目标。
 */
async function setup(registered = true, disabledPause = false) {
	logger.info("开始创建目标控制测试宿主");
	const goal = {
		id: "goal-1",
		objective: "测试目标",
		status: "active",
		autoContinue: true,
		sisyphus: false,
		usage: { tokensUsed: 0, activeSeconds: 0 },
	};
	let cleared = false;
	const invoked: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				if (!registered) return;
				pi.registerTool({
					name: "get_goal",
					label: "Goal",
					description: "Read goal",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: "目标" }], details: { version: 3, goal: cleared ? null : goal } };
					},
				});
				pi.registerCommand("work", {
					async handler(args, ctx) {
						invoked.push(args);
						if (args === "pause") goal.status = "paused";
						else if (args === "continue") goal.status = "active";
						else if (args === "archive" && (await ctx.ui.confirm("归档目标？", goal.objective))) {
							cleared = true;
							pi.appendEntry("pi-goal-focus", { version: 1, focusedGoalId: null });
						}
					},
				});
			},
		],
	});
	const config = join(harness.tempDir, "goal-settings.json");
	vi.stubEnv("PI_GOAL_SETTINGS_FILE", config);
	vi.stubEnv("PI_GOAL_GLOBAL_SETTINGS_FILE", join(harness.tempDir, "global-settings.json"));
	await writeFile(
		config,
		JSON.stringify({
			commands: {
				"goal-pause": disabledPause ? [] : ["work pause"],
				"goal-resume": ["work continue"],
				"goal-clear": ["work archive"],
			},
		}),
	);
	harness.sessionManager.appendCustomEntry("pi-goal-focus", { version: 1, focusedGoalId: "goal-1" });
	const journal = new QueueJournal(harness.tempDir, harness.tempDir, harness.session.sessionId, logger);
	await journal.load();
	const host = new AgentHost(
		{ session: harness.session, services: { modelRuntime: harness.modelRuntime }, dispose: async () => {} },
		logger,
		journal,
		new ImageStore(harness.tempDir, logger),
		new PlanJournal(harness.tempDir, harness.tempDir, harness.session.sessionId, logger),
		harness.authStorage,
	);
	await host.initialize();
	const request = { cwd: host.snapshot.cwd, sessionId: host.snapshot.sessionId, generation: host.snapshot.generation };
	const control = (action: GoalAction, goalId = "goal-1") =>
		host.dispatch({ requestId: crypto.randomUUID(), ...request, command: { type: "goalCommand", action, goalId } });
	logger.info("目标控制测试宿主创建结束");
	return {
		...harness,
		goal,
		host,
		invoked,
		config,
		request,
		control,
		async close() {
			await host.dispose();
			harness.cleanup();
		},
	};
}

/*
 * ========================================================================
 * 步骤2：核对按钮路由、确认和会话边界
 * ========================================================================
 * 数据源：实际 AgentHost 与命令处理器，不替换 session.prompt。
 * 操作：1) 别名控制直达处理器；2) 缺失、旧身份和焦点变化全部拒绝。
 */
describe("goal host controls", () => {
	it("keeps disabled controls disabled and rejects conflicting aliases", async () => {
		logger.info("开始验证目标禁用和路由冲突");
		const state = await setup(true, true);
		try {
			// 2.5 空命令列表不得回退为默认命令；冲突配置不得误启动目标草稿。
			await expect(state.control("pause")).rejects.toThrow("禁用");
			await writeFile(state.config, JSON.stringify({ commands: { "goal-pause": ["goal"] } }));
			await expect(state.control("pause")).rejects.toThrow("冲突");
			expect(state.invoked).toEqual([]);
		} finally {
			await state.close();
			logger.info("目标禁用和路由冲突验证结束");
		}
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	it("routes renamed controls directly and requires confirmation before archival", async () => {
		logger.info("开始验证目标别名和归档确认");
		const state = await setup();
		const prompt = vi.spyOn(state.session, "prompt");
		try {
			// 2.1 暂停与继续不走模型，归档取消不得改变目标。
			await state.control("pause");
			expect((await state.host.readGoals(state.request)).goals[0].status).toBe("paused");
			await state.control("resume");
			let pending = state.control("delete");
			await vi.waitFor(() => expect(state.host.dialogs.requests).toHaveLength(1));
			state.host.dialogs.reply({ id: state.host.dialogs.requests[0].id, cancelled: true });
			await pending;
			expect((await state.host.readGoals(state.request)).goals).toHaveLength(1);
			pending = state.control("delete");
			await vi.waitFor(() => expect(state.host.dialogs.requests).toHaveLength(1));
			state.host.dialogs.reply({ id: state.host.dialogs.requests[0].id, cancelled: false, value: true });
			await pending;
			expect((await state.host.readGoals(state.request)).goals).toEqual([]);
			expect(prompt).not.toHaveBeenCalled();
			expect(state.invoked).toEqual(["pause", "continue", "archive", "archive"]);
		} finally {
			await state.close();
			logger.info("目标别名和归档确认验证结束");
		}
	});
	it("rejects stale requests and goal IDs before invoking plugin handlers", async () => {
		logger.info("开始验证目标身份边界");
		const state = await setup();
		try {
			// 2.2 其他会话、项目或已被替换宿主的请求都不可读写当前目标。
			for (const request of [
				{ ...state.request, generation: "old" },
				{ ...state.request, sessionId: "other" },
				{ ...state.request, cwd: "C:/other" },
			])
				await expect(state.host.readGoals(request)).rejects.toThrow("会话已更换");
			await expect(state.control("pause", "other-goal")).rejects.toThrow("当前目标已更换");
			expect(state.invoked).toEqual([]);
		} finally {
			await state.close();
			logger.info("目标身份边界验证结束");
		}
	});
	it("rejects commands after settings change until resources are reloaded", async () => {
		logger.info("开始验证目标别名配置变更");
		const state = await setup();
		try {
			// 2.3 配置变更不能误调同名根命令下的旧操作。
			await writeFile(state.config, JSON.stringify({ commands: { "goal-pause": ["work stop"] } }));
			await expect(state.control("pause")).rejects.toThrow("重载会话资源");
			expect(state.invoked).toEqual([]);
		} finally {
			await state.close();
			logger.info("目标别名配置变更验证结束");
		}
	});
	it("fails missing plugins without sending the command to a model", async () => {
		logger.info("开始验证缺失目标插件");
		const state = await setup(false);
		const prompt = vi.spyOn(state.session, "prompt");
		try {
			// 2.4 插件缺失是明确错误，未知命令不得变成提示词。
			await expect(state.control("pause")).rejects.toThrow();
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			await state.close();
			logger.info("缺失目标插件验证结束");
		}
	});
});
