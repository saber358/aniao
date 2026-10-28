import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type ManagedHost, WorkspaceService } from "../src/main/workspace-service.ts";
import { WorkspaceStore } from "../src/main/workspace-store.ts";
import type { SessionSnapshot } from "../src/shared/protocol.ts";
import type { SessionSummary } from "../src/shared/workspace.ts";
import { FakeAgentPort, snapshot } from "./fixtures.ts";

const logger = { info: vi.fn() };
class Host extends FakeAgentPort implements ManagedHost {
	isClosed = false;
	declare current: SessionSnapshot;
	constructor(cwd: string, id: string) {
		super();
		this.current = { ...snapshot(), cwd, sessionId: id };
	}
	async getSnapshot() {
		return this.current;
	}
	async listSessions(): Promise<SessionSummary[]> {
		return [
			{
				id: this.current.sessionId,
				title: this.current.title,
				preview: "",
				messageCount: 0,
				updatedAt: Date.now(),
				persisted: false,
			},
		];
	}
	async getForkDraft() {
		return undefined;
	}
	async getImage() {
		return "";
	}
	async renameSession() {}
	async prepareTransition() {}
	async close() {
		this.isClosed = true;
	}
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "harness-archive-"));
	if (dirname(directory) !== tmpdir()) throw new Error("测试目录越界");
	const cwd = await realpath(directory);
	const store = new WorkspaceStore(join(directory, "state"), logger);
	const host = new Host(cwd, "running");
	const workspace = new WorkspaceService(store, () => host, logger);
	await workspace.attach(cwd);
	const old = Date.now() - 20 * 86400000;
	await store.rememberSessions(
		cwd,
		["old", "pinned", "running", "recent"].map((id) => ({
			id,
			title: id,
			preview: "",
			messageCount: 1,
			persisted: true,
			updatedAt: id === "recent" ? Date.now() : old,
		})),
	);
	await store.update(cwd, { sessionId: "pinned", pinned: true });
	return {
		directory,
		cwd,
		store,
		workspace,
		host,
		async close() {
			await workspace.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

/*
 * ========================================================================
 * 步骤1：验证自动归档与批量删除的实际边界
 * ========================================================================
 * 数据源：真实索引文件和可控宿主，不触碰用户历史。
 * 操作：1) 策略跨重启恢复；2) 任何运行或非归档目标阻止整批删除。
 */
describe("archive management", () => {
	it("archives only old unpinned idle sessions and remembers manual restoration", async () => {
		logger.info("开始验证自动归档保护");
		const test = await fixture();
		try {
			const before = (await test.store.allSessions()).map((entry) => entry.id);
			test.host.current.run.phase = "working";
			const archive = await test.workspace.saveArchivePolicy({ enabled: true, retentionDays: 7 });
			expect(archive.sessions.map((entry) => entry.id)).toEqual(["old"]);
			expect((await new WorkspaceStore(join(test.directory, "state"), logger).archivePolicy()).enabled).toBe(true);
			await test.workspace.restoreArchived({ sessionIds: ["old"] });
			await test.workspace.autoArchive();
			expect((await test.workspace.getArchiveSnapshot()).sessions).toHaveLength(0);
			expect((await test.store.allSessions()).map((entry) => entry.id)).toEqual(before);
		} finally {
			await test.close();
			logger.info("自动归档保护验证结束");
		}
	});
	it("restores archives across workspaces without switching the current session", async () => {
		logger.info("开始验证跨工作区归档恢复");
		const test = await fixture();
		try {
			const other = join(test.directory, "other");
			await mkdir(other);
			await test.store.remember(other, {
				id: "other",
				title: "其他项目",
				preview: "",
				messageCount: 0,
				persisted: false,
				updatedAt: 1,
				pinned: false,
				archived: true,
			});
			await test.store.setArchived(["old"], true);
			await test.workspace.restoreArchived({ sessionIds: ["old", "other"] });
			expect((await test.workspace.getArchiveSnapshot()).sessions).toHaveLength(0);
			expect((await test.workspace.getSnapshot())?.sessionId).toBe("running");
			await expect(test.workspace.restoreArchived({ sessionIds: ["old"] })).rejects.toThrow("不在归档");
		} finally {
			await test.close();
			logger.info("跨工作区归档恢复验证结束");
		}
	});
	it("checks every target before deleting and never permits nonarchived identities", async () => {
		logger.info("开始验证批量删除边界");
		const test = await fixture();
		const remove = vi.fn(async () => {});
		try {
			await test.store.setArchived(["old", "running"], true);
			test.host.current.run.phase = "working";
			await expect(test.workspace.deleteArchived({ sessionIds: ["old", "running"] }, remove)).rejects.toThrow(
				"仍在运行",
			);
			await expect(test.workspace.deleteArchived({ sessionIds: ["old", "recent"] }, remove)).rejects.toThrow(
				"不在归档",
			);
			await expect(test.workspace.deleteArchived({ sessionIds: ["unknown"] }, remove)).rejects.toThrow("不在归档");
			expect(remove).not.toHaveBeenCalled();
			expect(await test.store.findSession("old")).toBeDefined();
		} finally {
			await test.close();
			logger.info("批量删除边界验证结束");
		}
	});
	it("removes the selected history identity and retains metadata when a file operation fails", async () => {
		logger.info("开始验证删除持久化与失败恢复");
		const test = await fixture();
		try {
			await test.store.setArchived(["old"], true);
			await expect(
				test.workspace.deleteArchived({ sessionIds: ["old"] }, async () => {
					throw new Error("回收站不可用");
				}),
			).rejects.toThrow("回收站不可用");
			expect(await test.store.findSession("old")).toMatchObject({ archived: true });
			const remove = vi.fn(async () => {});
			await test.workspace.deleteArchived({ sessionIds: ["old"] }, remove);
			expect(remove).toHaveBeenCalledWith(test.cwd, "old");
			expect(await test.store.findSession("old")).toBeUndefined();
			expect((await test.workspace.getSnapshot())?.sessionId).toBe("running");
		} finally {
			await test.close();
			logger.info("删除持久化与失败恢复验证结束");
		}
	});
});
