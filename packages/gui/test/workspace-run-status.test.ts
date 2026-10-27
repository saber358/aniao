import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type ManagedHost, WorkspaceService } from "../src/main/workspace-service.ts";
import { WorkspaceStore } from "../src/main/workspace-store.ts";
import type { SessionSnapshot } from "../src/shared/protocol.ts";
import type { SessionSummary } from "../src/shared/workspace.ts";
import { FakeAgentPort, snapshot } from "./fixtures.ts";

const logger = { info: vi.fn() };
class RunHost extends FakeAgentPort implements ManagedHost {
	isClosed = false;
	declare current: SessionSnapshot;
	constructor(cwd: string) {
		super();
		this.current = { ...snapshot(), cwd };
	}
	async getSnapshot() {
		return structuredClone(this.current);
	}
	async listSessions(): Promise<SessionSummary[]> {
		return [
			{ id: this.current.sessionId, title: "会话", preview: "", messageCount: 0, persisted: false, updatedAt: 1 },
		];
	}
	async getForkDraft() {
		return undefined;
	}
	async getImage(): Promise<string> {
		throw new Error("无测试图片");
	}
	async renameSession() {}
	async prepareTransition() {}
	async close() {
		this.isClosed = true;
	}
	run(phase: SessionSnapshot["run"]["phase"]): void {
		this.current.run = { phase };
		this.current.seq++;
		this.emit({
			type: "event",
			value: {
				sessionId: this.current.sessionId,
				generation: this.current.generation,
				seq: this.current.seq,
				event: { type: "run", run: { phase } },
			},
		});
	}
}

/*
 * ========================================================================
 * 步骤1：验证侧栏运行标记来自真实任务状态
 * ========================================================================
 * 数据源：独立宿主的快照、订阅时机和有界元数据命令。
 * 操作：1) 捕获登记前结束的任务；2) 普通命令等待不冒充模型运行。
 */
describe("workspace task indicators", () => {
	it("recovers a missed idle event even when a newer title arrives before its snapshot", async () => {
		logger.info("开始验证不同字段的快照补读顺序");
		const directory = await mkdtemp(join(tmpdir(), "workspace-run-"));
		if (dirname(directory) !== tmpdir()) throw new Error("测试目录清理越界");
		const host = new RunHost(await realpath(directory));
		host.current.run.phase = "working";
		vi.spyOn(host, "listSessions").mockImplementationOnce(async () => {
			host.run("idle");
			return [
				{ id: host.current.sessionId, title: "会话", preview: "", messageCount: 0, persisted: false, updatedAt: 1 },
			];
		});
		vi.spyOn(host, "getSnapshot")
			.mockImplementationOnce(async () => structuredClone(host.current))
			.mockImplementationOnce(async () => {
				// 1.7 旧快照含漏收的 idle，新标题只覆盖标题，不能丢弃整个快照。
				const stale = structuredClone(host.current);
				host.current.title = "新标题";
				host.current.seq++;
				host.emit({
					type: "event",
					value: {
						sessionId: host.current.sessionId,
						generation: host.current.generation,
						seq: host.current.seq,
						event: { type: "title", title: host.current.title },
					},
				});
				return stale;
			});
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		try {
			await workspace.attach(directory);
			expect(workspace.getSessionRuntimes()[0]).toMatchObject({ title: "新标题", running: false });
		} finally {
			await workspace.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("不同字段的快照补读顺序验证结束");
		}
	});
	it("keeps extension initialization idle in the sidebar and follows real work afterward", async () => {
		logger.info("开始验证初始化与真实任务的运行标记");
		const directory = await mkdtemp(join(tmpdir(), "workspace-run-"));
		if (dirname(directory) !== tmpdir()) throw new Error("测试目录清理越界");
		const host = new RunHost(await realpath(directory));
		host.current.run.phase = "initializing";
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		try {
			// 1.3 初始化保持忙碌，但只有真正的任务阶段显示转圈。
			await workspace.attach(directory);
			expect(workspace.getSessionRuntimes()[0].running).toBe(false);
			for (const phase of [
				"preparing",
				"working",
				"waiting",
				"stopping",
				"compacting",
				"retrying",
				"settling",
			] as const) {
				host.run(phase);
				expect(workspace.getSessionRuntimes()[0].running).toBe(true);
			}
			host.run("idle");
			expect(workspace.getSessionRuntimes()[0].running).toBe(false);
			host.run("initializing");
			expect(workspace.getSessionRuntimes()[0].running).toBe(false);
		} finally {
			await workspace.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("初始化与真实任务的运行标记验证结束");
		}
	});
	it.each(["idle", "working"] as const)("preserves a newer %s event over a delayed snapshot", async (phase) => {
		logger.info("开始验证旧快照与新运行事件顺序");
		const directory = await mkdtemp(join(tmpdir(), "workspace-run-"));
		if (dirname(directory) !== tmpdir()) throw new Error("测试目录清理越界");
		const host = new RunHost(await realpath(directory));
		host.current.run.phase = phase === "idle" ? "working" : "idle";
		vi.spyOn(host, "getSnapshot")
			.mockImplementationOnce(async () => structuredClone(host.current))
			.mockImplementationOnce(async () => {
				// 1.4 快照已经生成，新事件却先抵达订阅者。
				const stale = structuredClone(host.current);
				host.run(phase);
				return stale;
			});
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		try {
			await workspace.attach(directory);
			expect(workspace.getSessionRuntimes()[0].running).toBe(phase === "working");
			// 1.5 同代次的重复或迟到事件也不能覆盖新状态。
			host.emit({
				type: "event",
				value: {
					sessionId: host.current.sessionId,
					generation: host.current.generation,
					seq: host.current.seq,
					event: { type: "run", run: { phase: phase === "idle" ? "working" : "idle" } },
				},
			});
			expect(workspace.getSessionRuntimes()[0].running).toBe(phase === "working");
		} finally {
			await workspace.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("旧快照与新运行事件顺序验证结束");
		}
	});
	it("releases a new host and subscription if reconciliation fails", async () => {
		logger.info("开始验证状态补读失败后的清理");
		const directory = await mkdtemp(join(tmpdir(), "workspace-run-"));
		if (dirname(directory) !== tmpdir()) throw new Error("测试目录清理越界");
		const host = new RunHost(await realpath(directory));
		vi.spyOn(host, "getSnapshot")
			.mockResolvedValueOnce(structuredClone(host.current))
			.mockRejectedValueOnce(new Error("宿主退出"));
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		try {
			// 1.6 登记未完成不能留下订阅或伪造的侧栏宿主。
			await expect(workspace.attach(directory)).rejects.toThrow("宿主退出");
			expect(host.isClosed).toBe(true);
			expect(host.listeners.size).toBe(0);
			expect(workspace.getSessionRuntimes()).toEqual([]);
			expect(await workspace.getSnapshot()).toBeNull();
		} finally {
			await workspace.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("状态补读失败后的清理验证结束");
		}
	});
	it("reconciles a run that settles before host subscription is installed", async () => {
		logger.info("开始验证登记期间的空闲事件");
		const directory = await mkdtemp(join(tmpdir(), "workspace-run-"));
		if (dirname(directory) !== tmpdir()) throw new Error("测试目录清理越界");
		const host = new RunHost(await realpath(directory));
		host.current.run.phase = "working";
		vi.spyOn(host, "listSessions").mockImplementationOnce(async () => {
			// 1.1 首次快照仍在运行，查历史期间任务已结束，空闲事件早于订阅。
			host.run("idle");
			return [
				{ id: host.current.sessionId, title: "会话", preview: "", messageCount: 0, persisted: false, updatedAt: 1 },
			];
		});
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		try {
			await workspace.attach(directory);
			expect((await workspace.getSnapshot())?.run.phase).toBe("idle");
			expect(workspace.getSessionRuntimes()[0].running).toBe(false);
		} finally {
			await workspace.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("登记期间空闲事件验证结束");
		}
	});
	it("does not turn a pending configuration command into a running task", async () => {
		logger.info("开始验证元数据命令运行标记");
		const directory = await mkdtemp(join(tmpdir(), "workspace-run-"));
		if (dirname(directory) !== tmpdir()) throw new Error("测试目录清理越界");
		const host = new RunHost(await realpath(directory));
		let finish = () => {};
		let enter = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		host.execute = async (envelope) => {
			if (envelope.command.type !== "setThinking") return;
			enter();
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		};
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		try {
			await workspace.attach(directory);
			const pending = workspace.dispatch({
				requestId: "config",
				sessionId: host.current.sessionId,
				generation: host.current.generation,
				command: { type: "setThinking", level: "off" },
			});
			await entered;
			// 1.2 宿主已空闲，即使设置请求仍在途也不显示任务转圈。
			host.run("idle");
			const running = workspace.getSessionRuntimes()[0].running;
			await workspace.dispatch({
				requestId: "notice",
				sessionId: host.current.sessionId,
				generation: host.current.generation,
				command: { type: "dismissNotice", id: crypto.randomUUID() },
			});
			expect(workspace.getSessionRuntimes()[0].running).toBe(false);
			finish();
			await pending;
			expect(running).toBe(false);
		} finally {
			finish();
			await workspace.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("元数据命令运行标记验证结束");
		}
	});
});
