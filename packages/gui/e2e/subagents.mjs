import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveConfig } from "electron-vite";
import { chromium } from "playwright";
import { createServer } from "vite";

const logger = console;
const artifactRoot = resolve("artifacts");
await mkdir(artifactRoot, { recursive: true });
const directory = await mkdtemp(join(artifactRoot, "subagent-browser-"));
if (dirname(directory) !== artifactRoot) throw new Error("验收清理目录越界");
let browser;
let server;

/*
 * ========================================================================
 * 步骤1：在真实浏览器加载右栏与离线详情端口
 * ========================================================================
 * 数据源：产品 Vue 组件、正式 Renderer 配置与本地固定回复。
 * 操作：1) 不启动模型或读取用户会话；2) 验证详情、失败、重试和状态撤回。
 */
logger.info("开始验证子智能体详情浏览器流程");
try {
	// 1.1 临时入口复用正式组件和 UI 插件，所有模型端口均为离线数据。
	await writeFile(
		join(directory, "index.html"),
		'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="app"></div><script type="module" src="/entry.ts"></script></html>',
	);
	await writeFile(
		join(directory, "entry.ts"),
		`
import "../../src/renderer/styles.css";
import ui from "@nuxt/ui/vue-plugin";
import { createApp, h, reactive } from "vue";
import { UApp } from "../../src/renderer/ui.ts";
import SubagentDetail from "../../src/renderer/components/SubagentDetail.vue";
const logger = console;
/*
 * ========================================================================
 * 步骤1：挂载离线右栏验收入口
 * ========================================================================
 * 数据源：固定任务、工具结果与可控失败。
 * 操作：1) 真实渲染；2) 不连接任何模型服务。
 */
logger.info("开始挂载右栏验收");
const snapshot = { kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: 1, runs: [{ id: "run", kind: "subagent", label: "worker", state: "running", children: [{ id: "step:0", kind: "step", label: "检查文件", agent: "worker", state: "running" }] }] };
const state = reactive({ snapshot, failed: false, status: "running" });
// 1.1 两个读取端口保持真实异步边界，完整转录缺失时使用官方消息窗口。
window.piDesktop = {
  async inspectSubagent() {
    if (state.failed) throw new Error("详情读取失败，请重试");
    return { kind: "pi-subagents.inspect-reply", version: 1, requestId: "fixture", asyncId: "run", childId: "step:0", status: state.status, task: "读取详情测试任务", resolvedModel: { provider: "offline", model: "fixture-model" }, messages: [{ role: "assistant", kind: "text", text: "正在检查文件" }, { role: "assistant", kind: "toolCall", name: "read", text: '{"path":"sample.ts"}' }, { role: "toolResult", kind: "text", text: "文件内容" }] };
  },
  async readSubagentTranscript() { return null; },
};
createApp({ setup() { return () => h(UApp, null, { default: () => h("main", { style: "width: 560px; height: 720px; display: flex; flex-direction: column; margin: 20px auto;" }, [
  h("nav", [h("button", { onClick: () => { state.failed = true; state.snapshot.runs[0].children[0].state = "paused"; } }, "模拟失败"), h("button", { onClick: () => { state.failed = false; state.status = "paused"; } }, "恢复服务"), h("button", { onClick: () => { state.snapshot = null; } }, "撤回状态")]),
  h(SubagentDetail, { snapshot: state.snapshot, runId: "run", childId: "step:0" }),
]) }); } }).use(ui).mount("#app");
logger.info("右栏验收挂载完成");
`,
		"utf8",
	);
	const { config } = await resolveConfig({}, "serve");
	if (!config?.renderer) throw new Error("Renderer 配置缺失");
	server = await createServer({
		...config.renderer,
		configFile: false,
		root: directory,
		server: { host: "127.0.0.1", port: 0, strictPort: true },
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("验收服务未监听");
	browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL });
	const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "networkidle" });
	// 1.2 有官方详情且没有完整文件时，右栏仍显示任务、模型和运行状态。
	await page.getByText("读取详情测试任务", { exact: true }).waitFor();
	assert.equal(await page.getByText("offline/fixture-model", { exact: true }).isVisible(), true);
	assert.equal(await page.getByText("运行中", { exact: true }).isVisible(), true);
	await page.getByRole("button", { name: /查阅.*sample\.ts/u }).click();
	await page.getByText("文件内容", { exact: true }).waitFor();
	await page.getByRole("button", { name: "模拟失败", exact: true }).click();
	await page.getByRole("alert").filter({ hasText: "详情读取失败，请重试" }).waitFor();
	assert.equal(await page.getByText("读取详情测试任务", { exact: true }).isVisible(), true);
	// 1.3 重试清除错误；状态撤回不隐藏已读取的对话。
	await page.getByRole("button", { name: "恢复服务", exact: true }).click();
	await page.getByRole("button", { name: "重试", exact: true }).click();
	await page.getByRole("alert").waitFor({ state: "detached" });
	await page.getByRole("button", { name: "撤回状态", exact: true }).click();
	assert.equal(await page.getByText("读取详情测试任务", { exact: true }).isVisible(), true);
	assert.equal(await page.getByText("已暂停", { exact: true }).isVisible(), true);
	await page.getByRole("button", { name: "已工作", exact: true }).click();
	assert.equal(await page.getByRole("button", { name: /查阅.*sample\.ts/u }).isVisible(), true);
	assert.deepEqual(errors, []);
	const screenshots = resolve("output/playwright");
	await mkdir(screenshots, { recursive: true });
	await page.screenshot({ path: join(screenshots, "subagent-details.png"), fullPage: true });
	logger.info(
		JSON.stringify({
			checks: [
				"inspection-without-transcript",
				"model-and-state",
				"tool-result-and-completed-turn-expansion",
				"partial-failure-preserves-content",
				"retry",
				"widget-retraction-preserves-content",
			],
			errors,
		}),
	);
} finally {
	await browser?.close();
	await server?.close();
	// 1.4 只清理本次创建的临时入口。
	await rm(directory, { recursive: true, force: true });
	logger.info("子智能体详情浏览器流程验证结束");
}
