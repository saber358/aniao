import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const logger = console;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] ?? "http://127.0.0.1:4177";
const artifacts = join(root, "artifacts", `browser-${Date.now()}`);
const local = new URL(base).hostname === "127.0.0.1";
const failures = [];
const report = { url: base, viewports: [], downloads: [], javascriptDisabled: false };
const browser = await chromium.launch({ channel: "msedge", headless: true });

/*
 * ========================================================================
 * 步骤1：验收真实浏览器中的布局、导航和原生下载
 * ========================================================================
 * 数据源：本地或线上官网，以及已验收的实际安装包。
 * 操作：1) 检查手机与桌面宽度；2) 点击双平台下载并核对文件名。
 */
logger.info("开始验收官网浏览器交互");
await mkdir(artifacts, { recursive: true });
try {
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
	await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
	// 1.1 本地点击完整下载，线上检查下载事件后取消，完整内容另做流式摘要校验。
	const page = await context.newPage();
	page.on("pageerror", (error) => failures.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") failures.push(message.text());
	});
	page.on("response", (response) => {
		if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
	});
	assert.equal((await page.goto(base, { waitUntil: "networkidle" })).status(), 200);
	assert.match(await page.title(), /Aniao Harness/);
	await page.screenshot({ path: join(artifacts, "desktop-hero.png") });
	// 1.2 每个锚点和图标都指向实际资源，不能以空链接充当按钮。
	assert.deepEqual(
		await page
			.locator('a[href^="#"]')
			.evaluateAll((links) =>
				links.filter((link) => !document.getElementById(link.hash.slice(1))).map((link) => link.hash),
			),
		[],
	);
	const sprite = await (await context.request.get(`${base}/assets/icons.svg`)).text();
	for (const reference of await page
		.locator("svg use")
		.evaluateAll((elements) => elements.map((element) => element.getAttribute("href")))) {
		assert(sprite.includes(`id="${reference.split("#")[1]}"`), reference);
	}
	assert.equal(await page.locator('a[href="https://github.com/saber358/aniao"]').count(), 2);
	for (const platform of ["windows", "linux"]) {
		const links = page.locator(`[data-download="${platform}"]`);
		assert.equal(await links.count(), 2);
		for (const link of await links.all()) {
			const filename = (await link.getAttribute("href")).split("/").pop();
			assert.match(filename, platform === "windows" ? /windows-x64-setup\.exe$/ : /linux-amd64\.deb$/);
			const downloadPromise = page.waitForEvent("download");
			await link.click();
			const download = await downloadPromise;
			assert.equal(download.suggestedFilename(), filename);
			if (local) assert.equal(await download.failure(), null);
			else await download.cancel();
			report.downloads.push({ platform, filename, nativeDownloadTested: true, completed: local });
		}
	}
	// 1.3 展开安装说明并验证剪贴板内容，不运行安装命令。
	await page.locator(".install-guide summary").click();
	await page.getByRole("button", { name: "复制 Linux 安装命令", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "安装命令已复制" }).waitFor();
	assert.equal(
		await page.evaluate(() => navigator.clipboard.readText()),
		"sudo apt install ./Aniao-Harness-0.80.23-linux-amd64.deb",
	);
	await page.locator(".faq-list summary").first().click();
	assert.equal(await page.locator(".faq-list details").first().getAttribute("open"), "");
	await page.locator(".install-guide summary").click();
	await page.getByRole("status").evaluate((element) => element.classList.remove("visible"));
	for (const width of [1440, 1024, 768, 390, 320]) {
		// 1.4 各个区段进入视口后验收图片加载和页面宽度。
		await page.setViewportSize({ width, height: width > 760 ? 1000 : 844 });
		for (const section of await page.locator("section").all()) await section.scrollIntoViewIfNeeded();
		await page.locator(".product-stage img").evaluate((image) => image.decode());
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `水平溢出：${width}`);
		assert.deepEqual(
			await page
				.locator("img")
				.evaluateAll((images) =>
					images.filter((image) => !image.complete || !image.naturalWidth).map((image) => image.src),
				),
			[],
		);
		await page.evaluate(() => scrollTo(0, 0));
		if (width === 1440 || width === 390) {
			await page.screenshot({ path: join(artifacts, `${width}-hero.png`) });
			await page.screenshot({ path: join(artifacts, `${width}-full.png`), fullPage: true });
		}
		report.viewports.push(width);
	}
	// 1.5 移动导航可展开、用 Esc 关闭，并通过链接到达下载区。
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "展开导航", exact: true }).click();
	assert.equal(await page.locator(".menu-toggle").getAttribute("aria-expanded"), "true");
	await page.keyboard.press("Escape");
	assert.equal(await page.locator(".menu-toggle").getAttribute("aria-expanded"), "false");
	await page.getByRole("button", { name: "展开导航", exact: true }).click();
	await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "下载", exact: true }).click();
	assert.equal(new URL(page.url()).hash, "#download");
	assert.equal(await page.locator(".menu-toggle").getAttribute("aria-expanded"), "false");
	assert(await page.locator(".download-options").isVisible());
	assert.deepEqual(failures, []);
	await context.close();
	// 1.6 关闭脚本仍显示内容，并保留可直接访问的两个下载地址。
	const plainContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
	const plainPage = await plainContext.newPage();
	await plainPage.goto(base);
	assert(await plainPage.locator(".download-options").isVisible());
	assert.equal(await plainPage.locator(".download-options a[download]").count(), 2);
	report.javascriptDisabled = true;
	await plainContext.close();
	// 1.7 系统开启动态效果时，首屏和滚动区段也能正常显示。
	const motionContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	const motionPage = await motionContext.newPage();
	await motionPage.goto(base);
	await motionPage.locator(".download-options").scrollIntoViewIfNeeded();
	await motionPage.waitForFunction(() => getComputedStyle(document.querySelector(".download-options")).opacity === "1");
	await motionContext.close();
	await writeFile(join(artifacts, "report.json"), `${JSON.stringify({ ...report, passed: true }, null, 2)}\n`);
	logger.info(JSON.stringify({ passed: true, artifacts, ...report }));
} finally {
	await browser.close();
	logger.info("官网浏览器交互验收结束");
}
