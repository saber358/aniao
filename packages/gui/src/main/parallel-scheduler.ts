import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { createLogger } from "../shared/logger.ts";
import type { ParallelJob, ParallelStart } from "../shared/parallel.ts";
import { parallelJobSchema } from "../shared/parallel.ts";
import type { AgentPort, CommandEnvelope, SessionSnapshot } from "../shared/protocol.ts";
import { writeJsonAtomically } from "../storage/atomic-json.ts";

const MAX_RUNNING = 2;
const MAX_JOBS = 20;
const RESULT_LIMIT = 8000;
const logger = createLogger("parallel");

export interface ParallelHost extends Pick<AgentPort, "dispatch"> {
	getSnapshot(): Promise<SessionSnapshot>;
	close(): Promise<void>;
	readonly isClosed: boolean;
}

interface ActiveRun {
	requestId: string;
	sessionId: string;
	generation: string;
}

/*
 * ========================================================================
 * 步骤1：管理独立后台会话槽位
 * ========================================================================
 * 数据源：每个任务自己的 utilityProcess 宿主与项目 cwd。
 * 操作：
 *   1) 最多两个任务同时运行，超出的任务持久化排队
 *   2) 记录完成、失败、取消和重启中断，不自动重放未完成任务
 */
export class ParallelScheduler {
	private readonly storeFile: string;
	private readonly createHost: (cwd: string) => ParallelHost;
	private readonly prepareWorkspace: (job: ParallelJob) => Promise<{ cwd: string; branch?: string }>;
	private jobs: ParallelJob[] = [];
	private readonly hosts = new Map<string, ParallelHost>();
	private readonly runs = new Map<string, ActiveRun>();
	private readonly cancelRequested = new Set<string>();
	private readonly active = new Map<string, Promise<void>>();
	private initialized = false;
	private closed = false;
	private saveQueue = Promise.resolve();

	constructor(
		storeFile: string,
		createHost: (cwd: string) => ParallelHost,
		prepareWorkspace: (job: ParallelJob) => Promise<{ cwd: string; branch?: string }>,
	) {
		this.storeFile = storeFile;
		this.createHost = createHost;
		this.prepareWorkspace = prepareWorkspace;
	}

	async initialize(): Promise<void> {
		try {
			const parsed = z
				.array(parallelJobSchema)
				.max(MAX_JOBS)
				.parse(JSON.parse(await readFile(this.storeFile, "utf8")));
			{
				const now = Date.now();
				this.jobs = parsed.map((job) =>
					job.status === "running" || job.status === "queued"
						? { ...job, status: "interrupted" as const, error: "应用已重启，未自动恢复该任务", finishedAt: now }
						: job,
				);
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
				throw new Error("并行任务记录无法读取，已保留原文件");
		}
		await this.persist();
		this.initialized = true;
	}

	list(): ParallelJob[] {
		return this.jobs.map((job) => ({ ...job })).sort((left, right) => right.createdAt - left.createdAt);
	}

	get(id: string): ParallelJob | null {
		const job = this.jobs.find((item) => item.id === id);
		return job ? { ...job } : null;
	}

	async start(request: ParallelStart): Promise<ParallelJob> {
		if (this.closed) throw new Error("并行任务已关闭");
		if (!this.initialized) throw new Error("并行任务尚未就绪，请检查任务记录");
		if (this.jobs.length >= MAX_JOBS && !this.pruneFinished()) throw new Error("并行任务记录已达上限");
		const job: ParallelJob = {
			id: randomUUID(),
			cwd: request.cwd,
			title: request.text.replace(/[\r\n]+/g, " ").slice(0, 120),
			prompt: request.text,
			status: "queued",
			createdAt: Date.now(),
		};
		this.jobs.push(job);
		try {
			await this.persist();
		} catch (error) {
			this.jobs = this.jobs.filter((entry) => entry !== job);
			throw error;
		}
		this.pump();
		return { ...job };
	}

	async cancel(id: string): Promise<ParallelJob | null> {
		const job = this.jobs.find((item) => item.id === id);
		if (!job) return null;
		if (job.status === "queued") {
			job.status = "canceled";
			job.finishedAt = Date.now();
			await this.persist();
			return { ...job };
		}
		if (job.status !== "running") throw new Error("任务已经结束");
		job.status = "canceled";
		job.finishedAt = Date.now();
		this.cancelRequested.add(id);
		const host = this.hosts.get(id);
		const run = this.runs.get(id);
		if (host && run) {
			const envelope: CommandEnvelope = {
				requestId: randomUUID(),
				sessionId: run.sessionId,
				generation: run.generation,
				command: { type: "abort" },
			};
			void host.dispatch(envelope).catch(() => {});
		}
		await this.persist();
		return { ...job };
	}

	async close(): Promise<void> {
		/*
		 * ========================================================================
		 * 步骤3：保存失败时仍等待所有后台宿主释放
		 * ========================================================================
		 * 数据源：活动任务、宿主注册表与串行写入队列。
		 * 操作：1) 初始化失败不覆盖原记录；2) 写入失败也必须关闭宿主。
		 */
		logger.info("开始关闭后台任务");
		try {
			// 3.1 先禁止新任务，取消状态不代表宿主已经退出。
			this.closed = true;
			for (const job of this.jobs) {
				if (job.status === "running") {
					job.status = "canceled";
					job.error = "应用关闭，任务已停止";
					job.finishedAt = Date.now();
					this.cancelRequested.add(job.id);
				}
			}
			try {
				if (this.initialized) await this.persist();
			} finally {
				// 3.2 无论磁盘是否可写，都等待宿主和准备中的任务回收。
				await Promise.allSettled([...this.hosts.values()].map((host) => host.close()));
				await Promise.allSettled(this.active.values());
				await this.saveQueue;
			}
		} finally {
			logger.info("后台任务关闭结束");
		}
	}

	private pump(): void {
		if (this.closed) return;
		let slots = MAX_RUNNING - this.active.size;
		for (const job of this.jobs) {
			if (slots <= 0) break;
			if (job.status !== "queued") continue;
			job.status = "running";
			job.startedAt = Date.now();
			slots -= 1;
			const running = Promise.resolve().then(() => this.runJob(job));
			this.active.set(job.id, running);
			void running.catch(() => logger.info("后台任务持久化失败，已停止继续调度"));
		}
	}

	private pruneFinished(): boolean {
		const terminal = ["completed", "failed", "canceled", "interrupted"];
		const index = this.jobs.findIndex((job) => terminal.includes(job.status) && !this.active.has(job.id));
		if (index < 0) return false;
		this.jobs.splice(index, 1);
		return true;
	}

	private async runJob(job: ParallelJob): Promise<void> {
		/*
		 * ========================================================================
		 * 步骤2：隔离目录后运行并核对最终消息
		 * ========================================================================
		 * 数据源：持久化任务身份、独立工作树和宿主最终快照。
		 * 操作：1) 保存实际 cwd 后启动；2) 宿主退出后才释放并发名额。
		 */
		logger.info("开始运行隔离后台任务");
		let host: ParallelHost | undefined;
		try {
			// 2.1 创建失败不会退回共享项目目录运行。
			await this.persist();
			const workspace = await this.prepareWorkspace({ ...job });
			job.executionCwd = workspace.cwd;
			job.branch = workspace.branch;
			await this.persist();
			if (this.closed || this.cancelRequested.has(job.id)) return;
			host = this.createHost(workspace.cwd);
			this.hosts.set(job.id, host);
			let snapshot = await host.getSnapshot();
			// 2.3 ready 先于扩展初始化结束；等待空闲，遇到交互则明确失败。
			const deadline = Date.now() + 60_000;
			while (snapshot.run.phase !== "idle" || snapshot.dialogs.length) {
				if (this.closed || this.cancelRequested.has(job.id)) return;
				if (snapshot.dialogs.length) throw new Error("后台任务启动需要用户交互，请检查扩展配置");
				if (Date.now() >= deadline) throw new Error("后台宿主初始化超时");
				await new Promise((resolve) => setTimeout(resolve, 50));
				snapshot = await host.getSnapshot();
			}
			if (this.cancelRequested.has(job.id)) return;
			job.sessionId = snapshot.sessionId;
			const run: ActiveRun = {
				requestId: randomUUID(),
				sessionId: snapshot.sessionId,
				generation: snapshot.generation,
			};
			this.runs.set(job.id, run);
			await this.persist();
			if (this.closed || this.cancelRequested.has(job.id)) return;
			const envelope: CommandEnvelope = {
				requestId: run.requestId,
				sessionId: run.sessionId,
				generation: run.generation,
				command: { type: "prompt", text: job.prompt },
			};
			await host.dispatch(envelope);
			if (this.cancelRequested.has(job.id)) return;
			const latest = await host.getSnapshot();
			// 2.2 SDK 错误消息正常收束也属于失败，不能只看 Promise 是否抛错。
			const answer = [...latest.messages].reverse().find((message) => message.role === "assistant");
			if (answer?.error) throw new Error(answer.error);
			if (latest.run.phase !== "idle" || !answer) throw new Error("后台任务未正常收束或没有返回结果");
			job.result = lastAssistantText(latest);
			job.status = "completed";
		} catch (error) {
			if (!this.cancelRequested.has(job.id)) {
				job.status = "failed";
				job.error = error instanceof Error ? error.message : "后台任务失败";
			}
		} finally {
			this.runs.delete(job.id);
			if (this.cancelRequested.has(job.id)) {
				job.finishedAt ??= Date.now();
			} else if (job.status === "completed" || job.status === "failed") {
				job.finishedAt = Date.now();
			}
			await host?.close().catch(() => {});
			this.hosts.delete(job.id);
			this.cancelRequested.delete(job.id);
			try {
				await this.persist();
			} catch {
				this.closed = true;
				logger.info("后台任务记录保存失败，已暂停调度并保留工作树");
			} finally {
				this.active.delete(job.id);
				this.pump();
				logger.info("隔离后台任务运行结束");
			}
		}
	}

	private persist(): Promise<void> {
		const data = structuredClone(this.jobs);
		const save = () => writeJsonAtomically(dirname(this.storeFile), basename(this.storeFile), data, logger);
		this.saveQueue = this.saveQueue.then(save, save);
		return this.saveQueue;
	}
}

function lastAssistantText(snapshot: SessionSnapshot): string {
	const message = [...snapshot.messages].reverse().find((item) => item.role === "assistant");
	if (!message) return "";
	const text = message.blocks
		.filter((block) => block.kind === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return text.slice(0, RESULT_LIMIT);
}
