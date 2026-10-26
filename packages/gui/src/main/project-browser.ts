import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
	ProjectDirectory,
	ProjectDirectoryRequest,
	ProjectFileContent,
	ProjectReadRequest,
} from "../shared/project-browser.ts";

const MAX_ENTRIES = 500;
const MAX_FILE = 1.5 * 1024 * 1024;

/*
 * ========================================================================
 * 步骤1：只读浏览当前项目目录
 * ========================================================================
 * 数据源：活动项目 cwd 下的目录项和文本文件。
 * 操作：
 *   1) 所有路径重新解析并限制在项目根目录内
 *   2) 跳过 .git、node_modules 和符号链接，限制条目与文件大小
 */
export class ProjectBrowser {
	async list(request: ProjectDirectoryRequest): Promise<ProjectDirectory> {
		const root = await realpath(request.cwd);
		const target = await this.resolve(root, request.path);
		const directory = await stat(target);
		if (!directory.isDirectory()) throw new Error("目标不是目录");
		const entries = [];
		for (const entry of await readdir(target, { withFileTypes: true })) {
			if (entries.length >= MAX_ENTRIES) break;
			if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
			if (!entry.isDirectory() && !entry.isFile()) continue;
			entries.push({
				name: entry.name,
				path: this.relative(root, resolve(target, entry.name)),
				type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
			});
		}
		entries.sort((left, right) => {
			if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
			return left.name.localeCompare(right.name);
		});
		return { path: this.relative(root, target), entries, truncated: entries.length >= MAX_ENTRIES };
	}

	async read(request: ProjectReadRequest): Promise<ProjectFileContent> {
		const root = await realpath(request.cwd);
		const target = await this.resolve(root, request.path);
		const info = await stat(target);
		if (!info.isFile()) throw new Error("目标不是文件");
		if (info.size > MAX_FILE) return { path: this.relative(root, target), text: "", binary: false, truncated: true };
		const buffer = await readFile(target);
		if (buffer.includes(0)) return { path: this.relative(root, target), text: "", binary: true, truncated: false };
		return { path: this.relative(root, target), text: buffer.toString("utf8"), binary: false, truncated: false };
	}

	async resolveFile(request: ProjectReadRequest): Promise<{ target: string; path: string }> {
		const root = await realpath(request.cwd);
		const target = await this.resolve(root, request.path);
		const info = await stat(target);
		if (!info.isFile()) throw new Error("目标不是文件");
		return { target, path: this.relative(root, target) };
	}

	private async resolve(root: string, path: string): Promise<string> {
		if (path.includes("\0") || isAbsolute(path)) throw new Error("文件路径无效");
		const target = resolve(root, path);
		const rel = relative(root, target);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("文件路径超出项目目录");
		const actual = await realpath(target);
		const actualRel = relative(root, actual);
		if (actualRel.startsWith("..") || isAbsolute(actualRel)) throw new Error("文件路径超出项目目录");
		return actual;
	}

	private relative(root: string, path: string): string {
		return relative(root, path).replaceAll("\\", "/");
	}
}
