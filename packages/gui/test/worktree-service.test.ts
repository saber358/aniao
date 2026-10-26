import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type ManagedHost, WorkspaceService } from "../src/main/workspace-service.ts";
import { WorkspaceStore } from "../src/main/workspace-store.ts";
import { WorktreeService } from "../src/main/worktree-service.ts";
import { snapshot } from "./fixtures.ts";

const execute = promisify(execFile);
const service = new WorktreeService();
const roots: string[] = [];
const parents: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execute("git", args, { cwd, encoding: "utf8", windowsHide: true });
	return stdout;
}

async function repository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-gui-worktree-"));
	roots.push(root);
	await git(root, "init");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test");
	await writeFile(join(root, "README.md"), "test\n");
	await git(root, "add", "-A");
	await git(root, "commit", "-m", "initial");
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })));
});

describe("git worktrees", () => {
	/*
	 * ========================================================================
	 * 步骤2：验证新工作树打开和来源隔离
	 * ========================================================================
	 * 数据源：临时 Git 仓库、真实工作树、独立桌面索引。
	 * 操作：1) 新建后直接打开；2) 目录隔离且拒绝不相关目录。
	 */
	it("opens a newly created worktree and rejects an unrelated directory", async () => {
		const logger = console;
		logger.info("开始验证新工作树会话关联");
		const root = await repository();
		parents.push(join(dirname(root), `${basename(root)}.worktrees`));
		const tree = await service.create({ cwd: root, branch: "codex/open-test", baseRef: "HEAD" });
		const store = new WorkspaceStore(join(root, "state"), logger);
		const workspace = new WorkspaceService(
			store,
			(cwd): ManagedHost => {
				const current = { ...snapshot(), cwd, sessionId: cwd === root ? "source" : "worktree" };
				return {
					isClosed: false,
					getSnapshot: async () => current,
					listSessions: async () => [
						{ id: current.sessionId, title: "test", preview: "", messageCount: 0, updatedAt: 1, persisted: false },
					],
					dispatch: async () => {},
					subscribe: () => () => {},
					getForkDraft: async () => undefined,
					getImage: async () => "",
					prepareTransition: async () => {},
					renameSession: async () => {},
					close: async () => {},
				};
			},
			logger,
		);
		try {
			// 2.1 无需先用目录选择器登记工作树。
			await workspace.attach(root);
			await workspace.openWorkspace(tree.path);
			expect((await workspace.getSnapshot())?.sessionId).toBe("worktree");
			expect(await store.projects()).toContain(await realpath(tree.path));
			await writeFile(join(tree.path, "README.md"), "isolated edit\n");
			expect((await readFile(join(root, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe("test\n");
			// 2.2 任意未登记目录仍不允许通过该入口打开。
			await expect(workspace.openWorkspace(dirname(root))).rejects.toThrow("不是当前仓库的工作树");
		} finally {
			await workspace.close();
			logger.info("新工作树会话关联验证结束");
		}
	});
	it("lists the main worktree and creates an independent branch", async () => {
		const root = await repository();
		parents.push(join(dirname(root), `${basename(root)}.worktrees`));
		const initial = await service.list(root);
		expect(initial.some((worktree) => worktree.current)).toBe(true);
		const created = await service.create({ cwd: root, branch: "feature/test", baseRef: "HEAD" });
		expect(created.branch).toBe("feature/test");
		expect(created.path).not.toBe(root);
		expect((await readFile(join(created.path, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe("test\n");
		const list = await service.list(root);
		expect(list.filter((worktree) => worktree.branch === "feature/test")).toHaveLength(1);
		await expect(service.create({ cwd: root, branch: "feature/test", baseRef: "HEAD" })).rejects.toThrow();
	});

	it("refuses to remove dirty worktrees and removes clean ones without deleting the branch", async () => {
		const root = await repository();
		parents.push(join(dirname(root), `${basename(root)}.worktrees`));
		const created = await service.create({ cwd: root, branch: "feature/cleanup", baseRef: "HEAD" });
		await writeFile(join(created.path, "README.md"), "dirty\n");
		await expect(service.remove({ cwd: root, path: created.path, expectedHead: created.head })).rejects.toThrow();
		await git(created.path, "restore", "README.md");
		const remaining = await service.remove({ cwd: root, path: created.path, expectedHead: created.head });
		expect(remaining.some((worktree) => worktree.path === created.path)).toBe(false);
		expect(await git(root, "branch", "--list", "feature/cleanup")).toContain("feature/cleanup");
	});
});
