import { resolveConfig as resolveDesktopConfig } from "electron-vite";
import { resolveConfig as resolveRendererConfig } from "vite";

const logger = console;

/*
 * ========================================================================
 * 步骤1：为干净工作区准备 UI 主题声明
 * ========================================================================
 * 数据源：与 dev 相同的 Renderer 配置。
 * 操作：
 *   1) 只解析配置并运行官方声明生成钩子
 *   2) 不编译、不启动服务，也不启动 Electron
 */
logger.info("开始准备 UI 类型声明");
// 1.1 让 Nuxt UI 在类型检查前生成 #build/ui 的真实声明。
const { config } = await resolveDesktopConfig({}, "serve");
if (!config?.renderer) throw new Error("Renderer 配置不存在");
await resolveRendererConfig(config.renderer, "serve");
logger.info("UI 类型声明准备完成");
