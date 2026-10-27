import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type ManagedHost, WorkspaceService } from "../src/main/workspace-service.ts";
import { WorkspaceStore } from "../src/main/workspace-store.ts";
import type { GoalReadRequest, GoalSnapshot } from "../src/shared/goals.ts";
import type { SessionSummary } from "../src/shared/workspace.ts";
import { FakeAgentPort, snapshot } from "./fixtures.ts";

const logger = { info: vi.fn() };
class GoalHost extends FakeAgentPort implements ManagedHost {
	isClosed = false;
	readGoals = vi.fn<NonNullable<ManagedHost["readGoals"]>>().mockResolvedValue({ goals: [], generatedAt: 1 });
	constructor(cwd: string, sessionId: string) {
		super();
		this.current = { ...snapshot(), cwd, sessionId };
	}
	async getSnapshot() {
		if (!this.current) throw new Error("测试会话缺失");
		return this.current;
	}
	async listSessions(): Promise<SessionSummary[]> {
		const value = await this.getSnapshot();
		return [{ id: value.sessionId, title: value.title, preview: "", updatedAt: 1, messageCount: 0, persisted: false }];
	}
	async getForkDraft() {
		return undefined;
	}
	async getImage(): Promise<string> {
		throw new Error("没有测试图片");
	}
	async prepareTransition() {}
	async renameSession() {}
	async close() {
		this.isClosed = true;
	}
}

/*
 * ========================================================================
 * 步骤1：校验主进程的目标查询身份和迟到响应
 * ========================================================================
 * 数据源：真实 WorkspaceService 与可控活动宿主。
 * 操作：1) 只接受当前项目/会话/代次；2) 更换宿主后旧读取必须失败。
 */
describe("workspace goal queries", () => {
	it("rejects foreign identities and a late result from the replaced host", async () => {
		logger.info("开始验证工作区目标隔离");
		const directory = await mkdtemp(join(tmpdir(), "goal-workspace-"));
		if (dirname(directory) !== tmpdir()) throw new Error("测试目录清理越界");
		const cwd = await realpath(directory);
		const source = new GoalHost(cwd, "source");
		const next = new GoalHost(cwd, "next");
		const factory = vi.fn().mockReturnValueOnce(source).mockReturnValueOnce(next);
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), factory, logger);
		let finish: (value: GoalSnapshot) => void = () => {};
		try {
			// 1.1 身份不匹配时，不向宿主发送任何读取。
			await workspace.attach(cwd);
			const request: GoalReadRequest = { cwd, sessionId: "source", generation: "host-1" };
			for (const invalid of [
				{ ...request, cwd: "C:/other" },
				{ ...request, sessionId: "other" },
				{ ...request, generation: "old" },
			])
				await expect(workspace.readGoals(invalid)).rejects.toThrow("会话已更换");
			expect(source.readGoals).not.toHaveBeenCalled();
			source.readGoals.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const pending = workspace.readGoals(request);
			await vi.waitFor(() => expect(source.readGoals).toHaveBeenCalledOnce());
			await workspace.attach(cwd, { type: "new" });
			finish({ goals: [], generatedAt: 2 });
			await expect(pending).rejects.toThrow("会话已更换");
			expect((await workspace.readGoals({ ...request, sessionId: "next" })).goals).toEqual([]);
		} finally {
			await workspace.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("工作区目标隔离验证结束");
		}
	});
});
