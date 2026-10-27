import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentHost } from "../src/host/agent-host.ts";
import { PlanJournal } from "../src/host/plan-journal.ts";
import { QueueJournal } from "../src/host/queue-journal.ts";
import { SUBAGENT_INSPECT_PREFIX, SUBAGENT_INSPECT_WIDGET } from "../src/shared/subagents.ts";
import { ImageStore } from "../src/storage/image-store.ts";
import { createHarness } from "./sdk-harness.ts";

const logger = { info: vi.fn() };

/*
 * ========================================================================
 * 步骤1：在真实 SDK 的活动主回合中检查子任务
 * ========================================================================
 * 数据源：faux 模型、真实扩展命令和临时队列存储。
 * 操作：1) 详情查询绕过主提交锁；2) 缺失接口不得启动模型。
 */
describe("subagent host inspection", () => {
	it.each([true, false])("queries a registered command without a model request (registered=%s)", async (registered) => {
		logger.info("开始验证真实 SDK 子任务查询");
		const harness = await createHarness({
			extensionFactories: registered
				? [
						(pi) => {
							pi.registerCommand("subagents-inspect-rpc", {
								handler: async (args, ctx) => {
									const [requestId, asyncId, childId] = args.split(" ");
									const canonicalId = childId === "nested-run" ? childId : asyncId;
									ctx.ui.setWidget(SUBAGENT_INSPECT_WIDGET, [
										`${SUBAGENT_INSPECT_PREFIX}${JSON.stringify({ kind: "pi-subagents.inspect-reply", version: 1, requestId, asyncId: canonicalId, childId, status: "running", messages: [{ role: "assistant", kind: "text", text: "正在检查文件" }] })}`,
									]);
									ctx.ui.setWidget(SUBAGENT_INSPECT_WIDGET, undefined);
								},
							});
						},
					]
				: [],
		});
		const journal = new QueueJournal(
			join(harness.tempDir, "journal"),
			harness.tempDir,
			harness.session.sessionId,
			logger,
		);
		await journal.load();
		const host = new AgentHost(
			{ session: harness.session, services: { modelRuntime: harness.modelRuntime }, dispose: async () => {} },
			logger,
			journal,
			new ImageStore(harness.tempDir, logger),
			new PlanJournal(harness.tempDir, harness.tempDir, harness.session.sessionId, logger),
			harness.authStorage,
		);
		let enter = () => {};
		let release = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				enter();
				await gate;
				return fauxAssistantMessage("完成");
			},
		]);
		try {
			// 1.1 主回合在运行，查询必须独立完成且不能调用 session.prompt。
			await host.initialize();
			const running = host.dispatch({
				requestId: "main",
				sessionId: host.snapshot.sessionId,
				generation: host.snapshot.generation,
				command: { type: "prompt", text: "主任务" },
			});
			await entered;
			const prompt = vi.spyOn(harness.session, "prompt");
			if (registered) {
				expect(await host.inspectSubagent("run", "step:1")).toMatchObject({ childId: "step:1", status: "running" });
				expect(await host.inspectSubagent("run", "run")).toMatchObject({ asyncId: "run" });
				expect(await host.inspectSubagent("run", "nested-run")).toMatchObject({
					asyncId: "nested-run",
					childId: "nested-run",
				});
			} else await expect(host.inspectSubagent("run", "step:1")).rejects.toThrow("尚未加载");
			expect(prompt).not.toHaveBeenCalled();
			expect(host.snapshot.extensions.widgets).toEqual([]);
			release();
			await running;
		} finally {
			release();
			await host.dispose();
			harness.cleanup();
			logger.info("真实 SDK 子任务查询验证完成");
		}
	});
});
