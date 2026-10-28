import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import electronExecutable from "electron";
import { _electron } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(root, "artifacts", `settings-data-${Date.now()}`);
const agent = join(artifacts, "agent");
const profile = join(artifacts, "profile");
const projects = [join(artifacts, "project"), join(artifacts, "ZCodeProject")];
const renderer = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
const fixtures = [];
const checks = [];
const failures = [];
let application;
let page;
await Promise.all([agent, profile, ...projects].map((path) => mkdir(path, { recursive: true })));
await writeFile(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			offline: {
				baseUrl: "http://127.0.0.1:65534/v1",
				api: "openai-completions",
				apiKey: "offline-fixture",
				models: [{ id: "fixture" }],
			},
		},
	}),
);
await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "offline", defaultModel: "fixture" }));

/*
 * ========================================================================
 * 步骤1：生成独立 SDK 历史和精确可核对的用量
 * ========================================================================
 * 数据源：临时本机会话，不调用模型，不访问用户历史或系统回收站。
 * 操作：1) 模型、日期与 Token 已知；2) 旧会话、置顶和近期会话分别覆盖。
 */
logger.info("开始准备设置数据验收");
const originalDirectory = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;
const referenceNow = Date.now();
try {
	for (const [projectIndex, cwd] of projects.entries()) {
		for (let index = 0; index < (projectIndex === 0 ? 5 : 3); index++) {
			const title =
				["查看 AI 助手全流程", "看看我的项目", "Fork of 看看我的项目", "归档保留测试", "当前会话"][index] ??
				`其他会话 ${index}`;
			const manager = SessionManager.create(cwd);
			const model = ["GLM-5.3", "deepseek-v4-pro", "grok-4.7"][index % 3];
			const total = index === 0 && projectIndex === 0 ? 14958000 : 21000;
			const timestamp = referenceNow - (index === 0 ? 3 : index === 1 ? 2 : 1) * 86400000;
			manager.appendMessage({ role: "user", content: "独立统计验收", timestamp });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "已完成" }],
				provider: "fixture",
				model,
				api: "openai-completions",
				usage: {
					input: total - 200,
					output: 200,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: total,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: timestamp + 24 * 60000,
			});
			manager.appendSessionInfo(title);
			const path = manager.getSessionFile();
			const entries = (await readFile(path, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			for (const entry of entries)
				if (entry.type === "message") entry.timestamp = new Date(entry.message.timestamp).toISOString();
			await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			const modified =
				index === (projectIndex === 0 ? 4 : 2) ? referenceNow : referenceNow - 20 * 86400000 - index * 3600000;
			await utimes(path, new Date(modified), new Date(modified));
			fixtures.push({ id: manager.getSessionId(), cwd, title, path, tokens: total, index, projectIndex });
		}
	}
} finally {
	if (originalDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalDirectory;
}

async function poll(read, message) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (await read()) return;
		await delay(50);
	}
	throw new Error(message);
}
const trashServer = createServer(async (request, response) => {
	let body = "";
	for await (const chunk of request) body += chunk;
	const path = JSON.parse(body).path;
	if (!fixtures.some((item) => resolve(item.path) === resolve(path))) {
		response.writeHead(400).end();
		return;
	}
	await rename(path, `${path}.test-trash`);
	response.writeHead(200).end("ok");
});
await new Promise((ready) => trashServer.listen(0, "127.0.0.1", ready));
const trashUrl = `http://127.0.0.1:${trashServer.address().port}`;
async function launch() {
	const environment = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		ANIAO_DEFAULT_PROVIDER_FILE: join(artifacts, "absent.json"),
		ANIAO_UPDATE_URL: "http://127.0.0.1:65534/updates/",
		ELECTRON_RENDERER_URL: renderer,
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "PI_PACKAGE_DIR"]) delete environment[key];
	application = await _electron.launch({
		executablePath: electronExecutable,
		args: [join(root, "dist/main/index.cjs"), `--user-data-dir=${profile}`],
		env: environment,
		cwd: root,
		timeout: 60000,
	});
	const log = createWriteStream(join(artifacts, `electron-${Date.now()}.log`));
	application.process().stdout.pipe(log, { end: false });
	application.process().stderr.pipe(log, { end: false });
	application.process().once("exit", () => log.end());
	await poll(async () => {
		page = application
			.windows()
			.find((candidate) => candidate.url().startsWith(renderer) && !candidate.url().includes("startup.html"));
		return Boolean(page);
	}, "工作台未就绪");
	page.on("pageerror", (error) => failures.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" || message.text().startsWith("[Vue warn]"))
			failures.push(message.text().slice(0, 400));
	});
	await page.emulateMedia({ reducedMotion: "reduce" });
	await application.evaluate(({ BrowserWindow, shell, net }, url) => {
		BrowserWindow.getAllWindows()
			.find((window) => !window.webContents.getURL().includes("startup.html"))
			.setSize(1720, 1100);
		// 1.1 删除仅改名独立测试文件，系统回收站及用户文件不受影响。
		shell.trashItem = async (path) => {
			const response = await net.fetch(url, { method: "POST", body: JSON.stringify({ path }) });
			if (!response.ok) throw new Error("测试文件拒绝删除");
		};
	}, trashUrl);
}

async function captureData(selector, name) {
	await application.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()
			.find((window) => !window.webContents.getURL().includes("startup.html"))
			.setSize(1720, 2000),
	);
	await page.waitForFunction(() => innerHeight > 1800);
	await page.locator(".settings-content").evaluate((element) => {
		element.scrollTop = 0;
	});
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	await page.locator(selector).screenshot({ path: join(artifacts, name), scale: "css" });
}

async function captureHover(name) {
	const bytes = await application.evaluate(async ({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find(
			(candidate) => !candidate.webContents.getURL().includes("startup.html"),
		);
		return (await window.webContents.capturePage()).toPNG();
	});
	await writeFile(join(artifacts, name), bytes);
}

/*
 * ========================================================================
 * 步骤3：用真实鼠标核对热力图浮层和趋势图提示
 * ========================================================================
 * 数据源：原生 SDK 的已知日期、模型和用户提问轮数。
 * 操作：1) 测量首次悬停延迟；2) 观察实际 Canvas 文字，禁止零消耗模型进入提示。
 */
async function verifyUsageHover(statistics) {
	logger.info("开始验证用量鼠标浮层");
	const day = statistics.dailyTurns.find((item) => item.turns === 2);
	assert(day, "缺少可核对消息轮数的日期");
	const cell = page.locator(`.heatmap-cell[data-date='${day.date}']`);
	assert.equal(await cell.getAttribute("title"), null);
	await cell.evaluate((element) => {
		window.usageHoverDelay = null;
		let started;
		element.addEventListener(
			"pointerenter",
			() => {
				started = performance.now();
			},
			{ once: true },
		);
		const observer = new MutationObserver(() => {
			if (started === undefined) return;
			const tooltip = document.querySelector(".heatmap-tooltip");
			if (!tooltip?.getBoundingClientRect().width) return;
			window.usageHoverDelay = performance.now() - started;
			observer.disconnect();
		});
		observer.observe(document.body, { subtree: true, childList: true, attributes: true });
	});
	await cell.hover();
	const tooltip = page.locator(".heatmap-tooltip");
	await tooltip.waitFor({ state: "visible", timeout: 1000 });
	assert.match(await tooltip.innerText(), /2 轮消息/);
	assert.match(
		await tooltip.innerText(),
		new RegExp(`${Number(day.date.slice(5, 7))}月${Number(day.date.slice(8))}日`),
	);
	await page.waitForFunction(() => window.usageHoverDelay !== null);
	const delayMs = await page.evaluate(() => window.usageHoverDelay);
	assert(delayMs < 250, `热力图浮层显示过慢：${delayMs}ms`);
	assert.equal(await tooltip.evaluate((element) => getComputedStyle(element).animationName), "none");
	assert(
		await tooltip.evaluate((element) => {
			const outer = element.getBoundingClientRect();
			const copy = element.querySelector(".heatmap-tooltip-copy").getBoundingClientRect();
			return copy.top >= outer.top && copy.bottom <= outer.bottom && outer.height >= copy.height + 16;
		}),
		"两行提示文字超出浮层边框",
	);
	await captureHover("heatmap-tooltip-light.png");
	await page.mouse.move(0, 0);
	await tooltip.waitFor({ state: "hidden" });
	await cell.focus();
	await tooltip.waitFor({ state: "visible" });
	await page.keyboard.press("Escape");
	await tooltip.waitFor({ state: "hidden" });
	await page.locator(".trend-canvas canvas").scrollIntoViewIfNeeded();
	await page.evaluate(() => {
		window.usageCanvasLabels = [];
		window.usageOriginalFillText = CanvasRenderingContext2D.prototype.fillText;
		CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
			if (this.canvas.closest(".trend-canvas")) window.usageCanvasLabels.push(String(text));
			return window.usageOriginalFillText.call(this, text, ...args);
		};
	});
	try {
		const box = await page.locator(".trend-canvas canvas").boundingBox();
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await poll(
			async () => (await page.evaluate(() => window.usageCanvasLabels)).some((text) => text.startsWith("GLM-5.3:")),
			"趋势图没有显示有消耗模型",
		);
		const labels = await page.evaluate(() => window.usageCanvasLabels);
		assert(
			!labels.some((text) => text.startsWith("deepseek-v4-pro:") || text.startsWith("grok-4.7:")),
			"趋势图提示包含零消耗模型",
		);
		await captureHover("trend-tooltip-nonzero.png");
		await page.mouse.move(0, 0);
		await page.evaluate(() => {
			window.usageCanvasLabels = [];
		});
		await page.mouse.move(box.x + 30, box.y + box.height / 2);
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		assert(
			!(await page.evaluate(() => window.usageCanvasLabels)).some((text) => text.includes(" tokens")),
			"零用量日期仍显示模型提示",
		);
		await writeFile(
			join(artifacts, "hover-results.json"),
			JSON.stringify(
				{
					passed: true,
					delayMs,
					date: day.date,
					turns: day.turns,
					tooltipLabels: labels.filter((text) => text.includes(" tokens")),
				},
				null,
				2,
			),
		);
	} finally {
		await page.evaluate(() => {
			CanvasRenderingContext2D.prototype.fillText = window.usageOriginalFillText;
		});
		await page.mouse.move(0, 0);
	}
	checks.push("heatmap-tooltip-immediate-date-and-real-turns", "trend-tooltip-skips-zero-token-models");
	logger.info("用量鼠标浮层验证结束");
}

try {
	await launch();
	await page.getByRole("heading", { name: "打开项目，开始工作", exact: true }).waitFor();
	for (const cwd of projects) {
		await application.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, cwd);
		await page.getByRole("button", { name: "打开项目", exact: true }).first().click();
		await poll(
			async () =>
				(await page.evaluate(() => window.piDesktop.getSnapshot()))?.cwd.replaceAll("\\", "/") ===
				cwd.replaceAll("\\", "/"),
			"项目未打开",
		);
	}
	await poll(
		async () => (await page.evaluate(() => window.piDesktop.getSnapshot())).run.phase === "idle",
		"宿主未空闲",
	);
	for (const fixture of fixtures.filter(
		(item) => (item.projectIndex === 0 && item.index < 3) || (item.projectIndex === 1 && item.index === 0),
	))
		await page.evaluate((id) => window.piDesktop.updateSession({ sessionId: id, archived: true }), fixture.id);
	const pinned = fixtures.find((item) => item.projectIndex === 0 && item.index === 3);
	await page.evaluate((id) => window.piDesktop.updateSession({ sessionId: id, pinned: true }), pinned.id);
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "使用统计", exact: true }).click();
	await page.locator(".usage-metrics").waitFor();
	const statistics = await page.evaluate(() => window.piDesktop.getUsageStatistics());
	assert.equal(
		statistics.totalTokens,
		fixtures.reduce((sum, fixture) => sum + fixture.tokens, 0),
	);
	assert.equal(statistics.peakTokens, 14958000);
	assert.equal(statistics.longestChatMs, 24 * 60000);
	assert(await page.getByText("24 分钟", { exact: true }).isVisible());
	assert.equal(await page.locator(".usage-statistics canvas").count(), 2);
	await captureData(".usage-statistics", "usage-light.png");
	await verifyUsageHover(statistics);
	for (const label of ["每周", "累计", "每日"]) {
		await page.getByRole("button", { name: label, exact: true }).click();
		assert.equal(await page.getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed"), "true");
	}
	await page.getByRole("button", { name: "近 30 日", exact: true }).click();
	assert.equal(await page.getByRole("button", { name: "近 30 日", exact: true }).getAttribute("aria-pressed"), "true");
	await page.getByRole("button", { name: "刷新", exact: true }).click();
	await poll(
		async () => (await page.locator(".usage-statistics").getAttribute("aria-busy")) === "false",
		"统计刷新未结束",
	);
	checks.push("real-sdk-token-total-models-and-duration", "heatmap-modes-range-and-refresh");

	/*
	 * ========================================================================
	 * 步骤2：验证归档搜索、恢复、确认删除与策略持久化
	 * ========================================================================
	 * 数据源：真实菜单、IPC、独立索引和 SDK 文件。
	 * 操作：1) 查询与取消确认不写历史；2) 确认后只移除所选归档身份。
	 */
	logger.info("开始验证归档管理流程");
	await page.getByRole("button", { name: "归档管理", exact: true }).click();
	await page.locator(".archive-policy-card").waitFor();
	await captureData(".archive-management", "archives-collapsed.png");
	await page.getByRole("button", { name: "展开归档项目：project", exact: true }).click();
	await captureData(".archive-management", "archives-expanded.png");
	await page.getByRole("searchbox", { name: "搜索已归档会话", exact: true }).fill("Fork");
	assert.equal(await page.locator(".archived-session").count(), 1);
	await page.getByRole("searchbox", { name: "搜索已归档会话", exact: true }).fill("");
	await page.getByLabel("归档排序方式", { exact: true }).selectOption("title");
	await page.getByLabel("归档项目筛选", { exact: true }).selectOption(projects[0].replaceAll("/", "\\"));
	assert.equal(await page.locator(".archive-project").count(), 1);
	await page.getByLabel("归档项目筛选", { exact: true }).selectOption("");
	const restore = fixtures.find((item) => item.projectIndex === 0 && item.index === 2);
	await page.getByRole("button", { name: `取消归档：${restore.title}`, exact: true }).click();
	await page.getByRole("button", { name: `取消归档：${restore.title}`, exact: true }).waitFor({ state: "hidden" });
	const before = (await page.evaluate(() => window.piDesktop.getArchiveSnapshot())).sessions.length;
	await page.getByRole("button", { name: "删除归档会话：看看我的项目", exact: true }).click();
	await page
		.getByRole("dialog", { name: "删除归档会话", exact: true })
		.getByRole("button", { name: "取消", exact: true })
		.click();
	assert.equal((await page.evaluate(() => window.piDesktop.getArchiveSnapshot())).sessions.length, before);
	await page.getByRole("button", { name: "删除归档会话：看看我的项目", exact: true }).click();
	await page.getByRole("button", { name: "确认删除", exact: true }).click();
	await page.getByRole("dialog", { name: "删除归档会话", exact: true }).waitFor({ state: "hidden" });
	assert.equal((await page.evaluate(() => window.piDesktop.getArchiveSnapshot())).sessions.length, before - 1);
	await page.getByRole("switch", { name: "自动归档旧会话", exact: true }).click();
	await poll(
		async () =>
			(await page.getByRole("switch", { name: "自动归档旧会话", exact: true }).getAttribute("aria-checked")) === "true",
		"自动归档未启用",
	);
	await page.getByLabel("归档保留时长", { exact: true }).selectOption("30");
	await poll(
		async () => (await page.evaluate(() => window.piDesktop.getArchiveSnapshot())).policy.retentionDays === 30,
		"保留时长未保存",
	);
	const archives = await page.evaluate(() => window.piDesktop.getArchiveSnapshot());
	assert(!archives.sessions.some((item) => item.id === pinned.id || item.id === restore.id));
	checks.push(
		"archive-search-sort-project-filter",
		"restore-and-delete-confirmation",
		"automatic-archive-pinned-and-restored-protection",
	);
	await page.getByRole("button", { name: "切换深色主题", exact: true }).click();
	await captureData(".archive-management", "archives-dark.png");
	await page.getByRole("button", { name: "使用统计", exact: true }).click();
	await page.locator(".usage-metrics").waitFor();
	await captureData(".usage-statistics", "usage-dark.png");
	const darkCell = page.locator('.heatmap-cell[data-level="4"]').first();
	await darkCell.hover();
	await page.locator(".heatmap-tooltip").waitFor({ state: "visible" });
	assert.equal(
		await page.locator(".heatmap-tooltip").evaluate((element) => getComputedStyle(element).backgroundColor),
		"rgb(35, 35, 36)",
	);
	await captureHover("heatmap-tooltip-dark.png");
	await page.mouse.move(0, 0);
	await page.locator(".heatmap-tooltip").waitFor({ state: "hidden" });
	await application.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()
			.find((window) => !window.webContents.getURL().includes("startup.html"))
			.setSize(1100, 720),
	);
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await page.waitForFunction(() => {
		const content = document.querySelector(".settings-content");
		return content.scrollWidth <= content.clientWidth;
	});
	await page.screenshot({ path: join(artifacts, "data-minimum-window.png"), scale: "css" });
	await page.getByRole("button", { name: "归档管理", exact: true }).click();
	await page.locator(".archive-policy-card").waitFor();
	assert(await page.locator(".settings-content").evaluate((element) => element.scrollWidth <= element.clientWidth));
	await page.screenshot({ path: join(artifacts, "archives-minimum-window.png"), scale: "css" });
	await application.close();
	application = undefined;
	await launch();
	await poll(async () => Boolean(await page.evaluate(() => window.piDesktop.getSnapshot())), "重启恢复失败");
	assert.deepEqual((await page.evaluate(() => window.piDesktop.getArchiveSnapshot())).policy, {
		enabled: true,
		retentionDays: 30,
	});
	checks.push("light-dark-and-minimum-window", "policy-survives-restart");
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "归档管理", exact: true }).click();
	await page.locator(".archive-policy-card").waitFor();
	const groupedBefore = (await page.evaluate(() => window.piDesktop.getArchiveSnapshot())).sessions.length;
	await page.getByRole("button", { name: "归档项目操作：ZCodeProject", exact: true }).click();
	await page.getByRole("menuitem", { name: "取消本组归档", exact: true }).click();
	await poll(
		async () =>
			(await page.evaluate(() => window.piDesktop.getArchiveSnapshot())).sessions.length === groupedBefore - 1,
		"分组恢复未生效",
	);
	await page.getByRole("button", { name: "全部删除", exact: true }).click();
	await page.getByRole("button", { name: "确认删除", exact: true }).click();
	await page.getByRole("dialog", { name: "删除归档会话", exact: true }).waitFor({ state: "hidden" });
	await page.getByText("暂无已归档会话", { exact: true }).waitFor();
	checks.push("group-restore-and-confirmed-delete-all-empty-state");
	assert.deepEqual(failures, []);
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: true, checks, statistics, failures }, null, 2),
	);
	logger.info(JSON.stringify({ passed: true, checks, artifacts }));
} catch (error) {
	await page?.screenshot({ path: join(artifacts, "failure.png"), scale: "css" }).catch(() => {});
	await writeFile(
		join(artifacts, "results.json"),
		JSON.stringify({ passed: false, checks, failures, error: String(error) }, null, 2),
	);
	throw error;
} finally {
	await application?.close().catch(() => {});
	trashServer.closeAllConnections();
	await new Promise((done) => trashServer.close(done));
	logger.info("设置数据验收结束");
}
