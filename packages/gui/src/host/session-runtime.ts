import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	getAgentDir,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "../shared/logger.ts";
import type { SessionTarget } from "../shared/workspace.ts";
import type { HostBuiltinMcp } from "./builtin-mcp.ts";
import { AuthStorage } from "./kernel.ts";
import { forkSessionManager } from "./session-fork.ts";
import { openSessionManager } from "./session-library.ts";

/*
 * ========================================================================
 * 步骤1：创建待接替的会话运行时
 * ========================================================================
 * 数据源：已确认的项目目录与受校验的会话目标。
 * 操作：
 *   1) cwd 资源由 SDK 服务工厂创建，扩展绑定等传输准备完成
 *   2) 分支只替换临时运行时，失败关闭资源，原活动宿主继续保留
 */
export async function openRuntime(cwd: string, target: SessionTarget, logger: Logger, builtin?: HostBuiltinMcp) {
	logger.info("开始创建待接替运行时");
	try {
		// 1.1 新建、恢复和分支复用同一工厂，避免另建 SDK 组装流程。
		const manager = await openSessionManager(cwd, target, logger);
		const credentials = AuthStorage.create(join(getAgentDir(), "auth.json"));
		const forkDraft = target.type === "fork" ? forkSessionManager(manager, target.entryId, logger) : undefined;
		const runtime = await createAgentSessionRuntime(
			async (options) => {
				const services = await createAgentSessionServices({
					cwd: options.cwd,
					agentDir: options.agentDir,
					modelRuntime: await ModelRuntime.create({
						credentials,
						modelsPath: join(options.agentDir, "models.json"),
					}),
					resourceLoaderOptions: {
						// SDK 会话不会自动加载 CLI 内置扩展；显式启用 MCP、codemode 和工具搜索。
						extensionFactories: [
							createCodemodeExtension(),
							createToolSearchExtension(),
							...(builtin ? [builtin.register(options.agentDir)] : []),
							createMcpExtension(builtin ? { createTransport: builtin.createTransport } : undefined),
						],
					},
				});
				const result = await createAgentSessionFromServices({
					services,
					sessionManager: options.sessionManager,
					sessionStartEvent: options.sessionStartEvent,
				});
				return { ...result, services, diagnostics: services.diagnostics };
			},
			{
				cwd,
				agentDir: getAgentDir(),
				sessionManager: manager,
				sessionStartEvent: {
					type: "session_start",
					reason:
						target.type === "fork"
							? "fork"
							: target.type === "new"
								? "new"
								: target.type === "session"
									? "resume"
									: "startup",
					previousSessionFile: manager.getHeader()?.parentSession,
				},
			},
		);
		return { runtime, forkDraft, credentials };
	} finally {
		logger.info("待接替运行时创建结束");
	}
}
