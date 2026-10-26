<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ParallelJob } from "../../shared/parallel.ts";
import { UButton, UModal } from "../ui.ts";

const props = defineProps<{ cwd: string | null }>();
const open = defineModel<boolean>({ default: false });
const emit = defineEmits<{ openSession: [job: ParallelJob] }>();
const bridge = window.piDesktop;
const jobs = ref<ParallelJob[]>([]);
const text = ref("");
const error = ref("");
const loading = ref(false);
const starting = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

const running = computed(() => jobs.value.filter((job) => job.status === "running").length);
const queued = computed(() => jobs.value.filter((job) => job.status === "queued").length);
const canStart = computed(() => !!props.cwd && text.value.trim().length > 0 && !starting.value && !loading.value);

function label(status: ParallelJob["status"]): string {
	if (status === "queued") return "排队中";
	if (status === "running") return "运行中";
	if (status === "completed") return "已完成";
	if (status === "interrupted") return "已中断";
	if (status === "canceled") return "已取消";
	return "失败";
}

function message(reason: unknown): string {
	return reason instanceof Error ? reason.message : "并行任务操作失败";
}

async function refresh(): Promise<void> {
	try {
		jobs.value = await bridge.listParallelJobs();
	} catch (reason) {
		error.value = message(reason);
	}
}

async function start(): Promise<void> {
	if (!canStart.value || !props.cwd) return;
	starting.value = true;
	error.value = "";
	try {
		await bridge.startParallelJob({ cwd: props.cwd, text: text.value.trim() });
		text.value = "";
		await refresh();
	} catch (reason) {
		error.value = message(reason);
	} finally {
		starting.value = false;
	}
}

async function cancel(job: ParallelJob): Promise<void> {
	error.value = "";
	try {
		await bridge.cancelParallelJob({ id: job.id });
		await refresh();
	} catch (reason) {
		error.value = message(reason);
	}
}

function openSession(job: ParallelJob): void {
	if (job.sessionId) emit("openSession", job);
}

watch(open, (value) => {
	if (timer) clearInterval(timer);
	timer = undefined;
	if (!value) return;
	error.value = "";
	loading.value = true;
	void refresh().finally(() => {
		loading.value = false;
	});
	timer = setInterval(() => {
		void refresh();
	}, 1500);
});

onBeforeUnmount(() => {
	if (timer) clearInterval(timer);
});
</script>

<template>
	<UModal
		v-model:open="open"
		title="并行任务"
		description="每个任务从当前 HEAD 创建独立工作树，最多同时运行 2 个，超出的任务排队。不包含来源目录未提交的改动，工作树会保留供核对。"
	>
		<template #body>
			<form class="parallel-form" @submit.prevent="start">
				<textarea
					v-model="text"
					rows="3"
					maxlength="100000"
					placeholder="描述一个可以独立完成的后台任务…"
					:disabled="!cwd"
				></textarea>
				<div>
					<span v-if="!cwd">请先打开项目</span>
					<span v-else>运行中 {{ running }} · 排队 {{ queued }}</span>
					<UButton type="submit" color="neutral" size="sm" :disabled="!canStart" :loading="starting"
						>启动任务</UButton
					>
				</div>
			</form>
			<p v-if="error" class="parallel-error" role="alert">{{ error }}</p>

			<div class="parallel-list">
				<div v-if="jobs.length === 0 && !loading" class="parallel-empty">还没有后台任务。</div>
				<article v-for="job in jobs" :key="job.id" class="parallel-job" :class="job.status">
					<header>
						<strong :title="job.title">{{ job.title }}</strong>
						<span class="parallel-status">{{ label(job.status) }}</span>
					</header>
					<small :title="job.executionCwd ?? job.cwd">{{ job.executionCwd ?? job.cwd }}</small>
					<small v-if="job.branch">{{ job.branch }}</small>
					<p v-if="job.result">{{ job.result }}</p>
					<p v-else-if="job.error" class="parallel-error">{{ job.error }}</p>
					<footer>
						<UButton
							v-if="job.status === 'completed' || job.status === 'failed'"
							color="neutral"
							variant="outline"
							size="xs"
							:disabled="!job.sessionId"
							@click="openSession(job)"
							>打开会话</UButton
						>
						<UButton
							v-if="job.status === 'queued' || job.status === 'running'"
							color="error"
							variant="ghost"
							size="xs"
							@click="cancel(job)"
							>取消</UButton
						>
					</footer>
				</article>
			</div>
		</template>
	</UModal>
</template>

<style scoped>
.parallel-form {
	display: grid;
	gap: 7px;
	margin-bottom: 14px;
}
.parallel-form textarea {
	width: 100%;
	min-height: 74px;
	padding: 9px 10px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--surface-raised);
	color: var(--ink);
	font-family: inherit;
	font-size: 12px;
	line-height: 1.55;
	outline: none;
	resize: vertical;
}
.parallel-form textarea:focus {
	border-color: var(--accent);
}
.parallel-form > div {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	color: var(--faint);
	font-size: 10px;
}
.parallel-error {
	margin: 0;
	color: #bd5a4b;
	font-size: 11px;
}
.parallel-list {
	display: grid;
	max-height: 46vh;
	overflow-y: auto;
	border-top: 1px solid var(--line-soft);
}
.parallel-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	min-height: 120px;
	color: var(--faint);
	font-size: 11px;
}
.parallel-job {
	display: grid;
	gap: 5px;
	padding: 10px 2px;
	border-bottom: 1px solid var(--line-soft);
}
.parallel-job header {
	display: flex;
	align-items: center;
	gap: 8px;
}
.parallel-job strong {
	overflow: hidden;
	color: var(--ink);
	font-size: 12px;
	font-weight: 550;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.parallel-status {
	flex: none;
	margin-left: auto;
	padding: 2px 5px;
	border-radius: 3px;
	background: var(--line-soft);
	color: var(--faint);
	font-size: 9px;
}
.parallel-job.running .parallel-status {
	background: var(--sage-soft);
	color: var(--sage);
}
.parallel-job.failed .parallel-status,
.parallel-job.interrupted .parallel-status {
	color: #bd5a4b;
}
.parallel-job small {
	overflow: hidden;
	color: var(--faint);
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 9px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.parallel-job p {
	display: -webkit-box;
	margin: 0;
	overflow: hidden;
	color: var(--muted);
	font-size: 11px;
	line-height: 1.55;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 4;
}
.parallel-job footer {
	display: flex;
	gap: 3px;
	margin-top: 2px;
}
</style>
