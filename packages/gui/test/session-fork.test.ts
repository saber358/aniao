import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forkSessionManager, getForkTargets } from "../src/host/session-fork.ts";
import { openSessionManager, SessionLibrary } from "../src/host/session-library.ts";
import { openRuntime } from "../src/host/session-runtime.ts";
import { DRAFT_TEXT_LIMIT } from "../src/shared/input-limits.ts";

const logger = { info: vi.fn() };
const directories: string[] = [];

/*
 * ========================================================================
 * 步骤1：验证原生分支的文件、来源与恢复语义
 * ========================================================================
 * 数据源：临时 SDK JSONL、真实运行时，不调用模型或读取用户认证。
 * 操作：
 *   1) 同文消息保留不同 entry ID，选定起点之后的内容不进入新分支
 *   2) 拒绝无助手历史、图片和过长输入，失败保留来源文件
 */
describe("native session fork", () => {
	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		for (const directory of directories.splice(0)) {
			if (!resolve(directory).startsWith(resolve(tmpdir()))) throw new Error("Unexpected temporary directory");
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("forks the selected duplicate message and restores its prefix and parent after restart", async () => {
		logger.info("开始验证原生分支持久化");
		const cwd = await mkdtemp(join(tmpdir(), "pi-gui-fork-"));
		directories.push(cwd);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
		const manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: "重复问题", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("第一答"));
		const second = manager.appendMessage({ role: "user", content: "重复问题", timestamp: 2 });
		manager.appendMessage(fauxAssistantMessage("第二答"));
		const third = manager.appendMessage({ role: "user", content: "重复问题", timestamp: 3 });
		manager.appendMessage(fauxAssistantMessage("第三答"));
		manager.appendSessionInfo("来源会话");
		const sourceFile = manager.getSessionFile();
		if (!sourceFile) throw new Error("Source fixture not persisted");
		const original = await readFile(sourceFile, "utf8");
		const { runtime, forkDraft } = await openRuntime(
			cwd,
			{ type: "fork", sourceId: manager.getSessionId(), entryId: third },
			logger,
		);
		const branchId = runtime.session.sessionId;
		try {
			expect(forkDraft).toBe("重复问题");
			expect(branchId).not.toBe(manager.getSessionId());
			expect(runtime.session.messages).toHaveLength(4);
			expect(runtime.session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "第二答" }],
			});
			expect([...getForkTargets(runtime.session, logger).values()].map((entry) => entry.entryId)).toEqual([second]);
			expect(
				(await new SessionLibrary(runtime.session, logger).list()).find((entry) => entry.id === branchId),
			).toMatchObject({
				parentId: manager.getSessionId(),
				persisted: true,
				title: "重复问题 · 分支",
			});
			expect(await readFile(sourceFile, "utf8")).toBe(original);
		} finally {
			await runtime.dispose();
		}
		const restored = await openRuntime(cwd, { type: "session", id: branchId, allowCreate: false }, logger);
		try {
			expect(restored.runtime.session.sessionId).toBe(branchId);
			expect(restored.runtime.session.messages).toHaveLength(4);
			expect(
				(await new SessionLibrary(restored.runtime.session, logger).list()).find((entry) => entry.id === branchId)
					?.parentId,
			).toBe(manager.getSessionId());
		} finally {
			await restored.runtime.dispose();
			logger.info("原生分支持久化验证完成");
		}
	});

	it("excludes empty prefixes, images and oversized drafts and rejects invalid entries before writing", async () => {
		logger.info("开始验证原生分支输入边界");
		const cwd = await mkdtemp(join(tmpdir(), "pi-gui-fork-"));
		directories.push(cwd);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
		const manager = SessionManager.create(cwd);
		const first = manager.appendMessage({ role: "user", content: "首条问题", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("首答"));
		manager.appendMessage({ role: "user", content: " ", timestamp: 2 });
		manager.appendMessage({ role: "user", content: "x".repeat(DRAFT_TEXT_LIMIT + 1), timestamp: 3 });
		manager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "有图片" },
				{ type: "image", mimeType: "image/png", data: "fixture" },
			],
			timestamp: 4,
		});
		const valid = manager.appendMessage({ role: "user", content: "有效中文", timestamp: 5 });
		const { runtime } = await openRuntime(
			cwd,
			{ type: "session", id: manager.getSessionId(), allowCreate: false },
			logger,
		);
		try {
			expect([...getForkTargets(runtime.session, logger).values()].map((entry) => entry.entryId)).toEqual([valid]);
			const fork = vi.spyOn(runtime.session.sessionManager, "createBranchedSession");
			expect(() => forkSessionManager(runtime.session.sessionManager, first, logger)).toThrow("暂不可分支");
			expect(fork).not.toHaveBeenCalled();
			expect(runtime.session.sessionId).toBe(manager.getSessionId());
			await expect(
				openSessionManager(cwd, { type: "fork", sourceId: "unknown", entryId: valid }, logger),
			).rejects.toThrow("文件已不存在");
		} finally {
			await runtime.dispose();
			logger.info("原生分支输入边界验证完成");
		}
	});
});
