import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ProjectFilePreview } from "../shared/project-browser.ts";

const run = promisify(execFile);
const DOCUMENT_EXTENSIONS = new Set([".docx", ".doc", ".odt", ".rtf"]);
const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

/*
 * ========================================================================
 * 步骤1：生成右侧只读文件预览
 * ========================================================================
 * 数据源：项目内已解析的绝对路径。
 * 操作：
 *   1) 文本和图片直接读取，限制大小
 *   2) Office 文档通过本机 LibreOffice 转纯文本，避免执行文档脚本
 *   3) PDF 交给 Chromium 内置预览
 */
export async function previewProjectFile(target: string, path: string): Promise<ProjectFilePreview> {
	const info = await stat(target);
	if (!info.isFile()) throw new Error("目标不是文件");
	const extension = extname(target).toLowerCase();
	if (extension === ".pdf") {
		return { kind: "pdf", path, url: pathToFileURL(target).href };
	}
	if (IMAGE_TYPES[extension]) {
		if (info.size > 8 * 1024 * 1024) return { kind: "unsupported", path };
		const data = await readFile(target);
		return { kind: "image", path, dataUrl: `data:${IMAGE_TYPES[extension]};base64,${data.toString("base64")}` };
	}
	if (DOCUMENT_EXTENSIONS.has(extension)) {
		const text = await convertDocument(target);
		if (text === undefined) return { kind: "unsupported", path };
		return { kind: "document", path, text, format: extension.slice(1).toUpperCase() };
	}
	if (info.size > 1.5 * 1024 * 1024) return { kind: "unsupported", path };
	const data = await readFile(target);
	if (data.includes(0)) return { kind: "unsupported", path };
	return { kind: "text", path, text: data.toString("utf8"), truncated: false };
}

async function convertDocument(target: string): Promise<string | undefined> {
	const soffice = [
		"C:\\Program Files\\LibreOffice\\program\\soffice.exe",
		"C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
	].find((candidate) => existsSync(candidate));
	if (!soffice) return undefined;
	const directory = await mkdtemp(join(tmpdir(), "aniao-file-preview-"));
	const profile = join(directory, "profile");
	try {
		const output = join(directory, "out");
		await run(
			soffice,
			[
				"--headless",
				"--norestore",
				"--nolockcheck",
				"--nodefault",
				"--nofirststartwizard",
				`-env:UserInstallation=${pathToFileURL(profile).href}`,
				"--convert-to",
				"txt:Text",
				"--outdir",
				output,
				target,
			],
			{ timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
		);
		const files = await readdir(output).catch(() => []);
		const converted = files.find((file) => extname(file).toLowerCase() === ".txt");
		if (!converted) return undefined;
		return (await readFile(join(output, converted), "utf8")).slice(0, 2_000_000);
	} catch {
		return undefined;
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}
