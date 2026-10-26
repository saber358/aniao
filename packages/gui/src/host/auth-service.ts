import { randomUUID } from "node:crypto";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthenticationState } from "../shared/interactions.ts";
import type { Logger } from "../shared/logger.ts";
import type { DialogService } from "./dialog-service.ts";

/*
 * ========================================================================
 * 步骤1：复用 Pi 模型运行时与异步认证存储
 * ========================================================================
 * 数据源：ModelRuntime 服务商与 CredentialStore；token 仅留在宿主。
 * 操作：
 *   1) 浏览器地址、设备码、选择和手工输入投影为有界交互
 *   2) 取消后复核信号再保存，忽略迟到成功；错误不回传服务商原始负载
 */
export class AuthService {
	private readonly runtime: ModelRuntime;
	private readonly storage: CredentialStore;
	private readonly dialogs: DialogService;
	private readonly logger: Logger;
	private readonly changed: () => void;
	private controller?: AbortController;
	private flow: AuthenticationState["flow"] = null;
	private closed = false;

	constructor(
		runtime: ModelRuntime,
		storage: CredentialStore,
		dialogs: DialogService,
		logger: Logger,
		changed: () => void,
	) {
		this.runtime = runtime;
		this.storage = storage;
		this.dialogs = dialogs;
		this.logger = logger;
		this.changed = changed;
	}

	get state(): AuthenticationState {
		return {
			providers: this.runtime
				.getProviders()
				.filter((provider) => provider.auth.oauth)
				.map((provider) => ({
					id: provider.id,
					name: provider.auth.oauth?.name ?? provider.name,
					authenticated: this.runtime.isUsingOAuth(provider.id),
				})),
			flow: this.flow,
		};
	}

	get busy(): boolean {
		return !!this.controller;
	}

	async login(providerId: string): Promise<void> {
		if (this.closed || this.controller) throw new Error("认证操作尚未结束");
		const oauth = this.runtime.getProvider(providerId)?.auth.oauth;
		if (!oauth) throw new Error("服务商不支持 OAuth");
		this.logger.info("开始 OAuth 登录");
		const controller = new AbortController();
		this.controller = controller;
		const id = randomUUID();
		this.flow = { id, provider: providerId, phase: "working", message: "正在准备登录" };
		this.changed();
		const update = (data: Partial<NonNullable<AuthenticationState["flow"]>>) => {
			if (controller.signal.aborted || this.controller !== controller || !this.flow) return;
			this.flow = { ...this.flow, ...data };
			this.changed();
		};
		// 1.1 登录总时限十分钟；回调服务器与轮询由现有 Provider 处理。
		const timer = setTimeout(() => controller.abort(), 600_000);
		timer.unref();
		let rejectCancelled: (error: Error) => void = () => {};
		const cancelled = new Promise<never>((_resolve, reject) => {
			rejectCancelled = reject;
		});
		const abort = () => rejectCancelled(new Error("登录已取消"));
		controller.signal.addEventListener("abort", abort, { once: true });
		try {
			const credentials = await Promise.race([
				cancelled,
				oauth.login({
					signal: controller.signal,
					prompt: async (prompt) => {
						// 1.3 回调服务器可单独取消手工输入，不取消整个登录流程。
						const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal;
						const result = await this.dialogs.show(
							prompt.type === "select"
								? {
										scope: "oauth",
										kind: "select",
										title: "登录方式",
										message: prompt.message.slice(0, 8192),
										options: prompt.options.map((option) => ({ value: option.id, label: option.label })),
									}
								: {
										scope: "oauth",
										kind: "input",
										title: "OAuth 登录",
										message: prompt.message.slice(0, 8192),
										placeholder: prompt.placeholder?.slice(0, 4096),
										secret: true,
									},
							{ signal },
						);
						signal.throwIfAborted();
						if (typeof result !== "string" || result.length > 16384) {
							controller.abort();
							throw new Error("登录输入已取消");
						}
						return result;
					},
					notify: (event) => {
						const url =
							event.type === "auth_url"
								? event.url
								: event.type === "device_code"
									? event.verificationUri
									: event.type === "info"
										? event.links?.[0]?.url
										: undefined;
						if (url) {
							const target = new URL(url);
							if (!["https:", "http:"].includes(target.protocol) || url.length > 8192) throw new Error("登录地址无效");
						}
						if (event.type === "auth_url")
							update({ url, message: event.instructions?.slice(0, 8192) || "请在浏览器完成登录" });
						else if (event.type === "device_code")
							update({ url, userCode: event.userCode.slice(0, 4096), message: "在浏览器输入设备码" });
						else update({ ...(url ? { url } : {}), message: event.message.slice(0, 8192) });
					},
				}),
			]);
			// 1.2 Provider 即使忽略取消信号，也不能写入迟到凭据。
			controller.signal.throwIfAborted();
			if (this.closed || this.controller !== controller) return;
			await this.storage.modify(
				providerId,
				async () => {
					controller.signal.throwIfAborted();
					return credentials;
				},
				{ signal: controller.signal },
			);
			await this.runtime.refresh({ allowNetwork: false, signal: controller.signal });
			this.flow = { id, provider: providerId, phase: "succeeded", message: "登录成功" };
		} catch {
			this.flow = {
				id,
				provider: providerId,
				phase: controller.signal.aborted ? "cancelled" : "failed",
				message: controller.signal.aborted ? "登录已取消" : "登录失败，请重试并检查网络或 Pi 配置",
			};
		} finally {
			clearTimeout(timer);
			controller.signal.removeEventListener("abort", abort);
			this.dialogs.cancel("oauth");
			this.controller = undefined;
			this.changed();
			this.logger.info("OAuth 登录结束");
		}
	}

	cancel(): void {
		this.controller?.abort();
		this.dialogs.cancel("oauth");
	}
	dispose(): void {
		this.closed = true;
		this.cancel();
	}
}
