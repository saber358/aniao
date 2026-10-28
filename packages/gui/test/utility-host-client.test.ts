import { EventEmitter } from "node:events";
import { type UtilityProcess, utilityProcess } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UtilityHostClient } from "../src/main/utility-host-client.ts";
import type { BuiltinCall } from "../src/shared/builtin-mcp.ts";
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
	 * 步骤6：验证模型到桌面工具的反向请求取消
	 * ========================================================================
	 * 数据源：受控宿主、延迟工具与取消通知。
	 * 操作：1) 原始宿主身份不能被参数替换；2) 取消和重复编号不派发第二次动作。
	 */
	it("binds desktop tool calls to the sending host and discards cancelled late results", async () => {
		logger.info("开始验证 MCP 反向调用取消");
		const child = new ChildProcessFixture();
		vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
		let finish: (value: { content: Array<{ type: "text"; text: string }> }) => void = () => {};
		const callback = vi.fn(
			async (_call: BuiltinCall, _owner: UtilityHostClient, _signal: AbortSignal) =>
				new Promise<{ content: Array<{ type: "text"; text: string }> }>((resolve) => {
					finish = resolve;
				}),
		);
		const client = new UtilityHostClient(
			"host.mjs",
			"C:/project",
			{ type: "recent" },
			logger,
			"C:/sdk",
			"C:/state",
			callback,
		);
		child.emit("message", { type: "ready" });
		try {
			// 6.1 反向工具仍是结构化请求，身份只取客户端对象。
			const request = {
				type: "builtinCall",
				id: "desktop-call",
				value: { server: "harness_browser", name: "browser_tabs", arguments: {} },
			};
			child.emit("message", request);
			child.emit("message", request);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback.mock.calls[0][1]).toBe(client);
			const signal = callback.mock.calls[0][2];
			expect(signal.aborted).toBe(false);
			child.emit("message", { type: "builtinCancel", id: request.id });
			expect(signal.aborted).toBe(true);
			finish({ content: [{ type: "text", text: "late" }] });
			await vi.waitFor(() =>
				expect(callback.mock.results[0].value).resolves.toMatchObject({ content: [{ text: "late" }] }),
			);
			expect(child.postMessage.mock.calls.some(([item]) => item.type === "builtinResult")).toBe(false);
		} finally {
			await client.close();
			logger.info("MCP 反向调用取消验证结束");
		}
	});
	/*
	 * ========================================================================
	 * 步骤5：验证历史重命名携带可信工作区
	 * ========================================================================
	 * 数据源：宿主客户端与跨进程请求校验。
	 * 操作：1) 原样传输主进程选定目录；2) 用关联结果结束请求。
	 */
	it("roundtrips a historical rename with the selected workspace directory", async () => {
		logger.info("开始验证跨工作区重命名传输");
		const child = new ChildProcessFixture();
		vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
		const client = new UtilityHostClient("host.mjs", "C:/active", { type: "recent" }, logger, "C:/sdk", "C:/state");
		child.emit("message", { type: "ready" });
		try {
			// 5.1 目标项目和当前宿主项目可以不同，目录始终来自主进程。
			const pending = client.renameSession("history", "新名称", "C:/other");
			await Promise.resolve();
			const request = child.postMessage.mock.calls.at(-1)?.[0];
			expect(request).toMatchObject({ type: "renameSession", sessionId: "history", title: "新名称", cwd: "C:/other" });
			child.emit("message", { type: "result", id: request?.id });
			await pending;
		} finally {
			await client.close();
			logger.info("跨工作区重命名传输验证结束");
		}
	});

	/*
	 * ========================================================================
	 * 步骤4：核对目标确认和会话读取的独立传输
	 * ========================================================================
	 * 数据源：真实宿主客户端和受控 utilityProcess。
	 * 操作：1) 交互确认不套用查询超时；2) 目标读取保留宿主身份。
	 */
	it("waits for goal confirmation and roundtrips a session-bound goal query", async () => {
		logger.info("开始验证目标控制传输");
		vi.useFakeTimers();
		const child = new ChildProcessFixture();
		vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
		const client = new UtilityHostClient("host.mjs", "C:/project", { type: "recent" }, logger, "C:/sdk", "C:/state");
		child.emit("message", { type: "ready" });
		try {
			// 4.1 确认尚未回答时十秒查询期限不结束目标控制。
			let finished = false;
			const command = client
				.dispatch({
					requestId: "goal-clear",
					sessionId: "session",
					generation: "host",
					command: { type: "goalCommand", action: "delete", goalId: "goal-1" },
				})
				.then(() => {
					finished = true;
				});
			await vi.advanceTimersByTimeAsync(30000);
			expect(finished).toBe(false);
			const reading = client.readGoals({ cwd: "C:/project", sessionId: "session", generation: "host" });
			await Promise.resolve();
			const request = child.postMessage.mock.calls.at(-1)?.[0];
			expect(request).toMatchObject({ type: "goals", cwd: "C:/project", sessionId: "session", generation: "host" });
			child.emit("message", { type: "goals", id: request?.id, value: { goals: [], generatedAt: 1 } });
			expect((await reading).goals).toEqual([]);
			child.emit("message", { type: "result", id: "goal-clear" });
			await command;
			expect(finished).toBe(true);
		} finally {
			await client.close();
			logger.info("目标控制传输验证结束");
		}
	});
	/*
	 * ========================================================================
	 * 步骤3：验证详情查询跨进程往返
	 * ========================================================================
	 * 数据源：模拟 utilityProcess 与真实宿主协议校验。
	 * 操作：1) 透传插件子任务键；2) 只接受关联的结构化详情。
	 */
	it("roundtrips an inspection while another command is pending", async () => {
		logger.info("开始验证子智能体详情传输");
		const child = new ChildProcessFixture();
		vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as UtilityProcess);
		const client = new UtilityHostClient("host.mjs", "C:/project", { type: "recent" }, logger, "C:/sdk", "C:/state");
		child.emit("message", { type: "ready" });
		try {
			// 3.1 长请求未结束时，独立详情仍可以先返回。
			const command = client.dispatch({
				requestId: "main",
				sessionId: "session-1",
				generation: "host-1",
				command: { type: "prompt", text: "任务" },
			});
			const inspection = client.inspectSubagent("run", "step:1");
			await Promise.resolve();
			const request = child.postMessage.mock.calls.at(-1)?.[0];
			expect(request).toMatchObject({ type: "subagentInspection", runId: "run", childId: "step:1" });
			child.emit("message", {
				type: "subagentInspection",
				id: request?.id,
				value: {
					kind: "pi-subagents.inspect-reply",
					version: 1,
					requestId: "inspection",
					asyncId: "run",
					childId: "step:1",
					status: "running",
					task: "检查文件",
				},
			});
			expect(await inspection).toMatchObject({ task: "检查文件" });
			child.emit("message", { type: "result", id: "main" });
			await command;
		} finally {
			await client.close();
			logger.info("子智能体详情传输验证完成");
		}
	});
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
