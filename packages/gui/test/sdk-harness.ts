import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../src/host/kernel.ts";

const logger = console;

/*
 * ========================================================================
 * 步骤1：用正式内核建立离线测试会话
 * ========================================================================
 * 数据源：固定版本的 SDK、独立临时目录与 faux 服务商。
 * 操作：
 *   1) 模型请求只消费预置响应，不读取用户配置或访问外部服务
 *   2) 测试使用产品同版本的认证、资源发现和会话工厂
 */
export async function createHarness(
	options: { tools?: ToolDefinition[]; extensionFactories?: InlineExtension[] } = {},
) {
	logger.info("开始创建桌面 SDK 离线会话");
	const tempDir = mkdtempSync(join(tmpdir(), "harness-sdk-"));
	try {
		// 1.1 认证与模型缓存均保存在内存，磁盘资源只来自独立目录。
		const authStorage = AuthStorage.inMemory();
		const faux = fauxProvider();
		await authStorage.modify(faux.provider.id, async () => ({ type: "api_key", key: "offline-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			extensionFactories: options.extensionFactories,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			settingsManager,
			resourceLoader,
			sessionManager,
			customTools: options.tools,
			tools: options.tools?.map((tool) => tool.name),
		});
		return {
			session,
			sessionManager,
			modelRuntime,
			authStorage,
			tempDir,
			setResponses: faux.setResponses,
			getPendingResponseCount: faux.getPendingResponseCount,
			cleanup() {
				logger.info("开始释放桌面 SDK 离线会话");
				try {
					// 1.2 仅清理本次工厂创建的临时目录，禁止越界删除。
					session.dispose();
					if (dirname(tempDir) !== tmpdir()) throw new Error("SDK 测试清理目录越界");
					rmSync(tempDir, { recursive: true, force: true });
				} finally {
					logger.info("桌面 SDK 离线会话释放结束");
				}
			},
		};
	} finally {
		logger.info("桌面 SDK 离线会话创建结束");
	}
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
		);
}
