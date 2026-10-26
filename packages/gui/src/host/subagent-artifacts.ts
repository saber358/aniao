import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ID = /^[A-Za-z0-9_-]+$/u;
const MAX_OUTPUT = 500_000;
const MAX_TRANSCRIPT = 2_000_000;

/*
 * 子智能体扩展把输出写在当前会话目录的 subagent-artifacts 下。
 * 只接受简单 ID，并在固定目录内查找候选文件，避免路径穿透。
 */
export async function readSubagentArtifact(
	sessionDir: string,
	runId: string,
	childId?: string,
): Promise<string | null> {
	if (!ID.test(runId) || (childId !== undefined && !ID.test(childId))) throw new Error("子智能体标识无效");
	const base = join(sessionDir, "subagent-artifacts");
	const candidates = [
		...(childId ? [join(base, "outputs", runId, `${childId}.md`)] : []),
		join(base, "outputs", runId, `${childId ?? "output"}.md`),
		join(base, "outputs", runId, "output.md"),
	];
	if (!childId) {
		try {
			for (const entry of await readdir(base)) {
				if (entry.startsWith(`${runId}_`) && entry.endsWith("_output.md")) candidates.push(join(base, entry));
			}
		} catch {
			// 运行尚未产生输出目录时返回 null。
		}
	}
	for (const path of candidates) {
		try {
			const text = await readFile(path, "utf8");
			return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n\n[输出已截断]` : text;
		} catch {}
	}
	return null;
}

export async function readSubagentTranscript(
	sessionDir: string,
	runId: string,
	childId?: string,
	sessionFile?: string,
): Promise<string | null> {
	if (!ID.test(runId) || (childId !== undefined && !ID.test(childId))) throw new Error("子智能体标识无效");
	const base = join(sessionDir, "subagent-artifacts");
	let entries: string[];
	try {
		entries = await readdir(base);
	} catch {
		return null;
	}
	const childMatch = childId ? /^task-(\d+)$/u.exec(childId) : null;
	const targetIndex = childMatch ? Number(childMatch[1]) - 1 : undefined;
	let files = entries.filter((entry) => entry.startsWith(`${runId}_`) && entry.endsWith("_transcript.jsonl"));
	// 工作流状态里的 runId 是父 run；子任务产物使用各自的 child runId，从会话工具结果中取映射。
	if (files.length === 0 && childId && sessionFile) {
		const childRunId = await resolveWorkflowChildRunId(sessionFile, runId, childId);
		if (childRunId)
			files = entries.filter((entry) => entry.startsWith(`${childRunId}_`) && entry.endsWith("_transcript.jsonl"));
	}
	const found: Array<{ file: string; childIndex: number }> = [];
	for (const file of files) {
		const path = join(base, file);
		try {
			const first = (await readFile(path, "utf8")).split(/\r?\n/u, 1)[0];
			const record = JSON.parse(first) as { childIndex?: number };
			found.push({ file, childIndex: typeof record.childIndex === "number" ? record.childIndex : 0 });
		} catch {}
	}
	if (found.length === 0) return null;
	const selected =
		(targetIndex !== undefined ? found.find((entry) => entry.childIndex === targetIndex) : undefined) ??
		(targetIndex !== undefined
			? [...found].sort((left, right) => left.childIndex - right.childIndex || left.file.localeCompare(right.file))[
					targetIndex
				]
			: found[0]) ??
		found[0];
	try {
		const text = await readFile(join(base, selected.file), "utf8");
		return text.length > MAX_TRANSCRIPT ? text.slice(0, MAX_TRANSCRIPT) : text;
	} catch {
		return null;
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

async function resolveWorkflowChildRunId(
	sessionFile: string,
	workflowRunId: string,
	childId: string,
): Promise<string | undefined> {
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
			const children = details.workflowChildren?.children ?? details.childRuns ?? details.runs?.[0]?.childRuns;
			const match = children?.find((child) => (child.childId ?? child.workflowKey) === childId);
			if (match?.runId && ID.test(match.runId)) return match.runId;
		}
	} catch {
		// 会话文件不可读时回退到普通产物查找。
	}
	return undefined;
}
