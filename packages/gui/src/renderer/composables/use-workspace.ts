import { nextTick, onMounted, onScopeDispose, ref, shallowRef } from "vue";
import { GuiController } from "../../domain/gui-controller.ts";
import { createLogger } from "../../shared/logger.ts";
import type { ProjectSummary, SessionChange, SessionLibrary } from "../../shared/workspace.ts";

const logger = createLogger("renderer");

/*
 * ========================================================================
 * 步骤1：将纯业务状态接入 Vue
 * ========================================================================
 * 数据源：preload 提供的有限端口。
 * 操作：
 *   1) 用 shallowRef 接收不可变 ViewModel
 *   2) 组件销毁时释放订阅，不销毁 Agent
 */
export function useWorkspace() {
	logger.info("开始绑定 Vue 工作区");
	const bridge = window.piDesktop;
	const controller = new GuiController(bridge, logger, bridge);
	const state = shallowRef(controller.value);
	const changing = ref(false);
	const actionError = ref("");
	const library = shallowRef<SessionLibrary | null>(null);
	const projects = shallowRef<ProjectSummary[]>([]);
	let libraryRequest = 0;
	const unsubscribe = controller.subscribe((next) => {
		const previous = state.value.snapshot;
		state.value = next;
		if (
			next.snapshot &&
			(previous?.sessionId !== next.snapshot.sessionId ||
				previous.title !== next.snapshot.title ||
				(previous.run.phase !== "idle" && next.snapshot.run.phase === "idle"))
		) {
			void refreshLibrary();
			void refreshProjects();
		}
	});

	async function refreshLibrary() {
		const request = ++libraryRequest;
		try {
			const next = await bridge.getLibrary();
			if (request === libraryRequest && next?.cwd === state.value.snapshot?.cwd) library.value = next;
		} catch (error) {
			if (request === libraryRequest) actionError.value = error instanceof Error ? error.message : "历史加载失败";
		}
	}
	async function refreshProjects() {
		try {
			projects.value = await bridge.getProjects();
		} catch (error) {
			actionError.value = error instanceof Error ? error.message : "工作区列表加载失败";
		}
	}
	onMounted(async () => {
		/*
		 * ========================================================================
		 * 步骤6：首屏事实加载后通知启动页退场
		 * ========================================================================
		 * 数据源：初始会话快照、项目列表与 Vue 首次绘制。
		 * 操作：1) 错误状态同样允许进入；2) 不添加固定品牌等待时间。
		 */
		logger.info("开始准备工作台首屏");
		try {
			// 6.1 等待真实初始状态，避免启动页结束后露出空会话。
			await controller.connect();
			await Promise.all([refreshLibrary(), refreshProjects()]);
		} finally {
			await nextTick();
			// 6.2 主窗口在交接前保持隐藏，不能依赖被暂停的 requestAnimationFrame。
			setTimeout(() => window.harnessWorkbenchReady?.(), 0);
			logger.info("工作台首屏准备结束");
		}
	});
	onScopeDispose(() => {
		unsubscribe();
		controller.dispose();
	});
	// 1.1 项目切换是桌面能力；完成后仍用标准快照同步业务状态。
	async function changeProject(createNew = false) {
		if (changing.value || state.value.selectingFiles) return;
		logger.info("开始切换桌面会话");
		changing.value = true;
		actionError.value = "";
		try {
			if (!(await controller.flushDraft())) throw new Error("草稿未保存，请先处理保存错误");
			if (createNew) await bridge.newSession();
			else if (!(await bridge.openProject())) return;
			await controller.refresh();
			await refreshLibrary();
			await refreshProjects();
		} catch (error) {
			actionError.value = error instanceof Error ? error.message : String(error);
		} finally {
			changing.value = false;
			logger.info("桌面会话切换结束");
		}
	}
	async function switchSession(operation: () => Promise<void>) {
		if (changing.value || state.value.selectingFiles) return;
		logger.info("开始切换历史会话");
		changing.value = true;
		actionError.value = "";
		try {
			if (!(await controller.flushDraft())) throw new Error("草稿未保存，请先处理保存错误");
			await operation();
			await controller.refresh();
			await refreshLibrary();
			await refreshProjects();
		} catch (error) {
			actionError.value = error instanceof Error ? error.message : "会话切换失败";
		} finally {
			changing.value = false;
			logger.info("历史会话切换结束");
		}
	}
	function openSession(sessionId: string) {
		return switchSession(() => bridge.openSession(sessionId));
	}
	function openWorkspace(cwd: string) {
		return switchSession(() => bridge.openWorkspace(cwd));
	}
	function newSessionAt(cwd: string) {
		return switchSession(() => bridge.newSessionAt(cwd));
	}
	function openSessionAt(cwd: string, sessionId: string) {
		return switchSession(() => bridge.openSessionAt(cwd, sessionId));
	}
	function forkSession(entryId: string) {
		const snapshot = state.value.snapshot;
		if (!snapshot || state.value.connection !== "connected") return;
		// 1.2 保存草稿前捕获选择代次，迟到调用不得切到新会话继续分支。
		const selection = { sessionId: snapshot.sessionId, generation: snapshot.generation, entryId };
		return switchSession(() => bridge.forkSession(selection));
	}
	async function updateSession(change: SessionChange): Promise<boolean> {
		if (changing.value || state.value.selectingFiles) return false;
		logger.info("开始更新会话列表");
		actionError.value = "";
		try {
			await bridge.updateSession(change);
			await controller.refresh();
			await refreshLibrary();
			await refreshProjects();
			return true;
		} catch (error) {
			actionError.value = error instanceof Error ? error.message : "会话更新失败";
			return false;
		} finally {
			logger.info("会话列表更新结束");
		}
	}
	async function renameWorkspace(cwd: string, name: string): Promise<boolean> {
		actionError.value = "";
		try {
			await bridge.renameWorkspace(cwd, name);
			await refreshProjects();
			return true;
		} catch (error) {
			actionError.value = error instanceof Error ? error.message : "工作区重命名失败";
			return false;
		}
	}
	async function removeWorkspace(cwd: string): Promise<boolean> {
		if (changing.value || state.value.selectingFiles) return false;
		changing.value = true;
		actionError.value = "";
		try {
			if (!(await controller.flushDraft())) throw new Error("草稿未保存，请先处理保存错误");
			await bridge.removeWorkspace(cwd);
			await controller.refresh();
			await refreshLibrary();
			await refreshProjects();
			return true;
		} catch (error) {
			actionError.value = error instanceof Error ? error.message : "工作区移除失败";
			return false;
		} finally {
			changing.value = false;
		}
	}
	logger.info("Vue 工作区绑定完成");
	return {
		state,
		controller,
		changing,
		actionError,
		changeProject,
		library,
		projects,
		refreshLibrary,
		refreshProjects,
		openWorkspace,
		newSessionAt,
		renameWorkspace,
		removeWorkspace,
		openSession,
		openSessionAt,
		forkSession,
		updateSession,
	};
}
