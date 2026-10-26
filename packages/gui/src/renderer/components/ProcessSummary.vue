<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ProcessSummary } from "../adapters/chat-view.ts";
import { UIcon } from "../ui.ts";

const props = defineProps<{ data: ProcessSummary }>();
const showNote = ref(true);
const showSteps = ref(false);
const gatedByNote = computed(() => !props.data.running && !!props.data.note);
const expanded = computed(() => (gatedByNote.value ? showNote.value : showSteps.value));
const label = computed(() => {
	if (props.data.running) {
		if (props.data.operation === "command") return "正在运行命令";
		if (props.data.operation === "tool") return "正在调用工具";
		return "正在分析请求";
	}
	const base = props.data.toolCount > 0 ? "已完成" : "已思考";
	return props.data.durationMs ? `${base}，用时 ${formatDuration(props.data.durationMs)}` : base;
});
const stateIcon = computed(() => {
	if (props.data.running) {
		if (props.data.operation === "command") return "i-lucide-terminal";
		if (props.data.operation === "tool") return "i-lucide-wrench";
		return "i-lucide-brain";
	}
	return props.data.toolCount > 0 ? "i-lucide-check" : "i-lucide-sparkles";
});
const meta = computed(() => {
	if (!props.data.running) return undefined;
	if (props.data.operation === "analyzing") return props.data.thinking?.preview;
	return props.data.detail;
});
const metaTitle = computed(() =>
	props.data.operation === "analyzing" ? props.data.thinking?.title : props.data.detail,
);
watch(
	() => props.data.running,
	(value) => {
		if (!value) {
			showNote.value = true;
			showSteps.value = false;
		}
	},
);

function toggleSummary(): void {
	if (!gatedByNote.value) {
		showSteps.value = !showSteps.value;
		return;
	}
	showNote.value = !showNote.value;
	if (!showNote.value) showSteps.value = false;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}秒`;
	return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
</script>

<template>
	<div class="process-summary">
		<button
			type="button"
			class="process-trigger"
			:class="{ running: data.running }"
			:aria-expanded="expanded"
			@click="toggleSummary"
		>
			<UIcon :name="stateIcon" class="process-state-icon" :class="{ active: data.running }" aria-hidden="true" />
			<span class="process-label">{{ label }}</span>
			<span v-if="meta" class="process-meta" :title="metaTitle">· {{ meta }}</span>
			<UIcon name="i-lucide-chevron-down" class="process-chevron" :class="{ open: expanded }" />
		</button>
		<template v-if="gatedByNote && showNote">
			<div class="process-divider"></div>
			<button
				type="button"
				class="process-note process-note-button"
				:aria-expanded="showSteps"
				@click="showSteps = !showSteps"
			>
				<UIcon name="i-lucide-terminal" class="process-note-icon" aria-hidden="true" />
				<span class="process-note-text">{{ data.note }}</span>
			</button>
		</template>
		<div v-if="showSteps" class="process-body">
			<div
				v-for="step in data.steps"
				:key="step.id"
				class="process-step"
				:class="{ error: step.state === 'failed' || step.state === 'interrupted' }"
			>
				<span v-if="step.state === 'running'" class="process-spinner process-step-spinner" aria-hidden="true" />
				<UIcon v-else-if="step.kind === 'thinking'" name="i-lucide-sparkles" class="process-step-icon" />
				<UIcon v-else-if="step.kind === 'command'" name="i-lucide-terminal" class="process-step-icon" />
				<UIcon v-else-if="step.kind === 'edit'" name="i-lucide-pencil" class="process-step-icon" />
				<UIcon v-else-if="step.kind === 'write'" name="i-lucide-save" class="process-step-icon" />
				<UIcon v-else-if="step.kind === 'read'" name="i-lucide-file-text" class="process-step-icon" />
				<UIcon v-else-if="step.kind === 'search'" name="i-lucide-search" class="process-step-icon" />
				<UIcon v-else name="i-lucide-wrench" class="process-step-icon" />
				<span class="process-step-label">{{ step.label }}</span>
				<span class="process-step-sep">·</span>
				<span class="process-step-detail" :title="step.title">{{ step.detail }}</span>
			</div>
		</div>
	</div>
</template>

<style scoped>
.process-state-icon {
	flex: none;
	width: 14px;
	height: 14px;
	color: var(--faint);
}
.process-state-icon.active {
	color: var(--accent);
}
.process-meta {
	min-width: 0;
	max-width: min(56vw, 620px);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>
