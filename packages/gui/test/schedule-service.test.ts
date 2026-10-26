import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScheduleRunner } from "../src/main/schedule-service.ts";
import { ScheduleService } from "../src/main/schedule-service.ts";
import type { ParallelJob } from "../src/shared/parallel.ts";

class FakeRunner implements ScheduleRunner {
	readonly jobs: ParallelJob[] = [];
	started = 0;

	async start(request: { cwd: string; text: string }): Promise<ParallelJob> {
		this.started++;
		const job: ParallelJob = {
			id: randomUUID(),
			cwd: request.cwd,
			title: request.text,
			prompt: request.text,
			status: "running",
			createdAt: Date.now(),
		};
		this.jobs.push(job);
		return { ...job };
	}

	list(): ParallelJob[] {
		return this.jobs.map((job) => ({ ...job }));
	}

	async cancel(id: string): Promise<ParallelJob | null> {
		const job = this.jobs.find((item) => item.id === id);
		if (!job) return null;
		job.status = "canceled";
		return { ...job };
	}
}

function task(id: string, catchUp: boolean) {
	return {
		id,
		cwd: "/tmp/project",
		title: id,
		prompt: "run",
		everyMinutes: 5,
		catchUp,
		paused: false,
		createdAt: 0,
		nextRunAt: 0,
	};
}

describe("schedule service", () => {
	/*
	 * ========================================================================
	 * 步骤2：验证损坏调度记录在退出后仍保留
	 * ========================================================================
	 * 数据源：独立临时文件与无外部调用的运行器。
	 * 操作：1) 初始化失败禁止安排；2) close 不写入空状态。
	 */
	it("preserves corrupt storage through shutdown and refuses new schedules", async () => {
		const logger = console;
		logger.info("开始验证损坏调度记录的退出保护");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-schedule-"));
		const store = join(directory, "tasks.json");
		const runner = new FakeRunner();
		const service = new ScheduleService(store, runner);
		const original = "{broken-schedule-record";
		try {
			// 2.1 损坏文件不进入可写状态，定时检查也不能启动任务。
			await writeFile(store, original);
			await expect(service.initialize()).rejects.toThrow("已保留原文件");
			await expect(service.create({ cwd: "/source", text: "task", everyMinutes: 5, catchUp: false })).rejects.toThrow(
				"尚未就绪",
			);
			await service.checkNow();
			expect(runner.started).toBe(0);
			// 2.2 退出只清理计时器，不把失败加载当成空任务。
			await service.close();
			expect(await readFile(store, "utf8")).toBe(original);
		} finally {
			await service.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("损坏调度记录的退出保护验证结束");
		}
	});

	it("starts a due task once and records completion", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-schedule-"));
		const runner = new FakeRunner();
		const notifications: string[] = [];
		let now = 1_000_000;
		const service = new ScheduleService(
			join(directory, "tasks.json"),
			runner,
			(title) => notifications.push(title),
			() => now,
		);
		try {
			await service.initialize();
			const snapshot = await service.create({
				cwd: "/tmp/project",
				text: "run",
				everyMinutes: 5,
				catchUp: false,
			});
			const id = snapshot.tasks[0].id;
			now += 5 * 60_000;
			await service.checkNow();
			expect(runner.started).toBe(1);
			expect(service.list().runs[0]?.status).toBe("running");

			runner.jobs[0].status = "completed";
			runner.jobs[0].result = "done";
			await service.checkNow();
			expect(service.list().runs[0]?.status).toBe("completed");
			expect(service.list().tasks.find((item) => item.id === id)?.nextRunAt).toBeGreaterThan(now);
			expect(notifications).toContain("定时任务完成");

			await service.pause(id, true);
			now += 10 * 60_000;
			await service.checkNow();
			expect(runner.started).toBe(1);
		} finally {
			await service.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("honors catch-up policy for overdue tasks", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-schedule-"));
		const store = join(directory, "tasks.json");
		await writeFile(store, JSON.stringify({ tasks: [task(randomUUID(), true), task(randomUUID(), false)], runs: [] }));
		const runner = new FakeRunner();
		const service = new ScheduleService(
			store,
			runner,
			() => {},
			() => 1_000_000,
		);
		try {
			await service.initialize();
			await service.checkNow();
			expect(runner.started).toBe(1);
			expect(service.list().tasks.filter((item) => item.catchUp)).toHaveLength(1);
		} finally {
			await service.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
