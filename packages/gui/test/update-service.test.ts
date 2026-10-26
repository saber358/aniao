import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateService } from "../src/main/update-service.ts";

vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return true;
		},
		getVersion: () => "0.80.8",
	},
}));
vi.mock("electron-updater", () => ({
	autoUpdater: {
		on: vi.fn(),
		checkForUpdates: vi.fn(),
		downloadUpdate: vi.fn(),
		quitAndInstall: vi.fn(),
		setFeedURL: vi.fn(),
	},
}));
const logger = { info: vi.fn() };
const info = { version: "0.80.9", releaseNotes: "手动下载应用更新" };

function emit(event: string, value?: unknown): void {
	for (const [name, listener] of vi.mocked(autoUpdater.on).mock.calls) {
		if (name === event) (listener as (input: unknown) => void)(value);
	}
}

async function discover(service: UpdateService): Promise<void> {
	vi.mocked(autoUpdater.checkForUpdates).mockImplementationOnce(async () => {
		emit("update-available", info);
		return null;
	});
	await service.check();
}

/*
 * ========================================================================
 * 步骤1：验证手动下载与显式安装边界
 * ========================================================================
 * 数据源：更新器替身，不访问发布服务器或安装真实程序。
 * 操作：1) 检查只请求元数据；2) 下载防重、同步进度并允许失败重试。
 */
describe("desktop updates", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.unstubAllEnvs();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("does not check, download or install in development mode", async () => {
		logger.info("开始验证开发模式更新边界");
		vi.spyOn(app, "isPackaged", "get").mockReturnValue(false);
		const service = new UpdateService(logger, vi.fn(), vi.fn());
		try {
			// 1.1 开发模式不触发更新网络请求。
			service.start();
			expect((await service.check()).phase).toBe("disabled");
			expect((await service.download()).phase).toBe("disabled");
			emit("update-downloaded", info);
			expect(service.current.phase).toBe("disabled");
			expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
			expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
			await expect(service.install()).rejects.toThrow("没有下载完成");
		} finally {
			logger.info("开发模式更新边界验证结束");
		}
	});

	it("preserves a retriable error after network or certificate failure", async () => {
		logger.info("开始验证更新网络失败");
		const service = new UpdateService(logger, vi.fn(), vi.fn());
		try {
			// 1.2 错误不会被显示为已是最新版本，之后可以重新检查。
			await discover(service);
			vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(new Error("certificate unavailable"));
			expect((await service.check()).phase).toBe("error");
			expect(service.current.message).toContain("certificate unavailable");
			vi.mocked(autoUpdater.checkForUpdates).mockImplementationOnce(async () => {
				emit("update-not-available");
				return null;
			});
			expect(await service.check()).toEqual({
				phase: "idle",
				currentVersion: "0.80.8",
				message: "当前已是最新版本",
				availableVersion: undefined,
				progress: undefined,
				releaseNotes: undefined,
			});
			expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
		} finally {
			logger.info("更新网络失败验证结束");
		}
	});

	it("waits for explicit install and host cleanup after downloading", async () => {
		logger.info("开始验证下载后的用户安装边界");
		let release = () => {};
		const cleanup = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const service = new UpdateService(logger, cleanup, vi.fn());
		try {
			// 1.3 下载不会自动安装，安装动作也必须等待宿主清理完成。
			await discover(service);
			vi.mocked(autoUpdater.downloadUpdate).mockImplementationOnce(async () => {
				emit("update-downloaded", info);
				return ["installer.exe"];
			});
			await service.download();
			expect(service.current.phase).toBe("downloaded");
			expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
			const installing = service.install();
			await service.install();
			expect(cleanup).toHaveBeenCalledOnce();
			expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
			release();
			await installing;
			expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
		} finally {
			release();
			logger.info("下载后的用户安装边界验证结束");
		}
	});

	it("keeps download failures retryable without automatically retrying", async () => {
		logger.info("开始验证下载失败与用户重试");
		const service = new UpdateService(logger, vi.fn(), vi.fn());
		try {
			// 1.4 更新器事件和 Promise 均报错时保留可下载版本。
			await discover(service);
			vi.mocked(autoUpdater.downloadUpdate).mockImplementationOnce(async () => {
				emit("error", new Error("installer download failed"));
				throw new Error("installer download failed");
			});
			expect(await service.download()).toMatchObject({
				phase: "error",
				availableVersion: "0.80.9",
				progress: undefined,
			});
			expect(service.current.message).toContain("installer download failed");
			expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
			vi.mocked(autoUpdater.downloadUpdate).mockImplementationOnce(async () => {
				emit("update-downloaded", info);
				return ["installer.exe"];
			});
			expect((await service.download()).phase).toBe("downloaded");
			expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);
		} finally {
			logger.info("下载失败与用户重试验证结束");
		}
	});

	it("checks on startup and periodically without downloading installers", async () => {
		logger.info("开始验证定时检查不下载");
		vi.useFakeTimers();
		const service = new UpdateService(logger, vi.fn(), vi.fn());
		try {
			// 1.5 重复启动只注册一组定时器，发现版本后等待用户动作。
			vi.mocked(autoUpdater.checkForUpdates).mockImplementation(async () => {
				emit("update-available", info);
				return null;
			});
			service.start();
			service.start();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(service.current).toMatchObject({ phase: "available", availableVersion: "0.80.9" });
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
			expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
			expect(autoUpdater.autoDownload).toBe(false);
			expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
			expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
			expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		} finally {
			logger.info("定时检查不下载验证结束");
		}
	});

	it("downloads once on user action and broadcasts progress across entry points", async () => {
		logger.info("开始验证下载防重与进度同步");
		const publish = vi.fn();
		const subscriber = vi.fn();
		const service = new UpdateService(logger, vi.fn(), publish);
		const unsubscribe = service.subscribe(subscriber);
		let finish = () => {};
		try {
			// 1.6 未发现版本不能下载，没有用户动作的进度事件不改变状态。
			await service.download();
			expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
			await discover(service);
			emit("download-progress", { percent: 50 });
			emit("update-downloaded", info);
			expect(service.current.phase).toBe("available");
			vi.mocked(autoUpdater.downloadUpdate).mockImplementationOnce(
				() =>
					new Promise<string[]>((resolve) => {
						finish = () => {
							emit("update-downloaded", info);
							resolve(["installer.exe"]);
						};
					}),
			);
			const downloading = service.download();
			expect(service.current).toMatchObject({ phase: "downloading", progress: 0 });
			await service.download();
			await service.check();
			expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
			expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
			// 1.7 广播同一快照，并拒绝越界或非数值进度。
			for (const [percent, expected] of [
				[47.8, 47.8],
				[-5, 0],
				[Number.NaN, 0],
				[120, 100],
			]) {
				emit("download-progress", { percent });
				expect(service.current.progress).toBe(expected);
				expect(publish).toHaveBeenLastCalledWith(service.current);
				expect(subscriber).toHaveBeenLastCalledWith(service.current);
			}
			finish();
			expect((await downloading).phase).toBe("downloaded");
			emit("download-progress", { percent: 5 });
			expect(service.current.progress).toBe(100);
			await service.download();
			await service.check();
			expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
			expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		} finally {
			finish();
			unsubscribe();
			logger.info("下载防重与进度同步验证结束");
		}
	});

	it("prevents downloads and duplicate checks while a check is in flight", async () => {
		logger.info("开始验证检查与下载互斥");
		const service = new UpdateService(logger, vi.fn(), vi.fn());
		let finish = () => {};
		try {
			// 1.8 保留上次版本时，检查尚未结束也不能下载过期结果。
			await discover(service);
			vi.mocked(autoUpdater.checkForUpdates).mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = () => {
							emit("update-not-available");
							resolve(null);
						};
					}),
			);
			const checking = service.check();
			await service.check();
			await service.download();
			expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
			expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
			finish();
			expect((await checking).phase).toBe("idle");
		} finally {
			finish();
			logger.info("检查与下载互斥验证结束");
		}
	});
});
