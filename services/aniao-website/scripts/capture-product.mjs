import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `product-${Date.now()}`);
const project = join(artifacts, "灵感工作室");
const agentDirectory = join(artifacts, "agent");
const profile = join(artifacts, "profile");
const executablePath = resolve(
	root,
	"../../packages/gui/artifacts/dual-x64-20261028/windows/win-unpacked/Aniao Harness.exe",
);
let application;

/*
 * ========================================================================
 * 步骤1：从真实桌面程序捕获官网界面示例
 * ========================================================================
 * 数据源：已验收安装包、独立工作区与本机确定性模型响应。
 * 操作：1) 不读取用户会话；2) 截图展示真实文件与工具工作区。
 */
logger.info("开始准备官网产品截图");
await Promise.all([project, agentDirectory, profile].map((path) => mkdir(path, { recursive: true })));
const server = createServer(async (request, response) => {
	if (!request.url?.endsWith("/chat/completions")) {
		response.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of request) body += chunk;
	const input = JSON.parse(body);
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const send = (delta, finish_reason = null) =>
		response.write(
			`data: ${JSON.stringify({ id: "website-demo", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	if (input.messages.some((message) => message.role === "tool")) {
		send({
			role: "assistant",
			content:
				"已经整理好了。\n\n### 把想法，变成下一步\n\n- **先定方向**：一个轻盈的个人作品集，用留白和图片讲清你的创作。\n- **再搭页面**：首页、作品详情和关于我，各自保留清楚的入口。\n- **边看边改**：页面和文件都留在工作区，继续对话就能完善。\n\n设计说明已保存。你可以先看看，再一起做出第一版。",
		});
		send({}, "stop");
	} else {
		send({
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: "write-design",
					type: "function",
					function: {
						name: "write",
						arguments: JSON.stringify({
							path: "设计说明.md",
							content:
								"# 灵感工作室\n\n## 页面方向\n\n用清晰的留白、作品图片和简短文字介绍创作。\n\n## 内容结构\n\n1. 首页：个人介绍与精选作品\n2. 作品：图像、过程与完成结果\n3. 关于：创作背景与联系入口\n\n## 下一步\n\n- 确定精选作品\n- 搭建响应式页面\n- 核对桌面与手机展示\n",
						}),
					},
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
			"aniao-preview": {
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-completions",
				apiKey: "offline-fixture",
				models: [
					{
						id: "studio",
						name: "Aniao Studio",
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
	JSON.stringify({ defaultProvider: "aniao-preview", defaultModel: "studio", retry: { enabled: false } }),
);
try {
	const environment = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDirectory,
		ANIAO_DEFAULT_PROVIDER_FILE: join(artifacts, "no-defaults.json"),
		ANIAO_UPDATE_URL: `http://127.0.0.1:${address.port}/updates/`,
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "PI_PACKAGE_DIR", "NODE_OPTIONS", "NODE_PATH"])
		delete environment[key];
	application = await _electron.launch({
		executablePath,
		args: [`--user-data-dir=${profile}`],
		cwd: dirname(executablePath),
		env: environment,
		timeout: 60000,
	});
	const log = createWriteStream(join(artifacts, "electron.log"));
	application.process().stdout.pipe(log, { end: false });
	application.process().stderr.pipe(log, { end: false });
	application.process().once("exit", () => log.end());
	let page;
	const deadline = Date.now() + 60000;
	while (!page && Date.now() < deadline) {
		page = application
			.windows()
			.find((candidate) => candidate.url().startsWith("file:") && !candidate.url().includes("startup.html"));
		if (!page) await delay(50);
	}
	assert(page);
	await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).waitFor();
	await application.evaluate(({ dialog, BrowserWindow }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
		BrowserWindow.getAllWindows()
			.find((window) => window.getTitle().includes("编程工作区"))
			.setSize(1440, 950);
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	while (!(await page.evaluate(() => window.piDesktop.getSnapshot()))) await delay(50);
	await page.locator("textarea").fill("想做一个个人作品集，帮我整理一下方向。");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.getByText("设计说明已保存。你可以先看看，再一起做出第一版。", { exact: true }).waitFor();
	await page.evaluate(async () => {
		const value = await window.piDesktop.getSnapshot();
		await window.piDesktop.updateSession({ sessionId: value.sessionId, title: "从灵感，到作品" });
	});
	await page.getByRole("heading", { name: "从灵感，到作品", exact: true }).waitFor();
	await page.locator("textarea").fill("接下来，开始做第一版吧。");
	await page.screenshot({ path: join(artifacts, "workspace.png"), fullPage: true });
	await writeFile(join(root, "public/assets/workspace-source.png"), await page.screenshot());
	logger.info(JSON.stringify({ captured: true, path: join(root, "public/assets/workspace-source.png") }));
} finally {
	await application?.close().catch(() => {});
	await new Promise((finish) => {
		server.close(finish);
		server.closeAllConnections();
	});
	logger.info("官网产品截图准备结束");
}
