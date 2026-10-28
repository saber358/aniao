import type { McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { HostBuiltinMcp } from "../src/host/builtin-mcp.ts";
import type { BuiltinCall } from "../src/shared/builtin-mcp.ts";

const logger = { info: vi.fn() };
type Message = Parameters<ReturnType<McpTransportFactory>["send"]>[0];
const entry = {
	name: "harness_browser",
	config: { url: "https://harness.invalid/mcp/harness_browser" },
	source: "built-in",
	scope: "extension" as const,
};

/*
 * ========================================================================
 * 步骤1：验证真实 MCP 传输的关联、取消和连接状态
 * ========================================================================
 * 数据源：内存 JSON-RPC、可延迟的桌面回复与非法环境变量配置。
 * 操作：1) 调用只发送一次；2) 关闭和取消撤销等待，迟到结果不能再次生效。
 */
describe("free built-in MCP transport", () => {
	it("discovers tools and correlates desktop replies without dispatching network requests", async () => {
		logger.info("开始验证内置 MCP 请求关联");
		const posted: Array<{ id: string; call: BuiltinCall }> = [];
		const host = new HostBuiltinMcp(logger, (id, call) => posted.push({ id, call }));
		const transport = host.createTransport(entry, ".", undefined);
		const received: Message[] = [];
		transport.onMessage((message) => received.push(message));
		try {
			// 1.1 初始化和工具发现走标准协议，不能触发桌面动作。
			await transport.start();
			await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
			await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
			expect(host.status()[0]).toMatchObject({ state: "connected", toolCount: 11 });
			expect(posted).toHaveLength(0);
			const pending = transport.send({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "browser_tabs", arguments: {} },
			});
			expect(posted).toHaveLength(1);
			expect(posted[0].call).toEqual({ server: "harness_browser", name: "browser_tabs", arguments: {} });
			host.receive("unrelated", { content: [{ type: "text", text: "ignored" }] });
			expect(received).toHaveLength(2);
			host.receive(posted[0].id, { content: [{ type: "text", text: "[]" }] });
			await pending;
			host.receive(posted[0].id, { content: [{ type: "text", text: "late" }] });
			expect(received).toHaveLength(3);
			expect(received.at(-1)).toMatchObject({ id: 3, result: { content: [{ text: "[]" }] } });
		} finally {
			await transport.close();
			host.close();
			logger.info("内置 MCP 请求关联验证结束");
		}
	});
	it("cancels pending desktop work on abort and transport close", async () => {
		logger.info("开始验证内置 MCP 取消清理");
		const posted = vi.fn();
		const cancel = vi.fn();
		const host = new HostBuiltinMcp(logger, posted, cancel);
		const transport = host.createTransport(entry, ".", undefined);
		try {
			// 1.2 预先取消不能派发，正在等待的调用取消后不接受迟到回复。
			const before = new AbortController();
			before.abort();
			await expect(
				transport.send(
					{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_tabs" } },
					{ signal: before.signal },
				),
			).rejects.toThrow();
			expect(posted).not.toHaveBeenCalled();
			const controller = new AbortController();
			const call = expect(
				transport.send(
					{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_tabs" } },
					{ signal: controller.signal },
				),
			).rejects.toThrow("取消");
			controller.abort();
			await call;
			const closing = expect(
				transport.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_tabs" } }),
			).rejects.toThrow("取消");
			await transport.close();
			await closing;
			expect(posted).toHaveBeenCalledTimes(2);
			expect(cancel).toHaveBeenCalledTimes(2);
			expect(host.status()[0].state).toBe("disconnected");
		} finally {
			await transport.close();
			host.close();
			logger.info("内置 MCP 取消清理验证结束");
		}
	});
	it("reports configuration resolution failures as failed connections", () => {
		logger.info("开始验证外部 MCP 连接错误");
		const host = new HostBuiltinMcp(logger, vi.fn());
		try {
			// 1.3 工厂创建阶段失败也必须出现在设置状态，不得卡在等待连接。
			expect(() =>
				host.createTransport(
					{
						name: "external",
						source: "fixture",
						scope: "global",
						config: { command: "unused", env: { CHECK: "$HARNESS_UNCONFIGURED_MCP_TEST_VAR_20261028" } },
					},
					".",
					undefined,
				),
			).toThrow();
			expect(host.status()[0]).toMatchObject({ name: "external", state: "failed", toolCount: 0 });
			expect(host.status()[0].error).toContain("HARNESS_UNCONFIGURED_MCP_TEST_VAR_20261028");
		} finally {
			host.close();
			logger.info("外部 MCP 连接错误验证结束");
		}
	});
});
