import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `startup-${Date.now()}`);
const renderer = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
const failures = [];
const results = [];
let application;
let theme = "light";
let releaseWorkbench;

/*
 * ========================================================================
 * 步骤1：用本机页面闸门隔离真实启动时序
 * ========================================================================
 * 数据源：现有开发服务与独立空白 profile，不读取用户项目或认证。
 * 操作：1) 启动页照常加载；2) 测试明确放行后才加载工作台。
 */
logger.info("开始准备启动动画验收");
await mkdir(artifacts, { recursive: true });
// 1.1 只延后主页面，不修改产品就绪信号或加入测试专用启动分支。
const server = createServer((request, response) => {
	if (request.url === "/startup.html") {
		response.writeHead(302, { Location: `${renderer}/startup.html?theme=${theme}` }).end();
	} else if (request.url === "/") {
		releaseWorkbench = () => response.writeHead(302, { Location: `${renderer}/` }).end();
	} else {
		response.writeHead(404).end();
	}
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert(address && typeof address === "object");
logger.info("启动动画验收准备结束");

async function waitForPage(predicate) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		const page = application.windows().find((candidate) => predicate(candidate.url()));
		if (page) return page;
		await delay(50);
	}
	throw new Error("等待启动验收页面超时");
}

async function launch(nextTheme) {
	theme = nextTheme;
	releaseWorkbench = undefined;
	const profile = join(artifacts, nextTheme);
	const agent = join(profile, "agent");
	await mkdir(agent, { recursive: true });
	const environment = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		ANIAO_DEFAULT_PROVIDER_FILE: join(profile, "absent-provider.json"),
		ANIAO_UPDATE_URL: `http://127.0.0.1:${address.port}/updates/`,
		ELECTRON_RENDERER_URL: `http://127.0.0.1:${address.port}/`,
	};
	delete environment.ELECTRON_RUN_AS_NODE;
	application = await _electron.launch({
		executablePath: electronExecutable,
		args: [join(root, "dist/main/index.cjs"), `--user-data-dir=${profile}`],
		cwd: artifacts,
		env: environment,
		timeout: 60000,
	});
	const splash = await waitForPage((url) => url.includes("/startup.html"));
	splash.on("pageerror", (error) => failures.push(error.message));
	splash.on("console", (message) => {
		if (message.type() === "error") failures.push(message.text());
	});
	await splash.getByRole("button", { name: "关闭应用", exact: true }).waitFor();
	await splash.getByText("正在恢复工作区", { exact: true }).waitFor();
	return splash;
}

try {
	/*
	 * ========================================================================
	 * 步骤2：核对原生窗口、动态偏好与真实首屏交接
	 * ========================================================================
	 * 数据源：真实 Electron 页面、受限 preload 和系统媒体查询。
	 * 操作：1) 隐藏未就绪主窗；2) 检查减少动态效果后放行主页面。
	 */
	logger.info("开始验证启动动画与首屏交接");
	const splash = await launch("light");
	// 2.1 等本轮有限入场动画结束，截图保留真实窗口关闭控件。
	await splash.evaluate(async () => {
		await Promise.all(
			document
				.getAnimations()
				.filter((animation) => animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
				.map((animation) => animation.finished),
		);
	});
	await splash.screenshot({ path: join(artifacts, "native-light.png"), scale: "css" });
	const state = await splash.evaluate(() => ({
		width: innerWidth,
		height: innerHeight,
		dark: document.documentElement.classList.contains("dark"),
		bridge: Object.keys(window.harnessStartup).sort(),
		hasBusinessBridge: Boolean(window.piDesktop),
		hasNode: typeof window.require !== "undefined",
		animation: getComputedStyle(document.querySelector(".startup-mark")).animationName,
	}));
	const { height, ...startupState } = state;
	assert(Math.abs(height - 880) <= 2, `原生窗口高度超出 Windows 边框取整范围：${height}`);
	assert.deepEqual(startupState, {
		width: 1320,
		dark: false,
		bridge: ["close", "left", "ready", "subscribe"],
		hasBusinessBridge: false,
		hasNode: false,
		animation: "startup-arrive",
	});
	// 2.2 品牌在大窗口中占据足够面积，加载区跟随品牌，不再远离到窗口底部。
	const composition = await splash.evaluate(() => {
		const brand = document.querySelector(".startup-brand").getBoundingClientRect();
		const content = document.querySelector(".startup-content").getBoundingClientRect();
		const loading = document.querySelector(".startup-loading").getBoundingClientRect();
		return {
			brandWidth: brand.width,
			contentHeight: content.height,
			loadingGap: loading.top - brand.bottom,
			visible: content.top >= 0 && content.bottom <= innerHeight,
			centered: Math.abs(content.left + content.width / 2 - innerWidth / 2) < 1,
		};
	});
	assert(composition.brandWidth >= state.width * 0.2, "品牌仍沿用小启动窗口的比例");
	assert(composition.contentHeight >= state.height * 0.3, "启动主体高度不足");
	assert(composition.loadingGap > 0 && composition.loadingGap <= 64, "加载状态应紧随品牌展示");
	assert(composition.visible && composition.centered, "启动主体必须居中并完整显示");
	results.push("prominent centered brand with nearby loading state and no content clipping");
	// 2.3 启动页和隐藏的初始化窗口必须拥有相同外框，交接前后不改变窗口位置和大小。
	const bounds = await application.evaluate(({ BrowserWindow }) => {
		const windows = BrowserWindow.getAllWindows();
		return {
			splash: windows.find((window) => window.webContents.getURL().includes("/startup.html"))?.getBounds(),
			workbench: windows.find((window) => !window.webContents.getURL().includes("/startup.html"))?.getBounds(),
		};
	});
	assert(bounds.splash);
	assert.deepEqual(bounds.splash, bounds.workbench);
	const visibleBefore = await application.evaluate(
		({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
	);
	assert.equal(visibleBefore, 1);
	results.push(`${state.width}x${height} native splash matches initialization window bounds; isolated startup bridge`);
	// 2.4 媒体偏好在真实 Chromium 中禁用入场、进度和退场动画。
	await splash.emulateMedia({ reducedMotion: "reduce" });
	const motion = await splash.evaluate(() => ({
		mark: getComputedStyle(document.querySelector(".startup-mark")).animationName,
		track: getComputedStyle(document.querySelector(".startup-track span")).animationName,
		transition: getComputedStyle(document.querySelector(".startup")).transitionDuration,
	}));
	assert.deepEqual(motion, { mark: "none", track: "none", transition: "0s" });
	results.push("reduced motion removes arrival, progress and exit movement");
	assert(releaseWorkbench);
	const splashClosed = splash.waitForEvent("close");
	releaseWorkbench();
	const main = await waitForPage((url) => url === `${renderer}/`);
	await main.getByRole("heading", { name: "打开项目，开始工作" }).waitFor();
	await main.waitForFunction(() => typeof window.harnessWorkbenchReady === "function");
	await splashClosed;
	const visibleAfter = await application.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().map((window) => ({
			visible: window.isVisible(),
			url: window.webContents.getURL(),
			bounds: window.getBounds(),
		})),
	);
	assert.deepEqual(visibleAfter, [{ visible: true, url: `${renderer}/`, bounds: bounds.splash }]);
	results.push("real first-paint acknowledgement reveals workbench and destroys splash");
	await application.close();
	application = undefined;
	logger.info("启动动画与首屏交接验证结束");

	/*
	 * ========================================================================
	 * 步骤3：核对深色状态与启动中关闭
	 * ========================================================================
	 * 数据源：第二个独立 profile 和仍被闸门拦住的主页面。
	 * 操作：1) 检查深色样式；2) 用户关闭后不得再露出工作台。
	 */
	logger.info("开始验证深色启动与提前退出");
	const dark = await launch("dark");
	// 3.1 测试中开启减少动态效果，截图不依赖等待品牌动画时长。
	await dark.emulateMedia({ reducedMotion: "reduce" });
	assert.equal(await dark.evaluate(() => document.documentElement.classList.contains("dark")), true);
	await dark.screenshot({ path: join(artifacts, "native-dark.png"), scale: "css" });
	const closed = application.waitForEvent("close");
	await dark.getByRole("button", { name: "关闭应用", exact: true }).click();
	await closed;
	application = undefined;
	results.push("dark native splash close exits while main-page loading is pending");
	logger.info("深色启动与提前退出验证结束");
	assert.deepEqual(failures, []);
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, results, failures }, null, 2),
		"utf8",
	);
	logger.info(JSON.stringify({ passed: true, results, artifacts }));
} catch (error) {
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: false, results, failures, error: String(error) }, null, 2),
		"utf8",
	);
	throw error;
} finally {
	await application?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((done) => server.close(done));
}
