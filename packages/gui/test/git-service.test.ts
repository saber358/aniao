import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "../src/main/git-service.ts";

const execute = promisify(execFile);
const service = new GitService();
const directories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execute("git", args, { cwd, encoding: "utf8", windowsHide: true });
	return stdout;
}

async function repository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-gui-git-"));
	directories.push(root);
	await git(root, "init");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test");
	return root;
}

async function commit(root: string, message = "initial"): Promise<void> {
	await git(root, "add", "-A");
	await git(root, "commit", "-m", message);
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("git review", () => {
	it("rejects directories that are not repositories", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-gui-git-none-"));
		directories.push(root);
		await expect(service.status(root)).rejects.toThrow();
	});

	it("reads status with staged, unstaged, untracked, renamed, and spaced paths", async () => {
		const root = await repository();
		await writeFile(join(root, "a.txt"), "one\n");
		await writeFile(join(root, "both.txt"), "base\n");
		await writeFile(join(root, "中文 文件.txt"), "base\n");
		await commit(root);

		await writeFile(join(root, "a.txt"), "two\n");
		await git(root, "mv", "中文 文件.txt", "改名 文件.txt");
		await writeFile(join(root, "both.txt"), "staged\n");
		await git(root, "add", "both.txt");
		await writeFile(join(root, "both.txt"), "unstaged\n");
		await writeFile(join(root, "new file.txt"), "new\n");

		const status = await service.status(root);
		expect(status.branch).toBeTruthy();
		expect(status.ahead).toBe(0);
		expect(status.behind).toBe(0);
		const changed = status.files.find((file) => file.path === "a.txt");
		expect(changed).toMatchObject({ staged: false, unstaged: true, untracked: false });
		const both = status.files.find((file) => file.path === "both.txt");
		expect(both).toMatchObject({ staged: true, unstaged: true });
		const untracked = status.files.find((file) => file.path === "new file.txt");
		expect(untracked, "path with spaces should remain intact").toMatchObject({ untracked: true });
		const renamed = status.files.find((file) => file.path === "改名 文件.txt");
		expect(renamed).toMatchObject({ originalPath: "中文 文件.txt" });
	});

	it("returns staged and unstaged versions for diff", async () => {
		const root = await repository();
		await writeFile(join(root, "file.txt"), "one\n");
		await commit(root);
		await writeFile(join(root, "file.txt"), "two\n");
		await git(root, "add", "file.txt");
		await writeFile(join(root, "file.txt"), "three\n");

		const staged = await service.diff({ cwd: root, path: "file.txt", staged: true });
		expect(staged).toMatchObject({ path: "file.txt", original: "one\n", modified: "two\n", binary: false });
		const unstaged = await service.diff({ cwd: root, path: "file.txt", staged: false });
		expect(unstaged).toMatchObject({ original: "two\n", modified: "three\n" });
	});

	it("returns an empty original for untracked files and detects binary files", async () => {
		const root = await repository();
		await writeFile(join(root, "new.txt"), "fresh\n");
		await writeFile(join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
		const untracked = await service.diff({ cwd: root, path: "new.txt", staged: false });
		expect(untracked).toMatchObject({ original: "", modified: "fresh\n", binary: false });
		const binary = await service.diff({ cwd: root, path: "image.bin", staged: false });
		expect(binary.binary).toBe(true);
		expect(binary.modified).toBe("");
	});

	it("uses the original path for a staged rename", async () => {
		const root = await repository();
		await writeFile(join(root, "old.txt"), "content\n");
		await commit(root);
		await git(root, "mv", "old.txt", "new.txt");
		const diff = await service.diff({
			cwd: root,
			path: "new.txt",
			originalPath: "old.txt",
			staged: true,
		});
		expect(diff.original).toBe("content\n");
		expect(diff.modified).toBe("content\n");
	});

	it("stages, unstages, and discards a worktree change", async () => {
		const root = await repository();
		await writeFile(join(root, "file.txt"), "one\n");
		await commit(root);
		await writeFile(join(root, "file.txt"), "two\n");

		const initial = await service.status(root);
		expect(initial.head).toBeTruthy();
		const initialFile = initial.files.find((file) => file.path === "file.txt");
		if (!initialFile) throw new Error("missing initial status");
		const staged = await service.mutate({
			cwd: root,
			path: "file.txt",
			action: "stage",
			expectedHead: initial.head,
			expectedIndex: initialFile.index,
			expectedWorktree: initialFile.worktree,
			expectedVersion: (await service.diff({ cwd: root, path: "file.txt", staged: false })).version,
		});
		expect(staged.files.find((file) => file.path === "file.txt")).toMatchObject({
			staged: true,
			unstaged: false,
		});

		const stagedFile = staged.files.find((file) => file.path === "file.txt");
		if (!stagedFile) throw new Error("missing staged status");
		const unstaged = await service.mutate({
			cwd: root,
			path: "file.txt",
			action: "unstage",
			expectedHead: staged.head,
			expectedIndex: stagedFile.index,
			expectedWorktree: stagedFile.worktree,
			expectedVersion: (await service.diff({ cwd: root, path: "file.txt", staged: true })).version,
		});
		expect(unstaged.files.find((file) => file.path === "file.txt")).toMatchObject({
			staged: false,
			unstaged: true,
		});

		const unstagedFile = unstaged.files.find((file) => file.path === "file.txt");
		if (!unstagedFile) throw new Error("missing unstaged status");
		const discarded = await service.mutate({
			cwd: root,
			path: "file.txt",
			action: "discard",
			expectedHead: unstaged.head,
			expectedIndex: unstagedFile.index,
			expectedWorktree: unstagedFile.worktree,
			expectedVersion: (await service.diff({ cwd: root, path: "file.txt", staged: false })).version,
		});
		expect(discarded.files.find((file) => file.path === "file.txt")).toBeUndefined();
		expect((await readFile(join(root, "file.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("one\n");
	});

	it("rejects mutations from a stale HEAD", async () => {
		const root = await repository();
		await writeFile(join(root, "file.txt"), "one\n");
		await commit(root);
		await writeFile(join(root, "file.txt"), "two\n");
		const status = await service.status(root);
		const file = status.files.find((item) => item.path === "file.txt");
		if (!file) throw new Error("missing file status");
		const version = (await service.diff({ cwd: root, path: "file.txt", staged: false })).version;
		await commit(root, "external commit");
		await expect(
			service.mutate({
				cwd: root,
				path: "file.txt",
				action: "stage",
				expectedHead: status.head,
				expectedIndex: file.index,
				expectedWorktree: file.worktree,
				expectedVersion: version,
			}),
		).rejects.toThrow();
	});

	/*
	 * ========================================================================
	 * 步骤2：覆盖 Git 状态不变时的旧差异操作
	 * ========================================================================
	 * 数据源：独立临时仓库，不修改用户工作区。
	 * 操作：1) 查看后再次编辑；2) 旧暂存与还原请求必须拒绝。
	 */
	it.each(["stage", "discard"] as const)("rejects stale %s when the worktree status stays M", async (action) => {
		const logger = console;
		logger.info("开始验证旧内容保护");
		try {
			// 2.1 两次编辑保持同一 HEAD 和 M 状态。
			const root = await repository();
			await writeFile(join(root, "file.txt"), "baseline\n");
			await commit(root);
			await writeFile(join(root, "file.txt"), "viewed\n");
			const status = await service.status(root);
			const version = (await service.diff({ cwd: root, path: "file.txt", staged: false })).version;
			await writeFile(join(root, "file.txt"), "later edit\n");
			// 2.2 拒绝旧请求，保留后来编辑。
			await expect(
				service.mutate({
					cwd: root,
					path: "file.txt",
					action,
					expectedHead: status.head,
					expectedIndex: " ",
					expectedWorktree: "M",
					expectedVersion: version,
				}),
			).rejects.toThrow("内容已变化");
			expect(await readFile(join(root, "file.txt"), "utf8")).toBe("later edit\n");
		} finally {
			logger.info("旧内容保护验证结束");
		}
	});
});
