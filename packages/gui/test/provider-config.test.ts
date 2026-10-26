import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeCustomProvider, writeCustomProvider } from "../src/host/provider-config.ts";

const roots: string[] = [];

async function modelsPath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-gui-provider-"));
	roots.push(root);
	return join(root, "models.json");
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("writeCustomProvider", () => {
	it("creates a custom provider without writing its API key", async () => {
		const path = await modelsPath();
		await writeCustomProvider(path, {
			id: "local-router",
			name: "Local Router",
			baseUrl: "http://localhost:8080/v1",
			api: "openai-completions",
			models: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }],
			apiKey: "secret-key",
		});

		const document = JSON.parse(await readFile(path, "utf8")) as {
			providers: Record<string, { name: string; models: Array<{ id: string }>; apiKey?: string }>;
		};
		expect(document.providers["local-router"]).toEqual({
			name: "Local Router",
			baseUrl: "http://localhost:8080/v1",
			api: "openai-completions",
			models: [{ id: "model-a" }, { id: "model-b" }],
		});
		expect(document.providers["local-router"]?.apiKey).toBeUndefined();
	});

	it("preserves existing providers and top-level fields", async () => {
		const path = await modelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: { existing: { baseUrl: "http://localhost:1234/v1", models: [{ id: "old" }] } },
				other: true,
			}),
		);
		await writeCustomProvider(path, {
			id: "new-provider",
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			models: [{ id: "new-model" }],
		});

		const document = JSON.parse(await readFile(path, "utf8")) as {
			providers: Record<string, unknown>;
			other?: boolean;
		};
		expect(document.other).toBe(true);
		expect(document.providers.existing).toBeDefined();
		expect(document.providers["new-provider"]).toMatchObject({ baseUrl: "https://api.example.com/v1" });
	});

	it("rejects invalid existing JSON", async () => {
		const path = await modelsPath();
		await writeFile(path, "not-json");
		await expect(
			writeCustomProvider(path, {
				id: "provider",
				baseUrl: "https://api.example.com/v1",
				api: "openai-completions",
				models: [{ id: "model" }],
			}),
		).rejects.toThrow();
	});

	it("writes reasoning capability for custom models", async () => {
		const path = await modelsPath();
		await writeCustomProvider(path, {
			id: "reasoning-provider",
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			models: [{ id: "reasoning-model", reasoning: true }],
		});
		const document = JSON.parse(await readFile(path, "utf8")) as {
			providers: Record<string, { models: Array<{ id: string; reasoning?: boolean }> }>;
		};
		expect(document.providers["reasoning-provider"]?.models).toEqual([{ id: "reasoning-model", reasoning: true }]);
	});

	it("writes advanced model limits, modalities and thinking levels", async () => {
		const path = await modelsPath();
		await writeCustomProvider(path, {
			id: "advanced-provider",
			baseUrl: "https://api.example.com/v1",
			api: "anthropic-messages",
			models: [
				{
					id: "advanced-model",
					reasoning: true,
					thinkingLevels: ["off", "low", "high", "max"],
					input: ["text", "image"],
					contextWindow: 1_000_000,
					maxTokens: 384_000,
					supportsStructuredOutput: true,
					supportsSystemMessages: true,
				},
			],
		});
		const document = JSON.parse(await readFile(path, "utf8")) as {
			providers: Record<
				string,
				{
					models: Array<{
						id: string;
						reasoning?: boolean;
						contextWindow?: number;
						maxTokens?: number;
						input?: string[];
						thinkingLevelMap?: Record<string, string | null>;
						compat?: Record<string, boolean>;
					}>;
				}
			>;
		};
		const model = document.providers["advanced-provider"]?.models[0];
		expect(model).toMatchObject({
			id: "advanced-model",
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			input: ["text", "image"],
			compat: { supportsStrictMode: true, supportsStrictTools: true, supportsMidConvoSystemMessages: true },
		});
		expect(model?.thinkingLevelMap).toMatchObject({ low: "low", high: "high", max: "max", medium: null });
	});

	it("removes only the selected custom provider", async () => {
		const path = await modelsPath();
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					keep: { baseUrl: "https://keep.example.com/v1", models: [{ id: "keep" }] },
					remove: { baseUrl: "https://remove.example.com/v1", models: [{ id: "remove" }] },
				},
				other: true,
			}),
		);
		await removeCustomProvider(path, "remove");
		const document = JSON.parse(await readFile(path, "utf8")) as {
			providers: Record<string, unknown>;
			other?: boolean;
		};
		expect(document.providers.keep).toBeDefined();
		expect(document.providers.remove).toBeUndefined();
		expect(document.other).toBe(true);
	});

	it("rejects removing an unknown provider", async () => {
		const path = await modelsPath();
		await writeFile(path, JSON.stringify({ providers: {} }));
		await expect(removeCustomProvider(path, "missing")).rejects.toThrow("不存在");
	});
});
