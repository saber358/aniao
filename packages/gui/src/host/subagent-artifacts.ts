import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../shared/logger.ts";
import { subagentOutputRequestSchema } from "../shared/subagents.ts";

const ID = /^[A-Za-z0-9_-]+$/u;
const MAX_OUTPUT = 500_000;
const MAX_TRANSCRIPT = 2_000_000;
const logger = createLogger("subagent-artifacts");

/*
 * ========================================================================
 * 步骤1：读取已确认子任务的输出
 * ========================================================================
 * 数据源：当前会话目录中的固定产物路径。
 * 操作：1) 只将受限运行 ID 用作文件名；2) 输出和截断提示共用传输预算。
 */
export async function readSubagentArtifact(
	sessionDir: string,
	runId: string,
	childId?: string,
	sessionFile?: string,
): Promise<string | null> {
	subagentOutputRequestSchema.parse({ runId, childId });
	logger.info("开始读取子智能体输出产物");
	try {
		const base = join(sessionDir, "subagent-artifacts");
		const candidates = [
			...(childId && ID.test(childId) ? [join(base, "outputs", runId, `${childId}.md`)] : []),
			...(!childId || childId === runId ? [join(base, "outputs", runId, "output.md")] : []),
		];
		// 1.1 子任务先解析归属；只从已匹配转录推导平铺输出，不能借用其他任务结果。
		const target = await resolveArtifactTarget(sessionFile, runId, childId);
		if (target) {
			try {
				if (target.index !== undefined) {
					const transcript = await selectTranscript(base, target.runId, target.index);
					if (transcript) candidates.push(join(base, transcript.replace(/_transcript\.jsonl$/u, "_output.md")));
				} else {
					const files = (await readdir(base)).filter(
						(entry) => entry.startsWith(`${target.runId}_`) && entry.endsWith("_output.md"),
					);
					if (files.length === 1) candidates.push(join(base, files[0]));
				}
			} catch {
				// 运行尚未产生输出目录时返回 null。
			}
		}
		for (const path of candidates) {
			try {
				const text = await readFile(path, "utf8");
				const marker = "\n\n[输出已截断]";
				return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT - marker.length)}${marker}` : text;
			} catch {}
		}
		return null;
	} finally {
		logger.info("子智能体输出产物读取结束");
	}
}

/*
 * ========================================================================
 * 步骤2：读取归属明确的完整转录
 * ========================================================================
 * 数据源：当前会话映射与子任务索引。
 * 操作：1) 拒绝无法识别的任务；2) 返回有界转录而非其他任务记录。
 */
export async function readSubagentTranscript(
	sessionDir: string,
	runId: string,
	childId?: string,
	sessionFile?: string,
): Promise<string | null> {
	subagentOutputRequestSchema.parse({ runId, childId });
	logger.info("开始读取子智能体转录产物");
	try {
		const base = join(sessionDir, "subagent-artifacts");
		// 2.1 优先使用当前会话记录的工作流映射，再识别插件标准 step 索引。
		const target = await resolveArtifactTarget(sessionFile, runId, childId);
		if (!target) return null;
		const selected = await selectTranscript(base, target.runId, target.index);
		if (!selected) return null;
		try {
			const text = await readFile(join(base, selected), "utf8");
			return text.length > MAX_TRANSCRIPT ? text.slice(0, MAX_TRANSCRIPT) : text;
		} catch {
			return null;
		}
	} finally {
		logger.info("子智能体转录产物读取结束");
	}
}

/*
 * ========================================================================
 * 步骤3：按子任务索引选择唯一转录
 * ========================================================================
 * 数据源：固定产物目录与转录首行 childIndex。
 * 操作：1) 不使用 childId 拼路径；2) 不把缺失任务回退到第一份转录。
 */
async function selectTranscript(base: string, runId: string, index?: number): Promise<string | null> {
	logger.info("开始匹配子智能体转录");
	try {
		// 3.1 目录尚未建立时保留暂无记录语义。
		const files = (await readdir(base)).filter(
			(entry) => entry.startsWith(`${runId}_`) && entry.endsWith("_transcript.jsonl"),
		);
		if (index === undefined) return files.length === 1 ? files[0] : null;
		const matches: string[] = [];
		for (const file of files) {
			try {
				const record = JSON.parse((await readFile(join(base, file), "utf8")).split(/\r?\n/u, 1)[0]) as {
					childIndex?: number;
				};
				if ((record.childIndex ?? 0) === index) matches.push(file);
			} catch {}
		}
		return matches.length === 1 ? matches[0] : null;
	} catch {
		return null;
	} finally {
		logger.info("子智能体转录匹配结束");
	}
}

interface WorkflowChild {
	childId?: string;
	workflowKey?: string;
	runId?: string;
}

interface ToolDetails {
	runId?: string;
	workflowRunId?: string;
	workflowChildren?: { workflowRunId?: string; children?: WorkflowChild[] };
	childRuns?: WorkflowChild[];
	runs?: Array<{ runId?: string; childRuns?: WorkflowChild[] }>;
}

/*
 * ========================================================================
 * 步骤4：解析当前会话内的父子运行归属
 * ========================================================================
 * 数据源：工具结果中的 workflowChildren、childRuns 和标准子任务索引。
 * 操作：1) 核对父运行；2) 返回受限运行 ID，不接受任意文件路径。
 */
async function resolveArtifactTarget(
	sessionFile: string | undefined,
	workflowRunId: string,
	childId: string | undefined,
): Promise<{ runId: string; index?: number } | null> {
	logger.info("开始解析子智能体产物归属");
	try {
		// 4.1 根节点和单任务节点使用父运行自己的产物。
		if (!childId || childId === workflowRunId) return { runId: workflowRunId };
		if (sessionFile) {
			try {
				const lines = (await readFile(sessionFile, "utf8")).split(/\r?\n/u);
				for (let index = lines.length - 1; index >= 0; index--) {
					const line = lines[index];
					if (!line.includes(workflowRunId)) continue;
					let record: { message?: { details?: ToolDetails }; details?: ToolDetails };
					try {
						record = JSON.parse(line) as typeof record;
					} catch {
						continue;
					}
					const details = record.message?.details ?? record.details;
					if (!details) continue;
					const run = details.runs?.find((item) => item.runId === workflowRunId);
					const children =
						details.workflowChildren?.workflowRunId === workflowRunId
							? details.workflowChildren.children
							: details.runId === workflowRunId || details.workflowRunId === workflowRunId
								? details.childRuns
								: run?.childRuns;
					const match = children?.find((child) => (child.childId ?? child.workflowKey) === childId);
					if (match?.runId && ID.test(match.runId)) return { runId: match.runId };
				}
			} catch {
				// 会话文件不可读时回退到普通产物查找。
			}
		}
		// 4.2 step 从零开始，旧任务编号从一开始；无法识别的业务键交给官方查询。
		const step = /^step:(\d+)$/u.exec(childId);
		const task = /^task-([1-9]\d*)$/u.exec(childId);
		const index = step ? Number(step[1]) : task ? Number(task[1]) - 1 : undefined;
		return index !== undefined && Number.isSafeInteger(index) ? { runId: workflowRunId, index } : null;
	} finally {
		logger.info("子智能体产物归属解析结束");
	}
}
