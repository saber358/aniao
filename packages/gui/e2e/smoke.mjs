import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `smoke-${Date.now()}`);
const project = join(artifacts, "中文项目");
const agentDirectory = join(artifacts, "agent");
const profile = join(artifacts, "profile");
const environment = {
	...process.env,
	ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173",
	PI_CODING_AGENT_DIR: agentDirectory,
};
delete environment.ELECTRON_RUN_AS_NODE;
let electronApp;
const failures = [];
let requests = 0;
let imageRequests = 0;
const imageMessageSizes = [];

/*
 * ========================================================================
 * 步骤1：建立仅监听本机的模型接口与独立数据目录
 * ========================================================================
 * 数据源：确定性测试文本，不读取用户认证，不调用外部模型。
 * 操作：
 *   1) 用真实 OpenAI 兼容 SSE 驱动 SDK 和工具循环
 *   2) 文件、会话、认证和截图全部写入本次验收目录
 */
logger.info("开始准备 Electron 离线验收");
await Promise.all([project, agentDirectory, profile].map((path) => mkdir(path, { recursive: true })));
await mkdir(join(agentDirectory, "extensions"));
await copyFile(
	join(root, "e2e/fixtures/portable-extension.mjs"),
	join(agentDirectory, "extensions/portable-extension.js"),
);
await writeFile(join(project, "README.md"), "# GUI 离线验收\n这是一份中文项目文件。\n", "utf8");
await mkdir(join(project, "src"));
await writeFile(join(project, "src", "中文 文件.ts"), "const referenceReady = true;\n", "utf8");
await writeFile(join(artifacts, "outside.txt"), "项目外文件不能进入草稿", "utf8");
// 1.1 接口支持工具往返和可取消的长流式回答。
const server = createServer(async (request, response) => {
	try {
		let body = "";
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body);
		requests++;
		response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		const send = (delta, finishReason = null) =>
			response.write(
				`data: ${JSON.stringify({
					id: "offline-completion",
					object: "chat.completion.chunk",
					created: 1,
					model: "fixture",
					choices: [{ index: 0, delta, finish_reason: finishReason }],
				})}\n\n`,
			);
		send({ role: "assistant" });
		const user = input.messages.filter((message) => message.role === "user").at(-1);
		const userText = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
		const referencesFile = userText?.includes("src/中文 文件.ts");
		if (userText?.includes("图片任务") || userText?.includes("图片中断验收")) {
			assert(
				Array.isArray(user.content) &&
					user.content.some(
						(part) => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,"),
					),
			);
			imageRequests++;
			imageMessageSizes.push(user.content.filter((part) => part.type === "image_url").length);
		}
		if (userText?.includes("长任务")) {
			for (let index = 0; index < 200 && !response.destroyed; index++) {
				send({ content: index === 0 ? "正在持续处理" : "，继续" });
				await delay(35);
			}
		} else if (userText?.includes("图片任务")) {
			send({ content: "图片已收到。" });
		} else if (userText?.includes("超长正文验收")) {
			send({ content: `\`\`\`text\n${"正文".repeat(1_000_001)}\n\`\`\`` });
		} else if (input.messages.at(-1)?.role !== "tool") {
			send({
				tool_calls: [
					{
						index: 0,
						id: `read-fixture-${requests}`,
						type: "function",
						function: {
							name: "read",
							arguments: JSON.stringify({ path: referencesFile ? "src/中文 文件.ts" : "README.md" }),
						},
					},
				],
			});
			send({}, "tool_calls");
			response.end("data: [DONE]\n\n");
			return;
		} else if (referencesFile) {
			assert(input.messages.at(-1).content.includes("referenceReady"));
			send({ content: "已读取引用文件，referenceReady 可用。" });
		} else {
			for (const text of ["已读取 README.md。\n\n", "这是中文项目文件。\n\n", "```ts\nconst ready = true;\n```"]) {
				send({ content: text });
				await delay(40);
			}
		}
		if (!response.destroyed) {
			send({}, "stop");
			response.end("data: [DONE]\n\n");
		}
	} catch {
		if (!response.destroyed) response.end();
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
await writeFile(
	join(agentDirectory, "models.json"),
	JSON.stringify({
		providers: {
			"gui-offline": {
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-completions",
				apiKey: "offline-fixture-only",
				models: [
					{
						id: "fixture",
						name: "离线验收模型",
						reasoning: true,
						input: ["text", "image"],
						contextWindow: 128000,
						maxTokens: 8192,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
					{
						id: "fixture-fast",
						name: "快速验收模型",
						reasoning: false,
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 8192,
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
	JSON.stringify({ defaultProvider: "gui-offline", defaultModel: "fixture", defaultThinkingLevel: "low" }),
	"utf8",
);
logger.info("Electron 离线验收数据准备完成");

async function launch() {
	logger.info("开始启动验收窗口");
	const application = await _electron.launch({
		executablePath: electronExecutable,
		args: [join(root, "dist/main/index.cjs"), `--user-data-dir=${profile}`],
		cwd: root,
		env: environment,
		timeout: 60000,
	});
	application.process().stdout.on("data", (chunk) => process.stdout.write(chunk));
	application.process().stderr.on("data", (chunk) => process.stderr.write(chunk));
	// 剪贴板验收截获 Electron API，避免改动用户的系统剪贴板。
	await application.evaluate(({ clipboard }) => {
		let text = "";
		clipboard.writeText = (value) => {
			text = value;
		};
		clipboard.readText = () => text;
	});
	const page = await application.firstWindow();
	page.setDefaultTimeout(15000);
	page.on("pageerror", (error) => failures.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") failures.push(message.text());
	});
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (["http:", "https:"].includes(url.protocol) && !["localhost", "127.0.0.1"].includes(url.hostname))
			failures.push(`Unexpected remote resource: ${url.origin}`);
	});
	logger.info("验收窗口启动完成");
	return { application, page };
}

// 1.3 事件文件使用浏览器 File / DataTransfer，不读取或改写系统剪贴板。
async function dispatchFileInput(page, type, files, text = "") {
	return page.locator("textarea").evaluate(
		(element, input) => {
			const transfer = new DataTransfer();
			if (input.text) transfer.setData("text/plain", input.text);
			for (const file of input.files) {
				const bytes = Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0));
				transfer.items.add(new File([bytes], file.name, { type: file.mime }));
			}
			const event =
				input.type === "paste"
					? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
					: new DragEvent(input.type, { dataTransfer: transfer, bubbles: true, cancelable: true });
			element.dispatchEvent(event);
			return event.defaultPrevented;
		},
		{ type, files, text },
	);
}

/*
 * ========================================================================
 * 步骤2：用真实窗口和用户操作验证完整链路
 * ========================================================================
 * 验收清单：
 *   1) 空状态、项目选择、工具往返、正文高亮、主题和设置
 *   2) 组合输入保护、重载恢复、停止和最小窗口布局
 */
logger.info("开始验证 Electron 用户路径");
try {
	let launchedApp = await launch();
	electronApp = launchedApp.application;
	let page = launchedApp.page;
	await page.getByRole("heading", { name: "打开项目，开始工作" }).waitFor({ timeout: 60000 });
	// 2.1 先核对实际启动尺寸，再用正常按钮打开准备好的目录。
	const launched = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
	assert(launched.width >= 1100 && launched.height >= 720);
	await page.screenshot({ path: join(artifacts, "01-empty.png"), scale: "css", animations: "disabled" });
	await electronApp.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor({ timeout: 60000 });
	await page.screenshot({ path: join(artifacts, "02-project.png"), scale: "css", animations: "disabled" });
	await page.getByRole("button", { name: "模型", exact: true }).waitFor();
	// 2.2 从真实菜单切换模型和等级，使用宿主快照核对结果。
	await page.getByRole("button", { name: "模型", exact: true }).click();
	await page.locator('[data-slot="input"] input').fill("快速验收模型");
	await page.getByRole("option", { name: /快速验收模型/ }).click();
	await page.waitForFunction(async () =>
		(await window.piDesktop.getSnapshot()).configuration.model.key.endsWith("fixture-fast"),
	);
	assert.equal(await page.getByRole("button", { name: "思考等级", exact: true }).count(), 0);
	await page.getByRole("button", { name: "模型", exact: true }).click();
	await page.locator('[data-slot="input"] input').fill("离线验收模型");
	await page.getByRole("option", { name: /离线验收模型/ }).click();
	await page.getByRole("button", { name: "思考等级", exact: true }).click();
	await page.getByRole("option", { name: "high", exact: true }).click();
	await page.waitForFunction(async () => (await window.piDesktop.getSnapshot()).configuration.thinking === "high");
	const separator = page.getByRole("separator");
	const beforeResize = await page.locator(".sidebar").boundingBox();
	await separator.focus();
	await page.keyboard.press("ArrowRight");
	await page.waitForFunction(
		(width) => document.querySelector(".sidebar").getBoundingClientRect().width > width,
		beforeResize.width,
	);

	let composer = page.locator("textarea");
	// 2.3 合成组合输入事件只检查组件保护逻辑，不替代人工输入法验收。
	await composer.fill("中文输入验收");
	await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
	assert.equal(requests, 0);
	await composer.fill("读取 README.md，然后回答已完成。");
	await page.getByRole("button", { name: "发送任务" }).click();
	await page.getByText("已读取 README.md。", { exact: true }).waitFor({ timeout: 30000 });
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	assert.equal(await composer.inputValue(), "");
	assert.equal(requests, 2);
	await page.waitForFunction(() => !document.querySelector(".model-select").disabled);
	await page.getByRole("button", { name: /read.*完成/ }).click();
	await page.getByText("这是一份中文项目文件。", { exact: false }).last().waitFor();
	await page.screenshot({ path: join(artifacts, "03-result.png"), scale: "css", animations: "disabled" });
	// 2.4 消息保留 Markdown，代码只复制正文；失败可重试，空负载被拒绝。
	await page.getByRole("button", { name: "复制用户消息", exact: true }).click();
	assert.equal(await electronApp.evaluate(({ clipboard }) => clipboard.readText()), "读取 README.md，然后回答已完成。");
	await page.getByRole("button", { name: "复制助手消息", exact: true }).click();
	assert.equal(
		await electronApp.evaluate(({ clipboard }) => clipboard.readText()),
		"已读取 README.md。\n\n这是中文项目文件。\n\n```ts\nconst ready = true;\n```",
	);
	await page.getByRole("button", { name: "复制代码", exact: true }).click();
	assert.equal(await electronApp.evaluate(({ clipboard }) => clipboard.readText()), "const ready = true;");
	await electronApp.evaluate(({ clipboard }) => {
		const write = clipboard.writeText;
		clipboard.writeText = () => {
			clipboard.writeText = write;
			throw new Error("fixture clipboard unavailable");
		};
	});
	await page.getByRole("button", { name: "复制代码", exact: true }).click();
	await page.getByText("复制失败，请重试", { exact: true }).waitFor();
	await page.getByRole("button", { name: "复制代码", exact: true }).focus();
	await page.keyboard.press("Enter");
	await page.getByText("复制失败，请重试", { exact: true }).waitFor({ state: "hidden" });
	assert.equal(
		await page.evaluate(async () => {
			try {
				await window.piDesktop.writeClipboard("");
				return false;
			} catch {
				return true;
			}
		}),
		true,
	);

	// 2.3 主题循环、设置焦点和敏感输入清理。
	await page.getByRole("button", { name: "切换深色主题" }).click();
	assert(await page.locator("html.dark").count());
	await page.screenshot({ path: join(artifacts, "04-dark.png"), scale: "css", animations: "disabled" });
	await page.getByRole("button", { name: "切换浅色主题" }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("dialog").waitFor();
	await page.locator("#api-key").fill("unused-fixture-key");
	await page.keyboard.press("Escape");
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "设置", exact: true }).click();
	assert.equal(await page.locator("#api-key").inputValue(), "");
	await page.locator("#api-key").fill("offline-saved-key");
	await page.getByRole("button", { name: "保存认证", exact: true }).click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	const auth = JSON.parse(await readFile(join(agentDirectory, "auth.json"), "utf8"));
	assert.equal(auth["gui-offline"].key, "offline-saved-key");
	assert(!(await page.locator("body").innerText()).includes("offline-saved-key"));

	// 2.4 在途重载后仍可继续看到流式内容并停止，不重复提交。
	await composer.fill("长任务");
	await page.getByRole("button", { name: "发送任务" }).click();
	await page.getByText(/正在持续处理/).waitFor();
	assert(await page.getByRole("button", { name: "搜索项目文件", exact: true }).isDisabled());
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.getByRole("button", { name: "停止任务" }).waitFor();
	await page.getByRole("button", { name: "停止任务" }).click();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor({ timeout: 15000 });
	assert.equal(requests, 3);
	await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720));
	await page.screenshot({ path: join(artifacts, "05-minimum.png"), scale: "css", animations: "disabled" });
	const fit = await page.evaluate(() => ({
		width: innerWidth,
		height: innerHeight,
		scrollWidth: document.documentElement.scrollWidth,
		composer: document.querySelector(".composer").getBoundingClientRect().toJSON(),
		sidebar: document.querySelector(".sidebar").getBoundingClientRect().toJSON(),
		main: document.querySelector(".main-workspace").getBoundingClientRect().toJSON(),
	}));
	assert(fit.scrollWidth <= fit.width);
	assert(fit.composer.bottom <= fit.height && fit.composer.left >= 0);
	assert(fit.sidebar.width >= 205 && fit.sidebar.width <= 345);
	assert(Math.abs(fit.main.right - fit.width) < 2, "主工作区必须撑满分栏");
	assert(fit.composer.width >= fit.main.width - 90, "输入区不能收缩到内容宽度");

	// 2.5 应用完全退出后从 SDK JSONL 恢复，再验证故障重开和新对话。
	const previous = await page.evaluate(() => window.piDesktop.getSnapshot());
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.getByText("已读取 README.md。", { exact: true }).waitFor({ timeout: 60000 });
	const restored = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.equal(restored.sessionId, previous.sessionId);
	assert.equal(restored.messages.length, previous.messages.length);
	await page.locator("textarea").fill("长任务，验证宿主退出");
	await page.getByRole("button", { name: "发送任务" }).click();
	// 2.6 恢复的历史中已有相同流式文字，必须等本轮助手开始后才能模拟故障。
	await page.waitForFunction(async () => {
		const current = await window.piDesktop.getSnapshot();
		const last = current.messages.at(-1);
		const user = current.messages.filter((message) => message.role === "user").at(-1);
		return (
			current.run.phase === "working" &&
			user?.blocks.some((block) => block.kind === "text" && block.text === "长任务，验证宿主退出") &&
			last?.role === "assistant" &&
			last.blocks.some((block) => block.kind === "text" && block.text.includes("正在持续处理"))
		);
	});
	await electronApp.evaluate(({ app }) => {
		const host = app.getAppMetrics().find((metric) => metric.name === "Pi Agent");
		if (!host) throw new Error("测试宿主未找到");
		process.kill(host.pid);
	});
	await page.getByRole("status").filter({ hasText: "连接已断开" }).waitFor();
	await electronApp.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor({ timeout: 60000 });
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor({ timeout: 60000 });
	const fresh = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.notEqual(fresh.sessionId, previous.sessionId);
	assert.equal(fresh.messages.length, 0);
	composer = page.locator("textarea");
	await composer.fill("读取 README.md，再次完成任务。");
	await page.getByRole("button", { name: "发送任务" }).click();
	await page.getByText("已读取 README.md。", { exact: true }).waitFor({ timeout: 30000 });
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	assert.equal(requests, 6);
	logger.info("Electron 基础用户路径验证完成");

	/*
	 * ========================================================================
	 * 步骤3：验证会话组织与独立草稿的持久化
	 * ========================================================================
	 * 数据源：真实 SDK 历史、桌面索引与窗口输入。
	 * 操作：
	 *   1) 用实际菜单重命名、置顶、归档，再从搜索结果恢复原会话
	 *   2) 未发送草稿在重载、会话切换和应用重启后保留身份与内容
	 */
	logger.info("开始验证会话历史与草稿");
	// 3.1 历史组织不改变消息数量，不把搜索条件带入新会话。
	await page.getByRole("button", { name: "刷新会话列表" }).click();
	await page.getByRole("button", { name: "会话操作：读取 README.md，再次完成任务。" }).click();
	await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
	await page.getByRole("dialog").waitFor();
	await page.locator("#session-title").fill("历史中文验收");
	await page.getByRole("button", { name: "保存名称" }).click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "会话操作：历史中文验收" }).click();
	await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
	await page.locator(".session-row").filter({ hasText: "历史中文验收" }).locator(".pin-indicator").waitFor();
	await page.getByRole("button", { name: "会话操作：历史中文验收" }).click();
	await page.getByRole("menuitem", { name: "归档", exact: true }).click();
	await page.getByRole("button", { name: "会话操作：历史中文验收" }).waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "最近会话", exact: true }).click();
	await page.getByRole("button", { name: "会话操作：历史中文验收" }).click();
	await page.getByRole("menuitem", { name: "取消归档", exact: true }).click();
	await page.getByRole("button", { name: "已归档", exact: true }).click();
	await page.getByRole("textbox", { name: "搜索会话" }).fill("历史中文");
	assert.equal(await page.locator(".session-row").count(), 1);
	await page.getByRole("textbox", { name: "搜索会话" }).fill("");
	const savedHistory = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.equal(savedHistory.title, "历史中文验收");
	// 3.2 同一项目多份未发送草稿在切换时独立保存。
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	await page.locator("textarea").fill("第一份未发送草稿\n保留中文内容");
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	const firstDraft = await page.evaluate(() => window.piDesktop.getSnapshot());
	await page.getByRole("button", { name: "会话操作：新对话" }).click();
	await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
	await page.locator("#session-title").fill("未发送草稿一");
	await page.getByRole("button", { name: "保存名称" }).click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.querySelector("textarea")?.value === "第一份未发送草稿\n保留中文内容");
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	await page.locator("textarea").fill("第二份独立草稿");
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	await page.locator(".session-open").filter({ hasText: "未发送草稿一" }).click();
	await page.waitForFunction(() => document.querySelector("textarea")?.value === "第一份未发送草稿\n保留中文内容");
	// 3.3 已登记但未落盘的会话不能被 SDK 当成全新身份。
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.waitForFunction(
		() => document.querySelector("textarea")?.value === "第一份未发送草稿\n保留中文内容",
		undefined,
		{ timeout: 60000 },
	);
	const restoredDraft = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.equal(restoredDraft.sessionId, firstDraft.sessionId);
	assert.equal(restoredDraft.title, "未发送草稿一");
	assert.equal(restoredDraft.messages.length, 0);
	await page.locator(".session-open").filter({ hasText: "历史中文验收" }).click();
	await page.getByText("已读取 README.md。", { exact: true }).waitFor();
	const selectedHistory = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.equal(selectedHistory.sessionId, savedHistory.sessionId);
	assert.equal(selectedHistory.messages.length, savedHistory.messages.length);
	assert.equal(await page.locator("textarea").inputValue(), "");
	const rejected = await page.evaluate(async () => {
		try {
			await window.piDesktop.openSession("unknown-session");
			return false;
		} catch {
			return true;
		}
	});
	assert.equal(rejected, true);
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, savedHistory.sessionId);
	await page.screenshot({ path: join(artifacts, "06-session-library.png"), scale: "css", animations: "disabled" });
	logger.info("会话历史与草稿验证完成");

	/*
	 * ========================================================================
	 * 步骤4：验证排队、引导与中断恢复
	 * ========================================================================
	 * 数据源：真实 SDK 队列和已持久化的桌面写前记录。
	 * 操作：
	 *   1) 排队与引导在重载后可见，并按 SDK 语义消费
	 *   2) 停止后先保存恢复草稿；重启和宿主故障后不自动重放
	 */
	logger.info("开始验证排队与引导");
	// 4.1 同一长任务内分别排队和引导，Enter 使用默认排队。
	await page.locator("textarea").fill("长任务，验证两类队列");
	await page.getByRole("button", { name: "发送任务" }).click();
	await page.getByRole("button", { name: "加入队列" }).waitFor();
	await page.locator("textarea").fill("稍后读取文件");
	await page.locator("textarea").press("Enter");
	await page.locator(".task-queue").getByText("稍后读取文件", { exact: true }).waitFor();
	await page.waitForFunction(() => document.querySelector("textarea")?.value === "");
	await page.locator("textarea").fill("先检查中文内容");
	await page.getByRole("button", { name: "引导当前任务" }).click();
	await page.locator(".task-queue").getByText("先检查中文内容", { exact: true }).waitFor();
	await page.locator("textarea").fill("队列消费时保留的新草稿");
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.locator(".task-queue").getByText("稍后读取文件", { exact: true }).waitFor();
	await page.screenshot({ path: join(artifacts, "07-queue.png"), scale: "css", animations: "disabled" });
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor({ timeout: 30000 });
	const consumed = await page.evaluate(() => window.piDesktop.getSnapshot());
	const lastUsers = consumed.messages
		.filter((message) => message.role === "user")
		.slice(-3)
		.map((message) => message.blocks.map((block) => block.text).join(""));
	assert.deepEqual(lastUsers, ["长任务，验证两类队列", "先检查中文内容", "稍后读取文件"]);
	assert.equal(await page.locator("textarea").inputValue(), "队列消费时保留的新草稿");
	assert.equal(await page.locator(".task-queue").count(), 0);
	// 4.2 取消保留剩余队列，恢复先落草稿，不自动发送。
	await page.locator("textarea").fill("长任务，验证停止后恢复");
	await page.getByRole("button", { name: "发送任务" }).click();
	await page.getByRole("button", { name: "加入队列" }).waitFor();
	await page.locator("textarea").fill("停止后保留的后续任务");
	await page.getByRole("button", { name: "加入队列" }).click();
	await page.locator(".task-queue").getByText("停止后保留的后续任务", { exact: true }).waitFor();
	await page.getByRole("button", { name: "停止任务" }).click();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	const stoppedRequests = requests;
	await page.locator("textarea").fill("保留原草稿");
	await page.getByRole("button", { name: "恢复到输入" }).click();
	await page.locator(".task-queue").waitFor({ state: "hidden" });
	assert.equal(await page.locator("textarea").inputValue(), "保留原草稿\n\n停止后保留的后续任务");
	assert.equal(requests, stoppedRequests);
	// 4.3 正常退出保存未消费队列，重启只提供待核对内容。
	await page.locator("textarea").fill("长任务，验证退出恢复队列");
	await page.getByRole("button", { name: "发送任务" }).click();
	await page.getByRole("button", { name: "加入队列" }).waitFor();
	await page.locator("textarea").fill("退出后保留的任务");
	await page.getByRole("button", { name: "加入队列" }).click();
	await page.locator(".task-queue").getByText("退出后保留的任务", { exact: true }).waitFor();
	const beforeExitRequests = requests;
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.locator(".task-queue").getByText("退出后保留的任务", { exact: true }).waitFor({ timeout: 60000 });
	await page.getByText("上次中断的输入可能已被处理。核对聊天记录后，可恢复到输入再发送。", { exact: true }).waitFor();
	assert.equal(requests, beforeExitRequests);
	await page.getByRole("button", { name: "清空队列" }).click();
	await page.locator(".task-queue").waitFor({ state: "hidden" });
	// 4.4 宿主异常退出仍保留已确认的队列，恢复草稿也可再次重启。
	await page.locator("textarea").fill("长任务，验证故障恢复队列");
	await page.getByRole("button", { name: "发送任务" }).click();
	await page.getByRole("button", { name: "加入队列" }).waitFor();
	await page.locator("textarea").fill("故障后待核对的输入");
	await page.getByRole("button", { name: "加入队列" }).click();
	await page.locator(".task-queue").getByText("故障后待核对的输入", { exact: true }).waitFor();
	await page.waitForFunction(() => document.querySelector("textarea")?.value === "");
	await electronApp.evaluate(({ app }) => {
		const host = app.getAppMetrics().find((metric) => metric.name === "Pi Agent");
		if (!host) throw new Error("测试宿主未找到");
		process.kill(host.pid);
	});
	await page.getByRole("status").filter({ hasText: "连接已断开" }).waitFor();
	const beforeRecoveryRequests = requests;
	await electronApp.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor({ timeout: 60000 });
	await page.locator(".task-queue").getByText("故障后待核对的输入", { exact: true }).waitFor();
	assert.equal(requests, beforeRecoveryRequests);
	await page.getByRole("button", { name: "恢复到输入" }).click();
	await page.locator(".task-queue").waitFor({ state: "hidden" });
	assert.equal(await page.locator("textarea").inputValue(), "故障后待核对的输入");
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.waitForFunction(() => document.querySelector("textarea")?.value === "故障后待核对的输入", undefined, {
		timeout: 60000,
	});
	assert.equal(await page.locator(".task-queue").count(), 0);
	assert.equal(requests, beforeRecoveryRequests);
	logger.info("排队、引导与中断恢复验证完成");

	/*
	 * ========================================================================
	 * 步骤5：验证消息分支、来源和独立草稿
	 * ========================================================================
	 * 数据源：真实 SDK JSONL 与消息操作按钮，不自动提交分支输入。
	 * 操作：
	 *   1) 重复消息按原生 ID 分支，来源文件保持原样
	 *   2) 重启恢复分支身份、草稿与来源，后续发送只改变分支会话
	 */
	logger.info("开始验证会话分支");
	// 5.1 首条消息没有可持久化前缀，之后的重复消息分别提供入口。
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	for (let index = 0; index < 3; index++) {
		await page.locator("textarea").fill("分支重复问题");
		await page.getByRole("button", { name: "发送任务" }).click();
		await page.waitForFunction(async (expected) => {
			const snapshot = await window.piDesktop.getSnapshot();
			return (
				snapshot.run.phase === "idle" &&
				snapshot.messages.filter((message) => message.role === "user").length === expected
			);
		}, index + 1);
		await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
		await page.waitForFunction(
			(expected) => document.querySelectorAll('[aria-label="从此消息分支"]').length === expected,
			index,
		);
	}
	await page.getByRole("button", { name: "会话操作：分支重复问题", exact: true }).click();
	await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
	await page.locator("#session-title").fill("分支来源验收");
	await page.getByRole("button", { name: "保存名称" }).click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	await page.locator("textarea").fill("来源会话的独立草稿");
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	const source = await page.evaluate(() => window.piDesktop.getSnapshot());
	const candidates = source.messages.filter((message) => message.forkEntryId);
	assert.equal(new Set(candidates.map((message) => message.forkEntryId)).size, 2);
	const selected = candidates.at(-1);
	const prefix = source.messages.slice(
		0,
		source.messages.findIndex((message) => message.id === selected.id),
	);
	const sessionFiles = await readdir(join(agentDirectory, "sessions"), { recursive: true });
	const sourceName = sessionFiles.find((file) => file.endsWith(`_${source.sessionId}.jsonl`));
	assert(sourceName);
	const sourcePath = join(agentDirectory, "sessions", sourceName);
	const sourceBytes = await readFile(sourcePath, "utf8");
	const beforeForkRequests = requests;
	await page.getByRole("button", { name: "从此消息分支", exact: true }).last().click();
	await page.waitForFunction(() => document.querySelector("textarea")?.value === "分支重复问题");
	await page.locator(".branch-origin").getByRole("button", { name: "分支来源验收", exact: true }).waitFor();
	const branch = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.notEqual(branch.sessionId, source.sessionId);
	assert.deepEqual(
		branch.messages.map(({ role, blocks }) => ({ role, blocks })),
		prefix.map(({ role, blocks }) => ({ role, blocks })),
	);
	assert.equal(await readFile(sourcePath, "utf8"), sourceBytes);
	assert.equal(requests, beforeForkRequests);
	assert(await page.locator("textarea").evaluate((element) => element === document.activeElement));
	await page.screenshot({ path: join(artifacts, "08-fork.png"), scale: "css", animations: "disabled" });
	// 5.2 重启不重发选中消息，来源链接恢复原消息与独立草稿。
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.waitForFunction(() => document.querySelector("textarea")?.value === "分支重复问题", undefined, {
		timeout: 60000,
	});
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, branch.sessionId);
	assert.equal(requests, beforeForkRequests);
	await page.locator(".branch-origin").getByRole("button", { name: "分支来源验收", exact: true }).click();
	await page.waitForFunction(() => document.querySelector("textarea")?.value === "来源会话的独立草稿");
	const reopenedSource = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.equal(reopenedSource.sessionId, source.sessionId);
	assert.deepEqual(
		reopenedSource.messages.map(({ role, blocks }) => ({ role, blocks })),
		source.messages.map(({ role, blocks }) => ({ role, blocks })),
	);
	assert.equal(await readFile(sourcePath, "utf8"), sourceBytes);
	const staleForkRejected = await page.evaluate(
		async (selection) => {
			try {
				await window.piDesktop.forkSession(selection);
				return false;
			} catch {
				return true;
			}
		},
		{ sessionId: source.sessionId, generation: source.generation, entryId: selected.forkEntryId },
	);
	assert.equal(staleForkRejected, true);
	// 5.3 用户明确发送后才请求模型，新结果不会覆盖来源消息。
	await page.locator(".session-open").filter({ hasText: branch.title }).click();
	await page.waitForFunction(() => document.querySelector("textarea")?.value === "分支重复问题");
	await page.locator("textarea").fill("读取 README.md，验证分支继续任务。");
	await page.getByRole("button", { name: "发送任务" }).click();
	await page.waitForFunction(async (expected) => {
		const snapshot = await window.piDesktop.getSnapshot();
		return snapshot.run.phase === "idle" && snapshot.messages.length === expected;
	}, branch.messages.length + 3);
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	assert.equal(requests, beforeForkRequests + 2);
	assert.equal(await readFile(sourcePath, "utf8"), sourceBytes);
	const continuedBranch = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.equal(continuedBranch.sessionId, branch.sessionId);
	assert.equal(continuedBranch.messages.length, branch.messages.length + 3);
	logger.info("会话分支验证完成");
	// 5.4 不把超长传输片段展示成可复制的完整代码块或消息。
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	await page.locator("textarea").fill("超长正文验收");
	await page.getByRole("button", { name: "发送任务" }).click();
	await page.getByText("正文过长，仅展示部分内容，暂不可整段复制。", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	assert.equal(await page.getByRole("button", { name: "复制助手消息", exact: true }).count(), 0);
	assert.equal(await page.getByRole("button", { name: "复制代码", exact: true }).count(), 0);

	/*
	 * ========================================================================
	 * 步骤6：验证项目文件引用的完整用户路径
	 * ========================================================================
	 * 数据源：真实原生对话框接口、中文文件和会话草稿，不上传文件正文。
	 * 操作：
	 *   1) 取消与混入越界文件不改草稿，有效选择去重后保留最新输入
	 *   2) 引用跨重载、切换和重启恢复，明确发送后才由 SDK read 工具读取
	 */
	logger.info("开始验证项目文件引用");
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	const referenceInput = "请检查引用的文件。  \n";
	await page.locator("textarea").fill(referenceInput);
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	const beforeReferencesRequests = requests;
	// 6.1 原生取消和整批越界都保留原输入，不能部分加入有效文件。
	await electronApp.evaluate(({ dialog }) => {
		dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
	});
	await page.getByRole("button", { name: "引用项目文件", exact: true }).click();
	await page.waitForFunction(() => !document.querySelector("textarea").disabled);
	assert.equal(await page.locator("textarea").inputValue(), referenceInput);
	await electronApp.evaluate(
		({ dialog }, paths) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
		},
		[join(project, "README.md"), join(artifacts, "outside.txt")],
	);
	await page.getByRole("button", { name: "引用项目文件", exact: true }).click();
	await page.locator(".workspace-error").filter({ hasText: "只能引用当前项目内的文件" }).waitFor();
	assert.equal(await page.locator("textarea").inputValue(), referenceInput);
	await electronApp.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async (_window, options) => {
			if (
				options.title !== "引用项目文件" ||
				options.defaultPath !== cwd ||
				!options.properties.includes("multiSelections")
			)
				throw new Error("文件选择必须使用当前项目与多选配置");
			return {
				canceled: false,
				filePaths: [`${cwd}/README.md`, `${cwd}/src/中文 文件.ts`, `${cwd}/README.md`],
			};
		};
	}, project);
	await page.getByRole("button", { name: "引用项目文件", exact: true }).click();
	const referenceDraft = `${referenceInput}@"README.md"\n@"src/中文 文件.ts"\n`;
	await page.waitForFunction((text) => document.querySelector("textarea")?.value === text, referenceDraft);
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	assert(await page.locator("textarea").evaluate((element) => element === document.activeElement));
	assert.equal(requests, beforeReferencesRequests);
	const referenceSession = await page.evaluate(() => window.piDesktop.getSnapshot());
	await page.screenshot({ path: join(artifacts, "09-project-files.png"), scale: "css", animations: "disabled" });
	const referenceFit = await page.evaluate(() => ({
		width: innerWidth,
		scrollWidth: document.documentElement.scrollWidth,
		options: document.querySelector(".composer-options").getBoundingClientRect().toJSON(),
		actions: document.querySelector(".composer-actions").getBoundingClientRect().toJSON(),
	}));
	assert(referenceFit.scrollWidth <= referenceFit.width && referenceFit.options.right <= referenceFit.actions.left);
	// 6.2 文件引用仍是原有文本草稿，切换到另一会话后能够原样恢复。
	await page.locator(".session-row.active").getByRole("button", { name: "会话操作：新对话", exact: true }).click();
	await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
	await page.locator("#session-title").fill("文件引用验收");
	await page.getByRole("button", { name: "保存名称" }).click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction((text) => document.querySelector("textarea")?.value === text, referenceDraft);
	await page.locator(".new-thread").click();
	await page.waitForFunction(() => {
		const textarea = document.querySelector("textarea");
		return textarea && !textarea.disabled && textarea.value === "";
	});
	assert.equal(await page.locator("textarea").inputValue(), "");
	await page.locator(".session-open").filter({ hasText: "文件引用验收" }).click();
	await page.waitForFunction((text) => document.querySelector("textarea")?.value === text, referenceDraft);
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.waitForFunction((text) => document.querySelector("textarea")?.value === text, referenceDraft, {
		timeout: 60000,
	});
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, referenceSession.sessionId);
	assert.equal(requests, beforeReferencesRequests);
	const staleReferenceRejected = await page.evaluate(
		async (selection) => {
			try {
				await window.piDesktop.selectProjectFiles(selection);
				return false;
			} catch {
				return true;
			}
		},
		{ sessionId: referenceSession.sessionId, generation: referenceSession.generation },
	);
	assert.equal(staleReferenceRejected, true);
	// 6.3 模型收到相对路径后调用真实 read；界面不声称文件正文已附加。
	await page.getByRole("button", { name: "发送任务" }).click();
	await page.getByText("已读取引用文件，referenceReady 可用。", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	const referencedResult = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.equal(referencedResult.tools.at(-1).name, "read");
	assert(referencedResult.tools.at(-1).output.includes("referenceReady"));
	assert.equal(requests, beforeReferencesRequests + 2);
	assert.equal(await page.locator("textarea").inputValue(), "");
	logger.info("项目文件引用验证完成");

	/*
	 * ========================================================================
	 * 步骤7：验证图片选择、持久化、发送与中断恢复
	 * ========================================================================
	 * 数据源：Electron 编码的本地 PNG、真实 SDK 图片参数和独立草稿。
	 * 操作：
	 *   1) 取消、损坏文件和模型能力受控，原图删除后草稿仍能恢复
	 *   2) 收束后清理原草稿，重启保留历史预览，中断不自动重发图片
	 */
	logger.info("开始验证 PNG 图片附件");
	let previewLoads = 0;
	page.on("console", (message) => {
		if (message.text() === "[image-preview] 开始读取图片缩略图") previewLoads++;
	});
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	const imageFile = join(artifacts, "中文 图片.jpeg");
	const png = await electronApp.evaluate(({ nativeImage }) =>
		nativeImage
			.createFromBitmap(Buffer.alloc(64 * 32 * 4, 180), { width: 64, height: 32 })
			.toPNG()
			.toString("base64"),
	);
	const jpeg = await electronApp.evaluate(
		({ nativeImage }, data) => nativeImage.createFromBuffer(Buffer.from(data, "base64")).toJPEG(90).toString("base64"),
		png,
	);
	await writeFile(imageFile, Buffer.from(jpeg, "base64"));
	await writeFile(join(artifacts, "fake.png"), "not a PNG");
	await page.locator("textarea").fill("图片任务，检查附件。");
	await electronApp.evaluate(({ dialog }) => {
		dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
	});
	await page.getByRole("button", { name: "添加图片附件", exact: true }).click();
	await page.waitForFunction(() => !document.querySelector("textarea").disabled);
	assert.equal(await page.getByLabel("草稿图片附件", { exact: true }).count(), 0);
	await electronApp.evaluate(
		({ dialog }, paths) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
		},
		[imageFile, join(artifacts, "fake.png")],
	);
	await page.getByRole("button", { name: "添加图片附件", exact: true }).click();
	await page.locator(".workspace-error").filter({ hasText: "有效的 PNG" }).waitFor();
	assert.equal(await page.getByLabel("草稿图片附件", { exact: true }).count(), 0);
	await electronApp.evaluate(({ dialog }, file) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file, file] });
	}, imageFile);
	await page.getByRole("button", { name: "添加图片附件", exact: true }).click();
	await page
		.getByLabel("草稿图片附件", { exact: true })
		.getByRole("button", { name: "查看图片附件", exact: true })
		.waitFor();
	assert.equal(await page.getByLabel("草稿图片附件", { exact: true }).locator("img").count(), 1);
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	const imageSession = await page.evaluate(() => window.piDesktop.getSnapshot());
	const imageDraft = await page.evaluate((id) => window.piDesktop.loadDraft(id), imageSession.sessionId);
	assert.equal(imageDraft.imageIds.length, 1);
	assert(!JSON.stringify(imageDraft).includes(png));
	assert.equal(imageRequests, 0);
	const readsBeforeTyping = previewLoads;
	await page.locator("textarea").fill("图片任务，修改说明。");
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	await page.locator("textarea").fill("图片任务，检查附件。");
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	assert.equal(previewLoads, readsBeforeTyping, "编辑说明不能重复读取图片");
	await page
		.getByLabel("草稿图片附件", { exact: true })
		.getByRole("button", { name: "查看图片附件", exact: true })
		.click();
	await page.getByRole("dialog", { name: "图片附件", exact: true }).waitFor();
	await page.keyboard.press("Escape");
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	// 7.1 删除原文件、重载和应用重启均从本地内容库读取，不重新选图或发送。
	await unlink(imageFile);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.getByLabel("草稿图片附件", { exact: true }).locator("img").waitFor();
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.getByLabel("草稿图片附件", { exact: true }).locator("img").waitFor({ timeout: 60000 });
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, imageSession.sessionId);
	assert.equal(imageRequests, 0);
	// 7.2 切换文本模型不会丢掉附件，发送给文本模型必须明确失败。
	await page.getByRole("button", { name: "模型", exact: true }).click();
	await page.locator('[data-slot="input"] input').fill("快速验收模型");
	await page.getByRole("option", { name: /快速验收模型/ }).click();
	await page.waitForFunction(async () => !(await window.piDesktop.getSnapshot()).configuration.model.supportsImages);
	assert(await page.getByRole("button", { name: "添加图片附件", exact: true }).isDisabled());
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.locator(".workspace-error").filter({ hasText: "不支持图片" }).waitFor();
	assert.equal(imageRequests, 0);
	await page.getByRole("button", { name: "模型", exact: true }).click();
	await page.locator('[data-slot="input"] input').fill("离线验收模型");
	await page.getByRole("option", { name: /离线验收模型/ }).click();
	await page.waitForFunction(async () => (await window.piDesktop.getSnapshot()).configuration.model.supportsImages);
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByText("图片已收到。", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	await page.waitForFunction(
		() => !document.querySelector('[aria-label="草稿图片附件"]') && document.querySelector("textarea")?.value === "",
	);
	await page.getByLabel("消息图片附件", { exact: true }).locator("img").waitFor();
	assert.equal(imageRequests, 1);
	await page.getByRole("button", { name: "复制用户消息", exact: true }).click();
	assert.equal(await electronApp.evaluate(({ clipboard }) => clipboard.readText()), "图片任务，检查附件。");
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.getByLabel("消息图片附件", { exact: true }).locator("img").waitFor();
	await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720));
	await page.screenshot({ path: join(artifacts, "10-images.png"), scale: "css", animations: "disabled" });
	const imageFit = await page.evaluate(() => ({
		width: innerWidth,
		scrollWidth: document.documentElement.scrollWidth,
		options: document.querySelector(".composer-options").getBoundingClientRect().toJSON(),
		actions: document.querySelector(".composer-actions").getBoundingClientRect().toJSON(),
	}));
	assert(imageFit.scrollWidth <= imageFit.width && imageFit.options.right <= imageFit.actions.left);
	// 7.3 任务被宿主故障中断时保留图片草稿，重启后不自动重放。
	await writeFile(imageFile, Buffer.from(jpeg, "base64"));
	await electronApp.evaluate(({ dialog }, file) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
	}, imageFile);
	await page.locator("textarea").fill("长任务，图片中断验收");
	await page.getByRole("button", { name: "添加图片附件", exact: true }).click();
	await page.getByLabel("草稿图片附件", { exact: true }).locator("img").waitFor();
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page
		.getByText(/正在持续处理/)
		.last()
		.waitFor();
	assert.equal(await page.locator("textarea").inputValue(), "长任务，图片中断验收");
	await electronApp.evaluate(({ app }) => {
		const host = app.getAppMetrics().find((metric) => metric.name === "Pi Agent");
		if (!host) throw new Error("测试宿主未找到");
		process.kill(host.pid);
	});
	await page.getByRole("status").filter({ hasText: "连接已断开" }).waitFor();
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.getByLabel("草稿图片附件", { exact: true }).locator("img").waitFor({ timeout: 60000 });
	assert.equal(await page.locator("textarea").inputValue(), "长任务，图片中断验收");
	assert.equal(imageRequests, 2);
	await page
		.getByLabel("草稿图片附件", { exact: true })
		.getByRole("button", { name: "移除图片附件", exact: true })
		.click();
	await page.getByLabel("草稿图片附件", { exact: true }).waitFor({ state: "hidden" });
	assert.equal(await page.locator("textarea").inputValue(), "长任务，图片中断验收");
	logger.info("PNG 图片附件验证完成");

	/*
	 * ========================================================================
	 * 步骤8：验证输入区文件事件、整批失败与恢复
	 * ========================================================================
	 * 数据源：合成粘贴 / 拖放事件与真实 File、IPC、原生解码和 SDK。
	 * 操作：
	 *   1) 纯文字不拦截，文件混选、内容伪造和文本模型拒绝不改原草稿
	 *   2) 有效图片去重并可重启恢复，明确发送后才请求模型
	 */
	logger.info("开始验证图片粘贴与拖放");
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	const eventText = "  图片任务，粘贴与拖放。\n";
	await page.locator("textarea").fill(eventText);
	const beforeEventRequests = imageRequests;
	const firstImage = { name: "粘贴图片.png", mime: "image/png", data: png };
	const secondJpeg = await electronApp.evaluate(({ nativeImage }) => {
		const pixels = Buffer.alloc(64 * 40 * 4);
		for (let offset = 0; offset < pixels.length; offset += 4) {
			pixels.set([120, 84, 61, 255], offset);
		}
		return nativeImage.createFromBitmap(pixels, { width: 64, height: 40 }).toJPEG(90).toString("base64");
	});
	const secondImage = { name: "拖放图片.jpeg", mime: "image/jpeg", data: secondJpeg };
	// 8.1 不拦截纯文字，文件事件不能默认插入路径或打开页面。
	assert.equal(await dispatchFileInput(page, "paste", [], "纯文字粘贴"), false);
	assert.equal(await dispatchFileInput(page, "drop", [], "https://example.invalid/"), false);
	assert.equal(
		await dispatchFileInput(page, "paste", [firstImage, { name: "file.ts", mime: "text/plain", data: "dGV4dA==" }]),
		true,
	);
	await page.locator(".workspace-error").filter({ hasText: "仅支持 PNG" }).waitFor();
	assert.equal(await page.getByLabel("草稿图片附件", { exact: true }).count(), 0);
	assert.equal(await page.locator("textarea").inputValue(), eventText);
	assert.equal(
		await dispatchFileInput(page, "drop", [firstImage, { name: "fake.png", mime: "image/png", data: "bm90IGEgcG5n" }]),
		true,
	);
	await page.locator(".workspace-error").filter({ hasText: "有效的 PNG" }).waitFor();
	assert.equal(await page.getByLabel("草稿图片附件", { exact: true }).count(), 0);
	// 8.2 文本模型在读取文件前拒绝，原说明仍然保留。
	await page.getByRole("button", { name: "模型", exact: true }).click();
	await page.locator('[data-slot="input"] input').fill("快速验收模型");
	await page.getByRole("option", { name: /快速验收模型/ }).click();
	await page.waitForFunction(async () => !(await window.piDesktop.getSnapshot()).configuration.model.supportsImages);
	await dispatchFileInput(page, "paste", [firstImage]);
	await page.locator(".workspace-error").filter({ hasText: "不支持图片" }).waitFor();
	assert.equal(await page.locator("textarea").inputValue(), eventText);
	await page.getByRole("button", { name: "模型", exact: true }).click();
	await page.locator('[data-slot="input"] input').fill("离线验收模型");
	await page.getByRole("option", { name: /离线验收模型/ }).click();
	await page.waitForFunction(async () => (await window.piDesktop.getSnapshot()).configuration.model.supportsImages);
	// 8.3 粘贴去重，拖放展示落点，两个入口共同保存同一份草稿。
	await dispatchFileInput(page, "paste", [firstImage]);
	await page.getByLabel("草稿图片附件", { exact: true }).locator("img").waitFor();
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	await dispatchFileInput(page, "paste", [firstImage]);
	await page.waitForFunction(() => !document.querySelector("textarea").disabled);
	assert.equal(await page.getByLabel("草稿图片附件", { exact: true }).locator("img").count(), 1);
	assert.equal(await dispatchFileInput(page, "dragover", [secondImage]), true);
	await page.getByText("松开以添加 PNG 或 JPEG 图片", { exact: true }).waitFor();
	await page.screenshot({ path: join(artifacts, "11-image-drop-zone.png"), scale: "css", animations: "disabled" });
	await dispatchFileInput(page, "drop", [secondImage]);
	await page.waitForFunction(() => {
		const images = [...document.querySelectorAll('[aria-label="草稿图片附件"] img')];
		return images.length === 2 && images.every((image) => image.naturalWidth > 0);
	});
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	assert.equal(await page.locator("textarea").inputValue(), eventText);
	assert(await page.locator("textarea").evaluate((element) => element === document.activeElement));
	assert.equal(await page.locator(".image-drop-hint").count(), 0);
	await dispatchFileInput(page, "drop", Array(5).fill(firstImage));
	await page.locator(".workspace-error").filter({ hasText: "最多添加 4 张" }).waitFor();
	assert.equal(await page.getByLabel("草稿图片附件", { exact: true }).locator("img").count(), 2);
	assert.equal(imageRequests, beforeEventRequests);
	await page.screenshot({ path: join(artifacts, "12-transferred-images.png"), scale: "css", animations: "disabled" });
	// 8.4 重载与重启保留两张图，发送仍通过真实 SDK 图片参数。
	const eventSession = await page.evaluate(() => window.piDesktop.getSnapshot());
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.querySelectorAll('[aria-label="草稿图片附件"] img').length === 2);
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.waitForFunction(
		() => document.querySelectorAll('[aria-label="草稿图片附件"] img').length === 2,
		undefined,
		{ timeout: 60000 },
	);
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, eventSession.sessionId);
	assert.equal(await page.locator("textarea").inputValue(), eventText);
	assert.equal(imageRequests, beforeEventRequests);
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByText("图片已收到。", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	await page.waitForFunction(
		() =>
			!document.querySelector('[aria-label="草稿图片附件"]') &&
			document.querySelectorAll('[aria-label="消息图片附件"] img').length === 2,
	);
	assert.equal(imageRequests, beforeEventRequests + 1);
	assert.equal(imageMessageSizes.at(-1), 2);
	assert.equal(await page.locator("textarea").inputValue(), "");
	logger.info("图片粘贴与拖放验证完成");

	/*
	 * ========================================================================
	 * 步骤9：验证搜索引用、键盘交互与候选失效
	 * ========================================================================
	 * 数据源：真实项目扫描、逐层忽略规则、原生文件回退和会话草稿。
	 * 操作：
	 *   1) 空状态、中文查询、组词和键盘选择不发送任务，受限结果明确提示
	 *   2) 搜索失败可重试，失效文件不进入草稿，重启后明确发送才读取正文
	 */
	logger.info("开始验证项目文件搜索");
	await writeFile(join(project, ".gitignore"), "search-hidden*.ts\nsearch-excluded/\n", "utf8");
	await writeFile(join(project, "src", ".gitignore"), "!search-hidden-keep.ts\n", "utf8");
	await mkdir(join(project, "search-excluded"));
	await Promise.all(
		["src/search-hidden-keep.ts", "src/search-hidden-drop.ts", "src/search-transient.ts", "search-excluded/file.ts"]
			.concat(Array.from({ length: 24 }, (_, index) => `src/search-limit-${index}.ts`))
			.map((path) => writeFile(join(project, path), "// search fixture\n", "utf8")),
	);
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	const searchText = "请检查搜索引用。  \n";
	await page.locator("textarea").fill(searchText);
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	const beforeSearchRequests = requests;
	const searchDialog = page.getByRole("dialog", { name: "搜索项目文件", exact: true });
	const searchQuery = page.getByLabel("搜索文件名", { exact: true });
	// 9.1 取消不改草稿，空查询和无结果有明确提示。
	await page.getByRole("button", { name: "搜索项目文件", exact: true }).click();
	await searchDialog.getByText("输入文件名开始搜索", { exact: true }).waitFor();
	assert.equal(await searchQuery.getAttribute("maxlength"), "200");
	assert.equal(await searchDialog.getByRole("option").count(), 0);
	await searchQuery.fill("no-file-matches-this-query");
	await searchDialog.getByText("没有匹配文件", { exact: true }).waitFor();
	await searchQuery.press("Escape");
	await searchDialog.waitFor({ state: "hidden" });
	assert.equal(await page.locator("textarea").inputValue(), searchText);
	await page.getByRole("button", { name: "搜索项目文件", exact: true }).click();
	await searchQuery.fill("src\\中文");
	await searchDialog.getByRole("option", { name: "src/中文 文件.ts", exact: true }).waitFor();
	await searchQuery.dispatchEvent("compositionstart");
	await searchQuery.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
	assert(await searchDialog.isVisible());
	assert.equal(await page.locator("textarea").inputValue(), searchText);
	await searchQuery.dispatchEvent("compositionend");
	await page.screenshot({ path: join(artifacts, "13-file-search.png"), scale: "css", animations: "disabled" });
	await searchQuery.press("Enter");
	await searchDialog.waitFor({ state: "hidden" });
	const searchDraft = `${searchText}@"src/中文 文件.ts"\n`;
	await page.waitForFunction((text) => document.querySelector("textarea")?.value === text, searchDraft);
	await page.waitForFunction(() => document.querySelector("textarea") === document.activeElement);
	assert.equal(requests, beforeSearchRequests);
	// 9.2 子目录规则可以恢复文件，全部二十条候选可见并提示不完整。
	await page.getByRole("button", { name: "搜索项目文件", exact: true }).click();
	await searchQuery.fill("search-hidden");
	await searchDialog.getByRole("option", { name: "src/search-hidden-keep.ts", exact: true }).waitFor();
	assert.equal(await searchDialog.getByRole("option").count(), 1);
	await searchQuery.fill("search-excluded");
	await searchDialog.getByText("没有匹配文件", { exact: true }).waitFor();
	await searchQuery.fill("search-limit");
	await searchDialog.getByText("搜索结果不完整，请缩小查询或使用原生选择。", { exact: true }).waitFor();
	assert.equal(await searchDialog.getByRole("option").count(), 20);
	await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720));
	const searchFit = await searchDialog.boundingBox();
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	assert(searchFit.x >= 0 && searchFit.y >= 0);
	assert(searchFit.x + searchFit.width <= viewport.width && searchFit.y + searchFit.height <= viewport.height);
	await page.screenshot({ path: join(artifacts, "14-file-search-limit.png"), scale: "css", animations: "disabled" });
	// 9.3 规则读取失败保留重试入口，不能静默显示空结果。
	await writeFile(join(project, "src", ".gitignore"), "x".repeat(65 * 1024), "utf8");
	await searchQuery.fill("search-hidden");
	await searchDialog.getByText("文件搜索失败，可重试或使用原生文件选择", { exact: true }).waitFor();
	await writeFile(join(project, "src", ".gitignore"), "!search-hidden-keep.ts\n", "utf8");
	await searchDialog.getByRole("button", { name: "重试搜索", exact: true }).click();
	await searchDialog.getByRole("option", { name: "src/search-hidden-keep.ts", exact: true }).waitFor();
	assert.equal(await searchDialog.getByRole("button", { name: "重试搜索", exact: true }).count(), 0);
	// 9.4 选择前删除文件必须失败，回退须等搜索弹窗关闭后才打开原生选择。
	await searchQuery.fill("search-transient");
	const transient = searchDialog.getByRole("option", { name: "src/search-transient.ts", exact: true });
	await transient.waitFor();
	await unlink(join(project, "src", "search-transient.ts"));
	await transient.click();
	await searchDialog.getByRole("alert").waitFor();
	assert.equal(await page.locator("textarea").inputValue(), searchDraft);
	await electronApp.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async (_window, options) => {
			if (options.defaultPath !== cwd) throw new Error("原生选择必须保留当前项目目录");
			return { canceled: false, filePaths: [`${cwd}/README.md`] };
		};
	}, project);
	await searchDialog.getByRole("button", { name: "使用原生文件选择", exact: true }).click();
	await searchDialog.waitFor({ state: "hidden" });
	const fallbackDraft = `${searchDraft}@"README.md"\n`;
	await page.waitForFunction((text) => document.querySelector("textarea")?.value === text, fallbackDraft);
	await page.waitForFunction(() => document.querySelector("textarea") === document.activeElement);
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	assert.equal(requests, beforeSearchRequests);
	// 9.5 搜索结果复用原草稿持久化与 SDK 工具读取，不建立第二条发送链路。
	const searchSession = await page.evaluate(() => window.piDesktop.getSnapshot());
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction((text) => document.querySelector("textarea")?.value === text, fallbackDraft);
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.waitForFunction((text) => document.querySelector("textarea")?.value === text, fallbackDraft, {
		timeout: 60000,
	});
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, searchSession.sessionId);
	assert.equal(requests, beforeSearchRequests);
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByText("已读取引用文件，referenceReady 可用。", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	assert.equal(requests, beforeSearchRequests + 2);
	assert.equal(await page.locator("textarea").inputValue(), "");
	logger.info("项目文件搜索验证完成");

	/*
	 * ========================================================================
	 * 步骤10：验证行内文件补全与发送键的优先级
	 * ========================================================================
	 * 数据源：真实 textarea 选择位置、键盘事件、文件搜索和草稿恢复。
	 * 操作：
	 *   1) Enter、Tab、方向键和组词只处理当前片段，保留前后正文与焦点
	 *   2) 失效文件、无结果和会话更换不误发任务，重启后明确发送才读取
	 */
	logger.info("开始验证行内文件补全");
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	const beforeCompletionRequests = requests;
	let inlineComposer = page.locator("textarea");
	let completionList = page.getByRole("listbox", { name: "文件补全候选", exact: true });
	await inlineComposer.fill("前文 @src/中文");
	await completionList.getByRole("option", { name: "src/中文 文件.ts", exact: true }).waitFor();
	assert.equal(await inlineComposer.getAttribute("aria-controls"), await completionList.getAttribute("id"));
	await page.screenshot({ path: join(artifacts, "15-inline-completion.png"), scale: "css", animations: "disabled" });
	// 10.1 长按 Enter 不能在补全完成后继续触发发送。
	await page.keyboard.down("Enter");
	await page.waitForFunction(() => document.querySelector("textarea")?.value === '前文 @"src/中文 文件.ts" ');
	await page.waitForFunction(() => document.querySelector("textarea") === document.activeElement);
	await page.keyboard.down("Shift");
	await page.keyboard.up("Shift");
	await page.keyboard.down("Enter");
	await page.keyboard.up("Enter");
	assert.equal(requests, beforeCompletionRequests);
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).messages.length, 0);
	assert(await inlineComposer.evaluate((element) => element === document.activeElement));
	await completionList.waitFor({ state: "hidden" });
	// 10.2 补全光标中间的整个片段，Tab 和鼠标都保留后文及空白。
	for (const source of ["前文 @src/中文-old.ts 后文\n", '前文 @"src/中文 旧.ts" 后文\n']) {
		await inlineComposer.fill(source);
		await inlineComposer.evaluate(
			(element, cursor) => element.setSelectionRange(cursor, cursor),
			source.indexOf("中文") + 2,
		);
		await completionList.getByRole("option", { name: "src/中文 文件.ts", exact: true }).waitFor();
		if (source.includes('"'))
			await completionList.getByRole("option", { name: "src/中文 文件.ts", exact: true }).click();
		else await inlineComposer.press("Tab");
		await page.waitForFunction(() => document.querySelector("textarea")?.value === '前文 @"src/中文 文件.ts" 后文\n');
		await page.waitForFunction(() => {
			const element = document.querySelector("textarea");
			return (
				element === document.activeElement &&
				!element.disabled &&
				element.selectionStart === element.value.indexOf("后文")
			);
		});
		assert.equal(requests, beforeCompletionRequests);
	}
	// 10.3 方向键切换并滚动到末项，二十条结果均可选择。
	await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720));
	await inlineComposer.fill(`${"保留正文\n".repeat(7)}@src/search-limit`);
	await page.locator(".file-completion-note").filter({ hasText: "结果不完整" }).waitFor();
	assert.equal(await completionList.getByRole("option").count(), 20);
	await inlineComposer.press("ArrowDown");
	assert.equal(await completionList.getByRole("option").nth(1).getAttribute("aria-selected"), "true");
	await inlineComposer.press("ArrowUp");
	await inlineComposer.press("ArrowUp");
	const lastCompletion = completionList.getByRole("option").last();
	assert.equal(await lastCompletion.getAttribute("aria-selected"), "true");
	assert.equal(await inlineComposer.getAttribute("aria-activedescendant"), await lastCompletion.getAttribute("id"));
	const completionBounds = await page.locator(".file-completion").boundingBox();
	const completionViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	assert(completionBounds.x >= 0 && completionBounds.y >= 0);
	assert(completionBounds.x + completionBounds.width <= completionViewport.width);
	assert(completionBounds.y + completionBounds.height <= completionViewport.height);
	const listBounds = await completionList.boundingBox();
	const lastBounds = await lastCompletion.boundingBox();
	assert(lastBounds.y >= listBounds.y && lastBounds.y + lastBounds.height <= listBounds.y + listBounds.height + 1);
	await page.screenshot({
		path: join(artifacts, "16-inline-completion-minimum.png"),
		scale: "css",
		animations: "disabled",
	});
	await inlineComposer.press("Tab");
	await completionList.waitFor({ state: "hidden" });
	assert.equal(requests, beforeCompletionRequests);
	// 10.4 无结果时 Enter 保留输入，Tab 可离开；Escape 不让输入区失焦。
	await inlineComposer.fill("前文 @no-completion-matches-this-name");
	await page.locator(".file-completion-note").getByText("没有匹配文件", { exact: true }).waitFor();
	await inlineComposer.press("Enter");
	assert.equal(await inlineComposer.inputValue(), "前文 @no-completion-matches-this-name");
	assert.equal(requests, beforeCompletionRequests);
	await inlineComposer.press("Tab");
	await completionList.waitFor({ state: "hidden" });
	assert(!(await inlineComposer.evaluate((element) => element === document.activeElement)));
	await inlineComposer.fill("前文 @src/中文");
	await completionList.getByRole("option", { name: "src/中文 文件.ts", exact: true }).waitFor();
	await inlineComposer.press("Escape");
	await completionList.waitFor({ state: "hidden" });
	assert(await inlineComposer.evaluate((element) => element === document.activeElement));
	await inlineComposer.fill("联系 dev@example.com");
	assert.equal(await completionList.count(), 0);
	await inlineComposer.fill("前文 @src/中文");
	await completionList.getByRole("option", { name: "src/中文 文件.ts", exact: true }).waitFor();
	await inlineComposer.press("Shift+Enter");
	await completionList.waitFor({ state: "hidden" });
	assert.equal(await inlineComposer.inputValue(), "前文 @src/中文\n");
	// 10.5 系统组词与刚结束的候选确认不会选择文件或发送提示词。
	await inlineComposer.fill("前文 @src/中文");
	await completionList.getByRole("option", { name: "src/中文 文件.ts", exact: true }).waitFor();
	await inlineComposer.evaluate((element) => {
		element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		element.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
		);
		element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
		element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	});
	assert.equal(await inlineComposer.inputValue(), "前文 @src/中文");
	assert.equal(requests, beforeCompletionRequests);
	await completionList.getByRole("option", { name: "src/中文 文件.ts", exact: true }).waitFor();
	await delay(60);
	await inlineComposer.press("Enter");
	await page.waitForFunction(() => document.querySelector("textarea")?.value === '前文 @"src/中文 文件.ts" ');
	// 10.6 失效候选不能覆盖原片段，恢复文件后可以重新确认。
	await writeFile(join(project, "src", "inline-transient.ts"), "// inline fixture\n", "utf8");
	await inlineComposer.fill("前文 @inline-transient");
	await completionList.getByRole("option", { name: "src/inline-transient.ts", exact: true }).waitFor();
	await unlink(join(project, "src", "inline-transient.ts"));
	await completionList.getByRole("option", { name: "src/inline-transient.ts", exact: true }).click();
	await page.locator(".file-completion").getByRole("alert").waitFor();
	assert.equal(await inlineComposer.inputValue(), "前文 @inline-transient");
	await writeFile(join(project, "src", "inline-transient.ts"), "// inline fixture\n", "utf8");
	await completionList.getByRole("option", { name: "src/inline-transient.ts", exact: true }).click();
	await page.waitForFunction(() => document.querySelector("textarea")?.value === '前文 @"src/inline-transient.ts" ');
	assert.equal(requests, beforeCompletionRequests);
	// 10.7 离开当前会话后撤下候选，重启只恢复完整草稿，不重发任务。
	await inlineComposer.fill("@src/中文");
	await page.locator(".new-thread").click();
	await page.waitForFunction(
		() => document.querySelector("textarea")?.value === "" && !document.querySelector(".file-completion"),
	);
	inlineComposer = page.locator("textarea");
	await inlineComposer.fill("请检查 @src/中文");
	await completionList.getByRole("option", { name: "src/中文 文件.ts", exact: true }).waitFor();
	await inlineComposer.press("Enter");
	const completedDraft = '请检查 @"src/中文 文件.ts" ';
	await page.waitForFunction((value) => document.querySelector("textarea")?.value === value, completedDraft);
	await page.getByText("草稿已保存", { exact: true }).waitFor();
	const completionSession = await page.evaluate(() => window.piDesktop.getSnapshot());
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	inlineComposer = page.locator("textarea");
	completionList = page.getByRole("listbox", { name: "文件补全候选", exact: true });
	await page.waitForFunction((value) => document.querySelector("textarea")?.value === value, completedDraft, {
		timeout: 60000,
	});
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, completionSession.sessionId);
	assert.equal(requests, beforeCompletionRequests);
	assert.equal(await completionList.count(), 0);
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByText("已读取引用文件，referenceReady 可用。", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	assert.equal(requests, beforeCompletionRequests + 2);
	logger.info("行内文件补全验证完成");
	/*
	 * ========================================================================
	 * 步骤11：验证图片排队、引导与跨重启恢复
	 * ========================================================================
	 * 数据源：真实 SDK、JPEG 输入与写前图片身份，不读取系统剪贴板。
	 * 操作：
	 *   1) 运行中添加两类图片任务，收束后验证实际模型图片请求
	 *   2) 停止并重启后保留附件，恢复草稿不自动发送
	 */
	logger.info("开始验证图片排队与引导");
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	await page.locator("textarea").fill("长任务，验证图片队列");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByRole("button", { name: "加入队列", exact: true }).waitFor();
	const beforeQueuedImages = imageRequests;
	for (const mode of ["加入队列", "引导当前任务"]) {
		await page.locator("textarea").fill(`图片任务，${mode}`);
		await dispatchFileInput(page, "paste", [{ name: "排队.jpeg", mime: "image/jpeg", data: jpeg }]);
		await page.getByLabel("草稿图片附件", { exact: true }).locator("img").waitFor();
		await page.getByRole("button", { name: mode, exact: true }).click();
		await page.waitForFunction(() => !document.querySelector('[aria-label="草稿图片附件"]'));
		await page.locator(".task-queue").getByText(`图片任务，${mode}`, { exact: true }).waitFor();
	}
	assert.equal(await page.locator(".task-queue").getByText("图片 1 张", { exact: true }).count(), 2);
	await page.screenshot({ path: join(artifacts, "17-image-queues.png"), scale: "css", animations: "disabled" });
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor({ timeout: 30000 });
	assert.equal(imageRequests, beforeQueuedImages + 2);
	const queuedMessages = (await page.evaluate(() => window.piDesktop.getSnapshot())).messages.filter(
		(message) => message.role === "user",
	);
	assert.deepEqual(
		queuedMessages.slice(-2).map((message) => message.blocks[0].text),
		["图片任务，引导当前任务", "图片任务，加入队列"],
	);
	assert(queuedMessages.slice(-2).every((message) => message.imageIds.length === 1));
	await page.locator("textarea").fill("长任务，停止保留图片队列");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByRole("button", { name: "加入队列", exact: true }).waitFor();
	await page.locator("textarea").fill("图片任务，待核对附件");
	await dispatchFileInput(page, "drop", [{ name: "恢复.png", mime: "image/png", data: png }]);
	await page.getByLabel("草稿图片附件", { exact: true }).locator("img").waitFor();
	await page.getByRole("button", { name: "加入队列", exact: true }).click();
	await page.locator(".task-queue").getByText("图片任务，待核对附件", { exact: true }).waitFor();
	await page.getByRole("button", { name: "停止任务", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	const beforeQueueRestart = requests;
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.locator(".task-queue").getByText("图片任务，待核对附件", { exact: true }).waitFor({ timeout: 60000 });
	await page.getByRole("button", { name: "恢复到输入", exact: true }).click();
	await page.locator(".task-queue").waitFor({ state: "hidden" });
	await page.getByLabel("草稿图片附件", { exact: true }).locator("img").waitFor();
	assert.equal(await page.locator("textarea").inputValue(), "图片任务，待核对附件");
	assert.equal(requests, beforeQueueRestart);
	await page.screenshot({ path: join(artifacts, "18-image-queue-recovery.png"), scale: "css", animations: "disabled" });
	logger.info("图片排队与引导验证完成");
	/*
	 * ========================================================================
	 * 步骤12：验证扩展可移植 UI 与 OAuth 登录
	 * ========================================================================
	 * 数据源：独立目录中的本地扩展、真实 Provider 注册表与 AuthStorage。
	 * 操作：
	 *   1) 交互跨重载保留，选择、确认、输入、编辑与切换取消均返回 SDK
	 *   2) 浏览器地址只截获不打开，登录取消、重启、退出不泄露凭据
	 */
	logger.info("开始验证扩展交互与 OAuth");
	await page.locator(".new-thread").click();
	await page.getByRole("heading", { name: "从这个项目开始" }).waitFor();
	const beforeInteractionRequests = requests;
	await page.locator("textarea").fill("/gui-dialogs");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByRole("dialog", { name: "扩展选择", exact: true }).waitFor();
	const pendingExtension = (await page.evaluate(() => window.piDesktop.getSnapshot())).dialogs[0];
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.getByRole("dialog", { name: "扩展选择", exact: true }).waitFor();
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).dialogs[0].id, pendingExtension.id);
	await page.getByRole("button", { name: "交互选项", exact: true }).click();
	await page.getByRole("option", { name: "检查中文", exact: true }).click();
	await page
		.getByRole("dialog", { name: "扩展选择", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page
		.getByRole("dialog", { name: "扩展确认", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.getByRole("textbox", { name: "交互输入", exact: true }).fill("中文扩展说明");
	await page
		.getByRole("dialog", { name: "扩展输入", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.getByRole("textbox", { name: "编辑内容", exact: true }).fill("编辑后的中文\n第二行");
	await page.screenshot({ path: join(artifacts, "19-extension-editor.png"), scale: "css", animations: "disabled" });
	await page
		.getByRole("dialog", { name: "扩展编辑", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.getByText("扩展交互已完成", { exact: true }).waitFor();
	await page.getByText("扩展状态已更新", { exact: true }).waitFor();
	await page.getByText("输入框下方小组件", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	assert.equal(requests, beforeInteractionRequests);
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).messages.length, 0);
	const staleReply = await page.evaluate(async (id) => {
		const current = await window.piDesktop.getSnapshot();
		try {
			await window.piDesktop.dispatch({
				requestId: crypto.randomUUID(),
				sessionId: current.sessionId,
				generation: current.generation,
				command: { type: "reply", reply: { id, cancelled: false, value: "0" } },
			});
			return false;
		} catch {
			return true;
		}
	}, pendingExtension.id);
	assert(staleReply);
	await page.locator("textarea").fill("/gui-dialogs");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page
		.getByRole("dialog", { name: "扩展选择", exact: true })
		.getByRole("button", { name: "取消", exact: true })
		.click();
	await page.getByText("扩展选择已取消", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	await page.locator("textarea").fill("/gui-timeout");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByText("扩展请求已超时", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	await page.locator("textarea").fill("/gui-guard");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByText("切换保护已开启", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	const guardedId = (await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId;
	await page.locator(".new-thread").click();
	await page
		.getByRole("dialog", { name: "切换确认", exact: true })
		.getByRole("button", { name: "否", exact: true })
		.click();
	await page.locator(".workspace-error").filter({ hasText: "扩展已取消会话切换" }).waitFor();
	assert.equal((await page.evaluate(() => window.piDesktop.getSnapshot())).sessionId, guardedId);
	await page.locator(".new-thread").click();
	await page
		.getByRole("dialog", { name: "切换确认", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.waitForFunction(async (id) => (await window.piDesktop.getSnapshot()).sessionId !== id, guardedId);
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "OAuth 服务商", exact: true }).click();
	await page.getByRole("option", { name: "离线 OAuth", exact: true }).click();
	await page.getByRole("button", { name: "开始登录", exact: true }).click();
	await page
		.getByRole("dialog", { name: "登录方式", exact: true })
		.getByRole("button", { name: "取消", exact: true })
		.click();
	await page.getByText("登录已取消", { exact: true }).waitFor();
	await page.getByRole("button", { name: "开始登录", exact: true }).click();
	await page.getByRole("button", { name: "交互选项", exact: true }).click();
	await page.getByRole("option", { name: "离线设备码", exact: true }).click();
	await page
		.getByRole("dialog", { name: "登录方式", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.getByRole("dialog", { name: "OAuth 登录", exact: true }).waitFor();
	await electronApp.evaluate(({ shell }) => {
		shell.openExternal = async (url) => {
			globalThis.__offlineLoginUrl = url;
		};
	});
	await page
		.getByRole("dialog", { name: "OAuth 登录", exact: true })
		.getByRole("link", { name: "在浏览器登录", exact: true })
		.click();
	assert.equal(await electronApp.evaluate(() => globalThis.__offlineLoginUrl), "https://example.invalid/authorize");
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await page.getByText("登录已取消", { exact: true }).waitFor();
	await page.getByRole("button", { name: "开始登录", exact: true }).click();
	await page.getByRole("button", { name: "交互选项", exact: true }).click();
	await page.getByRole("option", { name: "离线设备码", exact: true }).click();
	await page
		.getByRole("dialog", { name: "登录方式", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.getByRole("dialog", { name: "OAuth 登录", exact: true }).waitFor();
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.getByRole("dialog", { name: "OAuth 登录", exact: true }).waitFor();
	const currentAuth = await page.evaluate(() => window.piDesktop.getSnapshot());
	assert.equal(currentAuth.authentication.flow.userCode, "TEST-1234");
	assert(!JSON.stringify(currentAuth).includes("offline-private-"));
	await page.getByLabel("交互输入", { exact: true }).fill("offline-code");
	await page
		.getByRole("dialog", { name: "OAuth 登录", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.waitForFunction(
		async () => (await window.piDesktop.getSnapshot()).authentication.flow?.phase === "succeeded",
	);
	const savedOAuth = JSON.parse(await readFile(join(agentDirectory, "auth.json"), "utf8"));
	assert.equal(savedOAuth["gui-offline-oauth"].type, "oauth");
	assert.equal(savedOAuth["gui-offline-oauth"].access, "offline-private-access");
	assert.equal(requests, beforeInteractionRequests);
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	await page.getByRole("button", { name: "设置", exact: true }).waitFor({ timeout: 60000 });
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "OAuth 服务商", exact: true }).click();
	await page.getByRole("option", { name: "离线 OAuth", exact: true }).click();
	await page.getByRole("button", { name: "退出登录", exact: true }).click();
	await page.waitForFunction(
		async () =>
			!(await window.piDesktop.getSnapshot()).authentication.providers.find((item) => item.id === "gui-offline-oauth")
				.authenticated,
	);
	assert(!JSON.parse(await readFile(join(agentDirectory, "auth.json"), "utf8"))["gui-offline-oauth"]);
	await page.screenshot({ path: join(artifacts, "20-oauth-settings.png"), scale: "css", animations: "disabled" });
	assert.equal(requests, beforeInteractionRequests);
	logger.info("扩展交互与 OAuth 验证完成");
	/*
	 * ========================================================================
	 * 步骤13：验证扩展初始化期间的交互与启动原因
	 * ========================================================================
	 * 数据源：同一离线扩展、独立验收标记与真实应用重启。
	 * 操作：
	 *   1) 恢复和新建宿主等待用户输入时仍可收发回复
	 *   2) 启动原因由 SDK 会话事件提供，不通过界面推测
	 */
	logger.info("开始验证扩展启动交互");
	await writeFile(join(agentDirectory, "confirm-startup"), "offline fixture", "utf8");
	await electronApp.close();
	electronApp = undefined;
	launchedApp = await launch();
	electronApp = launchedApp.application;
	page = launchedApp.page;
	// 13.1 先建立传输再等待扩展回调，重启不能卡在宿主 ready 之前。
	await page.getByRole("dialog", { name: "扩展启动确认", exact: true }).waitFor({ timeout: 60000 });
	await page
		.getByRole("dialog", { name: "扩展启动确认", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.getByText("扩展启动已确认：resume", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	// 13.2 待接替宿主的初始化请求也能在完成切换后由快照恢复。
	await page.locator(".new-thread").click();
	await page.getByRole("dialog", { name: "扩展启动确认", exact: true }).waitFor({ timeout: 60000 });
	await page
		.getByRole("dialog", { name: "扩展启动确认", exact: true })
		.getByRole("button", { name: "确定", exact: true })
		.click();
	await page.getByText("扩展启动已确认：new", { exact: true }).waitFor();
	await page.getByRole("status").filter({ hasText: "就绪" }).waitFor();
	assert.equal(requests, beforeInteractionRequests);
	logger.info("扩展启动交互验证完成");
	assert.deepEqual(failures, []);
	logger.info(`Electron 用户路径通过；截图目录：${artifacts}`);
} catch (error) {
	if (electronApp) {
		const page = await electronApp.firstWindow();
		await page.screenshot({ path: join(artifacts, "99-failure.png"), scale: "css" });
		logger.error(await page.locator("body").innerText());
		logger.error({ url: page.url(), rendererErrors: failures });
	}
	throw error;
} finally {
	// 2.5 无论断言结果如何都关闭本脚本拥有的窗口与本地服务。
	await electronApp?.close();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	logger.info("Electron 验收资源已释放");
}
