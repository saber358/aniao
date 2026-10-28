import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dateKey, formatTokens, usageSeries, usageStreak } from "../src/domain/usage-statistics.ts";
import { scanUsageHistory, UsageAccumulator } from "../src/host/usage-reader.ts";

const logger = { info: vi.fn() };
const usage = {
	input: 100,
	output: 30,
	cacheRead: 20,
	cacheWrite: 10,
	reasoning: 15,
	totalTokens: 160,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function entries(id = "answer", day = "2026-10-28", model = "model-a"): SessionEntry[] {
	return [
		{
			type: "message",
			id: `${id}-user`,
			parentId: null,
			timestamp: `${day}T10:00:00`,
			message: { role: "user", content: "任务", timestamp: new Date(`${day}T10:00:00`).getTime() },
		},
		{
			type: "message",
			id,
			parentId: `${id}-user`,
			timestamp: `${day}T10:02:00`,
			message: {
				role: "assistant",
				provider: "fixture",
				model,
				api: "openai-completions",
				content: [{ type: "text", text: "完成" }],
				usage,
				stopReason: "stop",
				timestamp: new Date(`${day}T10:02:00`).getTime(),
			},
		},
	];
}

/*
 * ========================================================================
 * 步骤1：验证原生用量聚合和日期口径
 * ========================================================================
 * 数据源：SDK 类型的助手、缓存与分支复制记录。
 * 操作：1) 不重复累加 reasoning 和分支历史；2) 零值、间断和跨月边界真实可解释。
 */
describe("usage statistics", () => {
	afterEach(() => vi.unstubAllEnvs());
	it("counts token categories once, deduplicates copied branches and excludes idle gaps", () => {
		logger.info("开始验证真实用量聚合");
		const accumulator = new UsageAccumulator(logger);
		accumulator.add([...entries(), ...entries("second", "2026-10-29")]);
		accumulator.add(entries());
		expect(accumulator.snapshot()).toMatchObject({ totalTokens: 320, peakTokens: 320, longestChatMs: 240000 });
		expect(accumulator.snapshot().daily).toHaveLength(2);
		expect(accumulator.snapshot().activityDates).toEqual(["2026-10-28", "2026-10-29"]);
		expect(accumulator.snapshot().dailyTurns).toEqual([
			{ date: "2026-10-28", turns: 1 },
			{ date: "2026-10-29", turns: 1 },
		]);
		logger.info("真实用量聚合验证结束");
	});
	it("includes auxiliary usage and groups identical model ids by provider", () => {
		logger.info("开始验证辅助用量和模型归属");
		const accumulator = new UsageAccumulator(logger);
		accumulator.add([
			...entries(),
			{
				type: "usage",
				id: "cache",
				parentId: null,
				timestamp: "2026-10-28T11:00:00",
				kind: "cache_warm",
				provider: "other",
				model: "model-a",
				usage,
			},
		]);
		expect(accumulator.snapshot().totalTokens).toBe(320);
		expect(accumulator.snapshot().dailyTurns).toEqual([{ date: "2026-10-28", turns: 1 }]);
		expect(usageSeries(accumulator.snapshot(), 7, new Date("2026-10-28T12:00:00")).models).toHaveLength(2);
		logger.info("辅助用量和模型归属验证结束");
	});
	it("computes local calendar streaks, ranges and zero states", () => {
		logger.info("开始验证统计日期边界");
		const today = new Date("2026-03-02T12:00:00");
		expect(usageStreak(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"], today)).toEqual({
			current: 4,
			longest: 4,
		});
		expect(usageStreak(["2026-02-27", "2026-02-28"], today)).toEqual({ current: 0, longest: 2 });
		expect(usageStreak([], today)).toEqual({ current: 0, longest: 0 });
		const zero = new UsageAccumulator(logger).snapshot();
		expect(usageSeries(zero, 7, today).dates).toEqual([
			"2026-02-24",
			"2026-02-25",
			"2026-02-26",
			"2026-02-27",
			"2026-02-28",
			"2026-03-01",
			"2026-03-02",
		]);
		expect(formatTokens(15220000)).toBe("1522 万");
		expect(dateKey(today)).toBe("2026-03-02");
		logger.info("统计日期边界验证结束");
	});
	it("reads real SDK JSONL without opening an agent or modifying source history", async () => {
		logger.info("开始验证 SDK 历史只读扫描");
		const directory = await mkdtemp(join(tmpdir(), "harness-usage-"));
		if (dirname(directory) !== tmpdir()) throw new Error("测试目录越界");
		vi.stubEnv("PI_CODING_AGENT_DIR", directory);
		try {
			const cwd = join(directory, "project");
			await mkdir(cwd);
			const manager = SessionManager.create(cwd);
			for (const entry of entries())
				if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"))
					manager.appendMessage(entry.message);
			const file = manager.getSessionFile();
			if (!file) throw new Error("测试会话未落盘");
			const source = await readFile(file, "utf8");
			const scan = await scanUsageHistory(logger);
			expect(scan.files).toHaveLength(1);
			expect(scan.files[0]).toMatchObject({ id: manager.getSessionId(), cwd });
			expect(scan.usage.totalTokens).toBe(160);
			expect(scan.usage.skippedSessions).toBe(0);
			expect(await readFile(file, "utf8")).toBe(source);
			await writeFile(file, `${source}\n{broken`);
			const partial = await scanUsageHistory(logger);
			expect(partial.usage.totalTokens).toBe(160);
			expect(partial.usage.skippedSessions).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
			logger.info("SDK 历史只读扫描验证结束");
		}
	});
});
