import { describe, expect, it, vi } from "vitest";
import { readFileCompletion } from "../src/domain/file-completion.ts";
import { GuiController } from "../src/domain/gui-controller.ts";
import { DRAFT_TEXT_LIMIT } from "../src/shared/input-limits.ts";
import { FakeAgentPort, snapshot } from "./fixtures.ts";

const logger = { info: vi.fn() };

/*
 * ========================================================================
 * 步骤1：验证端口重连与提交竞态
 * ========================================================================
 * 数据源：在途快照、命令拒绝、断开和迟到事件。
 * 操作：
 *   1) 验证订阅先于快照安装，缺口会触发恢复
 *   2) 验证失败保留草稿，不覆盖新输入，不自动重发
 */
describe("GuiController", () => {
	it("inserts a revalidated completion at its original caret span without sending", async () => {
		logger.info("开始验证光标引用草稿保存");
		const port = new FakeAgentPort();
		vi.spyOn(port, "validateProjectFiles").mockResolvedValue(["src/中文 文件.ts"]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		try {
			const source = "前文  @src/old.ts 后文\n";
			const cursor = source.indexOf("src") + 3;
			const completion = readFileCompletion(source, cursor, cursor, logger);
			if (!completion) throw new Error("Completion missing");
			controller.setDraft(source);
			expect(
				await controller.referenceProjectFiles(
					{ sessionId: "session-1", generation: "host-1", paths: ["src/candidate.ts"] },
					completion,
				),
			).toBe(true);
			expect(controller.value.draft).toBe('前文  @"src/中文 文件.ts" 后文\n');
			expect(port.drafts.get("session-1")?.text).toBe(controller.value.draft);
			expect(port.commands).toEqual([]);
		} finally {
			controller.dispose();
			logger.info("光标引用草稿保存验证完成");
		}
	});
	it("rejects completion when editing changes its source before or during path validation", async () => {
		logger.info("开始验证补全草稿竞态");
		const port = new FakeAgentPort();
		let finish: (paths: string[]) => void = () => {};
		const validate = vi.spyOn(port, "validateProjectFiles").mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		try {
			const source = "前文 @src";
			const completion = readFileCompletion(source, source.length, source.length, logger);
			if (!completion) throw new Error("Completion missing");
			const selection = { sessionId: "session-1", generation: "host-1", paths: ["src/file.ts"] };
			controller.setDraft("较新的输入");
			expect(await controller.referenceProjectFiles(selection, completion)).toBe(false);
			expect(validate).not.toHaveBeenCalled();
			controller.setDraft(source);
			const selecting = controller.referenceProjectFiles(selection, completion);
			controller.setDraft("校验期间的新输入");
			finish(["src/file.ts"]);
			expect(await selecting).toBe(false);
			expect(controller.value.draft).toBe("校验期间的新输入");
			expect(controller.value.error).toContain("草稿已变化");
			expect(controller.value.selectingFiles).toBe(false);
			expect(port.commands).toEqual([]);
		} finally {
			controller.dispose();
			logger.info("补全草稿竞态验证完成");
		}
	});
	it("revalidates search references through the regular composer path and rejects stale selections", async () => {
		logger.info("开始验证搜索引用草稿复用");
		const port = new FakeAgentPort();
		const validate = vi.spyOn(port, "validateProjectFiles").mockResolvedValue(["src/中文 文件.ts"]);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("  原草稿\n");
		const selection = { sessionId: "session-1", generation: "host-1", paths: ["src/中文 文件.ts"] };
		try {
			expect(await controller.referenceProjectFiles({ ...selection, generation: "old" })).toBe(false);
			expect(validate).not.toHaveBeenCalled();
			expect(await controller.referenceProjectFiles(selection)).toBe(true);
			expect(validate).toHaveBeenCalledWith(selection);
			expect(controller.value.draft).toBe('  原草稿\n@"src/中文 文件.ts"\n');
			expect(port.drafts.get("session-1")?.text).toBe(controller.value.draft);
			expect(port.commands).toEqual([]);
			validate.mockRejectedValueOnce(new Error("文件已失效"));
			expect(await controller.referenceProjectFiles(selection)).toBe(false);
			expect(controller.value.error).toBe("文件已失效");
			expect(controller.value.draft).toBe('  原草稿\n@"src/中文 文件.ts"\n');
		} finally {
			controller.dispose();
			logger.info("搜索引用草稿复用验证完成");
		}
	});
	it("restores drafts and saves newer edits while an earlier write is pending", async () => {
		const port = new FakeAgentPort();
		port.drafts.set("session-1", { text: "已有草稿", revision: 3 });
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		expect(controller.value.draft).toBe("已有草稿");
		let finish: () => void = () => {};
		const save = port.saveDraft.bind(port);
		vi.spyOn(port, "saveDraft").mockImplementationOnce(
			(input) =>
				new Promise((resolve) => {
					finish = () => {
						void save(input).then(resolve);
					};
				}),
		);
		controller.setDraft("first edit");
		await Promise.resolve();
		controller.setDraft("latest edit");
		finish();
		expect(await controller.flushDraft()).toBe(true);
		expect(port.drafts.get("session-1")).toEqual({ text: "latest edit", revision: 5 });
		expect(controller.value.draftStatus).toBe("saved");
		controller.dispose();
	});

	it("keeps the local draft when persistence fails", async () => {
		const port = new FakeAgentPort();
		vi.spyOn(port, "saveDraft").mockRejectedValue(new Error("disk full"));
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("不能丢失");
		expect(await controller.flushDraft()).toBe(false);
		expect(controller.value.draft).toBe("不能丢失");
		expect(controller.value.draftError).toBe("disk full");
		controller.setDraft("");
		expect(await controller.flushDraft()).toBe(true);
		expect(controller.value.draftStatus).toBe("saved");
		controller.dispose();
	});
	it("reports unreadable drafts and can reconnect after the storage error is resolved", async () => {
		logger.info("开始验证草稿载入恢复");
		const port = new FakeAgentPort();
		vi.spyOn(port, "loadDraft").mockRejectedValueOnce(new Error("草稿无法读取"));
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		expect(controller.value.draftStatus).toBe("error");
		expect(controller.value.draftError).toBe("草稿无法读取");
		await controller.refresh();
		expect(controller.value.connection).toBe("connected");
		expect(controller.value.draftStatus).toBe("saved");
		controller.dispose();
		logger.info("草稿载入恢复验证完成");
	});
	it("buffers events emitted while the initial snapshot is pending", async () => {
		const port = new FakeAgentPort();
		port.read = async () => {
			port.emit({
				type: "event",
				value: {
					sessionId: "session-1",
					generation: "host-1",
					seq: 1,
					event: { type: "run", run: { phase: "working" } },
				},
			});
			return snapshot();
		};
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		expect(controller.value.snapshot?.run.phase).toBe("working");
		expect(controller.value.snapshot?.seq).toBe(1);
		controller.dispose();
		expect(port.listeners.size).toBe(0);
	});

	it("clears only the accepted draft while the task continues", async () => {
		const port = new FakeAgentPort();
		let complete = () => {};
		port.execute = () =>
			new Promise<void>((resolve) => {
				complete = resolve;
			});
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("first");
		const pending = controller.send({ type: "prompt", text: "first" });
		port.emit({
			type: "event",
			value: {
				sessionId: "session-1",
				generation: "host-1",
				seq: 1,
				event: { type: "message", message: { id: "user-1", role: "user", blocks: [{ kind: "text", text: "first" }] } },
			},
		});
		expect(controller.value.draft).toBe("");
		expect(controller.value.submitting).toBe(false);
		controller.setDraft("first");
		port.emit({
			type: "event",
			value: {
				sessionId: "session-1",
				generation: "host-1",
				seq: 2,
				event: { type: "message", message: { id: "user-1", role: "user", blocks: [{ kind: "text", text: "first" }] } },
			},
		});
		complete();
		await pending;
		expect(controller.value.draft).toBe("first");
		controller.dispose();
	});

	it("recovers once from a sequence gap and never replays commands", async () => {
		const port = new FakeAgentPort();
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		port.current = { ...snapshot(), seq: 5, run: { phase: "working" } };
		const read = vi.spyOn(port, "getSnapshot");
		for (const seq of [4, 5])
			port.emit({
				type: "event",
				value: {
					sessionId: "session-1",
					generation: "host-1",
					seq,
					event: { type: "run", run: { phase: "working" } },
				},
			});
		await controller.refresh();
		expect(read).toHaveBeenCalledTimes(1);
		expect(controller.value.snapshot?.seq).toBe(5);
		expect(port.commands).toEqual([]);
	});

	it("preserves rejected drafts and does not send while disconnected", async () => {
		const port = new FakeAgentPort();
		port.execute = async () => {
			throw new Error("Model unavailable");
		};
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("检查项目");
		expect(await controller.send({ type: "prompt", text: controller.value.draft })).toBe(false);
		expect(controller.value.draft).toBe("检查项目");
		expect(controller.value.error).toBe("Model unavailable");
		port.emit({ type: "disconnected", reason: "Host exited" });
		expect(await controller.send({ type: "prompt", text: "retry" })).toBe(false);
		expect(port.commands).toHaveLength(1);
	});

	it("does not overwrite newer drafts or submit twice while a command is pending", async () => {
		const port = new FakeAgentPort();
		let complete = () => {};
		port.execute = () =>
			new Promise<void>((resolve) => {
				complete = resolve;
			});
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("first");
		const pending = controller.send({ type: "prompt", text: "first" });
		expect(await controller.send({ type: "prompt", text: "duplicate" })).toBe(false);
		controller.setDraft("new draft");
		complete();
		await pending;
		expect(controller.value.draft).toBe("new draft");
		expect(port.commands).toHaveLength(1);
	});

	it("does not install a late snapshot after disposal", async () => {
		const port = new FakeAgentPort();
		let finish: (value: ReturnType<typeof snapshot>) => void = () => {};
		port.read = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const controller = new GuiController(port, logger, port);
		const connecting = controller.connect();
		await Promise.resolve();
		controller.dispose();
		finish(snapshot());
		await connecting;
		expect(controller.value.snapshot).toBeNull();
	});

	it("does not let an earlier run completion confirm a newer queued submission", async () => {
		logger.info("开始验证排队提交身份");
		const port = new FakeAgentPort();
		let finishRun = () => {};
		let finishQueue = () => {};
		port.execute = (envelope) =>
			new Promise<void>((resolve) => {
				if (envelope.command.type === "prompt") finishRun = resolve;
				else finishQueue = resolve;
			});
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("任务一");
		const running = controller.send({ type: "prompt", text: "任务一" });
		port.emit({
			type: "event",
			value: {
				sessionId: "session-1",
				generation: "host-1",
				seq: 1,
				event: { type: "run", run: { phase: "working" } },
			},
		});
		port.emit({
			type: "event",
			value: {
				sessionId: "session-1",
				generation: "host-1",
				seq: 2,
				event: { type: "message", message: { id: "user-1", role: "user", blocks: [{ kind: "text", text: "任务一" }] } },
			},
		});
		controller.setDraft("排队二");
		const queuing = controller.send({ type: "enqueue", mode: "followUp", text: "排队二" });
		finishRun();
		await running;
		expect(controller.value.submitting).toBe(true);
		expect(controller.value.draft).toBe("排队二");
		port.emit({
			type: "event",
			value: {
				sessionId: "session-1",
				generation: "host-1",
				seq: 3,
				event: {
					type: "message",
					message: { id: "user-2", role: "user", blocks: [{ kind: "text", text: "旧队列消息" }] },
				},
			},
		});
		expect(controller.value.draft).toBe("排队二");
		controller.setDraft("继续编辑的新草稿");
		finishQueue();
		await queuing;
		expect(controller.value.draft).toBe("继续编辑的新草稿");
		expect(controller.value.submitting).toBe(false);
		controller.dispose();
		logger.info("排队提交身份验证完成");
	});

	it("persists recovered queue text before clearing and retries without duplicating the text", async () => {
		logger.info("开始验证队列恢复保存顺序");
		const port = new FakeAgentPort();
		port.current = {
			...snapshot(),
			queue: {
				...snapshot().queue,
				followUp: [{ text: "任务二" }],
				recovery: { steering: [{ text: "引导一" }], followUp: [] },
			},
		};
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		controller.setDraft("已有草稿");
		await controller.flushDraft();
		const save = vi.spyOn(port, "saveDraft").mockRejectedValue(new Error("disk full"));
		expect(await controller.restoreQueue()).toBe(false);
		expect(port.commands).toHaveLength(0);
		expect(controller.value.draft).toBe("已有草稿\n\n引导一\n\n任务二");
		save.mockRestore();
		port.execute = async (command) => {
			expect(command.command.type).toBe("clearQueue");
			expect(port.drafts.get("session-1")?.text).toBe("已有草稿\n\n引导一\n\n任务二");
		};
		expect(await controller.restoreQueue()).toBe(true);
		expect(controller.value.draft).toBe("已有草稿\n\n引导一\n\n任务二");
		expect(port.commands).toHaveLength(1);
		controller.dispose();
		logger.info("队列恢复保存顺序验证完成");
	});

	it("blocks duplicate queue clearing and submissions until the pending clear finishes", async () => {
		logger.info("开始验证清空队列互斥");
		const port = new FakeAgentPort();
		let finish = () => {};
		port.execute = () =>
			new Promise<void>((resolve) => {
				finish = resolve;
			});
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		const clearing = controller.send({ type: "clearQueue" });
		expect(controller.value.queueBusy).toBe(true);
		expect(await controller.send({ type: "clearQueue" })).toBe(false);
		expect(await controller.send({ type: "prompt", text: "不能交错" })).toBe(false);
		finish();
		await clearing;
		expect(controller.value.queueBusy).toBe(false);
		expect(port.commands).toHaveLength(1);
		controller.dispose();
		logger.info("清空队列互斥验证完成");
	});

	/*
	 * ========================================================================
	 * 步骤2：验证文件引用的草稿与提交边界
	 * ========================================================================
	 * 数据源：可暂停文件选择端口、最新草稿与失败存储。
	 * 操作：
	 *   1) 引用只追加到原会话最新输入，保留空白、转义和持久化顺序
	 *   2) 取消、超限、断连或销毁不覆盖输入，选择期间不提交命令
	 */
	it("appends quoted project references to the latest draft and saves without sending", async () => {
		logger.info("开始验证文件引用草稿合并");
		const port = new FakeAgentPort();
		let finish: (paths: string[]) => void = () => {};
		const choose = vi.spyOn(port, "selectProjectFiles").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		try {
			// 2.1 选择开始后的编辑必须保留，路径引号不会变成提示词换行。
			controller.setDraft("最初输入");
			const pending = controller.referenceProjectFiles();
			controller.setDraft("最新输入  \n");
			expect(choose).toHaveBeenCalledWith({ sessionId: "session-1", generation: "host-1" });
			expect(controller.value.selectingFiles).toBe(true);
			expect(await controller.referenceProjectFiles()).toBe(false);
			expect(await controller.send({ type: "prompt", text: "不能抢先发送" })).toBe(false);
			expect(await controller.restoreQueue()).toBe(false);
			finish(["src/中文 文件.ts", 'src/带"引号.ts']);
			expect(await pending).toBe(true);
			const expected = '最新输入  \n@"src/中文 文件.ts"\n@"src/带\\"引号.ts"\n';
			expect(controller.value.draft).toBe(expected);
			expect(port.drafts.get("session-1")?.text).toBe(expected);
			expect(controller.value.selectingFiles).toBe(false);
			expect(port.commands).toEqual([]);
		} finally {
			controller.dispose();
			logger.info("文件引用草稿合并验证完成");
		}
	});

	it("keeps drafts unchanged on cancellation, selection failure and length overflow", async () => {
		logger.info("开始验证文件引用取消与超限");
		const port = new FakeAgentPort();
		const choose = vi.spyOn(port, "selectProjectFiles");
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		try {
			// 2.2 整批合并先检查长度，不静默截断输入或部分加入路径。
			controller.setDraft("保留末尾空格  ");
			await controller.flushDraft();
			const save = vi.spyOn(port, "saveDraft");
			expect(await controller.referenceProjectFiles()).toBe(false);
			expect(controller.value.draft).toBe("保留末尾空格  ");
			expect(save).not.toHaveBeenCalled();
			choose.mockRejectedValueOnce(new Error("只能引用当前项目内的文件"));
			expect(await controller.referenceProjectFiles()).toBe(false);
			expect(controller.value.draft).toBe("保留末尾空格  ");
			expect(controller.value.error).toContain("当前项目内");
			const text = "x".repeat(DRAFT_TEXT_LIMIT - 2);
			controller.setDraft(text);
			await controller.flushDraft();
			choose.mockResolvedValueOnce(["a.ts", "b.ts"]);
			expect(await controller.referenceProjectFiles()).toBe(false);
			expect(controller.value.draft).toBe(text);
			expect(controller.value.error).toContain("长度上限");
			expect(controller.value.selectingFiles).toBe(false);
			expect(port.commands).toEqual([]);
		} finally {
			controller.dispose();
			logger.info("文件引用取消与超限验证完成");
		}
	});

	it("preserves inserted references after a save failure and retries through normal draft persistence", async () => {
		logger.info("开始验证文件引用保存失败恢复");
		const port = new FakeAgentPort();
		const controller = new GuiController(port, logger, port);
		await controller.connect();
		try {
			// 2.3 文件选择不建立第二份草稿；存储错误仍保留可见引用供重试。
			controller.setDraft("说明  ");
			await controller.flushDraft();
			vi.spyOn(port, "selectProjectFiles").mockResolvedValue(["README.md"]);
			const save = vi.spyOn(port, "saveDraft").mockRejectedValue(new Error("disk full"));
			expect(await controller.referenceProjectFiles()).toBe(true);
			expect(controller.value.draft).toBe('说明  \n@"README.md"\n');
			expect(controller.value.draftStatus).toBe("error");
			expect(controller.value.draftError).toBe("disk full");
			expect(port.drafts.get("session-1")?.text).toBe("说明  ");
			save.mockRestore();
			expect(await controller.flushDraft()).toBe(true);
			expect(port.drafts.get("session-1")?.text).toBe(controller.value.draft);
		} finally {
			controller.dispose();
			logger.info("文件引用保存失败恢复验证完成");
		}
	});

	it.each(["session", "generation", "disconnect", "dispose"])(
		"ignores pending project file references after %s changes",
		async (change) => {
			logger.info("开始验证迟到文件引用");
			const port = new FakeAgentPort();
			let finish: (paths: string[]) => void = () => {};
			vi.spyOn(port, "selectProjectFiles").mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const controller = new GuiController(port, logger, port);
			await controller.connect();
			try {
				// 2.4 原调用返回时只允许修改原身份，断连和销毁也不接受结果。
				controller.setDraft("原草稿");
				const pending = controller.referenceProjectFiles();
				if (change === "session" || change === "generation") {
					port.current = {
						...snapshot(),
						...(change === "session" ? { sessionId: "next-session" } : { generation: "next-host" }),
					};
					await controller.refresh();
					controller.setDraft("新草稿");
				} else if (change === "disconnect") port.emit({ type: "disconnected", reason: "host exited" });
				else controller.dispose();
				const draft = controller.value.draft;
				finish(["README.md"]);
				expect(await pending).toBe(false);
				expect(controller.value.draft).toBe(draft);
				expect(port.commands).toEqual([]);
			} finally {
				controller.dispose();
				logger.info("迟到文件引用验证完成");
			}
		},
	);
});
