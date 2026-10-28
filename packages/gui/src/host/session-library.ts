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

	/*
	 * ========================================================================
	 * 步骤2：更新主进程确认过的目标会话名称
	 * ========================================================================
	 * 数据源：目标工作区 SDK 索引与本宿主活动会话。
	 * 操作：1) 活动会话改内存名称；2) 其他历史只追加原生名称记录。
	 */
	async rename(sessionId: string, title: string, cwd: string): Promise<void> {
		this.logger.info("开始重命名 SDK 会话");
		try {
			// 2.1 同时核对目录和身份，不能把其他工作区的请求写入当前会话。
			if (resolve(cwd) === resolve(this.session.sessionManager.getCwd()) && sessionId === this.session.sessionId) {
				if (!this.session.isIdle) throw new Error("请等待当前任务结束后重命名");
				this.session.setSessionName(title);
			} else {
				// 2.2 目标未打开时直接更新已查证历史，不创建 Agent 或切换活动会话。
				const entry = (await SessionManager.list(cwd)).find(
					(item) => item.id === sessionId && resolve(item.cwd) === resolve(cwd),
				);
				if (!entry) throw new Error("会话已不在该工作区中");
				SessionManager.open(entry.path).appendSessionInfo(title);
			}
		} finally {
			this.logger.info("SDK 会话重命名结束");
		}
	}
}
