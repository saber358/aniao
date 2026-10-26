export interface Logger {
	info(message: string): void;
}

/*
 * ========================================================================
 * 步骤1：建立各进程共用的日志入口
 * ========================================================================
 * 目标：用作用域定位生命周期，不记录提示词、凭据或工具内容。
 * 操作：
 *   1) 由组合入口选择日志作用域
 *   2) 允许测试注入独立日志接收器
 */
export function createLogger(scope: string): Logger {
	const logger = console;
	logger.info(`[${scope}] 日志已初始化`);
	// 1.1 只接收操作名称，业务负载不进入默认日志。
	return { info: (message) => logger.info(`[${scope}] ${message}`) };
}
