import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const artifacts = join(root, "artifacts", `tray-${process.platform}-${Date.now()}`);
const agent = join(artifacts, "agent");
const project = join(artifacts, "中文 项目");
const profile = join(artifacts, "profile");
const packaged = process.env.PI_GUI_PACKAGED_EXECUTABLE;
const executablePath = packaged ?? electronExecutable;
const args = [...(packaged ? [] : [join(root, "dist/main/index.cjs")]), `--user-data-dir=${profile}`];
const checks = [];
const failures = [];
let application;
let page;
let requests = 0;
let finishModel;

/*
 * ========================================================================
 * 步骤1：准备托盘验收的隔离桌面与慢模型替身
 * ========================================================================
 * 数据源：独立配置、中文项目、真实 Electron 和本机 SSE。
 * 操作：1) 不访问用户会话；2) 明确放行模型回复，核对隐藏时任务继续。
 */
logger.info("开始准备托盘完整流程验收");
await Promise.all([agent, project, profile].map((path) => mkdir(path, { recursive: true })));
const server = createServer(async (request, response) => {
	if (!request.url?.endsWith("/chat/completions")) {
		response.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of request) body += chunk;
	JSON.parse(body);
	requests++;
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	response.flushHeaders();
	finishModel = () => {
		for (const [delta, reason] of [
			[{ role: "assistant", content: "隐藏后任务完成" }, null],
			[{}, "stop"],
		])
			response.write(
				`data: ${JSON.stringify({ id: "tray", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
			);
		response.end("data: [DONE]\n\n");
	};
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
				models: [{ id: "fixture", contextWindow: 128000, maxTokens: 4096 }],
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
	ANIAO_DEFAULT_PROVIDER_FILE: join(artifacts, "absent.json"),
	ANIAO_UPDATE_URL: `${base}/updates/`,
};
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "PI_PACKAGE_DIR", "NODE_OPTIONS", "NODE_PATH"])
	delete environment[key];
if (!packaged) environment.ELECTRON_RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
async function poll(read, message) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (await read()) return;
		await delay(50);
	}
	throw new Error(message);
}
async function nativeState() {
	return application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes("startup.html"));
		return window
			? {
					id: window.id,
					contentsId: window.webContents.id,
					visible: window.isVisible(),
					destroyed: window.isDestroyed(),
				}
			: null;
	});
}
try {
	application = await _electron.launch({
		executablePath,
		args,
		env: environment,
		cwd: packaged ? dirname(executablePath) : root,
		timeout: 60000,
	});
	// 1.1 记录原生菜单用于调用真实菜单项，不修改产品行为。
	await application.evaluate(({ Tray }) => {
		globalThis.harnessTrayMenus = [];
		const original = Tray.prototype.setContextMenu;
		Tray.prototype.setContextMenu = function (menu) {
			globalThis.harnessTrayMenus.push(menu);
			return original.call(this, menu);
		};
	});
	const log = createWriteStream(join(artifacts, "electron.log"));
	application.process().stdout.pipe(log, { end: false });
	application.process().stderr.pipe(log, { end: false });
	application.process().once("exit", () => log.end());
	await poll(async () => {
		page = application
			.windows()
			.find(
				(item) =>
					!item.url().includes("startup.html") &&
					item.url().startsWith(packaged ? "file:" : environment.ELECTRON_RENDERER_URL),
			);
		return !!page;
	}, "工作台未就绪");
	page.on("pageerror", (error) => failures.push(error.message));
	await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).waitFor({ timeout: 60000 });
	await poll(
		async () => (await application.evaluate(() => globalThis.harnessTrayMenus.length)) > 0,
		"未捕获原生托盘菜单",
	);
	const runtime = await application.evaluate(({ app }) => ({
		version: app.getVersion(),
		platform: process.platform,
		packaged: app.isPackaged,
	}));
	await application.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	await poll(
		async () => (await page.evaluate(() => window.piDesktop.getSnapshot()))?.run.phase === "idle",
		"宿主未就绪",
	);
	const identity = await page.evaluate(() => window.piDesktop.getSnapshot());
	const original = await nativeState();
	checks.push("real-native-tray-created");
	logger.info("托盘完整流程验收准备结束");

	/*
	 * ========================================================================
	 * 步骤2：关闭主窗口后等待原任务结束再恢复
	 * ========================================================================
	 * 数据源：实际关闭 IPC、原窗口身份、SDK 快照与受控回复。
	 * 操作：1) 隐藏不停止任务；2) 托盘菜单恢复相同页面、会话与草稿。
	 */
	logger.info("开始验证托盘驻留与任务保持");
	await page.locator("textarea").fill("托盘任务测试");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await poll(
		async () => requests === 1 && (await page.evaluate(() => window.piDesktop.getSnapshot())).run.phase === "working",
		"模型任务没有启动",
	);
	await page.evaluate(() => window.piDesktop.closeWindow());
	await poll(async () => (await nativeState())?.visible === false, "关闭没有收起到托盘");
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).run.phase, "working");
	finishModel();
	await poll(
		async () => (await page.evaluate(() => window.piDesktop.getSnapshot())).run.phase === "idle",
		"隐藏时任务没有正常结束",
	);
	await poll(
		async () =>
			/隐藏后任务完成/.test(JSON.stringify((await page.evaluate(() => window.piDesktop.getSnapshot())).messages)),
		"隐藏任务回复未保存",
	);
	const current = await page.evaluate(() => window.piDesktop.getSnapshot());
	const draft = await page.evaluate(async (sessionId) => {
		const current = await window.piDesktop.loadDraft(sessionId);
		return window.piDesktop.saveDraft({ sessionId, revision: current.revision, text: "托盘保留的中文草稿" });
	}, current.sessionId);
	await application.evaluate(() => {
		const menu = globalThis.harnessTrayMenus.at(-1);
		menu.items.find((item) => item.label === "打开 Aniao Harness").click();
	});
	await poll(async () => (await nativeState())?.visible, "托盘菜单没有恢复原窗口");
	assert.deepEqual(await nativeState(), original);
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).generation, identity.generation);
	assert.equal((await page.evaluate((id) => window.piDesktop.loadDraft(id), current.sessionId)).text, draft.text);
	checks.push("close-hides-original-window", "task-finishes-while-hidden", "tray-menu-restores-same-session-and-draft");
	logger.info("托盘驻留与任务保持验证结束");

	/*
	 * ========================================================================
	 * 步骤3：再次启动恢复、真正退出与数据重启
	 * ========================================================================
	 * 数据源：真实第二实例、托盘退出菜单及独立磁盘目录。
	 * 操作：1) 不创建第二窗口；2) 真正退出后保留历史，不重放任务。
	 */
	logger.info("开始验证再次启动与真正退出");
	await page.evaluate(() => window.piDesktop.closeWindow());
	await poll(async () => !(await nativeState())?.visible, "第二次关闭没有隐藏");
	const second = spawn(executablePath, args, {
		cwd: packaged ? dirname(executablePath) : root,
		env: environment,
		stdio: "ignore",
		windowsHide: true,
	});
	const secondExit = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			second.kill();
			reject(new Error("第二实例没有退出"));
		}, 20000);
		second.once("error", reject);
		second.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
	assert.equal(secondExit, 0);
	await poll(async () => (await nativeState())?.visible, "再次启动没有恢复主窗口");
	assert.deepEqual(await nativeState(), original);
	assert.equal(requests, 1);
	checks.push("second-instance-restores-original-window");
	await page.evaluate(() => window.piDesktop.closeWindow());
	await poll(async () => !(await nativeState())?.visible, "退出前隐藏失败");
	const exited = application.waitForEvent("close", { timeout: 20000 });
	await application.evaluate(() => {
		setTimeout(
			() =>
				globalThis.harnessTrayMenus
					.at(-1)
					.items.find((item) => item.label === "退出")
					.click(),
			0,
		);
	});
	await exited;
	application = undefined;
	assert((await readFile(join(profile, "workspace", "index.json"), "utf8")).includes(current.sessionId));
	checks.push("tray-exit-runs-normal-shutdown");
	assert.deepEqual(failures, []);
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, runtime, checks, failures, modelRequests: requests }, null, 2),
	);
	logger.info(JSON.stringify({ passed: true, runtime, checks, artifacts }));
	logger.info("再次启动与真正退出验证结束");
} catch (error) {
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: false, error: String(error), checks, failures, modelRequests: requests }, null, 2),
	);
	throw error;
} finally {
	await application?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((ready) => server.close(ready));
	logger.info("托盘完整流程验收结束");
}
