import { mkdir, mkdtemp, realpath, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ManagedHost, WorkspaceService } from "../src/main/workspace-service.ts";
import { WorkspaceStore } from "../src/main/workspace-store.ts";
import type { SessionSnapshot } from "../src/shared/protocol.ts";
import type { SessionSummary } from "../src/shared/workspace.ts";
import { FakeAgentPort, snapshot } from "./fixtures.ts";
import { pngFixture } from "./image-fixture.ts";

const logger = { info: vi.fn() };
const directories: string[] = [];
class Host extends FakeAgentPort implements ManagedHost {
	isClosed = false;
	declare current: SessionSnapshot;
	constructor(cwd: string, id: string) {
		super();
		this.current = { ...snapshot(), cwd, sessionId: id };
	}
	async getSnapshot(): Promise<SessionSnapshot> {
		return this.current;
	}
	async listSessions(): Promise<SessionSummary[]> {
		return [
			{
				id: this.current.sessionId,
				title: this.current.title,
				preview: "",
				messageCount: 0,
				updatedAt: 1,
				persisted: false,
			},
		];
	}
	async renameSession(_sessionId: string, title: string): Promise<void> {
		this.current.title = title;
	}
	async getForkDraft(): Promise<string | undefined> {
		return undefined;
	}
	async prepareTransition(): Promise<void> {}
	async getImage(): Promise<string> {
		throw new Error("Image fixture unavailable");
	}
	async close(): Promise<void> {
		this.isClosed = true;
	}
}

/*
 * ========================================================================
 * 步骤1：验证工作区切换和历史权限边界
 * ========================================================================
 * 数据源：可控宿主与真实桌面索引文件。
 * 操作：
 *   1) 失败不关闭旧宿主，忙碌时不切换
 *   2) 未发送会话保留身份和草稿，未知 ID 无法读取
 */
describe("WorkspaceService", () => {
	it("does not create a replacement after closing during an extension transition", async () => {
		logger.info("开始验证退出取消待处理切换");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const host = new Host(await realpath(directory), "current");
		const factory = vi.fn(() => host);
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), factory, logger);
		await workspace.attach(directory);
		let release = () => {};
		let enter = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		vi.spyOn(host, "prepareTransition").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
					enter();
				}),
		);
		try {
			const changing = expect(workspace.newSession()).rejects.toThrow("工作区已关闭");
			await entered;
			await workspace.close();
			release();
			await changing;
			expect(factory).toHaveBeenCalledTimes(1);
			expect(host.isClosed).toBe(true);
		} finally {
			release();
			await workspace.close();
			logger.info("退出取消待处理切换验证完成");
		}
	});
	it("keeps the current host when an extension vetoes a switch and permits dialog replies during the hook", async () => {
		logger.info("开始验证扩展切换取消");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const host = new Host(await realpath(directory), "current");
		const factory = vi.fn(() => host);
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), factory, logger);
		await workspace.attach(directory);
		vi.spyOn(host, "prepareTransition").mockImplementationOnce(async () => {
			await workspace.dispatch({
				requestId: "reply",
				sessionId: "current",
				generation: host.current.generation,
				command: { type: "reply", reply: { id: crypto.randomUUID(), cancelled: true } },
			});
			throw new Error("扩展已取消会话切换");
		});
		try {
			await expect(workspace.newSession()).rejects.toThrow("扩展已取消");
			expect(factory).toHaveBeenCalledTimes(1);
			expect(host.isClosed).toBe(false);
			expect(host.commands).toHaveLength(1);
			expect((await workspace.getSnapshot())?.sessionId).toBe("current");
		} finally {
			await workspace.close();
			logger.info("扩展切换取消验证完成");
		}
	});
	it("supersedes file queries and rejects inactive or stale search identities", async () => {
		logger.info("开始验证文件查询身份与取消");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		await writeFile(join(directory, "source.ts"), "fixture");
		const host = new Host(await realpath(directory), "current");
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		await workspace.attach(directory);
		const input = { sessionId: "current", generation: host.current.generation, query: "source" };
		try {
			// 5.1 新查询先取消上一轮，旧查询不能占用新请求的取消句柄。
			const first = expect(workspace.searchProjectFiles(input)).rejects.toThrow();
			expect(await workspace.searchProjectFiles(input)).toEqual({ paths: ["source.ts"], incomplete: false });
			await first;
			await expect(workspace.searchProjectFiles({ ...input, generation: "old" })).rejects.toThrow("会话已更换");
			host.current.run.phase = "working";
			await expect(workspace.searchProjectFiles(input)).rejects.toThrow("停止当前任务");
			host.current.run.phase = "idle";
			const read = vi.spyOn(host, "getSnapshot");
			read
				.mockResolvedValueOnce(structuredClone(host.current))
				.mockResolvedValueOnce({ ...host.current, generation: "next" });
			await expect(workspace.searchProjectFiles(input)).rejects.toThrow("状态已变化");
			read.mockRestore();
			const closing = expect(workspace.searchProjectFiles(input)).rejects.toThrow();
			await workspace.close();
			await closing;
		} finally {
			await workspace.close();
			logger.info("文件查询身份与取消验证完成");
		}
	});

	it("revalidates search selections after deletion or replacement with an escaping link", async () => {
		logger.info("开始验证文件查询选择重检");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const root = join(directory, "project");
		const outside = join(directory, "outside");
		await mkdir(join(root, "src"), { recursive: true });
		await mkdir(outside);
		await writeFile(join(root, "src", "source.ts"), "fixture");
		await writeFile(join(outside, "source.ts"), "secret");
		const host = new Host(await realpath(root), "current");
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		await workspace.attach(root);
		const selection = { sessionId: "current", generation: host.current.generation };
		try {
			const result = await workspace.searchProjectFiles({ ...selection, query: "source" });
			expect(await workspace.validateProjectFiles({ ...selection, paths: result.paths })).toEqual(["src/source.ts"]);
			await unlink(join(root, "src", "source.ts"));
			await expect(workspace.validateProjectFiles({ ...selection, paths: result.paths })).rejects.toThrow("已失效");
			await rmdir(join(root, "src"));
			await symlink(outside, join(root, "src"), "junction");
			await expect(workspace.validateProjectFiles({ ...selection, paths: result.paths })).rejects.toThrow("当前项目");
			await expect(workspace.validateProjectFiles({ ...selection, paths: ["../outside/source.ts"] })).rejects.toThrow();
			await expect(
				workspace.validateProjectFiles({ ...selection, generation: "old", paths: result.paths }),
			).rejects.toThrow("会话已更换");
			expect((await workspace.getSnapshot())?.sessionId).toBe("current");
		} finally {
			await workspace.close();
			logger.info("文件查询选择重检验证完成");
		}
	});
	it("gates image selection by model capability and scopes previews to the active session", async () => {
		logger.info("开始验证桌面图片权限边界");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const host = new Host(await realpath(directory), "current");
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		await workspace.attach(directory);
		const selection = { sessionId: "current", generation: host.current.generation };
		const choose = vi.fn(async () => []);
		try {
			await expect(workspace.selectImages(selection, choose, (bytes) => bytes)).rejects.toThrow("不支持图片");
			await expect(workspace.importImages({ ...selection, data: [pngFixture] }, (bytes) => bytes)).rejects.toThrow(
				"不支持图片",
			);
			expect(choose).not.toHaveBeenCalled();
			const model = { key: "test/image", provider: "test", name: "Image", available: true, supportsImages: true };
			host.current.configuration = { ...host.current.configuration, model, models: [model] };
			const file = join(directory, "图片.png");
			await writeFile(file, Buffer.from(pngFixture, "base64"));
			const [imageId] = await workspace.selectImages(
				selection,
				async () => [file],
				(bytes) => bytes,
			);
			expect(await workspace.readImage({ ...selection, imageId, source: "draft" })).toBe(
				`data:image/png;base64,${pngFixture}`,
			);
			await expect(workspace.readImage({ ...selection, sessionId: "other", imageId, source: "draft" })).rejects.toThrow(
				"当前会话",
			);
			await expect(
				workspace.readImage({ ...selection, generation: "old", imageId, source: "message" }),
			).rejects.toThrow("当前会话");
		} finally {
			await workspace.close();
			logger.info("桌面图片权限边界验证完成");
		}
	});
	it("binds transferred images to idle or working hosts and rejects stale or interrupted imports", async () => {
		logger.info("开始验证图片内容导入身份");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const host = new Host(await realpath(directory), "current");
		const model = { key: "test/image", provider: "test", name: "Image", available: true, supportsImages: true };
		host.current.configuration = { ...host.current.configuration, model, models: [model] };
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		await workspace.attach(directory);
		const input = { sessionId: "current", generation: host.current.generation, data: [pngFixture] };
		try {
			// 3.1 传入内容与原生选择共用主进程归属检查，Renderer 不能选择存储目录。
			await expect(workspace.importImages({ ...input, generation: "old" }, (bytes) => bytes)).rejects.toThrow("已更换");
			host.current.run.phase = "working";
			expect(await workspace.importImages(input, (bytes) => bytes)).toHaveLength(1);
			host.current.run.phase = "retrying";
			await expect(workspace.importImages(input, (bytes) => bytes)).rejects.toThrow("停止当前任务");
			host.current.run.phase = "idle";
			const [imageId] = await workspace.importImages(input, (bytes) => bytes);
			expect(await workspace.readImage({ ...input, imageId, source: "draft" })).toBe(
				`data:image/png;base64,${pngFixture}`,
			);
			host.isClosed = true;
			await expect(workspace.importImages(input, (bytes) => bytes)).rejects.toThrow("连接项目");
		} finally {
			await workspace.close();
			logger.info("图片内容导入身份验证完成");
		}
	});

	it("holds selection exclusion until transferred image persistence completes", async () => {
		logger.info("开始验证图片内容导入互斥");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const host = new Host(await realpath(directory), "current");
		const model = { key: "test/image", provider: "test", name: "Image", available: true, supportsImages: true };
		host.current.configuration = { ...host.current.configuration, model, models: [model] };
		const store = new WorkspaceStore(join(directory, "state"), logger);
		const workspace = new WorkspaceService(store, () => host, logger);
		await workspace.attach(directory);
		let finish: (ids: string[]) => void = () => {};
		let entered = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		vi.spyOn(store.images, "importData").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
					entered();
				}),
		);
		const input = { sessionId: "current", generation: host.current.generation, data: [pngFixture] };
		try {
			// 3.2 存储等待期间阻止发送与切换，返回前仍复查宿主代次。
			const importing = workspace.importImages(input, (bytes) => bytes);
			await waiting;
			await expect(workspace.newSession()).rejects.toThrow("等待当前操作");
			await expect(
				workspace.dispatch({ requestId: "r", ...input, command: { type: "prompt", text: "不能交错" } }),
			).rejects.toThrow("连接项目");
			await expect(workspace.importImages(input, (bytes) => bytes)).rejects.toThrow("等待当前操作");
			host.current.generation = "next";
			finish([]);
			await expect(importing).rejects.toThrow("状态已变化");
			host.current.generation = input.generation;
			expect(await workspace.importImages(input, (bytes) => bytes)).toHaveLength(1);
		} finally {
			await workspace.close();
			logger.info("图片内容导入互斥验证完成");
		}
	});
	afterEach(async () => {
		for (const directory of directories.splice(0)) {
			if (!resolve(directory).startsWith(resolve(tmpdir()))) throw new Error("Unexpected temporary directory");
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("keeps unsent sessions selectable with separate drafts and restores the active identity", async () => {
		logger.info("开始验证未发送会话恢复");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const cwd = await realpath(directory);
		let counter = 0;
		const store = new WorkspaceStore(join(directory, "state"), logger);
		const factory = vi.fn(
			(path, target) => new Host(path, target.type === "session" ? target.id : `session-${++counter}`),
		);
		const workspace = new WorkspaceService(store, factory, logger);
		await workspace.attach(cwd);
		await workspace.saveDraft({ sessionId: "session-1", revision: 0, text: "第一份草稿" });
		await workspace.newSession();
		await workspace.saveDraft({ sessionId: "session-2", revision: 0, text: "第二份草稿" });
		expect((await workspace.getLibrary())?.sessions.map((item) => item.id).sort()).toEqual(["session-1", "session-2"]);
		await workspace.openSession("session-1");
		expect(await workspace.loadDraft("session-1")).toEqual({ text: "第一份草稿", revision: 1 });
		await expect(workspace.loadDraft("session-2")).rejects.toThrow("当前会话");
		await expect(workspace.openSession("unknown")).rejects.toThrow("当前项目");
		await workspace.updateSession({ sessionId: "session-1", pinned: true, archived: true });
		await workspace.close();
		const restored = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), factory, logger);
		await restored.restore();
		expect((await restored.getSnapshot())?.sessionId).toBe("session-1");
		expect((await restored.getLibrary())?.sessions.find((item) => item.id === "session-1")).toMatchObject({
			pinned: true,
			archived: true,
		});
		await restored.close();
		logger.info("未发送会话恢复验证完成");
	});

	it("preserves the existing host if the replacement fails and rejects switching while running", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const current = new Host(await realpath(directory), "current");
		const broken = new Host(current.current.cwd, "broken");
		vi.spyOn(broken, "getSnapshot").mockRejectedValue(new Error("startup failed"));
		const factory = vi.fn().mockReturnValueOnce(current).mockReturnValueOnce(broken);
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), factory, logger);
		await workspace.attach(directory);
		await expect(workspace.newSession()).rejects.toThrow("startup failed");
		expect(current.isClosed).toBe(false);
		expect(broken.isClosed).toBe(true);
		expect((await workspace.getSnapshot())?.sessionId).toBe("current");
		current.current.run.phase = "working";
		await expect(workspace.newSession()).rejects.toThrow("停止当前任务");
		expect(factory).toHaveBeenCalledTimes(2);
		await workspace.close();
	});

	it("rejects dispatch while session organization is in progress", async () => {
		logger.info("开始验证会话组织互斥");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const host = new Host(await realpath(directory), "current");
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		await workspace.attach(directory);
		let release = () => {};
		let entered = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		vi.spyOn(host, "renameSession").mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
					entered();
				}),
		);
		const updating = workspace.updateSession({ sessionId: "current", title: "新名称" });
		await waiting;
		await expect(
			workspace.dispatch({
				requestId: "request",
				sessionId: "current",
				generation: "host-1",
				command: { type: "prompt", text: "任务" },
			}),
		).rejects.toThrow("连接项目");
		release();
		await updating;
		await workspace.close();
		logger.info("会话组织互斥验证完成");
	});

	it("rejects a historical selection whose project changed while the list was loading", async () => {
		logger.info("开始验证迟到历史选择");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const cwd = await realpath(directory);
		const first = new Host(cwd, "first");
		const second = new Host(cwd, "second");
		const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), factory, logger);
		await workspace.attach(cwd);
		let release = () => {};
		let entered = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const list = first.listSessions.bind(first);
		vi.spyOn(first, "listSessions").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => {
						void list().then(resolve);
					};
					entered();
				}),
		);
		const opening = workspace.openSession("first");
		const rejected = expect(opening).rejects.toThrow("工作区已切换");
		await waiting;
		await workspace.attach(cwd, { type: "new" });
		release();
		await rejected;
		expect((await workspace.getSnapshot())?.sessionId).toBe("second");
		expect(factory).toHaveBeenCalledTimes(2);
		await workspace.close();
		logger.info("迟到历史选择验证完成");
	});

	it("saves a fork draft before replacing the host and preserves the source draft and queue", async () => {
		logger.info("开始验证分支保存顺序");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const cwd = await realpath(directory);
		const source = new Host(cwd, "source");
		source.current.messages = [{ id: "user-2", role: "user", blocks: [], forkEntryId: "native-entry" }];
		source.current.queue.recovery.followUp = [{ text: "留在来源会话的队列" }];
		const branch = new Host(cwd, "branch");
		vi.spyOn(branch, "getForkDraft").mockResolvedValue("分支输入");
		const summary = (await branch.listSessions())[0];
		vi.spyOn(branch, "listSessions").mockResolvedValue([{ ...summary, parentId: "source", persisted: true }]);
		const factory = vi.fn().mockReturnValueOnce(source).mockReturnValueOnce(branch);
		const store = new WorkspaceStore(join(directory, "state"), logger);
		const workspace = new WorkspaceService(store, factory, logger);
		await workspace.attach(cwd);
		await workspace.saveDraft({ sessionId: "source", text: "原草稿", revision: 0 });
		vi.spyOn(source, "close").mockImplementationOnce(async () => {
			expect(await store.loadDraft(cwd, "branch")).toEqual({ text: "分支输入", revision: 1 });
			source.isClosed = true;
		});
		try {
			await workspace.forkSession({
				sessionId: "source",
				generation: source.current.generation,
				entryId: "native-entry",
			});
			expect((await workspace.getSnapshot())?.sessionId).toBe("branch");
			expect(await workspace.loadDraft("branch")).toEqual({ text: "分支输入", revision: 1 });
			expect(await store.loadDraft(cwd, "source")).toEqual({ text: "原草稿", revision: 1 });
			expect(source.current.queue.recovery.followUp).toEqual([{ text: "留在来源会话的队列" }]);
			expect(factory.mock.calls[1][1]).toEqual({ type: "fork", sourceId: "source", entryId: "native-entry" });
		} finally {
			await workspace.close();
			logger.info("分支保存顺序验证完成");
		}
	});

	it("rejects invalid fork selections and retains the source when draft persistence fails", async () => {
		logger.info("开始验证分支边界与失败回退");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const cwd = await realpath(directory);
		const source = new Host(cwd, "source");
		source.current.messages = [{ id: "user-2", role: "user", blocks: [], forkEntryId: "native-entry" }];
		const branch = new Host(cwd, "branch");
		vi.spyOn(branch, "getForkDraft").mockResolvedValue("分支输入");
		const summary = (await branch.listSessions())[0];
		vi.spyOn(branch, "listSessions").mockResolvedValue([{ ...summary, parentId: "source", persisted: true }]);
		const factory = vi.fn().mockReturnValueOnce(source).mockReturnValueOnce(branch);
		const store = new WorkspaceStore(join(directory, "state"), logger);
		const workspace = new WorkspaceService(store, factory, logger);
		await workspace.attach(cwd);
		const selection = { sessionId: "source", generation: source.current.generation, entryId: "native-entry" };
		try {
			await expect(workspace.forkSession({ ...selection, generation: "old-generation" })).rejects.toThrow("会话已更换");
			await expect(workspace.forkSession({ ...selection, entryId: "display-id" })).rejects.toThrow("暂不可分支");
			source.current.run.phase = "working";
			await expect(workspace.forkSession(selection)).rejects.toThrow("停止当前任务");
			source.current.run.phase = "idle";
			expect(factory).toHaveBeenCalledTimes(1);
			vi.spyOn(store, "saveDraft").mockRejectedValueOnce(new Error("disk full"));
			await expect(workspace.forkSession(selection)).rejects.toThrow("disk full");
			expect((await workspace.getSnapshot())?.sessionId).toBe("source");
			expect((await store.active())?.id).toBe("source");
			expect(source.isClosed).toBe(false);
			expect(branch.isClosed).toBe(true);
		} finally {
			await workspace.close();
			logger.info("分支边界与失败回退验证完成");
		}
	});

	it("keeps the source active when the fork index cannot be committed", async () => {
		logger.info("开始验证分支索引失败回退");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const cwd = await realpath(directory);
		const source = new Host(cwd, "source");
		source.current.messages = [{ id: "u", role: "user", blocks: [], forkEntryId: "native-entry" }];
		const branch = new Host(cwd, "branch");
		vi.spyOn(branch, "getForkDraft").mockResolvedValue("新草稿");
		const summary = (await branch.listSessions())[0];
		vi.spyOn(branch, "listSessions").mockResolvedValue([{ ...summary, parentId: "source", persisted: true }]);
		const factory = vi.fn().mockReturnValueOnce(source).mockReturnValueOnce(branch);
		const store = new WorkspaceStore(join(directory, "state"), logger);
		const workspace = new WorkspaceService(store, factory, logger);
		await workspace.attach(cwd);
		const remember = store.remember.bind(store);
		vi.spyOn(store, "remember").mockImplementation(async (path, session, active) => {
			if (session.id === "branch") throw new Error("index unavailable");
			await remember(path, session, active);
		});
		try {
			await expect(
				workspace.forkSession({
					sessionId: "source",
					generation: source.current.generation,
					entryId: "native-entry",
				}),
			).rejects.toThrow("index unavailable");
			expect((await workspace.getSnapshot())?.sessionId).toBe("source");
			expect((await store.active())?.id).toBe("source");
			expect(await store.loadDraft(cwd, "branch")).toEqual({ text: "新草稿", revision: 1 });
			expect(source.isClosed).toBe(false);
			expect(branch.isClosed).toBe(true);
		} finally {
			await workspace.close();
			logger.info("分支索引失败回退验证完成");
		}
	});

	/*
	 * ========================================================================
	 * 步骤2：验证文件选择互斥和迟到结果
	 * ========================================================================
	 * 数据源：可暂停的原生选择回调和可变宿主状态。
	 * 操作：
	 *   1) 选择期间不能发送、切换或重复选择，失败后释放互斥
	 *   2) 旧身份、运行中和断连结果不返回给输入草稿
	 */
	it("locks commands and session changes until project file selection completes", async () => {
		logger.info("开始验证文件选择互斥");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const cwd = await realpath(directory);
		await writeFile(join(cwd, "文件.txt"), "fixture");
		const host = new Host(cwd, "current");
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		await workspace.attach(cwd);
		let finish: (paths: string[]) => void = () => {};
		let entered = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const selection = { sessionId: "current", generation: host.current.generation };
		try {
			// 2.1 对话框尚未返回时，所有活动会话变更都受同一互斥约束。
			const choosing = workspace.selectProjectFiles(selection, (directory) => {
				expect(directory).toBe(cwd);
				return new Promise((resolve) => {
					finish = resolve;
					entered();
				});
			});
			await waiting;
			await expect(workspace.newSession()).rejects.toThrow("等待当前操作");
			await expect(workspace.selectProjectFiles(selection, async () => [])).rejects.toThrow("等待当前操作");
			await expect(
				workspace.dispatch({ requestId: "request", ...selection, command: { type: "prompt", text: "不能交错" } }),
			).rejects.toThrow("连接项目");
			finish([join(cwd, "文件.txt")]);
			expect(await choosing).toEqual(["文件.txt"]);
			expect(await workspace.selectProjectFiles(selection, async () => [])).toEqual([]);
			await expect(
				workspace.selectProjectFiles(selection, async () => {
					throw new Error("dialog unavailable");
				}),
			).rejects.toThrow("dialog unavailable");
			expect(await workspace.selectProjectFiles(selection, async () => [])).toEqual([]);
		} finally {
			await workspace.close();
			logger.info("文件选择互斥验证完成");
		}
	});

	it("rejects stale identities, active runs and file results from a changed or closed host", async () => {
		logger.info("开始验证文件选择状态边界");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(directory);
		const host = new Host(await realpath(directory), "current");
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), () => host, logger);
		await workspace.attach(directory);
		const selection = { sessionId: "current", generation: host.current.generation };
		const choose = vi.fn(async () => []);
		try {
			// 2.2 选择前先拒绝过期状态；选择后再次核对，不能只信任首次快照。
			await expect(workspace.selectProjectFiles({ ...selection, generation: "old" }, choose)).rejects.toThrow(
				"会话已更换",
			);
			host.current.run.phase = "working";
			await expect(workspace.selectProjectFiles(selection, choose)).rejects.toThrow("停止当前任务");
			expect(choose).not.toHaveBeenCalled();
			host.current.run.phase = "idle";
			await expect(
				workspace.selectProjectFiles(selection, async () => {
					host.current = { ...host.current, generation: "next" };
					return [];
				}),
			).rejects.toThrow("会话状态已变化");
			host.current.generation = selection.generation;
			await expect(
				workspace.selectProjectFiles(selection, async () => {
					host.isClosed = true;
					return [];
				}),
			).rejects.toThrow("会话状态已变化");
			await expect(workspace.selectProjectFiles(selection, choose)).rejects.toThrow("连接项目");
		} finally {
			await workspace.close();
			logger.info("文件选择状态边界验证完成");
		}
	});

	it("groups sessions by workspace and opens a historical session from another project", async () => {
		const firstDirectory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		const secondDirectory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(firstDirectory, secondDirectory);
		const firstCwd = await realpath(firstDirectory);
		const secondCwd = await realpath(secondDirectory);
		const first = new Host(firstCwd, "first");
		const second = new Host(secondCwd, "second");
		const restored = new Host(firstCwd, "first");
		const workspace = new WorkspaceService(
			new WorkspaceStore(join(firstDirectory, "state"), logger),
			vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(restored),
			logger,
		);
		await workspace.attach(firstDirectory);
		await workspace.attach(secondDirectory);
		const projects = await workspace.getProjects();
		expect(projects.map((project) => project.cwd)).toEqual([secondCwd, firstCwd]);
		expect(projects[1]?.sessions.map((session) => session.id)).toEqual(["first"]);
		await workspace.openSession("first");
		expect((await workspace.getSnapshot())?.cwd).toBe(firstCwd);
		expect((await workspace.getSnapshot())?.sessionId).toBe("first");
		await workspace.close();
	});

	it("renames and removes a workspace and creates a session in another", async () => {
		const firstDirectory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		const secondDirectory = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
		directories.push(firstDirectory, secondDirectory);
		const firstCwd = await realpath(firstDirectory);
		const secondCwd = await realpath(secondDirectory);
		const first = new Host(firstCwd, "first");
		const second = new Host(secondCwd, "second");
		const created = new Host(firstCwd, "new");
		const workspace = new WorkspaceService(
			new WorkspaceStore(join(firstDirectory, "state"), logger),
			vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(created),
			logger,
		);
		await workspace.attach(firstDirectory);
		await workspace.attach(secondDirectory);
		await workspace.renameWorkspace(secondCwd, "第二个工作区");
		expect((await workspace.getProjects()).find((project) => project.cwd === secondCwd)?.name).toBe("第二个工作区");
		await workspace.removeWorkspace(secondCwd);
		expect(await workspace.getSnapshot()).toBeNull();
		expect((await workspace.getProjects()).map((project) => project.cwd)).toEqual([firstCwd]);
		await workspace.newSessionAt(firstCwd);
		expect((await workspace.getSnapshot())?.cwd).toBe(firstCwd);
		expect((await workspace.getSnapshot())?.sessionId).toBe("new");
		await workspace.close();
	});
});
