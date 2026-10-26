import { randomUUID } from "node:crypto";
import { type DialogReply, type DialogRequest, dialogRequestSchema } from "../shared/interactions.ts";
import type { Logger } from "../shared/logger.ts";

interface PendingDialog {
	request: DialogRequest;
	finish(value?: string | boolean): void;
}

/*
 * ========================================================================
 * 步骤1：持有交互回调并投影有限请求
 * ========================================================================
 * 数据源：宿主内的 OAuth / 扩展回调；跨进程只传展示参数和回复。
 * 操作：
 *   1) 每个请求独立关联，信号、超时、关闭都释放等待者
 *   2) 快照保留待答请求，Renderer 重载后可继续回复，旧回复明确拒绝
 */
export class DialogService {
	private readonly pending = new Map<string, PendingDialog>();
	private readonly logger: Logger;
	private readonly changed: () => void;
	private closed = false;

	constructor(logger: Logger, changed: () => void) {
		this.logger = logger;
		this.changed = changed;
	}

	get requests(): DialogRequest[] {
		return [...this.pending.values()].map((entry) => entry.request);
	}

	show(
		input: Omit<DialogRequest, "id" | "expiresAt">,
		options?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | boolean | undefined> {
		this.logger.info("开始建立交互请求");
		try {
			// 1.1 默认五分钟；所有回调均有界，预先取消不建立等待者。
			if (this.closed || options?.signal?.aborted) return Promise.resolve(undefined);
			if (this.pending.size >= 8) throw new Error("待处理交互过多，请先完成当前弹窗");
			const timeout = Math.min(600_000, Math.max(1, options?.timeout ?? 300_000));
			const request = dialogRequestSchema.parse({ ...input, id: randomUUID(), expiresAt: Date.now() + timeout });
			return new Promise((resolve) => {
				const finish = (value?: string | boolean) => {
					if (!this.pending.delete(request.id)) return;
					clearTimeout(timer);
					options?.signal?.removeEventListener("abort", cancel);
					this.changed();
					resolve(value);
				};
				const cancel = () => finish();
				const timer = setTimeout(cancel, timeout);
				timer.unref();
				this.pending.set(request.id, { request, finish });
				options?.signal?.addEventListener("abort", cancel, { once: true });
				this.changed();
			});
		} finally {
			this.logger.info("交互请求建立结束");
		}
	}

	reply(reply: DialogReply): void {
		this.logger.info("开始处理交互回复");
		try {
			// 1.2 除身份外还核对返回类型和选项，取消与确认互不混用。
			const pending = this.pending.get(reply.id);
			if (!pending) throw new Error("交互已结束，请查看当前弹窗");
			const request = pending.request;
			if (Date.now() >= request.expiresAt) {
				pending.finish();
				throw new Error("交互已超时");
			}
			if (!reply.cancelled) {
				if (request.kind === "confirm" ? typeof reply.value !== "boolean" : typeof reply.value !== "string")
					throw new Error("交互回复类型无效");
				if (request.kind === "select" && !request.options?.some((option) => option.value === reply.value))
					throw new Error("选择已失效");
				if (request.allowEmpty === false && typeof reply.value === "string" && !reply.value.trim())
					throw new Error("输入不能为空");
			}
			pending.finish(reply.cancelled ? undefined : reply.value);
		} finally {
			this.logger.info("交互回复处理结束");
		}
	}

	cancel(scope?: DialogRequest["scope"]): void {
		this.logger.info("开始取消待处理交互");
		try {
			// 1.3 关闭与取消复用同一清理路径，不保留计时器、信号监听或凭据输入。
			for (const entry of [...this.pending.values()]) if (!scope || entry.request.scope === scope) entry.finish();
		} finally {
			this.logger.info("待处理交互取消结束");
		}
	}

	dispose(): void {
		this.closed = true;
		this.cancel();
	}
}
