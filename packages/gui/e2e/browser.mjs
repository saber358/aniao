import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const logger = console;
const runtime = typeof process === "undefined" ? undefined : process;
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const { _electron } = require("playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/*
 * ========================================================================
 * 步骤1：准备不允许 iframe 嵌入的离线网页与独立桌面
 * ========================================================================
 * 数据源：本机 HTTP 服务、独立项目和无效测试认证。
 * 操作：1) 验证真实原生浏览器；2) 不使用用户账号、剪贴板和外部网络。
 */
export async function startBrowserTest(options = {}) {
	logger.info("开始准备内置浏览器验收");
	const artifacts = join(root, "artifacts", `browser-${Date.now()}`);
	const project = join(artifacts, "中文 项目");
	const agent = join(artifacts, "agent");
	await Promise.all([project, agent].map((path) => mkdir(path, { recursive: true })));
	await writeFile(join(project, "README.md"), "browser fixture\n", "utf8");
	await writeFile(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				"browser-offline": {
					baseUrl: "http://127.0.0.1:65534/v1",
					api: "openai-completions",
					apiKey: "offline-browser-key",
					models: [{ id: "fixture" }],
				},
			},
		}),
		"utf8",
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({ defaultProvider: "browser-offline", defaultModel: "fixture" }),
		"utf8",
	);
	const fixture = { hits: new Map(), retryEnabled: false, slowEnabled: false };
	// 1.1 失败与延迟由验收显式解除，避免外部网络和固定睡眠左右结果。
	const server = createServer((request, response) => {
		const path = new URL(request.url, "http://127.0.0.1").pathname;
		fixture.hits.set(path, (fixture.hits.get(path) ?? 0) + 1);
		if (path === "/unstable" && !fixture.retryEnabled) {
			request.socket.destroy();
			return;
		}
		if (path === "/slow" && !fixture.slowEnabled) return;
		if (path === "/unsafe") {
			response.writeHead(302, { Location: "file:///C:/private.txt" });
			response.end();
			return;
		}
		if (path === "/download") {
			response.writeHead(200, {
				"Content-Disposition": "attachment; filename=browser-fixture.txt",
				"Content-Type": "application/octet-stream",
			});
			response.end("fixture download");
			return;
		}
		const title =
			path === "/two"
				? "第二页"
				: path === "/three"
					? "新窗口链接"
					: path === "/unstable"
						? "重试成功"
						: path === "/slow"
							? "延迟页面"
							: "本地网页预览";
		response.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"X-Frame-Options": "DENY",
			"Content-Security-Policy": "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
			"Cache-Control": "no-store",
		});
		response.end(
			`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f7f8fa;color:#27313c;font:14px/1.6 system-ui,sans-serif}main{max-width:600px;padding:32px 24px;margin:auto}small{color:#7c8590}h1{font-size:24px;letter-spacing:-.6px;margin:8px 0}p{color:#626e7b}section{padding:20px;background:#fff;border:1px solid #e3e7eb;border-radius:10px;margin-top:24px}input{box-sizing:border-box;display:block;width:100%;border:1px solid #d9e0e7;border-radius:6px;padding:10px;margin:12px 0;font:inherit}button{background:#2475da;color:white;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font:inherit}nav{display:flex;flex-wrap:wrap;gap:16px;margin-top:24px}a{color:#2475da}output{margin-left:12px}footer{margin-top:32px;color:#7c8590;font-size:11px}</style></head><body><main><small>HARNESS · LOCAL PREVIEW</small><h1>${title}</h1><p>在工作台中预览网页，保留当前对话。</p><section><label for="draft">页面输入</label><input id="draft" placeholder="输入内容以验证标签保留"><button id="increase">增加计数</button><output id="count">0</output></section><nav><a href="/one">首页</a><a href="/two">第二页</a><a href="/three" target="_blank">新窗口链接</a><a href="#section">页内定位</a><a href="/download">下载文件</a></nav><footer id="section">此网页禁止 iframe 嵌入。当前使用独立原生网页视图。</footer></main><script>document.querySelector('#increase').onclick=()=>{document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1)};</script></body></html>`,
		);
	});
	await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	const environment = { ...(options.environment ?? runtime?.env) };
	const packagedExecutable = options.executable ?? environment.PI_GUI_PACKAGED_EXECUTABLE;
	const renderer = options.renderer ?? environment.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
	for (const key of Object.keys(environment)) {
		if (
			["electron_run_as_node", "node_options", "node_path", "pi_package_dir", "localappdata"].includes(
				key.toLowerCase(),
			)
		)
			delete environment[key];
	}
	Object.assign(environment, {
		ELECTRON_RENDERER_URL: renderer,
		PI_CODING_AGENT_DIR: agent,
		ANIAO_DEFAULT_PROVIDER_FILE: join(artifacts, "absent-provider.json"),
		LOCALAPPDATA: join(artifacts, "cache"),
		ANIAO_UPDATE_URL: "http://127.0.0.1:65534/updates/",
	});
	// 1.2 发布包使用自身 HTML 与资源，工具路径可限制为系统和 Git。
	if (packagedExecutable) delete environment.ELECTRON_RENDERER_URL;
	if (environment.PI_GUI_TEST_PATH) {
		for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
		environment.Path = environment.PI_GUI_TEST_PATH;
	}
	let application;
	try {
		application = await _electron.launch({
			executablePath: packagedExecutable ?? electronExecutable,
			args: [
				...(packagedExecutable ? [] : [join(root, "dist/main/index.cjs")]),
				`--user-data-dir=${join(artifacts, "profile")}`,
			],
			cwd: artifacts,
			env: environment,
			timeout: 60000,
		});
		const log = createWriteStream(join(artifacts, "electron.log"));
		application.process().stdout.pipe(log, { end: false });
		application.process().stderr.pipe(log, { end: false });
		application.process().once("exit", () => log.end());
		const page = await poll(
			async () =>
				application
					.windows()
					.find(
						(window) =>
							window.url().startsWith(packagedExecutable ? "file:" : renderer) &&
							!window.url().includes("startup.html"),
					),
			"工作台加载超时",
			60000,
		);
		page.setDefaultTimeout(15000);
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).waitFor();
		await poll(
			async () =>
				application.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows().some(
						(window) => !window.webContents.getURL().includes("startup.html") && window.isVisible(),
					),
				),
			"工作台窗口尚未显示",
		);
		await application.evaluate(({ dialog }, cwd) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
		}, project);
		await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
		await page.locator(".composer textarea").waitFor();
		await poll(async () => page.getByRole("button", { name: "打开变更", exact: true }).isEnabled(), "项目尚未就绪");
		logger.info("内置浏览器验收准备结束");
		return {
			application,
			page,
			artifacts,
			fixture,
			baseUrl,
			errors,
			results: [],
			async close() {
				await application.close().catch(() => {});
				server.closeAllConnections();
				await new Promise((done) => server.close(done));
			},
		};
	} catch (error) {
		await application?.close().catch(() => {});
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
		throw error;
	}
}

async function poll(read, message, timeout = 10000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await read();
		if (value) return value;
		await delay(40);
	}
	throw new Error(message);
}

export async function screenshotBrowser(test, name) {
	const bytes = await test.application.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("startup.html"),
		);
		const [width, height] = window.getContentSize();
		// 3.1 capturePage 只包含工作台 WebContents；系统窗口缩略图同时包含原生网页。
		const source = (await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width, height } })).find(
			(candidate) => candidate.id === window.getMediaSourceId(),
		);
		if (!source || source.thumbnail.isEmpty()) throw new Error("无法截取包含原生网页的窗口");
		return source.thumbnail.resize({ width, height, quality: "best" }).toPNG();
	});
	await writeFile(join(test.artifacts, `${name}.png`), bytes);
	return bytes;
}

export async function browserViewState(test) {
	return test.application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("startup.html"),
		);
		return window.contentView.children
			.filter((view) => view.webContents && view.webContents !== window.webContents)
			.map((view) => ({
				id: view.webContents.id,
				url: view.webContents.getURL(),
				visible: view.getVisible(),
				bounds: view.getBounds(),
			}));
	});
}

/*
 * ========================================================================
 * 步骤2：用真实用户操作验证浏览器控制、保留和失败恢复
 * ========================================================================
 * 数据源：真实地址栏、网页链接、历史、窗口和本机离线网页。
 * 操作：1) 每个可见控件均走正常输入；2) 检查隐藏、窄栏和弹窗时的原生区域。
 */
export async function runBrowserChecks(test) {
	const { application, page, baseUrl, fixture, results, errors } = test;
	const address = page.getByRole("textbox", { name: "网址", exact: true });
	const navigate = async (path, title) => {
		await address.fill(`${baseUrl}${path}`);
		await address.press("Enter");
		if (title) await page.locator(".browser-page-info").getByText(title, { exact: true }).waitFor();
	};
	const visibleView = async (visible) =>
		poll(async () => {
			const views = await browserViewState(test);
			return views.length === 1 && views[0].visible === visible ? views[0] : null;
		}, "网页可见性未同步");
	logger.info("开始验证真实内置浏览器");
	try {
		const closePanel = page.getByRole("button", { name: "关闭右侧面板", exact: true });
		if (await closePanel.isVisible()) await closePanel.click();
		results.length = 0;
		fixture.retryEnabled = false;
		fixture.slowEnabled = false;
		// 2.1 初始空状态和首个禁嵌入网页，网站脚本不能接触桌面桥。
		await page.keyboard.press("Control+t");
		await page.getByText("在这里浏览网页", { exact: true }).waitFor();
		assert(await page.getByRole("button", { name: "网页后退", exact: true }).isDisabled());
		await screenshotBrowser(test, "01-empty");
		await address.fill(`${baseUrl.replace("http://", "")}/one`);
		await page.getByRole("button", { name: "打开网页", exact: true }).click();
		await page.locator(".browser-page-info").getByText("本地网页预览", { exact: true }).waitFor();
		const guest = await poll(
			async () =>
				application
					.context()
					.pages()
					.find((candidate) => candidate.url() === `${baseUrl}/one`),
			"找不到原生网页目标",
		);
		await guest.getByRole("heading", { name: "本地网页预览", exact: true }).waitFor();
		assert.equal(
			JSON.stringify(
				await guest.evaluate(() => ({
					bridge: typeof window.piDesktop,
					node: typeof require,
					opener: window.opener === null,
				})),
			),
			JSON.stringify({ bridge: "undefined", node: "undefined", opener: true }),
		);
		await visibleView(true);
		await screenshotBrowser(test, "02-webpage-light");
		results.push(
			"native page with X-Frame-Options DENY and frame-ancestors none, address normalization, no desktop bridge or Node access passed",
		);

		// 2.2 网页内导航、前进后退、刷新和新窗口链接沿用一个浏览器标签。
		await guest.getByRole("link", { name: "第二页", exact: true }).click();
		await page.locator(".browser-page-info").getByText("第二页", { exact: true }).waitFor();
		await page.getByRole("button", { name: "网页后退", exact: true }).click();
		await guest.getByRole("heading", { name: "本地网页预览", exact: true }).waitFor();
		await page.getByRole("button", { name: "网页前进", exact: true }).click();
		await guest.getByRole("heading", { name: "第二页", exact: true }).waitFor();
		const hits = fixture.hits.get("/two");
		await page.getByRole("button", { name: "刷新网页", exact: true }).click();
		await poll(async () => fixture.hits.get("/two") > hits, "刷新未请求页面");
		await guest.getByRole("link", { name: "新窗口链接", exact: true }).click();
		await guest.getByRole("heading", { name: "新窗口链接", exact: true }).waitFor();
		assert.equal((await browserViewState(test)).length, 1);
		assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
		await guest.getByRole("link", { name: "页内定位", exact: true }).click();
		await poll(async () => (await address.inputValue()).endsWith("#section"), "页内地址未同步");
		results.push("page links, back, forward, refresh, hash navigation and target=_blank reuse passed");

		// 2.3 标签、开始页和文件工具切换不丢失 DOM，网页快捷键仍可打开设置。
		await guest.getByRole("textbox", { name: "页面输入", exact: true }).fill("保留页面状态");
		await guest.getByRole("button", { name: "增加计数", exact: true }).click();
		const viewId = (await browserViewState(test))[0].id;
		await page.getByRole("button", { name: "打开开始页", exact: true }).click();
		await visibleView(false);
		await page.getByRole("button", { name: /浏览器.*浏览网页与本地开发页面/ }).click();
		await visibleView(true);
		assert.equal((await browserViewState(test))[0].id, viewId);
		assert.equal(await guest.getByRole("textbox", { name: "页面输入", exact: true }).inputValue(), "保留页面状态");
		assert.equal(await guest.locator("#count").textContent(), "1");
		// Chromium DevTools 键盘会绕过 Electron before-input-event，此处补原生输入诊断。
		await guest.getByRole("textbox", { name: "页面输入", exact: true }).click();
		await application.evaluate(({ webContents }, url) => {
			const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(url));
			contents.focus();
			contents.sendInputEvent({ type: "keyDown", keyCode: "P", modifiers: ["control"] });
			contents.sendInputEvent({ type: "keyUp", keyCode: "P", modifiers: ["control"] });
		}, baseUrl);
		await page.getByRole("tab", { name: /^文件/ }).waitFor();
		await visibleView(false);
		await page.getByRole("tab", { name: /^浏览器/ }).click();
		await visibleView(true);
		await guest.getByRole("textbox", { name: "页面输入", exact: true }).click();
		await application.evaluate(({ webContents }, url) => {
			const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(url));
			contents.focus();
			contents.sendInputEvent({ type: "keyDown", keyCode: ",", modifiers: ["control"] });
			contents.sendInputEvent({ type: "keyUp", keyCode: ",", modifiers: ["control"] });
		}, baseUrl);
		await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
		await visibleView(false);
		await screenshotBrowser(test, "03-settings-overlay");
		await page.keyboard.press("Escape");
		await page.getByRole("dialog").waitFor({ state: "hidden" });
		await visibleView(true);
		await page.getByRole("button", { name: "编辑", exact: true }).click();
		await page.getByRole("menu").waitFor();
		await visibleView(false);
		await page.keyboard.press("Escape");
		await visibleView(true);
		assert.equal(await guest.getByRole("textbox", { name: "页面输入", exact: true }).inputValue(), "保留页面状态");
		results.push(
			"page state survives start/files/browser tabs; guest shortcuts, settings/menu occlusion and restoration passed",
		);

		// 2.4 放大、还原、360px 窄栏和最小窗口的原生区域保持对齐。
		await page.getByRole("button", { name: "放大面板", exact: true }).click();
		assert.equal(await page.locator(".conversation-column").isVisible(), false);
		await screenshotBrowser(test, "04-maximized");
		await page.getByRole("button", { name: "还原面板宽度", exact: true }).click();
		const separator = page.getByRole("separator", { name: "调整右侧面板宽度", exact: true });
		const dragStart = await separator.boundingBox();
		const beforeDrag = Number(await separator.getAttribute("aria-valuenow"));
		await page.mouse.move(dragStart.x + dragStart.width / 2, dragStart.y + 150);
		await page.mouse.down();
		await page.mouse.move(dragStart.x + 70, dragStart.y + 150, { steps: 8 });
		await page.mouse.up();
		await poll(
			async () => Number(await separator.getAttribute("aria-valuenow")) < beforeDrag - 40,
			"拖拽进入网页区域后未调整宽度",
		);
		await visibleView(true);
		await page.getByRole("separator", { name: "调整右侧面板宽度", exact: true }).press("Home");
		await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
		await screenshotBrowser(test, "05-narrow-dark");
		await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0];
			window.setSize(1100, 720);
		});
		await poll(async () => {
			const rect = await page.locator(".browser-viewport").boundingBox();
			const view = (await browserViewState(test))[0];
			return (
				Math.abs(view.bounds.width - Math.round(rect.width)) <= 1 && Math.abs(view.bounds.x - Math.round(rect.x)) <= 1
			);
		}, "网页区域与窄栏不对齐");
		assert.equal(
			await page.evaluate(
				() =>
					document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
			),
			true,
		);
		await screenshotBrowser(test, "06-minimum-window");
		results.push("maximize/restore, 360px dark panel, 1100x720 minimum window and native viewport bounds passed");

		// 2.5 可见错误、显式重试和停止加载都通过界面操作。
		await navigate("/unstable");
		await page.getByText("无法显示网页", { exact: true }).waitFor();
		await visibleView(false);
		await screenshotBrowser(test, "07-network-error");
		fixture.retryEnabled = true;
		await page.getByRole("button", { name: "重新加载", exact: true }).click();
		await guest.getByRole("heading", { name: "重试成功", exact: true }).waitFor();
		await visibleView(true);
		await navigate("/slow");
		await page.getByRole("button", { name: "停止加载网页", exact: true }).click();
		await page.getByText("页面加载已停止，可点击刷新重试。", { exact: true }).waitFor();
		fixture.slowEnabled = true;
		await page.getByRole("button", { name: "重新加载", exact: true }).click();
		await guest.getByRole("heading", { name: "延迟页面", exact: true }).waitFor();
		await address.fill("file:///C:/private.txt");
		await address.press("Enter");
		await page.getByRole("alert").filter({ hasText: "仅支持 HTTP 和 HTTPS 网页" }).waitFor();
		assert.equal((await browserViewState(test))[0].url, `${baseUrl}/slow`);
		await navigate("/unsafe");
		await page.getByText("无法显示网页", { exact: true }).waitFor();
		results.push("visible network failure/retry, stopping/reloading, unsafe typed URL and redirect rejection passed");

		// 2.6 下载给出系统浏览器入口，只有明确点击才打开外链。
		await navigate("/one", "本地网页预览");
		await guest.getByRole("link", { name: "下载文件", exact: true }).click();
		await page.getByRole("alert").filter({ hasText: "系统浏览器" }).waitFor();
		await visibleView(true);
		await guest.getByRole("heading", { name: "本地网页预览", exact: true }).waitFor();
		assert.equal(await address.inputValue(), `${baseUrl}/one`);
		await application.evaluate(({ shell }) => {
			globalThis.browserExternalUrls = [];
			shell.openExternal = async (url) => {
				globalThis.browserExternalUrls.push(url);
			};
		});
		await page.getByRole("button", { name: "在系统浏览器打开", exact: true }).click();
		assert.equal((await application.evaluate(() => globalThis.browserExternalUrls)).length, 1);
		results.push("page download prevention and explicit system-browser fallback passed");

		// 2.7 标签和主窗重载回收网页，关闭整栏后重新打开为干净标签。
		await page
			.getByRole("tab", { name: /^浏览器/ })
			.locator(".side-tab-close")
			.click();
		await poll(async () => (await browserViewState(test)).length === 0, "关闭标签未回收网页");
		await page.keyboard.press("Control+t");
		await page.getByText("在这里浏览网页", { exact: true }).waitFor();
		await navigate("/one", "本地网页预览");
		await page.getByRole("button", { name: "关闭右侧面板", exact: true }).click();
		await poll(async () => (await browserViewState(test)).length === 0, "关闭侧栏未回收网页");
		await page.keyboard.press("Control+t");
		await page.getByText("在这里浏览网页", { exact: true }).waitFor();
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.locator(".composer textarea").waitFor();
		await poll(async () => (await browserViewState(test)).length === 0, "工作台重载未回收网页");
		results.push("tab close, panel close/reopen and workbench reload release native views passed");
		assert.deepEqual(errors, []);
		await writeFile(
			join(test.artifacts, "results.json"),
			JSON.stringify({ passed: true, results, errors }, null, 2),
			"utf8",
		);
		logger.info(JSON.stringify({ passed: true, artifacts: test.artifacts, results }));
	} catch (error) {
		await screenshotBrowser(test, "failure").catch(() => {});
		await writeFile(
			join(test.artifacts, "results.json"),
			JSON.stringify({ passed: false, results, errors, error: String(error) }, null, 2),
			"utf8",
		);
		throw error;
	} finally {
		logger.info("真实内置浏览器验证结束");
	}
}

if (runtime?.argv[1] && resolve(runtime.argv[1]) === fileURLToPath(import.meta.url)) {
	const test = await startBrowserTest();
	try {
		await runBrowserChecks(test);
	} finally {
		await test.close();
	}
}
