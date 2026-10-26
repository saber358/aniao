import {
	fauxProvider,
	type OAuthAuth,
	type OAuthCredential,
	type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/host/auth-service.ts";
import { DialogService } from "../src/host/dialog-service.ts";
import { AuthStorage } from "../src/host/kernel.ts";

const logger = { info: vi.fn() };
const credentials: OAuthCredential = {
	type: "oauth",
	access: "private-access",
	refresh: "private-refresh",
	expires: 9999999999999,
};
async function fixture(login: (callbacks: ProviderAuthInteraction) => Promise<OAuthCredential>) {
	const provider: OAuthAuth = {
		name: "离线认证",
		login,
		refresh: async (value) => value,
		toAuth: async (value) => ({ apiKey: value.access }),
	};
	const storage = AuthStorage.inMemory();
	const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null });
	runtime.registerNativeProvider({ ...fauxProvider({ provider: "offline" }).provider, auth: { oauth: provider } });
	await runtime.refresh({ allowNetwork: false });
	const dialogs = new DialogService(logger, vi.fn());
	const auth = new AuthService(runtime, storage, dialogs, logger, vi.fn());
	return { auth, dialogs, storage, provider };
}

/*
 * ========================================================================
 * 步骤1：用现有认证存储验证 OAuth 回调与取消边界
 * ========================================================================
 * 数据源：离线服务商、内存 AuthStorage 和可控回调，不访问网络。
 * 操作：
 *   1) 登录选择、设备码和授权输入完整关联，凭据不进入快照
 *   2) 取消、超时和写入失败可以重试，迟到成功不能保存凭据
 */
describe("AuthService", () => {
	afterEach(() => vi.useRealTimers());
	it("adapts provider callbacks and stores tokens without exposing them in state", async () => {
		logger.info("开始验证 OAuth 回调适配");
		const { auth, dialogs, storage } = await fixture(async (callbacks) => {
			expect(
				await callbacks.prompt({ type: "select", message: "登录方式", options: [{ id: "device", label: "设备码" }] }),
			).toBe("device");
			callbacks.notify({ type: "device_code", verificationUri: "https://example.invalid/login", userCode: "ABCD" });
			callbacks.notify({ type: "auth_url", url: "https://example.invalid/authorize", instructions: "授权" });
			expect(await callbacks.prompt({ type: "secret", message: "输入授权码" })).toBe("code");
			callbacks.notify({ type: "progress", message: "等待完成" });
			return credentials;
		});
		try {
			const pending = auth.login("offline");
			dialogs.reply({ id: dialogs.requests[0].id, cancelled: false, value: "device" });
			await vi.waitFor(() => expect(dialogs.requests[0]?.kind).toBe("input"));
			expect(auth.state.flow).toMatchObject({ userCode: "ABCD", url: "https://example.invalid/authorize" });
			dialogs.reply({ id: dialogs.requests[0].id, cancelled: false, value: "code" });
			await pending;
			expect(await storage.read("offline")).toEqual(credentials);
			expect(auth.state.flow?.phase).toBe("succeeded");
			expect(JSON.stringify(auth.state)).not.toContain("private-");
			expect(dialogs.requests).toEqual([]);
		} finally {
			auth.dispose();
			dialogs.dispose();
			logger.info("OAuth 回调适配验证完成");
		}
	});
	it("settles cancellation even if a provider ignores abort and refuses its late credentials", async () => {
		logger.info("开始验证 OAuth 迟到成功");
		let finish: (value: OAuthCredential) => void = () => {};
		const { auth, dialogs, storage } = await fixture(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		try {
			const pending = auth.login("offline");
			auth.cancel();
			await pending;
			expect(auth.busy).toBe(false);
			expect(auth.state.flow?.phase).toBe("cancelled");
			finish(credentials);
			await Promise.resolve();
			expect(await storage.read("offline")).toBeUndefined();
		} finally {
			auth.dispose();
			dialogs.dispose();
			logger.info("OAuth 迟到成功验证完成");
		}
	});
	it("times out, rejects invalid URLs and sanitizes storage or provider failures", async () => {
		logger.info("开始验证 OAuth 超时与错误边界");
		vi.useFakeTimers();
		const { auth, dialogs, storage, provider } = await fixture(async () => new Promise(() => {}));
		try {
			const pending = auth.login("offline");
			await vi.advanceTimersByTimeAsync(600001);
			await pending;
			expect(auth.state.flow?.phase).toBe("cancelled");
			provider.login = async (callbacks) => {
				callbacks.notify({ type: "auth_url", url: "file:///secret" });
				return credentials;
			};
			await auth.login("offline");
			expect(auth.state.flow?.phase).toBe("failed");
			expect(await storage.read("offline")).toBeUndefined();
			provider.login = async () => credentials;
			vi.spyOn(storage, "modify").mockRejectedValueOnce(new Error("private-access disk failure"));
			await auth.login("offline");
			expect(auth.state.flow?.phase).toBe("failed");
			expect(JSON.stringify(auth.state)).not.toContain("private-access");
			await auth.login("offline");
			expect(auth.state.flow?.phase).toBe("succeeded");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			auth.dispose();
			dialogs.dispose();
			logger.info("OAuth 超时与错误边界验证完成");
		}
	});
	it("cancels only the manual prompt when the OAuth callback completes", async () => {
		logger.info("开始验证 OAuth 单个提示取消");
		const { auth, dialogs, storage } = await fixture(async (interaction) => {
			const promptController = new AbortController();
			// 1.3 浏览器回调先完成时，手工码提示关闭，整个登录继续保存凭据。
			const prompt = interaction.prompt({
				type: "manual_code",
				message: "输入授权码",
				signal: promptController.signal,
			});
			promptController.abort();
			await expect(prompt).rejects.toThrow();
			return credentials;
		});
		try {
			await auth.login("offline");
			expect(auth.state.flow?.phase).toBe("succeeded");
			expect(await storage.read("offline")).toEqual(credentials);
			expect(dialogs.requests).toEqual([]);
		} finally {
			auth.dispose();
			dialogs.dispose();
			logger.info("OAuth 单个提示取消验证结束");
		}
	});
});
