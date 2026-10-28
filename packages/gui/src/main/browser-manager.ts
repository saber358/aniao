import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import type { BrowserAction, BrowserLayout, BrowserNavigate, BrowserState } from "../shared/browser.ts";
import {
	type BrowserPresentation,
	type BuiltinCall,
	type BuiltinResult,
	builtinToolSchemas,
} from "../shared/builtin-mcp.ts";
import type { Logger } from "../shared/logger.ts";
import type { SessionIdentity } from "../shared/workspace.ts";
import { BROWSER_PAGE_SCRIPT } from "./browser-page-script.ts";
import { BrowserService } from "./browser-service.ts";

interface Entry {
	service: BrowserService;
	owner: SessionIdentity;
	layout?: BrowserLayout;
	pending: Promise<unknown>;
}
const key = (owner: SessionIdentity) => `${owner.sessionId}/${owner.generation}`;

/*
 * ========================================================================
 * 步骤1：按会话持有独立网页并串行处理同页动作
 * ========================================================================
 * 数据源：可信宿主身份、手动创建标签与原生网页视图。
 * 操作：1) 不能跨会话取标签；2) 隐藏和切换不销毁页面，关闭立即撤销身份。
 */
export class BrowserManager {
	private readonly entries = new Map<string, Entry>();
	private readonly selected = new Map<string, string>();
	private readonly window: BrowserWindow;
	private readonly logger: Logger;
	private readonly publish: (state: BrowserState) => void;
	private readonly present: (value: BrowserPresentation) => void;
	constructor(
		window: BrowserWindow,
		logger: Logger,
		publish: (state: BrowserState) => void,
		present: (value: BrowserPresentation) => void,
	) {
		this.window = window;
		this.logger = logger;
		this.publish = publish;
		this.present = present;
		window.webContents.on("did-start-loading", this.dispose);
	}
	create(id: string, owner: SessionIdentity): BrowserState {
		const existing = this.entries.get(id);
		if (existing) {
			if (key(existing.owner) !== key(owner)) throw new Error("浏览器标签属于其他会话");
			return existing.service.create(id);
		}
		if (this.entries.size >= 24) throw new Error("浏览器标签已达上限，请先关闭部分标签");
		const service = new BrowserService(this.window, this.logger, this.publish);
		this.entries.set(id, {
			service,
			owner: { sessionId: owner.sessionId, generation: owner.generation },
			pending: Promise.resolve(),
		});
		this.selected.set(key(owner), id);
		return service.create(id);
	}
	navigate(request: BrowserNavigate): void {
		this.entry(request.id).service.navigate(request);
	}
	navigateFile(request: { id: string; url: string }): void {
		this.entry(request.id).service.navigateFile(request);
	}
	action(request: BrowserAction): void {
		this.entry(request.id).service.action(request);
	}
	setLayout(layout: BrowserLayout): void {
		const entry = this.entries.get(layout.id);
		if (!entry) return;
		if (layout.visible) {
			this.selected.set(key(entry.owner), layout.id);
			for (const [id, item] of this.entries)
				if (id !== layout.id && item.layout?.visible) {
					item.layout = { ...item.layout, visible: false };
					item.service.setLayout(item.layout);
				}
		}
		entry.layout = layout;
		entry.service.setLayout(layout);
	}
	close(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.service.dispose();
		this.entries.delete(id);
		if (this.selected.get(key(entry.owner)) === id) this.selected.delete(key(entry.owner));
	}
	readonly dispose = (): void => {
		for (const id of this.entries.keys()) this.close(id);
	};
	private entry(id: string): Entry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error("浏览器标签已关闭");
		return entry;
	}
	async execute(owner: SessionIdentity, call: BuiltinCall, signal: AbortSignal): Promise<BuiltinResult> {
		this.logger.info("开始执行会话浏览器 MCP");
		try {
			// 1.1 schema 在工具与桌面两端重验，不提供任意脚本、桌面或工作台句柄。
			const args = builtinToolSchemas[call.name].parse(call.arguments);
			if (call.name === "browser_tabs")
				return this.text(
					[...this.entries]
						.filter(([, item]) => key(item.owner) === key(owner))
						.map(([id, item]) => ({
							...item.service.getState(),
							tabId: id,
							selected: this.selected.get(key(owner)) === id,
						})),
				);
			let id = "tabId" in args ? args.tabId : undefined;
			if ("newTab" in args && args.newTab) {
				if (id) throw new Error("新建标签时不能同时指定 tabId");
				id = randomUUID();
				this.create(id, owner);
			}
			id ??= this.selected.get(key(owner));
			if (!id && call.name === "browser_open") {
				id = randomUUID();
				this.create(id, owner);
			}
			if (!id) throw new Error("当前会话没有浏览器标签，请先调用 browser_open");
			const entry = this.entry(id);
			if (key(entry.owner) !== key(owner)) throw new Error("不能操作其他会话的浏览器标签");
			const tabId = id;
			const operation = entry.pending
				.catch(() => {})
				.then(async () => {
					signal.throwIfAborted();
					if (this.entries.get(tabId) !== entry) throw new Error("浏览器标签已关闭");
					this.selected.set(key(owner), tabId);
					if (call.name === "browser_close") {
						this.close(tabId);
						this.present({ id: tabId, ...owner, closed: true });
						return this.text({ closed: true, tabId });
					}
					this.present({ id: tabId, ...owner });
					if (call.name === "browser_open" && "url" in args) entry.service.navigate({ id: tabId, url: args.url });
					if (call.name === "browser_history" && "action" in args)
						entry.service.action({ id: tabId, action: args.action });
					const deadline = Date.now() + 20000;
					while (entry.service.getState()?.loading && Date.now() < deadline) {
						await delay(50, undefined, { signal });
					}
					signal.throwIfAborted();
					const state = entry.service.getState();
					if (!state) throw new Error("浏览器标签已关闭");
					if (state.loading) throw new Error("网页仍在加载，请稍后重试");
					if (state.error) throw new Error(state.error);
					const contents = entry.service.getContents(tabId);
					if (call.name === "browser_screenshot") {
						let shot = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
						if (shot.getSize().width > 1600) shot = shot.resize({ width: 1600 });
						const data = shot.toPNG().toString("base64");
						if (data.length > 5_600_000) throw new Error("截图过大，请缩小网页后重试");
						return { content: [{ type: "image" as const, data, mimeType: "image/png" as const }] };
					}
					if (call.name === "browser_press" && "key" in args) {
						contents.sendInputEvent({ type: "keyDown", keyCode: args.key });
						contents.sendInputEvent({ type: "keyUp", keyCode: args.key });
						return this.text({ pressed: true, tabId });
					}
					const action = call.name.replace("browser_", "");
					const input = {
						...args,
						action: action === "open" || action === "history" ? "snapshot" : action,
						pixels: "pixels" in args ? (args.pixels ?? 600) : 600,
					};
					const value: unknown = await contents.executeJavaScriptInIsolatedWorld(997, [
						{ code: `(${BROWSER_PAGE_SCRIPT})(${JSON.stringify(input)})` },
					]);
					signal.throwIfAborted();
					return this.text({ tabId, page: value });
				});
			entry.pending = operation;
			return await operation;
		} finally {
			this.logger.info("会话浏览器 MCP 执行结束");
		}
	}
	private text(value: unknown): BuiltinResult {
		let serialized = JSON.stringify(value);
		// 1.3 密集页面减少元素条数，不能把 JSON 从中间截断。
		if (
			serialized.length > 95000 &&
			typeof value === "object" &&
			value !== null &&
			"page" in value &&
			typeof value.page === "object" &&
			value.page !== null &&
			"elements" in value.page &&
			Array.isArray(value.page.elements)
		) {
			const page = { ...value.page, truncated: true, elements: [...value.page.elements] };
			while (serialized.length > 95000 && page.elements.length) {
				page.elements.length = Math.floor(page.elements.length * 0.75);
				serialized = JSON.stringify({ ...value, page });
			}
		}
		if (serialized.length > 95000)
			serialized = JSON.stringify({ truncated: true, excerpt: serialized.slice(0, 35000) });
		return { content: [{ type: "text", text: serialized }] };
	}
}
