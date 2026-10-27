import { describe, expect, it, vi } from "vitest";
import { DialogService } from "../src/host/dialog-service.ts";
import { ExtensionUI } from "../src/host/extension-ui.ts";
import {
	countSubagents,
	isSubagentActive,
	SUBAGENT_INSPECT_PREFIX,
	SUBAGENT_INSPECT_WIDGET,
	SUBAGENT_STATUS_PREFIX,
} from "../src/shared/subagents.ts";

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
	/*
	 * ========================================================================
	 * 步骤2：回归官方详情回复与状态隔离
	 * ========================================================================
	 * 数据源：交错的请求编号、瞬时组件和真实等待承诺。
	 * 操作：1) 按编号关联且不显示协议；2) 取消、超时和关闭都释放等待。
	 */
	it("correlates inspection replies and keeps status when other widgets retract", async () => {
		logger.info("开始验证详情回复关联与状态隔离");
		const dialogs = new DialogService(logger, vi.fn());
		const ui = new ExtensionUI(dialogs, logger, vi.fn());
		try {
			// 2.1 详情回复可以逆序到达，清理独立组件不清理运行树。
			ui.context.setWidget("subagent-async", [
				`${SUBAGENT_STATUS_PREFIX}${JSON.stringify({ kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: 1, runs: [{ id: "run", kind: "subagent", label: "worker", state: "running" }] })}`,
			]);
			const ids: string[] = [];
			const first = ui.requestSubagentInspection(async (id) => {
				ids.push(id);
			});
			const second = ui.requestSubagentInspection(async (id) => {
				ids.push(id);
			});
			await Promise.resolve();
			for (const [index, id] of [...ids].reverse().entries()) {
				ui.context.setWidget(SUBAGENT_INSPECT_WIDGET, [
					`${SUBAGENT_INSPECT_PREFIX}${JSON.stringify({ kind: "pi-subagents.inspect-reply", version: 1, requestId: id, finalOutput: `reply-${index}` })}`,
				]);
				ui.context.setWidget(SUBAGENT_INSPECT_WIDGET, undefined);
			}
			ui.context.setWidget("other-plugin", undefined);
			expect((await first).finalOutput).toBe("reply-1");
			expect((await second).finalOutput).toBe("reply-0");
			expect(ui.hasActiveSubagents()).toBe(true);
			expect(ui.value.widgets).toEqual([]);
			const waiting = ui.waitForSubagents();
			ui.cancelWait();
			await waiting;
			expect(ui.hasActiveSubagents()).toBe(true);
			const closing = ui.waitForSubagents();
			ui.dispose();
			await closing;
		} finally {
			ui.dispose();
			dialogs.dispose();
			logger.info("详情回复关联与状态隔离验证完成");
		}
	});
	it("rejects timed out, malformed and closed inspection requests", async () => {
		logger.info("开始验证详情等待清理");
		vi.useFakeTimers();
		const dialogs = new DialogService(logger, vi.fn());
		const ui = new ExtensionUI(dialogs, logger, vi.fn());
		try {
			// 2.2 超时、协议错误和退出都不能保留等待者。
			const timedOut = expect(ui.requestSubagentInspection(async () => {})).rejects.toThrow("超时");
			await vi.advanceTimersByTimeAsync(5000);
			await timedOut;
			const malformed = ui.requestSubagentInspection(async (requestId) => {
				ui.context.setWidget(SUBAGENT_INSPECT_WIDGET, [
					`${SUBAGENT_INSPECT_PREFIX}${JSON.stringify({ requestId, version: 99 })}`,
				]);
			});
			await expect(malformed).rejects.toThrow("格式无效");
			const closed = expect(ui.requestSubagentInspection(async () => {})).rejects.toThrow("已关闭");
			ui.dispose();
			await closed;
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			ui.dispose();
			dialogs.dispose();
			vi.useRealTimers();
			logger.info("详情等待清理验证完成");
		}
	});
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
