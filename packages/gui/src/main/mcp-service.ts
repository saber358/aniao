import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "../shared/logger.ts";
import {
	type McpServerInput,
	type McpServerSummary,
	mcpServerInputSchema,
	mcpServerNameSchema,
	mcpServerSummarySchema,
} from "../shared/mcp.ts";
import { writeJsonAtomically } from "../storage/atomic-json.ts";
import { resolveAgentDirectory } from "./default-provider.ts";

interface McpDocument {
	mcpServers?: Record<string, unknown>;
	[key: string]: unknown;
}

export class McpService {
	private readonly path: string;
	private readonly logger: Logger;
	private pending: Promise<unknown> = Promise.resolve();

	constructor(logger: Logger, directory = resolveAgentDirectory()) {
		this.path = join(directory, "mcp.json");
		this.logger = logger;
	}

	async list(): Promise<McpServerSummary[]> {
		await this.pending;
		const document = await this.read();
		return this.summaries(document);
	}

	private summaries(document: McpDocument): McpServerSummary[] {
		const servers = isRecord(document.mcpServers) ? document.mcpServers : {};
		const result: McpServerSummary[] = [];
		for (const [name, value] of Object.entries(servers)) {
			if (!isRecord(value)) continue;
			const command = typeof value.command === "string" ? value.command : undefined;
			const url = typeof value.url === "string" ? value.url : undefined;
			const args = Array.isArray(value.args)
				? value.args.filter((item): item is string => typeof item === "string")
				: undefined;
			const type = url ? "http" : command ? "stdio" : undefined;
			if (!type) continue;
			const parsed = mcpServerSummarySchema.safeParse({
				name,
				type,
				command,
				args,
				url,
				enabled: value.enabled !== false,
			});
			if (parsed.success) result.push(parsed.data);
		}
		return result.sort((left, right) => left.name.localeCompare(right.name));
	}

	async save(input: McpServerInput, apply?: () => Promise<void>): Promise<McpServerSummary[]> {
		const parsed = mcpServerInputSchema.parse(input);
		return this.change(async (document) => {
			const servers = isRecord(document.mcpServers) ? { ...document.mcpServers } : {};
			const current = servers[parsed.name];
			const existing: Record<string, unknown> = isRecord(current) ? { ...current } : {};
			const next: Record<string, unknown> = {
				...existing,
				enabled: parsed.enabled ?? true,
			};
			if (parsed.type === "stdio") {
				next.command = parsed.command;
				next.args = parsed.args ?? [];
				delete next.url;
				delete next.headers;
				delete next.type;
			} else {
				next.url = parsed.url;
				delete next.command;
				delete next.args;
				delete next.env;
				next.type = "http";
			}
			servers[parsed.name] = next;
			document.mcpServers = servers;
		}, apply);
	}

	async remove(name: string, apply?: () => Promise<void>): Promise<McpServerSummary[]> {
		const parsed = mcpServerNameSchema.parse(name);
		return this.change(async (document) => {
			const servers = isRecord(document.mcpServers) ? { ...document.mcpServers } : {};
			delete servers[parsed];
			document.mcpServers = servers;
		}, apply);
	}

	async setEnabled(name: string, enabled: boolean, apply?: () => Promise<void>): Promise<McpServerSummary[]> {
		const parsed = mcpServerNameSchema.parse(name);
		return this.change(async (document) => {
			const servers = isRecord(document.mcpServers) ? { ...document.mcpServers } : {};
			const current = servers[parsed];
			if (!isRecord(current)) throw new Error("MCP 服务不存在");
			servers[parsed] = { ...current, enabled };
			document.mcpServers = servers;
		}, apply);
	}

	/*
	 * ========================================================================
	 * 步骤1：串行保存配置并同步活动会话
	 * ========================================================================
	 * 数据源：mcp.json 与工作区提供的空闲会话重载回调。
	 * 操作：1) 原子写入后重载；2) 重载失败时还原配置并重载原运行态。
	 */
	private change(
		update: (document: McpDocument) => Promise<void>,
		apply?: () => Promise<void>,
	): Promise<McpServerSummary[]> {
		const operation = this.pending.then(async () => {
			this.logger.info("开始更新 MCP 配置与运行态");
			try {
				// 1.1 串行区间涵盖读取、写入、重载和回滚，避免并行保存覆盖。
				const previous = await this.read();
				const next = structuredClone(previous);
				await update(next);
				await this.write(next);
				try {
					await apply?.();
				} catch {
					await this.write(previous);
					try {
						await apply?.();
					} catch {
						throw new Error("MCP 配置已还原，但会话恢复失败，请重新打开项目");
					}
					throw new Error("MCP 配置未生效，已还原原配置与会话资源");
				}
				return this.summaries(next);
			} finally {
				this.logger.info("MCP 配置与运行态更新结束");
			}
		});
		this.pending = operation.catch(() => {});
		return operation;
	}

	private async read(): Promise<McpDocument> {
		if (!existsSync(this.path)) return {};
		const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
		if (!isRecord(parsed)) throw new Error("mcp.json 顶层必须是对象");
		return parsed as McpDocument;
	}

	private async write(document: McpDocument): Promise<void> {
		await writeJsonAtomically(dirname(this.path), "mcp.json", document, this.logger);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
