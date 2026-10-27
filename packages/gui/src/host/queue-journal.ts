import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "../shared/logger.ts";
import {
	QUEUE_TEXT_LIMIT,
	type QueueContent,
	type QueueItem,
	type QueueMode,
	queueItemSchema,
	queueModeSchema,
} from "../shared/queue.ts";
import { writeJsonAtomically } from "../storage/atomic-json.ts";

const entrySchema = queueItemSchema.extend({ id: z.string().min(1), mode: queueModeSchema });
const journalSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(20) });
type Entry = z.infer<typeof entrySchema>;

/*
 * ========================================================================
 * 步骤1：先保存排队意图，再交给 SDK 调度
 * ========================================================================
 * 数据源：已验证的用户输入与 SDK 收束后的剩余队列。
 * 操作：
 *   1) 请求编号只关联写前记录，不冒充 SDK 消息身份
 *   2) 运行中保留已接收记录，任务收束后才检查剩余队列
 *   3) 重启只提供待核对内容，不自动重放可能已执行的输入
 */
export class QueueJournal {
	private readonly directory: string;
	private readonly name: string;
	private readonly logger: Logger;
	private entries: Entry[] = [];
	private recovered: Entry[] = [];
	private pending: Promise<unknown> = Promise.resolve();
	private loaded = false;

	constructor(directory: string, cwd: string, sessionId: string, logger: Logger) {
		this.directory = directory;
		this.name = `queue-${createHash("sha256").update(`${cwd}\0${sessionId}`).digest("hex")}.json`;
		this.logger = logger;
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.logger.info("开始读取队列恢复记录");
		try {
			// 1.1 文件损坏时拒绝启动，保留原文供恢复。
			try {
				this.recovered = journalSchema.parse(
					JSON.parse(await readFile(join(this.directory, this.name), "utf8")),
				).entries;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
					throw new Error("队列恢复记录无法读取，请保留原文件后检查");
			}
			this.loaded = true;
		} finally {
			this.logger.info("队列恢复记录读取结束");
		}
	}

	get recovery(): QueueContent {
		return {
			steering: this.recovered
				.filter((entry) => entry.mode === "steer")
				.map(({ text, imageIds }) => ({ text, ...(imageIds?.length ? { imageIds } : {}) })),
			followUp: this.recovered
				.filter((entry) => entry.mode === "followUp")
				.map(({ text, imageIds }) => ({ text, ...(imageIds?.length ? { imageIds } : {}) })),
		};
	}

	get interrupted(): QueueContent {
		const entries = [...this.recovered, ...this.entries];
		return {
			steering: entries
				.filter((entry) => entry.mode === "steer")
				.map(({ text, imageIds }) => ({ text, ...(imageIds?.length ? { imageIds } : {}) })),
			followUp: entries
				.filter((entry) => entry.mode === "followUp")
				.map(({ text, imageIds }) => ({ text, ...(imageIds?.length ? { imageIds } : {}) })),
		};
	}

	get count(): number {
		return this.entries.length + this.recovered.length;
	}

	get textLength(): number {
		return [...this.entries, ...this.recovered].reduce((length, entry) => length + entry.text.length, 0);
	}

	private write(change: () => { entries: Entry[]; recovered: Entry[] }): Promise<void> {
		const result = this.pending.then(async () => {
			if (!this.loaded) throw new Error("请先读取队列恢复记录");
			const next = change();
			const data = journalSchema.parse({ version: 1, entries: [...next.recovered, ...next.entries] });
			await writeJsonAtomically(this.directory, this.name, data, this.logger);
			this.entries = next.entries;
			this.recovered = next.recovered;
		});
		this.pending = result.catch(() => {});
		return result;
	}

	prepare(id: string, mode: QueueMode, text: string, imageIds?: string[]): Promise<void> {
		return this.write(() => {
			if (this.entries.some((entry) => entry.id === id)) throw new Error("入队请求编号重复");
			return {
				entries: [...this.entries, { id, mode, text, ...(imageIds?.length ? { imageIds } : {}) }],
				recovered: this.recovered,
			};
		});
	}

	rollback(id: string): Promise<void> {
		return this.write(() => ({ entries: this.entries.filter((entry) => entry.id !== id), recovered: this.recovered }));
	}

	/*
	 * ========================================================================
	 * 步骤2：先保存单条修改意图，失败后可恢复原记录
	 * ========================================================================
	 * 数据源：入队请求身份和修改后的正文、模式及附件。
	 * 操作：1) 保留其他已接收记录；2) SDK 拒绝迟到修改时恢复写前状态。
	 */
	async amend(id: string, replacement: { mode: QueueMode; item: QueueItem } | null): Promise<() => Promise<void>> {
		this.logger.info("开始保存队列修改意图");
		let previous: Entry[] = [];
		try {
			// 2.1 变更只替换目标记录，不丢弃本轮已消费输入的恢复信息。
			await this.write(() => {
				previous = this.entries;
				const original = this.entries.find((entry) => entry.id === id);
				const next = replacement ? { ...replacement.item, id, mode: replacement.mode } : undefined;
				const entries =
					next && original?.mode === next.mode
						? this.entries.map((entry) => (entry.id === id ? next : entry))
						: [...this.entries.filter((entry) => entry.id !== id), ...(next ? [next] : [])];
				if ([...entries, ...this.recovered].reduce((length, entry) => length + entry.text.length, 0) > QUEUE_TEXT_LIMIT)
					throw new Error("本轮追加消息已达长度上限");
				return { entries, recovered: this.recovered };
			});
			return () => this.write(() => ({ entries: previous, recovered: this.recovered }));
		} finally {
			this.logger.info("队列修改意图保存结束");
		}
	}

	checkpoint(queue: QueueContent): Promise<void> {
		return this.write(() => ({
			entries: [
				...queue.steering.map((item) => ({ id: randomUUID(), mode: "steer" as const, ...item })),
				...queue.followUp.map((item) => ({ id: randomUUID(), mode: "followUp" as const, ...item })),
			],
			recovered: this.recovered,
		}));
	}

	clear(): Promise<void> {
		return this.write(() => ({ entries: [], recovered: [] }));
	}

	hold(): Promise<void> {
		return this.write(() => ({ entries: [], recovered: [...this.recovered, ...this.entries] }));
	}
}
