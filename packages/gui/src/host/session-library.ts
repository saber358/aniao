import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../shared/logger.ts";
import type { SessionSummary, SessionTarget } from "../shared/workspace.ts";

/*
 * ========================================================================
 * 步骤1：用 SDK 管理原生会话历史
 * ========================================================================
 * 数据源：当前项目的 SessionManager 索引与活动会话。
 * 操作：
 *   1) 对外只返回摘要，文件路径留在宿主
 *   2) 未发送草稿可按已登记身份重建空会话，缺失历史不伪装恢复
 */
export async function openSessionManager(cwd: string, target: SessionTarget, logger: Logger): Promise<SessionManager> {
	logger.info("开始选择 SDK 会话");
	try {
		// 1.1 目标 ID 必须来自当前项目列表或桌面登记的未落盘会话。
		if (target.type === "new") return SessionManager.create(cwd);
		if (target.type === "recent") return SessionManager.continueRecent(cwd);
		const id = target.type === "fork" ? target.sourceId : target.id;
		const entry = (await SessionManager.list(cwd)).find((item) => item.id === id && resolve(item.cwd) === resolve(cwd));
		if (entry) return SessionManager.open(entry.path, undefined, cwd);
		if (target.type === "fork" || !target.allowCreate) throw new Error("会话文件已不存在，请刷新历史列表");
		const manager = SessionManager.create(cwd, undefined, { id: target.id });
		if (target.title && target.title !== "新对话") manager.appendSessionInfo(target.title);
		return manager;
	} finally {
		logger.info("SDK 会话选择结束");
	}
}

export class SessionLibrary {
	private readonly session: AgentSession;
	private readonly logger: Logger;
	constructor(session: AgentSession, logger: Logger) {
		this.session = session;
		this.logger = logger;
	}

	async list(): Promise<SessionSummary[]> {
		this.logger.info("开始读取 SDK 会话历史");
		try {
			const cwd = this.session.sessionManager.getCwd();
			const entries = (await SessionManager.list(cwd)).filter((entry) => resolve(entry.cwd) === resolve(cwd));
			// 1.3 分支来源只传当前项目中已发现的会话 ID，原生路径不越过宿主。
			const idsByPath = new Map(entries.map((entry) => [resolve(entry.path), entry.id]));
			const result: SessionSummary[] = entries.map((entry) => ({
				id: entry.id,
				parentId: entry.parentSessionPath ? idsByPath.get(resolve(entry.parentSessionPath)) : undefined,
				title: (entry.name ?? (entry.firstMessage === "(no messages)" ? "新对话" : entry.firstMessage))
					.replace(/[\r\n]+/g, " ")
					.slice(0, 200),
				preview: entry.firstMessage === "(no messages)" ? "" : entry.firstMessage.slice(0, 500),
				updatedAt: entry.modified.getTime(),
				messageCount: entry.messageCount,
				persisted: true,
			}));
			// 1.2 SDK 在首个助手消息前延迟落盘，活动空会话仍需可见。
			if (!result.some((entry) => entry.id === this.session.sessionId)) {
				const first = this.session.messages.find((message) => message.role === "user");
				const text =
					first?.role === "user"
						? typeof first.content === "string"
							? first.content
							: first.content
									.filter((block) => block.type === "text")
									.map((block) => block.text)
									.join("\n")
						: "";
				const file = this.session.sessionFile;
				const parent = this.session.sessionManager.getHeader()?.parentSession;
				result.unshift({
					id: this.session.sessionId,
					parentId: parent ? idsByPath.get(resolve(parent)) : undefined,
					title:
						(this.session.sessionManager.getSessionName() ?? text.replace(/[\r\n]+/g, " ").slice(0, 200)) || "新对话",
					preview: text.slice(0, 500),
					updatedAt: Date.parse(this.session.sessionManager.getHeader()?.timestamp ?? "") || Date.now(),
					messageCount: this.session.messages.length,
					persisted: !!file && existsSync(file),
				});
			}
			return result;
		} finally {
			this.logger.info("SDK 会话历史读取结束");
		}
	}

	async rename(sessionId: string, title: string): Promise<void> {
		this.logger.info("开始重命名 SDK 会话");
		try {
			if (!this.session.isIdle) throw new Error("请等待当前任务结束后重命名");
			if (sessionId === this.session.sessionId) this.session.setSessionName(title);
			else {
				const cwd = this.session.sessionManager.getCwd();
				const entry = (await SessionManager.list(cwd)).find(
					(item) => item.id === sessionId && resolve(item.cwd) === resolve(cwd),
				);
				if (!entry) throw new Error("会话已不在当前项目中");
				SessionManager.open(entry.path).appendSessionInfo(title);
			}
		} finally {
			this.logger.info("SDK 会话重命名结束");
		}
	}
}
