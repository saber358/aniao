import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `kernel-1.4.0-${Date.now()}`);
const agentDirectory = join(artifacts, "agent");
const project = join(artifacts, "中文 项目");
const profile = join(artifacts, "profile");
const renderer = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
const packagedExecutable = process.env.PI_GUI_PACKAGED_EXECUTABLE;
const failures = [];
const results = [];
let application;
let page;
let stderr = "";

/*
 * ========================================================================
 * 步骤1：准备升级后真实桌面的独立认证与扩展目录
 * ========================================================================
 * 数据源：本地离线扩展、无效测试凭据和全新项目。
 * 操作：
 *   1) 复用旧扩展的 OAuth 回调，验证新运行时的适配能力
 *   2) 测试不调用模型、不访问认证服务器、不修改真实用户数据
 */
logger.info("开始准备 Pi 内核升级验收");
await Promise.all(
	[project, profile, join(agentDirectory, "extensions")].map((path) => mkdir(path, { recursive: true })),
);
await copyFile(join(root, "e2e/fixtures/portable-extension.mjs"), join(agentDirectory, "extensions/portable.js"));
// 1.4 在真实宿主中核对版本与官方延迟模块，不用开发进程代替安装包。
await writeFile(
	join(agentDirectory, "extensions/kernel-proof.js"),
	`import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, PI_AI_VERSION } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
const logger = console;
/*
 * ========================================================================
 * 步骤1：核对真实宿主版本与延迟认证模块
 * ========================================================================
 * 数据源：官方虚拟模块和预先取消的认证请求。
 * 操作：1) 加载真实模块；2) 仅保存非敏感版本与取消结果。
 */
export default function kernelProof(pi) {
	pi.on("session_start", async () => {
		logger.info("开始核对真实宿主内核");
		try {
			// 1.1 预先取消认证刷新，模块正常加载后不发送网络请求。
			const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
			const cancelled = new AbortController();
			cancelled.abort(new Error("offline-auth-abort"));
			let oauthError = "";
			try {
				await runtime.getProvider("openai-codex").auth.oauth.refresh({ type: "oauth", access: "offline", refresh: "offline", expires: 0 }, cancelled.signal);
			} catch (error) {
				oauthError = error instanceof Error ? error.message : String(error);
			}
			if (!/offline-auth-abort|aborted/i.test(oauthError)) throw new Error("官方 OAuth 延迟模块加载失败：" + oauthError);
			await writeFile(join(getAgentDir(), "kernel-proof.json"), JSON.stringify({ kernel: VERSION, models: PI_AI_VERSION, oauth: "cancelled-after-module-load" }), "utf8");
		} finally {
			logger.info("真实宿主内核核对结束");
		}
	});
}
`,
	"utf8",
);
await writeFile(
	join(agentDirectory, "settings.json"),
	JSON.stringify({ defaultProvider: "gui-kernel", defaultModel: "fixture" }),
	"utf8",
);
await writeFile(
	join(agentDirectory, "models.json"),
	JSON.stringify({
		providers: {
			"gui-kernel": {
				name: "离线内核",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/v1",
				models: [{ id: "fixture" }],
			},
		},
	}),
	"utf8",
);
logger.info("Pi 内核升级验收准备结束");

async function launch() {
	logger.info("开始启动内核验收工作台");
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (
			[
				"electron_run_as_node",
				"electron_renderer_url",
				"localappdata",
				"node_options",
				"node_path",
				"pi_package_dir",
			].includes(key.toLowerCase())
		)
			delete environment[key];
	}
	Object.assign(environment, {
		PI_CODING_AGENT_DIR: agentDirectory,
		ANIAO_DEFAULT_PROVIDER_FILE: join(artifacts, "absent-provider.json"),
		ANIAO_UPDATE_URL: "http://127.0.0.1:65534/updates/",
		LOCALAPPDATA: join(artifacts, "cache"),
	});
	// 1.3 安装包使用自身界面与资源，受限工具路径用于排除开发环境依赖。
	if (!packagedExecutable) environment.ELECTRON_RENDERER_URL = renderer;
	if (process.env.PI_GUI_TEST_PATH) {
		for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
		environment.Path = process.env.PI_GUI_TEST_PATH;
	}
	application = await _electron.launch({
		executablePath: packagedExecutable ?? electronExecutable,
		args: [...(packagedExecutable ? [] : [join(root, "dist/main/index.cjs")]), `--user-data-dir=${profile}`],
		cwd: artifacts,
		env: environment,
		timeout: 60000,
	});
	const log = createWriteStream(join(artifacts, `electron-${Date.now()}.log`));
	application.process().stdout.pipe(log, { end: false });
	application.process().stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	application.process().stderr.pipe(log, { end: false });
	application.process().once("exit", () => log.end());
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		// 1.1 启动页与工作台是不同窗口，禁止把首次出现的启动页当作工作台。
		page = application
			.windows()
			.find(
				(window) =>
					window.url().startsWith(packagedExecutable ? "file:" : renderer) && !window.url().includes("startup.html"),
			);
		if (page) break;
		await delay(50);
	}
	assert(page, "工作台未启动");
	page.setDefaultTimeout(15000);
	page.on("pageerror", (error) => failures.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") failures.push(message.text());
	});
	await page.waitForFunction(() => !!window.piDesktop);
	logger.info("内核验收工作台启动结束");
}

async function send(command) {
	return page.evaluate(async (input) => {
		const snapshot = await window.piDesktop.getSnapshot();
		await window.piDesktop.dispatch({
			requestId: crypto.randomUUID(),
			sessionId: snapshot.sessionId,
			generation: snapshot.generation,
			command: input,
		});
	}, command);
}

async function waitForSnapshot(predicate) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		// 1.2 IPC 查询在 Node 侧等待完成，禁止把浏览器返回的 Promise 当成已就绪状态。
		const snapshot = await page.evaluate(() => window.piDesktop.getSnapshot());
		if (snapshot && predicate(snapshot)) return snapshot;
		await delay(50);
	}
	throw new Error("等待内核会话状态超时");
}

async function login() {
	await page.evaluate(async () => {
		const snapshot = await window.piDesktop.getSnapshot();
		globalThis.kernelLogin = window.piDesktop.dispatch({
			requestId: crypto.randomUUID(),
			sessionId: snapshot.sessionId,
			generation: snapshot.generation,
			command: { type: "login", provider: "gui-offline-oauth" },
		});
	});
	await page.getByRole("dialog", { name: "登录方式", exact: true }).waitFor();
}

try {
	/*
	 * ========================================================================
	 * 步骤2：验证新模型运行时的配置与凭据同步
	 * ========================================================================
	 * 数据源：真实 IPC、CredentialStore 与本机 models.json。
	 * 操作：
	 *   1) 保存后立即刷新可用模型，退出重启保留凭据
	 *   2) 删除后保留其他服务商，自定义配置与本地凭据同步移除
	 */
	logger.info("开始验证新内核模型与认证操作");
	await launch();
	await application.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	await waitForSnapshot((snapshot) => snapshot.run.phase === "idle");
	// 2.1 真实扩展在当前 utilityProcess 中核对版本，防止旧工作区内核混入。
	const proofDeadline = Date.now() + 30000;
	let proof;
	while (Date.now() < proofDeadline) {
		proof = await readFile(join(agentDirectory, "kernel-proof.json"), "utf8").catch(() => undefined);
		if (proof) break;
		await delay(50);
	}
	assert(proof, "真实宿主内核证明未生成");
	assert.deepEqual(JSON.parse(proof), { kernel: "1.4.0", models: "1.4.0", oauth: "cancelled-after-module-load" });
	await send({ type: "setApiKey", provider: "gui-kernel", key: "offline-kernel-key" });
	await waitForSnapshot((snapshot) =>
		snapshot.configuration.models.some((model) => model.key === "gui-kernel/fixture" && model.available),
	);
	await send({
		type: "saveProvider",
		provider: {
			id: "gui-added",
			name: "新内核新增",
			baseUrl: "http://127.0.0.1:1/v1",
			api: "openai-completions",
			models: ["added-model"],
			reasoning: true,
			apiKey: "offline-added-key",
		},
	});
	let snapshot = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert(snapshot.configuration.models.some((model) => model.key === "gui-added/added-model" && model.available));
	assert(!JSON.stringify(snapshot).includes("offline-added-key"));
	await send({ type: "deleteProvider", provider: "gui-added" });
	snapshot = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert(!snapshot.configuration.models.some((model) => model.provider === "gui-added"));
	const stored = JSON.parse(await readFile(join(agentDirectory, "auth.json"), "utf8"));
	assert.equal(stored["gui-kernel"].key, "offline-kernel-key");
	assert.equal(stored["gui-added"], undefined);
	results.push(
		"actual kernel/model 1.4.0, official lazy OAuth load, async credential writes, model refresh, custom provider add/delete and secret-free snapshots passed",
	);
	logger.info("新内核模型与认证操作验证结束");

	/*
	 * ========================================================================
	 * 步骤3：验证旧扩展 OAuth 与重载、重启、退出登录
	 * ========================================================================
	 * 数据源：旧回调形式的离线 OAuth 扩展和真实桌面弹窗。
	 * 操作：
	 *   1) 取消不存凭据，重载保留输入身份，成功后持久化
	 *   2) 重启恢复登录状态，退出后立即刷新模型与认证状态
	 */
	logger.info("开始验证新内核 OAuth 与扩展适配");
	await login();
	await page
		.getByRole("dialog", { name: "登录方式", exact: true })
		.getByRole("button", { name: "取消", exact: true })
		.click();
	await waitForSnapshot((snapshot) => snapshot.authentication.flow?.phase === "cancelled");
	await login();
	await page.getByRole("button", { name: "交互选项", exact: true }).click();
	await page.getByRole("option", { name: "离线设备码", exact: true }).click();
	await page
		.getByRole("dialog", { name: "登录方式", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.getByRole("dialog", { name: "OAuth 登录", exact: true }).waitFor();
	const promptId = (await page.evaluate(() => window.piDesktop.getSnapshot())).dialogs[0].id;
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.getByRole("dialog", { name: "OAuth 登录", exact: true }).waitFor();
	snapshot = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.equal(snapshot.dialogs[0].id, promptId);
	assert.equal(snapshot.authentication.flow.userCode, "TEST-1234");
	await page.getByLabel("交互输入", { exact: true }).fill("offline-code");
	await page
		.getByRole("dialog", { name: "OAuth 登录", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await waitForSnapshot(
		(snapshot) =>
			snapshot.authentication.providers.find((provider) => provider.id === "gui-offline-oauth")?.authenticated,
	);
	assert(!JSON.stringify(await page.evaluate(() => window.piDesktop.getSnapshot())).includes("offline-private-"));
	await application.close();
	application = undefined;
	page = undefined;
	await launch();
	await waitForSnapshot(
		(snapshot) =>
			snapshot.authentication.providers.find((provider) => provider.id === "gui-offline-oauth")?.authenticated,
	);
	await send({ type: "logout", provider: "gui-offline-oauth" });
	snapshot = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.equal(
		snapshot.authentication.providers.find((provider) => provider.id === "gui-offline-oauth").authenticated,
		false,
	);
	assert.equal(JSON.parse(await readFile(join(agentDirectory, "auth.json"), "utf8"))["gui-offline-oauth"], undefined);
	results.push("legacy extension OAuth, cancel, reload identity, restart persistence and explicit logout passed");
	assert.deepEqual(failures, []);
	assert(!/UnhandledPromiseRejection|unhandledRejection/i.test(stderr));
	logger.info("新内核 OAuth 与扩展适配验证结束");
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, results, failures }, null, 2),
		"utf8",
	);
	logger.info(JSON.stringify({ passed: true, artifacts, results }));
} catch (error) {
	await page?.screenshot({ path: join(artifacts, "failure.png"), scale: "css" }).catch(() => {});
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: false, results, failures, error: String(error) }, null, 2),
		"utf8",
	);
	throw error;
} finally {
	await application?.close().catch(() => {});
	logger.info("Pi 内核升级验收结束");
}
