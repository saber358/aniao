import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, shallowReactive } from "vue";
import type { FileCompletion } from "../../src/domain/file-completion.ts";
import { type FileCompletionOptions, useFileCompletion } from "../../src/renderer/composables/use-file-completion.ts";
import type { ProjectFileReference } from "../../src/shared/project-files.ts";

const logger = { info: vi.fn() };
const focusDocument: { activeElement: FakeTextarea | null } = { activeElement: null };
class FakeNode extends EventTarget {}
class FakeTextarea extends FakeNode {
	value = "";
	selectionStart = 0;
	selectionEnd = 0;
	isConnected = true;
	focus = vi.fn(() => {
		focusDocument.activeElement = this;
		this.dispatchEvent(new Event("focus"));
	});
	setSelectionRange(start: number, end: number) {
		this.selectionStart = start;
		this.selectionEnd = end;
		this.dispatchEvent(new Event("select"));
	}
}
function setup(reference = async (_input: ProjectFileReference, _completion: FileCompletion) => true) {
	const element = new FakeTextarea();
	const options = shallowReactive<FileCompletionOptions>({
		textarea: element as unknown as HTMLTextAreaElement,
		draft: "",
		selection: { sessionId: "session", generation: "host" },
		disabled: false,
		error: null,
		directory: vi.fn(async (path: string) => ({ path, entries: [], truncated: false })),
		enterDirectory: vi.fn(async () => true),
		referenceDirectory: vi.fn(async () => true),
		search: vi.fn(async () => ({ paths: ["src/file.ts"], incomplete: false })),
		reference: vi.fn(reference),
	});
	const scope = effectScope();
	const view = scope.run(() => useFileCompletion(options, logger, "test-files"));
	if (!view) throw new Error("Completion view missing");
	function edit(text: string) {
		options.draft = text;
		element.value = text;
		element.setSelectionRange(text.length, text.length);
		element.dispatchEvent(new Event("input"));
	}
	function key(key: string, repeat = false) {
		const event = Object.assign(new Event("keydown", { cancelable: true }), {
			key,
			repeat,
			altKey: false,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			isComposing: false,
		});
		element.dispatchEvent(event);
		return event;
	}
	element.focus();
	return { element, options, scope, view, edit, key };
}

/*
 * ========================================================================
 * 步骤1：验证补全监听、键盘优先级与失效清理
 * ========================================================================
 * 数据源：只覆盖所用 DOM 接口的事件替身、真实 Vue watch 与虚拟计时器。
 * 操作：
 *   1) Escape 只关闭当前输入版本，编辑后可以重新查询
 *   2) 组词、空候选、重复按键、换代和销毁均不误选或恢复旧焦点
 */
describe("file completion view", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		focusDocument.activeElement = null;
		vi.stubGlobal("document", focusDocument);
		vi.stubGlobal("Node", FakeNode);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	it("reopens after editing away from an Escape-dismissed fragment and returning to its text", async () => {
		logger.info("开始验证补全关闭与重新编辑");
		const state = setup();
		try {
			state.edit("前文 @src");
			await nextTick();
			await vi.advanceTimersByTimeAsync(181);
			expect(state.view.matches.value.paths).toEqual(["src/file.ts"]);
			expect(state.key("Escape").defaultPrevented).toBe(true);
			expect(state.view.target.value).toBeNull();
			state.edit("邮箱 dev@example.com");
			await nextTick();
			state.edit("前文 @src");
			await nextTick();
			await vi.advanceTimersByTimeAsync(181);
			expect(state.view.target.value?.query).toBe("src");
			expect(state.options.search).toHaveBeenCalledTimes(2);
		} finally {
			state.scope.stop();
			logger.info("补全关闭与重新编辑验证完成");
		}
	});
	it("guards pending and empty confirmation while allowing Tab to leave", async () => {
		logger.info("开始验证空候选确认");
		const state = setup();
		state.options.search = vi.fn(async () => ({ paths: [], incomplete: false }));
		try {
			state.edit("@missing");
			await nextTick();
			expect(state.key("Enter").defaultPrevented).toBe(true);
			await vi.advanceTimersByTimeAsync(181);
			expect(state.key("Enter").defaultPrevented).toBe(true);
			expect(state.key("Tab").defaultPrevented).toBe(false);
			expect(state.view.target.value).toBeNull();
			expect(state.options.reference).not.toHaveBeenCalled();
		} finally {
			state.scope.stop();
			logger.info("空候选确认验证完成");
		}
	});
	it("does not select during composition or its trailing Enter, and suppresses held confirmation", async () => {
		logger.info("开始验证补全组词与长按保护");
		const state = setup();
		try {
			state.edit("@src");
			state.element.dispatchEvent(new Event("compositionstart"));
			expect(state.key("Enter").defaultPrevented).toBe(false);
			state.element.dispatchEvent(new Event("compositionend"));
			expect(state.key("Enter").defaultPrevented).toBe(false);
			expect(state.options.reference).not.toHaveBeenCalled();
			await nextTick();
			await vi.advanceTimersByTimeAsync(181);
			expect(state.key("Enter").defaultPrevented).toBe(true);
			state.edit('@"src/file.ts" ');
			await nextTick();
			state.element.dispatchEvent(Object.assign(new Event("keyup"), { key: "Shift", code: "ShiftLeft" }));
			expect(state.key("Enter", true).defaultPrevented).toBe(true);
			expect(state.options.reference).toHaveBeenCalledTimes(1);
		} finally {
			state.scope.stop();
			logger.info("补全组词与长按保护验证完成");
		}
	});
	it.each(["dispose", "generation"])(
		"drops late selection focus after %s and releases old listeners",
		async (change) => {
			logger.info("开始验证补全迟到选择");
			let finish: (value: boolean) => void = () => {};
			const state = setup(
				() =>
					new Promise<boolean>((resolve) => {
						finish = resolve;
					}),
			);
			try {
				state.edit("@src");
				await nextTick();
				await vi.advanceTimersByTimeAsync(181);
				const pending = state.view.select("src/file.ts");
				state.element.focus.mockClear();
				if (change === "dispose") state.scope.stop();
				else state.options.selection = { ...state.options.selection, generation: "next" };
				await nextTick();
				finish(true);
				await pending;
				expect(state.element.focus).not.toHaveBeenCalled();
				state.scope.stop();
				expect(state.key("Enter").defaultPrevented).toBe(false);
			} finally {
				state.scope.stop();
				logger.info("补全迟到选择验证完成");
			}
		},
	);
});
