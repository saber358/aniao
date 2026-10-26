import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "../shared/logger.ts";
import {
	type McpServerInput,
	type McpServerSummary,
	mcpServerInputSchema,
	mcpServerNameSchema,
	mcpServerSummarySchema,
} from "../shared/mcp.ts";
import { resolveAgentDirectory } from "./default-provider.ts";

interface McpDocument {
	mcpServers?: Record<string, unknown>;
	[key: string]: unknown;
}

export class McpService {
	private readonly path: string;
	private readonly logger: Logger;

	constructor(logger: Logger) {
		this.path = join(resolveAgentDirectory(), "mcp.json");
		this.logger = logger;
	}

	async list(): Promise<McpServerSummary[]> {
		const document = await this.read();
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

	async save(input: McpServerInput): Promise<McpServerSummary[]> {
		const parsed = mcpServerInputSchema.parse(input);
		const document = await this.read();
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
		await this.write(document);
		this.logger.info("MCP 服务配置已保存");
		return this.list();
	}

	async remove(name: string): Promise<McpServerSummary[]> {
		const parsed = mcpServerNameSchema.parse(name);
		const document = await this.read();
		const servers = isRecord(document.mcpServers) ? { ...document.mcpServers } : {};
		delete servers[parsed];
		document.mcpServers = servers;
		await this.write(document);
		this.logger.info("MCP 服务配置已删除");
		return this.list();
	}

	async setEnabled(name: string, enabled: boolean): Promise<McpServerSummary[]> {
		const parsed = mcpServerNameSchema.parse(name);
		const document = await this.read();
		const servers = isRecord(document.mcpServers) ? { ...document.mcpServers } : {};
		const current = servers[parsed];
		if (!isRecord(current)) throw new Error("MCP 服务不存在");
		servers[parsed] = { ...current, enabled };
		document.mcpServers = servers;
		await this.write(document);
		return this.list();
	}

	private async read(): Promise<McpDocument> {
		if (!existsSync(this.path)) return {};
		const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
		if (!isRecord(parsed)) throw new Error("mcp.json 顶层必须是对象");
		return parsed as McpDocument;
	}

	private async write(document: McpDocument): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(this.path, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
