import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { createDefaultTransport } from "@harness/pi-kernel/mcp-runtime";
import { z } from "zod";
import {
	BUILTIN_MCP_SERVERS,
	type BuiltinCall,
	type BuiltinResult,
	builtinToolDescriptions,
	builtinToolSchemas,
} from "../shared/builtin-mcp.ts";
import type { Logger } from "../shared/logger.ts";
import type { McpConnection } from "../shared/mcp.ts";

type Transport = ReturnType<McpTransportFactory>;
type MessageListener = Parameters<Transport["onMessage"]>[0];
interface Pending {
	resolve(value: BuiltinResult): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/*
 * ========================================================================
 * 步骤1：将内置 MCP 协议连接到会话专属桌面能力
 * ========================================================================
 * 数据源：官方 MCP 客户端、内存传输和主进程关联回复。
 * 操作：1) 通过标准 MCP 注册工具；2) 超时、取消和关闭都结束等待，不重放动作。
 */
export class HostBuiltinMcp {
	private readonly pending = new Map<string, Pending>();
	private readonly states = new Map<string, McpConnection>();
	private readonly logger: Logger;
	private readonly post: (id: string, call: BuiltinCall) => void;
	private readonly cancel: (id: string) => void;
	constructor(logger: Logger, post: (id: string, call: BuiltinCall) => void, cancel: (id: string) => void = () => {}) {
		this.logger = logger;
		this.post = post;
		this.cancel = cancel;
	}
	register(directory: string): ExtensionFactory {
		return (pi) => {
			this.logger.info("开始注册免费内置 MCP");
			try {
				// 1.1 只读启停偏好，不把内置命令或认证写入用户配置。
				const path = join(directory, "mcp.json");
				const config = existsSync(path)
					? z
							.object({ harnessBuiltins: z.record(z.string(), z.boolean()).optional() })
							.passthrough()
							.parse(JSON.parse(readFileSync(path, "utf8")))
					: {};
				this.states.clear();
				for (const server of BUILTIN_MCP_SERVERS) {
					if (config.harnessBuiltins?.[server.name] === false) continue;
					pi.registerMcpServer(server.name, {
						url: `https://harness.invalid/mcp/${server.name}`,
						description: server.description,
						exposure: "codemode",
					});
				}
			} finally {
				this.logger.info("免费内置 MCP 注册结束");
			}
		};
	}
	readonly createTransport: McpTransportFactory = (entry, cwd, auth) => {
		const builtin = BUILTIN_MCP_SERVERS.find(
			(server) =>
				server.name === entry.name &&
				"url" in entry.config &&
				entry.config.url === `https://harness.invalid/mcp/${server.name}`,
		);
		const current: McpConnection = { name: entry.name, state: "connecting", toolCount: 0 };
		this.states.set(entry.name, current);
		const methods = new Map<string | number, string>();
		const failed = (error: unknown) => {
			let message = error instanceof Error ? error.message : "连接失败";
			for (const value of Object.values(
				"url" in entry.config ? (entry.config.headers ?? {}) : (entry.config.env ?? {}),
			)) {
				if (value.length >= 4) message = message.replaceAll(value, "[已隐藏]");
			}
			message = message.replace(/https?:\/\/\S+/g, "[服务地址]").replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]");
			Object.assign(current, { state: "failed", error: message.slice(0, 2000), toolCount: 0 });
		};
		let transport: Transport;
		try {
			transport = builtin ? this.memoryTransport(builtin) : createDefaultTransport(entry, cwd, auth);
		} catch (error) {
			failed(error);
			throw error;
		}
		transport.onMessage((message) => {
			if (!("id" in message)) return;
			const method = methods.get(message.id);
			methods.delete(message.id);
			if ("error" in message && ["initialize", "tools/list"].includes(method ?? ""))
				failed(new Error(message.error.message));
			else if ("result" in message && method === "tools/list") {
				const parsed = z.object({ tools: z.array(z.unknown()).max(20000) }).safeParse(message.result);
				if (parsed.success)
					Object.assign(current, { state: "connected", toolCount: parsed.data.tools.length, error: undefined });
			}
		});
		transport.onError(failed);
		let closing = false;
		transport.onClose(() => {
			if (!closing && current.state === "connecting") {
				failed(new Error("服务在初始化完成前退出，请检查命令与参数"));
				return;
			}
			if (current.state !== "failed") current.state = "disconnected";
		});
		return {
			start: async () => {
				try {
					await transport.start();
				} catch (error) {
					failed(error);
					throw error;
				}
			},
			send: async (message, options) => {
				if ("method" in message && "id" in message) methods.set(message.id, message.method);
				try {
					await transport.send(message, options);
				} catch (error) {
					if ("method" in message && ["initialize", "tools/list"].includes(message.method)) failed(error);
					throw error;
				}
			},
			close: () => {
				closing = true;
				return transport.close();
			},
			onMessage: (listener) => transport.onMessage(listener),
			onError: (listener) => transport.onError(listener),
			onClose: (listener) => transport.onClose(listener),
			setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
		};
	};
	status(): McpConnection[] {
		return [...this.states.values()].map((state) => ({ ...state }));
	}
	receive(id: string, value: BuiltinResult): void {
		const item = this.pending.get(id);
		if (!item) return;
		clearTimeout(item.timer);
		this.pending.delete(id);
		item.resolve(value);
	}
	close(): void {
		for (const [id, item] of this.pending) {
			clearTimeout(item.timer);
			this.cancel(id);
			item.reject(new Error("内置 MCP 会话已关闭"));
		}
		this.pending.clear();
	}
	private memoryTransport(server: (typeof BUILTIN_MCP_SERVERS)[number]): Transport {
		const listeners = new Set<MessageListener>();
		const closes = new Set<() => void>();
		const active = new Map<string, () => void>();
		let closed = false;
		return {
			start: async () => {},
			onMessage: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => {},
			onClose: (listener) => {
				closes.add(listener);
				return () => closes.delete(listener);
			},
			close: async () => {
				if (closed) return;
				closed = true;
				for (const cancel of [...active.values()]) cancel();
				for (const listener of closes) listener();
				listeners.clear();
				closes.clear();
			},
			send: async (message, options) => {
				if (closed) throw new Error("内置 MCP 连接已关闭");
				options?.signal?.throwIfAborted();
				if (!("method" in message) || !("id" in message)) return;
				const respond = (result: unknown) => {
					if (!closed && !options?.signal?.aborted)
						for (const listener of listeners) listener({ jsonrpc: "2.0", id: message.id, result });
				};
				if (message.method === "initialize") {
					respond({
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: server.name, version: "1.0.0" },
					});
					return;
				}
				if (message.method === "tools/list") {
					respond({
						tools: server.tools.map((name) => ({
							name,
							description: builtinToolDescriptions[name],
							inputSchema: z.toJSONSchema(builtinToolSchemas[name], { target: "draft-7" }),
							annotations: {
								readOnlyHint: [
									"browser_tabs",
									"browser_snapshot",
									"browser_screenshot",
									"fetch_page",
									"search_web",
									"search_docs",
									"read_docs",
									"github_read",
								].includes(name),
							},
						})),
					});
					return;
				}
				if (message.method !== "tools/call") {
					respond({});
					return;
				}
				// 1.2 传输只接受登记工具，动作由主进程再次校验。
				const parsed = z
					.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
					.parse(message.params);
				if (!server.tools.some((name) => name === parsed.name)) throw new Error("未知内置 MCP 工具");
				const name = parsed.name as BuiltinCall["name"];
				const args = builtinToolSchemas[name].parse(parsed.arguments ?? {});
				const id = randomUUID();
				const result = await new Promise<BuiltinResult>((resolve, reject) => {
					const cleanup = () => {
						clearTimeout(timer);
						this.pending.delete(id);
						active.delete(id);
						options?.signal?.removeEventListener("abort", cancel);
					};
					const timer = setTimeout(() => {
						cleanup();
						this.cancel(id);
						reject(new Error("内置 MCP 请求超时"));
					}, 45000);
					const cancel = () => {
						cleanup();
						this.cancel(id);
						reject(new Error("内置 MCP 请求已取消"));
					};
					active.set(id, cancel);
					options?.signal?.addEventListener("abort", cancel, { once: true });
					this.pending.set(id, {
						timer,
						resolve: (value) => {
							cleanup();
							resolve(value);
						},
						reject: (error) => {
							cleanup();
							reject(error);
						},
					});
					try {
						this.post(id, { server: server.name, name, arguments: args });
					} catch (error) {
						cleanup();
						reject(error);
					}
				});
				respond(result);
			},
		};
	}
}
