import { open, opendir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import ignore from "ignore";
import type { Logger } from "../shared/logger.ts";
import { PROJECT_FILE_LIMIT, type ProjectFileMatches } from "../shared/project-files.ts";
import { projectFilePathsSchema } from "../shared/workspace.ts";
import { resolveProjectFiles } from "./project-files.ts";

const ENTRY_LIMIT = 10_000;
const DEPTH_LIMIT = 32;
const SCAN_MS = 2000;
const IGNORE_BYTES_LIMIT = 64 * 1024;
const IGNORE_TOTAL_LIMIT = 256 * 1024;
type Scope = { base: string; rules: ReturnType<typeof ignore> };

/*
 * ========================================================================
 * 步骤1：有界读取当前目录的忽略规则
 * ========================================================================
 * 数据源：项目内普通 .gitignore 文件，不读取链接目标或文件正文。
 * 操作：
 *   1) 只把缺失文件当作无规则，其他失败明确拒绝查询
 *   2) 限制单个规则文件与读取字节，返回规则留给成熟解析器处理
 */
async function readRules(directory: string, logger: Logger): Promise<string> {
	logger.info("开始读取文件搜索忽略规则");
	try {
		// 1.1 解析后必须仍指向当前目录内的同名规则，不跟随规则链接。
		const path = join(directory, ".gitignore");
		let resolved: string;
		try {
			resolved = await realpath(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
			throw new Error("忽略规则无法读取，请使用原生文件选择");
		}
		if (relative(directory, resolved) !== ".gitignore") throw new Error("忽略规则不能是链接，请使用原生文件选择");
		const file = await open(resolved, "r");
		try {
			if (!(await file.stat()).isFile()) throw new Error("忽略规则不是普通文件");
			const buffer = Buffer.alloc(IGNORE_BYTES_LIMIT + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (length > IGNORE_BYTES_LIMIT) throw new Error("忽略规则过大，请使用原生文件选择");
			return buffer.toString("utf8", 0, length);
		} finally {
			await file.close();
		}
	} finally {
		logger.info("文件搜索忽略规则读取结束");
	}
}

/*
 * ========================================================================
 * 步骤2：查询项目内的有限文件名候选
 * ========================================================================
 * 数据源：项目目录条目与逐层 .gitignore，不读取候选文件内容。
 * 操作：
 *   1) 逐目录异步扫描，跳过链接、.git 和 node_modules，保留嵌套规则覆盖
 *   2) 数量、条目、深度或时间预算用尽时返回明确的不完整标记
 */
export async function searchProjectFiles(
	cwd: string,
	query: string,
	logger: Logger,
	signal: AbortSignal,
): Promise<ProjectFileMatches> {
	logger.info("开始查询项目文件");
	try {
		// 2.1 空查询不扫描；查询作为普通子串，不作路径、glob 或正则执行。
		signal.throwIfAborted();
		const term = query.trim().replaceAll("\\", "/").toLowerCase();
		if (!term) return { paths: [], incomplete: false };
		const root = await realpath(cwd).catch(() => {
			throw new Error("项目目录已失效");
		});
		if (!(await stat(root)).isDirectory()) throw new Error("项目目录已失效");
		const started = performance.now();
		const matches = new Set<string>();
		let entries = 0;
		let ignoreBytes = 0;
		let incomplete = false;
		const exhausted = () => {
			signal.throwIfAborted();
			if (entries >= ENTRY_LIMIT || performance.now() - started >= SCAN_MS || matches.size > PROJECT_FILE_LIMIT) {
				incomplete = true;
				return true;
			}
			return false;
		};
		async function visit(directory: string, local: string, scopes: Scope[], depth: number): Promise<void> {
			if (exhausted()) return;
			if (depth > DEPTH_LIMIT) {
				incomplete = true;
				return;
			}
			// 2.2 每层重新检查真实归属；不让目录被替换后的结果越过项目边界。
			const resolved = await realpath(directory);
			const location = relative(root, resolved);
			if (isAbsolute(location) || location.split(sep).includes("..")) {
				incomplete = true;
				return;
			}
			const text = await readRules(resolved, logger);
			ignoreBytes += Buffer.byteLength(text);
			if (ignoreBytes > IGNORE_TOTAL_LIMIT) throw new Error("项目忽略规则过多，请使用原生文件选择");
			const inherited = text ? [...scopes, { base: local, rules: ignore().add(text) }] : scopes;
			const folder = await opendir(resolved);
			for await (const entry of folder) {
				if (exhausted()) return;
				entries++;
				if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
				if (!entry.isDirectory() && !entry.isFile()) continue;
				const path = local + entry.name;
				if (!projectFilePathsSchema.safeParse([path]).success) continue;
				let ignored = false;
				for (const scope of inherited) {
					const decision = scope.rules.test(path.slice(scope.base.length) + (entry.isDirectory() ? "/" : ""));
					if (decision.ignored) ignored = true;
					else if (decision.unignored) ignored = false;
				}
				if (ignored) continue;
				if (entry.isDirectory()) {
					try {
						await visit(join(resolved, entry.name), `${path}/`, inherited, depth + 1);
					} catch (error) {
						if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM"].includes(String(error.code)))
							incomplete = true;
						else throw error;
					}
				} else if (path.toLowerCase().includes(term)) {
					// 2.3 候选返回前复用原生选择的真实路径校验，失效条目不伪装成有效引用。
					try {
						for (const valid of await resolveProjectFiles(root, [join(resolved, entry.name)], logger))
							matches.add(valid);
					} catch {
						incomplete = true;
					}
				}
			}
		}
		await visit(root, "", [], 0);
		signal.throwIfAborted();
		// 2.4 只对有界候选排序，不声称在被截断的目录中找到了全部匹配。
		const paths = [...matches].sort(
			(a, b) =>
				Number(basename(b).toLowerCase() === term) - Number(basename(a).toLowerCase() === term) || a.localeCompare(b),
		);
		return { paths: paths.slice(0, PROJECT_FILE_LIMIT), incomplete: incomplete || paths.length > PROJECT_FILE_LIMIT };
	} finally {
		logger.info("项目文件查询结束");
	}
}
