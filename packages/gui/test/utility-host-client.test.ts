import { EventEmitter } from "node:events";
import { type UtilityProcess, utilityProcess } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UtilityHostClient } from "../src/main/utility-host-client.ts";
import { type HostRequest, hostResponseSchema, type PortNotification } from "../src/shared/protocol.ts";
import { snapshot } from "./fixtures.ts";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));
const logger = { info: vi.fn() };

class ChildProcessFixture extends EventEmitter {
	stdout = null;
	stderr = null;
	kill = vi.fn();
	postMessage = vi.fn((request: HostRequest) => {
		if (request.type === "shutdown") this.emit("message", { type: "result", id: request.id });
	});
}

/*
 * ========================================================================
 * 步骤1：验证桌面传输的等待、超时与退出清理
 * ========================================================================
 * 数据源：模拟 utilityProcess；不启动窗口或真实模型。
 * 操作：
 *   1) 核对请求关联和重复编号保护
 *   2) 退出、协议错误和超时均结束等待，不重放命令
 */
describe("UtilityHostClient", () => {
	/*
	 * ========================================================================
	 * 步骤2：验证批准后的执行不套用查询超时
	 * ========================================================================
	 * 数据源：模拟时钟与独立宿主替身。
	 * 操作：1) 批准运行超过十秒；2) 等待真实收束响应。
	 */
	it("waits for approved plan execution beyond the query timeout", async () => {
		logger.info("开始验证计划执行等待");
		vi.useFakeTimers();
		const child = new ChildProcessFixture();
		vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
		const client = new UtilityHostClient("host.mjs", "C:/project", { type: "recent" }, logger, "C:/sdk", "C:/state");
		child.emit("message", { type: "ready" });
		try {
			// 2.1 长任务不会因普通查询的十秒期限失败。
			const run = client.dispatch({
				requestId: "approved",
				sessionId: "session-1",
				generation: "host-1",
				command: { type: "approvePlan", text: "run" },
			});
			await vi.advanceTimersByTimeAsync(30_000);
			child.emit("message", { type: "result", id: "approved" });
			await expect(run).resolves.toBeUndefined();
		} finally {
			await client.close();
			logger.info("计划执行等待验证结束");
		}
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("correlates replies and rejects duplicate pending identifiers", async () => {
		logger.info("开始验证请求关联");
		const child = new ChildProcessFixture();
		vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
		const client = new UtilityHostClient("host.mjs", "C:/project", { type: "recent" }, logger, "C:/sdk", "C:/state");
		child.emit("message", { type: "ready" });
		try {
			// 1.1 第一个请求保持在途，重复编号不能覆盖其等待者。
			const command = {
				requestId: "same-id",
				sessionId: "session-1",
				generation: "host-1",
				command: { type: "abort" as const },
			};
			const pending = client.dispatch(command);
			await expect(client.dispatch(command)).rejects.toThrow("编号重复");
			child.emit("message", { type: "result", id: "same-id" });
			await pending;
			expect(child.postMessage).toHaveBeenCalledTimes(1);
		} finally {
			await client.close();
			logger.info("请求关联验证完成");
		}
	});

	it("rejects pending requests and notifies once when the host exits", async () => {
		logger.info("开始验证宿主退出");
		const child = new ChildProcessFixture();
		vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
		const client = new UtilityHostClient("host.mjs", "C:/project", { type: "recent" }, logger, "C:/sdk", "C:/state");
		const notifications: PortNotification[] = [];
		client.subscribe((event) => notifications.push(event));
		child.emit("message", { type: "ready" });
		try {
			// 1.2 退出结束所有在途查询，后续读取直接失败。
			const pending = client.getSnapshot();
			await Promise.resolve();
			child.emit("exit", 1);
			child.emit("exit", 1);
			await expect(pending).rejects.toThrow("进程已退出");
			await expect(client.getSnapshot()).rejects.toThrow("连接已关闭");
			expect(client.isClosed).toBe(true);
			expect(notifications).toHaveLength(1);
		} finally {
			await client.close();
			logger.info("宿主退出验证完成");
		}
	});

	it("times out a query and accepts a later fresh snapshot without replaying it", async () => {
		logger.info("开始验证查询超时");
		vi.useFakeTimers();
		const child = new ChildProcessFixture();
		vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
		const client = new UtilityHostClient("host.mjs", "C:/project", { type: "recent" }, logger, "C:/sdk", "C:/state");
		child.emit("message", { type: "ready" });
		try {
			// 1.3 超时响应被丢弃；用户后续刷新使用新请求编号。
			const expired = expect(client.getSnapshot()).rejects.toThrow("请求超时");
			await vi.advanceTimersByTimeAsync(10001);
			await expired;
			const current = client.getSnapshot();
			await Promise.resolve();
			const request = child.postMessage.mock.calls.at(-1)?.[0];
			expect(request?.type).toBe("snapshot");
			child.emit("message", { type: "snapshot", id: request?.id, value: snapshot() });
			expect(await current).toEqual(snapshot());
			expect(child.postMessage).toHaveBeenCalledTimes(2);
		} finally {
			await client.close();
			logger.info("查询超时验证完成");
		}
	});

	it("validates the startup draft and keeps it separate from session snapshots", async () => {
		logger.info("开始验证分支草稿启动结果");
		const child = new ChildProcessFixture();
		vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
		const client = new UtilityHostClient(
			"host.mjs",
			"C:/project",
			{ type: "fork", sourceId: "source", entryId: "native-entry" },
			logger,
			"C:/sdk",
			"C:/state",
		);
		try {
			const draft = client.getForkDraft();
			child.emit("message", { type: "ready", forkDraft: "原始中文\n  输入" });
			expect(await draft).toBe("原始中文\n  输入");
			expect(hostResponseSchema.safeParse({ type: "ready", forkDraft: "" }).success).toBe(false);
			expect(hostResponseSchema.safeParse({ type: "ready", forkDraft: "x".repeat(1_000_001) }).success).toBe(false);
			expect(child.postMessage).not.toHaveBeenCalled();
		} finally {
			await client.close();
			logger.info("分支草稿启动结果验证完成");
		}
	});
});
