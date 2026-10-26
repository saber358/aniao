import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `editing-${Date.now()}`);
const project = join(artifacts, "中文 项目");
const agent = join(artifacts, "agent");
const renderer = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
const packagedExecutable = process.env.PI_GUI_PACKAGED_EXECUTABLE;
const results = [];
const failures = [];
let application;
let page;
let clipboardSaved = false;

/*
 * ========================================================================
 * 步骤1：准备独立项目、配置和真实桌面入口
 * ========================================================================
 * 数据源：临时 Git 仓库、无效模型认证与开发服务。
 * 操作：1) 不读取用户认证；2) 剪贴板在内存中完整保留并最终恢复。
 */
logger.info("开始准备编辑菜单回归");
await Promise.all([project, agent].map((path) => mkdir(path, { recursive: true })));
// 1.1 fixture 禁用用户钩子与提交签名，仅写入独立验收目录。
async function git(...args) {
	return execute("git", args, { cwd: project, encoding: "utf8", windowsHide: true });
}
await git("init");
await git("config", "user.name", "GUI Offline");
await git("config", "user.email", "offline@example.invalid");
await git("config", "core.hooksPath", join(artifacts, "no-hooks"));
await git("config", "commit.gpgsign", "false");
await git("config", "core.autocrlf", "false");
await writeFile(join(project, "README.md"), "before\n", "utf8");
await git("add", "--", "README.md");
await git("commit", "-m", "offline editing fixture");
await writeFile(join(project, "README.md"), "after 中文\n", "utf8");
await writeFile(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			"editing-offline": {
				baseUrl: "http://127.0.0.1:65534/v1",
				api: "openai-completions",
				apiKey: "offline-editing-key",
				models: [{ id: "fixture" }],
			},
		},
	}),
	"utf8",
);
await writeFile(
	join(agent, "settings.json"),
	JSON.stringify({ defaultProvider: "editing-offline", defaultModel: "fixture" }),
	"utf8",
);
logger.info("编辑菜单回归准备结束");

async function edit(label) {
	await page.getByRole("button", { name: "编辑", exact: true }).click();
	await page.getByRole("menuitem", { name: new RegExp(`^${label}`) }).click();
	await page.getByRole("menu").waitFor({ state: "hidden" });
}

async function waitValue(value) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if ((await page.locator(".composer textarea").inputValue()) === value) return;
		await delay(30);
	}
	assert.equal(await page.locator(".composer textarea").inputValue(), value);
}

async function screenshot(name) {
	const bytes = await application.evaluate(async ({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("startup.html"),
		);
		const image = await window.capturePage();
		const [width, height] = window.getContentSize();
		return image.resize({ width, height, quality: "best" }).toPNG();
	});
	await writeFile(join(artifacts, `${name}.png`), bytes);
}

try {
	const environment = { ...process.env };
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
	// 1.2 安装包验收使用自身界面与受限工具路径，不依赖开发服务。
	if (packagedExecutable) delete environment.ELECTRON_RENDERER_URL;
	if (process.env.PI_GUI_TEST_PATH) {
		for (const key of Object.keys(environment)) if (key.toLowerCase() === "path") delete environment[key];
		environment.Path = process.env.PI_GUI_TEST_PATH;
	}
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
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		page = application
			.windows()
			.find(
				(window) =>
					window.url().startsWith(packagedExecutable ? "file:" : renderer) && !window.url().includes("startup.html"),
			);
		if (page) break;
		await delay(50);
	}
	assert(page, "工作台加载超时");
	page.setDefaultTimeout(15000);
	page.on("pageerror", (error) => failures.push(error.message));
	await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).waitFor();
	/*
	 * ========================================================================
	 * 步骤2：用正常菜单和键盘验证原生编辑
	 * ========================================================================
	 * 数据源：真实 textarea、菜单动作、Chromium 撤销记录与系统剪贴板。
	 * 操作：1) 空项目可打开设置；2) 连续快速操作不能被退场动画覆盖选择。
	 */
	logger.info("开始验证编辑菜单与焦点");
	await edit("设置");
	await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
	await page.keyboard.press("Escape");
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	await page.keyboard.press("Control+,");
	await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
	await page.keyboard.press("Escape");
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	await application.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	const input = page.locator(".composer textarea");
	await input.waitFor({ state: "visible" });
	await application.evaluate(async ({ clipboard, ClipboardItem }) => {
		// 2.1 提前物化所有格式，不能把 clipboard.read 返回项直接用于 write。
		const items = await clipboard.read();
		globalThis.editingClipboard = await Promise.all(
			items
				.filter((item) => item.types.length > 0)
				.map(
					async (item) =>
						new ClipboardItem(
							Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))),
						),
				),
		);
	});
	clipboardSaved = true;
	await input.click();
	await input.pressSequentially("menu-test", { delay: 45 });
	await edit("全选");
	await edit("复制");
	await input.press("End");
	await edit("粘贴");
	await waitValue("menu-testmenu-test");
	await edit("全选");
	await edit("剪切");
	await waitValue("");
	await edit("撤销");
	await waitValue("menu-testmenu-test");
	await edit("重做");
	await waitValue("");
	await edit("粘贴");
	await waitValue("menu-testmenu-test");
	await edit("全选");
	await edit("删除");
	await waitValue("");
	await edit("撤销");
	await waitValue("menu-testmenu-test");
	await page.getByRole("button", { name: "编辑", exact: true }).click();
	await page.keyboard.press("Escape");
	await page.getByRole("menu").waitFor({ state: "hidden" });
	assert.equal(await input.evaluate((element) => document.activeElement === element), true);
	await page.getByRole("button", { name: "编辑", exact: true }).click();
	await input.click();
	assert.equal(await input.evaluate((element) => document.activeElement === element), true);
	results.push(
		"eight edit menu actions, rapid selection/copy/paste, undo/redo, Escape/outside focus, settings and Ctrl+, passed",
	);
	logger.info("编辑菜单与焦点验证结束");

	/*
	 * ========================================================================
	 * 步骤3：验证右栏变更和聊天草稿同时可用
	 * ========================================================================
	 * 数据源：隔离仓库的真实差异、索引和当前草稿。
	 * 操作：1) 暂存与取消保留原内容；2) 窄栏和放大状态不替换会话。
	 */
	logger.info("开始验证右栏变更");
	await page.getByRole("button", { name: "打开变更", exact: true }).click();
	await page.locator(".change-row").filter({ hasText: "README.md" }).click();
	await page.getByRole("button", { name: "暂存", exact: true }).click();
	await page.getByRole("button", { name: "取消暂存", exact: true }).waitFor();
	assert((await git("diff", "--cached", "--name-only")).stdout.includes("README.md"));
	await page.getByRole("button", { name: "取消暂存", exact: true }).click();
	await page.getByRole("button", { name: "取消暂存", exact: true }).waitFor({ state: "hidden" });
	assert(!(await git("diff", "--cached", "--name-only")).stdout.includes("README.md"));
	await page.getByRole("button", { name: "行评论", exact: true }).click();
	await page.getByPlaceholder("写下对这一行的评论…").fill("核对这处改动");
	await page.getByRole("button", { name: "添加", exact: true }).click();
	await page.keyboard.press("Control+p");
	await page.getByRole("tab", { name: /^变更/ }).click();
	await page.getByText("核对这处改动", { exact: true }).waitFor();
	await page.getByRole("button", { name: "发送给 Agent", exact: true }).click();
	const feedbackDeadline = Date.now() + 5000;
	while (Date.now() < feedbackDeadline && !(await input.inputValue()).includes("行评论反馈")) await delay(30);
	assert.match(await input.inputValue(), /menu-testmenu-test[\s\S]*行评论反馈[\s\S]*核对这处改动/);
	await page.getByRole("button", { name: "放大面板", exact: true }).click();
	assert.equal(await page.locator(".conversation-column").isVisible(), false);
	await page.getByRole("button", { name: "还原面板宽度", exact: true }).click();
	await page.getByRole("separator", { name: "调整右侧面板宽度", exact: true }).press("Home");
	await screenshot("changes-light");
	await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
	await page.locator("html.dark").waitFor();
	await screenshot("changes-dark");
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	assert.equal(await readFile(join(project, "README.md"), "utf8"), "after 中文\n");
	assert.deepEqual(failures, []);
	results.push(
		"right-side changes preserve conversation/draft, stage/unstage, review across tabs, feedback, maximize/restore and 360px light/dark layouts passed",
	);
	logger.info("右栏变更验证结束");
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, results, failures }, null, 2),
		"utf8",
	);
	logger.info(JSON.stringify({ passed: true, artifacts, results }));
} catch (error) {
	await screenshot("failure").catch(() => {});
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: false, results, failures, error: String(error) }, null, 2),
		"utf8",
	);
	throw error;
} finally {
	if (clipboardSaved)
		await application.evaluate(async ({ clipboard }) => {
			if (globalThis.editingClipboard.length) await clipboard.write(globalThis.editingClipboard);
			else clipboard.clear();
			delete globalThis.editingClipboard;
		});
	await application?.close().catch(() => {});
	logger.info("编辑与变更回归结束");
}
