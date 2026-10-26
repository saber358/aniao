import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProjectFiles } from "../src/main/project-files.ts";
import { PROJECT_FILE_LIMIT, PROJECT_PATH_LIMIT } from "../src/shared/project-files.ts";
import { projectFilePathsSchema, projectFileSelectionSchema } from "../src/shared/workspace.ts";

const logger = { info: vi.fn() };
const directories: string[] = [];

/*
 * ========================================================================
 * 步骤1：验证项目文件的真实路径边界
 * ========================================================================
 * 数据源：临时项目、中文文件、真实目录链接和无效选择。
 * 操作：
 *   1) 同项目链接归一化去重，前缀相似目录与越界链接被拒绝
 *   2) 混入无效路径时整批失败，不读取正文或返回绝对路径
 */
describe("project file references", () => {
	afterEach(async () => {
		for (const directory of directories.splice(0)) {
			if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("pi-gui-files-"))
				throw new Error("Unexpected temporary directory");
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("normalizes selected files and in-project links without reading their contents", async () => {
		logger.info("开始验证项目文件归一化");
		try {
			// 1.1 junction 在 Windows 无需符号链接提权，同时覆盖真实目录解析。
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-files-"));
			directories.push(directory);
			const cwd = join(directory, "项目");
			await mkdir(join(cwd, "src"), { recursive: true });
			const file = join(cwd, "src", "中文 文件.ts");
			await writeFile(file, "不可送入界面的正文", "utf8");
			await symlink(join(cwd, "src"), join(cwd, "linked"), "junction");
			expect(
				await resolveProjectFiles(
					cwd,
					[file, join(cwd, "linked", "中文 文件.ts"), join(cwd, "src", "..", "src", "中文 文件.ts")],
					logger,
				),
			).toEqual(["src/中文 文件.ts"]);
			expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining(file));
		} finally {
			logger.info("项目文件归一化验证完成");
		}
	});

	it("rejects outside files, similar directory prefixes and escaping junctions atomically", async () => {
		logger.info("开始验证项目文件越界");
		try {
			// 1.2 有效文件与越界文件混选也不返回部分结果。
			const directory = await mkdtemp(join(tmpdir(), "pi-gui-files-"));
			directories.push(directory);
			const cwd = join(directory, "project");
			const outside = join(directory, "project-extra");
			await mkdir(cwd);
			await mkdir(outside);
			await writeFile(join(cwd, "inside.txt"), "inside");
			await writeFile(join(outside, "secret.txt"), "outside");
			await symlink(outside, join(cwd, "escape"), "junction");
			for (const file of [join(outside, "secret.txt"), join(cwd, "escape", "secret.txt")])
				await expect(resolveProjectFiles(cwd, [join(cwd, "inside.txt"), file], logger)).rejects.toThrow("当前项目");
		} finally {
			logger.info("项目文件越界验证完成");
		}
	});

	it("rejects missing files and directories and leaves cancellation empty", async () => {
		logger.info("开始验证无效文件选择");
		try {
			// 1.3 取消结果不要求项目仍存在，选择本身不创建任何文件。
			const cwd = await mkdtemp(join(tmpdir(), "pi-gui-files-"));
			directories.push(cwd);
			await expect(resolveProjectFiles(cwd, [cwd], logger)).rejects.toThrow("不能引用目录");
			await expect(resolveProjectFiles(cwd, [join(cwd, "missing")], logger)).rejects.toThrow("已失效或不可访问");
			await expect(resolveProjectFiles(join(cwd, "missing"), [join(cwd, "file")], logger)).rejects.toThrow(
				"项目目录已失效",
			);
			expect(await resolveProjectFiles(join(cwd, "missing"), [], logger)).toEqual([]);
		} finally {
			logger.info("无效文件选择验证完成");
		}
	});

	it("bounds counts and path text before filesystem access and validates the desktop contract", async () => {
		logger.info("开始验证文件选择协议上限");
		try {
			// 1.4 输入只允许身份；返回只允许有界相对路径。
			const cwd = resolve(tmpdir(), "absent-project");
			await expect(
				resolveProjectFiles(cwd, Array(PROJECT_FILE_LIMIT + 1).fill(join(cwd, "file")), logger),
			).rejects.toThrow("最多引用");
			for (const file of [
				"relative.txt",
				join(cwd, "换\n行"),
				join(cwd, "换\u0085行"),
				join(cwd, "换\u2028行"),
				join(cwd, "x".repeat(PROJECT_PATH_LIMIT)),
			])
				await expect(resolveProjectFiles(cwd, [file], logger)).rejects.toThrow("文件路径无效");
			expect(
				projectFileSelectionSchema.safeParse({ sessionId: "current", generation: "host", path: cwd }).success,
			).toBe(false);
			for (const path of ["../secret", "a/../secret", "C:/secret", "/secret", "..\\secret", "a\nfile"])
				expect(projectFilePathsSchema.safeParse([path]).success).toBe(false);
			expect(projectFilePathsSchema.parse(["src/中文 文件.ts", 'src/带"引号.ts'])).toHaveLength(2);
		} finally {
			logger.info("文件选择协议上限验证完成");
		}
	});
});
