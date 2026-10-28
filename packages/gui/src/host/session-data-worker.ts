import { createLogger } from "../shared/logger.ts";
import { scanUsageHistory } from "./usage-reader.ts";

const logger = createLogger("session-data");
/*
 * ========================================================================
 * 步骤1：在独立只读进程扫描历史
 * ========================================================================
 * 数据源：主进程继承的 SDK 配置目录。
 * 操作：1) 不启动 Agent；2) 只回传统计和主进程可用的文件身份。
 */
logger.info("开始读取会话数据");
void scanUsageHistory(logger)
	.then(
		(value) => process.parentPort?.postMessage({ value }),
		(error: unknown) =>
			process.parentPort?.postMessage({ error: error instanceof Error ? error.message : "会话数据读取失败" }),
	)
	.finally(() => logger.info("会话数据读取结束"));
