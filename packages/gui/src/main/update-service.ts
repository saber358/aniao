import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { Logger } from "../shared/logger.ts";
import type { UpdateState } from "../shared/update.ts";

type PublishState = (state: UpdateState) => void;
type BeforeInstall = () => Promise<void>;

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 10_000;

/**
 * 内测更新通道。
 *
 * 仅打包版本启用；定时检查，用户点击后才下载、重启安装。
 * 更新源使用 electron-builder 生成的 app-update.yml，可用 ANIAO_UPDATE_URL 覆盖。
 */
export class UpdateService {
	private state: UpdateState;
	private listeners = new Set<(state: UpdateState) => void>();
	private checking = false;
	private downloading = false;
	private installing = false;
	private started = false;
	private readonly logger: Logger;
	private readonly beforeInstall: BeforeInstall;
	private readonly publish: PublishState;

	constructor(logger: Logger, beforeInstall: BeforeInstall, publish: PublishState) {
		this.logger = logger;
		this.beforeInstall = beforeInstall;
		this.publish = publish;
		this.state = {
			phase: app.isPackaged ? "idle" : "disabled",
			currentVersion: app.getVersion(),
			message: app.isPackaged ? "尚未检查更新" : "开发模式不检查更新",
		};
		autoUpdater.autoDownload = false;
		autoUpdater.autoInstallOnAppQuit = false;
		autoUpdater.allowPrerelease = false;
		autoUpdater.on("checking-for-update", () => {
			if (this.checking) this.set({ phase: "checking", message: "正在检查更新" });
		});
		autoUpdater.on("update-available", (info) => {
			if (!this.checking) return;
			this.set({
				phase: "available",
				availableVersion: info.version,
				message: `发现新版本 ${info.version}，点击下载后开始更新`,
				progress: undefined,
				releaseNotes: normalizeReleaseNotes(info.releaseNotes),
			});
		});
		autoUpdater.on("update-not-available", () => {
			if (!this.checking) return;
			this.set({
				phase: "idle",
				message: "当前已是最新版本",
				availableVersion: undefined,
				progress: undefined,
				releaseNotes: undefined,
			});
		});
		autoUpdater.on("download-progress", (progress) => {
			if (!this.downloading || this.state.phase !== "downloading") return;
			this.set({
				phase: "downloading",
				availableVersion: this.state.availableVersion,
				progress: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0,
				message: "正在下载更新",
			});
		});
		autoUpdater.on("update-downloaded", (info) => {
			if (!this.downloading || this.state.phase !== "downloading") return;
			this.set({
				phase: "downloaded",
				availableVersion: info.version,
				progress: 100,
				message: `新版本 ${info.version} 已下载，重启后安装`,
				releaseNotes: normalizeReleaseNotes(info.releaseNotes),
			});
		});
		autoUpdater.on("error", (error) => {
			if (!this.checking && !this.downloading) return;
			this.set({
				phase: "error",
				message: `更新失败：${error instanceof Error ? error.message : "未知错误"}`,
			});
			this.logger.info("更新检查或下载失败");
		});
		if (process.env.ANIAO_UPDATE_URL) {
			autoUpdater.setFeedURL({ provider: "generic", url: process.env.ANIAO_UPDATE_URL });
		}
	}

	get current(): UpdateState {
		return { ...this.state };
	}

	start(): void {
		if (this.started || !app.isPackaged) return;
		this.started = true;
		const initial = setTimeout(() => void this.check(), INITIAL_DELAY_MS);
		initial.unref();
		const periodic = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
		periodic.unref();
	}

	subscribe(listener: (state: UpdateState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async check(): Promise<UpdateState> {
		if (!app.isPackaged) return this.current;
		if (this.checking || this.downloading || this.state.phase === "downloaded") return this.current;
		/*
		 * ========================================================================
		 * 步骤1：检查版本并等待用户下载
		 * ========================================================================
		 * 数据源：electron-updater 的版本元数据。
		 * 操作：1) 定时和手动检查共用入口；2) 检查过程不请求安装包。
		 */
		this.logger.info("开始检查应用更新");
		this.checking = true;
		try {
			this.set({ phase: "checking", message: "正在检查更新" });
			// 1.1 autoDownload 关闭，检查只发布版本信息。
			await autoUpdater.checkForUpdates();
		} catch (error) {
			this.set({
				phase: "error",
				message: `更新检查失败：${error instanceof Error ? error.message : "未知错误"}`,
			});
			this.logger.info("更新检查请求失败");
		} finally {
			this.checking = false;
			this.logger.info("应用更新检查结束");
		}
		return this.current;
	}

	async download(): Promise<UpdateState> {
		if (!app.isPackaged || this.checking || this.downloading || this.state.phase === "downloaded") return this.current;
		if (!this.state.availableVersion || !["available", "error"].includes(this.state.phase)) return this.current;
		/*
		 * ========================================================================
		 * 步骤2：只接收用户主动发起的下载
		 * ========================================================================
		 * 数据源：已检查的新版本与固定下载 IPC。
		 * 操作：1) 开始前锁定下载并广播零进度；2) 失败保留版本，允许点击重试。
		 */
		this.logger.info("开始下载应用更新");
		this.downloading = true;
		try {
			// 2.1 进度事件可能晚于下载请求，先同步所有界面入口。
			this.set({ phase: "downloading", progress: 0, message: "正在下载更新" });
			await autoUpdater.downloadUpdate();
		} catch (error) {
			// 2.2 不自动重试，也不把下载错误显示为最新版。
			this.set({
				phase: "error",
				progress: undefined,
				message: `更新下载失败：${error instanceof Error ? error.message : "未知错误"}`,
			});
		} finally {
			this.downloading = false;
			this.logger.info("应用更新下载结束");
		}
		return this.current;
	}

	async install(): Promise<void> {
		if (this.installing) return;
		if (this.state.phase !== "downloaded") throw new Error("还没有下载完成的更新");
		/*
		 * ========================================================================
		 * 步骤3：确认后清理宿主并重启安装
		 * ========================================================================
		 * 数据源：下载完成状态与用户安装操作。
		 * 操作：1) 防止重复安装；2) 等待宿主保存后再退出应用。
		 */
		this.logger.info("开始重启安装更新");
		this.installing = true;
		try {
			// 3.1 清理失败向调用方报错，保留已下载状态供重试。
			await this.beforeInstall();
			autoUpdater.quitAndInstall(true, true);
		} finally {
			this.installing = false;
			this.logger.info("重启安装更新请求结束");
		}
	}

	private set(patch: Partial<UpdateState>): void {
		this.state = { ...this.state, ...patch };
		const snapshot = this.current;
		for (const listener of this.listeners) listener(snapshot);
		this.publish(snapshot);
	}
}

function normalizeReleaseNotes(value: unknown): string | undefined {
	if (typeof value === "string") return value.slice(0, 20000) || undefined;
	if (!Array.isArray(value)) return undefined;
	const notes = value
		.map((item) => (typeof item === "object" && item !== null && "note" in item ? String(item.note ?? "") : ""))
		.filter(Boolean)
		.join("\n");
	return notes.slice(0, 20000) || undefined;
}
