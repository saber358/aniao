import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { createLogger } from "../shared/logger.ts";
import type { ParallelJob, ParallelStart } from "../shared/parallel.ts";
import type { ScheduleCreate, ScheduledRun, ScheduledSnapshot, ScheduledTask } from "../shared/schedule.ts";
import { scheduledRunSchema, scheduledTaskSchema } from "../shared/schedule.ts";
import { writeJsonAtomically } from "../storage/atomic-json.ts";

const MAX_TASKS = 50;
const MAX_RUNS = 200;
const TICK_MS = 5000;
const logger = createLogger("schedule");

export interface ScheduleRunner {
	start(request: ParallelStart): Promise<ParallelJob>;
	list(): ParallelJob[];
	cancel(id: string): Promise<ParallelJob | null>;
}

/*
 * ========================================================================
 * 步骤1：管理本地定时任务与运行记录
 * ========================================================================
 * 数据源：本地任务定义、并行任务执行器和系统时钟。
 * 操作：
 *   1) 到点前先推进 nextRunAt 并持久化，避免重启后重复安排
 *   2) 应用关闭或休眠按 catchUp 策略补跑一次或跳过
 *   3) 运行记录只保存有界结果与错误，不复制聊天正文
 */
export class ScheduleService {
	private readonly storeFile: string;
	private readonly runner: ScheduleRunner;
	private readonly notify: (title: string, body: string) => void;
	private readonly now: () => number;
	private tasks: ScheduledTask[] = [];
	private runs: ScheduledRun[] = [];
	private timer?: ReturnType<typeof setInterval>;
	private checking = false;
	private initialized = false;
	private closed = false;
	private saveQueue = Promise.resolve();

	constructor(
		storeFile: string,
		runner: ScheduleRunner,
		notify: (title: string, body: string) => void = () => {},
		now: () => number = Date.now,
	) {
		this.storeFile = storeFile;
		this.runner = runner;
		this.notify = notify;
		this.now = now;
	}

	async initialize(): Promise<void> {
		try {
			const parsed = z
				.object({
					tasks: z.array(scheduledTaskSchema).max(MAX_TASKS),
					runs: z.array(scheduledRunSchema).max(MAX_RUNS),
				})
				.parse(JSON.parse(await readFile(this.storeFile, "utf8")));
			this.tasks = parsed.tasks;
			this.runs = parsed.runs;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
				throw new Error("定时任务记录无法读取，已保留原文件");
		}
		const now = this.now();
		for (const run of this.runs) {
			if (run.status === "queued" || run.status === "running") {
				run.status = "interrupted";
				run.error = "应用已重启，未自动恢复该次运行";
				run.finishedAt = now;
			}
		}
		for (const task of this.tasks) {
			if (task.paused) continue;
			if (task.nextRunAt > now) continue;
			if (task.catchUp) task.nextRunAt = now;
			else task.nextRunAt = nextAfter(task.nextRunAt, task.everyMinutes, now);
		}
		await this.persist();
		this.initialized = true;
	}

	start(): void {
		if (this.timer || this.closed || !this.initialized) return;
		this.timer = setInterval(() => {
			void this.checkNow().catch(() => logger.info("定时任务检查失败，保留记录等待重试"));
		}, TICK_MS);
		this.timer.unref?.();
	}

	async close(): Promise<void> {
		/*
		 * ========================================================================
		 * 步骤3：停止定时检查并保留初始化失败的原记录
		 * ========================================================================
		 * 数据源：已加载的任务记录与定时器。
		 * 操作：1) 撤下计时器；2) 只保存成功初始化后的状态。
		 */
		logger.info("开始关闭定时任务");
		try {
			// 3.1 无法加载的文件不能在退出时被空列表覆盖。
			this.closed = true;
			if (this.timer) clearInterval(this.timer);
			this.timer = undefined;
			if (!this.initialized) return;
			const now = this.now();
			for (const run of this.runs) {
				if (run.status === "queued" || run.status === "running") {
					run.status = "interrupted";
					run.error = "应用关闭，未完成的运行已停止";
					run.finishedAt = now;
				}
			}
			// 3.2 后台宿主由并行调度器独立关闭。
			await this.persist();
		} finally {
			logger.info("定时任务关闭结束");
		}
	}

	list(): ScheduledSnapshot {
		return {
			tasks: this.tasks.map((task) => ({ ...task })),
			runs: this.runs.map((run) => ({ ...run })).sort((left, right) => right.createdAt - left.createdAt),
			now: this.now(),
		};
	}

	async create(request: ScheduleCreate): Promise<ScheduledSnapshot> {
		if (this.closed || !this.initialized) throw new Error("定时任务尚未就绪或已经关闭");
		if (this.tasks.length >= MAX_TASKS) throw new Error("定时任务数量已达上限");
		const task: ScheduledTask = {
			id: randomUUID(),
			cwd: request.cwd,
			title: request.title?.trim() || request.text.replace(/[\r\n]+/g, " ").slice(0, 120),
			prompt: request.text,
			everyMinutes: request.everyMinutes,
			catchUp: request.catchUp,
			paused: false,
			createdAt: this.now(),
			nextRunAt: this.now() + request.everyMinutes * 60_000,
		};
		this.tasks.push(task);
		await this.persist();
		return this.list();
	}

	async pause(id: string, paused: boolean): Promise<ScheduledSnapshot> {
		const task = this.task(id);
		task.paused = paused;
		if (!paused) task.nextRunAt = this.now() + task.everyMinutes * 60_000;
		await this.persist();
		return this.list();
	}

	async remove(id: string): Promise<ScheduledSnapshot> {
		const index = this.tasks.findIndex((task) => task.id === id);
		if (index < 0) throw new Error("定时任务不存在");
		for (const run of this.runs) {
			if (run.taskId !== id || !run.jobId || (run.status !== "queued" && run.status !== "running")) continue;
			await this.runner.cancel(run.jobId).catch(() => {});
		}
		this.tasks.splice(index, 1);
		this.runs = this.runs.filter((run) => run.taskId !== id);
		await this.persist();
		return this.list();
	}

	async runNow(id: string): Promise<ScheduledSnapshot> {
		const task = this.task(id);
		if (this.hasActiveRun(id)) throw new Error("该任务已有运行中的记录");
		await this.startTask(task, true);
		return this.list();
	}

	async checkNow(): Promise<void> {
		if (this.checking || this.closed || !this.initialized) return;
		this.checking = true;
		try {
			await this.refreshRuns();
			const now = this.now();
			for (const task of this.tasks) {
				if (task.paused || task.nextRunAt > now) continue;
				if (this.hasActiveRun(task.id)) {
					task.nextRunAt = now + task.everyMinutes * 60_000;
					continue;
				}
				const late = now - task.nextRunAt;
				if (late > task.everyMinutes * 60_000 * 1.5 && !task.catchUp) {
					task.nextRunAt = nextAfter(task.nextRunAt, task.everyMinutes, now);
					continue;
				}
				await this.startTask(task, false);
			}
			await this.persist();
		} finally {
			this.checking = false;
		}
	}

	private async startTask(task: ScheduledTask, manual: boolean): Promise<void> {
		const now = this.now();
		const run: ScheduledRun = {
			id: randomUUID(),
			taskId: task.id,
			status: "queued",
			createdAt: now,
		};
		this.runs.push(run);
		task.lastRunAt = now;
		if (!manual) task.nextRunAt = now + task.everyMinutes * 60_000;
		this.pruneRuns();
		// 1.1 先记录运行身份和下一时间，再到并行执行器入队。
		await this.persist();
		try {
			const job = await this.runner.start({ cwd: task.cwd, text: task.prompt });
			run.jobId = job.id;
			run.status = job.status;
			await this.persist();
		} catch (error) {
			run.status = "failed";
			run.error = error instanceof Error ? error.message : "定时任务启动失败";
			run.finishedAt = this.now();
			await this.persist();
			this.notify("定时任务失败", `${task.title}：${run.error}`);
		}
	}

	private async refreshRuns(): Promise<void> {
		const jobs = new Map(this.runner.list().map((job) => [job.id, job]));
		let changed = false;
		for (const run of this.runs) {
			if (run.status !== "queued" && run.status !== "running") continue;
			if (!run.jobId) continue;
			const job = jobs.get(run.jobId);
			if (!job) {
				run.status = "failed";
				run.error = "后台任务记录已丢失";
				run.finishedAt = this.now();
				changed = true;
				continue;
			}
			if (job.status === run.status) continue;
			run.status = job.status;
			changed = true;
			if (job.status === "completed") {
				run.result = job.result;
				run.finishedAt = this.now();
				const task = this.tasks.find((item) => item.id === run.taskId);
				this.notify("定时任务完成", task?.title ?? "定时任务");
			} else if (job.status === "failed") {
				run.error = job.error ?? "后台任务失败";
				run.finishedAt = this.now();
				const task = this.tasks.find((item) => item.id === run.taskId);
				this.notify("定时任务失败", `${task?.title ?? "定时任务"}：${run.error}`);
			} else if (job.status === "canceled" || job.status === "interrupted") {
				run.finishedAt = this.now();
			}
		}
		if (changed) await this.persist();
	}

	private hasActiveRun(taskId: string): boolean {
		return this.runs.some((run) => run.taskId === taskId && (run.status === "queued" || run.status === "running"));
	}

	private pruneRuns(): void {
		if (this.runs.length <= MAX_RUNS) return;
		const active = this.runs.filter((run) => run.status === "queued" || run.status === "running");
		this.runs = this.runs
			.filter((run) => run.status === "queued" || run.status === "running")
			.concat(
				this.runs
					.filter((run) => run.status !== "queued" && run.status !== "running")
					.sort((left, right) => right.createdAt - left.createdAt)
					.slice(0, Math.max(0, MAX_RUNS - active.length)),
			);
	}

	private task(id: string): ScheduledTask {
		if (this.closed || !this.initialized) throw new Error("定时任务尚未就绪或已经关闭");
		const task = this.tasks.find((item) => item.id === id);
		if (!task) throw new Error("定时任务不存在");
		return task;
	}

	private persist(): Promise<void> {
		/*
		 * ========================================================================
		 * 步骤2：串行同步并原子替换调度记录
		 * ========================================================================
		 * 数据源：任务定义与运行快照，不记录业务负载。
		 * 操作：1) 拷贝本次状态；2) 同步到磁盘后才完成保存。
		 */
		const data = structuredClone({ tasks: this.tasks, runs: this.runs });
		const save = async () => {
			logger.info("开始保存定时任务记录");
			try {
				// 2.1 避免异步写入读到之后变更的状态。
				await writeJsonAtomically(dirname(this.storeFile), basename(this.storeFile), data, logger);
			} finally {
				logger.info("定时任务记录保存结束");
			}
		};
		this.saveQueue = this.saveQueue.then(save, save);
		return this.saveQueue;
	}
}

function nextAfter(previous: number, everyMinutes: number, now: number): number {
	const interval = everyMinutes * 60_000;
	const missed = Math.max(1, Math.ceil((now - previous + 1) / interval));
	return previous + missed * interval;
}
