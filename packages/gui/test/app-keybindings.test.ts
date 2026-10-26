import { describe, expect, it, vi } from "vitest";
import { resolveAppAction } from "../src/domain/app-keybindings.ts";

const logger = { info: vi.fn() };
const stroke = { key: ",", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };

/*
 * ========================================================================
 * 步骤1：保护原生编辑组合键与可覆盖的应用快捷键
 * ========================================================================
 * 数据源：Windows/macOS 修饰键与用户覆盖配置。
 * 操作：1) 设置快捷键与原生编辑互不抢占；2) 完整匹配或禁用单个动作。
 */
describe("application keybindings", () => {
	it("opens settings with either platform modifier and leaves native edit keys untouched", () => {
		logger.info("开始验证设置快捷键与编辑边界");
		try {
			// 1.1 Ctrl+, 和 Cmd+, 等价，额外修饰键不能误打开应用工具。
			expect(resolveAppAction(stroke, undefined, logger)).toBe("settings");
			expect(resolveAppAction({ ...stroke, ctrlKey: false, metaKey: true }, undefined, logger)).toBe("settings");
			for (const key of ["z", "y", "x", "c", "v", "a", "Delete"])
				expect(resolveAppAction({ ...stroke, key }, undefined, logger)).toBeNull();
			for (const modifier of ["altKey", "shiftKey", "metaKey"])
				expect(resolveAppAction({ ...stroke, [modifier]: true }, undefined, logger)).toBeNull();
		} finally {
			logger.info("设置快捷键与编辑边界验证结束");
		}
	});
	it("keeps side tools configurable without registering duplicate edit shortcuts", () => {
		logger.info("开始验证应用工具快捷键覆盖");
		try {
			// 1.2 替换与禁用只影响指定动作，其余工具沿用默认配置。
			const bindings = { settings: [], files: [{ key: "f", ctrl: true }] };
			expect(resolveAppAction(stroke, bindings, logger)).toBeNull();
			expect(resolveAppAction({ ...stroke, key: "p" }, bindings, logger)).toBeNull();
			expect(resolveAppAction({ ...stroke, key: "F" }, bindings, logger)).toBe("files");
			expect(resolveAppAction({ ...stroke, key: "`" }, bindings, logger)).toBe("terminal");
			expect(resolveAppAction({ ...stroke, key: "t" }, bindings, logger)).toBe("browser");
		} finally {
			logger.info("应用工具快捷键覆盖验证结束");
		}
	});
});
