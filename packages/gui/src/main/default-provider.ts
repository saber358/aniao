import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../shared/logger.ts";

interface DefaultProviderConfig {
	provider: {
		id: string;
		name?: string;
		baseUrl: string;
		api: string;
		models: string[];
		reasoning?: boolean;
		thinkingLevels?: string[];
	};
	apiKey?: string;
	defaultThinkingLevel?: string;
}

const MARKER_FILE = ".aniao-default-provider";

export function resolveAgentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	return configured ? configured.replace(/^~(?=$|[\\/])/, homedir()) : join(homedir(), ".pi", "agent");
}

/**
 * 把默认 Provider 合并到用户配置。
 *
 * 已有 Provider、默认模型、认证和其他设置不会被覆盖。
 * 合并完成后写标记文件，用户之后主动删除默认 Provider 不会被重新加回。
 */
export async function seedDefaultProvider(
	agentDirectory: string,
	defaultsPath: string,
	logger: Logger,
): Promise<boolean> {
	if (!defaultsPath || !existsSync(defaultsPath)) return false;
	if (existsSync(join(agentDirectory, MARKER_FILE))) return false;
	const parsed = JSON.parse(await readFile(defaultsPath, "utf8")) as unknown;
	if (!isDefaultConfig(parsed)) throw new Error("默认 Provider 配置无效");
	const model = parsed.provider.models[0];
	if (!model) throw new Error("默认 Provider 没有模型");

	const modelsPath = join(agentDirectory, "models.json");
	const authPath = join(agentDirectory, "auth.json");
	const settingsPath = join(agentDirectory, "settings.json");
	const modelsDocument = (await readJsonObject(modelsPath)) ?? {};
	const authDocument = (await readJsonObject(authPath)) ?? {};
	const settingsDocument = (await readJsonObject(settingsPath)) ?? {};
	const providers = isRecord(modelsDocument.providers) ? { ...modelsDocument.providers } : {};
	const providerId = parsed.provider.id;
	let modelsChanged = false;
	if (!(providerId in providers)) {
		providers[providerId] = {
			name: parsed.provider.name ?? providerId,
			baseUrl: parsed.provider.baseUrl,
			api: parsed.provider.api,
			models: parsed.provider.models.map((id) => ({
				id,
				...(parsed.provider.reasoning ? { reasoning: true } : {}),
				...(parsed.provider.reasoning && parsed.provider.thinkingLevels?.length
					? { thinkingLevelMap: thinkingLevelMap(parsed.provider.thinkingLevels) }
					: {}),
			})),
		};
		modelsChanged = true;
	}

	let authChanged = false;
	if (parsed.apiKey && !(providerId in authDocument)) {
		authDocument[providerId] = { type: "api_key", key: parsed.apiKey };
		authChanged = true;
	}

	let settingsChanged = false;
	if (settingsDocument.defaultProvider === undefined && settingsDocument.defaultModel === undefined) {
		settingsDocument.defaultProvider = providerId;
		settingsDocument.defaultModel = model;
		if (parsed.defaultThinkingLevel) settingsDocument.defaultThinkingLevel = parsed.defaultThinkingLevel;
		settingsChanged = true;
	}

	await mkdir(agentDirectory, { recursive: true });
	if (modelsChanged) {
		modelsDocument.providers = providers;
		await writeJson(modelsPath, modelsDocument);
	}
	if (authChanged) await writeJson(authPath, authDocument);
	if (settingsChanged) await writeJson(settingsPath, settingsDocument);
	await writeFile(join(agentDirectory, MARKER_FILE), "", { encoding: "utf8", mode: 0o600 });
	logger.info("默认 Provider 已合并到用户配置");
	return modelsChanged || authChanged || settingsChanged;
}

function isDefaultConfig(value: unknown): value is DefaultProviderConfig {
	if (typeof value !== "object" || value === null) return false;
	const provider = (value as { provider?: unknown }).provider;
	if (typeof provider !== "object" || provider === null) return false;
	const item = provider as Record<string, unknown>;
	return (
		typeof item.id === "string" &&
		item.id.length > 0 &&
		typeof item.baseUrl === "string" &&
		item.baseUrl.length > 0 &&
		typeof item.api === "string" &&
		item.api.length > 0 &&
		Array.isArray(item.models) &&
		item.models.every((model) => typeof model === "string" && model.length > 0)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function thinkingLevelMap(levels: string[]): Record<string, string | null> {
	const selected = new Set(levels);
	return Object.fromEntries(
		["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, selected.has(level) ? level : null]),
	);
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
	if (!existsSync(path)) return undefined;
	const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	if (!isRecord(parsed)) throw new Error(`${path} 顶层必须是对象`);
	return parsed;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
