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
const artifacts = join(root, "output/playwright", `image-preview-${Date.now()}`);
const project = join(artifacts, "中文 项目");
const assets = join(project, "图片 目录");
const agentDirectory = join(artifacts, "agent");
const profile = join(artifacts, "profile");
const renderer = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
const packagedExecutable = process.env.PI_GUI_PACKAGED_EXECUTABLE;
const failures = [];
const checks = [];
let application;
let page;
let modelRequests = 0;

/*
 * ========================================================================
 * 步骤1：准备独立图片项目与桌面窗口
 * ========================================================================
 * 数据源：浏览器编码的测试图片、独立会话目录和本机空模型服务。
 * 操作：1) 不读取用户配置；2) 所有文件与截图留在本次验收目录。
 */
logger.info("开始准备侧栏图片验收");
await Promise.all([assets, agentDirectory, profile].map((path) => mkdir(path, { recursive: true })));
const server = createServer((request, response) => {
	if (request.method === "POST") modelRequests++;
	response.writeHead(404).end();
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert(address && typeof address === "object");
await writeFile(
	join(agentDirectory, "models.json"),
	JSON.stringify({
		providers: {
			"image-offline": {
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				api: "openai-completions",
				apiKey: "offline-fixture",
				models: [
					{
						id: "fixture",
						name: "图片验收",
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
	JSON.stringify({ defaultProvider: "image-offline", defaultModel: "fixture", retry: { enabled: false } }),
);
await writeFile(join(project, "说明.txt"), "文本预览继续可用。\n", "utf8");

try {
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
	application = await _electron.launch({
		executablePath: packagedExecutable ?? electronExecutable,
		args: [...(packagedExecutable ? [] : [join(root, "dist/main/index.cjs")]), `--user-data-dir=${profile}`],
		cwd: packagedExecutable ? dirname(packagedExecutable) : root,
		env: environment,
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
			.find(
				(candidate) =>
					candidate.url().startsWith(packagedExecutable ? "file:" : renderer) &&
					!candidate.url().includes("startup.html"),
			);
		if (!page) await delay(50);
	}
	assert(page, "未找到图片验收工作台");
	page.setDefaultTimeout(20000);
	page.on("pageerror", (error) => failures.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" || (message.type() === "warning" && message.text().startsWith("[Vue warn]")))
			failures.push(message.text().slice(0, 300));
	});
	await page.waitForFunction(() => !!window.piDesktop);
	// 1.1 用浏览器生成真实 PNG、JPEG 和 WebP，确保验收依赖实际解码。
	const encoded = await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		canvas.width = 1600;
		canvas.height = 900;
		const context = canvas.getContext("2d");
		context.fillStyle = "#e4eee9";
		context.fillRect(0, 0, 1600, 900);
		context.fillStyle = "#345e52";
		context.fillRect(100, 100, 700, 700);
		context.fillStyle = "#e49b5d";
		context.beginPath();
		context.arc(1100, 450, 230, 0, Math.PI * 2);
		context.fill();
		return Object.fromEntries(
			["png", "jpeg", "webp"].map((format) => [format, canvas.toDataURL(`image/${format}`).split(",")[1]]),
		);
	});
	await writeFile(join(assets, "图片.PNG"), Buffer.from(encoded.png, "base64"));
	await writeFile(join(assets, "照片.jpeg"), Buffer.from(encoded.jpeg, "base64"));
	await writeFile(join(assets, "照片.jpg"), Buffer.from(encoded.jpeg, "base64"));
	await writeFile(join(assets, "封面.webp"), Buffer.from(encoded.webp, "base64"));
	await writeFile(
		join(assets, "动画.gif"),
		Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
	);
	await writeFile(
		join(assets, "示意.svg"),
		'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#d9e8f2"/><circle cx="800" cy="450" r="300" fill="#36566c"/></svg>',
	);
	await writeFile(join(assets, "损坏.png"), "broken image");
	await writeFile(join(assets, "消失.png"), Buffer.from(encoded.png, "base64"));
	await writeFile(join(assets, "超限.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
	await application.evaluate(({ dialog }, cwd) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
	}, project);
	await page.getByRole("button", { name: "打开项目", exact: true }).last().click();
	await page.waitForFunction(async () => (await window.piDesktop.getSnapshot())?.run.phase === "idle");
	logger.info("侧栏图片验收准备结束");

	/*
	 * ========================================================================
	 * 步骤2：从文件列表打开图片并检查缩放与标签状态
	 * ========================================================================
	 * 数据源：真实文件列表、预览 IPC、图片解码和右侧标签。
	 * 操作：1) 六种扩展名使用图片通道；2) 缩放、切换和窄栏仍可浏览。
	 */
	logger.info("开始验证图片打开与缩放");
	await page.getByRole("button", { name: "展开右侧面板", exact: true }).click();
	await page.locator(".side-tool").filter({ hasText: "工作区文件" }).click();
	await page.locator(".file-row").filter({ hasText: "说明.txt" }).click();
	await page.getByText("文本预览继续可用。", { exact: true }).waitFor();
	await page.getByRole("button", { name: "返回列表", exact: true }).click();
	await page.locator(".file-row").filter({ hasText: "图片 目录" }).click();
	await page.locator(".file-row").filter({ hasText: "图片.PNG" }).click();
	await imageReady("图片.PNG");
	await page.waitForFunction(() => {
		const image = document.querySelector('.side-view:not([style*="display: none"]) img');
		const viewport = image?.parentElement;
		return (
			image &&
			image.getBoundingClientRect().width < image.naturalWidth &&
			image.getBoundingClientRect().width <= viewport.clientWidth - 31 &&
			image.getBoundingClientRect().height <= viewport.clientHeight - 31
		);
	});
	const originalFit = await geometry();
	assert(
		originalFit.width < 1600 &&
			originalFit.width <= originalFit.viewportWidth + 1 &&
			originalFit.height <= originalFit.viewportHeight + 1,
		JSON.stringify(originalFit),
	);
	await page.getByRole("button", { name: "图片原始大小", exact: true }).click();
	assert.equal(Math.round((await geometry()).width), 1600);
	assert((await geometry()).scrollWidth > (await geometry()).viewportWidth);
	await page.getByRole("button", { name: "放大图片", exact: true }).click();
	assert.equal(Math.round((await geometry()).width), 2000);
	await page.getByRole("button", { name: "缩小图片", exact: true }).click();
	assert.equal(Math.round((await geometry()).width), 1600);
	await filesTab();
	await page.locator(".file-row").filter({ hasText: "图片.PNG" }).click();
	assert.equal(await page.getByRole("tab", { name: "图片.PNG", exact: false }).count(), 1);
	assert.equal(Math.round((await geometry()).width), 1600);
	await page.getByRole("button", { name: "适应窗口", exact: true }).click();
	await page.getByRole("button", { name: "放大面板", exact: true }).click();
	await page.waitForFunction(
		(width) =>
			document.querySelector('.side-view:not([style*="display: none"]) img')?.getBoundingClientRect().width > width,
		originalFit.width,
	);
	await page.getByRole("button", { name: "还原面板宽度", exact: true }).click();
	await page.screenshot({ path: join(artifacts, "image-fit.png"), fullPage: true });
	checks.push(
		"workspace-text-preserved",
		"png-via-file-list",
		"fit-original-and-zoom",
		"deduplicated-tab-preserves-zoom",
		"fit-follows-panel-width",
	);
	for (const name of ["照片.jpeg", "照片.jpg", "封面.webp", "动画.gif", "示意.svg"]) {
		await filesTab();
		await page.locator(".file-row").filter({ hasText: name }).click();
		await imageReady(name);
	}
	checks.push("jpeg-webp-gif-svg-decoded");
	await application.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()
			.find((window) => window.getTitle().includes("编程工作区"))
			.setSize(1100, 720);
	});
	await page.getByRole("separator", { name: "调整右侧面板宽度" }).focus();
	await page.keyboard.press("Home");
	await page.getByRole("button", { name: "适应窗口", exact: true }).click();
	await page.waitForFunction(() => {
		const view = document.querySelector('.side-view:not([style*="display: none"])');
		const image = view.querySelector("img");
		return image && image.getBoundingClientRect().width <= view.clientWidth;
	});
	await page.screenshot({ path: join(artifacts, "image-narrow.png"), fullPage: true });
	const narrow = await page
		.locator(".side-panel")
		.evaluate((panel) => ({ width: panel.clientWidth, scrollWidth: panel.scrollWidth }));
	assert(narrow.scrollWidth <= narrow.width + 1);
	const lightImage = await visible().getByRole("img").screenshot({ animations: "disabled" });
	await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
	const darkImage = await visible().getByRole("img").screenshot({ animations: "disabled" });
	const colors = await application.evaluate(
		({ nativeImage }, encoded) => {
			const center = (data) => {
				const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
				const { width, height } = image.getSize();
				const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
				return [...image.toBitmap().subarray(offset, offset + 4)];
			};
			return { light: center(encoded.light), dark: center(encoded.dark) };
		},
		{ light: lightImage.toString("base64"), dark: darkImage.toString("base64") },
	);
	assert.deepEqual(colors.light, [108, 86, 54, 255], JSON.stringify(colors));
	assert.deepEqual(colors.dark, colors.light, "主题切换不能改变图片中心像素");
	await page.screenshot({ path: join(artifacts, "image-dark.png"), fullPage: true });
	await page.getByRole("button", { name: "切换浅色主题", exact: true }).click();
	checks.push("narrow-panel-fits-image-and-controls", "theme-preserves-image-colors");
	logger.info("图片打开与缩放验证结束");

	/*
	 * ========================================================================
	 * 步骤3：验证图片错误、重试与文件边界
	 * ========================================================================
	 * 数据源：损坏图片、删除后恢复的文件和受限项目路径。
	 * 操作：1) 失败后能重试；2) 超限和项目外路径不能越过预览边界。
	 */
	logger.info("开始验证图片错误与重试");
	await filesTab();
	await page.locator(".file-row").filter({ hasText: "损坏.png" }).click();
	await page.getByRole("alert").filter({ hasText: "图片无法打开" }).waitFor();
	await writeFile(join(assets, "损坏.png"), Buffer.from(encoded.png, "base64"));
	await page.getByRole("button", { name: "重新加载", exact: true }).click();
	await imageReady("损坏.png");
	await filesTab();
	await unlink(join(assets, "消失.png"));
	await page.locator(".file-row").filter({ hasText: "消失.png" }).click();
	await visible().getByRole("alert").waitFor();
	await writeFile(join(assets, "消失.png"), Buffer.from(encoded.png, "base64"));
	await page.getByRole("button", { name: "重新加载", exact: true }).click();
	await imageReady("消失.png");
	await filesTab();
	await page.locator(".file-row").filter({ hasText: "超限.png" }).click();
	await visible().getByText("图片超过 8 MiB，暂不支持预览。", { exact: true }).waitFor();
	await assert.rejects(
		page.evaluate(async () => {
			const current = await window.piDesktop.getSnapshot();
			await window.piDesktop.previewProjectFile({ cwd: current.cwd, path: "../outside.png" });
		}),
	);
	assert.equal(modelRequests, 0);
	assert.deepEqual(failures, []);
	checks.push(
		"corrupt-image-retry",
		"missing-image-retry",
		"bounded-image-size",
		"project-path-boundary",
		"no-model-request",
	);
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, checks, failures, modelRequests }, null, 2),
	);
	logger.info(JSON.stringify({ passed: true, checks, artifacts }));
	logger.info("图片错误与重试验证结束");
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
	logger.info("侧栏图片验收结束");
}

function visible() {
	return page.locator('.side-view:not([style*="display: none"])');
}
async function filesTab() {
	await page.getByRole("tab", { name: "文件", exact: false }).click();
}
async function imageReady(name) {
	await visible().getByRole("img", { name, exact: true }).waitFor();
	await page.waitForFunction((name) => {
		const image = document.querySelector('.side-view:not([style*="display: none"]) img');
		return image?.alt === name && image.complete && image.naturalWidth > 0;
	}, name);
	await page.getByRole("button", { name: "图片原始大小", exact: true }).waitFor();
}
async function geometry() {
	return visible()
		.getByRole("img")
		.evaluate((image) => ({
			width: image.getBoundingClientRect().width,
			height: image.getBoundingClientRect().height,
			viewportWidth: image.parentElement.clientWidth - 32,
			viewportHeight: image.parentElement.clientHeight - 32,
			scrollWidth: image.parentElement.scrollWidth,
		}));
}
