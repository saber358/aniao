import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore, PI_AI_VERSION } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";

const logger = console;

/*
 * ========================================================================
 * 步骤1：从打包后的真实宿主加载磁盘扩展
 * ========================================================================
 * 数据源：独立验收目录中的用户扩展、项目扩展和相对导入。
 * 操作：
 *   1) 覆盖信任前后两次发现与虚拟模块解析
 *   2) 修改入口后重载，验证缓存失效
 */
logger.info("开始验证打包扩展宿主");
try {
	const [cwd, agentDir] = process.argv.slice(2);
	// 1.1 构建产物位于测试目录，不保留 SDK 的 dist 目录结构。
	const loader = new DefaultResourceLoader({ cwd, agentDir });
	await loader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			if (extensionsResult.errors.length) throw new Error(JSON.stringify(extensionsResult.errors));
			const names = extensionsResult.extensions.flatMap((extension) => [...extension.commands.keys()]);
			if (names.length !== 1 || names[0] !== "portable") throw new Error("项目扩展不能在信任前加载");
			return true;
		},
	});
	const first = loader.getExtensions();
	if (first.errors.length) throw new Error(JSON.stringify(first.errors));
	const commands = first.extensions.flatMap((extension) => [...extension.commands.keys()]).sort();
	// 1.2 重载不能继续使用上一轮工厂。
	writeFileSync(
		join(agentDir, "extensions", "portable.ts"),
		'export default (pi) => pi.registerCommand("reloaded", {handler: async () => {}});',
	);
	await loader.reload();
	const reloaded = loader.getExtensions();
	if (reloaded.errors.length) throw new Error(JSON.stringify(reloaded.errors));
	// 1.3 已取消的真实 OAuth 刷新仍须先加载官方模块；请求信号预先取消，不访问认证服务器。
	const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
	const oauth = models.getProvider("openai-codex")?.auth.oauth;
	if (!oauth) throw new Error("官方 OAuth 服务商缺失");
	const cancelled = new AbortController();
	cancelled.abort(new Error("offline-auth-abort"));
	let oauthError = "";
	try {
		await oauth.refresh({ type: "oauth", access: "offline", refresh: "offline", expires: 0 }, cancelled.signal);
	} catch (error) {
		oauthError = error instanceof Error ? error.message : String(error);
	}
	if (!/offline-auth-abort|aborted/i.test(oauthError)) throw new Error(`OAuth 延迟模块验收失败：${oauthError}`);
	logger.info(
		JSON.stringify({
			kernel: VERSION,
			models: PI_AI_VERSION,
			oauth: "cancelled-after-module-load",
			commands,
			reloaded: reloaded.extensions.flatMap((extension) => [...extension.commands.keys()]).sort(),
		}),
	);
} finally {
	logger.info("打包扩展宿主验证完成");
}
