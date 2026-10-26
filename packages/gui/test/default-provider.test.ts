import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedDefaultProvider } from "../src/main/default-provider.ts";

const roots: string[] = [];
const logger = { info: () => {} };

async function directory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-gui-default-provider-"));
	roots.push(root);
	return root;
}

async function defaults(path: string, apiKey = "default-key") {
	await writeFile(
		path,
		JSON.stringify({
			provider: {
				id: "aniao",
				name: "aniao",
				baseUrl: "https://api.example.com",
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
});
