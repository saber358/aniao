<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ScheduledRun, ScheduledSnapshot, ScheduledTask } from "../../shared/schedule.ts";
import { UButton, UIcon } from "../ui.ts";

const props = defineProps<{ cwd: string }>();
const emit = defineEmits<{ openParallel: [] }>();
const bridge = window.piDesktop;
const snapshot = ref<ScheduledSnapshot | null>(null);
const text = ref("");
const everyMinutes = ref(30);
const catchUp = ref(false);
const creating = ref(false);
const query = ref("");
const filter = ref<"all" | "enabled" | "paused">("all");
const error = ref("");
const working = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

const tasks = computed(() => {
	const value = query.value.trim().toLowerCase();
	return (snapshot.value?.tasks ?? []).filter((task) => {
		if (filter.value === "enabled" && task.paused) return false;
		if (filter.value === "paused" && !task.paused) return false;
		return !value || `${task.title} ${task.prompt}`.toLowerCase().includes(value);
	});
});
const runs = computed(() => snapshot.value?.runs ?? []);
const canCreate = computed(
	() => !!props.cwd && text.value.trim().length > 0 && everyMinutes.value >= 5 && !working.value,
);
const tabCounts = computed(() => {
	const all = snapshot.value?.tasks ?? [];
	return {
		all: all.length,
		enabled: all.filter((task) => !task.paused).length,
		paused: all.filter((task) => task.paused).length,
	};
});

function message(reason: unknown): string {
	return reason instanceof Error ? reason.message : "自动化任务操作失败";
}

function time(value: number | undefined): string {
	if (!value) return "—";
	return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function runStatus(status: string): string {
	if (status === "queued") return "排队中";
	if (status === "running") return "运行中";
	if (status === "completed") return "完成";
	if (status === "interrupted") return "中断";
	if (status === "canceled") return "取消";
	return "失败";
}

function taskRuns(task: ScheduledTask): ScheduledRun[] {
	return runs.value.filter((run) => run.taskId === task.id).slice(0, 3);
}

async function refresh(): Promise<void> {
	try {
		snapshot.value = await bridge.listSchedules();
	} catch (reason) {
		error.value = message(reason);
	}
}

async function apply(action: () => Promise<ScheduledSnapshot>): Promise<void> {
	working.value = true;
	error.value = "";
	try {
		snapshot.value = await action();
	} catch (reason) {
		error.value = message(reason);
	} finally {
		working.value = false;
	}
}

async function create(): Promise<void> {
	if (!canCreate.value) return;
	await apply(() =>
		bridge.createSchedule({
			cwd: props.cwd,
			text: text.value.trim(),
			everyMinutes: everyMinutes.value,
			catchUp: catchUp.value,
		}),
	);
	text.value = "";
	creating.value = false;
}

async function pause(task: ScheduledTask): Promise<void> {
	await apply(() => bridge.pauseSchedule({ id: task.id, paused: !task.paused }));
}

async function runNow(task: ScheduledTask): Promise<void> {
	await apply(() => bridge.runScheduleNow(task.id));
}

async function remove(task: ScheduledTask): Promise<void> {
	if (!window.confirm(`删除定时任务「${task.title}」？`)) return;
	await apply(() => bridge.deleteSchedule(task.id));
}

onMounted(() => {
	void refresh();
	timer = setInterval(() => {
		void refresh();
	}, 3000);
});
onBeforeUnmount(() => {
	if (timer) clearInterval(timer);
});
</script>

<template>
	<section class="main-page automation-page">
		<div class="main-page-inner">
			<header class="automation-head">
				<div>
					<h1>自动化任务</h1>
				</div>
				<div class="automation-head-actions">
					<UButton
						color="neutral"
						variant="outline"
						size="sm"
						icon="i-lucide-git-branch"
						@click="emit('openParallel')"
						>并行任务</UButton
					>
					<UButton color="neutral" variant="solid" size="sm" icon="i-lucide-plus" @click="creating = true"
						>新建</UButton
					>
				</div>
			</header>

			<div class="automation-tabs" role="tablist" aria-label="自动化任务筛选">
				<button
					v-for="tab in [
						{ id: 'all' as const, label: '全部', count: tabCounts.all },
						{ id: 'enabled' as const, label: '已开启', count: tabCounts.enabled },
						{ id: 'paused' as const, label: '已暂停', count: tabCounts.paused },
					]"
					:key="tab.id"
					type="button"
					role="tab"
					:aria-selected="filter === tab.id"
					:class="{ active: filter === tab.id }"
					@click="filter = tab.id"
				>
					{{ tab.label }}<em>{{ tab.count }}</em>
				</button>
			</div>

			<label class="automation-search">
				<UIcon name="i-lucide-search" aria-hidden="true" />
				<input v-model="query" placeholder="搜索自动化任务" />
			</label>

			<form v-if="creating" class="automation-form" @submit.prevent="create">
				<textarea
					v-model="text"
					rows="3"
					maxlength="100000"
					placeholder="描述要定时执行的任务…"
					autofocus
				></textarea>
				<div class="automation-options">
					<label>
						<span>每隔</span>
						<input v-model.number="everyMinutes" type="number" min="5" max="10080" step="1" />
						<span>分钟</span>
					</label>
					<label>
						<input v-model="catchUp" type="checkbox" />
						<span>错过时补跑一次</span>
					</label>
					<span class="automation-note">应用关闭或休眠后按此策略处理。</span>
					<div class="automation-form-actions">
						<UButton color="neutral" variant="ghost" size="sm" @click="creating = false">取消</UButton>
						<UButton type="submit" color="neutral" size="sm" :disabled="!canCreate" :loading="working"
							>创建任务</UButton
						>
					</div>
				</div>
			</form>
			<p v-if="error" class="automation-error" role="alert">{{ error }}</p>

			<div v-if="snapshot && tasks.length === 0" class="automation-empty">
				<UIcon name="i-lucide-clock" aria-hidden="true" />
				<p>{{ query ? "没有匹配的自动化任务" : "还没有自动化任务，在下方创建的任务会显示在这里" }}</p>
				<UButton v-if="!query" color="neutral" variant="outline" size="sm" @click="creating = true"
					>新建自动化任务</UButton
				>
			</div>

			<div v-else class="automation-list">
				<article v-for="task in tasks" :key="task.id" class="automation-task">
					<header>
						<div>
							<strong :title="task.title">{{ task.title }}</strong>
							<span class="automation-status" :class="{ paused: task.paused }">{{
								task.paused ? "已暂停" : "已开启"
							}}</span>
						</div>
						<span class="automation-time">下次 {{ time(task.nextRunAt) }}</span>
					</header>
					<p>{{ task.prompt }}</p>
					<small>每隔 {{ task.everyMinutes }} 分钟 · {{ task.catchUp ? "补跑一次" : "跳过错过" }}</small>
					<footer>
						<UButton color="neutral" variant="ghost" size="xs" :disabled="working" @click="pause(task)">
							{{ task.paused ? "恢复" : "暂停" }}
						</UButton>
						<UButton color="neutral" variant="outline" size="xs" :disabled="working" @click="runNow(task)"
							>立即运行</UButton
						>
						<UButton color="error" variant="ghost" size="xs" :disabled="working" @click="remove(task)"
							>删除</UButton
						>
					</footer>
					<div v-if="taskRuns(task).length" class="automation-runs">
						<div v-for="run in taskRuns(task)" :key="run.id">
							<span :class="run.status">{{ runStatus(run.status) }}</span>
							<em>{{ time(run.createdAt) }}</em>
							<p v-if="run.error">{{ run.error }}</p>
							<p v-else-if="run.result">{{ run.result }}</p>
						</div>
					</div>
				</article>
			</div>
		</div>
	</section>
</template>

<style scoped>
.main-page {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	background: var(--surface);
}
.main-page-inner {
	width: min(100%, 1000px);
	margin: 0 auto;
	padding: 32px 38px 48px;
}
.automation-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 20px;
	margin-bottom: 20px;
}
.automation-head h1 {
	margin: 0;
	color: var(--ink);
	font-size: 24px;
	font-weight: 650;
	letter-spacing: -0.5px;
}
.automation-head-actions {
	display: flex;
	align-items: center;
	gap: 6px;
}
.automation-tabs {
	display: flex;
	gap: 2px;
	margin-bottom: 12px;
}
.automation-tabs button {
	display: flex;
	align-items: center;
	gap: 5px;
	padding: 6px 10px;
	border: 0;
	border-radius: 6px;
	background: transparent;
	color: var(--muted);
	cursor: pointer;
	font-size: 11px;
}
.automation-tabs button.active {
	background: var(--sidebar);
	color: var(--ink);
}
.automation-tabs em {
	color: var(--faint);
	font-size: 9px;
	font-style: normal;
}
.automation-search {
	display: flex;
	align-items: center;
	gap: 8px;
	height: 38px;
	margin-bottom: 18px;
	padding: 0 11px;
	border: 1px solid var(--line);
	border-radius: 9px;
	background: var(--surface-raised);
	color: var(--faint);
}
.automation-search input {
	flex: 1;
	min-width: 0;
	border: 0;
	background: transparent;
	color: var(--ink);
	font: inherit;
	font-size: 12px;
	outline: none;
}
.automation-form {
	display: grid;
	gap: 8px;
	margin-bottom: 18px;
	padding: 12px;
	border: 1px solid var(--line);
	border-radius: 10px;
	background: var(--surface-raised);
}
.automation-form textarea {
	width: 100%;
	min-height: 76px;
	padding: 9px 10px;
	border: 1px solid var(--line-soft);
	border-radius: 7px;
	background: var(--surface);
	color: var(--ink);
	font: inherit;
	font-size: 12px;
	line-height: 1.55;
	resize: vertical;
	outline: none;
}
.automation-form textarea:focus {
	border-color: var(--accent);
}
.automation-options {
	display: flex;
	align-items: center;
	gap: 12px;
	flex-wrap: wrap;
	color: var(--faint);
	font-size: 10px;
}
.automation-options label {
	display: flex;
	align-items: center;
	gap: 5px;
}
.automation-options input[type="number"] {
	width: 68px;
	height: 27px;
	padding: 0 6px;
	border: 1px solid var(--line);
	border-radius: 5px;
	background: var(--surface);
	color: var(--ink);
	font: inherit;
	font-size: 11px;
}
.automation-options input[type="checkbox"] {
	accent-color: var(--accent);
}
.automation-note {
	color: var(--faint);
}
.automation-form-actions {
	display: flex;
	gap: 3px;
	margin-left: auto;
}
.automation-error {
	margin: 0 0 10px;
	color: #bd5a4b;
	font-size: 11px;
}
.automation-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	flex-direction: column;
	gap: 10px;
	min-height: 300px;
	color: var(--faint);
	font-size: 11px;
	text-align: center;
}
.automation-empty > svg {
	font-size: 24px;
}
.automation-empty p {
	margin: 0;
}
.automation-list {
	display: grid;
	border-top: 1px solid var(--line-soft);
}
.automation-task {
	display: grid;
	gap: 6px;
	padding: 12px 2px;
	border-bottom: 1px solid var(--line-soft);
}
.automation-task header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}
.automation-task header > div {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}
.automation-task strong {
	overflow: hidden;
	color: var(--ink);
	font-size: 12px;
	font-weight: 550;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.automation-status {
	flex: none;
	padding: 2px 5px;
	border-radius: 3px;
	background: var(--sage-soft);
	color: var(--sage);
	font-size: 9px;
}
.automation-status.paused {
	background: var(--line-soft);
	color: var(--faint);
}
.automation-time {
	flex: none;
	color: var(--faint);
	font-size: 9px;
}
.automation-task > p {
	display: -webkit-box;
	margin: 0;
	overflow: hidden;
	color: var(--muted);
	font-size: 11px;
	line-height: 1.55;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 3;
}
.automation-task > small {
	color: var(--faint);
	font-size: 9px;
}
.automation-task footer {
	display: flex;
	gap: 3px;
}
.automation-runs {
	display: grid;
	gap: 3px;
	padding-top: 5px;
	border-top: 1px dashed var(--line-soft);
}
.automation-runs > div {
	display: grid;
	grid-template-columns: auto auto 1fr;
	gap: 6px;
	align-items: baseline;
	color: var(--faint);
	font-size: 9px;
}
.automation-runs span {
	color: var(--muted);
}
.automation-runs span.completed {
	color: var(--sage);
}
.automation-runs span.failed,
.automation-runs span.interrupted {
	color: #bd5a4b;
}
.automation-runs em {
	font-style: normal;
}
.automation-runs p {
	grid-column: 1 / -1;
	display: -webkit-box;
	margin: 0;
	overflow: hidden;
	color: var(--muted);
	font-size: 10px;
	line-height: 1.45;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
}
@media (max-width: 900px) {
	.main-page-inner {
		padding: 24px 20px 36px;
	}
}
</style>
