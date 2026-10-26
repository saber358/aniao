import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { copyKernelRuntimeFiles } from "../config/kernel-build.ts";
import { workspaceAliases } from "../config/workspace-aliases.ts";

const logger = console;
const execute = promisify(execFile);

/*
 * ========================================================================
 * 步骤1：回归打包宿主的扩展发现与依赖解析
 * ========================================================================
 * 数据源：临时中文目录和真实 esbuild/Jiti，不替换模块加载器。
 * 操作：
 *   1) SDK 内部模块走虚拟映射，相对文件仍从扩展目录读取
 *   2) 宿主不要求其他工作区包先生成 dist，重载后清除旧工厂
 */
describe("bundled extensions", () => {
	it("loads user and trusted project modules and invalidates factories on reload", async () => {
		logger.info("开始验证打包扩展加载");
		const artifactRoot = resolve("artifacts");
		await mkdir(artifactRoot, { recursive: true });
		const directory = await mkdtemp(join(artifactRoot, "extension-loader-"));
		if (dirname(resolve(directory)) !== artifactRoot) throw new Error("测试清理目录越界");
		try {
			const cwd = join(directory, "中文项目");
			const agentDir = join(directory, "agent");
			// 1.1 使用独立目录，禁止读取用户真实扩展与认证。
			await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
			await mkdir(join(agentDir, "extensions", "helper"), { recursive: true });
			await writeFile(join(agentDir, "extensions", "helper", "label.ts"), 'export const label: string = "portable";');
			await writeFile(
				join(agentDir, "extensions", "portable.ts"),
				`
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { label } from "./helper/label.ts";
export default function (pi) {
  if (Type.String().type !== "string" || !builtinProviders().length) throw new Error("virtual modules unavailable");
  createEventBus();
  pi.registerCommand(truncateToWidth(label, 20), { handler: async () => {} });
}
`,
			);
			await writeFile(
				join(cwd, ".pi", "extensions", "project.ts"),
				'export default (pi) => pi.registerCommand("project", {handler: async () => {}});',
			);
			// 1.2 与产品宿主使用相同别名、打包格式和模块副作用设置。
			const outfile = join(directory, "host.mjs");
			await build({
				entryPoints: ["test/fixtures/extension-host.ts"],
				outfile,
				bundle: true,
				platform: "node",
				format: "esm",
				target: "node22",
				packages: "external",
				ignoreAnnotations: true,
				define: { PI_BUNDLED_NODE: "true" },
				alias: Object.fromEntries(workspaceAliases.map(({ find, replacement }) => [find, replacement])),
			});
			await copyKernelRuntimeFiles(directory);
			const { stdout } = await execute(process.execPath, [outfile, cwd, agentDir], {
				maxBuffer: 1024 * 1024,
				timeout: 10_000,
			});
			expect(stdout).toContain('"commands":["portable","project"]');
			expect(stdout).toContain('"kernel":"1.4.0"');
			expect(stdout).toContain('"models":"1.4.0"');
			expect(stdout).toContain('"oauth":"cancelled-after-module-load"');
			expect(stdout).toContain('"reloaded":["project","reloaded"]');
		} finally {
			await rm(directory, { recursive: true, force: true });
			logger.info("打包扩展加载验证完成");
		}
	});
});
