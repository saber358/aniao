import { EventEmitter } from "node:events";
import { type UtilityProcess, utilityProcess } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDataClient } from "../src/main/session-data-client.ts";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));
const logger = { info: vi.fn() };
const value = {
	usage: {
		generatedAt: 1,
		totalTokens: 0,
		peakTokens: 0,
		longestChatMs: 0,
		activityDates: [],
		dailyTurns: [],
		daily: [],
		skippedSessions: 0,
	},
	files: [],
};
class Worker extends EventEmitter {
	kill = vi.fn();
}

/*
 * ========================================================================
 * 步骤1：验证只读统计进程的合并、失败和退出回收
 * ========================================================================
 * 数据源：独立 utilityProcess 替身，不读取真实会话。
 * 操作：1) 并发刷新只启动一个进程；2) 协议错误与超时不能伪装为零用量。
 */
describe("SessionDataClient", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});
	it("shares a scan and releases the worker after a validated reply", async () => {
		logger.info("开始验证统计扫描合并");
		const worker = new Worker();
		vi.mocked(utilityProcess.fork).mockReturnValue(worker as unknown as UtilityProcess);
		const client = new SessionDataClient("statistics.mjs", logger);
		const first = client.scan();
		expect(client.scan()).toBe(first);
		worker.emit("message", { value });
		expect(await first).toEqual(value);
		expect(worker.kill).toHaveBeenCalledOnce();
		expect(utilityProcess.fork).toHaveBeenCalledOnce();
		client.close();
		await expect(client.scan()).rejects.toThrow("应用已退出");
		logger.info("统计扫描合并验证结束");
	});
	it("rejects invalid responses, permits a fresh retry and cancels on shutdown", async () => {
		logger.info("开始验证统计失败与重试");
		const worker = new Worker();
		vi.mocked(utilityProcess.fork).mockReturnValue(worker as unknown as UtilityProcess);
		const client = new SessionDataClient("statistics.mjs", logger);
		const pending = expect(client.scan()).rejects.toThrow("协议不匹配");
		worker.emit("message", { value: { usage: "bad" } });
		await pending;
		const retry = expect(client.scan()).rejects.toThrow("应用已退出");
		client.close();
		await retry;
		expect(worker.kill).toHaveBeenCalledTimes(2);
		logger.info("统计失败与重试验证结束");
	});
	it("times out a stalled worker and preserves an explicit failure", async () => {
		logger.info("开始验证统计超时");
		vi.useFakeTimers();
		const worker = new Worker();
		vi.mocked(utilityProcess.fork).mockReturnValue(worker as unknown as UtilityProcess);
		const client = new SessionDataClient("statistics.mjs", logger);
		const pending = expect(client.scan()).rejects.toThrow("统计读取超时");
		await vi.advanceTimersByTimeAsync(120001);
		await pending;
		expect(worker.kill).toHaveBeenCalledOnce();
		client.close();
		logger.info("统计超时验证结束");
	});
});
