import { describe, expect, it, vi } from "vitest";
import { resolveEditorAction } from "../src/domain/editor-keybindings.ts";

const logger = { info: vi.fn() };
const stroke = { key: "Enter", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

/*
 * ========================================================================
 * 步骤1：验证编辑器键位不会抢占系统或换行动作
 * ========================================================================
 * 数据源：默认按键、显式覆盖和标准键盘字段。
 * 操作：
 *   1) 只有完整修饰键匹配才能触发补全动作
 *   2) 单个动作可替换或禁用，其余默认值继续生效
 */
describe("editor keybindings", () => {
	it("keeps modified Enter outside completion and resolves default selection keys", () => {
		logger.info("开始验证默认补全键位");
		expect(resolveEditorAction(stroke, undefined, logger)).toBe("completionAccept");
		for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"])
			expect(resolveEditorAction({ ...stroke, [modifier]: true }, undefined, logger)).toBeNull();
		expect(resolveEditorAction({ ...stroke, key: "ArrowDown" }, undefined, logger)).toBe("completionNext");
		expect(resolveEditorAction({ ...stroke, key: "ArrowUp" }, undefined, logger)).toBe("completionPrevious");
		expect(resolveEditorAction({ ...stroke, key: "Escape" }, undefined, logger)).toBe("completionDismiss");
		expect(resolveEditorAction({ ...stroke, key: "Tab" }, undefined, logger)).toBe("completionTab");
		logger.info("默认补全键位验证完成");
	});
	it("replaces or disables an action without changing other defaults", () => {
		logger.info("开始验证补全键位覆盖");
		const config = { completionAccept: [{ key: "j", ctrl: true }], completionTab: [] };
		expect(resolveEditorAction(stroke, config, logger)).toBeNull();
		expect(resolveEditorAction({ ...stroke, key: "J", ctrlKey: true }, config, logger)).toBe("completionAccept");
		expect(resolveEditorAction({ ...stroke, key: "Tab" }, config, logger)).toBeNull();
		expect(resolveEditorAction({ ...stroke, key: "Escape" }, config, logger)).toBe("completionDismiss");
		logger.info("补全键位覆盖验证完成");
	});
});
