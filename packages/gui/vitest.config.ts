import { defineConfig } from "vitest/config";
import { kernelDirectory, workspaceAliases } from "./config/workspace-aliases.ts";

/*
 * ========================================================================
 * 步骤1：限定 GUI 离线测试范围
 * ========================================================================
 * 目标：只运行本包用例，不发现仓库的付费模型或端点测试。
 * 操作：
 *   1) 复用开发入口别名
 *   2) 屏蔽通过用例的生命周期日志
 */
export default defineConfig({
	resolve: { alias: workspaceAliases },
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		env: { PI_PACKAGE_DIR: kernelDirectory },
		silent: "passed-only",
		testTimeout: 15000,
	},
});
