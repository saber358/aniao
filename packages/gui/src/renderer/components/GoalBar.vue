<script setup lang="ts">
import { computed, ref } from "vue";
import type { GoalAction, GoalStatus, GoalTaskView } from "../../shared/goals.ts";
import { createLogger } from "../../shared/logger.ts";
import { useGoals } from "../composables/use-goals.ts";
import { UIcon } from "../ui.ts";

const props = defineProps<{
	cwd: string;
	sessionId: string;
	generation: string;
	control: (action: GoalAction, goalId: string) => Promise<boolean>;
}>();
/*
 * ========================================================================
 * 步骤1：展示当前会话的目标
 * ========================================================================
 * 数据源：受会话身份约束的目标接口。
 * 操作：1) 启动即显示已绑定目标；2) 无焦点会话不显示其他会话目标。
 */
const logger = createLogger("goal-bar");
logger.info("开始建立当前会话目标栏");
// 1.1 操作回调等待宿主实际完成，不让定时刷新提前释放按钮。
const { goals, error, pendingAction, loading, refresh, act } = useGoals(
	() => ({ cwd: props.cwd, sessionId: props.sessionId, generation: props.generation }),
	window.piDesktop,
	(action, goalId) => props.control(action, goalId),
	logger,
);
const expanded = ref(false);
const goal = computed(() => goals.value[0]);
logger.info("当前会话目标栏建立完成");

const statusText: Record<GoalStatus, string> = {
	running: "进行中",
	idle: "等待继续",
	paused: "已暂停",
	blocked: "受阻",
	budget_limited: "预算限制",
	complete: "已完成",
};

function formatDuration(seconds: number): string {
	if (!seconds) return "";
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} 分`;
	const hours = Math.floor(minutes / 60);
	return `${hours} 小时 ${minutes % 60} 分`;
}

function formatTokens(tokens: number): string {
	if (!tokens) return "";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
	return String(tokens);
}

function taskIcon(task: GoalTaskView): string {
	if (task.status === "complete") return "i-lucide-circle-check-big";
	if (task.status === "skipped") return "i-lucide-circle-slash-2";
	if (task.current) return "i-lucide-circle-dot-dashed";
	return "i-lucide-circle";
}

function taskClass(task: GoalTaskView): Record<string, boolean> {
	return { complete: task.status === "complete", skipped: task.status === "skipped", current: task.current };
}
</script>

<template>
	<div v-if="error" class="goal-read-error" role="alert">
		<span>{{ error }}</span
		><button type="button" :disabled="loading || pendingAction !== null" @click="refresh">重试</button>
	</div>
	<section v-if="goal" class="goal-bar" :class="`status-${goal.status}`" aria-label="目标进度">
		<div
			class="goal-summary"
			role="button"
			tabindex="0"
			:aria-expanded="expanded"
			@click="expanded = !expanded"
			@keydown.enter.prevent="expanded = !expanded"
			@keydown.space.prevent="expanded = !expanded"
		>
			<span class="goal-mark" aria-hidden="true">
				<UIcon name="i-lucide-target" />
			</span>
			<span class="goal-copy">
				<span class="goal-kicker">
					<span class="goal-label">目标</span>
					<span class="goal-status"><i></i>{{ statusText[goal.status] }}</span>
					<span v-if="goal.sisyphus" class="goal-chip">有序</span>
					<span v-if="goal.auditor" class="goal-chip auditor">审计</span>
				</span>
				<strong class="goal-title">{{ goal.title }}</strong>
			</span>
			<span class="goal-progress">
				<span v-if="goal.progress" class="goal-progress-text">
					{{ goal.progress.completed }}/{{ goal.progress.total }}
				</span>
				<span v-if="goal.progress" class="goal-progress-track" aria-hidden="true">
					<i :style="{ width: `${goal.progress.percentage}%` }"></i>
				</span>
				<span class="goal-usage">
					{{
						[formatDuration(goal.usage.activeSeconds), formatTokens(goal.usage.tokensUsed)]
							.filter(Boolean)
							.join(" · ")
					}}
				</span>
			</span>
			<span class="goal-actions" aria-label="目标操作">
				<button
					v-if="goal.status !== 'complete'"
					type="button"
					class="goal-action"
					:disabled="pendingAction !== null"
					:title="goal.status === 'running' ? '暂停目标' : '继续目标'"
					:aria-label="goal.status === 'running' ? '暂停目标' : '继续目标'"
					@click.stop="act(goal.status === 'running' ? 'pause' : 'resume')"
				>
					<span>{{ goal.status === "running" ? "暂停" : "继续" }}</span>
				</button>
				<button
					type="button"
					class="goal-action danger"
					:disabled="pendingAction !== null"
					title="删除目标"
					aria-label="删除目标"
					@click.stop="act('delete')"
				>
					<UIcon name="i-lucide-trash-2" aria-hidden="true" />
					<span>删除</span>
				</button>
			</span>
			<UIcon
				:name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
				class="goal-chevron"
				aria-hidden="true"
			/>
		</div>

		<div v-if="expanded" class="goal-detail">
			<p class="goal-objective">{{ goal.objective }}</p>

			<div v-if="goal.currentTask" class="goal-current">
				<UIcon name="i-lucide-locate-fixed" aria-hidden="true" />
				<span>当前任务</span>
				<strong>{{ goal.currentTask.title }}</strong>
			</div>

			<div v-if="goal.tasks.length" class="goal-tasks">
				<div
					v-for="task in goal.tasks.slice(0, 80)"
					:key="task.id"
					class="goal-task"
					:class="taskClass(task)"
					:style="{ paddingLeft: `${10 + task.depth * 16}px` }"
				>
					<UIcon :name="taskIcon(task)" aria-hidden="true" />
					<span>{{ task.title }}</span>
					<small v-if="task.verificationContract">需证据</small>
				</div>
			</div>

			<div v-if="goal.verificationContract" class="goal-contract">
				<UIcon name="i-lucide-shield-check" aria-hidden="true" />
				<div>
					<span>完成条件</span>
					<p>{{ goal.verificationContract }}</p>
				</div>
			</div>

			<p v-if="goal.pauseReason" class="goal-note">
				<UIcon name="i-lucide-circle-pause" aria-hidden="true" />
				{{ goal.pauseReason }}
			</p>
			<p v-if="goal.truncated" class="goal-other">内容较长，当前展示部分信息。完整内容保存在目标插件中。</p>
		</div>
	</section>
</template>

<style scoped>
.goal-read-error {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 8px;
	color: var(--danger);
	font-size: 11px;
}
.goal-read-error button {
	border: 0;
	background: transparent;
	color: inherit;
	cursor: pointer;
	text-decoration: underline;
}
.goal-bar {
	margin: 0 0 10px;
	overflow: hidden;
	border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--line-soft));
	border-radius: 12px;
	background:
		linear-gradient(120deg, color-mix(in srgb, var(--accent) 7%, var(--surface)) 0%, var(--surface) 62%),
		var(--surface);
	box-shadow: 0 1px 2px rgb(0 0 0 / 3%);
	transition:
		border-color 160ms ease,
		box-shadow 160ms ease;
}
.goal-bar:hover {
	border-color: color-mix(in srgb, var(--accent) 30%, var(--line-soft));
	box-shadow: 0 3px 12px rgb(0 0 0 / 5%);
}
.goal-bar.status-paused,
.goal-bar.status-idle {
	border-color: color-mix(in srgb, #d99a2b 22%, var(--line-soft));
	background: var(--surface);
}
.goal-bar.status-blocked {
	border-color: color-mix(in srgb, #d95c5c 24%, var(--line-soft));
	background: var(--surface);
}
.goal-summary {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	padding: 9px 12px;
	border: 0;
	background: transparent;
	color: inherit;
	cursor: pointer;
	font: inherit;
	text-align: left;
}
.goal-mark {
	display: grid;
	flex: none;
	width: 30px;
	height: 30px;
	place-items: center;
	border-radius: 9px;
	background: color-mix(in srgb, var(--accent) 12%, var(--active));
	color: var(--accent);
	font-size: 16px;
}
.goal-copy {
	display: grid;
	gap: 2px;
	min-width: 0;
	flex: 1;
}
.goal-kicker {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
	color: var(--faint);
	font-size: 9px;
	line-height: 1.2;
}
.goal-label {
	letter-spacing: 0.08em;
}
.goal-status {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--muted);
}
.goal-status i {
	width: 5px;
	height: 5px;
	border-radius: 50%;
	background: var(--sage);
}
.status-paused .goal-status i,
.status-idle .goal-status i {
	background: #d99a2b;
}
.status-blocked .goal-status i {
	background: #d95c5c;
}
.status-running .goal-status i {
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--sage) 15%, transparent);
}
.goal-chip {
	padding: 1px 5px;
	border-radius: 4px;
	background: var(--active);
	color: var(--muted);
	font-size: 8px;
	letter-spacing: 0.02em;
}
.goal-chip.auditor {
	color: var(--sage);
}
.goal-title {
	overflow: hidden;
	color: var(--ink);
	font-size: 12px;
	font-weight: 550;
	line-height: 1.4;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.goal-progress {
	display: flex;
	align-items: center;
	gap: 7px;
	flex: none;
}
.goal-progress-text {
	color: var(--muted);
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 10px;
}
.goal-progress-track {
	width: 62px;
	height: 4px;
	overflow: hidden;
	border-radius: 4px;
	background: var(--active);
}
.goal-progress-track i {
	display: block;
	height: 100%;
	border-radius: inherit;
	background: linear-gradient(90deg, var(--sage), var(--accent));
	transition: width 220ms ease;
}
.goal-usage {
	max-width: 120px;
	overflow: hidden;
	color: var(--faint);
	font-size: 9px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.goal-chevron {
	flex: none;
	color: var(--faint);
	font-size: 13px;
}
.goal-actions {
	display: flex;
	align-items: center;
	gap: 2px;
	flex: none;
	opacity: 1;
}
.goal-action {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: auto;
	height: 24px;
	padding: 0 7px;
	gap: 3px;
	border: 0;
	border-radius: 5px;
	background: transparent;
	color: var(--muted);
	cursor: pointer;
	font: inherit;
	font-size: 10px;
	line-height: 1;
	white-space: nowrap;
}
.goal-action:hover:not(:disabled) {
	background: var(--active);
	color: var(--ink);
}
.goal-action.danger:hover:not(:disabled) {
	background: color-mix(in srgb, #d95c5c 10%, transparent);
	color: #c54b4b;
}
.goal-action:disabled {
	cursor: default;
	opacity: 0.4;
}
.goal-detail {
	display: grid;
	gap: 11px;
	padding: 0 13px 13px 52px;
	border-top: 1px solid color-mix(in srgb, var(--line-soft) 70%, transparent);
	margin-top: 0;
	padding-top: 11px;
}
.goal-objective {
	margin: 0;
	color: var(--muted);
	font-size: 10px;
	line-height: 1.65;
	white-space: pre-wrap;
}
.goal-current {
	display: flex;
	align-items: baseline;
	gap: 6px;
	min-width: 0;
	color: var(--faint);
	font-size: 10px;
}
.goal-current strong {
	overflow: hidden;
	color: var(--ink);
	font-size: 11px;
	font-weight: 500;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.goal-tasks {
	display: grid;
	gap: 1px;
	max-height: 230px;
	overflow-y: auto;
	padding: 2px 0;
}
.goal-task {
	display: flex;
	align-items: center;
	gap: 6px;
	min-height: 23px;
	border-radius: 5px;
	color: var(--muted);
	font-size: 10px;
}
.goal-task > span {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.goal-task small {
	margin-left: auto;
	padding: 1px 4px;
	border-radius: 3px;
	background: var(--active);
	color: var(--faint);
	font-size: 8px;
}
.goal-task.complete {
	color: var(--faint);
	text-decoration: line-through;
	text-decoration-color: color-mix(in srgb, var(--faint) 45%, transparent);
}
.goal-task.current {
	background: color-mix(in srgb, var(--accent) 7%, transparent);
	color: var(--ink);
}
.goal-task.current > svg {
	color: var(--accent);
}
.goal-task.skipped {
	color: var(--faint);
}
.goal-contract {
	display: flex;
	gap: 8px;
	padding: 8px 9px;
	border: 1px solid color-mix(in srgb, var(--sage) 18%, var(--line-soft));
	border-radius: 8px;
	background: color-mix(in srgb, var(--sage) 4%, var(--surface));
	color: var(--sage);
}
.goal-contract > div {
	display: grid;
	gap: 2px;
	min-width: 0;
}
.goal-contract span {
	font-size: 9px;
	font-weight: 550;
}
.goal-contract p {
	margin: 0;
	overflow: hidden;
	color: var(--muted);
	font-size: 10px;
	line-height: 1.55;
	white-space: pre-wrap;
}
.goal-note,
.goal-other {
	display: flex;
	align-items: center;
	gap: 5px;
	margin: 0;
	color: var(--faint);
	font-size: 9px;
}
.goal-note {
	color: #b57d22;
}
</style>
