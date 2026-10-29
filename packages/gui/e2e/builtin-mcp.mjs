import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "artifacts", `builtin-mcp-${Date.now()}`);
const agent = join(output, "agent");
const project = join(output, "project");
const checks = [];
const failures = [];
const toolResults = [];
let code = "";
let application;
let page;
let requests = 0;
let turnRequested = false;

/*
 * ========================================================================
 * 步骤1：准备免付费的真实 MCP 与浏览器验收
 * ========================================================================
 * 数据源：本机 HTTP 模型替身、原生网页、独立桌面与 SDK 目录。
 * 操作：1) 工具经过正式模型循环；2) 不读取用户认证或访问付费 API。
 */
logger.info("开始准备内置 MCP 验收");
await Promise.all([agent, project].map((path) => mkdir(path, { recursive: true })));
const server = createServer(async (request, response) => {
	if (request.url === "/page") {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(
			'<!doctype html><html><head><title>浏览器验收</title></head><body><h1>免费工具测试</h1><label>名字<input id="name"></label><label>语言<select id="language"><option value="zh">中文</option><option value="en">English</option></select></label><button onclick="document.getElementById(\'result\').textContent=\'已填写：\'+document.getElementById(\'name\').value+\':\'+document.getElementById(\'language\').value">提交测试</button><p id="result">尚未填写</p><div style="height:2400px">长页面</div></body></html>',
		);
		return;
	}
	if (request.url === "/text") {
		response
			.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			.end(
				"<title>公开正文</title><script>secret script</script><main><h1>免费文档</h1><p>正文测试 &amp; Unicode 中文。</p></main>",
			);
		return;
	}
	if (request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of request) body += chunk;
	const input = JSON.parse(body);
	requests++;
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const send = (delta, finish_reason = null) =>
		response.write(
			`data: ${JSON.stringify({ id: "builtin", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	if (turnRequested) {
		toolResults.push(input.messages.findLast((message) => message.role === "tool")?.content);
		send({ role: "assistant", content: `验收完成 ${requests}` });
		send({}, "stop");
	} else {
		turnRequested = true;
		send({
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: `builtin-${requests}`,
					type: "function",
					function: { name: "codemode", arguments: JSON.stringify({ code }) },
				},
			],
		});
		send({}, "tool_calls");
	}
	response.end("data: [DONE]\n\n");
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const base = `http://127.0.0.1:${server.address().port}`;
await writeFile(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			offline: {
				baseUrl: `${base}/v1`,
				api: "openai-completions",
				apiKey: "offline-fixture",
				models: [{ id: "fixture", contextWindow: 128000, maxTokens: 4096, input: ["text", "image"] }],
			},
		},
	}),
);
await writeFile(
	join(agent, "settings.json"),
	JSON.stringify({
		defaultProvider: "offline",
		defaultModel: "fixture",
		retry: { enabled: false },
		compaction: { enabled: false },
	}),
);
const environment = {
	...process.env,
	PI_CODING_AGENT_DIR: agent,
	ANIAO_DEFAULT_PROVIDER_FILE: join(output, "absent.json"),
	ANIAO_UPDATE_URL: `${base}/updates/`,
};
for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "PI_PACKAGE_DIR"]) delete environment[key];
const packaged = process.env.PI_GUI_PACKAGED_EXECUTABLE;
if (packaged) delete environment.ELECTRON_RENDERER_URL;
else environment.ELECTRON_RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
async function poll(read, message) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (await read()) return;
		await delay(50);
	}
	throw new Error(message);
}
async function run(script, contains, identity) {
	code = script;
	turnRequested = false;
	const before = toolResults.length;
	await page.evaluate(async (owner) => {
		const state = owner ?? (await window.piDesktop.getSnapshot());
		await window.piDesktop.dispatch({
			requestId: crypto.randomUUID(),
			sessionId: state.sessionId,
			generation: state.generation,
			command: { type: "prompt", text: "运行独立离线工具验收" },
		});
	}, identity);
	assert(toolResults.length > before, "缺少工具返回");
	assert(
		JSON.stringify(toolResults.at(-1)).includes(contains),
		`工具未返回预期结果 ${contains}: ${JSON.stringify(toolResults.at(-1)).slice(0, 1800)}`,
	);
	return toolResults.at(-1);
}
async function capture(name) {
	const bytes = await application.evaluate(async ({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("startup.html"),
		);
		return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG();
	});
	await writeFile(join(output, name), bytes);
}
try {
	application = await _electron.launch({
		executablePath: packaged ?? electronExecutable,
		args: [...(packaged ? [] : [join(root, "dist/main/index.cjs")]), `--user-data-dir=${join(output, "profile")}`],
		cwd: root,
		env: environment,
		timeout: 60000,
	});
	const log = createWriteStream(join(output, "electron.log"));
	application.process().stdout.pipe(log, { end: false });
	application.process().stderr.pipe(log, { end: false });
	application.process().once("exit", () => log.end());
	await poll(async () => {
		page = application
			.windows()
			.find(
				(candidate) =>
					!candidate.url().includes("startup.html") &&
					candidate.url().startsWith(packaged ? "file:" : environment.ELECTRON_RENDERER_URL),
			);
		return !!page;
	}, "工作台未就绪");
	page.on("pageerror", (error) => failures.push(error.message));
	page.setDefaultTimeout(20000);
	await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).waitFor({ timeout: 60000 });
	await application.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	await poll(
		async () => (await page.evaluate(() => window.piDesktop.getSnapshot()))?.run.phase === "idle",
		"宿主未就绪",
	);
	await poll(
		async () =>
			(await page.evaluate(() => window.piDesktop.listMcpServers())).filter(
				(item) => item.connection?.state === "connected",
			).length === 4,
		"四项内置 MCP 未连接",
	);
	checks.push("four-free-builtins-connected-without-keys");
	logger.info("内置 MCP 验收准备结束");

	/*
	 * ========================================================================
	 * 步骤2：让真实模型循环操控右侧原生网页
	 * ========================================================================
	 * 数据源：MCP 元素快照、Unicode 输入与页面真实响应。
	 * 操作：1) 打开、填写、选择、点击、截图；2) 复用用户可见的相同网页。
	 */
	logger.info("开始验证右栏浏览器工具");
	await run(
		`const opened = await tools.mcp__harness_browser__browser_open({ url: ${JSON.stringify(`${base}/page`)} }); const value = JSON.parse(opened.content[0].text); store('tab', value.tabId); const elements = value.page.elements; await tools.mcp__harness_browser__browser_fill({ ref: elements.find(x => x.label === '名字').ref, text: '测试 中文 42' }); await tools.mcp__harness_browser__browser_select({ ref: elements.find(x => x.tag === 'select').ref, value: 'en' }); await tools.mcp__harness_browser__browser_click({ ref: elements.find(x => x.label === '提交测试').ref }); text(await tools.mcp__harness_browser__browser_snapshot({}));`,
		"已填写：测试 中文 42:en",
	);
	await page.getByRole("textbox", { name: "网址", exact: true }).waitFor();
	assert.equal(await page.getByRole("textbox", { name: "网址", exact: true }).inputValue(), `${base}/page`);
	await run(
		"const shot = await tools.mcp__harness_browser__browser_screenshot({}); image(shot.content[0]); text('SCREENSHOT_OK');",
		"SCREENSHOT_OK",
	);
	await run(
		"await tools.mcp__harness_browser__browser_scroll({ direction:'down',pixels:900 }); await tools.mcp__harness_browser__browser_press({ key:'Escape' }); text('SCROLL_PRESS_OK');",
		"SCROLL_PRESS_OK",
	);
	checks.push(
		"model-opens-visible-native-page",
		"snapshot-fill-select-click-unicode",
		"real-native-screenshot-and-scroll-key",
	);
	const first = await page.evaluate(() => window.piDesktop.getSnapshot());
	const firstTabText = await run("text(await tools.mcp__harness_browser__browser_tabs({}));", "tabId");
	const firstTab = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(firstTabText)?.[0];
	assert(firstTab, "没有取得当前浏览器标签身份");
	await page.evaluate((cwd) => window.piDesktop.newSessionAt(cwd), project);
	await poll(async () => {
		const state = await page.evaluate(() => window.piDesktop.getSnapshot());
		return state.sessionId !== first.sessionId && state.run.phase === "idle";
	}, "第二会话未就绪");
	await run("text(await tools.mcp__harness_browser__browser_tabs({}));", "[]");
	const second = await page.evaluate(() => window.piDesktop.getSnapshot());
	await page.evaluate((cwd) => window.piDesktop.newSessionAt(cwd), project);
	await poll(async () => {
		const state = await page.evaluate(() => window.piDesktop.getSnapshot());
		return state.sessionId !== second.sessionId && state.run.phase === "idle";
	}, "后台会话未就绪");
	const background = await page.evaluate(() => window.piDesktop.getSnapshot());
	await page.evaluate(({ cwd, id }) => window.piDesktop.openSessionAt(cwd, id), { cwd: project, id: second.sessionId });
	await run(
		`const opened = await tools.mcp__harness_browser__browser_open({url:${JSON.stringify(`${base}/page`)}}); const value=JSON.parse(opened.content[0].text); await tools.mcp__harness_browser__browser_fill({ref:value.page.elements.find(x=>x.label==='名字').ref,text:'后台首次打开'}); const shot=await tools.mcp__harness_browser__browser_screenshot({}); image(shot.content[0]); text(await tools.mcp__harness_browser__browser_snapshot({}));`,
		"后台首次打开",
		{ sessionId: background.sessionId, generation: background.generation },
	);
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, second.sessionId);
	checks.push("background-first-browser-open-keeps-active-session");
	await run(
		`text(await tools.mcp__harness_browser__browser_snapshot({tabId:${JSON.stringify(firstTab)}}));`,
		"其他会话",
	);
	await page.evaluate(({ cwd, id }) => window.piDesktop.openSessionAt(cwd, id), { cwd: project, id: first.sessionId });
	await poll(
		async () => (await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId === first.sessionId,
		"未恢复第一会话",
	);
	await run("text(await tools.mcp__harness_browser__browser_snapshot({}));", "已填写：测试 中文 42:en");
	await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
	await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
	await run("text(await tools.mcp__harness_browser__browser_snapshot({}));", "已填写：测试 中文 42:en");
	checks.push(
		"session-switch-retains-native-page-and-input",
		"other-session-has-no-browser-access",
		"sidebar-toggle-preserves-browser",
	);
	await run(
		`await tools.mcp__harness_browser__browser_open({newTab:true,url:${JSON.stringify(`${base}/text`)}}); text(await tools.mcp__harness_browser__browser_snapshot({tabId:load('tab')}));`,
		"已填写：测试 中文 42:en",
	);
	checks.push("multiple-browser-tabs-select-original-page");
	logger.info("右栏浏览器工具验证结束");

	/*
	 * ========================================================================
	 * 步骤3：验证免费正文工具和 MCP 管理边界
	 * ========================================================================
	 * 数据源：本机 HTML、真实 MCP 设置与不存在的命令。
	 * 操作：1) 正文不含脚本；2) 失败显示真实连接状态，参数按行保留空格。
	 */
	logger.info("开始验证免费网页与管理状态");
	await run(
		`text(await tools.mcp__harness_web__fetch_page({url:${JSON.stringify(`${base}/text`)}}));`,
		"正文测试 & Unicode 中文",
	);
	await run(
		`text(await tools.mcp__harness_docs__read_docs({url:${JSON.stringify(`${base}/text`)}}));`,
		"正文测试 & Unicode 中文",
	);
	await page.evaluate(() => window.piDesktop.setMcpServerEnabled("harness_browser", false));
	await run(
		"try { await tools.mcp__harness_browser__browser_tabs({}); text('UNEXPECTED_ENABLED'); } catch(error) { text('DISABLED_OK'); }",
		"DISABLED_OK",
	);
	await page.evaluate(() => window.piDesktop.setMcpServerEnabled("harness_browser", true));
	checks.push("builtin-switch-takes-effect-without-model-replay");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "MCP 服务器", exact: true }).click();
	await page.getByText("内置", { exact: true }).first().waitFor();
	await page.evaluate(() =>
		window.piDesktop.saveMcpServer({
			name: "broken",
			type: "stdio",
			command: "harness_mcp_no_such_executable",
			enabled: true,
		}),
	);
	await page.getByText("连接失败", { exact: true }).waitFor();
	await page.getByRole("button", { name: "新建 MCP 服务器", exact: true }).click();
	await page.locator("#mcp-name").fill("spaced");
	await page.locator("#mcp-command").fill(process.execPath);
	await page.locator("#mcp-args").fill("C:\\path with spaces\\server.mjs\n中文 参数");
	await page.locator(".provider-editor").getByRole("button", { name: "保存", exact: true }).click();
	await page.locator(".provider-editor").waitFor({ state: "hidden" });
	const saved = JSON.parse(await readFile(join(agent, "mcp.json"), "utf8"));
	assert.deepEqual(saved.mcpServers.spaced.args, ["C:\\path with spaces\\server.mjs", "中文 参数"]);
	await capture("mcp-errors.png");
	await page.evaluate(async () => {
		await window.piDesktop.removeMcpServer("broken");
		await window.piDesktop.removeMcpServer("spaced");
	});
	await poll(async () => (await page.locator(".provider-card").count()) === 4, "测试配置未清理");
	await page.locator(".settings-content").evaluate((element) => {
		element.scrollTop = 0;
	});
	await capture("mcp-light.png");
	checks.push(
		"real-mcp-fetch-readonly-html",
		"broken-command-shows-failed-with-error",
		"newline-arguments-preserve-spaces",
	);
	await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
	await page.evaluate(() => new Promise((ready) => requestAnimationFrame(() => requestAnimationFrame(ready))));
	await capture("mcp-dark.png");
	assert.deepEqual(failures, []);
	await writeFile(join(output, "results.json"), JSON.stringify({ passed: true, checks, requests, failures }, null, 2));
	logger.info(JSON.stringify({ passed: true, checks, artifacts: output }));
	logger.info("免费网页与管理状态验证结束");
} catch (error) {
	if (page) await capture("failure.png").catch(() => {});
	await writeFile(
		join(output, "results.json"),
		JSON.stringify({ passed: false, checks, requests, error: String(error), failures, toolResults }, null, 2),
	);
	throw error;
} finally {
	await application?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((finish) => server.close(finish));
	logger.info("内置 MCP 验收结束");
}
