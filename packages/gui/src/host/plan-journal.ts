import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "../shared/logger.ts";
import { type PlanState, planStateSchema } from "../shared/plan.ts";
import { writeJsonAtomically } from "../storage/atomic-json.ts";

const recordSchema = z.object({
	version: z.literal(1),
	plan: planStateSchema,
	tools: z.array(z.string().min(1).max(4096)).max(1000),
});
type PlanRecord = z.infer<typeof recordSchema>;

/*
 * ========================================================================
 * 步骤1：原子保存计划状态和批准前的工具集合
 * ========================================================================
 * 数据源：已验证会话身份和宿主计划事件，不另存聊天消息。
 * 操作：1) 按会话隔离并串行保存；2) 重启把在途计划改为中断，不自动重放。
 */
export class PlanJournal {
	private readonly directory: string;
	private readonly name: string;
	private readonly logger: Logger;
	private pending = Promise.resolve();
	private record: PlanRecord = { version: 1, plan: { phase: "off", text: "" }, tools: [] };

	constructor(directory: string, cwd: string, sessionId: string, logger: Logger) {
		this.directory = directory;
		this.name = `plan-${createHash("sha256").update(`${cwd}\0${sessionId}`).digest("hex")}.json`;
		this.logger = logger;
	}

	get value(): PlanRecord {
		return structuredClone(this.record);
	}

	async load(): Promise<void> {
		this.logger.info("开始恢复计划状态");
		try {
			// 1.1 损坏文件保留原文，不能伪装成没有计划。
			try {
				this.record = recordSchema.parse(JSON.parse(await readFile(join(this.directory, this.name), "utf8")));
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
					throw new Error("计划记录无法读取，已保留原文件");
			}
			// 1.2 不把中断执行当成待发送任务，必须由用户核对后处理。
			if (this.record.plan.phase === "drafting" || this.record.plan.phase === "executing") {
				await this.save(
					{
						phase: "interrupted",
						text: this.record.plan.text,
						reason: "上次运行已中断，请先核对文件与聊天记录；重新批准会再次执行计划",
					},
					this.record.tools,
				);
			}
		} finally {
			this.logger.info("计划状态恢复结束");
		}
	}

	save(plan: PlanState, tools: string[]): Promise<void> {
		const record = recordSchema.parse({ version: 1, plan, tools });
		const operation = this.pending
			.catch(() => {})
			.then(async () => {
				this.logger.info("开始持久化计划状态");
				try {
					// 1.3 只在原子保存成功后更新恢复基线。
					await writeJsonAtomically(this.directory, this.name, record, this.logger);
					this.record = record;
				} finally {
					this.logger.info("计划状态持久化结束");
				}
			});
		this.pending = operation;
		return operation;
	}

	flush(): Promise<void> {
		return this.pending;
	}
}
