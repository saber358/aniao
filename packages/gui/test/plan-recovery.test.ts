import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentHost } from "../src/host/agent-host.ts";
import { PlanJournal } from "../src/host/plan-journal.ts";
import { QueueJournal } from "../src/host/queue-journal.ts";
import type { GuiCommand } from "../src/shared/protocol.ts";
import { ImageStore } from "../src/storage/image-store.ts";
import { createHarness, type Harness } from "./sdk-harness.ts";

const logger = { info: vi.fn() };

async function hostFor(harness: Harness) {
	const cwd = harness.session.sessionManager.getCwd();
	const directory = join(harness.tempDir, "state");
	const journal = new QueueJournal(directory, cwd, harness.session.sessionId, logger);
	const plans = new PlanJournal(directory, cwd, harness.session.sessionId, logger);
	await journal.load();
	await plans.load();
	const host = new AgentHost(
		{
			session: harness.session,
			services: { modelRuntime: harness.modelRuntime },
			dispose: async () => {},
		},
		logger,
		journal,
		new ImageStore(directory, logger),
		plans,
		harness.authStorage,
	);
	const send = (command: GuiCommand) =>
		host.dispatch({
			requestId: crypto.randomUUID(),
			sessionId: host.snapshot.sessionId,
			generation: host.snapshot.generation,
			command,
		});
	return { host, plans, send, directory };
}

/*
 * ========================================================================
 * 步骤1：验证计划恢复保持用户批准边界
 * ========================================================================
 * 数据源：真实 SDK harness、离线响应和临时计划记录。
 * 操作：1) 保存、重开、批准；2) 中断或损坏时禁止自动执行。
 */
describe("plan recovery", () => {
	it("restores an edited awaiting plan with only read tools and executes only after approval", async () => {
		logger.info("开始验证待确认计划恢复");
		const harness = await createHarness();
		let current = await hostFor(harness);
		const tools = harness.session.getActiveToolNames();
		harness.setResponses([fauxAssistantMessage("inspect then edit"), fauxAssistantMessage("done")]);
		try {
			// 1.1 保存计划编辑后关闭宿主，原工具集合不得丢失。
			await current.send({ type: "prompt", text: "plan task", plan: true });
			expect(current.host.snapshot.plan?.phase).toBe("awaiting");
			await current.send({ type: "editPlan", text: "edited plan 中文" });
			await current.host.dispose();
			current = await hostFor(harness);
			expect(current.host.snapshot.plan).toMatchObject({ phase: "awaiting", text: "edited plan 中文" });
			expect(harness.session.getActiveToolNames()).not.toContain("write");
			expect(harness.getPendingResponseCount()).toBe(1);
			// 1.2 明确批准后才恢复写工具并消耗下一条响应。
			await current.send({ type: "approvePlan", text: "edited plan 中文" });
			expect(current.host.snapshot.plan?.phase).toBe("completed");
			expect(harness.session.getActiveToolNames()).toEqual(tools);
		} finally {
			await current.host.dispose();
			harness.cleanup();
			logger.info("待确认计划恢复验证结束");
		}
	});

	it.each(["drafting", "executing"] as const)(
		"restores %s as interrupted without replaying a prompt",
		async (phase) => {
			logger.info("开始验证在途计划中断恢复");
			const harness = await createHarness();
			let current = await hostFor(harness);
			try {
				// 1.3 模拟进程在记录落盘后退出，不重放模型请求。
				await current.plans.save({ phase, text: "saved plan" }, harness.session.getActiveToolNames());
				await current.host.dispose();
				const prompt = vi.spyOn(harness.session, "prompt");
				current = await hostFor(harness);
				expect(current.host.snapshot.plan).toMatchObject({ phase: "interrupted", text: "saved plan" });
				expect(prompt).not.toHaveBeenCalled();
				await expect(current.send({ type: "prompt", text: "bypass" })).rejects.toThrow("批准或取消");
				await current.send({ type: "rejectPlan" });
				expect(current.host.snapshot.plan?.phase).toBe("off");
			} finally {
				await current.host.dispose();
				harness.cleanup();
				logger.info("在途计划中断恢复验证结束");
			}
		},
	);

	it("does not report a failed execution as a completed plan", async () => {
		logger.info("开始验证计划执行失败状态");
		const harness = await createHarness();
		const current = await hostFor(harness);
		harness.setResponses([
			fauxAssistantMessage("plan"),
			{ ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "offline failure" },
		]);
		try {
			// 1.4 SDK 用错误消息结束时，计划仍需人工核对。
			await current.send({ type: "prompt", text: "plan task", plan: true });
			await current.send({ type: "approvePlan", text: "plan" });
			expect(current.host.snapshot.plan?.phase).toBe("interrupted");
		} finally {
			await current.host.dispose();
			harness.cleanup();
			logger.info("计划执行失败状态验证结束");
		}
	});

	it("preserves a corrupt plan file and refuses to load it", async () => {
		logger.info("开始验证计划损坏保护");
		const harness = await createHarness();
		const current = await hostFor(harness);
		try {
			// 1.5 文件损坏不清空、不覆盖，也不忽略批准边界。
			await current.plans.save({ phase: "awaiting", text: "plan" }, []);
			const file = (await readdir(current.directory)).find((name) => name.startsWith("plan-"));
			if (!file) throw new Error("missing plan file");
			await writeFile(join(current.directory, file), "{broken", "utf8");
			await expect(hostFor(harness)).rejects.toThrow("计划记录无法读取");
			expect(await readFile(join(current.directory, file), "utf8")).toBe("{broken");
		} finally {
			await current.host.dispose();
			harness.cleanup();
			logger.info("计划损坏保护验证结束");
		}
	});
});
