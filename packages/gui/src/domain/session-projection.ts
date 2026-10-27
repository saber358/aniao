import type { Logger } from "../shared/logger.ts";
import type { SessionEvent, SessionSnapshot } from "../shared/protocol.ts";

/*
 * ========================================================================
 * 步骤1：将有序事件投影为不可变视图快照
 * ========================================================================
 * 数据源：AgentPort 的快照和事件，不依赖界面或传输。
 * 操作：
 *   1) 拒绝旧会话、旧代次、重复和缺失事件
 *   2) 消息与工具累计快照按身份替换，不追加重复文本
 */
export class SessionProjection {
	private snapshot: SessionSnapshot;
	private readonly logger: Logger;

	constructor(snapshot: SessionSnapshot, logger: Logger) {
		this.logger = logger;
		this.logger.info("开始安装会话快照");
		// 1.1 切断调用方对后续状态的引用。
		this.snapshot = structuredClone(snapshot);
		this.logger.info("会话快照安装完成");
	}

	get value(): SessionSnapshot {
		return this.snapshot;
	}

	apply(envelope: SessionEvent): "applied" | "stale" | "gap" {
		this.logger.info("开始投影会话事件");
		try {
			const previous = this.snapshot;
			// 1.2 会话与代次决定事件归属，序号决定是否连续。
			if (
				envelope.sessionId !== previous.sessionId ||
				envelope.generation !== previous.generation ||
				envelope.seq <= previous.seq
			)
				return "stale";
			if (envelope.seq !== previous.seq + 1) return "gap";

			const event = envelope.event;
			const next = { ...previous, seq: envelope.seq };
			// 1.3 仅复制变化的列表，保留未变化对象供 Vue 浅响应式复用。
			switch (event.type) {
				case "message": {
					const index = previous.messages.findIndex((message) => message.id === event.message.id);
					next.messages = [...previous.messages];
					if (index < 0) next.messages.push(event.message);
					else next.messages[index] = event.message;
					break;
				}
				case "tool": {
					const index = previous.tools.findIndex((tool) => tool.id === event.tool.id);
					next.tools = [...previous.tools];
					if (index < 0) next.tools.push(event.tool);
					else next.tools[index] = event.tool;
					break;
				}
				case "run":
					next.run = event.run;
					break;
				case "configuration":
					next.configuration = event.configuration;
					break;
				case "resources":
					next.resources = event.resources;
					break;
				case "title":
					next.title = event.title;
					break;
				case "queue":
					next.queue = event.queue;
					break;
				case "dialogs":
					next.dialogs = event.dialogs;
					break;
				case "authentication":
					next.authentication = event.authentication;
					break;
				case "extensions":
					next.extensions = event.extensions;
					break;
				case "plan":
					next.plan = event.plan;
					break;
				case "contextUsage":
					next.contextUsage = event.contextUsage;
					break;
			}
			this.snapshot = next;
			return "applied";
		} finally {
			this.logger.info("会话事件投影完成");
		}
	}
}
