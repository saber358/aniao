<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { UIcon } from "../ui.ts";
import MarkdownBlock from "./MarkdownBlock.vue";

const durations = new Map<string, number>();
const props = defineProps<{ text: string; running?: boolean; durationMs?: number }>();
const expanded = ref(false);
const elapsedSeconds = ref(0);
let startedAt: number | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const durationMs = computed(() => {
	if (props.running) return elapsedSeconds.value * 1000;
	return props.durationMs ?? durations.get(props.text) ?? 0;
});
const preview = computed(() => {
	const latest = props.text.replace(/\s+/g, " ").trim();
	if (!latest) return "";
	return latest.length > 96 ? `…${latest.slice(-96)}` : latest;
});
const label = computed(() => {
	if (props.running) return "思考";
	return durationMs.value > 0 ? `思考 · 持续了 ${formatDuration(durationMs.value)}` : "思考";
});

watch(
	() => props.running,
	(running) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (!running) {
			if (startedAt !== null) durations.set(props.text, Date.now() - startedAt);
			startedAt = null;
			return;
		}
		startedAt = Date.now();
		timer = setInterval(() => {
			if (startedAt !== null) {
				elapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000);
				durations.set(props.text, Date.now() - startedAt);
			}
		}, 1000);
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	if (timer) clearInterval(timer);
	if (startedAt !== null) durations.set(props.text, Date.now() - startedAt);
});

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} 秒`;
	return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
</script>

<template>
	<div class="thinking-block">
		<button type="button" class="thinking-trigger" :aria-expanded="expanded" @click="expanded = !expanded">
			<UIcon name="i-lucide-brain" class="thinking-icon" aria-hidden="true" />
			<span class="thinking-label">{{ label }}</span>
			<span v-if="running && preview" class="thinking-live">{{ preview }}</span>
			<UIcon name="i-lucide-chevron-right" class="thinking-chevron" :class="{ open: expanded }" aria-hidden="true" />
		</button>
		<div v-if="expanded" class="thinking-body">
			<MarkdownBlock :text="text" />
		</div>
	</div>
</template>

<style scoped>
.thinking-block {
	display: grid;
	gap: 6px;
}
.thinking-trigger {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	padding: 2px 0;
	border: 0;
	background: transparent;
	color: var(--faint);
	cursor: pointer;
	font: inherit;
	font-size: 13px;
	line-height: 1.5;
	text-align: left;
}
.thinking-trigger:hover {
	color: var(--muted);
}
.thinking-icon,
.thinking-chevron {
	width: 14px;
	height: 14px;
	flex: none;
}
.thinking-chevron {
	transition:
		opacity 0.15s ease,
		transform 0.15s ease;
	opacity: 0;
}
.thinking-trigger:hover .thinking-chevron,
.thinking-trigger:focus-visible .thinking-chevron {
	opacity: 1;
}
.thinking-chevron.open {
	transform: rotate(90deg);
}
.thinking-label {
	flex: none;
}
.thinking-live {
	overflow: hidden;
	min-width: 0;
	color: var(--faint);
	text-overflow: ellipsis;
	white-space: nowrap;
	animation: thinking-pulse 1.4s ease-in-out infinite;
}
.thinking-body {
	max-height: 220px;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 4px 6px 6px 20px;
	border-left: 1px solid var(--line-soft);
	color: var(--faint);
	font-size: 12px;
	overflow-wrap: anywhere;
	word-break: break-word;
}
.thinking-body :deep(.markdown-body) {
	max-width: 100%;
	color: var(--faint);
	overflow-wrap: anywhere;
	word-break: break-word;
}
.thinking-body :deep(pre),
.thinking-body :deep(code) {
	max-width: 100%;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	word-break: break-word;
}
.thinking-body :deep(.comark-content) {
	min-width: 0;
	max-width: 100%;
}
@keyframes thinking-pulse {
	0%,
	100% {
		opacity: 0.55;
	}
	50% {
		opacity: 1;
	}
}
</style>
