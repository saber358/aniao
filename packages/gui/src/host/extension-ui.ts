import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionUIContext, initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionState } from "../shared/interactions.ts";
import type { Logger } from "../shared/logger.ts";
import {
	hasActiveSubagents,
	SUBAGENT_STATUS_PREFIX,
	type SubagentSnapshot,
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
				if (content !== undefined && !Array.isArray(content)) {
					// 组件型 widget 依赖终端 TUI；桌面端保留插件运行，不把显示失败升级为错误。
					this.logger.info("忽略扩展组件型小组件");
					return;
				}
				if (Array.isArray(content) && content[0]?.startsWith(SUBAGENT_STATUS_PREFIX)) {
					this.updateSubagents(key, content[0].slice(SUBAGENT_STATUS_PREFIX.length));
					return;
				}
				if (content === undefined && (key === this.subagentWidgetKey || this.state.subagents)) {
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
		// 等待期间状态可能由任意快照更新或清空；轮询状态本身，避免漏掉一次释放通知后永久卡住。
		while (this.hasActiveSubagents()) {
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
		}
	}

	cancelWait(): void {
		this.releaseSubagentWaiters();
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
		this.releaseSubagentWaiters();
		this.dialogs.cancel("extension");
	}
}
