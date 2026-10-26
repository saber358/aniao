import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GoalSnapshot, GoalTaskStatus, GoalTaskView, GoalView } from "../shared/goals.ts";

interface StoredTask {
	id?: unknown;
	title?: unknown;
	status?: unknown;
	subtasks?: unknown;
	verificationContract?: unknown;
	evidence?: unknown;
}

interface StoredGoal {
	id?: unknown;
	objective?: unknown;
	status?: unknown;
	autoContinue?: unknown;
	sisyphus?: unknown;
	skipAuditor?: unknown;
	usage?: { tokensUsed?: unknown; activeSeconds?: unknown };
	taskList?: { tasks?: unknown };
	currentTaskId?: unknown;
	verificationContract?: unknown;
	pauseReason?: unknown;
	activePath?: unknown;
	updatedAt?: unknown;
}

function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < content.length; index++) {
		const char = content[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return index;
	}
	return -1;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integerValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function taskStatus(value: unknown): GoalTaskStatus {
	return value === "complete" || value === "skipped" ? value : "pending";
}

function flattenTasks(raw: unknown, depth = 0): GoalTaskView[] {
	if (!Array.isArray(raw) || depth > 12) return [];
	const result: GoalTaskView[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const task = item as StoredTask;
		const id = stringValue(task.id);
		const title = stringValue(task.title);
		if (!id || !title) continue;
		result.push({
			id,
			title,
			status: taskStatus(task.status),
			depth,
			current: false,
			...(stringValue(task.verificationContract)
				? { verificationContract: stringValue(task.verificationContract) }
				: {}),
			...(stringValue(task.evidence) ? { evidence: stringValue(task.evidence) } : {}),
		});
		if (Array.isArray(task.subtasks)) result.push(...flattenTasks(task.subtasks, depth + 1));
	}
	return result;
}

function objectiveTitle(objective: string): string {
	const line = objective
		.split(/\r?\n/u)
		.map((item) => item.replace(/^#+\s*/u, "").trim())
		.find(Boolean);
	return (line ?? objective).slice(0, 500);
}

function toGoalView(raw: StoredGoal, activePath: string): GoalView | null {
	const id = stringValue(raw.id);
	const objective = stringValue(raw.objective);
	if (!id || !objective) return null;
	const tasks = flattenTasks(raw.taskList?.tasks);
	const currentTaskId = stringValue(raw.currentTaskId);
	const current =
		tasks.find((task) => task.id === currentTaskId && task.status === "pending") ??
		tasks.find((task) => task.status === "pending");
	for (const task of tasks) task.current = task.id === current?.id;
	const topLevel = tasks.filter((task) => task.depth === 0);
	const completed = topLevel.filter((task) => task.status === "complete" || task.status === "skipped").length;
	const status: "active" | "paused" | "blocked" | "budget_limited" =
		raw.status === "paused" || raw.status === "blocked" || raw.status === "budget_limited" ? raw.status : "active";
	const autoContinue = raw.autoContinue !== false;
	return {
		id,
		title: objectiveTitle(objective),
		objective: objective.slice(0, 20_000),
		status: status === "active" ? (autoContinue ? "running" : "idle") : status,
		autoContinue,
		sisyphus: raw.sisyphus === true,
		auditor: raw.skipAuditor !== true,
		usage: {
			tokensUsed: integerValue(raw.usage?.tokensUsed),
			activeSeconds: integerValue(raw.usage?.activeSeconds),
		},
		...(topLevel.length
			? {
					progress: {
						completed,
						total: topLevel.length,
						percentage: Math.round((completed / topLevel.length) * 100),
					},
				}
			: {}),
		...(current ? { currentTask: { id: current.id, title: current.title } } : {}),
		tasks,
		...(stringValue(raw.verificationContract) ? { verificationContract: stringValue(raw.verificationContract) } : {}),
		...(stringValue(raw.pauseReason) ? { pauseReason: stringValue(raw.pauseReason) } : {}),
		activePath,
		...(stringValue(raw.updatedAt) ? { updatedAt: stringValue(raw.updatedAt) } : {}),
	};
}

export async function readGoals(cwd: string, sessionId?: string): Promise<GoalSnapshot> {
	const root = resolve(cwd, ".pi/goals");
	const generatedAt = Date.now();
	const focusedGoalId = sessionId ? await readFocusedGoalId(sessionId) : undefined;
	if (sessionId && !focusedGoalId) return { goals: [], generatedAt };
	let names: string[];
	try {
		names = (await readdir(root)).filter((name) => /^active_goal_.*\.md$/u.test(name)).sort();
	} catch {
		return { goals: [], generatedAt };
	}
	const goals: GoalView[] = [];
	for (const name of names.slice(0, 20)) {
		const path = join(root, name);
		try {
			const stat = await lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			const content = await readFile(path, "utf8");
			const end = findJsonObjectEnd(content);
			if (end < 0) continue;
			const raw = JSON.parse(content.slice(0, end + 1)) as StoredGoal;
			const goal = toGoalView(raw, `.pi/goals/${name}`);
			if (goal && (!focusedGoalId || goal.id === focusedGoalId)) goals.push(goal);
		} catch {
			// 目标文件可能正在原子替换；下一次轮询会重试。
		}
	}
	goals.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
	return { goals, generatedAt };
}

async function readFocusedGoalId(sessionId: string): Promise<string | null | undefined> {
	const root = join(homedir(), ".pi", "agent", "sessions");
	let dirs: string[];
	try {
		dirs = (await readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return undefined;
	}
	for (const dir of dirs) {
		let files: string[];
		try {
			files = await readdir(join(root, dir));
		} catch {
			continue;
		}
		const file = files.find((name) => name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`));
		if (!file) continue;
		try {
			const lines = (await readFile(join(root, dir, file), "utf8")).split(/\r?\n/u);
			for (let index = lines.length - 1; index >= 0; index--) {
				const line = lines[index];
				if (!line.includes("pi-goal-focus")) continue;
				const record = JSON.parse(line) as {
					customType?: string;
					data?: { focusedGoalId?: unknown };
				};
				if (record.customType !== "pi-goal-focus") continue;
				return typeof record.data?.focusedGoalId === "string" ? record.data.focusedGoalId : null;
			}
			return null;
		} catch {
			return undefined;
		}
	}
	return undefined;
}
