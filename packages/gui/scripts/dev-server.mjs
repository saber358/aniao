import { resolveConfig } from "electron-vite";
import { build, createServer } from "vite";

const logger = console;

/*
 * ========================================================================
 * 步骤1：准备可独立连接的桌面开发服务
 * ========================================================================
 * 数据源：与正常 dev 命令相同的 electron-vite 配置。
 * 操作：
 *   1) 用开发配置编译 main/preload，不运行生产构建
 *   2) 启动 Renderer 服务，让 Electron 验收脚本持有窗口生命周期
 */
logger.info("开始准备桌面开发服务");
const { config } = await resolveConfig({}, "serve");
if (!config?.main || !config.preload || !config.renderer) throw new Error("桌面开发配置不完整");
// 1.1 依次编译，避免在 preload 准备好前启动 Electron。
await build(config.main);
await build(config.preload);
const server = await createServer(config.renderer);
await server.listen();
server.printUrls();
logger.info("桌面开发服务已就绪");
// 1.2 进程退出时释放监听端口，Vite 自身持有开发期间的生命周期。
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, async () => {
		await server.close();
		process.exit(0);
	});
}
