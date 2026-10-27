import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionUIContext, initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionState } from "../shared/interactions.ts";
import type { Logger } from "../shared/logger.ts";
import {
	hasActiveSubagents,
	SUBAGENT_INSPECT_PREFIX,
	SUBAGENT_INSPECT_WIDGET,
	SUBAGENT_STATUS_PREFIX,
	type SubagentInspection,
	type SubagentSnapshot,
	subagentInspectionSchema,
	subagentSnapshotSchema,
} from "../shared/subagents.ts";
import type { DialogService } from "./dialog-service.ts";
import { theme } from "./kernel.ts";

/*
 * ========================================================================
 * 步骤1：把可移植扩展 UI 适配为桌面数据
 * ========================================================================
 * 数据源：ExtensionUIContext；工厂函数和终端组件不进入跨进程协议。
 * 操作：
 *   1) 选择、确认、输入和编辑共用有界交互服务
 *   2) 通知、状态和文本小组件按键替换，终端专有能力明确提示不支持
 */
export class ExtensionUI {
	private state: ExtensionState = {
		notices: [],
		statuses: [],
		widgets: [],
		supported: ["select", "confirm", "input", "editor", "notify", "setStatus", "setWidget:text", "setToolsExpanded"],
	};
	private readonly dialogs: DialogService;
	private readonly logger: Logger;
	private readonly changed: (state: ExtensionState) => void;
	private closed = false;
	private toolsExpanded = false;
	private subagentWidgetKey: string | undefined;
	private readonly subagentWaiters = new Set<() => void>();
	private subagentWaitGeneration = 0;
	private readonly inspections = new Map<
		string,
		{ finish(value: SubagentInspection): void; fail(error: Error): void }
	>();
	readonly context: ExtensionUIContext;

	constructor(dialogs: DialogService, logger: Logger, changed: (state: ExtensionState) => void) {
		this.dialogs = dialogs;
		this.logger = logger;
		this.changed = changed;
		initTheme("dark", false);
		// 1.1 对照 RPC 的 Theme 读取语义，仅在宿主使用；显示文本去除终端控制符。
		this.context = {
			select: async (title, options, opts) => {
				const values = [...options];
				const result = await dialogs.show(
					{
						scope: "extension",
						kind: "select",
						title: this.text(title, 4096),
						options: values.map((value, index) => ({ value: String(index), label: this.text(value, 4096) })),
					},
					opts,
				);
				return typeof result === "string" ? values[Number(result)] : undefined;
			},
			confirm: async (title, message, opts) =>
				(await dialogs.show(
					{ scope: "extension", kind: "confirm", title: this.text(title, 4096), message: this.text(message, 8192) },
					opts,
				)) === true,
			input: async (title, placeholder, opts) => {
				const result = await dialogs.show(
					{
						scope: "extension",
						kind: "input",
						title: this.text(title, 4096),
						placeholder: placeholder ? this.text(placeholder, 4096) : undefined,
					},
					opts,
				);
				return typeof result === "string" ? result : undefined;
			},
			editor: async (title, prefill) => {
				const result = await dialogs.show(
					{ scope: "extension", kind: "editor", title: this.text(title, 4096), prefill },
					undefined,
				);
				return typeof result === "string" ? result : undefined;
			},
			notify: (message, level = "info") => this.notify(message, level),
			setStatus: (key, text) => {
				const entries = this.state.statuses.filter((entry) => entry.key !== key);
				if (text !== undefined) entries.push({ key: this.text(key, 256), text: this.text(text, 8192) });
				this.update({ statuses: entries.slice(-20) });
			},
			setWidget: (key, content, options) => {
				// 1.3 官方详情回复先关联请求；发送后的撤回不进入可见组件和运行状态。
				if (key === SUBAGENT_INSPECT_WIDGET) {
					if (Array.isArray(content) && content[0]?.startsWith(SUBAGENT_INSPECT_PREFIX))
						this.receiveInspection(content[0].slice(SUBAGENT_INSPECT_PREFIX.length));
					return;
				}
				if (content !== undefined && !Array.isArray(content)) {
					// 组件型 widget 依赖终端 TUI；桌面端保留插件运行，不把显示失败升级为错误。
					this.logger.info("忽略扩展组件型小组件");
					return;
				}
				if (Array.isArray(content) && content[0]?.startsWith(SUBAGENT_STATUS_PREFIX)) {
					this.updateSubagents(key, content[0].slice(SUBAGENT_STATUS_PREFIX.length));
					return;
				}
				if (content === undefined && key === this.subagentWidgetKey) {
					this.clearSubagents();
					return;
				}
				if (content && content.length > 40) throw new Error("文本小组件最多 40 行");
				const entries = this.state.widgets.filter((entry) => entry.key !== key);
				if (content)
					entries.push({
						key: this.text(key, 256),
						lines: content.map((line) => this.text(line, 4096)),
						placement: options?.placement ?? "aboveEditor",
					});
				this.update({ widgets: entries.slice(-20) });
			},
			onTerminalInput: () => {
				// 子 Agent 扩展用终端输入监听做按键交互；桌面端没有对应通道，保留扩展运行并返回空清理函数。
				this.logger.info("忽略扩展终端输入监听");
				return () => {};
			},
			setWorkingMessage: () => this.unsupported("setWorkingMessage"),
			setWorkingVisible: () => this.unsupported("setWorkingVisible"),
			setWorkingIndicator: () => this.unsupported("setWorkingIndicator"),
			setHiddenThinkingLabel: () => this.unsupported("setHiddenThinkingLabel"),
			setFooter: (factory) => {
				if (factory) this.unsupported("setFooter");
			},
			setHeader: (factory) => {
				if (factory) this.unsupported("setHeader");
			},
			setTitle: () => this.unsupported("setTitle"),
			custom: async () => {
				this.unsupported("custom");
				throw new Error("GUI 不支持终端组件工厂");
			},
			pasteToEditor: () => this.unsupported("pasteToEditor"),
			setEditorText: () => this.unsupported("setEditorText"),
			getEditorText: () => {
				throw new Error("GUI 暂不支持扩展读取主输入框");
			},
			addAutocompleteProvider: () => this.unsupported("addAutocompleteProvider"),
			setEditorComponent: (factory) => {
				if (factory) this.unsupported("setEditorComponent");
			},
			getEditorComponent: () => undefined,
			get theme() {
				return theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "GUI 使用桌面主题设置" }),
			getToolsExpanded: () => this.toolsExpanded,
			setToolsExpanded: (expanded) => {
				this.toolsExpanded = expanded;
			},
		};
	}

	get value(): ExtensionState {
		return this.state;
	}

	hasSubagentState(): boolean {
		return this.state.subagents !== undefined;
	}

	hasActiveSubagents(): boolean {
		return hasActiveSubagents(this.state.subagents);
	}

	async waitForSubagents(): Promise<void> {
		this.logger.info("开始等待子智能体");
		try {
			// 2.1 状态检查与等待者登记之间不让出控制权，取消后不再进入下一轮等待。
			const generation = this.subagentWaitGeneration;
			while (!this.closed && generation === this.subagentWaitGeneration && this.hasActiveSubagents())
				await new Promise<void>((resolve) => this.subagentWaiters.add(resolve));
		} finally {
			this.logger.info("子智能体等待结束");
		}
	}

	cancelWait(): void {
		this.subagentWaitGeneration += 1;
		this.releaseSubagentWaiters();
	}

	/*
	 * ========================================================================
	 * 步骤2：关联官方详情查询与瞬时组件回复
	 * ========================================================================
	 * 数据源：宿主只读扩展命令与带 requestId 的回复。
	 * 操作：1) 派发前登记；2) 超时、异常和关闭均清理等待者。
	 */
	requestSubagentInspection(dispatch: (requestId: string) => Promise<void>): Promise<SubagentInspection> {
		this.logger.info("开始读取子智能体详情");
		if (this.closed) return Promise.reject(new Error("子智能体详情会话已关闭"));
		if (this.inspections.size >= 16) return Promise.reject(new Error("子智能体详情请求过多，请稍后重试"));
		// 2.2 UUID 只用于回复关联，不将模型消息或文件路径作为命令内容。
		const requestId = randomUUID();
		return new Promise<SubagentInspection>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				this.inspections.delete(requestId);
				this.logger.info("子智能体详情读取结束");
			};
			const fail = (error: Error) => {
				cleanup();
				reject(error);
			};
			const timer = setTimeout(() => fail(new Error("子智能体详情查询超时，请重试")), 5000);
			this.inspections.set(requestId, {
				finish: (value) => {
					cleanup();
					resolve(value);
				},
				fail,
			});
			void Promise.resolve()
				.then(() => dispatch(requestId))
				.catch((error: unknown) => {
					this.inspections.get(requestId)?.fail(error instanceof Error ? error : new Error("子智能体详情查询失败"));
				});
		});
	}

	private receiveInspection(json: string): void {
		this.logger.info("开始处理子智能体详情回复");
		try {
			// 2.3 先检查传输预算，再解析和关联；未匹配回复不会成为可见组件。
			if (Buffer.byteLength(json, "utf8") > 65536) return;
			const value: unknown = JSON.parse(json);
			const parsed = subagentInspectionSchema.safeParse(value);
			if (parsed.success) this.inspections.get(parsed.data.requestId)?.finish(parsed.data);
			else if (value && typeof value === "object" && "requestId" in value && typeof value.requestId === "string")
				this.inspections.get(value.requestId)?.fail(new Error("子智能体详情回复格式无效"));
		} catch {
			this.logger.info("忽略损坏的子智能体详情回复");
		} finally {
			this.logger.info("子智能体详情回复处理结束");
		}
	}

	private updateSubagents(key: string, json: string): void {
		try {
			const parsed = subagentSnapshotSchema.safeParse(JSON.parse(json));
			if (!parsed.success) {
				this.logger.info("忽略无效的子 Agent 状态快照");
				return;
			}
			const snapshot: SubagentSnapshot = parsed.data;
			this.subagentWidgetKey = key;
			this.update({
				subagents: snapshot.runs.length ? snapshot : undefined,
				widgets: this.state.widgets.filter((entry) => entry.key !== key),
			});
			if (!hasActiveSubagents(snapshot)) this.releaseSubagentWaiters();
		} catch {
			this.logger.info("解析子 Agent 状态快照失败");
		}
	}

	private clearSubagents(): void {
		this.subagentWidgetKey = undefined;
		this.update({ subagents: undefined });
		this.releaseSubagentWaiters();
	}

	private releaseSubagentWaiters(): void {
		for (const resolve of this.subagentWaiters) resolve();
		this.subagentWaiters.clear();
	}

	private text(value: string, limit: number): string {
		if (value.length > limit) throw new Error("扩展展示内容超过上限");
		return stripVTControlCharacters(value);
	}

	private update(patch: Partial<ExtensionState>): void {
		this.logger.info("开始更新扩展展示");
		try {
			// 1.2 退出后迟到的扩展回调不重新建立视图。
			if (this.closed) return;
			this.state = { ...this.state, ...patch };
			this.changed(this.state);
		} finally {
			this.logger.info("扩展展示更新结束");
		}
	}

	notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		this.update({
			notices: [...this.state.notices, { id: randomUUID(), message: this.text(message, 8192), level }].slice(-20),
		});
	}

	dismiss(id: string): void {
		this.update({ notices: this.state.notices.filter((notice) => notice.id !== id) });
	}
	private unsupported(method: string): void {
		this.notify(`扩展界面能力暂不支持：${method}`, "warning");
	}
	dispose(): void {
		this.closed = true;
		this.cancelWait();
		for (const pending of this.inspections.values()) pending.fail(new Error("子智能体详情会话已关闭"));
		this.dialogs.cancel("extension");
	}
}
