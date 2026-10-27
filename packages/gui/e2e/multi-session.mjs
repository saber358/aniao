import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `multi-session-${Date.now()}`);
const project = join(artifacts, "中文项目");
const agentDirectory = join(artifacts, "agent");
const profile = join(artifacts, "profile");
const renderer = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
const packagedExecutable = process.env.PI_GUI_PACKAGED_EXECUTABLE;
const gates = new Map();
const requests = [];
const failures = [];
let application;
let page;
let stderr = "";

/*
 * ========================================================================
 * 步骤1：创建独立模型服务和桌面数据目录
 * ========================================================================
 * 数据源：本机 SSE 响应与可控的任务完成信号。
 * 操作：1) 所有凭据、会话和输出在验收目录；2) 用真实 SDK 请求验证并发。
 */
logger.info("开始准备多会话 Electron 验收");
await Promise.all([project, agentDirectory, profile].map((path) => mkdir(path, { recursive: true })));
const server = createServer(async (request, response) => {
	if (!request.url?.endsWith("/chat/completions")) {
		response.writeHead(404).end();
		return;
	}
	try {
		let body = "";
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body);
		const last = input.messages.filter((message) => message.role === "user").at(-1);
		const text =
			typeof last?.content === "string"
				? last.content
				: (last?.content
						?.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("") ?? "");
		requests.push(text);
		response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		const send = (delta, finish_reason = null) =>
			response.write(
				`data: ${JSON.stringify({ id: `multi-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
			);
		send({ role: "assistant", content: `正在处理${text}` });
		// 1.1 等待由验收器单独释放；停止任务会关闭响应，不需要等待另一会话。
		await new Promise((resolve) => {
			gates.set(text, resolve);
			response.once("close", resolve);
		});
		gates.delete(text);
		if (!response.destroyed) {
			send({ content: `\n${text}完成` });
			send({}, "stop");
			response.end("data: [DONE]\n\n");
		}
	} catch (error) {
		failures.push(String(error));
		if (!response.destroyed) response.end();
	}
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert(address && typeof address === "object");
await writeFile(
	join(agentDirectory, "models.json"),
	JSON.stringify({
		providers: {
			"multi-offline": {
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-completions",
				apiKey: "offline-fixture",
				models: [
					{
						id: "fixture",
						name: "离线多会话",
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
await writeFile(
	join(agentDirectory, "settings.json"),
	JSON.stringify({
		defaultProvider: "multi-offline",
		defaultModel: "fixture",
		retry: { enabled: false },
		compaction: { enabled: false },
	}),
);
await mkdir(join(agentDirectory, "extensions"));
await writeFile(
	join(agentDirectory, "extensions", "initialization.js"),
	`const logger = console;
/*
 * ========================================================================
 * 步骤1：停留在真实扩展初始化阶段
 * ========================================================================
 * 数据源：独立测试会话的 session_start 事件。
 * 操作：1) 等待界面取消输入；2) 不提交模型任务。
 */
export default function (pi) {
	pi.on("session_start", async (_event, ctx) => {
		logger.info("开始等待初始化验收输入");
		try {
			// 1.1 用可见交互控制初始化结束时机。
			await ctx.ui.input("初始化验收");
		} finally {
			logger.info("初始化验收输入结束");
		}
	});
}
`,
);

async function current() {
	return page.evaluate(() => window.piDesktop.getSnapshot());
}
async function waitFor(check, message) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		const value = await current();
		if (value && check(value)) return value;
		await delay(50);
	}
	throw new Error(message);
}

/*
 * ========================================================================
 * 步骤3：核对首次打开与应用恢复时的初始化状态
 * ========================================================================
 * 数据源：真实扩展弹窗、侧栏运行标记和本机模型请求计数。
 * 操作：1) 初始化不显示任务；2) 应用重启不重发历史任务。
 */
async function launchDesktop(environment) {
	logger.info("开始启动多会话验收窗口");
	try {
		// 3.1 每次启动复用同一隔离 profile，完整重建宿主与 Renderer。
		page = undefined;
		application = await _electron.launch({
			executablePath: packagedExecutable ?? electronExecutable,
			args: [...(packagedExecutable ? [] : [join(root, "dist/main/index.cjs")]), `--user-data-dir=${profile}`],
			cwd: packagedExecutable ? dirname(packagedExecutable) : root,
			env: environment,
			timeout: 60000,
		});
		const log = createWriteStream(join(artifacts, "electron.log"), { flags: "a" });
		application.process().stdout.pipe(log, { end: false });
		application.process().stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		application.process().stderr.pipe(log, { end: false });
		application.process().once("exit", () => log.end());
		const deadline = Date.now() + 60000;
		while (!page && Date.now() < deadline) {
			page = application
				.windows()
				.find(
					(candidate) =>
						candidate.url().startsWith(packagedExecutable ? "file:" : renderer) &&
						!candidate.url().includes("startup.html"),
				);
			if (!page) await delay(50);
		}
		assert(page, "未找到工作台窗口");
		page.setDefaultTimeout(20000);
		page.on("pageerror", (error) => failures.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error" || (message.type() === "warning" && message.text().startsWith("[Vue warn]")))
				failures.push(message.text().slice(0, 300));
		});
		await page.waitForFunction(() => !!window.piDesktop);
	} finally {
		logger.info("多会话验收窗口启动结束");
	}
}

async function finishInitialization(running, requestCount) {
	logger.info("开始验证初始化没有任务标记");
	try {
		// 3.2 扩展还在等待输入，不能先跳过初始化再核对运行指示器。
		const value = await waitFor((value) => value.dialogs[0]?.title === "初始化验收", "扩展初始化交互未出现");
		const dialog = page.getByRole("dialog", { name: "初始化验收", exact: true });
		await dialog.waitFor();
		assert.equal(value.run.phase, "initializing");
		assert.equal(requests.length, requestCount);
		assert.equal(
			(await page.evaluate(() => window.piDesktop.getSessionRuntimes())).filter((entry) => entry.running).length,
			running,
		);
		assert.equal(await page.locator(".session-running-spinner").count(), running);
		assert.equal(await page.locator(".conversation-scroll.running").count(), 0);
		assert.equal(await page.getByRole("button", { name: "停止任务", exact: true }).count(), 0);
		await page.screenshot({ path: join(artifacts, `initializing-${requestCount}.png`), fullPage: true });
		await dialog.getByRole("button", { name: "取消", exact: true }).click();
		await waitFor((value) => value.run.phase === "idle" && !value.dialogs.length, "初始化未收束");
		assert.equal(requests.length, requestCount);
		return value;
	} finally {
		logger.info("初始化没有任务标记验证结束");
	}
}

try {
	/*
	 * ========================================================================
	 * 步骤2：从实际会话标签切换页面并并发提交任务
	 * ========================================================================
	 * 数据源：真实主进程、utilityProcess、preload 和 Vue 工作台。
	 * 操作：1) 运行中返回标签、新建和浏览；2) 完成与停止分别归属各会话。
	 */
	logger.info("开始验证多会话用户操作");
	const environment = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDirectory,
		ELECTRON_RENDERER_URL: renderer,
		ANIAO_DEFAULT_PROVIDER_FILE: join(artifacts, "no-default-provider.json"),
		ANIAO_UPDATE_URL: `http://127.0.0.1:${address.port}/updates/`,
	};
	delete environment.ELECTRON_RUN_AS_NODE;
	if (packagedExecutable) {
		delete environment.ELECTRON_RENDERER_URL;
		delete environment.PI_PACKAGE_DIR;
		delete environment.NODE_PATH;
		delete environment.NODE_OPTIONS;
	}
	if (process.env.PI_GUI_TEST_PATH) {
		for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
		environment.Path = process.env.PI_GUI_TEST_PATH;
	}
	await launchDesktop(environment);
	await application.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	await finishInitialization(0, 0);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.locator("textarea").waitFor();
	assert.equal(await page.locator(".session-running-spinner").count(), 0);
	assert.equal(requests.length, 0);
	await page.locator("textarea").fill("任务A");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	const a = await waitFor((value) => value.run.phase === "working", "A 未开始运行");
	await page.locator(".session-open").filter({ hasText: "任务A" }).waitFor();
	// 2.1 插件页能直接点正在运行的会话标签返回，不依赖顶部应用入口。
	await page.getByRole("button", { name: "插件", exact: true }).click();
	await page.getByRole("heading", { name: "插件", exact: true }).waitFor();
	await page.locator(".session-open").filter({ hasText: "任务A" }).click();
	await page.locator("textarea").waitFor();
	assert.equal((await current()).generation, a.generation);
	assert.equal((await current()).run.phase, "working");
	// 2.2 A 运行中创建 B 并发出第二个请求，两个真实 utilityProcess 均保持活动。
	await page.getByRole("button", { name: "新会话", exact: true }).click();
	await finishInitialization(1, 1);
	const b = await waitFor((value) => value.sessionId !== a.sessionId && value.run.phase === "idle", "B 未创建");
	await page.locator("textarea").fill("任务B");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await waitFor((value) => value.run.phase === "working", "B 未开始运行");
	await page.waitForFunction(
		async () => (await window.piDesktop.getSessionRuntimes()).filter((entry) => entry.running).length === 2,
	);
	assert.equal(await page.locator(".session-running-spinner").count(), 2);
	await page.locator("textarea").fill("B独立草稿");
	await page.locator(".session-open").filter({ hasText: "任务A" }).click();
	await waitFor((value) => value.sessionId === a.sessionId, "未返回 A");
	assert.equal((await current()).generation, a.generation);
	assert.equal((await current()).run.phase, "working");
	await page.locator("textarea").fill("A独立草稿");
	await page.getByRole("button", { name: "自动化任务", exact: true }).click();
	await page.locator(".session-open").filter({ hasText: "任务B" }).click();
	await waitFor((value) => value.sessionId === b.sessionId, "未返回 B");
	assert.equal(await page.locator("textarea").inputValue(), "B独立草稿");
	// 2.3 A 后台完成不影响 B 的运行和草稿；重载工作台不停止两个宿主。
	assert(gates.has("任务A"), "A 未进入本地模型等待");
	gates.get("任务A")();
	await page.waitForFunction(async (sessionId) => {
		const runtime = (await window.piDesktop.getSessionRuntimes()).find((entry) => entry.sessionId === sessionId);
		return runtime && !runtime.running;
	}, a.sessionId);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.locator("textarea").waitFor();
	await waitFor((value) => value.sessionId === b.sessionId && value.run.phase === "working", "重载后 B 状态丢失");
	assert.equal(await page.locator("textarea").inputValue(), "B独立草稿");
	await page.locator(".session-open").filter({ hasText: "任务A" }).click();
	await waitFor((value) => value.sessionId === a.sessionId && value.run.phase === "idle", "A 后台完成记录缺失");
	assert.equal(await page.locator("textarea").inputValue(), "A独立草稿");
	assert(
		(await current()).messages.some((message) => message.blocks.some((block) => block.text.includes("任务A完成"))),
	);
	await page.locator(".session-open").filter({ hasText: "任务B" }).click();
	await waitFor((value) => value.sessionId === b.sessionId, "停止前未返回 B");
	await page.locator("textarea").fill("");
	await page.getByRole("button", { name: "停止任务", exact: true }).click();
	await waitFor((value) => value.run.phase === "idle", "B 停止失败");
	assert.equal(requests.length, 2);
	assert.equal(
		(await page.evaluate(() => window.piDesktop.getSessionRuntimes())).filter((entry) => entry.running).length,
		0,
	);
	// 3.3 关闭应用后从落盘会话恢复，初始化与历史读取均不再发送模型请求。
	await application.close();
	await launchDesktop(environment);
	const restored = await finishInitialization(0, 2);
	assert.equal(restored.sessionId, b.sessionId);
	assert.notEqual(restored.generation, b.generation);
	assert.equal(await page.locator(".session-running-spinner").count(), 0);
	assert.deepEqual(failures, []);
	assert(!/UnhandledPromiseRejection|unhandledRejection/u.test(stderr));
	await page.screenshot({ path: join(artifacts, "multi-session.png"), fullPage: true });
	const results = {
		passed: true,
		requests,
		checks: [
			"opening-does-not-run",
			"initialization-does-not-spin",
			"idle-renderer-reload",
			"restore-does-not-run",
			"return-from-plugins-via-session",
			"create-while-running",
			"two-concurrent-requests",
			"retained-generations",
			"per-session-drafts",
			"return-from-automation",
			"background-completion",
			"renderer-reload",
			"independent-stop",
		],
		failures,
	};
	await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
	logger.info(JSON.stringify({ ...results, artifacts }));
} catch (error) {
	await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: false, error: String(error), failures, requests }, null, 2),
	);
	throw error;
} finally {
	for (const finish of gates.values()) finish();
	await application?.close().catch(() => {});
	await new Promise((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});
	logger.info("多会话 Electron 验收结束");
}
