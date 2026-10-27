import { onScopeDispose, ref, watch } from "vue";
import type { GoalAction, GoalReadRequest, GoalView } from "../../shared/goals.ts";
import type { Logger } from "../../shared/logger.ts";
import type { DesktopBridge } from "../../shared/protocol.ts";

/*
 * ========================================================================
 * 步骤1：按会话身份加载和控制目标栏
 * ========================================================================
 * 数据源：当前 cwd、sessionId、generation 与宿主目标接口。
 * 操作：1) 切换立即清空旧会话内容；2) 同会话失败保留成功数据并提示重试。
 */
export function useGoals(
	target: () => GoalReadRequest,
	port: Pick<DesktopBridge, "readGoals">,
	control: (action: GoalAction, goalId: string) => Promise<boolean>,
	logger: Logger,
) {
	const goals = ref<GoalView[]>([]);
	const error = ref<string | null>(null);
	const pendingAction = ref<GoalAction | null>(null);
	const loading = ref(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	let reading: Promise<void> | undefined;
	let closed = false;

	function refresh(): Promise<void> {
		if (closed) return Promise.resolve();
		if (reading) return reading;
		logger.info("开始刷新当前会话目标栏");
		const current = { ...target() };
		const version = generation;
		clearTimeout(timer);
		loading.value = true;
		const pending = Promise.resolve().then(async () => {
			try {
				// 1.1 启动恢复与手动切换规则一致，不屏蔽已经绑定的目标。
				const snapshot = await port.readGoals(current);
				if (closed || version !== generation) return;
				goals.value = snapshot.goals;
				error.value = null;
			} catch (cause) {
				if (!closed && version === generation)
					error.value = cause instanceof Error ? cause.message : "目标状态读取失败";
			} finally {
				if (!closed && version === generation) {
					reading = undefined;
					loading.value = false;
					timer = setTimeout(() => {
						void refresh();
					}, 2500);
				}
				logger.info("当前会话目标栏刷新结束");
			}
		});
		reading = pending;
		return pending;
	}

	/*
	 * ========================================================================
	 * 步骤2：等待目标操作实际结束
	 * ========================================================================
	 * 数据源：绑定目标 ID 的控制回调和确认弹窗生命周期。
	 * 操作：1) 轮询不能解除按钮忙碌；2) 失败保留目标，完成后刷新真实状态。
	 */
	async function act(action: GoalAction): Promise<void> {
		const goal = goals.value[0];
		if (!goal || pendingAction.value || closed) return;
		logger.info("开始提交目标栏操作");
		const version = generation;
		pendingAction.value = action;
		try {
			// 2.1 终态不提交继续，其他拒绝原因由插件处理。
			if (goal.status === "complete" && action === "resume") return;
			const accepted = await control(action, goal.id);
			if (closed || version !== generation) return;
			if (!accepted) error.value = "目标操作未完成，请核对提示后重试";
			else {
				await reading;
				await refresh();
			}
		} catch (cause) {
			if (!closed && version === generation) error.value = cause instanceof Error ? cause.message : "目标操作失败";
		} finally {
			if (!closed && version === generation) pendingAction.value = null;
			logger.info("目标栏操作提交结束");
		}
	}

	watch(
		() => {
			const value = target();
			return [value.cwd, value.sessionId, value.generation] as const;
		},
		() => {
			logger.info("开始切换目标栏会话");
			// 2.2 代次失效同步发生，不允许旧请求在下一次界面更新前重新显示旧目标。
			generation += 1;
			clearTimeout(timer);
			reading = undefined;
			goals.value = [];
			error.value = null;
			pendingAction.value = null;
			void refresh();
			logger.info("目标栏会话切换结束");
		},
		{ immediate: true, flush: "sync" },
	);
	onScopeDispose(() => {
		logger.info("开始释放目标栏会话");
		closed = true;
		generation += 1;
		clearTimeout(timer);
		logger.info("目标栏会话释放结束");
	});
	return { goals, error, pendingAction, loading, refresh, act };
}
