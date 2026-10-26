import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensionsCached } from "../src/core/extensions/loader.ts";

const logger = console;

/*
 * ========================================================================
 * 步骤1：验证模块模式切换不会复用另一宿主的工厂
 * ========================================================================
 * 数据源：临时扩展文件和真实 Jiti 工厂缓存，不调用模型。
 * 操作：
 *   1) 相同目录与模式继续复用模块
 *   2) 文件系统宿主和虚拟宿主切换时使旧缓存失效
 */
describe("extension module mode", () => {
	it("isolates cached factories by module mode", async () => {
		logger.info("开始验证模块模式缓存");
		const temporaryRoot = resolve(tmpdir());
		const directory = await mkdtemp(join(temporaryRoot, "pi-module-mode-"));
		if (dirname(resolve(directory)) !== temporaryRoot) throw new Error("测试清理目录越界");
		clearExtensionCache();
		try {
			// 1.1 同模式加载仍使用第一次编译的模块，工厂每次重新注册。
			const entry = join(directory, "extension.ts");
			await writeFile(entry, 'export default (pi) => pi.registerCommand("first", { handler: async () => {} });');
			const first = await loadExtensionsCached([entry], directory, undefined, undefined, "virtual");
			expect(first.errors).toEqual([]);
			expect([...first.extensions[0].commands.keys()]).toEqual(["first"]);
			await writeFile(entry, 'export default (pi) => pi.registerCommand("second", { handler: async () => {} });');
			const cached = await loadExtensionsCached([entry], directory, undefined, undefined, "virtual");
			expect([...cached.extensions[0].commands.keys()]).toEqual(["first"]);
			// 1.2 即使另一模式没有扩展，回到原模式也必须重新加载。
			await loadExtensionsCached([], directory, undefined, undefined, "filesystem");
			const switched = await loadExtensionsCached([entry], directory, undefined, undefined, "virtual");
			expect(switched.errors).toEqual([]);
			expect([...switched.extensions[0].commands.keys()]).toEqual(["second"]);
		} finally {
			clearExtensionCache();
			await rm(directory, { recursive: true, force: true });
			logger.info("模块模式缓存验证完成");
		}
	});
});
