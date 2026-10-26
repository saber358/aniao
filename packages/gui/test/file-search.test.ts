import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchProjectFiles } from "../src/main/file-search.ts";
import { PROJECT_QUERY_LIMIT } from "../src/shared/project-files.ts";
import { projectFileReferenceSchema, projectFileSearchSchema } from "../src/shared/workspace.ts";

const logger = { info: vi.fn() };
const directories: string[] = [];

/*
 * ========================================================================
 * 步骤1：验证项目文件查询的规则、范围与预算
 * ========================================================================
 * 数据源：真实临时目录、嵌套忽略规则、目录链接和普通文件名。
 * 操作：
 *   1) 忽略规则交给 ignore 解析，查询仅匹配路径字面量
 *   2) 不扫描链接目标，不把取消或不完整结果伪装成完整搜索
 */
describe("project file search", () => {
	afterEach(async () => {
		for (const directory of directories.splice(0)) {
			if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("pi-gui-search-"))
				throw new Error("Unexpected temporary directory");
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("respects nested ignore overrides and matches Chinese, spaces and literal punctuation", async () => {
		logger.info("开始验证文件查询规则");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-search-"));
			directories.push(directory);
			for (const folder of ["src", "nested", "keep", "ignored", "node_modules", ".git"])
				await mkdir(join(directory, folder));
			await writeFile(join(directory, ".gitignore"), "*.log\nignored/\nkeep/*.ts\n!keep/allowed.ts\nnested/*.ts\n");
			await writeFile(join(directory, "nested", ".gitignore"), "!visible.ts\n");
			const files = [
				"src/中文 文件.ts",
				"src/[literal].ts",
				"nested/visible.ts",
				"nested/hidden.ts",
				"keep/allowed.ts",
				"keep/hidden.ts",
				"ignored/hidden.ts",
				"node_modules/hidden.ts",
				".git/hidden.ts",
				"error.log",
			];
			await Promise.all(files.map((file) => writeFile(join(directory, file), "unchanged")));
			const all = await searchProjectFiles(directory, ".ts", logger, new AbortController().signal);
			expect(all.paths.sort()).toEqual(
				["keep/allowed.ts", "nested/visible.ts", "src/[literal].ts", "src/中文 文件.ts"].sort(),
			);
			expect(all.incomplete).toBe(false);
			expect((await searchProjectFiles(directory, "src\\中文", logger, new AbortController().signal)).paths).toEqual([
				"src/中文 文件.ts",
			]);
			expect((await searchProjectFiles(directory, "[literal]", logger, new AbortController().signal)).paths).toEqual([
				"src/[literal].ts",
			]);
			expect((await searchProjectFiles(directory, "*.ts", logger, new AbortController().signal)).paths).toEqual([]);
			expect(await readFile(join(directory, "src", "中文 文件.ts"), "utf8")).toBe("unchanged");
		} finally {
			logger.info("文件查询规则验证完成");
		}
	});

	it("does not traverse internal, escaping or cyclic directory links", async () => {
		logger.info("开始验证文件查询链接边界");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-search-"));
			directories.push(directory);
			const root = join(directory, "project");
			const outside = join(directory, "project-extra");
			await mkdir(join(root, "src"), { recursive: true });
			await mkdir(outside);
			await writeFile(join(root, "src", "visible.ts"), "visible");
			await writeFile(join(outside, "secret.ts"), "secret");
			await symlink(outside, join(root, "escape"), "junction");
			await symlink(root, join(root, "cycle"), "junction");
			await symlink(join(root, "src"), join(root, "alias"), "junction");
			expect(await searchProjectFiles(root, ".ts", logger, new AbortController().signal)).toEqual({
				paths: ["src/visible.ts"],
				incomplete: false,
			});
		} finally {
			logger.info("文件查询链接边界验证完成");
		}
	});

	it("returns a bounded incomplete result and honors cancellation without touching absent roots", async () => {
		logger.info("开始验证文件查询预算");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-search-"));
			directories.push(directory);
			await Promise.all(
				Array.from({ length: 21 }, (_value, index) => writeFile(join(directory, `${index}.ts`), "fixture")),
			);
			const found = await searchProjectFiles(directory, ".ts", logger, new AbortController().signal);
			expect(found.paths).toHaveLength(20);
			expect(found.incomplete).toBe(true);
			expect(await searchProjectFiles(join(directory, "absent"), "", logger, new AbortController().signal)).toEqual({
				paths: [],
				incomplete: false,
			});
			const cancelled = new AbortController();
			cancelled.abort();
			await expect(searchProjectFiles(join(directory, "absent"), "x", logger, cancelled.signal)).rejects.toThrow();
			await expect(
				searchProjectFiles(join(directory, "absent"), "x", logger, new AbortController().signal),
			).rejects.toThrow("项目目录已失效");
		} finally {
			logger.info("文件查询预算验证完成");
		}
	});

	it("rejects oversized ignore files rather than scanning with silently missing rules", async () => {
		logger.info("开始验证文件查询规则上限");
		try {
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-search-"));
			directories.push(directory);
			await writeFile(join(directory, ".gitignore"), "x".repeat(64 * 1024 + 1));
			await expect(searchProjectFiles(directory, "x", logger, new AbortController().signal)).rejects.toThrow(
				"忽略规则过大",
			);
		} finally {
			logger.info("文件查询规则上限验证完成");
		}
	});

	it("only accepts bounded search text and project relative references at the bridge", () => {
		logger.info("开始验证文件查询协议");
		try {
			const selection = { sessionId: "session", generation: "host" };
			for (const query of ["a\nfile", "a\u2028file", "x".repeat(PROJECT_QUERY_LIMIT + 1)])
				expect(projectFileSearchSchema.safeParse({ ...selection, query }).success).toBe(false);
			expect(projectFileSearchSchema.safeParse({ ...selection, query: "x", cwd: "outside" }).success).toBe(false);
			for (const paths of [[], ["../outside"], ["/outside"], ["C:/outside"], ["link/../../outside"]])
				expect(projectFileReferenceSchema.safeParse({ ...selection, paths }).success).toBe(false);
			expect(projectFileReferenceSchema.parse({ ...selection, paths: ["src/中文 文件.ts"] }).paths).toEqual([
				"src/中文 文件.ts",
			]);
		} finally {
			logger.info("文件查询协议验证完成");
		}
	});
});
