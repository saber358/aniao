import { createInterface } from "node:readline";

const logger = { info: (message) => console.error(message) };
/*
 * ========================================================================
 * 步骤1：提供离线 MCP 协议端点
 * ========================================================================
 * 数据源：本测试启动的 stdio 管道。
 * 操作：1) 回应初始化与工具查询；2) 日志只写 stderr，stdout 保留给 JSON-RPC。
 */
logger.info("开始监听离线 MCP 请求");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	// 1.1 忽略通知，只响应带编号的请求，不访问网络或文件。
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	let result = {};
	if (request.method === "initialize") result = {
		protocolVersion: request.params.protocolVersion,
		capabilities: { tools: {} }, serverInfo: { name: "offline-audit", version: "1.0.0" },
	};
	if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Offline echo", inputSchema: { type: "object", properties: {} } }] };
	if (request.method === "tools/call") result = { content: [{ type: "text", text: "offline reply" }] };
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
input.on("close", () => logger.info("离线 MCP 请求监听结束"));
