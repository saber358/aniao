import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const logger = console;
const root = fileURLToPath(new URL("../", import.meta.url));

/*
 * ========================================================================
 * 步骤1：在 Linux x64 构建 Electron 的终端原生模块
 * ========================================================================
 * 数据源：已安装的固定版本 Electron、node-pty 与 electron-builder 自带重建工具。
 * 操作：1) 拒绝跨系统复制原生模块；2) 只编译 node-pty，不运行其他安装脚本。
 */
logger.info("开始准备 Linux x64 终端模块");
try {
	// 1.1 原生模块必须在目标系统构建，Windows 包继续使用自身预编译文件。
	assert.equal(process.platform, "linux", "Linux 包必须在 Linux 环境构建");
	assert.equal(process.arch, "x64", "当前 Linux 安装包只提供 amd64 架构");
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const electronVersion = manifest.devDependencies.electron;
	assert.match(electronVersion, /^\d+\.\d+\.\d+$/);
	// 1.2 重建工具来自已锁定的 electron-builder 依赖，只编译 node-pty。
	const cli = join(dirname(fileURLToPath(import.meta.resolve("@electron/rebuild"))), "cli.js");
	const child = spawn(
		process.execPath,
		[
			cli,
			"--version",
			electronVersion,
			"--module-dir",
			root,
			"--only",
			"node-pty",
			"--arch",
			"x64",
			"--force",
			"--build-from-source",
		],
		{ cwd: root, stdio: "inherit", windowsHide: true },
	);
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	assert.equal(code, 0, "Linux 终端原生模块编译失败");
} finally {
	logger.info("Linux x64 终端模块准备结束");
}
