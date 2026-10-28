import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const logger = console;
const root = fileURLToPath(new URL("../public/", import.meta.url));
const types = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript",
	".css": "text/css",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".txt": "text/plain",
};
const installers = resolve(root, "../../../packages/gui/artifacts/publish-0.80.23-20261028/installers");
const downloads = new Map([
	["Aniao-Harness-0.80.23-windows-x64-setup.exe", "Aniao-Harness-0.80.23-windows-x64-setup.exe"],
	["Aniao-Harness-0.80.23-linux-amd64.deb", "Aniao-Harness-0.80.23-linux-amd64.deb"],
	["aniao-0.80.23-SHA256SUMS.txt", "SHA256SUMS.txt"],
]);

/*
 * ========================================================================
 * 步骤1：提供限定目录的本地官网预览
 * ========================================================================
 * 数据源：版本化官网静态文件与已验收的两个安装包。
 * 操作：1) 页面限定 public；2) 下载只允许三个固定文件。
 */
logger.info("开始启动官网本地预览");
const server = createServer(async (request, response) => {
	try {
		// 1.1 仅接受静态资源，路径解析后再次检查目录边界。
		const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
		const download = pathname.startsWith("/downloads/") ? downloads.get(pathname.slice(11)) : undefined;
		const path = download
			? resolve(installers, download)
			: resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
		if (!download && !path.startsWith(root.endsWith(sep) ? root : root + sep)) {
			response.writeHead(403).end();
			return;
		}
		const info = await stat(path);
		if (!info.isFile()) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": types[extname(path)] ?? "application/octet-stream",
			"Content-Length": info.size,
			...(download ? { "Content-Disposition": `attachment; filename="${basename(pathname)}"` } : {}),
		});
		// 1.2 大安装包采用流式响应，浏览器退出后及时关闭读取流。
		if (request.method === "HEAD") response.end();
		else {
			const stream = createReadStream(path);
			stream.on("error", () => response.destroy());
			response.on("close", () => stream.destroy());
			stream.pipe(response);
		}
	} catch {
		response.writeHead(404).end();
	}
});
await new Promise((ready) => server.listen(4177, "127.0.0.1", ready));
logger.info("官网预览已就绪：http://127.0.0.1:4177");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
