import { describe, expect, it, vi } from "vitest";
import { applyFileCompletion, readFileCompletion } from "../src/domain/file-completion.ts";

const logger = { info: vi.fn() };

/*
 * ========================================================================
 * 步骤1：验证文件补全的范围与原文保护
 * ========================================================================
 * 数据源：中文、邮箱、引号、长文本和光标位于中间的草稿。
 * 操作：
 *   1) 只提取当前可查询片段，不把邮箱或跨行文字当成文件路径
 *   2) 替换只改变当前引用，旧草稿和伪造范围明确拒绝
 */
describe("file completion", () => {
	it("recognizes plain, quoted and empty queries using UTF-16 caret positions", () => {
		logger.info("开始验证文件补全识别");
		for (const [source, query] of [
			["@", ""],
			["请检查 @src/中文", "src/中文"],
			['下一步\n@"src/中文 文件', "src/中文 文件"],
			["表情😀 @src\\中文", "src\\中文"],
		]) {
			const target = readFileCompletion(source, source.length, source.length, logger);
			expect(target?.query).toBe(query);
			expect(target?.source).toBe(source);
			expect(target?.end).toBe(source.length);
		}
		logger.info("文件补全识别验证完成");
	});
	it("rejects emails, selections, finished references, multiline and excessive prefixes", () => {
		logger.info("开始验证文件补全边界");
		for (const source of [
			"dev@example.com",
			'@"src/file.ts" ',
			'@"src\nfile',
			"@src file",
			`@${"x".repeat(201)}`,
			"text without a reference",
		])
			expect(readFileCompletion(source, source.length, source.length, logger)).toBeNull();
		for (const [start, end] of [
			[0, 2],
			[-1, -1],
			[0.5, 0.5],
			[9, 9],
		])
			expect(readFileCompletion("@src", start, end, logger)).toBeNull();
		logger.info("文件补全边界验证完成");
	});
	it("replaces the whole plain or closed quoted token while preserving surrounding text", () => {
		logger.info("开始验证片段替换");
		for (const source of ["前文  @src/old.ts 后文\n", '前文  @"src/中文 旧.ts" 后文\n']) {
			const cursor = source.indexOf("src") + 3;
			const target = readFileCompletion(source, cursor, cursor, logger);
			if (!target) throw new Error("Completion missing");
			expect(applyFileCompletion(source, target, "src/中文 文件.ts", logger)).toBe('前文  @"src/中文 文件.ts" 后文\n');
		}
		const source = '@"src';
		const target = readFileCompletion(source, source.length, source.length, logger);
		if (!target) throw new Error("Completion missing");
		expect(applyFileCompletion(source, target, 'src/带"引号.ts', logger)).toBe('@"src/带\\"引号.ts" ');
		logger.info("片段替换验证完成");
	});
	it("does not erase suffix prose after an unfinished quote or accept stale spans", () => {
		logger.info("开始验证旧片段拒绝");
		const source = '前文 @"src 后文';
		const cursor = source.indexOf(" 后文");
		const target = readFileCompletion(source, cursor, cursor, logger);
		if (!target) throw new Error("Completion missing");
		expect(applyFileCompletion(source, target, "src/file.ts", logger)).toBe('前文 @"src/file.ts" 后文');
		expect(() => applyFileCompletion(`${source} 新输入`, target, "file.ts", logger)).toThrow("草稿已变化");
		expect(() => applyFileCompletion(source, { ...target, start: 0 }, "file.ts", logger)).toThrow("草稿已变化");
		expect(readFileCompletion(`@src${"x".repeat(5000)}`, 4, 4, logger)).toBeNull();
		logger.info("旧片段拒绝验证完成");
	});
});
