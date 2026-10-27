import { onScopeDispose, ref, watch } from "vue";
import type { Logger } from "../../shared/logger.ts";
import type { DesktopBridge } from "../../shared/protocol.ts";
import type { SubagentInspection } from "../../shared/subagents.ts";

const errors = {
	invalid_request: "子智能体查询参数无效",
	not_found: "当前会话中找不到这个子智能体",
	foreign_session: "这个子智能体属于其他会话",
	stale: "子智能体记录已清理",
	no_active_session: "请先连接项目",
	internal: "子智能体记录读取失败",
};

/*
 * ========================================================================
 * 步骤1：独立加载官方详情与完整转录
 * ========================================================================
 * 数据源：当前标签目标、宿主官方详情查询和按任务归属读取的转录。
 * 操作：1) 两个来源分别保留结果；2) 用代次拒绝切换与销毁后的迟到回复。
 */
export function useSubagentDetails(
	target: () => { runId: string; childId?: string; active: boolean },
	port: Pick<DesktopBridge, "inspectSubagent" | "readSubagentTranscript">,
	logger: Logger,
) {
	const inspection = ref<SubagentInspection | null>(null);
	const transcript = ref<string | null>(null);
	const loading = ref(false);
	const error = ref<string | null>(null);
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let previousKey = "";

	async function load(version: number): Promise<void> {
		logger.info("开始加载子智能体右栏详情");
		const current = target();
		loading.value = true;
		try {
			// 1.1 一个来源失败不会抹掉另一个来源，短暂失败也保留本任务已有内容。
			const [detail, record] = await Promise.allSettled([
				Promise.resolve().then(() => port.inspectSubagent(current.runId, current.childId)),
				Promise.resolve().then(() => port.readSubagentTranscript(current.runId, current.childId)),
			]);
			if (closed || version !== generation) return;
			if (detail.status === "fulfilled") inspection.value = detail.value;
			if (record.status === "fulfilled" && record.value !== null) transcript.value = record.value;
			if (detail.status === "fulfilled" && detail.value.error?.code === "foreign_session") transcript.value = null;
			error.value =
				detail.status === "rejected"
					? detail.reason instanceof Error
						? detail.reason.message
						: "子智能体详情读取失败"
					: detail.value.error
						? errors[detail.value.error.code]
						: null;
		} finally {
			// 1.2 完成后安排下一次读取，避免慢请求叠加；终态仍会最后读取一次。
			if (!closed && version === generation) {
				loading.value = false;
				if (target().active || inspection.value?.status === "running" || inspection.value?.status === "queued")
					timer = setTimeout(() => {
						void load(version);
					}, 2500);
			}
			logger.info("子智能体右栏详情加载结束");
		}
	}

	function refresh(): void {
		logger.info("开始刷新子智能体右栏");
		try {
			// 1.3 重试与目标切换同时使旧读取失效。
			clearTimeout(timer);
			const current = target();
			const key = JSON.stringify([current.runId, current.childId]);
			if (key !== previousKey) {
				previousKey = key;
				inspection.value = null;
				transcript.value = null;
				error.value = null;
			}
			void load(++generation);
		} finally {
			logger.info("子智能体右栏刷新派发结束");
		}
	}

	watch(
		() => {
			const current = target();
			return [current.runId, current.childId, current.active] as const;
		},
		refresh,
		{ immediate: true },
	);
	onScopeDispose(() => {
		logger.info("开始释放子智能体右栏详情");
		// 1.4 销毁后不安装旧结果，也不重建轮询。
		closed = true;
		generation += 1;
		clearTimeout(timer);
		logger.info("子智能体右栏详情释放结束");
	});
	return { inspection, transcript, loading, error, refresh };
}
