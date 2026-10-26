import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `updates-${Date.now()}`);
const renderer = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
const payload = Buffer.alloc(4 * 1024 * 1024, 71);
const checksum = createHash("sha512").update(payload).digest("base64");
const results = [];
const failures = [];
let application;
let page;
let offeredVersion = "0.80.9";
let failDownload = true;
let failCheck = false;
let installerRequests = 0;
let metadataRequests = 0;
let stderr = "";

/*
 * ========================================================================
 * 步骤1：准备隔离更新源和真实应用入口
 * ========================================================================
 * 数据源：本机版本清单与固定字节，不接触发布服务器或用户认证。
 * 操作：1) 真实更新器下载并校验摘要；2) 安装调用由测试入口记录，禁止启动安装器。
 */
logger.info("开始准备手动更新验收");
await mkdir(artifacts, { recursive: true });
// 1.1 缓慢发送测试包，确保能检查真实进度；清单失败和下载失败分别控制。
const server = createServer(async (request, response) => {
	const path = new URL(request.url, "http://fixture").pathname;
	if (path === "/latest.yml") {
		metadataRequests += 1;
		if (failCheck) {
			response.writeHead(503).end("offline check unavailable");
			return;
		}
		response
			.writeHead(200, { "Content-Type": "text/yaml" })
			.end(
				`version: ${offeredVersion}\nfiles:\n  - url: fixture-${offeredVersion}.exe\n    sha512: ${checksum}\n    size: ${payload.length}\npath: fixture-${offeredVersion}.exe\nsha512: ${checksum}\nreleaseDate: '2026-10-23T00:00:00.000Z'\nreleaseNotes: '更新入口与手动下载验收'\n`,
			);
		return;
	}
	if (path.endsWith(".exe")) {
		installerRequests += 1;
		if (failDownload) {
			response.writeHead(404).end("offline download unavailable");
			return;
		}
		response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": payload.length });
		for (let offset = 0; offset < payload.length && !response.destroyed; offset += 64 * 1024) {
			response.write(payload.subarray(offset, offset + 64 * 1024));
			await delay(250);
		}
		response.end();
		return;
	}
	response.writeHead(404).end();
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert(address && typeof address === "object");
const feed = `http://127.0.0.1:${address.port}/`;
const config = join(artifacts, "app-update.yml");
const entry = join(artifacts, "entry.cjs");
await writeFile(config, `provider: generic\nurl: ${feed}\nupdaterCacheDirName: manual-update-fixture\n`, "utf8");
// 1.2 只在独立测试进程中模拟打包标志和版本，产品不加入测试后门。
await writeFile(
	entry,
	`const { app } = require("electron");
const logger = console;
/*
 * ========================================================================
 * 步骤1：在独立进程中启用真实更新器
 * ========================================================================
 * 数据源：开发主进程和本机测试清单。
 * 操作：1) 固定测试版本；2) 记录安装意图，禁止运行测试包。
 */
logger.info("开始准备更新验收进程");
// 1.1 使用真实主进程、preload 与 renderer，只有安装动作被替换。
Object.defineProperty(app, "isPackaged", { get: () => true });
app.getVersion = () => "0.80.8";
const { autoUpdater } = require(${JSON.stringify(createRequire(import.meta.url).resolve("electron-updater"))});
autoUpdater.updateConfigPath = ${JSON.stringify(config)};
autoUpdater.disableDifferentialDownload = true;
autoUpdater.disableWebInstaller = true;
globalThis.updateInstallCalls = 0;
autoUpdater.quitAndInstall = () => { globalThis.updateInstallCalls += 1; };
require(${JSON.stringify(join(root, "dist/main/index.cjs"))});
logger.info("更新验收进程准备结束");
`,
	"utf8",
);
logger.info("手动更新验收准备结束");

async function launch(label) {
	const profile = join(artifacts, label);
	await mkdir(profile, { recursive: true });
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (["electron_run_as_node", "localappdata", "node_options", "node_path"].includes(key.toLowerCase()))
			delete environment[key];
	}
	Object.assign(environment, {
		PI_CODING_AGENT_DIR: join(profile, "agent"),
		PI_PACKAGE_DIR: join(root, "node_modules/@earendil-works/pi-coding-agent"),
		ANIAO_DEFAULT_PROVIDER_FILE: join(profile, "absent-provider.json"),
		ANIAO_UPDATE_URL: feed,
		LOCALAPPDATA: join(profile, "cache"),
		ELECTRON_RENDERER_URL: renderer,
	});
	application = await _electron.launch({
		executablePath: electronExecutable,
		args: [entry, `--user-data-dir=${profile}`],
		cwd: artifacts,
		env: environment,
		timeout: 60000,
	});
	const log = createWriteStream(join(profile, "electron.log"));
	application.process().stdout.pipe(log, { end: false });
	application.process().stderr.on("data", (data) => {
		stderr += data.toString();
	});
	application.process().stderr.pipe(log, { end: false });
	application.process().once("exit", () => log.end());
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		page = application
			.windows()
			.find((candidate) => candidate.url().startsWith(renderer) && !candidate.url().includes("startup.html"));
		if (page) {
			page.on("pageerror", (error) => failures.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error") failures.push(message.text());
			});
			await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).waitFor();
			return;
		}
		await delay(50);
	}
	throw new Error("更新验收工作台加载超时");
}

async function waitForUpdate(phase) {
	const deadline = Date.now() + 30000;
	let state;
	while (Date.now() < deadline) {
		state = await page.evaluate(() => window.piDesktop.getUpdateState());
		if (state.phase === phase) return state;
		if (state.phase === "error" && phase !== "error") throw new Error(state.message);
		await delay(100);
	}
	throw new Error(`等待更新状态超时：${phase}，${JSON.stringify(state)}`);
}

async function openSettings() {
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "通用设置", exact: true }).click();
	return page.getByRole("region", { name: "应用更新", exact: true }).last();
}

async function openVersionDialog() {
	await page.getByRole("button", { name: "帮助", exact: true }).click();
	await page.getByRole("menuitem", { name: "检查更新", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "关于 Aniao Harness", exact: true });
	await dialog.waitFor();
	return dialog;
}

try {
	/*
	 * ========================================================================
	 * 步骤2：验证新版本提示、失败重试与跨入口进度
	 * ========================================================================
	 * 数据源：实际 IPC、真实更新器 HTTP 请求与 Electron DOM。
	 * 操作：1) 无项目也能操作；2) 侧栏、设置与帮助共用手动下载状态。
	 */
	logger.info("开始验证更新入口与下载状态");
	await launch("available");
	await waitForUpdate("available");
	assert(metadataRequests > 0);
	assert.equal(installerRequests, 0);
	const download = page.getByRole("button", { name: "下载更新 v0.80.9", exact: true });
	await download.waitFor();
	const appearance = await download.evaluate((button) => {
		const disc = button.querySelector(".download-disc");
		const style = getComputedStyle(disc);
		const profile = document.querySelector(".user-profile");
		const settings = document.querySelector('button[aria-label="设置"]');
		const icon = disc.firstElementChild;
		return {
			background: style.backgroundColor,
			color: getComputedStyle(icon).color,
			borderRadius: style.borderRadius,
			width: disc.getBoundingClientRect().width,
			height: disc.getBoundingClientRect().height,
			hitWidth: button.getBoundingClientRect().width,
			afterProfile: button.getBoundingClientRect().left >= profile.getBoundingClientRect().right,
			leftOfSettings: button.getBoundingClientRect().right <= settings.getBoundingClientRect().left,
			nextIsSettings: button.parentElement.nextElementSibling === settings,
		};
	});
	assert.deepEqual(appearance, {
		background: "rgb(65, 118, 230)",
		color: "rgb(255, 255, 255)",
		borderRadius: "50%",
		width: 20,
		height: 20,
		hitWidth: 28,
		afterProfile: true,
		leftOfSettings: true,
		nextIsSettings: true,
	});
	await page.locator(".sidebar-footer").screenshot({ path: join(artifacts, "footer-available.png"), scale: "css" });
	const versionDialog = await openVersionDialog();
	await waitForUpdate("available");
	assert.match(await versionDialog.innerText(), /版本 0.80.8[\s\S]+最新版本 v0.80.9/);
	await page.getByRole("button", { name: "检查更新", exact: true }).click();
	await waitForUpdate("available");
	assert.equal(installerRequests, 0);
	await versionDialog.screenshot({ path: join(artifacts, "dialog-available-light.png"), scale: "css" });
	await page.screenshot({ path: join(artifacts, "workbench-dialog-light.png"), scale: "css" });
	await versionDialog.getByRole("button", { name: "确定", exact: true }).click();
	await versionDialog.waitFor({ state: "hidden" });
	assert(await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).isVisible());
	const settings = await openSettings();
	assert(await settings.getByRole("button", { name: "下载更新", exact: true }).isEnabled());
	await settings.getByRole("button", { name: "检查更新", exact: true }).click();
	await versionDialog.waitFor();
	await page.getByRole("dialog", { name: "设置", exact: true }).waitFor({ state: "hidden" });
	await waitForUpdate("available");
	assert.equal(installerRequests, 0);
	await versionDialog.getByRole("button", { name: "确定", exact: true }).click();
	await versionDialog.waitFor({ state: "hidden" });
	results.push(
		"20px blue white-arrow icon sits immediately left of Settings after the profile; Help and Settings checks open version dialog and only request metadata",
	);
	// 2.1 侧栏下载失败后，设置页保留版本与显式重试按钮。
	await download.click();
	await waitForUpdate("error");
	assert.equal(installerRequests, 1);
	const retryPanel = await openSettings();
	assert.match(await retryPanel.innerText(), /404/);
	failDownload = false;
	await retryPanel.getByRole("button", { name: "重试下载", exact: true }).click();
	await waitForUpdate("downloading");
	await page.getByRole("button", { name: "关闭设置", exact: true }).click();
	const circle = page.locator(".update-download-slot [role=progressbar]");
	await circle.waitFor();
	await page.waitForFunction(
		() => Number(document.querySelector(".update-download-slot [role=progressbar]")?.getAttribute("aria-valuenow")) > 0,
	);
	await openVersionDialog();
	await versionDialog.screenshot({ path: join(artifacts, "dialog-downloading-light.png"), scale: "css" });
	assert(await page.getByRole("progressbar", { name: /更新下载进度/ }).isVisible());
	assert(await page.getByRole("button", { name: "检查更新", exact: true }).isDisabled());
	await versionDialog.getByRole("button", { name: "确定", exact: true }).click();
	await versionDialog.waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
	await openVersionDialog();
	const darkAppearance = await versionDialog.evaluate((dialog) => ({
		rootFilter: getComputedStyle(document.documentElement).filter,
		background: getComputedStyle(dialog).backgroundColor,
		color: getComputedStyle(dialog.querySelector(".about-brand h2")).color,
		markFilter: getComputedStyle(dialog.querySelector(".about-mark")).filter,
	}));
	assert.deepEqual(darkAppearance, {
		rootFilter: "none",
		background: "rgb(27, 27, 28)",
		color: "rgb(249, 250, 251)",
		markFilter: "invert(1)",
	});
	await versionDialog.screenshot({ path: join(artifacts, "dialog-downloading-dark.png"), scale: "css" });
	await versionDialog.getByRole("button", { name: "确定", exact: true }).click();
	await versionDialog.waitFor({ state: "hidden" });
	const progressPanel = await openSettings();
	await progressPanel.getByRole("progressbar").waitFor();
	await page.screenshot({ path: join(artifacts, "settings-downloading-dark.png"), scale: "css" });
	await page.getByRole("button", { name: "关闭设置", exact: true }).click();
	await waitForUpdate("downloaded");
	assert.equal(installerRequests, 2);
	assert.equal(await application.evaluate(() => globalThis.updateInstallCalls), 0);
	const cached = await readFile(join(artifacts, "available/cache/manual-update-fixture/pending/fixture-0.80.9.exe"));
	assert.equal(createHash("sha512").update(cached).digest("base64"), checksum);
	await page.getByRole("button", { name: "应用", exact: true }).click();
	await page.getByRole("button", { name: "更新已下载，查看安装选项", exact: true }).click();
	await versionDialog.waitFor();
	assert.equal(await application.evaluate(() => globalThis.updateInstallCalls), 0);
	await page.getByRole("button", { name: "重启并安装", exact: true }).click();
	// 2.2 安装入口等待宿主清理，点击返回时不能假定清理已经完成。
	const installDeadline = Date.now() + 10000;
	while (Date.now() < installDeadline) {
		if ((await application.evaluate(() => globalThis.updateInstallCalls)) === 1) break;
		await delay(50);
	}
	assert.equal(await application.evaluate(() => globalThis.updateInstallCalls), 1);
	results.push(
		"footer download 404 stays retryable; Settings retry downloads once with shared ring/bar progress, SHA-512 verified, install only on explicit click (installer stubbed)",
	);
	await application.close();
	application = undefined;
	logger.info("更新入口与下载状态验证结束");

	/*
	 * ========================================================================
	 * 步骤3：验证无新版、检查失败和版本弹窗下载
	 * ========================================================================
	 * 数据源：全新独立缓存与可切换的本机版本清单。
	 * 操作：1) 检查失败不能显示最新版；2) 版本弹窗也必须点击后才下载。
	 */
	logger.info("开始验证版本弹窗检查");
	offeredVersion = "0.80.8";
	const before = installerRequests;
	await launch("latest");
	const latestDialog = await openVersionDialog();
	await waitForUpdate("idle");
	await page.getByText("当前已是最新版本", { exact: true }).waitFor();
	assert.match(await latestDialog.innerText(), /版本 0.80.8/);
	assert.equal(await page.locator(".update-download-slot").count(), 0);
	assert.equal(installerRequests, before);
	await latestDialog.screenshot({ path: join(artifacts, "dialog-latest.png"), scale: "css" });
	failCheck = true;
	await page.getByRole("button", { name: "检查更新", exact: true }).click();
	await waitForUpdate("error");
	assert.equal(await page.getByText("当前已是最新版本", { exact: true }).count(), 0);
	failCheck = false;
	offeredVersion = "0.80.9";
	await page.getByRole("button", { name: "检查更新", exact: true }).click();
	await waitForUpdate("available");
	assert.equal(installerRequests, before);
	await page
		.getByRole("region", { name: "应用更新", exact: true })
		.getByRole("button", { name: "下载更新", exact: true })
		.click();
	await waitForUpdate("downloaded");
	assert.equal(installerRequests, before + 1);
	assert.equal(await application.evaluate(() => globalThis.updateInstallCalls), 0);
	assert.deepEqual(failures, []);
	assert(!/UnhandledPromiseRejection|unhandledRejection/i.test(stderr));
	results.push(
		"version dialog works without project; no-update shows current version, check failures stay errors, dialog downloads only after click",
	);
	logger.info("版本弹窗检查验证结束");
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, results, appearance, metadataRequests, installerRequests }, null, 2),
		"utf8",
	);
	logger.info(JSON.stringify({ passed: true, artifacts, results }));
} catch (error) {
	await page?.screenshot({ path: join(artifacts, "failure.png"), scale: "css" }).catch(() => {});
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify(
			{ passed: false, results, error: String(error), failures, metadataRequests, installerRequests },
			null,
			2,
		),
		"utf8",
	);
	throw error;
} finally {
	await application?.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((done) => server.close(done));
	logger.info("手动更新验收结束");
}
