import { createLogger } from "../shared/logger.ts";
import { type HostResponse, hostRequestSchema } from "../shared/protocol.ts";
import { sessionTargetSchema } from "../shared/workspace.ts";
import { ImageStore } from "../storage/image-store.ts";
import { AgentHost } from "./agent-host.ts";
import { PlanJournal } from "./plan-journal.ts";
import { HostPluginService } from "./plugin-service.ts";
import { QueueJournal } from "./queue-journal.ts";
import { SessionLibrary } from "./session-library.ts";
import { openRuntime } from "./session-runtime.ts";
import { readSubagentArtifact, readSubagentTranscript } from "./subagent-artifacts.ts";

const logger = createLogger("agent-host");
const parentPort = process.parentPort;

/*
 * ========================================================================
 * 步骤1：在 utilityProcess 中启动独立会话
 * ========================================================================
 * 数据源：主进程确认过的项目目录与启动方式。
 * 操作：
 *   1) SDK、认证、工具与 JSONL 均留在宿主
 *   2) 先建立回复通道，再绑定扩展 UI 与 session_start 回调
 */
async function startHost(): Promise<void> {
	logger.info("开始初始化会话运行时");
	if (!parentPort) throw new Error("AgentHost 必须由桌面主进程启动");
	const cwd = process.argv[2];
	const target = sessionTargetSchema.parse(JSON.parse(process.argv[3] ?? '{"type":"recent"}'));
	const queueDirectory = process.argv[4];
	if (!cwd || !queueDirectory) throw new Error("缺少项目或桌面存储目录");

	// 1.1 临时运行时完整建立后才向主进程报告可用。
	const { runtime, forkDraft, credentials } = await openRuntime(cwd, target, logger);
	const journal = new QueueJournal(queueDirectory, cwd, runtime.session.sessionId, logger);
	await journal.load();
	const plans = new PlanJournal(queueDirectory, cwd, runtime.session.sessionId, logger);
	await plans.load();
	const host = new AgentHost(runtime, logger, journal, new ImageStore(queueDirectory, logger), plans, credentials);
	const plugins = new HostPluginService(cwd, runtime.session.settingsManager, logger);
	const library = new SessionLibrary(runtime.session, logger);
	const post = (response: HostResponse) => parentPort.postMessage(response);
	host.adapter.subscribe((value) => post({ type: "event", value }));
	// 1.2 每个请求独立等待，停止请求不会被长时间的 prompt 阻塞。
	parentPort.on("message", async ({ data }) => {
		const parsed = hostRequestSchema.safeParse(data);
		if (!parsed.success) {
			logger.info("已拒绝无效宿主请求");
			return;
		}
		const request = parsed.data;
		try {
			if (request.type === "snapshot") post({ type: "snapshot", id: request.id, value: host.snapshot });
			else if (request.type === "transition") {
				await host.beforeTransition(request.target);
				post({ type: "result", id: request.id });
			} else if (request.type === "image")
				post({ type: "image", id: request.id, url: host.adapter.getImage(request.imageId) });
			else if (request.type === "history") post({ type: "history", id: request.id, value: await library.list() });
			else if (request.type === "renameSession") {
				await library.rename(request.sessionId, request.title);
				post({ type: "result", id: request.id });
			} else if (request.type === "command") {
				await host.dispatch(request.value);
				post({ type: "result", id: request.id });
			} else if (request.type === "plugins") {
				const source = request.source ?? "";
				const value =
					request.action === "list"
						? await plugins.list()
						: request.action === "install"
							? await plugins.install(source)
							: await plugins.remove(source, request.scope ?? "user");
				post({ type: "plugins", id: request.id, value });
			} else if (request.type === "subagentOutput") {
				post({
					type: "subagentOutput",
					id: request.id,
					value: await readSubagentArtifact(
						runtime.session.sessionManager.getSessionDir(),
						request.runId,
						request.childId,
					),
				});
			} else if (request.type === "subagentTranscript") {
				post({
					type: "subagentTranscript",
					id: request.id,
					value: await readSubagentTranscript(
						runtime.session.sessionManager.getSessionDir(),
						request.runId,
						request.childId,
						runtime.session.sessionManager.getSessionFile(),
					),
				});
			} else {
				await host.dispose();
				post({ type: "result", id: request.id });
				process.exit(0);
			}
		} catch (error) {
			post({
				type: "error",
				id: request.id,
				message: error instanceof Error ? error.message.slice(0, 8192) : "宿主操作失败",
			});
		}
	});
	post({ type: "ready", forkDraft });
	void host.initialize().catch(() => host.extensionUI.notify("扩展初始化失败，请检查 Pi 配置", "error"));
	logger.info("会话运行时初始化完成");
}

void startHost().catch((error: unknown) => {
	logger.info("会话运行时初始化失败");
	console.error(error);
	process.exit(1);
});
