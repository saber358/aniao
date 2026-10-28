import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type ArchivePolicy, archivePolicySchema } from "../shared/data-statistics.ts";
import type { Logger } from "../shared/logger.ts";
import {
	type Draft,
	type DraftWrite,
	draftSchema,
	type SessionChange,
	type SessionItem,
	type SessionSummary,
	sessionIdSchema,
	sessionItemSchema,
} from "../shared/workspace.ts";
import { writeJsonAtomically } from "../storage/atomic-json.ts";
import { ImageStore } from "../storage/image-store.ts";

const savedSessionSchema = sessionItemSchema.extend({ cwd: z.string().min(1).max(4096) });
const indexSchema = z.object({
	version: z.literal(1),
	active: z.object({ cwd: z.string().min(1).max(4096), id: sessionIdSchema }).nullable(),
	projects: z.array(z.string().min(1).max(4096)).max(500).default([]),
	projectNames: z.record(z.string().min(1).max(4096), z.string().min(1).max(100)).default({}),
	sessions: z.array(savedSessionSchema).max(20000),
	archivePolicy: archivePolicySchema.default({ enabled: false, retentionDays: 7 }),
	archiveRestoredAt: z.record(sessionIdSchema, z.number().nonnegative()).default({}),
});
type Index = z.infer<typeof indexSchema>;
type SavedSession = z.infer<typeof savedSessionSchema>;
const SESSION_BATCH_LIMIT = 200;
const PROJECT_LIMIT = 500;

function projectList(projects: string[], sessions: SavedSession[], active: Index["active"]): string[] {
	const values = [...projects, ...sessions.map((item) => item.cwd), ...(active ? [active.cwd] : [])];
	return [...new Set(values)].slice(0, PROJECT_LIMIT);
}

/*
 * ========================================================================
 * 步骤1：原子保存桌面组织信息与独立草稿
 * ========================================================================
 * 数据源：用户明确选择的会话、组织操作和输入草稿。
 * 操作：
 *   1) 串行读改写，临时文件同步后替换，失败不发布内存状态
 *   2) 草稿独立存储，界面重载后的旧修订不能覆盖新内容
 */
export class WorkspaceStore {
	readonly images: ImageStore;
	private readonly directory: string;
	private readonly logger: Logger;
	private pending: Promise<unknown> = Promise.resolve();
	private index?: Index;

	constructor(directory: string, logger: Logger) {
		this.directory = directory;
		this.logger = logger;
		this.images = new ImageStore(directory, logger);
	}

	private async readIndex(): Promise<Index> {
		if (this.index) return this.index;
		try {
			const parsed = indexSchema.parse(JSON.parse(await readFile(join(this.directory, "index.json"), "utf8")));
			this.index = { ...parsed, projects: projectList(parsed.projects, parsed.sessions, parsed.active) };
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
				throw new Error("工作区索引无法读取，请保留原文件后检查");
			this.index = {
				version: 1,
				active: null,
				projects: [],
				projectNames: {},
				sessions: [],
				archivePolicy: { enabled: false, retentionDays: 7 },
				archiveRestoredAt: {},
			};
		}
		return this.index;
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation);
		this.pending = result.catch(() => {});
		return result;
	}

	async active(): Promise<Index["active"]> {
		await this.pending;
		return (await this.readIndex()).active;
	}

	async projects(): Promise<string[]> {
		await this.pending;
		return [...(await this.readIndex()).projects];
	}

	async projectName(cwd: string): Promise<string | undefined> {
		await this.pending;
		return (await this.readIndex()).projectNames[cwd];
	}

	renameProject(cwd: string, name: string): Promise<void> {
		return this.serialize(async () => {
			const current = await this.readIndex();
			if (!current.projects.includes(cwd)) throw new Error("工作区已不在列表中");
			if (current.projectNames[cwd] === name) return;
			const next: Index = {
				...current,
				projectNames: { ...current.projectNames, [cwd]: name },
			};
			await writeJsonAtomically(this.directory, "index.json", next, this.logger);
			this.index = next;
		});
	}

	removeProject(cwd: string): Promise<void> {
		return this.serialize(async () => {
			const current = await this.readIndex();
			if (!current.projects.includes(cwd)) throw new Error("工作区已不在列表中");
			const { [cwd]: _name, ...projectNames } = current.projectNames;
			const next: Index = {
				...current,
				active: current.active?.cwd === cwd ? null : current.active,
				projects: current.projects.filter((item) => item !== cwd),
				projectNames,
				sessions: current.sessions.filter((item) => item.cwd !== cwd),
			};
			await writeJsonAtomically(this.directory, "index.json", next, this.logger);
			this.index = next;
		});
	}

	async findSession(sessionId: string): Promise<SavedSession | undefined> {
		await this.pending;
		const found = (await this.readIndex()).sessions.find((item) => item.id === sessionId);
		return found ? { ...found } : undefined;
	}

	rememberProject(cwd: string): Promise<void> {
		return this.serialize(async () => {
			const current = await this.readIndex();
			if (current.projects.includes(cwd)) return;
			const next: Index = {
				...current,
				projects: projectList([...current.projects, cwd], current.sessions, current.active),
			};
			await writeJsonAtomically(this.directory, "index.json", next, this.logger);
			this.index = next;
		});
	}

	rememberSessions(cwd: string, entries: SessionSummary[]): Promise<void> {
		return this.serialize(async () => {
			/*
			 * ========================================================================
			 * 步骤2：刷新会话摘要并保留已保存的列表顺序
			 * ========================================================================
			 * 数据源：当前索引顺序与 SDK 返回的最新摘要。
			 * 操作：1) 旧会话只更新内容；2) 新会话放在前面，未落盘身份继续保留。
			 */
			this.logger.info("开始刷新会话摘要和固定顺序");
			try {
				const current = await this.readIndex();
				const previous = new Map(
					current.sessions.filter((item) => item.cwd === cwd).map((item) => [item.id, item] as const),
				);
				// 2.1 SDK 修改时间只影响显示，不再影响已存在会话的位置。
				const latest = new Map(
					entries.slice(0, SESSION_BATCH_LIMIT).map(
						(entry) =>
							[
								entry.id,
								{
									...entry,
									cwd,
									pinned: previous.get(entry.id)?.pinned ?? false,
									archived: previous.get(entry.id)?.archived ?? false,
								},
							] as const,
					),
				);
				const sessions: SavedSession[] = [
					...[...latest.values()].filter((item) => !previous.has(item.id)),
					...[...previous.values()].flatMap((item) => {
						const summary = latest.get(item.id);
						return summary ? [summary] : item.persisted ? [] : [item];
					}),
				];
				const all = [...current.sessions.filter((item) => item.cwd !== cwd), ...sessions];
				const next: Index = {
					...current,
					projects: projectList([...current.projects, cwd], all, current.active),
					sessions: all,
				};
				if (JSON.stringify(current) === JSON.stringify(next)) return;
				await writeJsonAtomically(this.directory, "index.json", next, this.logger);
				this.index = next;
			} finally {
				this.logger.info("会话摘要和固定顺序刷新结束");
			}
		});
	}

	async sessions(cwd: string): Promise<SessionItem[]> {
		await this.pending;
		return (await this.readIndex()).sessions
			.filter((item) => item.cwd === cwd)
			.map(({ cwd: _cwd, ...item }) => ({ ...item }));
	}

	/*
	 * ========================================================================
	 * 步骤3：原子保存归档策略和批量归档状态
	 * ========================================================================
	 * 数据源：桌面索引里的已登记会话，不接收外部文件路径。
	 * 操作：1) 批量写入一次持久化；2) 删除身份时清除活动引用，其他会话位置不变。
	 */
	async allSessions(): Promise<SavedSession[]> {
		await this.pending;
		return (await this.readIndex()).sessions.map((item) => ({ ...item }));
	}
	async archivePolicy(): Promise<ArchivePolicy> {
		await this.pending;
		return { ...(await this.readIndex()).archivePolicy };
	}
	async archiveRestoredAt(): Promise<Record<string, number>> {
		await this.pending;
		return { ...(await this.readIndex()).archiveRestoredAt };
	}
	setArchivePolicy(policy: ArchivePolicy): Promise<void> {
		return this.serialize(async () => {
			this.logger.info("开始保存自动归档策略");
			try {
				const current = await this.readIndex();
				const next = { ...current, archivePolicy: archivePolicySchema.parse(policy) };
				await writeJsonAtomically(this.directory, "index.json", next, this.logger);
				this.index = next;
			} finally {
				this.logger.info("自动归档策略保存结束");
			}
		});
	}
	setArchived(sessionIds: string[], archived: boolean): Promise<void> {
		return this.serialize(async () => {
			this.logger.info("开始批量更新归档状态");
			try {
				const current = await this.readIndex();
				const ids = new Set(sessionIds);
				if (current.sessions.filter((item) => ids.has(item.id)).length !== ids.size)
					throw new Error("部分会话已不在列表中");
				const archiveRestoredAt = { ...current.archiveRestoredAt };
				if (!archived) for (const id of ids) archiveRestoredAt[id] = Date.now();
				const next = {
					...current,
					archiveRestoredAt,
					sessions: current.sessions.map((item) => (ids.has(item.id) ? { ...item, archived } : item)),
				};
				await writeJsonAtomically(this.directory, "index.json", next, this.logger);
				this.index = next;
			} finally {
				this.logger.info("归档状态批量更新结束");
			}
		});
	}
	forgetSession(sessionId: string): Promise<void> {
		return this.serialize(async () => {
			this.logger.info("开始移除已删除会话身份");
			try {
				const current = await this.readIndex();
				const archiveRestoredAt = { ...current.archiveRestoredAt };
				delete archiveRestoredAt[sessionId];
				const next = {
					...current,
					archiveRestoredAt,
					active: current.active?.id === sessionId ? null : current.active,
					sessions: current.sessions.filter((item) => item.id !== sessionId),
				};
				await writeJsonAtomically(this.directory, "index.json", next, this.logger);
				this.index = next;
			} finally {
				this.logger.info("已删除会话身份移除结束");
			}
		});
	}

	remember(cwd: string, session: SessionItem, active = false): Promise<void> {
		return this.serialize(async () => {
			this.logger.info("开始保存会话组织信息");
			try {
				const current = await this.readIndex();
				const previous = current.sessions.find((item) => item.cwd === cwd && item.id === session.id);
				const saved = {
					...session,
					pinned: previous?.pinned ?? session.pinned,
					archived: previous?.archived ?? session.archived,
					cwd,
				};
				const sessions = previous
					? current.sessions.map((item) => (item === previous ? saved : item))
					: [saved, ...current.sessions];
				const activeRef = active ? { cwd, id: session.id } : current.active;
				const next: Index = {
					...current,
					projects: projectList([...current.projects, cwd], sessions, activeRef),
					sessions,
					active: activeRef,
				};
				if (JSON.stringify(current) === JSON.stringify(next)) return;
				await writeJsonAtomically(this.directory, "index.json", next, this.logger);
				this.index = next;
			} finally {
				this.logger.info("会话组织信息保存结束");
			}
		});
	}

	update(cwd: string, change: SessionChange): Promise<void> {
		return this.serialize(async () => {
			this.logger.info("开始更新会话偏好");
			try {
				const current = await this.readIndex();
				const index = current.sessions.findIndex((item) => item.cwd === cwd && item.id === change.sessionId);
				if (index < 0) throw new Error("会话已不在当前项目中");
				const { sessionId: _id, ...patch } = change;
				const next = {
					...current,
					sessions: [...current.sessions],
					archiveRestoredAt: { ...current.archiveRestoredAt },
				};
				if (change.archived === false) next.archiveRestoredAt[change.sessionId] = Date.now();
				next.sessions[index] = { ...next.sessions[index], ...patch };
				await writeJsonAtomically(this.directory, "index.json", next, this.logger);
				this.index = next;
			} finally {
				this.logger.info("会话偏好更新结束");
			}
		});
	}

	private draftName(cwd: string, sessionId: string): string {
		return `draft-${createHash("sha256").update(`${cwd}\0${sessionId}`).digest("hex")}.json`;
	}

	async loadDraft(cwd: string, sessionId: string): Promise<Draft> {
		await this.pending;
		return this.readDraft(cwd, sessionId);
	}

	private async readDraft(cwd: string, sessionId: string): Promise<Draft> {
		try {
			return draftSchema.parse(
				JSON.parse(await readFile(join(this.directory, this.draftName(cwd, sessionId)), "utf8")),
			);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return { text: "", revision: 0 };
			throw new Error("草稿无法读取，请保留原文件后检查");
		}
	}

	saveDraft(cwd: string, input: DraftWrite): Promise<Draft> {
		return this.serialize(async () => {
			this.logger.info("开始保存会话草稿");
			try {
				// 1.2 只接受当前修订，错误恢复后不重放旧界面写入。
				const current = await this.readDraft(cwd, input.sessionId);
				if (current.revision !== input.revision) throw new Error("草稿已在其他界面更新，请先复制当前输入再重载");
				if (
					current.text === input.text &&
					JSON.stringify(current.imageIds ?? []) === JSON.stringify(input.imageIds ?? [])
				)
					return current;
				const next = {
					text: input.text,
					revision: current.revision + 1,
					...(input.imageIds?.length ? { imageIds: input.imageIds } : {}),
				};
				await writeJsonAtomically(this.directory, this.draftName(cwd, input.sessionId), next, this.logger);
				return next;
			} finally {
				this.logger.info("会话草稿保存结束");
			}
		});
	}

	async flush(): Promise<void> {
		await this.pending;
	}
}
