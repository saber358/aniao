import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../shared/logger.ts";

interface DefaultProviderConfig {
	provider: {
		id: string;
		name?: string;
		baseUrl: string;
		previousBaseUrls?: string[];
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
 * 已初始化用户仅迁移明确登记的旧默认地址，保留其他 Provider 字段。
 * 合并完成后写标记文件，用户之后主动删除默认 Provider 不会被重新加回。
 */
export async function seedDefaultProvider(
	agentDirectory: string,
	defaultsPath: string,
	logger: Logger,
): Promise<boolean> {
	if (!defaultsPath || !existsSync(defaultsPath)) return false;
	const parsed = JSON.parse(await readFile(defaultsPath, "utf8")) as unknown;
	if (!isDefaultConfig(parsed)) throw new Error("默认 Provider 配置无效");
	const model = parsed.provider.models[0];
	if (!model) throw new Error("默认 Provider 没有模型");
	if (existsSync(join(agentDirectory, MARKER_FILE))) {
		return migrateDefaultProviderUrl(agentDirectory, parsed.provider, logger);
	}

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

/*
 * ========================================================================
 * 步骤1：迁移已初始化用户的旧默认服务地址
 * ========================================================================
 * 数据源：内置地址迁移名单与本机完整 models.json。
 * 操作：1) 核对旧地址、协议和模型；2) 备份后原子替换地址，保留其余配置。
 */
async function migrateDefaultProviderUrl(
	agentDirectory: string,
	provider: DefaultProviderConfig["provider"],
	logger: Logger,
): Promise<boolean> {
	logger.info("开始核对默认 Provider 地址迁移");
	let temporaryPath: string | undefined;
	try {
		// 1.1 没有声明迁移或没有现有配置时，不补回用户删除的服务商。
		const modelsPath = join(agentDirectory, "models.json");
		if (!provider.previousBaseUrls?.length || !existsSync(modelsPath)) return false;
		const original = await readFile(modelsPath, "utf8");
		const document = JSON.parse(original) as unknown;
		if (!isRecord(document) || !isRecord(document.providers)) return false;
		const existing = document.providers[provider.id];
		if (!isRecord(existing)) return false;
		const existingModels = existing.models;
		if (
			typeof existing.baseUrl !== "string" ||
			!provider.previousBaseUrls.includes(existing.baseUrl) ||
			existing.baseUrl === provider.baseUrl ||
			existing.api !== provider.api ||
			!Array.isArray(existingModels) ||
			!provider.models.every((id) => existingModels.some((model) => isRecord(model) && model.id === id))
		) {
			return false;
		}
		// 1.2 保留首次迁移前的完整原文；重试时不覆盖已有备份。
		const backupPath = join(agentDirectory, "models.json.before-default-url-update");
		if (!existsSync(backupPath)) {
			await writeFile(backupPath, original, { encoding: "utf8", mode: 0o600, flag: "wx" });
		}
		existing.baseUrl = provider.baseUrl;
		temporaryPath = `${modelsPath}.${randomUUID()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		// 1.3 拒绝覆盖启动期间其他实例写入的配置。
		if ((await readFile(modelsPath, "utf8")) !== original) throw new Error("模型配置已变化，请重新启动后更新地址");
		await rename(temporaryPath, modelsPath);
		return true;
	} finally {
		if (temporaryPath) await rm(temporaryPath, { force: true });
		logger.info("默认 Provider 地址迁移核对结束");
	}
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
		(item.previousBaseUrls === undefined ||
			(Array.isArray(item.previousBaseUrls) &&
				item.previousBaseUrls.every((url) => typeof url === "string" && url.length > 0))) &&
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
