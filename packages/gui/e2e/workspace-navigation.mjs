import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import electronExecutable from "electron";
import { _electron } from "playwright";
import { browserViewState, screenshotBrowser } from "./browser.mjs";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `navigation-${Date.now()}`);
const projects = [join(artifacts, "项目甲"), join(artifacts, "项目乙")];
const agent = join(artifacts, "agent");
const profile = join(artifacts, "profile");
const renderer = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
const packagedExecutable = process.env.PI_GUI_PACKAGED_EXECUTABLE;
const executablePath = packagedExecutable ?? electronExecutable;
const launchDirectory = packagedExecutable ? dirname(packagedExecutable) : root;
const failures = [];
const checks = [];
const selectionTraces = [];
let application;
let page;

function isWorkbench(candidate) {
	return (
		candidate.url().startsWith(packagedExecutable ? "file:" : renderer) && !candidate.url().includes("startup.html")
	);
}

/*
 * ========================================================================
 * 步骤1：准备独立会话和可保留输入的本机网页
 * ========================================================================
 * 数据源：临时项目、无效离线模型配置与本机 HTTP，不访问真实账号。
 * 操作：1) 不发送模型请求；2) 验证导航和原生浏览器状态保持。
 */
logger.info("开始准备工作区导航验收");
await Promise.all([...projects, agent, profile].map((path) => mkdir(path, { recursive: true })));
await writeFile(join(projects[0], "说明.md"), "# 保留文件预览\n\n左侧栏切换后内容仍在。\n");
await writeFile(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			"navigation-offline": {
				baseUrl: "http://127.0.0.1:65534/v1",
				api: "openai-completions",
				apiKey: "offline-fixture",
				models: [{ id: "fixture", name: "离线导航验收" }],
			},
		},
	}),
);
await writeFile(
	join(agent, "settings.json"),
	JSON.stringify({ defaultProvider: "navigation-offline", defaultModel: "fixture" }),
);
// 1.2 用 SDK 保存真实历史，覆盖应用重启后未打开工作区的名称写入。
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
let savedHistoryPath;
process.env.PI_CODING_AGENT_DIR = agent;
try {
	const manager = SessionManager.create(projects[1]);
	manager.appendMessage({ role: "user", content: "本机历史记录，无模型请求。", timestamp: Date.now() });
	manager.appendSessionInfo("乙会话1");
	savedHistoryPath = manager.getSessionFile();
} finally {
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
}
const server = createServer((_request, response) =>
	response
		.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
		.end(
			'<!doctype html><meta charset="utf-8"><title>导航状态验收</title><style>body{font:16px system-ui;padding:24px}input{padding:10px;width:260px}</style><h1>本机状态页面</h1><label>保留输入 <input aria-label="保留输入"></label>',
		),
);
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert(address && typeof address === "object");
const website = `http://127.0.0.1:${address.port}/`;

async function poll(check, message, timeout = 30000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(50);
	}
	throw new Error(message);
}

async function sidebarAppearance() {
	await page.mouse.move(900, 700);
	await poll(async () => (await page.locator(".sidebar").getAttribute("aria-busy")) !== "true", "会话切换未结束");
	return page.locator(".workspace-node").evaluateAll((projects) => {
		const measure = (element) => {
			element.dataset.selectionIdentity ??= crypto.randomUUID();
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return {
				identity: element.dataset.selectionIdentity,
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
				styles: Object.fromEntries(
					[
						"font-family",
						"font-size",
						"font-weight",
						"font-style",
						"line-height",
						"letter-spacing",
						"color",
						"text-align",
						"text-indent",
						"padding",
						"margin",
						"border-width",
						"border-radius",
						"display",
						"visibility",
						"opacity",
						"gap",
						"mask-image",
					].map((name) => [name, style.getPropertyValue(name)]),
				),
			};
		};
		return {
			appearance: projects.map((project) => ({
				cwd: project.dataset.workspace,
				project: [
					".project-row",
					".project-open",
					".project-name",
					".project-folder",
					".project-chevron",
					".project-actions",
				].map((selector) => measure(project.querySelector(selector))),
				sessions: [...project.querySelectorAll(".session-row")].map((row) => ({
					id: row.dataset.session,
					parts: [
						row,
						...row.querySelectorAll(".session-open, .session-name, .session-time, button[aria-label^='会话操作']"),
					].map(measure),
				})),
			})),
			backgrounds: projects.map((project) => ({
				project: getComputedStyle(project.querySelector(".project-row")).backgroundColor,
				sessions: [...project.querySelectorAll(".session-row")].map((row) => getComputedStyle(row).backgroundColor),
			})),
		};
	});
}

async function selectWithoutFlash(title) {
	await sidebarAppearance();
	await page.evaluate(() => {
		const sidebar = document.querySelector(".sidebar");
		const nodes = [...sidebar.querySelectorAll(".project-row, .session-row, .project-open, .session-open")];
		const appearance = (node) => {
			const style = getComputedStyle(node);
			return [style.opacity, style.fontSize, style.fontWeight, style.lineHeight, style.color];
		};
		const baseline = nodes.map(appearance);
		const failures = [];
		let frames = 0;
		let animation;
		const capture = () => {
			frames++;
			const current = [
				...document.querySelectorAll(
					".workspace-tree .project-row, .workspace-tree .session-row, .workspace-tree .project-open, .workspace-tree .session-open",
				),
			];
			if (current.length !== nodes.length || current.some((node, index) => node !== nodes[index]))
				failures.push("会话行被移除或重建");
			if (nodes.some((node, index) => JSON.stringify(appearance(node)) !== JSON.stringify(baseline[index])))
				failures.push("字体或透明度短暂改变");
			if (sidebar.querySelectorAll(".session-row.active").length !== 1) failures.push("选中会话短暂清空");
			if (
				[...sidebar.querySelectorAll(".project-row")].some(
					(node) => getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)",
				)
			)
				failures.push("工作区出现选中背景");
		};
		const observer = new MutationObserver(capture);
		observer.observe(sidebar, { subtree: true, childList: true, attributes: true });
		const frame = () => {
			capture();
			animation = requestAnimationFrame(frame);
		};
		frame();
		window.sidebarSelectionTrace = () => {
			capture();
			observer.disconnect();
			cancelAnimationFrame(animation);
			return { frames, failures: [...new Set(failures)] };
		};
	});
	await page.locator(".session-open").filter({ hasText: title }).click();
	await page.getByRole("heading", { name: title, exact: true }).waitFor();
	await sidebarAppearance();
	const trace = await page.evaluate(() => window.sidebarSelectionTrace());
	selectionTraces.push({ title, ...trace });
	assert.deepEqual(trace.failures, [], `${title}切换过程中侧栏闪烁`);
}

try {
	const environment = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		ANIAO_DEFAULT_PROVIDER_FILE: join(artifacts, "absent.json"),
		ANIAO_UPDATE_URL: `${website}updates/`,
		ELECTRON_RENDERER_URL: renderer,
	};
	if (packagedExecutable) delete environment.ELECTRON_RENDERER_URL;
	for (const key of ["ELECTRON_RUN_AS_NODE", "PI_PACKAGE_DIR", "NODE_OPTIONS", "NODE_PATH"]) delete environment[key];
	application = await _electron.launch({
		executablePath,
		args: [...(packagedExecutable ? [] : [join(root, "dist/main/index.cjs")]), `--user-data-dir=${profile}`],
		cwd: launchDirectory,
		env: environment,
		timeout: 60000,
	});
	const log = createWriteStream(join(artifacts, "electron.log"));
	application.process().stdout.pipe(log, { end: false });
	application.process().stderr.pipe(log, { end: false });
	application.process().once("exit", () => log.end());
	await poll(
		async () => {
			page = application.windows().find(isWorkbench);
			return Boolean(page);
		},
		"未找到工作台",
		60000,
	);
	page.on("pageerror", (error) => failures.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" || (message.type() === "warning" && message.text().startsWith("[Vue warn]")))
			failures.push(message.text().slice(0, 300));
	});
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).waitFor();
	await application.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()
			.find((window) => !window.webContents.getURL().includes("startup.html"))
			.setSize(1600, 1000);
	});
	for (const [projectIndex, cwd] of projects.entries()) {
		// 1.1 通过正常目录选择建立项目，并保存多个无模型请求的命名会话。
		await application.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, cwd);
		await page.getByRole("button", { name: "打开项目", exact: true }).first().click();
		await poll(async () => {
			const value = await page.evaluate(() => window.piDesktop.getSnapshot());
			return value?.cwd.replaceAll("\\", "/") === cwd.replaceAll("\\", "/") && value.run.phase === "idle";
		}, "项目未就绪");
		for (let index = 0; index < (projectIndex === 0 ? 5 : 2); index++) {
			if (index > 0) await page.evaluate(() => window.piDesktop.newSession());
			const current = await page.evaluate(() => window.piDesktop.getSnapshot());
			const title = `${projectIndex === 0 ? "甲" : "乙"}会话${index + 1}`;
			await page.evaluate(({ sessionId, title }) => window.piDesktop.updateSession({ sessionId, title }), {
				sessionId: current.sessionId,
				title,
			});
		}
	}
	await poll(
		async () => (await page.locator(".workspace-node").first().locator(".session-row").count()) === 5,
		"非当前工作区未显示全部五个会话",
	);
	assert.equal(await page.getByText(/查看全部.*个会话/).count(), 0);
	checks.push("all-project-sessions-visible-without-view-all");

	/*
	 * ========================================================================
	 * 步骤2：验证点击会话只改变选中背景
	 * ========================================================================
	 * 数据源：真实 SDK、持久化索引和侧栏 DOM 顺序。
	 * 操作：1) 深浅主题核对字号、几何、图标和节点身份；2) 重载恢复后保持相同顺序。
	 */
	logger.info("开始核对稳定会话顺序");
	const before = await page.evaluate(() => window.piDesktop.getProjects());
	const order = before.map((project) => ({
		cwd: project.cwd,
		sessions: project.sessions.map((session) => session.id),
	}));
	// 2.1 跨工作区切换前后，除背景之外的字形、布局和节点身份必须一致。
	const lightBefore = await sidebarAppearance();
	await page.locator(".sidebar").screenshot({ path: join(artifacts, "sidebar-light-before.png"), scale: "css" });
	await selectWithoutFlash("甲会话1");
	const lightAfter = await sidebarAppearance();
	assert.deepEqual(lightAfter.appearance, lightBefore.appearance, "跨工作区选择改变了文字、布局或图标");
	assert.notDeepEqual(lightAfter.backgrounds, lightBefore.backgrounds, "选中背景未更新");
	await page.locator(".sidebar").screenshot({ path: join(artifacts, "sidebar-light-after.png"), scale: "css" });
	await poll(
		async () =>
			JSON.stringify(
				await page.evaluate(async () =>
					(await window.piDesktop.getProjects()).map((project) => ({
						cwd: project.cwd,
						sessions: project.sessions.map((session) => session.id),
					})),
				),
			) === JSON.stringify(order),
		"跨项目选择改变顺序",
	);
	assert.deepEqual(await page.locator(".project-name").allTextContents(), ["项目甲", "项目乙"]);
	const activeOrder = await page.locator(".session-list .session-name").allTextContents();
	await selectWithoutFlash("甲会话3");
	assert.deepEqual(await page.locator(".session-list .session-name").allTextContents(), activeOrder);
	const sameProject = await sidebarAppearance();
	assert.deepEqual(sameProject.appearance, lightAfter.appearance, "同工作区选择改变了文字或布局");
	assert.notDeepEqual(sameProject.backgrounds, lightAfter.backgrounds, "同工作区选中背景未更新");
	// 2.2 深色主题重复跨项目和同项目选择，不能依赖浅色主题的偶然样式。
	await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
	const darkBefore = await sidebarAppearance();
	await page.locator(".sidebar").screenshot({ path: join(artifacts, "sidebar-dark-before.png"), scale: "css" });
	await selectWithoutFlash("乙会话1");
	const darkAfter = await sidebarAppearance();
	assert.deepEqual(darkAfter.appearance, darkBefore.appearance, "深色跨工作区选择改变了文字或布局");
	assert.notDeepEqual(darkAfter.backgrounds, darkBefore.backgrounds, "深色选中背景未更新");
	await page.locator(".sidebar").screenshot({ path: join(artifacts, "sidebar-dark-after.png"), scale: "css" });
	await selectWithoutFlash("乙会话2");
	assert.deepEqual((await sidebarAppearance()).appearance, darkAfter.appearance, "深色同工作区选择改变了文字或布局");
	await selectWithoutFlash("甲会话3");
	await page.getByRole("button", { name: "切换浅色主题", exact: true }).click();
	checks.push("selection-only-changes-background-light", "selection-only-changes-background-dark");
	await writeFile(
		join(artifacts, "sidebar-appearance.json"),
		JSON.stringify({ lightBefore, lightAfter, sameProject, darkBefore, darkAfter }, null, 2),
	);
	await page.reload();
	await page.getByRole("heading", { name: "甲会话3", exact: true }).waitFor();
	assert.deepEqual(await page.locator(".project-name").allTextContents(), ["项目甲", "项目乙"]);
	assert.deepEqual(await page.locator(".session-list .session-name").allTextContents(), activeOrder);
	assert.equal(await page.getByRole("button", { name: "打开变更", exact: true }).count(), 0);
	checks.push("project-and-session-order-stable", "reload-preserves-order", "no-top-changes-button");
	checks.push("no-workspace-selected-background", "no-sidebar-flash-during-navigation");
	await writeFile(join(artifacts, "selection-frames.json"), JSON.stringify(selectionTraces, null, 2));
	logger.info("稳定会话顺序核对结束");

	/*
	 * ========================================================================
	 * 步骤5：验证其他工作区会话菜单可用
	 * ========================================================================
	 * 数据源：真实菜单、SDK 历史和桌面索引。
	 * 操作：1) 重命名、置顶和归档都不切换当前会话；2) 取消操作保留列表顺序。
	 */
	logger.info("开始核对其他工作区会话菜单");
	const activeIdentity = (await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId;
	await page.getByRole("button", { name: "会话操作：乙会话1", exact: true }).click();
	await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
	await page.locator("#session-title").fill("乙工作区改名验收");
	await page.getByRole("button", { name: "保存名称", exact: true }).click();
	await page.getByRole("heading", { name: "重命名会话", exact: true }).waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "会话操作：乙工作区改名验收", exact: true }).click();
	await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
	await poll(
		async () =>
			(await page.locator(".workspace-node").nth(1).locator(".session-name").first().textContent()) ===
			"乙工作区改名验收",
		"其他工作区置顶未生效",
	);
	await page.getByRole("button", { name: "会话操作：乙工作区改名验收", exact: true }).click();
	await page.getByRole("menuitem", { name: "取消置顶", exact: true }).click();
	await poll(
		async () => !(await page.locator(".workspace-node").nth(1).locator(".pin-indicator").count()),
		"取消置顶未生效",
	);
	await page.getByRole("button", { name: "会话操作：乙工作区改名验收", exact: true }).click();
	await page.getByRole("menuitem", { name: "归档", exact: true }).click();
	await page.getByRole("button", { name: "会话操作：乙工作区改名验收", exact: true }).waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "工作区选项", exact: true }).click();
	await page.getByRole("menuitem", { name: "显示已归档会话", exact: true }).click();
	await page.getByRole("button", { name: "会话操作：乙工作区改名验收", exact: true }).click();
	await page.getByRole("menuitem", { name: "取消归档", exact: true }).click();
	await page.getByRole("button", { name: "会话操作：乙工作区改名验收", exact: true }).waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "工作区选项", exact: true }).click();
	await page.getByRole("menuitem", { name: "显示最近会话", exact: true }).click();
	await page.getByRole("button", { name: "会话操作：乙工作区改名验收", exact: true }).waitFor();
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, activeIdentity);
	checks.push("other-workspace-rename-pin-and-archive", "session-actions-preserve-active-session");
	logger.info("其他工作区会话菜单核对结束");

	/*
	 * ========================================================================
	 * 步骤3：左栏切换保持右栏文件、终端和原生网页
	 * ========================================================================
	 * 数据源：右侧标签、文件预览内容、真实 PTY 和网页输入值。
	 * 操作：1) 核对组件和原生页面未重建；2) 侧栏按钮只改变布局。
	 */
	logger.info("开始核对左右侧栏独立");
	await page.getByRole("button", { name: "展开右侧面板", exact: true }).click();
	await page.locator(".side-tool").filter({ hasText: "变更" }).click();
	await page.getByRole("tab", { name: /^变更/ }).waitFor();
	await page.getByRole("button", { name: "打开开始页", exact: true }).click();
	await page.locator(".side-view:visible .side-tool").filter({ hasText: "工作区文件" }).click();
	await page.locator(".file-row").filter({ hasText: "说明.md" }).click();
	await page.getByText("左侧栏切换后内容仍在。", { exact: false }).waitFor();
	const panelIdentity = await page.locator(".side-panel").evaluate((element) => {
		element.dataset.navigationIdentity = crypto.randomUUID();
		return element.dataset.navigationIdentity;
	});
	await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
	assert.equal(await page.locator(".side-panel").getAttribute("data-navigation-identity"), panelIdentity);
	assert(await page.locator(".file-preview pre").isVisible());
	await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
	assert.equal(await page.locator(".side-panel").getAttribute("data-navigation-identity"), panelIdentity);
	assert(await page.locator(".file-preview pre").isVisible());
	await page.keyboard.press("Control+`");
	await page.locator(".terminal-panel").waitFor({ state: "visible" });
	const terminalIdentity = await page.locator(".terminal-panel:visible").evaluate((element) => {
		element.dataset.terminalIdentity = crypto.randomUUID();
		return element.dataset.terminalIdentity;
	});
	await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
	await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
	assert.equal(await page.locator(".terminal-panel:visible").getAttribute("data-terminal-identity"), terminalIdentity);
	await page.keyboard.press("Control+t");
	await page.getByRole("textbox", { name: "网址", exact: true }).fill(website);
	await page.getByRole("button", { name: "打开网页", exact: true }).click();
	let web;
	await poll(async () => {
		web = application.windows().find((candidate) => candidate.url() === website);
		return Boolean(web);
	}, "本机网页未打开");
	await web.getByRole("textbox", { name: "保留输入", exact: true }).fill("原生页面状态保留");
	const webContentsId = await application.evaluate(
		({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url).id,
		website,
	);
	for (let index = 0; index < 3; index++) {
		await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
		await poll(
			async () => (await browserViewState({ application })).some((view) => view.id === webContentsId && view.visible),
			"收起左侧栏后原生网页消失",
		);
		await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
		await poll(
			async () => (await browserViewState({ application })).some((view) => view.id === webContentsId && view.visible),
			"展开左侧栏后原生网页消失",
		);
	}
	assert.equal(await web.getByRole("textbox", { name: "保留输入", exact: true }).inputValue(), "原生页面状态保留");
	assert.equal(
		await application.evaluate(
			({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url).id,
			website,
		),
		webContentsId,
	);
	await screenshotBrowser({ application, artifacts }, "sidebar-browser-retained");
	checks.push(
		"changes-from-side-panel",
		"file-preview-preserved",
		"terminal-instance-preserved",
		"native-browser-id-and-input-preserved",
		"native-browser-stays-visible-on-sidebar-toggle",
	);
	logger.info("左右侧栏独立核对结束");

	/*
	 * ========================================================================
	 * 步骤4：所有设置分类使用同一居中宽度
	 * ========================================================================
	 * 数据源：实际窗口内的设置内容边界与多分类页面。
	 * 操作：1) 测量左右间距；2) 长表单可滚动，最小窗口无横向溢出。
	 */
	logger.info("开始核对设置内容居中与宽度");
	await page.keyboard.press("Control+,");
	await page.locator(".settings-page").waitFor({ state: "visible" });
	const settings = [];
	for (const label of [
		"账号与余额",
		"通用设置",
		"模型",
		"MCP 服务器",
		"技能",
		"插件",
		"Agent 预设",
		"使用统计",
		"归档管理",
	]) {
		await page
			.getByRole("navigation", { name: "设置分类", exact: true })
			.getByRole("button", { name: label, exact: true })
			.click();
		const geometry = await page.locator(".settings-content").evaluate((element) => {
			const outer = element.getBoundingClientRect();
			const inner = element.querySelector(".settings-section, .data-settings").getBoundingClientRect();
			return {
				width: inner.width,
				centerOffset: Math.abs(outer.x + outer.width / 2 - inner.x - inner.width / 2),
				available: outer.width,
			};
		});
		assert(geometry.centerOffset < 2, `${label}偏离右侧中心线`);
		assert(geometry.width > 300 && geometry.width <= 832, `${label}没有采用统一宽度`);
		if (settings.length) assert(Math.abs(geometry.width - settings[0].width) < 1, `${label}与其他分类宽度不同`);
		settings.push({ label, ...geometry });
	}
	await page.getByRole("button", { name: "模型", exact: true }).click();
	await page.getByRole("button", { name: "添加模型提供商", exact: true }).click();
	await page.getByRole("button", { name: "自定义 API", exact: true }).click();
	await page.screenshot({ path: join(artifacts, "settings-wide.png"), scale: "css" });
	await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
	await page.screenshot({ path: join(artifacts, "settings-dark.png"), scale: "css" });
	await application.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()
			.find((window) => !window.webContents.getURL().includes("startup.html"))
			.setSize(1100, 720);
	});
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await page.screenshot({ path: join(artifacts, "settings-minimum.png"), scale: "css" });
	await page.getByRole("button", { name: "返回工作区", exact: true }).click();
	assert.equal(await web.getByRole("textbox", { name: "保留输入", exact: true }).inputValue(), "原生页面状态保留");
	checks.push(
		"settings-right-column-centered",
		"all-settings-share-content-width",
		"settings-long-form-and-minimum-window",
	);
	logger.info("设置内容居中与宽度核对结束");

	/*
	 * ========================================================================
	 * 步骤6：重启后操作尚未打开的历史工作区
	 * ========================================================================
	 * 数据源：相同独立 profile、实际 SDK JSONL 与保留宿主数量。
	 * 操作：1) 跨项目更新原生名称；2) 不创建宿主，不切换当前会话。
	 */
	logger.info("开始核对未打开历史工作区操作");
	await application.close();
	application = await _electron.launch({
		executablePath,
		args: [...(packagedExecutable ? [] : [join(root, "dist/main/index.cjs")]), `--user-data-dir=${profile}`],
		cwd: launchDirectory,
		env: environment,
		timeout: 60000,
	});
	const restartedLog = createWriteStream(join(artifacts, "electron-restarted.log"));
	application.process().stdout.pipe(restartedLog, { end: false });
	application.process().stderr.pipe(restartedLog, { end: false });
	application.process().once("exit", () => restartedLog.end());
	await poll(
		async () => {
			page = application.windows().find(isWorkbench);
			return Boolean(page);
		},
		"重启后未找到工作台",
		60000,
	);
	page.on("pageerror", (error) => failures.push(error.message));
	await page.getByRole("heading", { name: "甲会话3", exact: true }).waitFor();
	await page.getByRole("button", { name: "会话操作：乙工作区改名验收", exact: true }).waitFor();
	await poll(
		async () => (await page.evaluate(() => window.piDesktop.getSnapshot())).run.phase === "idle",
		"重启会话未就绪",
	);
	assert.equal((await page.evaluate(() => window.piDesktop.getSessionRuntimes())).length, 1);
	await page.getByRole("button", { name: "会话操作：乙工作区改名验收", exact: true }).click();
	await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
	await page.locator("#session-title").fill("乙重启后改名");
	await page.getByRole("button", { name: "保存名称", exact: true }).click();
	await page.getByRole("heading", { name: "重命名会话", exact: true }).waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "会话操作：乙重启后改名", exact: true }).waitFor();
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, activeIdentity);
	assert.equal((await page.evaluate(() => window.piDesktop.getSessionRuntimes())).length, 1);
	const savedEntries = (await readFile(savedHistoryPath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(savedEntries.filter((entry) => entry.type === "session_info").at(-1).name, "乙重启后改名");
	await page.locator(".sidebar").screenshot({ path: join(artifacts, "sidebar-restarted.png"), scale: "css" });
	checks.push("unopened-workspace-native-rename-after-restart", "historical-actions-create-no-host");
	logger.info("未打开历史工作区操作核对结束");
	assert.deepEqual(failures, []);
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, checks, settings, failures }, null, 2),
	);
	logger.info(JSON.stringify({ passed: true, checks, artifacts }));
} catch (error) {
	await page?.screenshot({ path: join(artifacts, "failure.png"), scale: "css" }).catch(() => {});
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: false, checks, failures, error: String(error) }, null, 2),
	);
	throw error;
} finally {
	await application?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((done) => server.close(done));
	logger.info("工作区导航验收结束");
}
