import { existsSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { DRAFT_TEXT_LIMIT } from "../shared/input-limits.ts";
import type { Logger } from "../shared/logger.ts";

/*
 * ========================================================================
 * 步骤1：从原生分支确定可恢复的分支起点
 * ========================================================================
 * 数据源：SessionManager 活动分支和 SDK 当前上下文对象。
 * 操作：
 *   1) 按对象身份关联消息，不用正文或展示序号猜测原生 entry ID
 *   2) 只开放已有助手历史后的纯文本用户消息，保证分支立即落盘
 */
export function getForkTargets(
	session: Pick<AgentSession, "sessionManager" | "messages">,
	logger: Logger,
): Map<AgentMessage, { entryId: string; text: string }> {
	logger.info("开始读取原生分支起点");
	try {
		// 1.1 压缩后已离开当前上下文的消息不再提供界面操作。
		const visible = new Set(session.messages);
		const targets = new Map<AgentMessage, { entryId: string; text: string }>();
		let hasAssistant = false;
		for (const entry of session.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "assistant") hasAssistant = true;
			if (!hasAssistant || message.role !== "user" || !visible.has(message)) continue;
			if (typeof message.content !== "string" && message.content.some((block) => block.type !== "text")) continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			if (text.trim() && text.length <= DRAFT_TEXT_LIMIT) targets.set(message, { entryId: entry.id, text });
		}
		return targets;
	} finally {
		logger.info("原生分支起点读取结束");
	}
}

/*
 * ========================================================================
 * 步骤2：在待接替宿主内建立 SDK 分支
 * ========================================================================
 * 数据源：临时 SessionManager 和已验证的原生 entry ID。
 * 操作：
 *   1) 在运行时初始化前建立分支，避免 SDK 恢复配置时补写来源文件
 *   2) 只写新文件，原生消息 ID 与父链仍由 SDK 保留
 */
export function forkSessionManager(manager: SessionManager, entryId: string, logger: Logger): string {
	logger.info("开始建立 SDK 会话分支");
	try {
		// 2.1 不对 SDK 私有字段赋值，不插入虚假消息迫使会话落盘。
		const target = [
			...getForkTargets({ sessionManager: manager, messages: manager.buildSessionContext().messages }, logger).values(),
		].find((item) => item.entryId === entryId);
		const parentId = manager.getEntry(entryId)?.parentId;
		const sourceFile = manager.getSessionFile();
		if (!target || !parentId || !sourceFile || !existsSync(sourceFile))
			throw new Error("这条消息暂不可分支，请刷新会话后重试");
		const sourceId = manager.getSessionId();
		const file = manager.createBranchedSession(parentId);
		if (manager.getSessionId() === sourceId || !file || !existsSync(file))
			throw new Error("会话分支未完整保存，已保留原会话");
		manager.appendSessionInfo(
			`${target.text
				.replace(/[\r\n]+/g, " ")
				.trim()
				.slice(0, 195)} · 分支`,
		);
		return target.text;
	} finally {
		logger.info("SDK 会话分支建立结束");
	}
}
