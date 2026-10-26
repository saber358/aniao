import { describe, expect, it, vi } from "vitest";
import { DialogService } from "../src/host/dialog-service.ts";
import { ExtensionUI } from "../src/host/extension-ui.ts";
import { countSubagents, isSubagentActive, SUBAGENT_STATUS_PREFIX } from "../src/shared/subagents.ts";

const logger = { info: vi.fn() };

/*
 * ========================================================================
 * 步骤1：验证扩展 UI 的可序列化边界
 * ========================================================================
 * 数据源：UIContext、信号与展示订阅，不运行模型。
 * 操作：
 *   1) 四类回调按独立请求关联，取消和关闭释放等待者
 *   2) 文本展示去除 ANSI 并有界，终端工厂不进入界面
 */
describe("ExtensionUI", () => {
	it("roundtrips portable dialogs and preserves original duplicate selection values", async () => {
		logger.info("开始验证扩展弹窗适配");
		const dialogs = new DialogService(logger, vi.fn());
		const ui = new ExtensionUI(dialogs, logger, vi.fn());
		try {
			const selected = ui.context.select("选择", ["重复", "重复"]);
			dialogs.reply({ id: dialogs.requests[0].id, cancelled: false, value: "1" });
			expect(await selected).toBe("重复");
			const confirmed = ui.context.confirm("确认", "继续？");
			dialogs.reply({ id: dialogs.requests[0].id, cancelled: false, value: false });
			expect(await confirmed).toBe(false);
			const entered = ui.context.input("输入", "中文");
			dialogs.reply({ id: dialogs.requests[0].id, cancelled: false, value: "正文" });
			expect(await entered).toBe("正文");
			const edited = ui.context.editor("编辑", "原文\n下一行");
			expect(dialogs.requests[0].prefill).toBe("原文\n下一行");
			dialogs.reply({ id: dialogs.requests[0].id, cancelled: true });
			expect(await edited).toBeUndefined();
			const closing = ui.context.confirm("关闭", "退出");
			ui.dispose();
			expect(await closing).toBe(false);
		} finally {
			ui.dispose();
			dialogs.dispose();
			logger.info("扩展弹窗适配验证完成");
		}
	});
	it("bounds plain-text widgets and exposes unsupported terminal capabilities explicitly", async () => {
		logger.info("开始验证扩展展示边界");
		const dialogs = new DialogService(logger, vi.fn());
		const changed = vi.fn();
		const ui = new ExtensionUI(dialogs, logger, changed);
		try {
			ui.context.setStatus("state", "\u001b[31m中文状态\u001b[0m");
			ui.context.setWidget("widget", ["<script>text</script>"], { placement: "belowEditor" });
			expect(ui.value.statuses[0].text).toBe("中文状态");
			expect(ui.value.widgets[0].lines).toEqual(["<script>text</script>"]);
			expect(() => ui.context.setWidget("large", Array(41).fill("line"))).toThrow("最多 40 行");
			expect(ui.context.getToolsExpanded()).toBe(false);
			ui.context.setToolsExpanded(true);
			expect(ui.context.getToolsExpanded()).toBe(true);
			const factory = vi.fn();
			await expect(ui.context.custom(factory)).rejects.toThrow("不支持终端组件");
			expect(factory).not.toHaveBeenCalled();
			expect(ui.value.notices[0].message).toContain("custom");
			for (let index = 0; index < 25; index++) ui.context.notify(`notice-${index}`);
			expect(ui.value.notices).toHaveLength(20);
			ui.context.setStatus("state", undefined);
			ui.context.setWidget("widget", undefined);
			expect(ui.value.statuses).toEqual([]);
			expect(ui.value.widgets).toEqual([]);
			ui.dispose();
			changed.mockClear();
			ui.context.notify("迟到通知");
			expect(changed).not.toHaveBeenCalled();
		} finally {
			ui.dispose();
			dialogs.dispose();
			logger.info("扩展展示边界验证完成");
		}
	});
	it("parses subagent snapshots and releases the wait only when all children settle", async () => {
		const dialogs = new DialogService(logger, vi.fn());
		const ui = new ExtensionUI(dialogs, logger, vi.fn());
		const snapshot = (state: "running" | "complete") => ({
			kind: "pi-subagents.async-status-snapshot",
			version: 1,
			generatedAt: 1,
			runs: [
				{
					id: "run",
					kind: "workflow",
					label: "scout",
					state,
					children: [{ id: "child", kind: "step", label: "分析文件", state, agent: "Explore" }],
				},
			],
		});
		try {
			ui.context.setWidget("pi-subagents", [`${SUBAGENT_STATUS_PREFIX}${JSON.stringify(snapshot("running"))}`]);
			expect(ui.hasActiveSubagents()).toBe(true);
			expect(ui.value.subagents?.runs[0].children?.[0].agent).toBe("Explore");
			expect(ui.value.widgets).toEqual([]);
			const waiting = ui.waitForSubagents();
			ui.context.setWidget("pi-subagents", [`${SUBAGENT_STATUS_PREFIX}${JSON.stringify(snapshot("complete"))}`]);
			await waiting;
			expect(ui.hasActiveSubagents()).toBe(false);
			ui.context.setWidget("pi-subagents", undefined);
			expect(ui.value.subagents).toBeUndefined();
			expect(
				isSubagentActive({
					id: "failed",
					kind: "workflow",
					label: "failed",
					state: "failed",
					children: [{ id: "stale", kind: "step", label: "stale", state: "running" }],
				}),
			).toBe(false);
			expect(
				countSubagents({
					kind: "pi-subagents.async-status-snapshot",
					version: 1,
					generatedAt: 1,
					runs: [{ id: "failed", kind: "workflow", label: "failed", state: "failed", children: [] }],
				}).active,
			).toBe(0);
		} finally {
			ui.dispose();
			dialogs.dispose();
		}
	});
});
