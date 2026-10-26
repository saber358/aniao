import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { GitDiff, GitDiffRequest, GitFileChange, GitMutationRequest, GitStatus } from "../shared/git.ts";
import { createLogger } from "../shared/logger.ts";

const execute = promisify(execFile);
const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_CONTENT = 1.5 * 1024 * 1024;
const logger = createLogger("git");

interface Content {
	text: string;
	binary: boolean;
	truncated: boolean;
}

/*
 * ========================================================================
 * 步骤1：提供只读 Git 快照与文件差异
 * ========================================================================
 * 数据源：当前活动项目目录下的 Git CLI。
 * 操作：
 *   1) 固定 cwd、参数数组和输出上限，不拼接 shell
 *   2) 只读取状态、分支与指定文件的两个版本
 */
export class GitService {
	async status(cwd: string): Promise<GitStatus> {
		const root = await this.repositoryRoot(cwd);
		const [head, branch, counts, raw] = await Promise.all([
			this.head(root),
			this.branch(root),
			this.aheadBehind(root),
			this.git(root, ["status", "--porcelain=v1", "-z"]),
		]);
		const files: GitFileChange[] = [];
		const tokens = raw.split("\0");
		for (let index = 0; index < tokens.length; index += 1) {
			const token = tokens[index];
			if (!token || token.length < 4) continue;
			const indexStatus = token[0] ?? " ";
			const worktreeStatus = token[1] ?? " ";
			const path = token.slice(3);
			if (!path) continue;
			let originalPath: string | undefined;
			if (["R", "C"].includes(indexStatus) || ["R", "C"].includes(worktreeStatus)) {
				originalPath = tokens[index + 1];
				index += 1;
			}
			const untracked = indexStatus === "?" && worktreeStatus === "?";
			files.push({
				path,
				originalPath,
				index: indexStatus,
				worktree: worktreeStatus,
				staged: !untracked && indexStatus !== " ",
				unstaged: !untracked && worktreeStatus !== " ",
				untracked,
			});
		}
		return { root, head, branch, ahead: counts.ahead, behind: counts.behind, files };
	}

	async mutate(request: GitMutationRequest): Promise<GitStatus> {
		/*
		 * ========================================================================
		 * 步骤2：核对用户实际查看的文件版本后修改 Git 状态
		 * ========================================================================
		 * 数据源：HEAD、索引对象与工作区文件内容摘要。
		 * 操作：1) 拒绝内容已变化的旧差异；2) 只处理明确选中的文件。
		 */
		logger.info("开始核对 Git 操作版本");
		try {
			// 2.1 状态字母相同仍可能包含新编辑，必须重新核对内容摘要。
			const before = await this.status(request.cwd);
			const root = before.root;
			this.assertInside(root, request.path);
			this.assertInside(root, request.originalPath ?? request.path);
			if (before.head !== request.expectedHead) throw new Error("Git HEAD 已变化，请刷新后重试");
			const file = before.files.find(
				(item) => item.path === request.path && item.originalPath === request.originalPath,
			);
			if (!file) throw new Error("文件状态已变化，请刷新后重试");
			if (file.index !== request.expectedIndex || file.worktree !== request.expectedWorktree)
				throw new Error("文件状态已变化，请刷新后重试");
			if ((await this.revision(root, request.path, request.originalPath)) !== request.expectedVersion)
				throw new Error("文件内容已变化，请刷新差异后重试");
			// 2.2 版本校验通过后才允许暂存、取消暂存或还原。
			if (request.action === "stage") {
				if (file.staged && !file.unstaged) throw new Error("没有需要暂存的改动");
				await this.git(root, ["add", "-A", "--", request.path]);
			} else if (request.action === "unstage") {
				if (!file.staged) throw new Error("没有需要取消暂存的改动");
				try {
					await this.git(root, ["restore", "--staged", "--", request.path]);
				} catch {
					await this.git(root, ["rm", "--cached", "--", request.path]);
				}
			} else {
				if (file.untracked) throw new Error("未跟踪文件不支持还原");
				if (!file.unstaged) throw new Error("没有需要还原的改动");
				await this.git(root, ["restore", "--worktree", "--", request.path]);
			}
			return this.status(request.cwd);
		} finally {
			logger.info("Git 操作版本核对结束");
		}
	}

	async diff(request: GitDiffRequest): Promise<GitDiff> {
		/*
		 * ========================================================================
		 * 步骤3：为差异绑定可重新验证的内容版本
		 * ========================================================================
		 * 数据源：Git 两侧版本与工作区文件，不采用修改时间推测内容。
		 * 操作：1) 读取前后各取一次摘要；2) 读取期间变化则拒绝混合快照。
		 */
		logger.info("开始读取有版本的 Git 差异");
		try {
			// 3.1 先记录索引、HEAD 与工作区内容，再读取展示版本。
			const root = await this.repositoryRoot(request.cwd);
			const path = request.path;
			const originalPath = request.originalPath ?? path;
			this.assertInside(root, path);
			this.assertInside(root, originalPath);
			const version = await this.revision(root, path, request.originalPath);

			let original: Content = empty();
			let modified: Content = empty();
			if (request.staged) {
				original = await this.show(root, `HEAD:${originalPath}`);
				modified = await this.show(root, `:${path}`);
			} else {
				original = await this.show(root, `:${originalPath}`);
				modified = await this.readWorktree(root, path);
			}
			// 3.2 摘要同时用于后续 Git 动作和行评论定位。
			if ((await this.revision(root, path, request.originalPath)) !== version)
				throw new Error("文件在读取期间发生变化，请刷新差异后重试");
			return {
				version,
				path,
				originalPath: request.originalPath,
				original: original.text,
				modified: modified.text,
				binary: original.binary || modified.binary,
				truncated: original.truncated || modified.truncated,
			};
		} finally {
			logger.info("有版本的 Git 差异读取结束");
		}
	}

	private async revision(root: string, path: string, originalPath?: string): Promise<string> {
		const paths = [...new Set([path, ...(originalPath ? [originalPath] : [])])];
		const [head, index, ...contents] = await Promise.all([
			this.head(root),
			this.git(root, ["ls-files", "--stage", "-z", "--", ...paths]),
			...paths.map(async (entry) => {
				const absolute = this.assertInside(root, entry);
				try {
					const parent = await realpath(dirname(absolute));
					this.assertInside(root, relative(root, parent));
					const info = await lstat(absolute);
					if (info.isSymbolicLink()) return `link:${await readlink(absolute)}`;
					if (!info.isFile()) return `other:${info.mode}`;
					return `${info.mode}:${await this.git(root, ["hash-object", "--no-filters", "--", entry])}`;
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
					throw error;
				}
			}),
		]);
		return createHash("sha256")
			.update(JSON.stringify([head, index, ...contents]))
			.digest("hex");
	}

	private async repositoryRoot(cwd: string): Promise<string> {
		const directory = await realpath(cwd);
		const root = await this.git(directory, ["rev-parse", "--show-toplevel"]);
		return realpath(root.trim());
	}

	private async head(root: string): Promise<string> {
		try {
			return (await this.git(root, ["rev-parse", "HEAD"])).trim();
		} catch {
			return "";
		}
	}

	private async branch(root: string): Promise<string> {
		try {
			const branch = (await this.git(root, ["branch", "--show-current"])).trim();
			return branch || "detached HEAD";
		} catch {
			return "detached HEAD";
		}
	}

	private async aheadBehind(root: string): Promise<{ ahead: number; behind: number }> {
		try {
			const output = (await this.git(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).trim();
			const [ahead = "0", behind = "0"] = output.split(/\s+/);
			return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
		} catch {
			return { ahead: 0, behind: 0 };
		}
	}

	private async show(root: string, spec: string): Promise<Content> {
		try {
			const size = Number((await this.git(root, ["cat-file", "-s", spec])).trim());
			if (!Number.isFinite(size)) return empty();
			if (size > MAX_CONTENT) return { text: "", binary: false, truncated: true };
			const output = await this.git(root, ["show", spec]);
			return decode(output);
		} catch {
			return empty();
		}
	}

	private async readWorktree(root: string, path: string): Promise<Content> {
		const absolute = this.assertInside(root, path);
		try {
			const info = await lstat(absolute);
			if (!info.isFile()) return empty();
			const target = info.isSymbolicLink() ? await realpath(absolute) : absolute;
			this.assertInside(root, relative(root, target));
			if (info.size > MAX_CONTENT) return { text: "", binary: false, truncated: true };
			return decode(await readFile(target));
		} catch {
			return empty();
		}
	}

	private assertInside(root: string, path: string): string {
		if (path.includes("\0") || isAbsolute(path)) throw new Error("文件路径无效");
		const absolute = resolve(root, path);
		const rel = relative(root, absolute);
		if (rel.startsWith("..") || isAbsolute(rel) || (rel && !absolute.startsWith(root + sep)))
			throw new Error("文件路径超出项目目录");
		return absolute;
	}

	private async git(cwd: string, args: string[]): Promise<string> {
		const result = await execute("git", args, {
			cwd,
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: MAX_BUFFER,
			timeout: 15_000,
		});
		return String(result.stdout);
	}
}

function empty(): Content {
	return { text: "", binary: false, truncated: false };
}

function decode(value: string | Buffer): Content {
	const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
	if (buffer.includes(0)) return { text: "", binary: true, truncated: false };
	return { text: buffer.toString("utf8"), binary: false, truncated: false };
}
