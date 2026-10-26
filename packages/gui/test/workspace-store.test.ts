import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "../src/main/workspace-store.ts";

const logger = { info: vi.fn() };
const directories: string[] = [];
const session = {
	id: "session-1",
	title: "中文草稿",
	preview: "",
	updatedAt: 1,
	messageCount: 0,
	persisted: false,
	pinned: false,
	archived: false,
};

/*
 * ========================================================================
 * 步骤1：验证持久化修订与原子替换
 * ========================================================================
 * 数据源：每个用例独立的临时目录，不读取用户数据。
 * 操作：
 *   1) 重建 Store 后验证偏好和草稿可恢复
 *   2) 拒绝旧修订，损坏文件不被空内容覆盖
 */
describe("WorkspaceStore", () => {
	afterEach(async () => {
		for (const directory of directories.splice(0)) {
			if (!resolve(directory).startsWith(resolve(tmpdir()))) throw new Error("Unexpected temporary directory");
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("persists session organization and drafts independently across restarts", async () => {
		logger.info("开始验证工作区恢复");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-store-"));
		directories.push(directory);
		const store = new WorkspaceStore(directory, logger);
		await store.remember("C:/中文项目", session, true);
		await store.update("C:/中文项目", { sessionId: session.id, pinned: true, archived: true });
		await store.saveDraft("C:/中文项目", { sessionId: session.id, text: "未发送的中文\n第二行", revision: 0 });
		const restored = new WorkspaceStore(directory, logger);
		expect(await restored.active()).toEqual({ cwd: "C:/中文项目", id: session.id });
		expect(await restored.sessions("C:/中文项目")).toEqual([{ ...session, pinned: true, archived: true }]);
		expect(await restored.sessions("C:/另一个项目")).toEqual([]);
		expect(await restored.loadDraft("C:/中文项目", session.id)).toEqual({
			text: "未发送的中文\n第二行",
			revision: 1,
		});
		expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
		expect(await readFile(join(directory, "index.json"), "utf8")).not.toContain("未发送的中文");
		logger.info("工作区恢复验证完成");
	});

	it("groups sessions by workspace and keeps recent summaries", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-store-"));
		directories.push(directory);
		const store = new WorkspaceStore(directory, logger);
		await store.rememberProject("C:/项目一");
		await store.rememberProject("C:/项目二");
		await store.rememberSessions("C:/项目一", [
			{ ...session, id: "a1", updatedAt: 2 },
			{ ...session, id: "a2", updatedAt: 1 },
		]);
		await store.remember("C:/项目一", { ...session, id: "a1" }, true);
		await store.update("C:/项目一", { sessionId: "a1", pinned: true });
		expect(await store.projects()).toEqual(["C:/项目一", "C:/项目二"]);
		expect((await store.sessions("C:/项目一")).map((item) => item.id).sort()).toEqual(["a1", "a2"]);
		expect(await store.findSession("a2")).toMatchObject({ cwd: "C:/项目一", id: "a2" });
		const restored = new WorkspaceStore(directory, logger);
		expect(await restored.projects()).toEqual(["C:/项目一", "C:/项目二"]);
		expect(await restored.findSession("a1")).toMatchObject({ pinned: true, cwd: "C:/项目一" });
	});

	it("renames and removes workspace metadata without touching other projects", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-store-"));
		directories.push(directory);
		const store = new WorkspaceStore(directory, logger);
		await store.rememberProject("C:/项目一");
		await store.rememberProject("C:/项目二");
		await store.rememberSessions("C:/项目一", [{ ...session, id: "a1", updatedAt: 2 }]);
		await store.remember("C:/项目一", { ...session, id: "a1" }, true);
		await store.renameProject("C:/项目一", "新名字");
		expect(await store.projectName("C:/项目一")).toBe("新名字");
		await store.removeProject("C:/项目一");
		expect(await store.projects()).toEqual(["C:/项目二"]);
		expect(await store.sessions("C:/项目一")).toEqual([]);
		expect(await store.active()).toBeNull();
		expect(await store.findSession("a1")).toBeUndefined();
		const restored = new WorkspaceStore(directory, logger);
		expect(await restored.projects()).toEqual(["C:/项目二"]);
		expect(await restored.projectName("C:/项目一")).toBeUndefined();
	});

	it("serializes concurrent writes and rejects stale revisions without poisoning future writes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-store-"));
		directories.push(directory);
		const store = new WorkspaceStore(directory, logger);
		const first = store.saveDraft("cwd", { sessionId: "s", revision: 0, text: "first" });
		const stale = expect(store.saveDraft("cwd", { sessionId: "s", revision: 0, text: "stale" })).rejects.toThrow(
			"其他界面",
		);
		await first;
		await stale;
		expect(await store.loadDraft("cwd", "s")).toEqual({ text: "first", revision: 1 });
		await store.saveDraft("cwd", { sessionId: "s", revision: 1, text: "latest" });
		expect(await store.loadDraft("cwd", "s")).toEqual({ text: "latest", revision: 2 });
	});

	it("does not overwrite a malformed workspace index", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-store-"));
		directories.push(directory);
		await writeFile(join(directory, "index.json"), "{broken", "utf8");
		const store = new WorkspaceStore(directory, logger);
		await expect(store.remember("cwd", session)).rejects.toThrow("索引无法读取");
		expect(await readFile(join(directory, "index.json"), "utf8")).toBe("{broken");
	});

	it("preserves a malformed draft instead of replacing it with new input", async () => {
		logger.info("开始验证损坏草稿保护");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-store-"));
		directories.push(directory);
		const store = new WorkspaceStore(directory, logger);
		await store.saveDraft("cwd", { sessionId: "s", revision: 0, text: "原文" });
		const draft = (await readdir(directory)).find((name) => name.startsWith("draft-"));
		if (!draft) throw new Error("Draft fixture missing");
		const path = join(directory, draft);
		await writeFile(path, "{broken", "utf8");
		await expect(store.loadDraft("cwd", "s")).rejects.toThrow("草稿无法读取");
		await expect(store.saveDraft("cwd", { sessionId: "s", revision: 1, text: "新输入" })).rejects.toThrow(
			"草稿无法读取",
		);
		expect(await readFile(path, "utf8")).toBe("{broken");
		logger.info("损坏草稿保护验证完成");
	});
});
