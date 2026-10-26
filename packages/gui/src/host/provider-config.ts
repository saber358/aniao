import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CustomModelInput, CustomProviderInput } from "../shared/provider.ts";

interface ModelsDocument {
	providers?: Record<string, unknown>;
	[key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCustomProviderNames(modelsPath: string): Map<string, string> {
	const names = new Map<string, string>();
	if (!existsSync(modelsPath)) return names;
	try {
		const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
		if (!isObject(parsed) || !isObject(parsed.providers)) return names;
		for (const [id, value] of Object.entries(parsed.providers)) {
			if (isObject(value) && typeof value.name === "string" && value.name.trim()) names.set(id, value.name.trim());
		}
	} catch {
		// 配置错误由 ModelRegistry 诊断；这里只负责显示名称。
	}
	return names;
}

/**
 * 写入一个最小可用的自定义 Provider 配置。
 *
 * API Key 不写入 models.json；凭据由调用方写入 AuthStorage。
 * 已有文件的其他 Provider 和顶层字段保持不变。
 */
export async function writeCustomProvider(modelsPath: string, input: CustomProviderInput): Promise<void> {
	const document = await readModelsDocument(modelsPath);
	const providers = isObject(document.providers) ? { ...document.providers } : {};
	const models = new Map(input.models.map((model) => [model.id.trim(), model]));
	providers[input.id] = {
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		api: input.api,
		models: [...models.values()].map((model) => modelDefinition(model)),
	};
	document.providers = providers;
	await writeModelsDocument(modelsPath, document);
}

function modelDefinition(input: CustomModelInput): Record<string, unknown> {
	const model: Record<string, unknown> = { id: input.id };
	if (input.reasoning) model.reasoning = true;
	if (input.contextWindow) model.contextWindow = input.contextWindow;
	if (input.maxTokens) model.maxTokens = input.maxTokens;
	if (input.input?.length) model.input = [...new Set(input.input)];
	if (input.reasoning && input.thinkingLevels?.length) {
		const selected = new Set(input.thinkingLevels);
		model.thinkingLevelMap = Object.fromEntries(
			(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) => [
				level,
				selected.has(level) && level !== "off" ? level : selected.has(level) ? undefined : null,
			]),
		);
	}
	const compat: Record<string, boolean> = {};
	if (input.supportsStructuredOutput) {
		compat.supportsStrictMode = true;
		compat.supportsStrictTools = true;
	}
	if (input.supportsSystemMessages) compat.supportsMidConvoSystemMessages = true;
	if (Object.keys(compat).length) model.compat = compat;
	return model;
}

export async function removeCustomProvider(modelsPath: string, provider: string): Promise<void> {
	const document = await readModelsDocument(modelsPath);
	if (!isObject(document.providers) || !(provider in document.providers)) {
		throw new Error("自定义 Provider 不存在");
	}
	const providers = { ...document.providers };
	delete providers[provider];
	document.providers = providers;
	await writeModelsDocument(modelsPath, document);
}

async function readModelsDocument(modelsPath: string): Promise<ModelsDocument> {
	if (!existsSync(modelsPath)) return {};
	const parsed = JSON.parse(await readFile(modelsPath, "utf8")) as unknown;
	if (!isObject(parsed)) throw new Error("models.json 顶层必须是对象");
	return parsed as ModelsDocument;
}

async function writeModelsDocument(modelsPath: string, document: ModelsDocument): Promise<void> {
	await mkdir(dirname(modelsPath), { recursive: true });
	await writeFile(modelsPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
