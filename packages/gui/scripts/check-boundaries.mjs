import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const logger = console;
const sourceRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("../src", import.meta.url)));
const violations = [];

/*
 * ========================================================================
 * 步骤1：静态检查架构依赖方向
 * ========================================================================
 * 数据源：TypeScript 与 Vue script 块，不执行被检查模块。
 * 操作：
 *   1) 用 TypeScript AST 检查导入、再导出与动态导入
 *   2) 状态层只依赖共享契约，Renderer 不接触后端运行时
 */
logger.info("开始检查 GUI 架构边界");
// 1.1 仅遍历产品源码，不扫描依赖、构建产物和测试替身。
function visitDirectory(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			visitDirectory(path);
			continue;
		}
		if (!/\.(?:ts|vue)$/.test(path)) continue;
		const layer = relative(sourceRoot, path).replaceAll("\\", "/").split("/")[0];
		const text = readFileSync(path, "utf8");
		const scripts = path.endsWith(".vue")
			? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
			: [text];
		for (const script of scripts) {
			const source = ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true);
			function inspect(node) {
				if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
					violations.push(`${relative(sourceRoot, path)}: 禁止动态导入`);
				}
				if (
					(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
					node.moduleSpecifier &&
					ts.isStringLiteral(node.moduleSpecifier)
				) {
					const specifier = node.moduleSpecifier.text;
					const internal = specifier.startsWith(".");
					const target = internal
						? relative(sourceRoot, resolve(dirname(path), specifier))
								.replaceAll("\\", "/")
								.split("/")[0]
						: "";
					const forbiddenRuntime = /^(?:node:|electron$|@earendil-works\/pi-)/.test(specifier);
					const allowedPure = internal
						? ["shared", "domain"].includes(target)
						: layer === "shared" && specifier === "zod";
					if (
						(["domain", "shared"].includes(layer) && !allowedPure) ||
						(layer === "renderer" &&
							(forbiddenRuntime || (internal && !["renderer", "domain", "shared"].includes(target))))
					) {
						violations.push(`${relative(sourceRoot, path)}: ${layer} 不允许依赖 ${specifier}`);
					}
				}
				ts.forEachChild(node, inspect);
			}
			inspect(source);
		}
	}
}

try {
	// 1.2 输出全部违规，CI 与本地共用相同门禁。
	visitDirectory(sourceRoot);
	for (const violation of violations) logger.error(violation);
	if (violations.length) process.exitCode = 1;
} finally {
	logger.info(`GUI 架构检查结束，违规数：${violations.length}`);
}
