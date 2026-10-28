import { utilityProcess } from "electron";
import { z } from "zod";
import { type HistoryScan, historyScanSchema } from "../shared/data-statistics.ts";
import type { Logger } from "../shared/logger.ts";

/*
 * ========================================================================
 * 步骤1：隔离历史读取的内存、超时和退出
 * ========================================================================
 * 数据源：不含模型运行时的受管 utilityProcess。
 * 操作：1) 同时刷新合并为一次扫描；2) 完成或退出即回收进程。
 */
export class SessionDataClient {
	private pending?: Promise<HistoryScan>;
	private cancel?: () => void;
	private closed = false;
	private readonly entry: string;
	private readonly logger: Logger;
	constructor(entry: string, logger: Logger) {
		this.entry = entry;
		this.logger = logger;
	}
	scan(): Promise<HistoryScan> {
		if (this.closed) return Promise.reject(new Error("应用已退出"));
		if (this.pending) return this.pending;
		this.logger.info("开始连接只读统计进程");
		this.pending = new Promise<HistoryScan>((resolve, reject) => {
			const child = utilityProcess.fork(this.entry, [], { serviceName: "Harness statistics", stdio: "ignore" });
			let finished = false;
			const finish = (value?: HistoryScan, error?: Error) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				child.kill();
				if (value) resolve(value);
				else reject(error ?? new Error("统计读取失败"));
			};
			const timer = setTimeout(() => finish(undefined, new Error("统计读取超时，请重试")), 120000);
			this.cancel = () => finish(undefined, new Error("应用已退出"));
			child.on("message", (input: unknown) => {
				// 1.1 返回值再次校验，不能把进程异常当作空用量。
				const parsed = z.object({ value: historyScanSchema.optional(), error: z.string().optional() }).safeParse(input);
				if (!parsed.success) finish(undefined, new Error("统计数据协议不匹配"));
				else finish(parsed.data.value, new Error(parsed.data.error ?? "统计读取失败"));
			});
			child.once("exit", () => finish(undefined, new Error("统计进程退出，请重试")));
		}).finally(() => {
			this.pending = undefined;
			this.cancel = undefined;
			this.logger.info("只读统计进程连接结束");
		});
		return this.pending;
	}
	close(): void {
		this.closed = true;
		this.cancel?.();
	}
}
