import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { parseSessionEntries, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { HistoryScan, UsageSnapshot } from "../shared/data-statistics.ts";
import type { Logger } from "../shared/logger.ts";

export function localDate(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/*
 * ========================================================================
 * 步骤1：累计原生历史中的用量事实
 * ========================================================================
 * 数据源：助手、缓存、压缩和分支摘要的 SDK Usage。
 * 操作：1) 相同分支复制记录只计一次；2) 记录日期、模型和会话内实际回合时长。
 */
export class UsageAccumulator {
	private readonly seen = new Set<string>();
	private readonly activity = new Set<string>();
	private readonly turns = new Map<string, number>();
	private readonly days = new Map<string, UsageSnapshot["daily"][number]>();
	private total = 0;
	private peak = 0;
	private longest = 0;
	private readonly logger: Logger;
	constructor(logger: Logger) {
		this.logger = logger;
	}
	add(entries: SessionEntry[]): void {
		this.logger.info("开始累计会话用量");
		try {
			let provider = "unknown";
			let model = "未知模型";
			let sessionTokens = 0;
			let start = 0;
			let end = 0;
			let duration = 0;
			for (const entry of entries) {
				const timestamp = Date.parse(entry.timestamp);
				if (!Number.isFinite(timestamp)) continue;
				if (entry.type === "model_change") {
					provider = entry.provider;
					model = entry.modelId;
				}
				// 1.1 每个用户回合只累计到最后助手响应，不把两次提问之间的空闲算作聊天。
				if (entry.type === "message" && entry.message.role === "user") {
					if (start && end >= start) duration += end - start;
					start = timestamp;
					end = 0;
					this.activity.add(localDate(timestamp));
					// 1.3 每个原始用户提问计一轮，分支复制和工具往返不追加轮数。
					const turnKey = `turn:${createHash("sha256")
						.update(JSON.stringify([entry.id, entry.timestamp, entry.message]))
						.digest("hex")}`;
					if (!this.seen.has(turnKey)) {
						this.seen.add(turnKey);
						const date = localDate(timestamp);
						this.turns.set(date, (this.turns.get(date) ?? 0) + 1);
					}
				}
				if (entry.type === "message" && entry.message.role === "assistant") end = timestamp;
				const assistant = entry.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
				const usage =
					assistant?.usage ??
					(entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
						? entry.usage
						: undefined);
				if (!usage) continue;
				const tokens = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce(
					(sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0),
					0,
				);
				sessionTokens += tokens;
				const owner = assistant?.provider ?? (entry.type === "usage" ? entry.provider : provider);
				const name = assistant?.model ?? (entry.type === "usage" ? entry.model : model);
				const key = createHash("sha256")
					.update(JSON.stringify([entry.id, entry.timestamp, owner, name, usage]))
					.digest("hex");
				if (this.seen.has(key)) continue;
				this.seen.add(key);
				// 1.2 reasoning 已包含于 output，不额外累加；无报告的 Usage 不做估算。
				if (tokens <= 0) continue;
				const date = localDate(timestamp);
				this.activity.add(date);
				const dayKey = JSON.stringify([date, owner, name]);
				const current = this.days.get(dayKey) ?? { date, provider: owner, model: name, tokens: 0 };
				current.tokens += tokens;
				this.days.set(dayKey, current);
				this.total += tokens;
			}
			if (start && end >= start) duration += end - start;
			this.longest = Math.max(this.longest, duration);
			this.peak = Math.max(this.peak, sessionTokens);
		} finally {
			this.logger.info("会话用量累计结束");
		}
	}
	snapshot(skippedSessions = 0): UsageSnapshot {
		return {
			generatedAt: Date.now(),
			totalTokens: this.total,
			peakTokens: this.peak,
			longestChatMs: this.longest,
			activityDates: [...this.activity].sort(),
			dailyTurns: [...this.turns]
				.map(([date, turns]) => ({ date, turns }))
				.sort((a, b) => a.date.localeCompare(b.date)),
			daily: [...this.days.values()].sort((a, b) => a.date.localeCompare(b.date)),
			skippedSessions,
		};
	}
}

/*
 * ========================================================================
 * 步骤2：只读扫描本机 SDK 历史
 * ========================================================================
 * 数据源：SDK 发现的 JSONL 文件，不调用模型或初始化扩展。
 * 操作：1) 每次只读取一个有界文件；2) 损坏或过大文件显式计入不完整报告。
 */
export async function scanUsageHistory(logger: Logger): Promise<HistoryScan> {
	logger.info("开始扫描本机使用统计");
	try {
		const sessions = await SessionManager.listAll();
		const accumulator = new UsageAccumulator(logger);
		let skipped = Math.max(0, sessions.length - 20000);
		const files: HistoryScan["files"] = [];
		for (const session of sessions.slice(0, 20000)) {
			// 2.1 SDK 只提供已发现的路径，原文留在独立进程，不传入界面。
			files.push({ id: session.id, cwd: session.cwd, path: session.path });
			try {
				if ((await stat(session.path)).size > 64 * 1024 * 1024) {
					skipped++;
					continue;
				}
				const text = await readFile(session.path, "utf8");
				const entries = parseSessionEntries(text);
				if (entries.length !== text.split("\n").filter((line) => line.trim()).length) skipped++;
				accumulator.add(entries.filter((entry): entry is SessionEntry => entry.type !== "session"));
			} catch {
				skipped++;
			}
		}
		return { usage: accumulator.snapshot(skipped), files };
	} finally {
		logger.info("本机使用统计扫描结束");
	}
}
