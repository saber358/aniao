import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ParallelHost } from "../src/main/parallel-scheduler.ts";
import { ParallelScheduler } from "../src/main/parallel-scheduler.ts";
import type { CommandEnvelope, SessionSnapshot } from "../src/shared/protocol.ts";
import { snapshotSchema } from "../src/shared/protocol.ts";

class FakeHost implements ParallelHost {
	readonly cwd: string;
	readonly isClosed = false;
	private snapshot: SessionSnapshot;
	private finishPrompt?: () => void;
	private prompt?: Promise<void>;

	constructor(cwd: string) {
		this.cwd = cwd;
		this.snapshot = snapshot(`session-${cwd}`);
	}

	async getSnapshot(): Promise<SessionSnapshot> {
		return this.snapshot;
	}

	async dispatch(envelope: CommandEnvelope): Promise<void> {
		if (envelope.command.type === "abort") {
			this.finishPrompt?.();
			return;
		}
		if (envelope.command.type !== "prompt") return;
		this.prompt = new Promise<void>((resolve) => {
			this.finishPrompt = resolve;
		});
		await this.prompt;
		this.snapshot = {
			...this.snapshot,
			messages: [
				{
					id: "message-1",
					role: "assistant",
					blocks: [{ kind: "text", text: `completed ${this.cwd}` }],
				},
			],
		};
	}

	complete(): void {
		this.finishPrompt?.();
	}

	async close(): Promise<void> {
		this.complete();
	}
}

function snapshot(sessionId: string): SessionSnapshot {
	return snapshotSchema.parse({
		version: 1,
		sessionId,
		generation: "generation-1",
		seq: 0,
		cwd: "/tmp/project",
		title: "task",
		messages: [],
		tools: [],
		run: { phase: "idle" },
		configuration: { model: null, models: [], thinking: "off", thinkingLevels: ["off"] },
		queue: { steering: [], followUp: [], recovery: { steering: [], followUp: [] }, error: null },
		dialogs: [],
		authentication: { providers: [], flow: null },
		extensions: { notices: [], statuses: [], widgets: [], supported: [] },
	});
}

async function waitFor(check: () => boolean, timeout = 2000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("等待并行状态超时");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("parallel scheduler", () => {
	/*
	 * ========================================================================
	 * 步骤3：验证持久化失败仍关闭宿主且不覆盖损坏记录
	 * ========================================================================
	 * 数据源：独立临时目录与等待中的离线宿主。
	 * 操作：1) 用目录阻止原子替换；2) 损坏初始化后退出仍保留原文。
	 */
	it("closes active hosts even when shutdown persistence fails", async () => {
		const logger = console;
		logger.info("开始验证保存失败后的宿主回收");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-parallel-"));
		const store = join(directory, "jobs.json");
		const host = new FakeHost("/isolated/task");
		const close = vi.spyOn(host, "close");
		const dispatch = vi.spyOn(host, "dispatch");
		const scheduler = new ParallelScheduler(
			store,
			() => host,
			async () => ({ cwd: host.cwd }),
		);
		try {
			// 3.1 先等任务真实进入等待，再制造记录替换失败。
			await scheduler.initialize();
			await scheduler.start({ cwd: "/source", text: "wait" });
			await waitFor(() => dispatch.mock.calls.some(([command]) => command.command.type === "prompt"));
			await rm(store);
			await mkdir(store);
			// 3.2 close 必须报告磁盘错误，同时完成等待中的宿主清理。
			await expect(scheduler.close()).rejects.toThrow();
			expect(close).toHaveBeenCalled();
			expect(scheduler.list()[0]?.status).toBe("canceled");
		} finally {
			await scheduler.close().catch(() => {});
			await rm(directory, { recursive: true, force: true });
			logger.info("保存失败后的宿主回收验证结束");
		}
	});

	it("preserves a corrupt record when closing after failed initialization", async () => {
		const logger = console;
		logger.info("开始验证损坏后台记录的退出保护");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-parallel-"));
		const store = join(directory, "jobs.json");
		const original = "{broken-job-record";
		const scheduler = new ParallelScheduler(
			store,
			() => new FakeHost("/isolated"),
			async () => ({ cwd: "/isolated" }),
		);
		try {
			// 3.3 初始化失败后不接收新任务，退出也不能写入空列表。
			await writeFile(store, original);
			await expect(scheduler.initialize()).rejects.toThrow("已保留原文件");
			await expect(scheduler.start({ cwd: "/source", text: "task" })).rejects.toThrow("尚未就绪");
			await scheduler.close();
			expect(await readFile(store, "utf8")).toBe(original);
		} finally {
			await scheduler.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("损坏后台记录的退出保护验证结束");
		}
	});

	/*
	 * ========================================================================
	 * 步骤2：验证取消收束、错误结果和目录隔离
	 * ========================================================================
	 * 数据源：可延迟退出的离线宿主；不调用真实模型。
	 * 操作：1) 取消不释放活跃名额；2) 错误状态与实际 cwd 必须持久化。
	 */
	it("keeps the slot until a canceled host has fully closed", async () => {
		const logger = console;
		logger.info("开始验证取消后的并发上限");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-parallel-"));
		const hosts: FakeHost[] = [];
		let releaseClose = () => {};
		let closing = false;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const scheduler = new ParallelScheduler(
			join(directory, "jobs.json"),
			(cwd) => {
				const host = new FakeHost(cwd);
				if (!hosts.length)
					vi.spyOn(host, "close").mockImplementation(async () => {
						closing = true;
						await closeGate;
					});
				hosts.push(host);
				return host;
			},
			async (job) => ({ cwd: job.cwd }),
		);
		try {
			// 2.1 abort 返回后宿主仍在清理，第三个任务必须继续排队。
			await scheduler.initialize();
			const first = await scheduler.start({ cwd: "/tmp/project", text: "first" });
			await scheduler.start({ cwd: "/tmp/project", text: "second" });
			await waitFor(() => hosts.length === 2);
			await scheduler.cancel(first.id);
			await waitFor(() => closing);
			await scheduler.start({ cwd: "/tmp/project", text: "third" });
			expect(hosts).toHaveLength(2);
			expect(scheduler.list().find((job) => job.title === "third")?.status).toBe("queued");
			// 2.2 关闭真正结束后才允许下一任务创建宿主。
			releaseClose();
			await waitFor(() => hosts.length === 3);
		} finally {
			releaseClose();
			await scheduler.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("取消后的并发上限验证结束");
		}
	});

	it("records assistant errors as failed and starts only in the prepared workspace", async () => {
		const logger = console;
		logger.info("开始验证后台错误和目录隔离");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-parallel-"));
		const current = snapshot("offline-error");
		const create = vi.fn(
			(_cwd: string): ParallelHost => ({
				isClosed: false,
				getSnapshot: async () => current,
				dispatch: async () => {
					current.messages = [{ id: "error", role: "assistant", blocks: [], error: "offline failure" }];
				},
				close: async () => {},
			}),
		);
		const scheduler = new ParallelScheduler(join(directory, "jobs.json"), create, async () => ({
			cwd: "/isolated/task",
			branch: "codex/task-test",
		}));
		try {
			// 2.3 Promise 正常结束但快照含错误，不能报告成功。
			await scheduler.initialize();
			await scheduler.start({ cwd: "/source/project", text: "task" });
			await waitFor(() => scheduler.list()[0]?.status === "failed");
			expect(create).toHaveBeenCalledWith("/isolated/task");
			expect(scheduler.list()[0]).toMatchObject({
				error: "offline failure",
				executionCwd: "/isolated/task",
				branch: "codex/task-test",
			});
		} finally {
			await scheduler.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("后台错误和目录隔离验证结束");
		}
	});

	it("does not start a host when workspace preparation fails", async () => {
		const logger = console;
		logger.info("开始验证隔离失败保护");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-parallel-"));
		const create = vi.fn(() => new FakeHost("/source"));
		const scheduler = new ParallelScheduler(join(directory, "jobs.json"), create, async () => {
			throw new Error("worktree unavailable");
		});
		try {
			// 2.4 目录准备失败必须失败，不回退到源项目。
			await scheduler.initialize();
			await scheduler.start({ cwd: "/source", text: "task" });
			await waitFor(() => scheduler.list()[0]?.status === "failed");
			expect(create).not.toHaveBeenCalled();
		} finally {
			await scheduler.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("隔离失败保护验证结束");
		}
	});
	it("runs two jobs and queues the next one", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-parallel-"));
		const hosts: FakeHost[] = [];
		const scheduler = new ParallelScheduler(
			join(directory, "jobs.json"),
			(cwd) => {
				const host = new FakeHost(cwd);
				hosts.push(host);
				return host;
			},
			async (job) => ({ cwd: job.cwd }),
		);
		try {
			await scheduler.initialize();
			await scheduler.start({ cwd: "/tmp/project", text: "first" });
			await scheduler.start({ cwd: "/tmp/project", text: "second" });
			await scheduler.start({ cwd: "/tmp/project", text: "third" });
			await waitFor(() => hosts.length === 2);
			expect(scheduler.list().map((job) => job.status)).toEqual(["queued", "running", "running"]);

			hosts[0].complete();
			await waitFor(() => scheduler.list().some((job) => job.status === "completed"));
			await waitFor(() => hosts.length === 3);
			expect(scheduler.list().find((job) => job.title === "third")?.status).toBe("running");
		} finally {
			await scheduler.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("marks unfinished jobs as interrupted after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-parallel-"));
		const store = join(directory, "jobs.json");
		await writeFile(
			store,
			JSON.stringify([
				{
					id: "00000000-0000-4000-8000-000000000001",
					cwd: "/tmp/project",
					title: "unfinished",
					prompt: "do work",
					status: "running",
					createdAt: 1,
					startedAt: 2,
				},
			]),
		);
		const scheduler = new ParallelScheduler(
			store,
			() => new FakeHost("/tmp/project"),
			async (job) => ({ cwd: job.cwd }),
		);
		try {
			await scheduler.initialize();
			expect(scheduler.list()[0]?.status).toBe("interrupted");
			expect(JSON.parse(await readFile(store, "utf8"))[0].status).toBe("interrupted");
		} finally {
			await scheduler.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
