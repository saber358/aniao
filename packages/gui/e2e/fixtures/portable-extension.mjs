import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const logger = console;

/*
 * ========================================================================
 * 步骤1：注册仅供桌面离线验收的扩展与认证服务商
 * ========================================================================
 * 数据源：确定性对话框输入，不调用网络、不读取真实凭据。
 * 操作：
 *   1) 覆盖四类扩展交互、文本展示和切换取消
 *   2) OAuth 复用服务商回调；固定测试 token 只写入独立验收目录
 */
export default function portableExtension(pi) {
	logger.info("开始注册桌面离线扩展");
	let guard = false;
	// 1.0 验收后段才启用启动提问，检查传输就绪顺序与启动原因。
	pi.on("session_start", async (event, ctx) => {
		if (!existsSync(join(getAgentDir(), "confirm-startup"))) return;
		if (await ctx.ui.confirm("扩展启动确认", "允许初始化当前会话？")) ctx.ui.notify(`扩展启动已确认：${event.reason}`);
	});
	// 1.1 注册表在宿主内持有回调，renderer 只看到显示名和认证状态。
	pi.registerProvider("gui-offline-oauth", {
		oauth: {
			name: "离线 OAuth",
			async login(callbacks) {
				const choice = await callbacks.onSelect({
					message: "选择离线登录方式",
					options: [
						{ id: "device", label: "离线设备码" },
						{ id: "manual", label: "离线手工码" },
					],
				});
				if (!choice) throw new Error("cancelled");
				callbacks.onDeviceCode({ verificationUri: "https://example.invalid/device", userCode: "TEST-1234" });
				callbacks.onAuth({ url: "https://example.invalid/authorize", instructions: "完成离线授权输入" });
				const code = await callbacks.onPrompt({ message: "输入离线授权码", placeholder: "输入 offline-code" });
				if (code !== "offline-code") throw new Error("incorrect offline code");
				callbacks.signal?.throwIfAborted();
				return { access: "offline-private-access", refresh: "offline-private-refresh", expires: 9999999999999 };
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		},
	});
	// 1.2 所有值都由用户回复产生，取消不会再请求模型。
	pi.registerCommand("gui-dialogs", {
		description: "桌面扩展离线验收",
		handler: async (_args, ctx) => {
			const selected = await ctx.ui.select("扩展选择", ["检查中文", "检查边界"]);
			if (!selected) {
				ctx.ui.notify("扩展选择已取消");
				return;
			}
			if (!(await ctx.ui.confirm("扩展确认", "继续检查输入与编辑？"))) return;
			const input = await ctx.ui.input("扩展输入", "输入说明");
			if (input === undefined) return;
			const edited = await ctx.ui.editor("扩展编辑", `${selected}\n${input}`);
			if (edited === undefined) return;
			ctx.ui.setStatus("fixture", "扩展状态已更新");
			ctx.ui.setWidget("above", ["扩展文本小组件", edited], { placement: "aboveEditor" });
			ctx.ui.setWidget("below", ["输入框下方小组件"], { placement: "belowEditor" });
			ctx.ui.notify("扩展交互已完成");
		},
	});
	pi.registerCommand("gui-timeout", {
		description: "桌面扩展超时验收",
		handler: async (_args, ctx) => {
			const result = await ctx.ui.confirm("扩展超时", "等待自动关闭", { timeout: 150 });
			ctx.ui.notify(result ? "意外确认" : "扩展请求已超时");
		},
	});
	pi.registerCommand("gui-guard", {
		description: "桌面切换钩子验收",
		handler: async (_args, ctx) => {
			guard = true;
			ctx.ui.notify("切换保护已开启");
		},
	});
	pi.on("session_before_switch", async (_event, ctx) =>
		guard ? { cancel: !(await ctx.ui.confirm("切换确认", "允许切换会话？")) } : undefined,
	);
	logger.info("桌面离线扩展注册完成");
}
