import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "output/playwright", `viewed-images-${Date.now()}`);
const project = join(artifacts, "中文 项目");
const assets = join(artifacts, "项目外 图片");
const agentDirectory = join(artifacts, "agent");
const profile = join(artifacts, "profile");
const renderer = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
const packagedExecutable = process.env.PI_GUI_PACKAGED_EXECUTABLE;
const failures = [];
const checks = [];
const requests = [];
let application;
let page;
let imageReads = 0;
let release = () => {};
const gate = new Promise((resolve) => {
	release = resolve;
});

/*
 * ========================================================================
 * 步骤1：准备真实图片与离线多工具响应
 * ========================================================================
 * 数据源：独立项目、项目外测试图片和本机 SSE 模型替身。
 * 操作：1) SDK 真正读取图片；2) 用户原有窗口、配置和会话保持独立。
 */
logger.info("开始准备图片查看步骤验收");
await Promise.all([project, assets, agentDirectory, profile].map((path) => mkdir(path, { recursive: true })));
await writeFile(join(project, "说明.txt"), "普通文件内容", "utf8");
const server = createServer(async (request, response) => {
	if (!request.url?.endsWith("/chat/completions")) {
		response.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of request) body += chunk;
	const input = JSON.parse(body);
	const userIndex = input.messages.findLastIndex(
		(message) => message.role === "user" && /查看(?:两|五)张图片/u.test(JSON.stringify(message.content)),
	);
	const five = JSON.stringify(input.messages[userIndex]?.content).includes("五张");
	const result = input.messages.slice(userIndex + 1).some((message) => message.role === "tool");
	requests.push({ five, result });
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const send = (delta, finish_reason = null) =>
		response.write(
			`data: ${JSON.stringify({ id: "viewed-images", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	if (!result) {
		const files = five
			? Array.from({ length: 5 }, (_item, index) => join(assets, `截图${index}.png`))
			: [join(assets, "截图0.png"), join(assets, "相机.jpeg"), "说明.txt", "missing.png"];
		send({
			role: "assistant",
			tool_calls: files.map((path, index) => ({
				index,
				id: `read-${five}-${index}`,
				type: "function",
				function: { name: "read", arguments: JSON.stringify({ path }) },
			})),
		});
		send({}, "tool_calls");
	} else {
		send({ role: "assistant", content: "正在核对图片。" });
		if (!five) await gate;
		send({ content: "图片查看完成。" });
		send({}, "stop");
	}
	response.end("data: [DONE]\n\n");
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert(address && typeof address === "object");
const environment = {
	...process.env,
	PI_CODING_AGENT_DIR: agentDirectory,
	ELECTRON_RENDERER_URL: renderer,
	ANIAO_DEFAULT_PROVIDER_FILE: join(artifacts, "no-provider.json"),
	ANIAO_UPDATE_URL: `http://127.0.0.1:${address.port}/updates/`,
};
delete environment.ELECTRON_RUN_AS_NODE;
if (packagedExecutable) {
	for (const key of ["ELECTRON_RENDERER_URL", "PI_PACKAGE_DIR", "NODE_PATH", "NODE_OPTIONS"]) delete environment[key];
}
await writeFile(
	join(agentDirectory, "models.json"),
	JSON.stringify({
		providers: {
			"view-offline": {
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-completions",
				apiKey: "offline-fixture",
				models: [
					{
						id: "fixture",
						name: "离线查看图片",
						reasoning: false,
						input: ["text", "image"],
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
		defaultProvider: "view-offline",
		defaultModel: "fixture",
		retry: { enabled: false },
		compaction: { enabled: false },
	}),
);

try {
	await launch();
	// 1.1 用真实编码图片验证 PNG 与 JPEG 两条读取通道。
	const encoded = await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		canvas.width = 240;
		canvas.height = 160;
		const context = canvas.getContext("2d");
		const png = ["#dde9e2", "#dbe7ee", "#f2e3d4", "#e9dfee", "#eeeacb"].map((color, index) => {
			context.fillStyle = color;
			context.fillRect(0, 0, 240, 160);
			context.fillStyle = "#435c50";
			context.fillRect(20 + index * 20, 30, 100, 100);
			return canvas.toDataURL("image/png").split(",")[1];
		});
		return { png, jpeg: canvas.toDataURL("image/jpeg").split(",")[1] };
	});
	await Promise.all(
		encoded.png.map((data, index) => writeFile(join(assets, `截图${index}.png`), Buffer.from(data, "base64"))),
	);
	await writeFile(join(assets, "相机.jpeg"), Buffer.from(encoded.jpeg, "base64"));
	await application.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	await page.waitForFunction(async () => (await window.piDesktop.getSnapshot())?.run.phase === "idle");
	logger.info("图片查看步骤验收准备结束");

	/*
	 * ========================================================================
	 * 步骤2：核对折叠文案与单行缩略图
	 * ========================================================================
	 * 数据源：实际 read 工具事件、原生图片端口与渲染后的步骤。
	 * 操作：1) 成功图片合并，普通和失败读取仍可见；2) 展开后按需读取图片。
	 */
	logger.info("开始验证图片步骤折叠与展开");
	await page.locator("textarea").fill("查看两张图片");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	const trigger = page.getByRole("button", { name: "已查看 2 张图片", exact: true });
	await trigger.waitFor();
	assert.equal(await page.locator(".viewed-images-thumbnails").count(), 0);
	assert.equal(imageReads, 0);
	assert.equal(await page.locator(".tool-activities").count(), 2);
	assert.match(await page.locator(".tool-activities").first().innerText(), /查阅.*说明\.txt/su);
	assert.match(await page.locator(".tool-activities").last().innerText(), /失败/u);
	await trigger.screenshot({ path: join(artifacts, "collapsed.png") });
	await trigger.click();
	await thumbnails(2);
	assert.equal(imageReads, 2);
	const urls = await page
		.locator(".viewed-images-thumbnails img")
		.evaluateAll((images) => images.map((image) => image.src.split(";")[0]));
	assert.deepEqual(urls, ["data:image/png", "data:image/jpeg"]);
	const row = await page
		.locator(".viewed-images-thumbnails img")
		.evaluateAll((images) => images.map((image) => image.getBoundingClientRect().top));
	assert.equal(new Set(row).size, 1);
	await page.locator(".viewed-images").screenshot({ path: join(artifacts, "expanded.png") });
	await page.getByRole("button", { name: "查看图片附件", exact: true }).first().click();
	await page.getByRole("dialog", { name: "图片附件", exact: true }).waitFor();
	await page.keyboard.press("Escape");
	await trigger.click();
	assert.equal(await page.locator(".viewed-images-thumbnails").count(), 0);
	// 2.1 原图删除后，工具结果缓存仍能显示，展开不会重新调用模型或读取原文件。
	await unlink(join(assets, "相机.jpeg"));
	await trigger.click();
	await thumbnails(2);
	assert.equal(requests.length, 2);
	checks.push(
		"image-read-label",
		"consecutive-images-grouped",
		"collapsed-loads-no-thumbnail",
		"expanded-single-thumbnail-row",
		"png-and-jpeg-decoded",
		"text-and-failed-reads-preserved",
		"thumbnail-enlargement",
		"cached-after-original-deletion",
	);
	release();
	await page.waitForFunction(async () => (await window.piDesktop.getSnapshot())?.run.phase === "idle");
	await page.waitForFunction(() => !document.querySelector(".conversation-scroll.running"));
	await page.locator(".turn-header").first().click();
	await trigger.click();
	await thumbnails(2);
	logger.info("图片步骤折叠与展开验证结束");

	/*
	 * ========================================================================
	 * 步骤3：验证多张图片和重启恢复
	 * ========================================================================
	 * 数据源：五张不同图片、原生 JSONL 和同一独立应用目录。
	 * 操作：1) 数量不受草稿四张限制；2) 重启后不调用模型即可恢复缩略图。
	 */
	logger.info("开始验证多图片与重启恢复");
	await page.locator("textarea").fill("查看五张图片");
	await page.getByRole("button", { name: "发送任务", exact: true }).click();
	await page.waitForFunction(
		async () =>
			(await window.piDesktop.getSnapshot())?.messages.filter((message) => message.role === "user").length === 2 &&
			(await window.piDesktop.getSnapshot())?.run.phase === "idle",
	);
	await page.waitForFunction(
		() =>
			document.querySelectorAll(".turn-header").length === 2 && !document.querySelector(".conversation-scroll.running"),
	);
	await page.locator(".turn-header").last().click();
	await page.getByRole("button", { name: "已查看 5 张图片", exact: true }).click();
	await thumbnails(5);
	await application.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()
			.find((window) => window.getTitle().includes("编程工作区"))
			.setSize(1100, 720);
	});
	const fiveRow = page.locator(".viewed-images-thumbnails").last();
	const positions = await fiveRow
		.locator("img")
		.evaluateAll((images) => images.map((image) => image.getBoundingClientRect().top));
	assert.equal(new Set(positions).size, 1);
	await fiveRow.screenshot({ path: join(artifacts, "five-images.png") });
	await application.close();
	await launch();
	await page.waitForFunction(
		async () =>
			(await window.piDesktop.getSnapshot())?.messages.filter((message) => message.role === "user").length === 2,
	);
	await page.locator(".turn-header").first().click();
	await page.getByRole("button", { name: "已查看 2 张图片", exact: true }).click();
	await thumbnails(2);
	assert.equal(requests.length, 4);
	assert.deepEqual(failures, []);
	checks.push("five-images-one-row", "narrow-layout", "history-restores-tool-images", "restart-does-not-request-model");
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, checks, failures, requests }, null, 2),
	);
	logger.info(JSON.stringify({ passed: true, checks, artifacts }));
	logger.info("多图片与重启恢复验证结束");
} catch (error) {
	await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: false, error: String(error), checks, failures, requests }, null, 2),
	);
	throw error;
} finally {
	release();
	await application?.close().catch(() => {});
	await new Promise((finish) => {
		server.close(finish);
		server.closeAllConnections();
	});
	logger.info("图片查看步骤验收结束");
}

async function launch() {
	logger.info("开始启动图片步骤验收窗口");
	try {
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
		assert(page, "未找到图片步骤验收工作台");
		page.setDefaultTimeout(20000);
		page.on("pageerror", (error) => failures.push(error.message));
		page.on("console", (message) => {
			if (message.text() === "[image-preview] 开始读取图片缩略图") imageReads++;
			if (message.type() === "error" || (message.type() === "warning" && message.text().startsWith("[Vue warn]")))
				failures.push(message.text().slice(0, 300));
		});
		await page.waitForFunction(() => !!window.piDesktop);
	} finally {
		logger.info("图片步骤验收窗口启动结束");
	}
}
async function thumbnails(count) {
	await page.waitForFunction((count) => {
		const images = [...document.querySelectorAll(".viewed-images-thumbnails img")];
		return images.length === count && images.every((image) => image.complete && image.naturalWidth > 0);
	}, count);
}
