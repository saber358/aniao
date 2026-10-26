import type { ImagesPort } from "../src/shared/images.ts";
import type { ProjectFileSelection, ProjectFilesPort } from "../src/shared/project-files.ts";
import type { AgentPort, CommandEnvelope, PortNotification, SessionSnapshot } from "../src/shared/protocol.ts";
import type { Draft, DraftPort, DraftWrite } from "../src/shared/workspace.ts";

/*
 * ========================================================================
 * 步骤1：提供确定性的会话与端口替身
 * ========================================================================
 * 目标：覆盖事件次序和失败路径，不启动 Electron 或真实模型。
 * 操作：
 *   1) 快照按测试独立创建
 *   2) 允许在查询和命令期间注入竞态
 */
export function snapshot(): SessionSnapshot {
	return {
		version: 1,
		sessionId: "session-1",
		generation: "host-1",
		seq: 0,
		cwd: "C:/workspace/中文项目",
		title: "新对话",
		messages: [],
		tools: [],
		run: { phase: "idle" },
		configuration: { model: null, models: [], thinking: "off", thinkingLevels: ["off"] },
		dialogs: [],
		authentication: { providers: [], flow: null },
		extensions: { notices: [], statuses: [], widgets: [], supported: [] },
		queue: { steering: [], followUp: [], recovery: { steering: [], followUp: [] }, error: null },
	};
}

export class FakeAgentPort implements AgentPort, DraftPort, ProjectFilesPort, ImagesPort {
	current: SessionSnapshot | null = snapshot();
	listeners = new Set<(notification: PortNotification) => void>();
	commands: CommandEnvelope[] = [];
	read: () => Promise<SessionSnapshot | null> = async () => this.current;
	execute: (command: CommandEnvelope) => Promise<void> = async () => {};
	drafts = new Map<string, Draft>();
	async selectProjectFiles(_selection: ProjectFileSelection): Promise<string[]> {
		return [];
	}
	async searchProjectFiles() {
		return { paths: [], incomplete: false };
	}
	async validateProjectFiles(): Promise<string[]> {
		return [];
	}
	async selectImages(): Promise<string[]> {
		return [];
	}
	async importImages(): Promise<string[]> {
		return [];
	}
	async readImage(): Promise<string> {
		throw new Error("Image fixture unavailable");
	}
	async loadDraft(sessionId: string): Promise<Draft> {
		return this.drafts.get(sessionId) ?? { text: "", revision: 0 };
	}
	async saveDraft(input: DraftWrite): Promise<Draft> {
		const saved = {
			text: input.text,
			revision: input.revision + 1,
			...(input.imageIds?.length ? { imageIds: input.imageIds } : {}),
		};
		this.drafts.set(input.sessionId, saved);
		return saved;
	}

	getSnapshot(): Promise<SessionSnapshot | null> {
		return this.read();
	}
	async dispatch(command: CommandEnvelope): Promise<void> {
		this.commands.push(command);
		await this.execute(command);
	}
	subscribe(listener: (notification: PortNotification) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	emit(notification: PortNotification): void {
		for (const listener of this.listeners) listener(structuredClone(notification));
	}
}
