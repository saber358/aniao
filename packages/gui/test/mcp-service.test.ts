import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentHost } from "../src/host/agent-host.ts";
import { PlanJournal } from "../src/host/plan-journal.ts";
import { QueueJournal } from "../src/host/queue-journal.ts";
import { McpService } from "../src/main/mcp-service.ts";
import { mcpServerInputSchema } from "../src/shared/mcp.ts";
import { ImageStore } from "../src/storage/image-store.ts";
import { createHarness } from "./sdk-harness.ts";

const logger = { info: vi.fn() };

/*
 * ========================================================================
 * 步骤1：验证配置串行化、回滚与真实 SDK 热重载
 * ========================================================================
 * 数据源：独立临时目录及本地 stdio MCP，不使用真实用户配置。
 * 操作：1) 保存、启停、删除后核对运行态；2) 故障时保留原配置。
 */
describe("McpService", () => {
	it("serializes concurrent saves and preserves unrelated fields on rollback", async () => {
		logger.info("开始验证 MCP 原子配置和回滚");
		const directory = await mkdtemp(join(tmpdir(), "harness-mcp-"));
		if (dirname(directory) !== tmpdir()) throw new Error("MCP 测试清理越界");
		try {
			// 1.1 原配置中的凭据与扩展字段随事务保留，不写入日志。
			const file = join(directory, "mcp.json");
			await writeFile(
				file,
				JSON.stringify({
					other: true,
					mcpServers: { keep: { command: "unused", env: { SECRET: "fixture-only" }, enabled: false } },
				}),
			);
			const service = new McpService(logger, directory);
			await Promise.all([
				service.save({ name: "one", type: "stdio", command: "unused", enabled: false }),
				service.save({ name: "two", type: "stdio", command: "unused", enabled: false }),
			]);
			expect((await service.list()).map((server) => server.name)).toEqual(["keep", "one", "two"]);
			const before = JSON.parse(await readFile(file, "utf8"));
			const reload = vi.fn().mockRejectedValueOnce(new Error("reload failed")).mockResolvedValueOnce(undefined);
			await expect(service.remove("keep", reload)).rejects.toThrow("已还原");
			expect(reload).toHaveBeenCalledTimes(2);
			expect(JSON.parse(await readFile(file, "utf8"))).toEqual(before);
		} finally {
			await rm(directory, { recursive: true, force: true });
			logger.info("MCP 配置和回滚验证完成");
		}
	});

	it("reloads the active SDK after enabling, disabling and removing a local MCP", async () => {
		logger.info("开始验证真实 MCP 会话同步");
		let directory = "";
		const h = await createHarness({
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => {
						const document = z
							.object({
								mcpServers: z.record(
									z.string(),
									z.object({ command: z.string(), args: z.array(z.string()), enabled: z.boolean() }),
								),
							})
							.parse(JSON.parse(readFileSync(join(directory, "mcp.json"), "utf8")));
						return {
							errors: [],
							servers: Object.entries(document.mcpServers).map(([name, config]) => ({
								name,
								config: { ...config, exposure: "direct" as const },
								source: join(directory, "mcp.json"),
							})),
						};
					},
				}),
			],
		});
		directory = h.tempDir;
		const service = new McpService(logger, directory);
		await service.save(
			mcpServerInputSchema.parse({
				name: "offline",
				type: "stdio",
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))],
				enabled: false,
			}),
		);
		const journal = new QueueJournal(join(directory, "queue"), directory, h.session.sessionId, logger);
		await journal.load();
		const host = new AgentHost(
			{ session: h.session, services: { modelRuntime: h.modelRuntime }, dispose: async () => {} },
			logger,
			journal,
			new ImageStore(join(directory, "images"), logger),
			new PlanJournal(join(directory, "plans"), directory, h.session.sessionId, logger),
			h.authStorage,
		);
		const reload = () =>
			host.dispatch({
				requestId: crypto.randomUUID(),
				sessionId: host.snapshot.sessionId,
				generation: host.snapshot.generation,
				command: { type: "reloadResources" },
			});
		try {
			// 1.2 先验证 disabled 状态，再启用真实本地工具，保证刷新改变运行态。
			await host.initialize();
			expect(h.session.getActiveToolNames()).not.toContain("mcp__offline__echo");
			await service.setEnabled("offline", true, reload);
			await vi.waitFor(() => expect(h.session.getActiveToolNames()).toContain("mcp__offline__echo"));
			expect(host.snapshot.resources?.commands.some((command) => command.name === "mcp")).toBe(true);
			await service.setEnabled("offline", false, reload);
			expect(h.session.getActiveToolNames()).not.toContain("mcp__offline__echo");
			await h.session.prompt("/mcp");
			expect(host.snapshot.extensions.notices.some((notice) => notice.message.includes("offline: disabled"))).toBe(
				true,
			);
			await service.remove("offline", reload);
			await h.session.prompt("/mcp");
			expect(
				host.snapshot.extensions.notices.some((notice) => notice.message.includes("No MCP servers configured")),
			).toBe(true);
			expect(host.snapshot.run.phase).toBe("idle");
		} finally {
			await host.dispose();
			h.cleanup();
			logger.info("真实 MCP 会话同步验证完成");
		}
	});
});
