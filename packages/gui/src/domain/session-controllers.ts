import type { Logger } from "../shared/logger.ts";
import type { ProjectFileReference } from "../shared/project-files.ts";
import type { AgentPort, DesktopBridge, GuiCommand } from "../shared/protocol.ts";
import type { FileCompletion } from "./file-completion.ts";
import { GuiController, type GuiState } from "./gui-controller.ts";

/*
 * ========================================================================
 * 步骤1：每个会话持有独立的界面状态与提交等待
 * ========================================================================
 * 数据源：宿主会话身份、限定身份的快照端口与独立草稿存储。
 * 操作：1) 切换只改变活动 Controller；2) 旧提交结果只能修改原会话。
 */
export class SessionControllers {
	private readonly port: AgentPort & Pick<DesktopBridge, "getSessionSnapshot">;
	private readonly workspace: ConstructorParameters<typeof GuiController>[2];
	private readonly logger: Logger;
	private readonly controllers = new Map<string, GuiController>();
	private readonly listeners = new Set<(state: GuiState) => void>();
	private readonly empty: GuiController;
	private active: GuiController;
	private release?: () => void;
	private closed = false;
	private syncing?: Promise<void>;

	constructor(
		port: AgentPort & Pick<DesktopBridge, "getSessionSnapshot">,
		logger: Logger,
		workspace: ConstructorParameters<typeof GuiController>[2],
	) {
		this.port = port;
		this.logger = logger;
		this.workspace = workspace;
		this.empty = new GuiController(port, logger, workspace);
		this.active = this.empty;
	}
	get value(): GuiState {
		return this.active.value;
	}
	subscribe(listener: (state: GuiState) => void): () => void {
		this.listeners.add(listener);
		listener(this.value);
		return () => {
			this.listeners.delete(listener);
		};
	}
	connect(): Promise<void> {
		return this.refresh();
	}
	refresh(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.syncing) return this.syncing;
		this.logger.info("开始选择会话界面状态");
		this.syncing = Promise.resolve()
			.then(async () => {
				// 1.1 先定位桌面当前选择，再安装限定身份的会话端口。
				const snapshot = await this.port.getSnapshot();
				if (this.closed) return;
				if (!snapshot) {
					this.select(this.empty);
					await this.empty.connect();
					return;
				}
				const key = JSON.stringify([snapshot.sessionId, snapshot.generation]);
				let controller = this.controllers.get(key);
				if (!controller) {
					const identity = { sessionId: snapshot.sessionId, generation: snapshot.generation };
					controller = new GuiController(
						{
							getSnapshot: () => this.port.getSessionSnapshot(identity),
							dispatch: (command) => this.port.dispatch(command),
							subscribe: (listener) =>
								this.port.subscribe((notification) => {
									if (
										notification.type === "event" &&
										notification.value.sessionId === identity.sessionId &&
										notification.value.generation === identity.generation
									)
										listener(notification);
									else if (
										notification.type === "disconnected" &&
										notification.sessionId === identity.sessionId &&
										notification.generation === identity.generation
									)
										listener(notification);
								}),
						},
						this.logger,
						this.workspace,
					);
					this.controllers.set(key, controller);
				}
				await controller.connect();
				// 1.5 目标快照和草稿就绪后再发布，避免先把侧栏切到空状态。
				if (!this.closed) this.select(controller);
			})
			.catch(async () => {
				// 1.4 当前宿主故障时由其 Controller 发布断连状态，不影响其他会话。
				if (!this.closed) await this.active.refresh();
			})
			.finally(() => {
				this.syncing = undefined;
				this.logger.info("会话界面状态选择结束");
			});
		return this.syncing;
	}

	private select(controller: GuiController): void {
		this.logger.info("开始激活会话界面");
		try {
			// 1.2 只替换当前视图订阅，后台 Controller 继续处理自己的消息和草稿。
			this.release?.();
			this.active = controller;
			this.release = controller.subscribe((state) => {
				for (const listener of this.listeners) listener(state);
			});
		} finally {
			this.logger.info("会话界面激活结束");
		}
	}

	setDraft(text: string): void {
		this.active.setDraft(text);
	}
	flushDraft(): Promise<boolean> {
		return this.active.flushDraft();
	}
	send(command: GuiCommand): Promise<boolean> {
		return this.active.send(command);
	}
	restoreQueue(): Promise<boolean> {
		return this.active.restoreQueue();
	}
	referenceProjectFiles(reference?: ProjectFileReference, completion?: FileCompletion): Promise<boolean> {
		return this.active.referenceProjectFiles(reference, completion);
	}
	attachImages(read?: () => Promise<string[]>): Promise<boolean> {
		return this.active.attachImages(read);
	}
	removeImage(imageId: string): void {
		this.active.removeImage(imageId);
	}
	dispose(): void {
		this.logger.info("开始释放多会话界面");
		try {
			// 1.3 Renderer 关闭不停止宿主；主进程负责全部进程生命周期。
			this.closed = true;
			this.release?.();
			this.empty.dispose();
			for (const controller of this.controllers.values()) controller.dispose();
			this.controllers.clear();
			this.listeners.clear();
		} finally {
			this.logger.info("多会话界面释放结束");
		}
	}
}
