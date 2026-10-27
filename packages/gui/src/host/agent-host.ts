import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { type AgentSession, type AgentSessionRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { queueTexts } from "../domain/queue-view.ts";
import { imageBatchSchema } from "../shared/image-schema.ts";
import type { Logger } from "../shared/logger.ts";
import type { CommandEnvelope, Configuration, SessionSnapshot } from "../shared/protocol.ts";
import { QUEUE_LIMIT, QUEUE_TEXT_LIMIT, type QueueItem } from "../shared/queue.ts";
import type { SessionTarget } from "../shared/workspace.ts";
import { type ImageStore, imageIdentity } from "../storage/image-store.ts";
import { AuthService } from "./auth-service.ts";
import { DialogService } from "./dialog-service.ts";
import { ExtensionUI } from "./extension-ui.ts";
import { captureQueuedMessage, commitQueuedChange, commitQueuedInput, prepareQueuedInput } from "./kernel-queue.ts";
import type { PlanJournal } from "./plan-journal.ts";
import { readCustomProviderNames, removeCustomProvider, writeCustomProvider } from "./provider-config.ts";
import type { QueueJournal } from "./queue-journal.ts";
import { SessionAdapter } from "./session-adapter.ts";

type HostRuntime = Pick<AgentSessionRuntime, "session" | "dispose"> & {
	services: Pick<AgentSessionRuntime["services"], "modelRuntime">;
};

const PLAN_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const PLAN_PREFIX =
	"计划模式：先分析代码和约束，只输出清晰、可执行的实施计划，列出涉及的文件、步骤、风险和需要确认的范围。不要修改文件，不要运行会改变工作区的命令。等待用户批准后再实施。\n\n";
const PLAN_EXECUTE_PREFIX = "执行以下已批准的计划。按计划修改工作区并验证结果：\n\n";

/*
 * ========================================================================
 * 步骤1：把界面业务命令交给现有 Pi 会话
 * ========================================================================
 * 数据源：独立会话运行时与经过校验的命令。
 * 操作：
 *   1) 核对会话身份和运行互斥，取消命令独立处理
 *   2) 凭据只写入现有 AuthStorage，不回传给界面
 */
export class AgentHost {
	readonly adapter: SessionAdapter;
	private readonly runtime: HostRuntime;
	private readonly credentials: CredentialStore;
	private readonly logger: Logger;
	private submitting = false;
	private disposed = false;
	private readonly journal: QueueJournal;
	private queueSubmission?: Promise<void>;
	private stopping?: Promise<void>;
	private holdQueue = false;
	private readonly images: ImageStore;
	readonly dialogs: DialogService;
	private readonly auth: AuthService;
	readonly extensionUI: ExtensionUI;
	private planTools: string[] | null = null;
	private readonly planJournal: PlanJournal;
	private readonly releasePlan: () => void;
	private customProviderNames?: Map<string, string>;

	constructor(
		runtime: HostRuntime,
		logger: Logger,
		journal: QueueJournal,
		images: ImageStore,
		planJournal: PlanJournal,
		credentials: CredentialStore,
	) {
		this.runtime = runtime;
		this.credentials = credentials;
		this.logger = logger;
		this.journal = journal;
		this.images = images;
		this.planJournal = planJournal;
		logger.info("开始创建 Agent 宿主");
		// 1.4 Windows 默认使用 PowerShell，避免仅有 WSL bash 时无法访问 Windows 路径。
		if (process.platform === "win32") {
			const activeTools = runtime.session.getActiveToolNames();
			if (!activeTools.includes("powershell")) {
				runtime.session.setActiveToolsByName([...activeTools, "powershell"]);
			}
			logger.info(`Windows PowerShell 工具已启用：${runtime.session.getActiveToolNames().join(", ")}`);
		}
		this.adapter = new SessionAdapter(runtime.session, this.configuration(), logger, true);
		this.dialogs = new DialogService(logger, () => this.adapter.updateDialogs(this.dialogs.requests));
		this.auth = new AuthService(runtime.services.modelRuntime, credentials, this.dialogs, logger, () =>
			this.adapter.updateAuthentication(this.auth.state),
		);
		this.adapter.updateAuthentication(this.auth.state);
		this.extensionUI = new ExtensionUI(this.dialogs, logger, (state) => this.adapter.updateExtensions(state));
		this.adapter.updateExtensions(this.extensionUI.value);
		this.adapter.updateQueueRecovery(journal.recovery);
		// 1.5 恢复计划只安装状态，不调用 prompt，也不自动恢复写工具。
		const savedPlan = planJournal.value;
		if (savedPlan.plan.phase !== "off") {
			if (["awaiting", "interrupted"].includes(savedPlan.plan.phase)) {
				this.planTools = savedPlan.tools;
				runtime.session.setActiveToolsByName(savedPlan.tools.filter((name) => PLAN_TOOL_NAMES.has(name)));
			}
			this.adapter.restorePlan(savedPlan.plan);
		}
		this.releasePlan = this.adapter.subscribe((event) => {
			if (event.event.type !== "plan") return;
			void this.planJournal.save(event.event.plan, this.planTools ?? runtime.session.getActiveToolNames()).catch(() => {
				this.extensionUI.notify("计划保存失败，已保留当前状态，请检查存储后重试", "error");
			});
		});
		logger.info("Agent 宿主创建完成");
	}

	get snapshot(): SessionSnapshot {
		return this.adapter.snapshot;
	}

	/*
	 * ========================================================================
	 * 步骤4：在传输就绪后绑定扩展 UI 与生命周期
	 * ========================================================================
	 * 数据源：现有 ExtensionRunner；初始化提问可经快照跨重载恢复。
	 * 操作：
	 *   1) 先提供有效会话身份和回复通道，再等待 session_start
	 *   2) 会话更换前调用来源扩展的取消钩子，取消不创建替代宿主
	 */
	async initialize(): Promise<void> {
		this.logger.info("开始绑定桌面扩展");
		this.submitting = true;
		this.adapter.beginPrompt();
		try {
			// 4.1 RPC 模式仅承诺可序列化 UI；终端工厂由适配器明确拒绝。
			await this.runtime.session.bindExtensions({
				mode: "rpc",
				uiContext: this.extensionUI.context,
				onError: () => this.extensionUI.notify("扩展运行失败，请检查 Pi 扩展配置", "error"),
				abortHandler: () => {
					void this.stop().catch(() => this.extensionUI.notify("扩展停止请求失败", "error"));
				},
			});
			this.adapter.updateConfiguration(this.configuration());
			if (this.planTools)
				this.runtime.session.setActiveToolsByName(this.planTools.filter((name) => PLAN_TOOL_NAMES.has(name)));
			for (const error of this.runtime.session.resourceLoader.getExtensions().errors) {
				if (error) this.extensionUI.notify("部分扩展加载失败，请检查 Pi 扩展配置", "warning");
			}
		} finally {
			this.submitting = false;
			this.adapter.endPrompt();
			this.logger.info("桌面扩展绑定结束");
		}
	}

	async beforeTransition(target: SessionTarget): Promise<void> {
		this.logger.info("开始核对扩展会话切换");
		if (this.submitting || this.snapshot.run.phase !== "idle" || this.dialogs.requests.length)
			throw new Error("请等待当前操作结束");
		if (this.snapshot.plan && !["off", "completed"].includes(this.snapshot.plan.phase))
			throw new Error("请先批准或取消当前计划");
		this.submitting = true;
		try {
			// 4.2 保留当前运行时，不调用会先销毁来源的 SDK replacement 方法。
			const runner = this.runtime.session.extensionRunner;
			const result =
				target.type === "fork"
					? await runner.emit({ type: "session_before_fork", entryId: target.entryId, position: "before" })
					: await runner.emit({ type: "session_before_switch", reason: target.type === "new" ? "new" : "resume" });
			if (result?.cancel) throw new Error("扩展已取消会话切换");
		} finally {
			this.submitting = false;
			this.logger.info("扩展会话切换核对结束");
		}
	}

	private restorePlanTools(): void {
		if (!this.planTools) return;
		this.runtime.session.setActiveToolsByName(this.planTools);
		this.planTools = null;
	}

	private customProviders(): Map<string, string> {
		this.customProviderNames ??= readCustomProviderNames(join(getAgentDir(), "models.json"));
		return this.customProviderNames;
	}

	private providerDisplayName(provider: string): string {
		return (
			this.customProviders().get(provider) ?? this.runtime.services.modelRuntime.getProvider(provider)?.name ?? provider
		);
	}

	private configuration(): Configuration {
		const registry = this.runtime.services.modelRuntime;
		const session = this.runtime.session;
		const models = registry.getModels().map((model) => ({
			key: `${model.provider}/${model.id}`,
			provider: model.provider,
			providerName: this.providerDisplayName(model.provider),
			name: model.name,
			available: registry.hasConfiguredAuth(model.provider),
			supportsImages: model.input.includes("image"),
		}));
		return {
			model: session.model
				? (models.find((model) => model.key === `${session.model?.provider}/${session.model?.id}`) ?? null)
				: null,
			models,
			customProviders: [...this.customProviders().keys()],
			thinking: session.thinkingLevel,
			thinkingLevels: session.getAvailableThinkingLevels(),
		};
	}

	async dispatch(envelope: CommandEnvelope): Promise<void> {
		this.logger.info("开始处理宿主命令");
		try {
			const snapshot = this.snapshot;
			if (this.disposed || envelope.sessionId !== snapshot.sessionId || envelope.generation !== snapshot.generation)
				throw new Error("会话已更换，请刷新后重试");
			const command = envelope.command;
			const session: AgentSession = this.runtime.session;
			// 1.4 交互回复和取消必须绕过长请求互斥，否则登录会等待自身结束。
			if (command.type === "reply") {
				this.dialogs.reply(command.reply);
				return;
			}
			if (command.type === "cancelLogin") {
				this.auth.cancel();
				return;
			}
			if (command.type === "dismissNotice") {
				this.extensionUI.dismiss(command.id);
				return;
			}
			// 1.1 取消不排在 prompt 后面，其他配置变更必须等待运行收束。
			if (command.type === "abort") {
				if (snapshot.run.phase === "preparing") throw new Error("任务正在准备，开始运行后可停止");
				await this.stop();
				if (snapshot.plan?.phase === "drafting" || snapshot.plan?.phase === "executing") {
					this.adapter.restorePlan({
						phase: "interrupted",
						text: this.snapshot.plan?.text ?? "",
						reason: "运行已停止，请核对已完成改动后再批准",
					});
					await this.planJournal.flush();
				}
				return;
			}
			if (snapshot.dialogs.length) throw new Error("请先完成当前交互");
			if (command.type === "goalCommand") {
				const commandText =
					command.action === "pause" ? "/goal-pause" : command.action === "resume" ? "/goal-resume" : "/goal-clear";
				// 扩展命令在 SDK 内是即时控制通道，不等待当前模型回合结束。
				await session.prompt(commandText, { source: "interactive" });
				return;
			}
			if (command.type === "queueAction") {
				if (this.queueSubmission || this.stopping) throw new Error("上一条队列操作尚未结束");
				this.queueSubmission = this.queueAction(command.action, command.itemId, command.text);
				try {
					await this.queueSubmission;
				} finally {
					this.queueSubmission = undefined;
				}
				return;
			}
			if (command.type === "enqueue") {
				if (this.queueSubmission) throw new Error("上一条消息仍在入队");
				if (snapshot.run.phase !== "working" || !session.isStreaming)
					throw new Error("当前任务已收束或暂停，请核对后重新发送");
				if (this.journal.count >= QUEUE_LIMIT || this.journal.textLength + command.text.length > QUEUE_TEXT_LIMIT)
					throw new Error("本轮追加消息已达上限，请等待当前任务结束");
				this.queueSubmission = this.enqueue(envelope.requestId, command.mode, command.text, command.imageIds);
				try {
					await this.queueSubmission;
				} finally {
					this.queueSubmission = undefined;
				}
				return;
			}
			if (this.submitting || snapshot.run.phase !== "idle") throw new Error("请等待当前任务结束");
			this.submitting = true;
			try {
				switch (command.type) {
					case "reloadResources": {
						/*
						 * ========================================================================
						 * 步骤5：空闲时重载当前会话资源
						 * ========================================================================
						 * 数据源：已原子保存的 MCP 配置和 SDK 资源加载器。
						 * 操作：1) 待批准计划结束后才重载；2) 重建扩展运行态。
						 */
						this.logger.info("开始重载会话资源");
						if (this.planTools) throw new Error("请先批准或取消当前计划，再修改 MCP");
						this.adapter.beginPrompt();
						try {
							// 5.1 初始化期间的扩展交互仍由独立 reply 命令响应。
							await session.reload();
						} finally {
							this.adapter.updateResources();
							this.adapter.endPrompt();
							this.logger.info("会话资源重载结束");
						}
						break;
					}
					case "prompt": {
						if (queueTexts(snapshot.queue).length) throw new Error("请先恢复或清空待处理消息");
						if (snapshot.plan?.phase === "awaiting" || snapshot.plan?.phase === "interrupted")
							throw new Error("请先批准或取消当前计划");
						const planMode = command.plan === true;
						let planStarted = false;
						if (planMode) {
							if (snapshot.plan && !["off", "completed"].includes(snapshot.plan.phase))
								throw new Error("当前已有计划，请先处理");
							const tools = session.getActiveToolNames();
							const readOnly = tools.filter((name) => PLAN_TOOL_NAMES.has(name));
							if (readOnly.length === 0) throw new Error("当前会话没有只读工具，无法进入计划模式");
							this.planTools = tools;
							session.setActiveToolsByName(readOnly);
							this.adapter.beginPlan();
							planStarted = true;
						} else if (snapshot.plan?.phase === "completed") {
							this.adapter.clearPlan();
						}
						// 1.2 不依赖 RPC 内部 preflight 钩子；命令完成与 agent_settled 分开投影。
						this.adapter.beginPrompt();
						try {
							// 1.6 计划意图落盘后才调用 SDK，失败时不开始模型请求。
							await this.planJournal.flush();
							if (command.imageIds?.length && !session.model?.input.includes("image"))
								throw new Error("当前模型不支持图片，请先切换模型");
							const images = command.imageIds?.length
								? await this.images.readMany(snapshot.cwd, snapshot.sessionId, command.imageIds)
								: undefined;
							if (this.disposed) throw new Error("会话已关闭，图片未发送");
							await session.prompt(planStarted ? `${PLAN_PREFIX}${command.text}` : command.text, {
								source: "interactive",
								images,
							});
							await this.awaitSubagents();
						} catch (error) {
							if (planStarted) {
								this.restorePlanTools();
								this.adapter.clearPlan();
							}
							throw error;
						} finally {
							await this.queueSubmission?.catch(() => {});
							await this.stopping?.catch(() => {});
							try {
								await this.checkpoint();
							} finally {
								this.adapter.endPrompt();
							}
						}
						break;
					}
					case "approvePlan": {
						if (snapshot.plan?.phase !== "awaiting" && snapshot.plan?.phase !== "interrupted")
							throw new Error("当前没有待批准的计划");
						this.adapter.approvePlan(command.text);
						this.adapter.beginPrompt();
						try {
							// 1.7 先保存批准事实，再恢复写工具和开始执行。
							await this.planJournal.flush();
							this.restorePlanTools();
							await session.prompt(`${PLAN_EXECUTE_PREFIX}${command.text}`, { source: "interactive" });
							await this.awaitSubagents();
						} catch (error) {
							this.adapter.restorePlan({
								phase: "interrupted",
								text: command.text,
								reason: "执行未正常完成，请核对结果后重试",
							});
							throw error;
						} finally {
							try {
								await this.checkpoint();
							} finally {
								this.adapter.endPrompt();
							}
						}
						break;
					}
					case "editPlan": {
						if (!snapshot.plan || !["awaiting", "interrupted"].includes(snapshot.plan.phase))
							throw new Error("当前计划不可编辑");
						// 1.8 编辑只保存计划文本，不调用模型或改变工具权限。
						this.adapter.restorePlan({ ...snapshot.plan, text: command.text });
						await this.planJournal.flush();
						break;
					}
					case "rejectPlan": {
						if (snapshot.plan?.phase !== "awaiting" && snapshot.plan?.phase !== "interrupted")
							throw new Error("当前没有待批准的计划");
						this.restorePlanTools();
						this.adapter.clearPlan();
						await this.planJournal.flush();
						break;
					}
					case "dismissPlan": {
						if (snapshot.plan?.phase !== "completed" && snapshot.plan?.phase !== "off")
							throw new Error("计划仍在进行中");
						this.adapter.clearPlan();
						break;
					}
					case "clearQueue":
						// 1.3 只在空闲时整体清空，恢复到草稿由 Controller 先保存后提交。
						await this.journal.clear();
						this.holdQueue = false;
						session.clearQueue();
						this.adapter.updateQueueRecovery(this.journal.recovery);
						break;
					case "setModel": {
						const model = this.runtime.services.modelRuntime
							.getModels()
							.find((item) => `${item.provider}/${item.id}` === command.key);
						if (!model) throw new Error("所选模型已不可用");
						await session.setModel(model);
						break;
					}
					case "setThinking":
						if (!session.getAvailableThinkingLevels().includes(command.level))
							throw new Error("当前模型不支持这个思考等级");
						session.setThinkingLevel(command.level);
						break;
					case "setApiKey": {
						const services = this.runtime.services;
						if (!services.modelRuntime.getModels().some((model) => model.provider === command.provider))
							throw new Error("未知服务商");
						// 1.9 新版凭据写入串行化，刷新完成后才向界面报告可用模型。
						await this.credentials.modify(command.provider, async () => ({ type: "api_key", key: command.key }));
						await services.modelRuntime.refresh({ allowNetwork: false });
						if (!session.model) {
							const model = services.modelRuntime
								.getAvailableSnapshot()
								.find((item) => item.provider === command.provider);
							if (model) await session.setModel(model);
						}
						break;
					}
					case "saveProvider": {
						const services = this.runtime.services;
						const file = join(getAgentDir(), "models.json");
						const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
						const previousAuth = await this.credentials.read(command.provider.id);
						try {
							await writeCustomProvider(file, command.provider);
							this.customProviderNames = undefined;
							await services.modelRuntime.refresh({ allowNetwork: false });
							const configError = services.modelRuntime.getError();
							if (configError) throw new Error(configError);
							if (command.provider.apiKey) {
								await this.credentials.modify(command.provider.id, async () => ({
									type: "api_key",
									key: command.provider.apiKey,
								}));
								await services.modelRuntime.refresh({ allowNetwork: false });
							}
							if (!session.model) {
								const model = services.modelRuntime
									.getAvailableSnapshot()
									.find((item) => item.provider === command.provider.id);
								if (model) await session.setModel(model);
							}
						} catch (error) {
							if (previous === undefined) await rm(file, { force: true });
							else await writeFile(file, previous, { encoding: "utf8", mode: 0o600 });
							if (previousAuth) await this.credentials.modify(command.provider.id, async () => previousAuth);
							else await this.credentials.delete(command.provider.id);
							this.customProviderNames = undefined;
							await services.modelRuntime.refresh({ allowNetwork: false });
							throw error;
						}
						break;
					}
					case "deleteProvider": {
						const services = this.runtime.services;
						const custom = this.customProviders().has(command.provider);
						const previousAuth = await this.credentials.read(command.provider);
						if (!custom && !previousAuth) throw new Error("当前 Provider 没有可删除的本地配置");
						const file = join(getAgentDir(), "models.json");
						const previous = custom && existsSync(file) ? readFileSync(file, "utf8") : undefined;
						try {
							if (custom) {
								await removeCustomProvider(file, command.provider);
								this.customProviderNames = undefined;
								await services.modelRuntime.refresh({ allowNetwork: false });
								const configError = services.modelRuntime.getError();
								if (configError) throw new Error(configError);
							}
							await this.credentials.delete(command.provider);
							await services.modelRuntime.refresh({ allowNetwork: false });
							if (session.model?.provider === command.provider) {
								const model = services.modelRuntime.getAvailableSnapshot()[0];
								if (model) await session.setModel(model);
							}
						} catch (error) {
							if (custom) {
								if (previous === undefined) await rm(file, { force: true });
								else await writeFile(file, previous, { encoding: "utf8", mode: 0o600 });
								this.customProviderNames = undefined;
							}
							if (previousAuth) await this.credentials.modify(command.provider, async () => previousAuth);
							else await this.credentials.delete(command.provider);
							await services.modelRuntime.refresh({ allowNetwork: false });
							throw error;
						}
						break;
					}
					case "login":
						await this.auth.login(command.provider);
						await this.runtime.services.modelRuntime.refresh({ allowNetwork: false });
						if (!session.model) {
							const model = this.runtime.services.modelRuntime
								.getAvailableSnapshot()
								.find((item) => item.provider === command.provider);
							if (model) await session.setModel(model);
						}
						break;
					case "logout":
						if ((await this.credentials.read(command.provider))?.type !== "oauth")
							throw new Error("当前服务商没有已保存的 OAuth 登录");
						await this.runtime.services.modelRuntime.logout(command.provider);
						this.adapter.updateAuthentication(this.auth.state);
						break;
				}
				this.adapter.updateConfiguration(this.configuration());
			} finally {
				this.submitting = false;
			}
		} finally {
			this.logger.info("宿主命令处理结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤2：持久化入队意图并等待 SDK 接受
	 * ========================================================================
	 * 数据源：明确的队列模式与当前流式状态。
	 * 操作：
	 *   1) 保存成功后再次检查运行状态，拒绝迟到输入启动新任务
	 *   2) 已接收的记录留到任务收束，崩溃后只提示核对，不自动重放
	 */
	private async queueAction(action: "steer" | "remove" | "edit", itemId: string, text?: string): Promise<void> {
		const snapshot = this.snapshot;
		const session = this.runtime.session;
		if (snapshot.run.phase !== "working" || !session.isStreaming) throw new Error("请等待任务运行后再调整队列");
		const index = snapshot.queue.followUp.findIndex((item) => item.id === itemId);
		const target = snapshot.queue.followUp[index];
		if (!target) throw new Error("排队消息已不存在");
		const editedText = text?.trim();
		if (action === "edit" && !editedText) throw new Error("排队消息不能为空");
		const original = captureQueuedMessage(session, index, this.logger);
		let undo: (() => Promise<void>) | undefined;
		let committed = false;
		this.logger.info("开始调整排队消息");
		try {
			// 2.3 只准备目标输入；存储和扩展等待期间模型仍可消费其他消息。
			const edited =
				action === "edit" && editedText
					? await prepareQueuedInput(session, editedText, "followUp", this.logger, {
							images:
								typeof original.content === "string"
									? undefined
									: original.content.filter((part) => part.type === "image"),
						})
					: undefined;
			if (action === "edit" && !edited) throw new Error("扩展已接管本次输入，原排队消息保持不变");
			if (edited) edited.timestamp = original.timestamp;
			const replacement = edited ? await this.prepareQueueItem(edited, itemId, target.imageIds) : target;
			undo = await this.journal.amend(
				itemId,
				action === "remove" ? null : { mode: action === "steer" ? "steer" : "followUp", item: replacement },
			);
			if (this.disposed || this.stopping || !session.isStreaming || this.snapshot.run.phase !== "working")
				throw new Error("当前任务已收束或暂停，请核对后重试");
			const current = this.snapshot.queue;
			if (!current.followUp.some((item) => item.id === itemId)) throw new Error("排队消息已开始处理，请核对聊天记录");
			// 2.4 身份核对、原生队列变更和投影安装处于同一同步区间。
			const notify = commitQueuedChange(session, original, action, this.logger, edited);
			committed = true;
			this.adapter.replaceQueue({
				steering: action === "steer" ? [...current.steering, replacement] : current.steering,
				followUp: current.followUp.flatMap((item) =>
					item.id !== itemId ? [item] : action === "edit" ? [replacement] : [],
				),
			});
			notify();
			this.publishRecovery();
		} catch (error) {
			if (!committed && undo) {
				try {
					await undo();
				} catch {
					this.publishRecovery("队列修改记录恢复失败，请保留恢复文件后重试");
					throw new Error("队列修改记录恢复失败，请检查存储");
				}
			}
			this.publishRecovery(error instanceof Error ? error.message : "队列调整失败");
			throw error;
		} finally {
			this.logger.info("排队消息调整结束");
		}
	}

	private async enqueue(
		requestId: string,
		mode: "steer" | "followUp",
		text: string,
		imageIds?: string[],
	): Promise<void> {
		this.logger.info("开始持久化排队意图");
		let prepared = false;
		let committed = false;
		try {
			// 2.1 队列写入失败时尚未调用 SDK，原草稿保持可恢复。
			const session = this.runtime.session;
			if (imageIds?.length && !session.model?.input.includes("image"))
				throw new Error("当前模型不支持图片，请先切换模型");
			const images = imageIds?.length
				? await this.images.readMany(this.snapshot.cwd, this.snapshot.sessionId, imageIds)
				: undefined;
			if (this.disposed || this.stopping || !session.isStreaming || this.snapshot.run.phase !== "working")
				throw new Error("当前任务已收束或暂停，请核对后重新发送");
			// 2.2 异步输入钩子只准备数据；结束后重新核对，不让 prompt 启动新一轮任务。
			const message = await prepareQueuedInput(session, text, mode, this.logger, {
				images,
				allowImmediateCommand: !images?.length,
			});
			if (!message) return;
			const item = await this.prepareQueueItem(message, requestId, imageIds);
			if (this.journal.count >= QUEUE_LIMIT || this.journal.textLength + item.text.length > QUEUE_TEXT_LIMIT)
				throw new Error("本轮追加消息已达上限，请等待当前任务结束");
			await this.journal.prepare(requestId, mode, item.text, item.imageIds);
			prepared = true;
			if (this.disposed || this.stopping || !session.isStreaming || this.snapshot.run.phase !== "working")
				throw new Error("当前任务已收束或暂停，请核对后重新发送");
			// 2.5 写前保存后同步入队和安装附件映射，不再等待任何扩展回调。
			const current = this.snapshot.queue;
			const notify = commitQueuedInput(session, message, mode, this.logger);
			committed = true;
			this.adapter.replaceQueue({
				steering: mode === "steer" ? [...current.steering, item] : current.steering,
				followUp: mode === "followUp" ? [...current.followUp, item] : current.followUp,
			});
			notify();
			this.publishRecovery();
		} catch (error) {
			if (prepared && !committed) await this.journal.rollback(requestId);
			this.publishRecovery(error instanceof Error ? error.message : "入队失败");
			throw error;
		} finally {
			this.logger.info("排队意图持久化结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤6：按扩展处理后的实际内容保存恢复附件
	 * ========================================================================
	 * 数据源：单条准备消息和同会话已验证的图片摘要。
	 * 操作：1) 未变化的附件复用原内容；2) 新图片先保存，拒绝无法恢复的格式。
	 */
	private async prepareQueueItem(
		message: Extract<AgentMessage, { role: "user" }>,
		id: string,
		knownIds?: string[],
	): Promise<QueueItem> {
		this.logger.info("开始保存排队消息附件归属");
		try {
			// 6.1 删除图片时同步移除引用；正文与恢复记录使用相同展开结果。
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("");
			const images = typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "image");
			if (!images.length) return { id, text };
			if (!this.runtime.session.model?.input.includes("image")) throw new Error("当前模型不支持扩展返回的图片");
			if (images.some((image) => image.mimeType !== "image/png"))
				throw new Error("扩展返回的排队图片必须为 PNG，原消息保持不变");
			const data = [
				...new Set(
					imageBatchSchema
						.parse(images.map((image) => image.data))
						.map((value) => Buffer.from(value, "base64").toString("base64")),
				),
			];
			const imageIds = data.map(imageIdentity);
			// 6.2 不读取其他条目的图片；写入失败时还未触碰核心队列。
			if (imageIds.join() !== knownIds?.join())
				await this.images.importData(this.snapshot.cwd, this.snapshot.sessionId, data, (bytes) => bytes);
			message.content = [
				{ type: "text", text },
				...data.map((value) => ({ type: "image" as const, mimeType: "image/png", data: value })),
			];
			return { id, text, imageIds };
		} finally {
			this.logger.info("排队消息附件归属保存结束");
		}
	}

	private async checkpoint(): Promise<void> {
		this.logger.info("开始保存收束后的队列");
		try {
			await this.planJournal.flush();
			if (this.holdQueue) {
				await this.journal.hold();
				this.holdQueue = false;
			}
			await this.journal.checkpoint(this.snapshot.queue);
			this.publishRecovery();
		} catch (error) {
			this.publishRecovery("队列保存失败，请核对待处理输入后重试");
			throw error;
		} finally {
			this.logger.info("收束后的队列保存结束");
		}
	}

	private publishRecovery(error: string | null = null): void {
		this.adapter.updateQueueRecovery(this.holdQueue ? this.journal.interrupted : this.journal.recovery, error);
	}

	/*
	 * ========================================================================
	 * 步骤3：先撤下待处理消息，再停止 SDK
	 * ========================================================================
	 * 数据源：SDK 队列和已保存的写前记录。
	 * 操作：
	 *   1) 同步清除 SDK 待处理消息，避免取消后继续消费后续任务
	 *   2) 保留待核对记录，保存失败也不覆盖原有写前文件
	 */
	private async awaitSubagents(): Promise<void> {
		if (!this.extensionUI.hasActiveSubagents()) return;
		this.adapter.markWaiting();
		await this.extensionUI.waitForSubagents();
	}

	private async stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		const session = this.runtime.session;
		if (session.isIdle) {
			this.extensionUI.cancelWait();
			return;
		}
		this.dialogs.cancel("extension");
		this.extensionUI.cancelWait();
		this.logger.info("开始暂停队列并停止任务");
		// 3.1 先关闭继续消费的入口，之后的迟到入队会回滚。
		this.adapter.markStopping();
		this.holdQueue = true;
		session.clearQueue();
		this.publishRecovery();
		const stopping = Promise.resolve().then(async () => {
			try {
				await this.queueSubmission?.catch(() => {});
				await this.journal.hold();
				this.holdQueue = false;
				this.publishRecovery();
			} catch (error) {
				this.publishRecovery("待处理消息保存失败，已保留恢复记录");
				throw error;
			} finally {
				session.abortCompaction();
				await session.abort();
			}
		});
		this.stopping = stopping;
		try {
			await stopping;
		} finally {
			this.stopping = undefined;
			this.logger.info("队列暂停与任务停止结束");
		}
	}

	async dispose(): Promise<void> {
		this.logger.info("开始关闭 Agent 宿主");
		this.disposed = true;
		this.auth.dispose();
		this.dialogs.dispose();
		this.extensionUI.dispose();
		try {
			// 1.3 先请求取消并等待 SDK 收束，再释放订阅与运行时。
			await this.stop();
			await this.queueSubmission?.catch(() => {});
			await this.checkpoint();
		} finally {
			try {
				this.adapter.dispose();
				this.releasePlan();
				await this.runtime.dispose();
			} finally {
				this.logger.info("Agent 宿主关闭结束");
			}
		}
	}
}
