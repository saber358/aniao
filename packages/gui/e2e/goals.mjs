import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveConfig } from "electron-vite";
import { chromium } from "playwright";
import { createServer } from "vite";

const logger = console;
const artifactRoot = resolve("artifacts");
await mkdir(artifactRoot, { recursive: true });
const directory = await mkdtemp(join(artifactRoot, "goal-browser-"));
if (dirname(directory) !== artifactRoot) throw new Error("目标验收清理目录越界");
let browser;
let server;

/*
 * ========================================================================
 * 步骤1：加载真实目标栏与隔离端口
 * ========================================================================
 * 数据源：正式 Renderer 配置、GoalBar 和固定会话数据。
 * 操作：1) 检查启动和同项目切换；2) 不调用模型或读取用户目标。
 */
logger.info("开始目标栏浏览器验收");
try {
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
import GoalBar from "../../src/renderer/components/GoalBar.vue";
const logger = console;
/*
 * ========================================================================
 * 步骤1：挂载目标栏隔离验收入口
 * ========================================================================
 * 数据源：两个同项目会话和可控操作承诺。
 * 操作：1) 一个会话有目标，另一个无目标；2) 控制确认完成前不释放按钮。
 */
logger.info("开始挂载目标验收视图");
const state = reactive({ sessionId: "bound", generation: "host-1", status: "running", failed: false });
let finish;
window.piDesktop = { async readGoals(request) {
  if (state.failed) throw new Error("目标读取失败，请重试");
  return { generatedAt: Date.now(), goals: request.sessionId === "bound" ? [{ id: "goal-1", title: "绑定会话的目标", objective: "只在当前绑定会话显示", status: state.status, autoContinue: true, sisyphus: false, auditor: false, usage: { tokensUsed: 1200, activeSeconds: 60 }, tasks: [{ id: "t1", title: "检查会话隔离", status: "pending", depth: 0, current: true }], truncated: true }] : [] };
} };
const control = () => new Promise(resolve => { finish = resolve; });
// 1.1 控制区只改变测试状态，不操作真实项目或目标。
createApp({ setup() { return () => h(UApp, null, { default: () => h("main", { style: "width: 720px; padding: 20px; margin: auto;" }, [
  h("nav", [
    h("button", { onClick: () => { state.sessionId = "unbound"; } }, "无目标会话"),
    h("button", { onClick: () => { state.sessionId = "bound"; } }, "有目标会话"),
    h("button", { onClick: () => { finish?.(true); } }, "取消确认"),
    h("button", { onClick: () => { state.failed = true; state.generation = "host-2"; } }, "模拟故障"),
    h("button", { onClick: () => { state.failed = false; } }, "恢复服务"),
    h("button", { onClick: () => { state.status = "complete"; state.generation = "host-3"; } }, "目标完成"),
  ]),
  h(GoalBar, { cwd: "C:/same-project", sessionId: state.sessionId, generation: state.generation, control }),
]) }); } }).use(ui).mount("#app");
logger.info("目标验收视图挂载完成");
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
	if (!address || typeof address === "string") throw new Error("目标验收服务未监听");
	browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL });
	const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "networkidle" });
	// 1.2 首次恢复已有目标立即显示；同项目另一会话没有目标就不显示。
	await page.getByText("绑定会话的目标", { exact: true }).waitFor();
	await page.getByRole("button", { name: "无目标会话", exact: true }).click();
	await page.getByRole("region", { name: "目标进度" }).waitFor({ state: "detached" });
	await page.getByRole("button", { name: "有目标会话", exact: true }).click();
	await page.getByText("绑定会话的目标", { exact: true }).waitFor();
	// 1.3 用浏览器虚拟时钟覆盖多轮轮询，归档确认未结束时按钮保持禁用。
	await page.clock.install();
	await page.getByRole("button", { name: "删除目标", exact: true }).click();
	await page.clock.runFor(12500);
	assert.equal(await page.getByRole("button", { name: "删除目标", exact: true }).isDisabled(), true);
	await page.getByRole("button", { name: "取消确认", exact: true }).click();
	await page.waitForFunction(() => !document.querySelector('[aria-label="删除目标"]')?.disabled);
	// 1.4 读取失败显示明确提示，重试成功后恢复目标。
	await page.getByRole("button", { name: "模拟故障", exact: true }).click();
	await page.getByRole("alert").filter({ hasText: "目标读取失败" }).waitFor();
	await page.getByRole("button", { name: "恢复服务", exact: true }).click();
	await page.getByRole("button", { name: "重试", exact: true }).click();
	await page.getByRole("alert").waitFor({ state: "detached" });
	await page.getByText("绑定会话的目标", { exact: true }).waitFor();
	// 1.5 完成态不显示继续按钮，展开后显示长内容提示。
	await page.getByRole("button", { name: "目标完成", exact: true }).click();
	await page.getByText("已完成", { exact: true }).waitFor();
	assert.equal(await page.getByRole("button", { name: "继续目标", exact: true }).count(), 0);
	await page.locator(".goal-summary").click();
	await page.getByText("内容较长，当前展示部分信息。完整内容保存在目标插件中。", { exact: true }).waitFor();
	assert.deepEqual(errors, []);
	const screenshots = resolve("output/playwright");
	await mkdir(screenshots, { recursive: true });
	await page.screenshot({ path: join(screenshots, "goal-session-isolation.png"), fullPage: true });
	logger.info(
		JSON.stringify({
			checks: [
				"startup-bound-goal",
				"same-project-unbound-session",
				"return-to-bound-session",
				"confirmation-busy-across-polls",
				"read-error-and-retry",
				"complete-without-resume",
				"truncation-notice",
			],
			errors,
		}),
	);
} finally {
	await browser?.close();
	await server?.close();
	// 1.6 仅清理本次创建的验收入口。
	await rm(directory, { recursive: true, force: true });
	logger.info("目标栏浏览器验收结束");
}
