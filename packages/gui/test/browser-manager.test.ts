import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../src/main/browser-manager.ts";
import type { BrowserState } from "../src/shared/browser.ts";

const fixtures = vi.hoisted(() => ({
	pages: [] as Array<{ state: BrowserState; execute: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
}));
vi.mock("../src/main/browser-service.ts", () => ({
	BrowserService: class {
		private state: BrowserState = {
			id: "",
			url: "",
			title: "fixture",
			loading: false,
			canGoBack: false,
			canGoForward: false,
			error: null,
			notice: null,
		};
		private execute = vi.fn(async () => ({ text: "fixture page" }));
		dispose = vi.fn();
		constructor() {
			fixtures.pages.push({ state: this.state, execute: this.execute, dispose: this.dispose });
		}
		create(id: string) {
			this.state.id = id;
			return { ...this.state };
		}
		navigate(input: { url: string }) {
			this.state.url = input.url;
		}
		getState() {
			return { ...this.state };
		}
		getContents() {
			return { executeJavaScriptInIsolatedWorld: this.execute };
		}
		setLayout() {}
	},
}));
const logger = { info: vi.fn() };
const owner = { sessionId: "one", generation: "first" };
const other = { sessionId: "two", generation: "second" };
const id = "40cbb848-6d53-4abd-a717-19874a2fd8ac";

/*
 * ========================================================================
 * 步骤1：验证多会话浏览器的归属、队列与释放
 * ========================================================================
 * 数据源：独立原生视图替身和可暂停的页面请求。
 * 操作：1) 标签不能跨会话调用；2) 排队取消和标签关闭不得继续操作页面。
 */
describe("browser MCP ownership", () => {
	it("preserves valid snapshot JSON when dense pages exceed the transfer budget", async () => {
		logger.info("开始验证密集网页快照预算");
		const manager = new BrowserManager(
			{ webContents: new EventEmitter() } as unknown as BrowserWindow,
			logger,
			vi.fn(),
			vi.fn(),
		);
		try {
			// 2.1 压缩元素列表后仍保留来源、正文和截断标记。
			manager.create(id, owner);
			fixtures.pages[0].execute.mockResolvedValueOnce({
				text: "页面正文",
				elements: Array.from({ length: 250 }, (_, index) => ({ ref: String(index), label: "x".repeat(700) })),
			});
			const result = await manager.execute(
				owner,
				{ server: "harness_browser", name: "browser_snapshot", arguments: {} },
				new AbortController().signal,
			);
			const block = result.content[0];
			expect(block.type).toBe("text");
			if (block.type === "text") {
				expect(block.text.length).toBeLessThan(100000);
				const data = JSON.parse(block.text);
				expect(data.page.truncated).toBe(true);
				expect(data.page.text).toBe("页面正文");
				expect(data.page.elements.length).toBeLessThan(250);
			}
		} finally {
			manager.dispose();
			logger.info("密集网页快照预算验证结束");
		}
	});
	beforeEach(() => {
		fixtures.pages.length = 0;
	});
	it("keeps separate tabs per session and rejects explicit access across identities", async () => {
		logger.info("开始验证浏览器会话归属");
		const window = { webContents: new EventEmitter() } as unknown as BrowserWindow;
		const manager = new BrowserManager(window, logger, vi.fn(), vi.fn());
		try {
			// 1.1 只有可信宿主身份拥有标签，UUID 本身不是跨会话授权。
			manager.create(id, owner);
			await expect(
				manager.execute(
					other,
					{ server: "harness_browser", name: "browser_snapshot", arguments: { tabId: id } },
					new AbortController().signal,
				),
			).rejects.toThrow("其他会话");
			expect(() => manager.create(id, other)).toThrow("其他会话");
			const empty = await manager.execute(
				other,
				{ server: "harness_browser", name: "browser_tabs", arguments: {} },
				new AbortController().signal,
			);
			expect(empty.content[0]).toEqual({ type: "text", text: "[]" });
			await manager.execute(
				other,
				{ server: "harness_browser", name: "browser_open", arguments: { url: "https://example.com/", newTab: true } },
				new AbortController().signal,
			);
			expect(fixtures.pages).toHaveLength(2);
			manager.close(id);
			expect(fixtures.pages[0].dispose).toHaveBeenCalledTimes(1);
			expect(fixtures.pages[1].dispose).not.toHaveBeenCalled();
		} finally {
			manager.dispose();
			logger.info("浏览器会话归属验证结束");
		}
	});
	it("serializes actions and discards cancelled or closed queued requests", async () => {
		logger.info("开始验证浏览器队列取消");
		const manager = new BrowserManager(
			{ webContents: new EventEmitter() } as unknown as BrowserWindow,
			logger,
			vi.fn(),
			vi.fn(),
		);
		try {
			manager.create(id, owner);
			let finish: (value: unknown) => void = () => {};
			fixtures.pages[0].execute.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const first = manager.execute(
				owner,
				{ server: "harness_browser", name: "browser_snapshot", arguments: {} },
				new AbortController().signal,
			);
			await vi.waitFor(() => expect(fixtures.pages[0].execute).toHaveBeenCalledTimes(1));
			// 1.2 第二个请求必须排队，取消后不得进入原生网页。
			const cancel = new AbortController();
			const second = expect(
				manager.execute(owner, { server: "harness_browser", name: "browser_snapshot", arguments: {} }, cancel.signal),
			).rejects.toThrow();
			cancel.abort();
			finish({ text: "done" });
			await first;
			await second;
			expect(fixtures.pages[0].execute).toHaveBeenCalledTimes(1);
			manager.close(id);
			await expect(
				manager.execute(
					owner,
					{ server: "harness_browser", name: "browser_snapshot", arguments: { tabId: id } },
					new AbortController().signal,
				),
			).rejects.toThrow("已关闭");
		} finally {
			manager.dispose();
			logger.info("浏览器队列取消验证结束");
		}
	});
});
