import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueJournal } from "../src/host/queue-journal.ts";

const logger = { info: vi.fn() };
const directories: string[] = [];

/*
 * ========================================================================
 * 步骤1：验证队列写前记录和保守恢复
 * ========================================================================
 * 数据源：临时目录；不读取用户会话或认证。
 * 操作：
 *   1) 保留重复文本和两类语义，收束后只保留尚未消费内容
 *   2) 损坏数据拒绝覆盖，清空与回滚只作用于本会话
 */
describe("QueueJournal", () => {
	afterEach(async () => {
		for (const directory of directories.splice(0)) {
			if (!resolve(directory).startsWith(resolve(tmpdir()))) throw new Error("Unexpected temporary directory");
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("keeps write-ahead records for manual review and checkpoints only after settlement", async () => {
		logger.info("开始验证队列写前恢复");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-queue-"));
		directories.push(directory);
		const journal = new QueueJournal(directory, "cwd", "session", logger);
		await journal.load();
		await journal.prepare("one", "followUp", "相同输入");
		await journal.prepare("two", "steer", "相同输入");
		const interrupted = new QueueJournal(directory, "cwd", "session", logger);
		await interrupted.load();
		expect(interrupted.recovery).toEqual({ steering: [{ text: "相同输入" }], followUp: [{ text: "相同输入" }] });
		await journal.checkpoint({ steering: [], followUp: [{ text: "剩余任务" }] });
		const settled = new QueueJournal(directory, "cwd", "session", logger);
		await settled.load();
		expect(settled.recovery).toEqual({ steering: [], followUp: [{ text: "剩余任务" }] });
		await settled.clear();
		const cleared = new QueueJournal(directory, "cwd", "session", logger);
		await cleared.load();
		expect(cleared.recovery).toEqual({ steering: [], followUp: [] });
		logger.info("队列写前恢复验证完成");
	});

	it("rolls back only the rejected request and isolates projects", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-queue-"));
		directories.push(directory);
		const journal = new QueueJournal(directory, "cwd", "s", logger);
		await journal.load();
		await journal.prepare("keep", "steer", "保留");
		await journal.prepare("late", "followUp", "迟到");
		await journal.rollback("late");
		const restored = new QueueJournal(directory, "cwd", "s", logger);
		await restored.load();
		expect(restored.recovery).toEqual({ steering: [{ text: "保留" }], followUp: [] });
		const other = new QueueJournal(directory, "other-cwd", "s", logger);
		await other.load();
		expect(other.count).toBe(0);
	});

	it("preserves malformed records for recovery", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-queue-"));
		directories.push(directory);
		const journal = new QueueJournal(directory, "cwd", "s", logger);
		await journal.load();
		await journal.prepare("one", "steer", "原文");
		const name = (await readdir(directory)).find((item) => item.startsWith("queue-"));
		if (!name) throw new Error("Journal fixture missing");
		const path = join(directory, name);
		await writeFile(path, "{broken", "utf8");
		const restored = new QueueJournal(directory, "cwd", "s", logger);
		await expect(restored.load()).rejects.toThrow("恢复记录无法读取");
		await expect(restored.clear()).rejects.toThrow("先读取");
		expect(await readFile(path, "utf8")).toBe("{broken");
	});

	/*
	 * ========================================================================
	 * 步骤2：验证单条编辑保持恢复顺序
	 * ========================================================================
	 * 数据源：交错的两类写前记录。
	 * 操作：1) 同模式原位替换；2) 改为引导时追加到引导末尾，撤销恢复原顺序。
	 */
	it("preserves edited order and appends steering changes within their mode", async () => {
		logger.info("开始验证单条修改恢复顺序");
		const directory = await mkdtemp(join(tmpdir(), "pi-gui-queue-"));
		directories.push(directory);
		const journal = new QueueJournal(directory, "cwd", "ordered", logger);
		try {
			// 2.1 编辑 B 不得将 B 放到 C 之后。
			await journal.load();
			for (const text of ["A", "B", "C"]) await journal.prepare(text, "followUp", text);
			await journal.prepare("X", "steer", "X");
			await journal.amend("B", { mode: "followUp", item: { text: "edited B" } });
			expect(journal.interrupted.followUp.map((item) => item.text)).toEqual(["A", "edited B", "C"]);
			const undo = await journal.amend("A", { mode: "steer", item: { text: "A" } });
			expect(journal.interrupted.steering.map((item) => item.text)).toEqual(["X", "A"]);
			await undo();
			const reloaded = new QueueJournal(directory, "cwd", "ordered", logger);
			await reloaded.load();
			expect(reloaded.recovery.followUp.map((item) => item.text)).toEqual(["A", "edited B", "C"]);
			expect(reloaded.recovery.steering).toEqual([{ text: "X" }]);
		} finally {
			logger.info("单条修改恢复顺序验证结束");
		}
	});
});
