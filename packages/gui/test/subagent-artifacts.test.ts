import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSubagentArtifact, readSubagentTranscript } from "../src/host/subagent-artifacts.ts";
import { hostResponseSchema } from "../src/shared/protocol.ts";
import { subagentOutputRequestSchema } from "../src/shared/subagents.ts";

const logger = console;
let directory = "";
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "subagent-artifacts-test-"));
});
afterEach(async () => {
	if (dirname(directory) !== tmpdir()) throw new Error("测试清理目录越界");
	await rm(directory, { recursive: true, force: true });
});

/*
 * ========================================================================
 * 步骤1：生成符合插件命名和首行格式的离线产物
 * ========================================================================
 * 数据源：独立临时目录、运行 ID 和 childIndex。
 * 操作：1) 同时写入转录与输出；2) 正文使用中文验证编码。
 */
async function artifact(runId: string, agent: string, index: number, text: string): Promise<void> {
	logger.info("开始生成子任务测试产物");
	try {
		// 1.1 产物名称与插件 getArtifactPaths 一致。
		const base = join(directory, "subagent-artifacts");
		await mkdir(base, { recursive: true });
		await writeFile(
			join(base, `${runId}_${agent}_${index}_transcript.jsonl`),
			`${JSON.stringify({ version: 1, recordType: "message", runId, agent, childIndex: index, role: "user", text })}\n`,
			"utf8",
		);
		await writeFile(join(base, `${runId}_${agent}_${index}_output.md`), text, "utf8");
	} finally {
		logger.info("子任务测试产物生成完成");
	}
}

/*
 * ========================================================================
 * 步骤2：验证标准索引、工作流映射和传输边界
 * ========================================================================
 * 数据源：平铺产物和当前会话工具结果，不读取真实用户会话。
 * 操作：1) 精确选择子任务；2) 缺失任务不借用其他任务，截断后仍符合协议。
 */
describe("subagent artifacts", () => {
	it("roundtrips step IDs and does not borrow unknown or missing child records", async () => {
		logger.info("开始验证子任务索引往返");
		try {
			// 2.1 文件排序与子任务顺序相反，不能依赖首个文件。
			await artifact("parallel", "z-worker", 0, "任务零");
			await artifact("parallel", "a-reviewer", 1, "任务一");
			expect(subagentOutputRequestSchema.parse({ runId: "parallel", childId: "step:1" }).childId).toBe("step:1");
			expect(await readSubagentArtifact(directory, "parallel", "step:1")).toBe("任务一");
			expect(await readSubagentTranscript(directory, "parallel", "step:0")).toContain("任务零");
			expect(await readSubagentTranscript(directory, "parallel", "step:9")).toBeNull();
			expect(await readSubagentTranscript(directory, "parallel", "missing-child")).toBeNull();
			expect(await readSubagentArtifact(directory, "parallel", "../outside")).toBeNull();
			await expect(readSubagentTranscript(directory, "../outside")).rejects.toThrow();
		} finally {
			logger.info("子任务索引往返验证完成");
		}
	});
	it("resolves only children belonging to the requested workflow", async () => {
		logger.info("开始验证工作流子任务归属");
		try {
			// 2.2 后写的无关运行不能覆盖当前工作流的同名业务键。
			await artifact("child-run", "worker", 0, "正确工作流");
			await artifact("other-run", "worker", 0, "无关工作流");
			const file = join(directory, "session.jsonl");
			await writeFile(
				file,
				[
					{
						message: {
							details: { workflowRunId: "workflow", childRuns: [{ workflowKey: "review:lint", runId: "child-run" }] },
						},
					},
					{
						message: {
							details: {
								workflowRunId: "other",
								childRuns: [{ workflowKey: "review:lint", runId: "other-run" }],
								note: "workflow",
							},
						},
					},
				]
					.map((record) => JSON.stringify(record))
					.join("\n"),
			);
			expect(await readSubagentArtifact(directory, "workflow", "review:lint", file)).toBe("正确工作流");
			expect(await readSubagentTranscript(directory, "workflow", "review:lint", file)).toContain("正确工作流");
		} finally {
			logger.info("工作流子任务归属验证完成");
		}
	});
	it("counts the truncation marker inside the host output budget", async () => {
		logger.info("开始验证输出传输上限");
		try {
			// 2.3 大输出不能让合法宿主回复被协议校验拒绝。
			await artifact("long-run", "worker", 0, "中".repeat(500001));
			const value = await readSubagentArtifact(directory, "long-run");
			expect(value?.length).toBe(500000);
			expect(value?.endsWith("[输出已截断]")).toBe(true);
			expect(hostResponseSchema.safeParse({ type: "subagentOutput", id: "request", value }).success).toBe(true);
		} finally {
			logger.info("输出传输上限验证完成");
		}
	});
});
