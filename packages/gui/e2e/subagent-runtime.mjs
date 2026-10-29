import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.PI_GUI_SUBAGENT_OUTPUT ?? join(root, "artifacts", `subagent-runtime-${Date.now()}`);
const plugin = process.env.PI_GUI_SUBAGENT_PLUGIN_PATH;
assert(plugin, "请用 PI_GUI_SUBAGENT_PLUGIN_PATH 指定已安装的 pi-subagents 包目录");
const agent = join(output, "agent");
const project = join(output, "中文 项目");
const runs = join(output, "subagents", "async-subagent-runs");
const checks = [];
const failures = [];
const children = [];
const parentReceipts = new Map();
const toolResults = [];
const dispatched = new Set();
const cases = (process.env.PI_GUI_SUBAGENT_CASES ?? "foreground,background,parallel").split(",");
let application;
let page;
let runtime;
let requests = 0;

/*
 * ========================================================================
 * 步骤1：准备真实插件与本地模型服务
 * ========================================================================
 * 数据源：已安装的插件包、隔离配置和固定文本文件。
 * 操作：1) 子代理经过真实 SDK 和工具循环；2) 不读取用户凭据或调用付费模型。
 */
logger.info("开始准备子代理运行验收");
const pluginManifest = JSON.parse(await readFile(join(plugin, "package.json"), "utf8"));
assert.equal(pluginManifest.name, "pi-subagents");
await Promise.all([agent, project, join(agent, "extensions/subagent")].map((path) => mkdir(path, { recursive: true })));
await writeFile(join(project, "fixture.txt"), "HARNESS_SUBAGENT_FILE_OK\n", "utf8");
await writeFile(join(agent, "extensions/subagent/config.json"), JSON.stringify({ toolActivation: "eager" }));
await writeFile(
	join(project, "parallel.js"),
	'const results = await runs.all([{key:"left",agent:"delegate",task:"HARNESS_SUBAGENT_CHILD:left",model:"offline/fixture",context:"fresh"},{key:"right",agent:"delegate",task:"HARNESS_SUBAGENT_CHILD:right",model:"offline/fixture",context:"fresh"}]); return results.map(item => item.output);',
	"utf8",
);
const server = createServer(async (request, response) => {
	if (request.url !== "/v1/chat/completions") return response.writeHead(404).end();
	try {
		let body = "";
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body);
		requests++;
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const send = (delta, finish_reason = null) =>
			response.write(
				`data: ${JSON.stringify({ id: "subagent-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
			);
		const users = JSON.stringify(input.messages.filter((message) => message.role === "user"));
		const parent = /HARNESS_SUBAGENT_PARENT:([a-z]+)/u.exec(users)?.[1];
		const child = parent ? undefined : /HARNESS_SUBAGENT_CHILD:([a-z]+)/u.exec(users)?.[1];
		if (parent) parentReceipts.set(parent, JSON.stringify(input.messages));
		const tool = input.messages.findLast((message) => message.role === "tool");
		if (child) {
			// 1.1 先读真实文件，再让子会话输出固定结果，验证工具回传也可用。
			if (tool?.content?.includes("HARNESS_SUBAGENT_FILE_OK")) {
				children.push(child);
				send({ role: "assistant", content: `CHILD_OK:${child}` });
				send({}, "stop");
			} else {
				send({
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `read-${requests}`,
							type: "function",
							function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) },
						},
					],
				});
				send({}, "tool_calls");
			}
		} else if (parent && !dispatched.has(parent)) {
			assert(
				input.tools.some((item) => item.function?.name === "subagent"),
				"真实插件未向模型暴露 subagent 工具",
			);
			dispatched.add(parent);
			const parameters =
				parent === "parallel"
					? { workflow: "./parallel.js", async: true, model: "offline/fixture", options: { mission: false } }
					: {
							agent: "delegate",
							task: `HARNESS_SUBAGENT_CHILD:${parent}`,
							async: parent !== "foreground",
							model: "offline/fixture",
							options: { context: "fresh" },
						};
			send({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: `subagent-${parent}`,
						type: "function",
						function: { name: "subagent", arguments: JSON.stringify(parameters) },
					},
				],
			});
			send({}, "tool_calls");
		} else {
			if (tool) toolResults.push({ parent, content: tool.content });
			send({ role: "assistant", content: `PARENT_OK:${parent ?? "completion"}` });
			send({}, "stop");
		}
		response.end("data: [DONE]\n\n");
	} catch (error) {
		failures.push(String(error));
		response.end();
	}
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
				models: [{ id: "fixture", contextWindow: 128000, maxTokens: 4096, input: ["text"] }],
			},
		},
	}),
);
await writeFile(
	join(agent, "settings.json"),
	JSON.stringify({
		defaultProvider: "offline",
		defaultModel: "fixture",
		packages: [resolve(plugin)],
		retry: { enabled: false },
		compaction: { enabled: false },
	}),
);
logger.info("子代理运行验收准备结束");

async function poll(read, message, timeout = 45000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await read();
		if (value) return value;
		await delay(100);
	}
	throw new Error(message);
}

try {
	/*
	 * ========================================================================
	 * 步骤2：在独立桌面中验证前台、后台和并行子代理
	 * ========================================================================
	 * 数据源：真实 Electron 宿主、插件运行文件和正式详情 IPC。
	 * 操作：1) 核对启动、工具调用、完成与模型；2) 保存可重复核验的结果。
	 */
	logger.info("开始验证真实子代理运行");
	const packaged = process.env.PI_GUI_PACKAGED_EXECUTABLE;
	const environment = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_SUBAGENTS_TEMP_ROOT: join(output, "subagents"),
		ANIAO_DEFAULT_PROVIDER_FILE: join(output, "absent.json"),
		ANIAO_UPDATE_URL: `${base}/updates/`,
	};
	for (const key of [
		"ELECTRON_RUN_AS_NODE",
		"NODE_OPTIONS",
		"NODE_PATH",
		"PI_PACKAGE_DIR",
		"PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
	])
		delete environment[key];
	if (packaged) delete environment.ELECTRON_RENDERER_URL;
	else environment.ELECTRON_RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
	application = await _electron.launch({
		executablePath: packaged ?? electronExecutable,
		args: [...(packaged ? [] : [join(root, "dist/main/index.cjs")]), `--user-data-dir=${join(output, "profile")}`],
		cwd: output,
		env: environment,
		timeout: 60000,
	});
	const log = createWriteStream(join(output, "electron.log"));
	application.process().stdout.pipe(log, { end: false });
	application.process().stderr.pipe(log, { end: false });
	application.process().once("exit", () => log.end());
	await poll(
		async () => {
			page = application
				.windows()
				.find(
					(candidate) =>
						!candidate.url().includes("startup.html") &&
						candidate.url().startsWith(packaged ? "file:" : environment.ELECTRON_RENDERER_URL),
				);
			return page;
		},
		"工作台未就绪",
		60000,
	);
	page.setDefaultTimeout(15000);
	page.on("pageerror", (error) => failures.push(error.message));
	await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).waitFor({ timeout: 60000 });
	// 2.2 保存实际应用版本与插件版本，防止把开发版报告当作安装包验收。
	runtime = await application.evaluate(({ app }) => ({
		version: app.getVersion(),
		packaged: app.isPackaged,
		platform: process.platform,
		arch: process.arch,
	}));
	if (packaged) assert.equal(runtime.packaged, true);
	await application.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	await poll(
		async () => (await page.evaluate(() => window.piDesktop.getSnapshot()))?.run.phase === "idle",
		"宿主未就绪",
	);
	for (const name of cases) {
		logger.info(`开始验收 ${name}`);
		await page.evaluate(async (name) => {
			const state = await window.piDesktop.getSnapshot();
			await window.piDesktop.dispatch({
				requestId: crypto.randomUUID(),
				sessionId: state.sessionId,
				generation: state.generation,
				command: { type: "prompt", text: `HARNESS_SUBAGENT_PARENT:${name}` },
			});
		}, name);
		if (name === "foreground") {
			assert(children.includes(name), `前台子代理未完成：${JSON.stringify(toolResults).slice(-2400)}`);
			assert(
				toolResults.some((item) => item.content.includes("CHILD_OK:foreground")),
				"主会话未收到前台结果",
			);
		} else {
			// 2.1 每个场景使用不同主会话，避免自动完成通知重复提交旧任务。
			const status = await poll(
				async () => {
					for (const id of await readdir(runs).catch(() => [])) {
						const value = await readFile(join(runs, id, "status.json"), "utf8")
							.then(JSON.parse)
							.catch(() => undefined);
						if (!value || value.mode !== (name === "parallel" ? "workflow" : "single")) continue;
						if (["complete", "failed", "partial", "stopped"].includes(value.state)) return value;
					}
				},
				`后台子代理未结束：${JSON.stringify(toolResults).slice(-2400)}`,
			);
			await writeFile(join(output, `${name}-status.json`), JSON.stringify(status, null, 2));
			assert.equal(status.state, "complete", `子代理失败：${status.error ?? JSON.stringify(status).slice(-2000)}`);
			const expected = name === "parallel" ? ["left", "right"] : [name];
			for (const child of expected) assert(children.includes(child), `子代理 ${child} 没有完成文件读取`);
			const inspection = await page.evaluate((id) => window.piDesktop.inspectSubagent(id), status.runId);
			await writeFile(join(output, `${name}-inspection.json`), JSON.stringify(inspection, null, 2));
			assert.equal(inspection.error, undefined, "右栏详情读取失败");
			assert.equal(inspection.status, "complete");
			if (name !== "parallel") {
				assert(inspection.finalOutput.includes(`CHILD_OK:${name}`), "右栏缺少子代理结果");
				assert.deepEqual(inspection.resolvedModel, { provider: "offline", model: "fixture" });
			} else {
				for (const child of expected) {
					const detail = await page.evaluate(({ id, child }) => window.piDesktop.inspectSubagent(id, child), {
						id: status.runId,
						child,
					});
					assert.equal(detail.error, undefined, `并行子代理 ${child} 详情读取失败`);
					assert(detail.finalOutput.includes(`CHILD_OK:${child}`), `并行子代理 ${child} 结果缺失`);
				}
			}
			await poll(
				() => expected.every((child) => parentReceipts.get(name)?.includes(`CHILD_OK:${child}`)),
				"后台完成通知未向主会话回传结果",
			);
		}
		checks.push(`${name}: actual plugin launch, file tool, model reply and result passed`);
		logger.info(`${name} 验收结束`);
		await page.evaluate((cwd) => window.piDesktop.newSessionAt(cwd), project);
		await poll(
			async () => (await page.evaluate(() => window.piDesktop.getSnapshot()))?.run.phase === "idle",
			"下一验收会话未就绪",
		);
	}
	assert.deepEqual(failures, []);
	await writeFile(
		join(output, "results.json"),
		JSON.stringify(
			{ passed: true, runtime, plugin, pluginVersion: pluginManifest.version, checks, children, requests, failures },
			null,
			2,
		),
	);
	logger.info(JSON.stringify({ passed: true, checks, output }));
} catch (error) {
	await page?.screenshot({ path: join(output, "failure.png"), scale: "css" }).catch(() => {});
	await writeFile(
		join(output, "results.json"),
		JSON.stringify(
			{
				passed: false,
				runtime,
				plugin,
				pluginVersion: pluginManifest.version,
				checks,
				children,
				requests,
				failures,
				toolResults,
				error: String(error),
			},
			null,
			2,
		),
	);
	throw error;
} finally {
	await application?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((finish) => server.close(finish));
	logger.info("真实子代理运行验收结束");
}
