import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `workflows-${Date.now()}`);
const project = join(artifacts, "中文 项目");
const agentDirectory = join(artifacts, "agent");
const profile = join(artifacts, "profile");
let application;
let page;
let requests = 0;
const failures = [];
const results = [];
const packagedExecutable = process.env.PI_GUI_PACKAGED_EXECUTABLE;
const environment = {
	...process.env,
	PI_CODING_AGENT_DIR: agentDirectory,
	ANIAO_DEFAULT_PROVIDER_FILE: join(artifacts, "absent-provider.json"),
	ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173",
};
delete environment.ELECTRON_RUN_AS_NODE;
if (packagedExecutable) delete environment.ELECTRON_RENDERER_URL;
if (packagedExecutable) {
	delete environment.PI_PACKAGE_DIR;
	delete environment.NODE_PATH;
	delete environment.NODE_OPTIONS;
}
if (process.env.PI_GUI_TEST_PATH) {
	for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
	environment.Path = process.env.PI_GUI_TEST_PATH;
}

/*
 * ========================================================================
 * 步骤1：创建独立项目和本机模型替身
 * ========================================================================
 * 数据源：临时 Git 仓库与确定性 SSE，不读取用户认证。
 * 操作：1) 所有写入留在 artifacts；2) 只允许本机网络请求。
 */
logger.info("开始准备高级工作流验收");
await Promise.all([project, agentDirectory, profile].map((path) => mkdir(path, { recursive: true })));
// 1.1 Git fixture 不使用用户仓库、钩子和签名。
async function git(...args) {
	return execute("git", args, { cwd: project, encoding: "utf8", windowsHide: true });
}
await git("init");
await git("config", "user.name", "GUI Offline");
await git("config", "user.email", "offline@example.invalid");
await git("config", "core.hooksPath", join(artifacts, "no-hooks"));
await git("config", "commit.gpgsign", "false");
await git("config", "core.autocrlf", "false");
await writeFile(join(project, "README.md"), "baseline\n", "utf8");
await git("add", "--", "README.md");
await git("commit", "-m", "offline fixture");
const server = createServer(async (request, response) => {
	if (!request.url?.endsWith("/chat/completions")) {
		response.writeHead(404).end();
		return;
	}
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	requests += 1;
	const lastUser = [...input.messages].reverse().find((message) => message.role === "user");
	const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
	if (text.includes("offline-failure")) {
		response
			.writeHead(400, { "Content-Type": "application/json" })
			.end(JSON.stringify({ error: { message: "offline workflow failure", type: "invalid_request_error" } }));
		return;
	}
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const chunk = (delta, finish_reason = null) =>
		response.write(
			`data: ${JSON.stringify({ id: "workflow", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	// 1.2 计划分析只输出文本；批准或并行任务才请求真实 SDK write 工具。
	if ((text.includes("执行以下已批准") || text.includes("parallel-write")) && input.messages.at(-1)?.role !== "tool") {
		chunk({
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: "write-fixture",
					type: "function",
					function: {
						name: "write",
						arguments: JSON.stringify({
							path: text.includes("parallel-write") ? "isolated.txt" : "plan-output.txt",
							content: "offline verified\n",
						}),
					},
				},
			],
		});
		chunk({}, "tool_calls");
	} else {
		chunk({
			role: "assistant",
			content: text.includes("计划模式")
				? "1. Read the project\n2. Write plan-output.txt after approval"
				: "offline workflow complete",
		});
		chunk({}, "stop");
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
			"workflow-offline": {
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-completions",
				apiKey: "offline-fixture",
				models: [
					{
						id: "fixture",
						name: "离线工作流",
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
	"utf8",
);
await writeFile(
	join(agentDirectory, "settings.json"),
	JSON.stringify({ defaultProvider: "workflow-offline", defaultModel: "fixture", retry: { enabled: false } }),
	"utf8",
);
environment.ANIAO_UPDATE_URL = `http://127.0.0.1:${address.port}/updates/`;
logger.info("高级工作流验收准备结束");

async function launch(executable = packagedExecutable) {
	application = await _electron.launch({
		executablePath: executable ?? electronExecutable,
		args: [...(executable ? [] : [join(root, "dist/main/index.cjs")]), `--user-data-dir=${profile}`],
		cwd: artifacts,
		env: environment,
		timeout: 60000,
	});
	const log = createWriteStream(join(artifacts, "electron.log"), { flags: "a" });
	application.process().stdout.pipe(log, { end: false });
	application.process().stderr.pipe(log, { end: false });
	application.process().once("exit", () => log.end());
	// 5.3 启动页与主窗共存时，明确等待工作台页面，不把品牌页当成聊天页。
	let page;
	const deadline = Date.now() + 60000;
	while (!page) {
		page = application.windows().find((candidate) => {
			const url = candidate.url();
			return url.length > 0 && url !== "about:blank" && !new URL(url).pathname.endsWith("/startup.html");
		});
		if (Date.now() > deadline) throw new Error("等待工作台窗口超时");
		if (!page) await delay(50);
	}
	page.setDefaultTimeout(30000);
	page.on("pageerror", (error) => failures.push(error.message));
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (["http:", "https:"].includes(url.protocol) && !["localhost", "127.0.0.1"].includes(url.hostname))
			failures.push(`Unexpected remote resource: ${url.origin}`);
	});
	return page;
}

async function poll(page, condition, argument, timeout = 90000) {
	const deadline = Date.now() + timeout;
	while (!(await page.evaluate(condition, argument))) {
		if (Date.now() > deadline) throw new Error("等待桌面状态超时");
		await delay(100);
	}
}

/*
 * ========================================================================
 * 步骤2：验证真实窗口、Git 保护和工作树关联
 * ========================================================================
 * 数据源：preload、主进程、utilityProcess 和真实 SDK。
 * 操作：1) 拒绝旧差异；2) 创建后直接打开工作树。
 */
logger.info("开始验证工程工作流");
try {
	page = await launch(process.env.PI_GUI_PREVIOUS_EXECUTABLE ?? packagedExecutable);
	await page.getByRole("heading", { name: "打开项目，开始工作" }).waitFor();
	await application.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	await poll(page, async () => (await window.piDesktop.getSnapshot())?.run.phase === "idle");
	if (process.env.PI_GUI_PREVIOUS_EXECUTABLE) {
		/*
		 * ========================================================================
		 * 步骤5：从旧版本数据目录启动新打包版本
		 * ========================================================================
		 * 数据源：旧版本生成的真实 JSONL、认证和草稿，不接触用户目录。
		 * 操作：1) 旧版本保存数据；2) 新版本原样恢复并继续后续验收。
		 */
		logger.info("开始验证版本替换后的数据恢复");
		// 5.1 在旧包中保存认证、历史与中文草稿。
		await page.evaluate(async () => {
			const snapshot = await window.piDesktop.getSnapshot();
			await window.piDesktop.dispatch({
				requestId: crypto.randomUUID(),
				sessionId: snapshot.sessionId,
				generation: snapshot.generation,
				command: { type: "setApiKey", provider: "workflow-offline", key: "offline-upgrade-key" },
			});
		});
		await page.locator("textarea").fill("upgrade history fixture");
		await page.getByRole("button", { name: "发送任务", exact: true }).click();
		await poll(page, async () => {
			const snapshot = await window.piDesktop.getSnapshot();
			return snapshot.run.phase === "idle" && snapshot.messages.some((message) => message.role === "assistant");
		});
		const previous = await page.evaluate(() => window.piDesktop.getSnapshot());
		await page.locator("textarea").fill("升级后保留的草稿 中文");
		await poll(
			page,
			async (id) => (await window.piDesktop.loadDraft(id)).text === "升级后保留的草稿 中文",
			previous.sessionId,
		);
		await application.close();
		// 5.2 替换为新包，仍使用同一个独立数据目录。
		page = await launch();
		await poll(page, async () => (await window.piDesktop.getSnapshot())?.run.phase === "idle");
		const restored = await page.evaluate(() => window.piDesktop.getSnapshot());
		assert.equal(restored.sessionId, previous.sessionId);
		assert.deepEqual(
			restored.messages.map((message) => message.blocks),
			previous.messages.map((message) => message.blocks),
		);
		await poll(page, (text) => document.querySelector("textarea")?.value === text, "升级后保留的草稿 中文");
		assert.equal(await page.locator("textarea").inputValue(), "升级后保留的草稿 中文");
		assert.equal(
			JSON.parse(await readFile(join(agentDirectory, "auth.json"), "utf8"))["workflow-offline"].key,
			"offline-upgrade-key",
		);
		await page.locator("textarea").fill("");
		results.push("previous package history, credentials and Chinese draft restored by candidate package");
		logger.info("版本替换后的数据恢复验证结束");
	}
	// 2.1 同一 M 状态下再次编辑，旧还原请求必须失败且保留新内容。
	await writeFile(join(project, "README.md"), "viewed\n", "utf8");
	const stale = await page.evaluate(async () => {
		const current = await window.piDesktop.getSnapshot();
		const status = await window.piDesktop.gitStatus(current.cwd);
		const diff = await window.piDesktop.gitDiff({ cwd: current.cwd, path: "README.md", staged: false });
		return {
			cwd: current.cwd,
			path: "README.md",
			action: "discard",
			expectedHead: status.head,
			expectedIndex: status.files[0].index,
			expectedWorktree: status.files[0].worktree,
			expectedVersion: diff.version,
		};
	});
	await writeFile(join(project, "README.md"), "later edit 中文\n", "utf8");
	const rejection = await page.evaluate(async (request) => {
		try {
			await window.piDesktop.gitMutate(request);
			return "";
		} catch (error) {
			return error.message;
		}
	}, stale);
	assert(rejection.includes("内容已变化"));
	assert.equal(await readFile(join(project, "README.md"), "utf8"), "later edit 中文\n");
	results.push("stale diff rejected; later edit retained");
	// 2.2 用工作树界面创建和打开，不预先登记新目录。
	await page.getByRole("button", { name: "展开右侧面板", exact: true }).click();
	await page.locator(".side-tool").filter({ hasText: "变更" }).click();
	await page.getByRole("button", { name: "工作树", exact: true }).click();
	await page.getByPlaceholder("feature/my-change").fill("codex/workflow-review");
	await page.getByRole("button", { name: "创建工作树", exact: true }).click();
	const row = page.locator(".worktree-row").filter({ hasText: "codex/workflow-review" });
	await row.getByRole("button", { name: "打开", exact: true }).click();
	await poll(page, async () => (await window.piDesktop.getSnapshot())?.cwd.includes("codex-workflow-review"));
	const current = await page.evaluate(() => window.piDesktop.getSnapshot());
	const worktree = current.cwd;
	assert.notEqual(resolve(worktree), resolve(project));
	assert.equal((await readFile(join(worktree, "README.md"), "utf8")).replaceAll("\r\n", "\n"), "baseline\n");
	results.push("new worktree opened with independent session and clean HEAD");
	await page.screenshot({ path: join(artifacts, "01-worktree.png"), scale: "css" });
	logger.info("工程工作流验证结束");

	/*
	 * ========================================================================
	 * 步骤3：验证计划持久化和批准边界
	 * ========================================================================
	 * 数据源：实际模型替身响应、原子计划记录和重启窗口。
	 * 操作：1) 修改保存后重启；2) 明确批准后才调用写工具。
	 */
	logger.info("开始验证计划重启恢复");
	await page.getByRole("button", { name: "切换计划模式", exact: true }).click();
	await page.locator("textarea").fill("先生成计划");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByLabel("待确认计划", { exact: true }).waitFor();
	await page.getByLabel("待确认计划", { exact: true }).fill("write plan-output.txt after approval 中文");
	await page.getByRole("button", { name: "保存修改", exact: true }).click();
	await poll(page, async () => (await window.piDesktop.getSnapshot()).plan?.text.includes("中文"));
	const beforeRestart = requests;
	await application.close();
	page = await launch();
	await page.getByLabel("待确认计划", { exact: true }).waitFor();
	assert.equal(
		await page.getByLabel("待确认计划", { exact: true }).inputValue(),
		"write plan-output.txt after approval 中文",
	);
	assert.equal(requests, beforeRestart);
	await assert.rejects(readFile(join(worktree, "plan-output.txt")));
	await page.getByRole("button", { name: "批准并执行", exact: true }).click();
	await poll(page, async () => (await window.piDesktop.getSnapshot()).plan?.phase === "completed");
	assert.equal(await readFile(join(worktree, "plan-output.txt"), "utf8"), "offline verified\n");
	await assert.rejects(readFile(join(project, "plan-output.txt")));
	results.push("edited plan restored without requests; approval executed real SDK write");
	await page.screenshot({ path: join(artifacts, "02-plan-complete.png"), scale: "css" });
	logger.info("计划重启恢复验证结束");

	/*
	 * ========================================================================
	 * 步骤4：验证并行隔离、失败状态和定时记录
	 * ========================================================================
	 * 数据源：真实后台宿主、独立工作树和本地调度。
	 * 操作：1) 工具只写隔离目录；2) Provider 错误必须显示失败。
	 */
	logger.info("开始验证隔离后台运行");
	const job = await page.evaluate(async () => {
		const snapshot = await window.piDesktop.getSnapshot();
		return window.piDesktop.startParallelJob({ cwd: snapshot.cwd, text: "parallel-write" });
	});
	await poll(
		page,
		async (id) => {
			const job = (await window.piDesktop.listParallelJobs()).find((entry) => entry.id === id);
			return job && !["running", "queued"].includes(job.status);
		},
		job.id,
	);
	const finished = await page.evaluate(
		async (id) => (await window.piDesktop.listParallelJobs()).find((entry) => entry.id === id),
		job.id,
	);
	assert.equal(finished.status, "completed", JSON.stringify(finished));
	assert.notEqual(resolve(finished.executionCwd), resolve(worktree));
	assert.equal(await readFile(join(finished.executionCwd, "isolated.txt"), "utf8"), "offline verified\n");
	await assert.rejects(readFile(join(worktree, "isolated.txt")));
	results.push("parallel task wrote only inside its own worktree");
	const failed = await page.evaluate(async () => {
		const snapshot = await window.piDesktop.getSnapshot();
		return window.piDesktop.startParallelJob({ cwd: snapshot.cwd, text: "offline-failure" });
	});
	await poll(
		page,
		async (id) => (await window.piDesktop.listParallelJobs()).find((entry) => entry.id === id)?.status === "failed",
		failed.id,
	);
	results.push("provider error recorded as failed");
	const scheduled = await page.evaluate(async () => {
		const snapshot = await window.piDesktop.getSnapshot();
		const tasks = await window.piDesktop.createSchedule({
			cwd: snapshot.cwd,
			text: "offline-failure",
			everyMinutes: 5,
			catchUp: false,
		});
		return tasks.tasks[0];
	});
	await page.evaluate((id) => window.piDesktop.runScheduleNow(id), scheduled.id);
	await poll(
		page,
		async (id) =>
			(await window.piDesktop.listSchedules()).runs.some((run) => run.taskId === id && run.status === "failed"),
		scheduled.id,
	);
	await page.getByRole("button", { name: "自动化任务", exact: true }).click();
	await page.getByText("offline workflow failure", { exact: false }).first().waitFor();
	await page.screenshot({ path: join(artifacts, "03-automation.png"), scale: "css" });
	results.push("scheduled failure retained and displayed");
	/*
	 * ========================================================================
	 * 步骤6：验证打包后的 PTY 和退出回收
	 * ========================================================================
	 * 数据源：真实 node-pty、Windows shell 和 Electron 进程指标。
	 * 操作：1) 停止 Agent 不关闭用户终端；2) 窗口退出后检查受管进程消失。
	 */
	logger.info("开始验证独立终端和退出回收");
	// 6.1 终端真实输出与退出事件经 preload 往返，不依赖全局 Node。
	const terminal = await page.evaluate(async () => {
		window.__workflowTerminal = { output: "", exited: false };
		window.__workflowTerminalRelease = window.piDesktop.subscribeTerminal((event) => {
			if (event.type === "data") window.__workflowTerminal.output += event.data;
			else window.__workflowTerminal.exited = true;
		});
		const snapshot = await window.piDesktop.getSnapshot();
		const terminal = await window.piDesktop.terminalCreate({ cwd: snapshot.cwd, cols: 80, rows: 24 });
		await window.piDesktop.dispatch({
			requestId: crypto.randomUUID(),
			sessionId: snapshot.sessionId,
			generation: snapshot.generation,
			command: { type: "abort" },
		});
		window.piDesktop.terminalWrite({ id: terminal.id, data: "Write-Output 'PTY_OFFLINE_VERIFIED'\r" });
		return terminal;
	});
	await poll(page, () => (window.__workflowTerminal.output.match(/PTY_OFFLINE_VERIFIED/g) ?? []).length >= 2);
	await page.evaluate((id) => window.piDesktop.terminalClose({ id }), terminal.id);
	await poll(page, () => window.__workflowTerminal.exited);
	await page.evaluate(() => window.__workflowTerminalRelease());
	results.push("packaged PTY output and close verified; Agent abort left terminal usable");
	assert.deepEqual(failures, []);
	const metrics = await application.evaluate(({ app }) => app.getAppMetrics().map((entry) => entry.pid));
	await application.close();
	application = undefined;
	// 6.2 只检查本次应用报告的 PID，不触碰其他桌面进程。
	let live = metrics;
	for (let attempt = 0; attempt < 50 && live.length; attempt++) {
		live = live.filter((pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		});
		if (live.length) await delay(100);
	}
	assert.deepEqual(live, [], "验收窗口退出后仍有受管进程");
	results.push("Electron reported child processes exited after closing");
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, results, requests, failures, worktree: await realpath(worktree) }, null, 2),
		"utf8",
	);
	logger.info("隔离后台运行验证结束");
	logger.info("独立终端和退出回收验证结束");
	logger.info(JSON.stringify({ passed: true, results, artifacts }));
} catch (error) {
	await page?.screenshot({ path: join(artifacts, "failure.png"), scale: "css" }).catch(() => {});
	await writeFile(join(artifacts, "failure.html"), (await page?.content().catch(() => "")) ?? "", "utf8");
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: false, results, requests, failures, error: String(error) }, null, 2),
		"utf8",
	);
	throw error;
} finally {
	await application?.close().catch(() => {});
	await new Promise((done) => server.close(done));
}
