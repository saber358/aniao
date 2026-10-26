import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGoals } from "../src/main/goal-service.ts";

describe("readGoals", () => {
	it("reads an active goal file, tasks, current task and usage", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-goal-ui-"));
		try {
			const goals = join(root, ".pi/goals");
			await mkdir(goals, { recursive: true });
			const record = {
				version: 3,
				id: "goal-1",
				objective: "实现一个功能\n并补充测试",
				status: "active",
				autoContinue: true,
				sisyphus: false,
				usage: { tokensUsed: 12_300, activeSeconds: 95 },
				updatedAt: "2026-10-26T08:00:00.000Z",
				currentTaskId: "t2",
				taskList: {
					tasks: [
						{ id: "t1", title: "准备", status: "complete", completedAt: "2026-10-26T08:00:00.000Z" },
						{
							id: "t2",
							title: "实现",
							status: "pending",
							subtasks: [{ id: "t2a", title: "代码", status: "pending" }],
						},
					],
					blockCompletion: false,
					proposedAt: "2026-10-26T08:00:00.000Z",
				},
			};
			await writeFile(join(goals, "active_goal_1.md"), `${JSON.stringify(record)}\n\n# Goal Prompt\n`);
			const snapshot = await readGoals(root);
			expect(snapshot.goals).toHaveLength(1);
			expect(snapshot.goals[0]).toMatchObject({
				id: "goal-1",
				title: "实现一个功能",
				status: "running",
				progress: { completed: 1, total: 2, percentage: 50 },
				currentTask: { id: "t2", title: "实现" },
				usage: { tokensUsed: 12_300, activeSeconds: 95 },
			});
			expect(snapshot.goals[0].tasks.map((task) => [task.id, task.depth, task.current])).toEqual([
				["t1", 0, false],
				["t2", 0, true],
				["t2a", 1, false],
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
