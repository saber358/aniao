import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserViewState, screenshotBrowser, startBrowserTest } from "./browser.mjs";

const logger = console;
const test = await startBrowserTest();
const { application, page, artifacts } = test;
const checks = [];
const measurements = [];

async function settleLayout() {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function width() {
	return page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().width);
}

async function measure(label) {
	await settleLayout();
	const geometry = await page.evaluate(() => ({
		window: innerWidth,
		sidebar: document.querySelector(".sidebar").getBoundingClientRect().width,
		main: document.querySelector(".main-workspace").getBoundingClientRect().width,
		conversation: document.querySelector(".conversation-column").getBoundingClientRect().width,
		right: document.querySelector(".side-panel")?.getBoundingClientRect().width,
		overflow: document.documentElement.scrollWidth > innerWidth,
		controls: document.querySelector(".workspace-splitter > [data-resize-handle]")?.getAttribute("aria-controls"),
	}));
	assert(!geometry.overflow, `${label}出现横向溢出`);
	assert.equal(geometry.controls, "workspace-sidebar", `${label}分隔条控制了主区`);
	measurements.push({ label, ...geometry });
	return geometry;
}

async function dragSidebar(delta, release = true) {
	const box = await page.locator(".workspace-splitter > [data-resize-handle]").boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 12 });
	if (release) {
		await page.mouse.up();
		await page.mouse.move(700, 100);
	}
	await settleLayout();
}

async function resizeWindow(windowWidth) {
	await application.evaluate(({ BrowserWindow }, size) => {
		BrowserWindow.getAllWindows()
			.find((window) => !window.webContents.getURL().includes("startup.html"))
			.setSize(size, 900);
	}, windowWidth);
	await page.waitForFunction((expected) => innerWidth === expected, windowWidth);
	await settleLayout();
}

/*
 * ========================================================================
 * 步骤1：验证拖拽方向、重开宽度和窗口缩放
 * ========================================================================
 * 数据源：真实 Electron、同一分栏实例与实际鼠标事件。
 * 操作：1) 重复收起展开后仍控制左栏；2) 窗口变化由主区吸收。
 */
logger.info("开始验证左侧栏拖拽与宽度保持");
try {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const identity = await page.locator(".main-workspace").evaluate((element) => {
		element.dataset.resizeIdentity = crypto.randomUUID();
		return element.dataset.resizeIdentity;
	});
	const sidebarIdentity = await page.locator(".sidebar").evaluate((element) => {
		element.dataset.resizeIdentity = crypto.randomUUID();
		return element.dataset.resizeIdentity;
	});
	const initial = await measure("initial");
	// 1.1 相同方向拖拽在收起前后应产生相同方向的尺寸变化。
	await dragSidebar(40);
	const expanded = await measure("drag-right");
	assert(Math.abs(expanded.sidebar - initial.sidebar - 40) < 3, "向右拖拽未按距离加宽");
	for (let index = 0; index < 4; index++) {
		const previous = await width();
		await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
		assert.equal(await page.locator(".sidebar").isVisible(), false);
		assert.equal(await page.locator(".workspace-splitter > [data-resize-handle]").isVisible(), false);
		await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
		const reopened = await measure(`reopened-${index}`);
		assert(Math.abs(reopened.sidebar - previous) < 2, "重新展开丢失了用户宽度");
		assert.equal(await page.locator(".main-workspace").getAttribute("data-resize-identity"), identity);
		assert.equal(await page.locator(".sidebar").getAttribute("data-resize-identity"), sidebarIdentity);
		await dragSidebar(-25);
		const smaller = await width();
		assert(Math.abs(previous - smaller - 25) < 3, "重开后向左拖拽方向异常");
		await dragSidebar(25);
		assert(Math.abs((await width()) - smaller - 25) < 3, "重开后向右拖拽方向异常");
	}
	checks.push("drag-follows-pointer-before-and-after-four-reopens", "reopen-preserves-width-and-main-instance");
	// 1.2 左栏使用像素宽度，主区吸收最大化、还原和最小窗口的宽度变化。
	const preferred = await width();
	for (const size of [1600, 1100, 1600, 1320]) {
		await resizeWindow(size);
		const geometry = await measure(`window-${size}`);
		assert(Math.abs(geometry.sidebar - preferred) < 3, "改变窗口尺寸时侧栏宽度漂移");
		assert(geometry.main >= 600, "主区宽度低于既有下限");
	}
	checks.push("pixel-width-stays-stable-across-window-resizes");
	// 1.3 极端鼠标位置与键盘 Home/End 都遵守既有宽度边界。
	await dragSidebar(500);
	assert(Math.abs((await width()) - 380) < 3, "左栏超过最大宽度");
	await dragSidebar(-700);
	assert(Math.abs((await width()) - 240) < 3, "左栏低于最小宽度");
	const handle = page.locator(".workspace-splitter > [data-resize-handle]");
	await handle.focus();
	await page.keyboard.press("End");
	await settleLayout();
	assert(Math.abs((await width()) - 380) < 3, `键盘无法增大左栏：${await width()}`);
	await page.keyboard.press("Home");
	await settleLayout();
	assert(Math.abs((await width()) - 240) < 3, "键盘无法缩小左栏");
	await dragSidebar(60);
	checks.push("pointer-and-keyboard-respect-width-limits");
	logger.info("左侧栏拖拽与宽度保持验证结束");

	/*
	 * ========================================================================
	 * 步骤2：右侧原生网页与左栏拖拽相互独立
	 * ========================================================================
	 * 数据源：真实 WebContentsView、网页输入与窄窗口布局。
	 * 操作：1) 拖拽期间让出鼠标，结束后恢复；2) 只改变尺寸，不重建网页。
	 */
	logger.info("开始验证左右面板拖拽与网页保持");
	await page.keyboard.press("Control+t");
	await page.getByRole("textbox", { name: "网址", exact: true }).fill(`${test.baseUrl}/one`);
	await page.getByRole("button", { name: "打开网页", exact: true }).click();
	await page.waitForFunction(() => document.querySelector(".browser-page-info")?.textContent.includes("本地网页预览"));
	const web = application.windows().find((candidate) => candidate.url() === `${test.baseUrl}/one`);
	assert(web);
	await web.locator("#draft").fill("左侧栏拖拽后保留网页输入");
	const webId = (await browserViewState(test)).find((view) => view.url === `${test.baseUrl}/one`).id;
	await resizeWindow(1100);
	await dragSidebar(400, false);
	await page.waitForFunction(() => document.body.classList.contains("resizing-side-panel"));
	await settleLayout();
	assert(!(await browserViewState(test)).find((view) => view.id === webId).visible, "原生网页未让出拖拽区域");
	// 2.1 即使鼠标经过原生网页区域，松开后也必须释放拖拽状态。
	await page.mouse.move(1000, 500, { steps: 8 });
	await page.mouse.up();
	await page.mouse.move(700, 100);
	await page.waitForFunction(() => !document.body.classList.contains("resizing-side-panel"));
	await settleLayout();
	const narrow = await measure("narrow-with-browser");
	assert(narrow.conversation >= 318, "左栏拉宽后右栏挤占了对话区");
	assert((await browserViewState(test)).find((view) => view.id === webId).visible, "拖拽结束后网页未恢复");
	assert.equal(await web.locator("#draft").inputValue(), "左侧栏拖拽后保留网页输入");
	for (let index = 0; index < 3; index++) {
		await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
		await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
		await dragSidebar(-20);
		await dragSidebar(20);
	}
	assert.equal(await web.locator("#draft").inputValue(), "左侧栏拖拽后保留网页输入");
	assert((await browserViewState(test)).find((view) => view.id === webId).visible);
	checks.push(
		"native-page-yields-during-left-drag-and-returns",
		"narrow-workspace-keeps-conversation-space",
		"browser-state-survives-repeated-left-resizes",
	);
	// 2.2 隐藏工作区时产生的零宽度不能覆盖左右栏的既有尺寸。
	const beforeSettings = await measure("before-settings");
	await page.keyboard.press("Control+,");
	await page.locator(".settings-page").waitFor({ state: "visible" });
	await settleLayout();
	await resizeWindow(1600);
	await page.getByRole("button", { name: "返回工作区", exact: true }).click();
	const afterSettings = await measure("after-settings-window-resize");
	assert(Math.abs(afterSettings.sidebar - beforeSettings.sidebar) < 3, "设置页返回后左栏宽度漂移");
	assert(Math.abs(afterSettings.right - beforeSettings.right) < 1, "隐藏工作区时右栏被缩窄");
	checks.push("hidden-workspace-resize-preserves-both-panel-widths");
	await resizeWindow(1600);
	await screenshotBrowser(test, "sidebar-resize-light");
	await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
	await dragSidebar(-30);
	await dragSidebar(30);
	await measure("dark-with-browser");
	await screenshotBrowser(test, "sidebar-resize-dark");
	checks.push("light-and-dark-resizing");
	assert.deepEqual(test.errors, []);
	await writeFile(
		join(artifacts, "sidebar-resize-results.json"),
		JSON.stringify({ passed: true, checks, measurements }, null, 2),
	);
	logger.info(JSON.stringify({ passed: true, checks, artifacts }));
	logger.info("左右面板拖拽与网页保持验证结束");
} catch (error) {
	await page.screenshot({ path: join(artifacts, "sidebar-resize-failure.png"), scale: "css" }).catch(() => {});
	await writeFile(
		join(artifacts, "sidebar-resize-results.json"),
		JSON.stringify({ passed: false, checks, measurements, error: String(error) }, null, 2),
	);
	throw error;
} finally {
	await test.close();
	logger.info("左侧栏宽度验收结束");
}
