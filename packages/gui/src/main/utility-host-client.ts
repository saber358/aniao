import { randomUUID } from "node:crypto";
import { type UtilityProcess, utilityProcess } from "electron";
import type { Logger } from "../shared/logger.ts";
import type { PluginPackage, PluginScope } from "../shared/plugins.ts";
import {
	type CommandEnvelope,
	type HostRequest,
	type HostResponse,
	hostResponseSchema,
	type PortNotification,
	type SessionSnapshot,
} from "../shared/protocol.ts";
import type { SessionSummary, SessionTarget } from "../shared/workspace.ts";

interface PendingRequest {
	resolve(response: HostResponse): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}

/*
 * ========================================================================
 * 步骤1：管理独立宿主与请求生命周期
 * ========================================================================
 * 数据源：utilityProcess 的消息、退出与错误。
 * 操作：
 *   1) 请求超时或进程退出时清理所有等待者
 *   2) 事件独立于请求完成，不阻塞流式展示或停止命令
 */
export class UtilityHostClient {
	private readonly child: UtilityProcess;
	private readonly logger: Logger;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Set<(notification: PortNotification) => void>();
	private readonly ready: Promise<void>;
	private resolveReady: () => void = () => {};
	private rejectReady: (error: Error) => void = () => {};
	private startupTimer?: ReturnType<typeof setTimeout>;
	private closed = false;
	private forkDraft?: string;

	constructor(
		entry: string,
		cwd: string,
		target: SessionTarget,
		logger: Logger,
		sdkDirectory: string,
		queueDirectory: string,
	) {
		this.logger = logger;
		logger.info("开始启动独立 Agent 进程");
		this.ready = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		this.child = utilityProcess.fork(entry, [cwd, JSON.stringify(target), queueDirectory], {
			serviceName: "Pi Agent",
			stdio: "pipe",
			env: { ...process.env, PI_PACKAGE_DIR: sdkDirectory },
		});
		// 1.1 日志不与业务通道混用；宿主 stderr 不回传给 Renderer。
		this.child.stdout?.pipe(process.stdout);
		this.child.stderr?.pipe(process.stderr);
		this.child.on("message", (data: unknown) => this.receive(data));
		this.child.on("exit", () => this.fail(new Error("Agent 进程已退出，请重新打开项目")));
		this.startupTimer = setTimeout(() => {
			this.fail(new Error("Agent 进程启动超时"));
			this.child.kill();
		}, 60000);
	}

	async getSnapshot(): Promise<SessionSnapshot> {
		const response = await this.request({ type: "snapshot", id: randomUUID() });
		if (response.type !== "snapshot") throw new Error("宿主快照响应无效");
		return response.value;
	}

	async listSessions(): Promise<SessionSummary[]> {
		const response = await this.request({ type: "history", id: randomUUID() });
		if (response.type !== "history") throw new Error("宿主历史响应无效");
		return response.value;
	}

	async getImage(imageId: string): Promise<string> {
		const response = await this.request({ type: "image", id: randomUUID(), imageId });
		if (response.type !== "image") throw new Error("宿主图片响应无效");
		return response.url;
	}

	async renameSession(sessionId: string, title: string): Promise<void> {
		await this.request({ type: "renameSession", id: randomUUID(), sessionId, title });
	}
	async listPlugins(): Promise<PluginPackage[]> {
		const response = await this.request({ type: "plugins", id: randomUUID(), action: "list" });
		if (response.type !== "plugins") throw new Error("宿主插件响应无效");
		return response.value;
	}
	async installPlugin(source: string): Promise<PluginPackage[]> {
		const response = await this.request({ type: "plugins", id: randomUUID(), action: "install", source });
		if (response.type !== "plugins") throw new Error("宿主插件响应无效");
		return response.value;
	}
	async removePlugin(source: string, scope: PluginScope): Promise<PluginPackage[]> {
		const response = await this.request({ type: "plugins", id: randomUUID(), action: "remove", source, scope });
		if (response.type !== "plugins") throw new Error("宿主插件响应无效");
		return response.value;
	}
	async readSubagentOutput(runId: string, childId?: string): Promise<string | null> {
		const response = await this.request({
			type: "subagentOutput",
			id: randomUUID(),
			runId,
			...(childId ? { childId } : {}),
		});
		if (response.type !== "subagentOutput") throw new Error("宿主子智能体响应无效");
		return response.value;
	}
	async readSubagentTranscript(runId: string, childId?: string): Promise<string | null> {
		const response = await this.request({
			type: "subagentTranscript",
			id: randomUUID(),
			runId,
			...(childId ? { childId } : {}),
		});
		if (response.type !== "subagentTranscript") throw new Error("宿主子智能体转录响应无效");
		return response.value;
	}
	async prepareTransition(target: SessionTarget): Promise<void> {
		await this.request({ type: "transition", id: randomUUID(), target });
	}

	async getForkDraft(): Promise<string | undefined> {
		await this.ready;
		if (this.closed) throw new Error("Agent 连接已关闭");
		return this.forkDraft;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	async dispatch(value: CommandEnvelope): Promise<void> {
		await this.request({ type: "command", id: value.requestId, value });
	}

	subscribe(listener: (notification: PortNotification) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private receive(data: unknown): void {
		const parsed = hostResponseSchema.safeParse(data);
		if (!parsed.success) {
			this.fail(new Error("Agent 消息协议不匹配"));
			this.child.kill();
			return;
		}
		const response = parsed.data;
		if (response.type === "ready") {
			clearTimeout(this.startupTimer);
			this.forkDraft = response.forkDraft;
			this.resolveReady();
			this.logger.info("独立 Agent 进程启动完成");
			return;
		}
		if (response.type === "event") {
			for (const listener of this.listeners) listener({ type: "event", value: response.value });
			return;
		}
		const pending = this.pending.get(response.id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(response.id);
		if (response.type === "error") pending.reject(new Error(response.message));
		else pending.resolve(response);
	}

	private async request(request: HostRequest): Promise<HostResponse> {
		await this.ready;
		if (this.closed) throw new Error("Agent 连接已关闭");
		if (this.pending.has(request.id)) throw new Error("宿主请求编号重复");
		// 1.2 prompt 由运行收束结束，不套用普通查询的短超时。
		const waitForRun =
			request.type === "transition" ||
			(request.type === "command" && ["prompt", "approvePlan", "login"].includes(request.value.command.type));
		return new Promise((resolve, reject) => {
			const pending: PendingRequest = { resolve, reject };
			if (!waitForRun)
				pending.timer = setTimeout(
					() => {
						this.pending.delete(request.id);
						reject(new Error("宿主请求超时，请刷新状态后再操作"));
					},
					request.type === "plugins" ? 120000 : 10000,
				);
			this.pending.set(request.id, pending);
			this.child.postMessage(request);
		});
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.startupTimer);
		this.rejectReady(error);
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
		for (const listener of this.listeners) listener({ type: "disconnected", reason: error.message });
	}

	async close(): Promise<void> {
		this.logger.info("开始回收 Agent 进程");
		try {
			// 1.3 给 SDK 收束窗口，超时后关闭受管 utilityProcess。
			if (!this.closed) {
				await Promise.race([
					this.request({ type: "shutdown", id: randomUUID() }).catch(() => {}),
					new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, 5000);
						timer.unref();
					}),
				]);
			}
		} finally {
			this.fail(new Error("Agent 连接已关闭"));
			this.child.kill();
			this.listeners.clear();
			this.logger.info("Agent 进程回收完成");
		}
	}
}
