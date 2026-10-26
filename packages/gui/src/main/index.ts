import { app, dialog } from "electron";
import { createLogger } from "../shared/logger.ts";
import { PRODUCT_NAME } from "../shared/product.ts";
import { startApplication } from "./application.ts";

const logger = createLogger("main");

/*
 * ========================================================================
 * 步骤1：处理桌面启动结果
 * ========================================================================
 * 数据源：桌面组合入口，不在入口堆放业务逻辑。
 * 操作：
 *   1) 展示可诊断的启动失败
 *   2) 失败后退出，避免留下空白窗口或宿主
 */
logger.info(`开始启动 ${PRODUCT_NAME} 桌面端`);
// 1.1 业务异常统一落在组合边界。
startApplication()
	.then(() => logger.info(`${PRODUCT_NAME} 桌面端启动完成`))
	.catch((error: unknown) => {
		logger.info(`${PRODUCT_NAME} 桌面端启动失败`);
		dialog.showErrorBox(`${PRODUCT_NAME} 启动失败`, error instanceof Error ? error.message : "未知启动错误");
		app.quit();
	});
