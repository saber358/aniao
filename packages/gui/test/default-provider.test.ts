import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedDefaultProvider } from "../src/main/default-provider.ts";
import type { Logger } from "../src/shared/logger.ts";

const roots: string[] = [];
const logger: Logger = { info: () => {} };

async function directory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-gui-default-provider-"));
	roots.push(root);
	return root;
}

async function defaults(path: string, apiKey = "default-key", previousBaseUrls?: string[]) {
	await writeFile(
		path,
		JSON.stringify({
			provider: {
				id: "aniao",
				name: "aniao",
				baseUrl: "https://api.example.com",
				...(previousBaseUrls ? { previousBaseUrls } : {}),
				api: "anthropic-messages",
				models: ["grok-4.7"],
				reasoning: true,
				thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
			},
			apiKey,
			defaultThinkingLevel: "high",
		}),
	);
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("default provider seeding", () => {
	it("writes provider, default model and credential for a fresh user", async () => {
		const root = await directory();
		const defaultsPath = join(root, "defaults.json");
		await defaults(defaultsPath);
		const seeded = await seedDefaultProvider(root, defaultsPath, logger);
		expect(seeded).toBe(true);
		const models = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
		const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
		const auth = JSON.parse(await readFile(join(root, "auth.json"), "utf8"));
		expect(models.providers.aniao).toMatchObject({
			baseUrl: "https://api.example.com",
			api: "anthropic-messages",
			models: [
				{
					id: "grok-4.7",
					reasoning: true,
					thinkingLevelMap: {
						minimal: null,
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "xhigh",
						max: "max",
					},
				},
			],
		});
		expect(settings).toEqual({
			defaultProvider: "aniao",
			defaultModel: "grok-4.7",
			defaultThinkingLevel: "high",
		});
		expect(auth.aniao).toEqual({ type: "api_key", key: "default-key" });
		expect(JSON.stringify(models)).not.toContain("default-key");
	});

	it("merges the default provider into an existing Pi configuration without overriding it", async () => {
		const root = await directory();
		const defaultsPath = join(root, "defaults.json");
		await defaults(defaultsPath);
		await writeFile(
			join(root, "models.json"),
			JSON.stringify({
				providers: { custom: { baseUrl: "https://custom.example.com", models: [{ id: "custom" }] } },
			}),
		);
		await writeFile(join(root, "auth.json"), JSON.stringify({ custom: { type: "api_key", key: "custom-key" } }));
		await writeFile(
			join(root, "settings.json"),
			JSON.stringify({ defaultProvider: "custom", defaultModel: "custom", defaultThinkingLevel: "low" }),
		);
		const seeded = await seedDefaultProvider(root, defaultsPath, logger);
		expect(seeded).toBe(true);
		const models = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
		const auth = JSON.parse(await readFile(join(root, "auth.json"), "utf8"));
		expect(models.providers.custom).toBeDefined();
		expect(models.providers.aniao).toMatchObject({
			models: [
				{
					id: "grok-4.7",
					reasoning: true,
					thinkingLevelMap: {
						minimal: null,
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "xhigh",
						max: "max",
					},
				},
			],
		});
		expect(auth.custom).toBeDefined();
		expect(auth.aniao).toEqual({ type: "api_key", key: "default-key" });
		expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
			defaultProvider: "custom",
			defaultModel: "custom",
			defaultThinkingLevel: "low",
		});
	});

	it("does not reintroduce the provider after the user removes it", async () => {
		const root = await directory();
		const defaultsPath = join(root, "defaults.json");
		await defaults(defaultsPath);
		await seedDefaultProvider(root, defaultsPath, logger);
		await rm(join(root, "models.json"), { force: true });
		expect(await seedDefaultProvider(root, defaultsPath, logger)).toBe(false);
		await expect(readFile(join(root, "models.json"), "utf8")).rejects.toThrow();
	});

	it("skips when no bundled defaults exist", async () => {
		const root = await directory();
		expect(await seedDefaultProvider(root, join(root, "missing.json"), logger)).toBe(false);
	});

	/*
	 * ========================================================================
	 * 步骤1：验证升级用户的地址迁移和重复启动
	 * ========================================================================
	 * 数据源：已初始化标记、旧默认地址与自定义模型参数。
	 * 操作：1) 只替换旧地址并保留原文备份；2) 认证、设置和重复启动保持不变。
	 */
	it("migrates a seeded legacy endpoint without changing credentials, settings or model fields", async () => {
		logger.info("开始验证默认地址升级");
		try {
			// 1.1 准备已初始化用户，加入其他服务商和高级配置。
			const root = await directory();
			const defaultsPath = join(root, "defaults.json");
			await defaults(defaultsPath, "default-key", ["https://legacy.example.com"]);
			await seedDefaultProvider(root, defaultsPath, logger);
			const modelsPath = join(root, "models.json");
			const document = JSON.parse(await readFile(modelsPath, "utf8"));
			document.providers.aniao.baseUrl = "https://legacy.example.com";
			document.providers.aniao.models[0].contextWindow = 234567;
			document.providers.custom = { baseUrl: "https://custom.example.com", models: [{ id: "custom" }] };
			const original = `${JSON.stringify(document, null, 2)}\n`;
			await writeFile(modelsPath, original);
			const auth = await readFile(join(root, "auth.json"), "utf8");
			const settings = await readFile(join(root, "settings.json"), "utf8");
			// 1.2 升级只更新地址，备份必须保留原文。
			expect(await seedDefaultProvider(root, defaultsPath, logger)).toBe(true);
			document.providers.aniao.baseUrl = "https://api.example.com";
			expect(JSON.parse(await readFile(modelsPath, "utf8"))).toEqual(document);
			expect(await readFile(join(root, "models.json.before-default-url-update"), "utf8")).toBe(original);
			expect(await readFile(join(root, "auth.json"), "utf8")).toBe(auth);
			expect(await readFile(join(root, "settings.json"), "utf8")).toBe(settings);
			const saved = await readFile(modelsPath, "utf8");
			expect(await seedDefaultProvider(root, defaultsPath, logger)).toBe(false);
			expect(await readFile(modelsPath, "utf8")).toBe(saved);
		} finally {
			logger.info("默认地址升级验证结束");
		}
	});

	/*
	 * ========================================================================
	 * 步骤2：验证自定义与已删除服务商保护
	 * ========================================================================
	 * 数据源：现有用户修改过的地址、协议、模型和服务商删除状态。
	 * 操作：1) 只接受完整匹配的旧默认配置；2) 跳过时不改写原文件。
	 */
	it.each(["custom-url", "different-api", "different-model", "deleted-provider"])(
		"preserves seeded configuration when the provider has %s",
		async (scenario) => {
			logger.info("开始验证用户服务商配置保护");
			try {
				// 2.1 每个用例先建立合法初始化状态，再模拟用户修改。
				const root = await directory();
				const defaultsPath = join(root, "defaults.json");
				await defaults(defaultsPath, "default-key", ["https://legacy.example.com"]);
				await seedDefaultProvider(root, defaultsPath, logger);
				const modelsPath = join(root, "models.json");
				const document = JSON.parse(await readFile(modelsPath, "utf8"));
				document.providers.aniao.baseUrl = "https://legacy.example.com";
				if (scenario === "custom-url") document.providers.aniao.baseUrl = "https://my-proxy.example.com";
				if (scenario === "different-api") document.providers.aniao.api = "openai-completions";
				if (scenario === "different-model") document.providers.aniao.models = [{ id: "custom-model" }];
				if (scenario === "deleted-provider") delete document.providers.aniao;
				const original = JSON.stringify(document);
				await writeFile(modelsPath, original);
				// 2.2 不匹配迁移条件时，文件内容也必须保持原样。
				expect(await seedDefaultProvider(root, defaultsPath, logger)).toBe(false);
				expect(await readFile(modelsPath, "utf8")).toBe(original);
				await expect(readFile(join(root, "models.json.before-default-url-update"), "utf8")).rejects.toThrow();
			} finally {
				logger.info("用户服务商配置保护验证结束");
			}
		},
	);
});
