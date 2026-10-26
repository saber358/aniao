import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitWorktree, WorktreeCreate, WorktreeRemove } from "../shared/git-worktree.ts";

const execute = promisify(execFile);
const MAX_BUFFER = 4 * 1024 * 1024;

/*
 * ========================================================================
 * 步骤1：管理 Git 工作树生命周期
 * ========================================================================
 * 数据源：当前仓库、已有 worktree 列表和用户提交的分支/起点。
 * 操作：
 *   1) 创建独立目录，已有分支不得被其他工作树占用
 *   2) 移除前核对 HEAD、未提交改动和忽略文件，不做自动清理
 */
export class WorktreeService {
	async list(cwd: string): Promise<GitWorktree[]> {
		const root = await this.repositoryRoot(cwd);
		return this.listFromRoot(root, cwd);
	}

	async create(request: WorktreeCreate): Promise<GitWorktree> {
		const root = await this.repositoryRoot(request.cwd);
		if (!request.branch || request.branch.startsWith("-") || request.branch.includes("\0"))
			throw new Error("分支名称无效");
		await this.git(root, ["check-ref-format", "--branch", request.branch]);
		if (!request.baseRef || request.baseRef.startsWith("-") || request.baseRef.includes("\0"))
			throw new Error("起点无效");
		await this.git(root, ["rev-parse", "--verify", `${request.baseRef}^{commit}`]);
		const worktrees = await this.listFromRoot(root, request.cwd);
		const existing = worktrees.find((worktree) => worktree.branch === request.branch);
		if (existing) throw new Error(`分支已被工作树占用：${existing.path}`);

		const parent = join(dirname(root), `${basename(root)}.worktrees`);
		await mkdir(parent, { recursive: true });
		const slug = request.branch
			.replace(/[^\p{L}\p{N}._-]+/gu, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80);
		let path = join(parent, slug || "worktree");
		for (let index = 2; ; index += 1) {
			try {
				await stat(path);
				path = join(parent, `${slug || "worktree"}-${index}`);
			} catch {
				break;
			}
		}

		const branchExists = await this.git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${request.branch}`])
			.then(() => true)
			.catch(() => false);
		const args = branchExists
			? ["worktree", "add", path, request.branch]
			: ["worktree", "add", "-b", request.branch, path, request.baseRef];
		await this.git(root, args);
		const created = (await this.listFromRoot(root, request.cwd)).find(
			(worktree) => resolve(worktree.path) === resolve(path),
		);
		if (!created) throw new Error("工作树创建后未出现在列表中");
		return created;
	}

	async remove(request: WorktreeRemove): Promise<GitWorktree[]> {
		const root = await this.repositoryRoot(request.cwd);
		const worktrees = await this.listFromRoot(root, request.cwd);
		const target = worktrees.find((worktree) => resolve(worktree.path) === resolve(request.path));
		if (!target) throw new Error("工作树不存在，请刷新后重试");
		if (resolve(target.path) === resolve(root)) throw new Error("不能移除主工作树");
		const head = (await this.git(target.path, ["rev-parse", "HEAD"])).trim();
		if (request.expectedHead && head !== request.expectedHead) throw new Error("工作树 HEAD 已变化，请刷新后重试");
		const status = (await this.git(target.path, ["status", "--porcelain", "--ignored"])).trim();
		if (status) throw new Error("工作树仍有未提交或忽略文件，不做自动清理");
		await this.git(root, ["worktree", "remove", target.path]);
		return this.listFromRoot(root, request.cwd);
	}

	private async listFromRoot(root: string, cwd: string): Promise<GitWorktree[]> {
		const output = await this.git(root, ["worktree", "list", "--porcelain"]);
		const current = await realpath(cwd);
		const worktrees: GitWorktree[] = [];
		let entry: Partial<GitWorktree> | undefined;
		const finish = () => {
			if (!entry?.path) return;
			worktrees.push({
				path: entry.path,
				head: entry.head ?? "",
				branch: entry.branch,
				detached: entry.detached ?? false,
				bare: entry.bare ?? false,
				current: resolve(entry.path) === resolve(current),
			});
			entry = undefined;
		};
		for (const line of output.split(/\r?\n/)) {
			if (line.startsWith("worktree ")) {
				finish();
				entry = { path: line.slice("worktree ".length) };
			} else if (!entry) {
			} else if (line.startsWith("HEAD ")) {
				entry.head = line.slice("HEAD ".length);
			} else if (line.startsWith("branch ")) {
				const ref = line.slice("branch ".length);
				entry.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
			} else if (line === "detached") {
				entry.detached = true;
			} else if (line === "bare") {
				entry.bare = true;
			} else if (line === "") {
				finish();
			}
		}
		finish();
		return worktrees;
	}

	private async repositoryRoot(cwd: string): Promise<string> {
		const directory = await realpath(cwd);
		const root = await this.git(directory, ["rev-parse", "--show-toplevel"]);
		return realpath(root.trim());
	}

	private async git(cwd: string, args: string[]): Promise<string> {
		const result = await execute("git", args, {
			cwd,
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: MAX_BUFFER,
			timeout: 30_000,
		});
		return String(result.stdout);
	}
}
