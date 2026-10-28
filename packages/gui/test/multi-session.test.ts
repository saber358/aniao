import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionControllers } from "../src/domain/session-controllers.ts";
import { type ManagedHost, WorkspaceService } from "../src/main/workspace-service.ts";
import { WorkspaceStore } from "../src/main/workspace-store.ts";
import type { PortNotification, SessionEvent, SessionSnapshot } from "../src/shared/protocol.ts";
import type { SessionSummary } from "../src/shared/workspace.ts";
import { FakeAgentPort, snapshot } from "./fixtures.ts";

const logger = { info: vi.fn() };

class Host extends FakeAgentPort implements ManagedHost {
	isClosed = false;
	declare current: SessionSnapshot;
	finish: () => void = () => {};
	constructor(cwd: string, id: string) {
		super();
		this.current = { ...snapshot(), cwd, sessionId: id, generation: `host-${id}` };
		this.execute = async (envelope) => {
			if (envelope.command.type === "prompt") {
				const text = envelope.command.text;
				this.event({ type: "run", run: { phase: "working" } });
				this.event({ type: "message", message: { id: `user-${id}`, role: "user", blocks: [{ kind: "text", text }] } });
				await new Promise<void>((resolve) => {
					this.finish = resolve;
				});
				this.event({
					type: "message",
					message: { id: `answer-${id}`, role: "assistant", blocks: [{ kind: "text", text: `${id}完成` }] },
				});
				this.event({ type: "run", run: { phase: "idle" } });
			} else if (envelope.command.type === "abort") this.finish();
		};
	}
	event(event: SessionEvent["event"]): void {
		this.current.seq++;
		if (event.type === "run") this.current.run = event.run;
		if (event.type === "message") this.current.messages.push(event.message);
		this.emit({
			type: "event",
			value: { sessionId: this.current.sessionId, generation: this.current.generation, seq: this.current.seq, event },
		});
	}
	async getSnapshot() {
		return structuredClone(this.current);
	}
	async listSessions(): Promise<SessionSummary[]> {
		return [
			{
				id: this.current.sessionId,
				title: this.current.title,
				preview: "",
				updatedAt: 1,
				messageCount: this.current.messages.length,
				persisted: false,
			},
		];
	}
	async getForkDraft() {
		return undefined;
	}
	async getImage(): Promise<string> {
		throw new Error("没有测试图片");
	}
	async prepareTransition() {
		throw new Error("导航不应触发生命周期切换");
	}
	async renameSession() {}
	async close() {
		this.isClosed = true;
		this.finish();
	}
}

/*
 * ========================================================================
 * 步骤1：验证主进程与界面之间的多会话完整链路
 * ========================================================================
 * 数据源：真实 WorkspaceService、Controller 注册表、独立草稿文件与可控宿主。
 * 操作：1) 两个任务同时运行并反复切换；2) 输出、取消、故障和输入各自隔离。
 */
describe("multiple retained sessions", () => {
	/*
	 * ========================================================================
	 * 步骤2：验证切换准备期间保留已有界面
	 * ========================================================================
	 * 数据源：可暂停的目标快照与真实 Controller 注册表。
	 * 操作：1) 首次打开与返回缓存会话都等待就绪；2) 不发布空快照或连接中状态。
	 */
	it("keeps the current view until new and retained session snapshots are ready", async () => {
		logger.info("开始验证会话界面无空状态切换");
		const fixture = new FakeAgentPort();
		const first = { ...snapshot(), sessionId: "first", generation: "first-host" };
		const second = { ...snapshot(), sessionId: "second", generation: "second-host" };
		let selected = first;
		let waiting = Promise.resolve();
		let entered = () => {};
		let release = () => {};
		const port = {
			getSnapshot: async () => selected,
			getSessionSnapshot: async () => {
				entered();
				await waiting;
				return selected;
			},
			dispatch: fixture.dispatch.bind(fixture),
			subscribe: fixture.subscribe.bind(fixture),
		};
		const controllers = new SessionControllers(port, logger, fixture);
		const observed: { id: string | undefined; connection: string }[] = [];
		const unsubscribe = controllers.subscribe((state) =>
			observed.push({ id: state.snapshot?.sessionId, connection: state.connection }),
		);
		try {
			await controllers.connect();
			for (const target of [second, first]) {
				// 2.1 目标快照等待时，当前会话和侧栏仍保持已连接画面。
				const previous = controllers.value.snapshot?.sessionId;
				const started = new Promise<void>((resolve) => {
					entered = resolve;
				});
				waiting = new Promise<void>((resolve) => {
					release = resolve;
				});
				selected = target;
				observed.length = 0;
				const pending = controllers.refresh();
				await started;
				expect(controllers.value.snapshot?.sessionId).toBe(previous);
				expect(controllers.value.connection).toBe("connected");
				release();
				await pending;
				// 2.2 完整目标状态一次发布，不出现先清空再填回的中间帧。
				expect(controllers.value.snapshot?.sessionId).toBe(target.sessionId);
				expect(observed).not.toHaveLength(0);
				expect(observed.every((value) => value.id && value.connection === "connected")).toBe(true);
			}
		} finally {
			release();
			unsubscribe();
			controllers.dispose();
			logger.info("会话界面无空状态切换验证结束");
		}
	});

	it("runs two sessions concurrently and preserves per-session drafts and pending commands", async () => {
		logger.info("开始验证多会话并发与草稿隔离");
		const directory = await mkdtemp(join(tmpdir(), "pi-multi-session-"));
		if (dirname(directory) !== tmpdir()) throw new Error("测试目录清理越界");
		const cwd = await realpath(directory);
		const a = new Host(cwd, "a");
		const b = new Host(cwd, "b");
		const factory = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b);
		const workspace = new WorkspaceService(new WorkspaceStore(join(directory, "state"), logger), factory, logger);
		const port = {
			getSnapshot: () => workspace.getSnapshot(),
			getSessionSnapshot: workspace.getSessionSnapshot.bind(workspace),
			dispatch: workspace.dispatch.bind(workspace),
			subscribe: workspace.subscribe.bind(workspace),
		};
		const drafts = {
			loadDraft: workspace.loadDraft.bind(workspace),
			saveDraft: workspace.saveDraft.bind(workspace),
			selectProjectFiles: vi.fn(async () => []),
			validateProjectFiles: vi.fn(async () => []),
			searchProjectFiles: vi.fn(async () => ({ paths: [], incomplete: false })),
			selectImages: vi.fn(async () => []),
			importImages: vi.fn(async () => []),
			readImage: vi.fn(async () => ""),
		};
		const controllers = new SessionControllers(port, logger, drafts);
		try {
			// 1.1 A 未完成即可创建 B；B 的命令与草稿由独立 Controller 持有。
			await workspace.attach(cwd);
			await controllers.connect();
			controllers.setDraft("A任务");
			await controllers.flushDraft();
			const runA = controllers.send({ type: "prompt", text: "A任务" });
			await vi.waitFor(() => expect(a.current.run.phase).toBe("working"));
			await workspace.newSession();
			await controllers.refresh();
			expect(controllers.value.submitting).toBe(false);
			expect(a.isClosed).toBe(false);
			controllers.setDraft("B任务");
			await controllers.flushDraft();
			const runB = controllers.send({ type: "prompt", text: "B任务" });
			await vi.waitFor(() => expect(b.current.run.phase).toBe("working"));
			expect(workspace.getSessionRuntimes().filter((entry) => entry.running)).toHaveLength(2);
			controllers.setDraft("B后续输入");
			await controllers.flushDraft();
			// 1.2 A 在后台完成不得清空 B 的输入或结束 B 的运行状态。
			a.finish();
			expect(await runA).toBe(true);
			expect(controllers.value.snapshot?.sessionId).toBe("b");
			expect(controllers.value.draft).toBe("B后续输入");
			expect(controllers.value.snapshot?.run.phase).toBe("working");
			await workspace.openSession("a");
			await controllers.refresh();
			expect(controllers.value.snapshot?.messages.at(-1)?.blocks[0].text).toBe("a完成");
			controllers.setDraft("A独立草稿");
			await controllers.flushDraft();
			await workspace.openSession("b");
			await controllers.refresh();
			expect(controllers.value.draft).toBe("B后续输入");
			expect(factory).toHaveBeenCalledTimes(2);
			await controllers.send({ type: "abort" });
			expect(await runB).toBe(true);
			expect(a.commands.map((entry) => entry.command.type)).toEqual(["prompt"]);
			expect(b.commands.map((entry) => entry.command.type)).toEqual(["prompt", "abort"]);
			await workspace.openSession("a");
			await controllers.refresh();
			expect(controllers.value.draft).toBe("A独立草稿");
		} finally {
			a.finish();
			b.finish();
			controllers.dispose();
			await workspace.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("多会话并发与草稿隔离验证结束");
		}
	});
	it("scopes background failures, rejects stale commands and closes all hosts even after a failure", async () => {
		logger.info("开始验证多会话故障和退出");
		const directory = await mkdtemp(join(tmpdir(), "pi-multi-session-"));
		if (dirname(directory) !== tmpdir()) throw new Error("测试目录清理越界");
		const cwd = await realpath(directory);
		const a = new Host(cwd, "a");
		const b = new Host(cwd, "b");
		const workspace = new WorkspaceService(
			new WorkspaceStore(join(directory, "state"), logger),
			vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b),
			logger,
		);
		const events: PortNotification[] = [];
		workspace.subscribe((event) => events.push(event));
		try {
			// 1.3 后台故障有独立身份，不把当前会话标为断开。
			await workspace.attach(cwd);
			await workspace.newSession();
			a.isClosed = true;
			a.emit({ type: "disconnected", reason: "A退出" });
			expect(events.find((event) => event.type === "disconnected")).toMatchObject({
				sessionId: "a",
				generation: "host-a",
			});
			expect(workspace.getSessionRuntimes().find((entry) => entry.sessionId === "b")?.connected).toBe(true);
			await expect(
				workspace.dispatch({ requestId: "stale", sessionId: "b", generation: "old", command: { type: "abort" } }),
			).rejects.toThrow();
			const closeB = vi.spyOn(b, "close");
			vi.spyOn(a, "close").mockRejectedValueOnce(new Error("保存失败"));
			await expect(workspace.close()).rejects.toThrow("部分会话保存失败");
			expect(closeB).toHaveBeenCalledOnce();
		} finally {
			await workspace.close();
			await rm(directory, { recursive: true, force: true });
			logger.info("多会话故障和退出验证结束");
		}
	});
});
