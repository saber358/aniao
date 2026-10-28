import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `platform-${process.platform}-${Date.now()}`);
const project = join(artifacts, "中文 项目");
const agentDirectory = join(artifacts, "agent");
const profile = join(artifacts, "profile");
const executablePath = process.env.PI_GUI_PACKAGED_EXECUTABLE;
const checks = [];
const failures = [];
let application;
let page;
let modelRequests = 0;

/*
 * ========================================================================
 * 步骤1：以独立配置启动真实目标平台安装包
 * ========================================================================
 * 数据源：已打包程序、本机模型替身和中文项目目录。
 * 操作：1) 不访问用户账号；2) 验证系统、架构、宿主和原生终端。
 */
logger.info("开始准备桌面平台验收");
assert(executablePath, "必须指定已打包程序");
await Promise.all([project, agentDirectory, profile].map((path) => mkdir(path, { recursive: true })));
const server = createServer(async (request, response) => {
	if (!request.url?.endsWith("/chat/completions")) {
		response.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of request) body += chunk;
	const input = JSON.parse(body);
	modelRequests++;
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const send = (delta, finish_reason = null) =>
		response.write(
			`data: ${JSON.stringify({ id: "platform", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	if (input.messages.some((message) => message.role === "tool")) {
		send({ role: "assistant", content: "平台验证完成" });
		send({}, "stop");
	} else {
		send({
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: "platform-write",
					type: "function",
					function: { name: "write", arguments: JSON.stringify({ path: "平台输出.txt", content: "桌面工具正常\n" }) },
				},
			],
		});
		send({}, "tool_calls");
	}
	response.end("data: [DONE]\n\n");
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert(address && typeof address === "object");
await writeFile(
	join(agentDirectory, "models.json"),
	JSON.stringify({
		providers: {
			"platform-offline": {
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-completions",
				apiKey: "offline-fixture",
				models: [
					{
						id: "fixture",
						name: "平台离线验收",
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
		defaultProvider: "platform-offline",
		defaultModel: "fixture",
		retry: { enabled: false },
		compaction: { enabled: false },
	}),
);
const environment = {
	...process.env,
	PI_CODING_AGENT_DIR: agentDirectory,
	ANIAO_DEFAULT_PROVIDER_FILE: join(artifacts, "no-default-provider.json"),
	ANIAO_UPDATE_URL: `http://127.0.0.1:${address.port}/updates/`,
};
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "PI_PACKAGE_DIR", "NODE_OPTIONS", "NODE_PATH"])
	delete environment[key];
try {
	application = await _electron.launch({
		executablePath,
		args: [`--user-data-dir=${profile}`],
		env: environment,
		cwd: dirname(executablePath),
		timeout: 60000,
	});
	const log = createWriteStream(join(artifacts, "electron.log"));
	application.process().stdout.pipe(log, { end: false });
	application.process().stderr.pipe(log, { end: false });
	application.process().once("exit", () => log.end());
	const deadline = Date.now() + 60000;
	while (!page && Date.now() < deadline) {
		page = application
			.windows()
			.find((candidate) => candidate.url().startsWith("file:") && !candidate.url().includes("startup.html"));
		if (!page) await delay(50);
	}
	assert(page, "未找到平台工作台");
	page.setDefaultTimeout(20000);
	page.on("pageerror", (error) => failures.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" || (message.type() === "warning" && message.text().startsWith("[Vue warn]")))
			failures.push(message.text().slice(0, 250));
	});
	await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).waitFor();
	const runtime = await application.evaluate(({ app }) => ({
		platform: process.platform,
		arch: process.arch,
		packaged: app.isPackaged,
		version: app.getVersion(),
		electron: process.versions.electron,
	}));
	assert.equal(runtime.platform, process.platform);
	assert.equal(runtime.arch, "x64");
	assert.equal(runtime.packaged, true);
	checks.push("native-platform-and-x64", "packaged-startup");
	await application.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	const opened = await waitSnapshot((snapshot) => snapshot.run.phase === "idle");
	assert.equal(opened.cwd.replaceAll("\\", "/"), project.replaceAll("\\", "/"));
	assert.equal(modelRequests, 0);
	assert.equal(await page.locator(".session-running-spinner").count(), 0);
	checks.push("sdk-host-ready", "opening-does-not-run");

	/*
	 * ========================================================================
	 * 步骤2：验证终端与 Agent 实际工具往返
	 * ========================================================================
	 * 数据源：目标系统的 shell、真实 node-pty 和离线 SDK 写文件请求。
	 * 操作：1) shell 计算结果而非输入回显；2) 模型往返后检查落盘内容。
	 */
	logger.info("开始验证平台终端与工具");
	await page.evaluate(async () => {
		window.platformTerminalEvents = [];
		window.platformTerminalRelease = window.piDesktop.subscribeTerminal((event) =>
			window.platformTerminalEvents.push(event),
		);
		const current = await window.piDesktop.getSnapshot();
		window.platformTerminal = await window.piDesktop.terminalCreate({ cwd: current.cwd, cols: 80, rows: 24 });
	});
	const command =
		process.platform === "win32" ? '[Console]::WriteLine("RESULT_" + (6 * 7))\r' : "printf 'RESULT_%s\\n' $((6 * 7))\r";
	await page.evaluate((data) => window.piDesktop.terminalWrite({ id: window.platformTerminal.id, data }), command);
	await page.waitForFunction(() =>
		window.platformTerminalEvents.some((event) => event.type === "data" && event.data.includes("RESULT_42")),
	);
	await page.evaluate(() => {
		window.piDesktop.terminalClose({ id: window.platformTerminal.id });
		window.platformTerminalRelease();
	});
	checks.push("native-pty-shell-result");
	await page.locator("textarea").fill("平台验收，写入文件");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByText("平台验证完成", { exact: true }).waitFor();
	await waitSnapshot((snapshot) => snapshot.run.phase === "idle");
	assert.equal(await readFile(join(project, "平台输出.txt"), "utf8"), "桌面工具正常\n");
	assert.equal(modelRequests, 2);
	await page.locator("textarea").fill("平台草稿保留");
	await page.reload();
	await page.waitForFunction(() => document.querySelector("textarea")?.value === "平台草稿保留");
	assert.equal(modelRequests, 2);
	checks.push("sdk-tool-write-roundtrip", "utf8-file-content", "renderer-draft-recovery", "reload-does-not-replay");
	await page.screenshot({ path: join(artifacts, "desktop.png"), fullPage: true });
	assert.deepEqual(failures, []);
	await application.close();
	application = undefined;
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, runtime, checks, failures, modelRequests }, null, 2),
	);
	logger.info(JSON.stringify({ passed: true, runtime, checks, artifacts }));
} catch (error) {
	await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: false, error: String(error), checks, failures, modelRequests }, null, 2),
	);
	throw error;
} finally {
	await application?.close().catch(() => {});
	await new Promise((finish) => {
		server.close(finish);
		server.closeAllConnections();
	});
	logger.info("桌面平台验收结束");
}

async function waitSnapshot(check) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		const value = await page.evaluate(() => window.piDesktop.getSnapshot());
		if (value && check(value)) return value;
		await delay(50);
	}
	throw new Error("等待目标平台会话快照超时");
}
