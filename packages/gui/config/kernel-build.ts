import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { kernelDirectory } from "./workspace-aliases.ts";

const logger = console;

/*
 * ========================================================================
 * 步骤1：保留官方内核的延迟加载模块与工作线程
 * ========================================================================
 * 数据源：Pi 1.4.0 已发布的独立运行文件。
 * 操作：
 *   1) OAuth、Bedrock 和图片处理沿用官方构建产物
 *   2) 文件放在宿主旁，保证变量导入与 codemode 线程在安装后可解析
 */
export async function copyKernelRuntimeFiles(directory: string): Promise<void> {
	logger.info("开始准备 Pi 延迟加载资源");
	try {
		// 1.1 官方变量导入无法由 esbuild 自动发现，必须随宿主显式保留。
		await mkdir(directory, { recursive: true });
		for (const name of [
			"anthropic",
			"bedrock-converse-stream",
			"github-copilot",
			"image-resize-worker",
			"kimi-coding",
			"meta",
			"openai-chatgpt",
			"openai-codex",
			"openrouter",
			"radius",
			"xai",
			"codemode-worker",
		]) {
			await copyFile(join(kernelDirectory, "dist/bundle/chunks", `${name}.js`), join(directory, `${name}.js`));
		}
	} finally {
		logger.info("Pi 延迟加载资源准备结束");
	}
}
