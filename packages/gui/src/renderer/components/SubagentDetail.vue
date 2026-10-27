<script setup lang="ts">
import { computed } from "vue";
import type { SubagentNode, SubagentSnapshot } from "../../shared/subagents.ts";
import { createLogger } from "../../shared/logger.ts";
import { useSubagentDetails } from "../composables/use-subagent-details.ts";
import SubagentConversation from "./SubagentConversation.vue";

const props = defineProps<{
	snapshot: SubagentSnapshot | null;
	runId: string;
	childId?: string;
}>();

function findNode(node: SubagentNode, id: string): SubagentNode | undefined {
	if (node.id === id) return node;
	for (const child of node.children ?? []) {
		const found = findNode(child, id);
		if (found) return found;
	}
	return undefined;
}

const run = computed(() => props.snapshot?.runs.find((item) => item.id === props.runId));
const node = computed(() => {
	if (!run.value) return undefined;
	return props.childId && props.childId !== props.runId ? findNode(run.value, props.childId) : run.value;
});
const active = computed(() => node.value?.state === "queued" || node.value?.state === "running");

/*
 * ========================================================================
 * 步骤1：展示独立子任务详情与读取状态
 * ========================================================================
 * 数据源：官方详情、完整转录与当前运行快照。
 * 操作：1) 状态撤回后保留已读对话；2) 失败单独提示并允许重试。
 */
const logger = createLogger("subagent-detail");
logger.info("开始建立子智能体详情视图");
// 1.1 详情请求独立于状态组件，停止和完成后仍读取最后一次记录。
const { inspection, transcript, loading, error, refresh } = useSubagentDetails(
	() => ({ runId: props.runId, childId: props.childId, active: active.value }),
	window.piDesktop,
	logger,
);
const labels = {
	queued: "排队中",
	running: "运行中",
	complete: "已完成",
	failed: "执行失败",
	partial: "部分完成",
	paused: "已暂停",
	stopped: "已停止",
	rejected: "已拒绝",
};
const state = computed(() => node.value?.state ?? inspection.value?.status);
const model = computed(() =>
	inspection.value?.resolvedModel
		? `${inspection.value.resolvedModel.provider}/${inspection.value.resolvedModel.model}`
		: node.value?.model,
);
const hasRecord = computed(() =>
	Boolean(
		transcript.value || inspection.value?.task || inspection.value?.messages?.length || inspection.value?.finalOutput,
	),
);
logger.info("子智能体详情视图建立完成");
</script>

<template>
	<div class="subagent-detail">
		<header class="subagent-detail-summary">
			<strong>{{ node?.agent || inspection?.label || node?.label || "子智能体" }}</strong>
			<span v-if="state">{{ labels[state] }}</span>
			<span v-if="model">{{ model }}</span>
			<span v-if="node?.activity?.currentTool">正在调用 {{ node.activity.currentTool }}</span>
		</header>
		<div v-if="error" class="subagent-detail-error" role="alert">
			<span>{{ error }}</span>
			<button type="button" :disabled="loading" @click="refresh">重试</button>
		</div>
		<SubagentConversation
			v-if="hasRecord"
			:transcript="transcript"
			:inspection="inspection"
			:running="state === 'queued' || state === 'running'"
		/>
		<p v-else-if="!error" class="subagent-detail-empty">
			{{
				loading
					? "正在读取子智能体记录…"
					: active
						? "子智能体正在运行，等待首条消息…"
						: "该子智能体还没有可显示的对话记录。"
			}}
		</p>
		<p v-if="!transcript && inspection?.truncated" class="subagent-detail-empty">当前显示最近的部分记录。</p>
	</div>
</template>

<style scoped>
.subagent-detail {
	display: flex;
	flex: 1;
	min-height: 0;
	flex-direction: column;
	overflow: hidden;
}
.subagent-detail-summary,
.subagent-detail-error {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	padding: 12px 18px;
	border-bottom: 1px solid var(--line);
	color: var(--muted);
	font-size: 11px;
}
.subagent-detail-summary strong {
	color: var(--ink);
	font-weight: 550;
}
.subagent-detail-error {
	color: var(--danger);
}
.subagent-detail-error button {
	border: 0;
	background: transparent;
	color: inherit;
	cursor: pointer;
	text-decoration: underline;
}
.subagent-detail-empty {
	margin: 0;
	padding: 24px 20px;
	color: var(--faint);
	font-size: 11px;
	line-height: 1.6;
}
</style>
