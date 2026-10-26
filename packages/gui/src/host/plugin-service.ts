import { DefaultPackageManager, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../shared/logger.ts";
import type { PluginPackage, PluginScope } from "../shared/plugins.ts";

const ALLOWED_SOURCE = /^(npm:|git:|https?:\/\/|ssh:\/\/|\/|[A-Za-z]:[\\/])/u;

/*
 * ========================================================================
 * 步骤1：在 SDK 宿主内处理 npm、Git 和本地插件
 * ========================================================================
 * 数据源：当前会话的 Pi settings 与工作区目录。
 * 操作：
 *   1) 安装/移除只通过 DefaultPackageManager，不自行拼 npm 命令
 *   2) SDK 只存在于 ESM 宿主，主进程不直接加载 Pi 包
 */
export class HostPluginService {
	private readonly cwd: string;
	private readonly settings: SettingsManager;
	private readonly logger: Logger;

	constructor(cwd: string, settings: SettingsManager, logger: Logger) {
		this.cwd = cwd;
		this.settings = settings;
		this.logger = logger;
	}

	async list(): Promise<PluginPackage[]> {
		return this.map(this.createManager());
	}

	async install(source: string): Promise<PluginPackage[]> {
		this.validateSource(source);
		const manager = this.createManager();
		this.logger.info(`开始安装插件：${source}`);
		manager.setProgressCallback((event) => {
			this.logger.info(`插件安装 ${event.action}：${event.source}${event.message ? ` ${event.message}` : ""}`);
		});
		try {
			await manager.installAndPersist(source, { local: false });
			await this.settings.flush();
			this.logger.info(`插件安装完成：${source}`);
			return this.map(manager);
		} finally {
			manager.setProgressCallback(undefined);
		}
	}

	async remove(source: string, scope: PluginScope): Promise<PluginPackage[]> {
		const manager = this.createManager();
		this.logger.info(`开始移除插件：${source}`);
		try {
			const removed = await manager.removeAndPersist(source, { local: scope === "project" });
			if (!removed) throw new Error("插件不在当前设置中，可能已被移除");
			await this.settings.flush();
			this.logger.info(`插件移除完成：${source}`);
			return this.map(manager);
		} finally {
			manager.setProgressCallback(undefined);
		}
	}

	private createManager(): DefaultPackageManager {
		const agentDir = getAgentDir();
		return new DefaultPackageManager({
			cwd: this.cwd,
			agentDir,
			settingsManager: this.settings,
		});
	}

	private map(manager: DefaultPackageManager): PluginPackage[] {
		return manager.listConfiguredPackages().map((item) => ({
			source: item.source,
			scope: item.scope,
			installed: true,
			...(item.installedPath ? { path: item.installedPath } : {}),
		}));
	}

	private validateSource(source: string): void {
		if (!ALLOWED_SOURCE.test(source)) throw new Error("仅支持 npm、Git 或本地路径插件来源");
	}
}
