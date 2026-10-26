<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { TurnHeaderData } from "../adapters/chat-view.ts";
import { UIcon } from "../ui.ts";

const props = defineProps<{ data: TurnHeaderData; expanded: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const elapsedSeconds = ref(0);
let startedAt: number | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const label = computed(() => {
	if (props.data.running) return `工作中 ${formatDuration(elapsedSeconds.value * 1000)}`;
	return props.data.durationMs ? `已工作 ${formatDuration(props.data.durationMs)}` : "已工作";
});

watch(
	() => props.data.running,
	(running) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (!running) {
			startedAt = null;
			elapsedSeconds.value = 0;
			return;
		}
		startedAt = Date.now();
		timer = setInterval(() => {
			if (startedAt !== null) elapsedSeconds.value = Math.floor((Date.now() - startedAt) / 1000);
		}, 1000);
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	if (timer) clearInterval(timer);
});

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} 秒`;
	return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
</script>

<template>
	<button type="button" class="turn-header" :aria-expanded="expanded" @click="!data.running && emit('toggle')">
		<span>{{ label }}</span>
		<UIcon
			v-if="!data.running"
			name="i-lucide-chevron-right"
			class="turn-header-chevron"
			:class="{ open: expanded }"
			aria-hidden="true"
		/>
	</button>
</template>

<style scoped>
.turn-header {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	padding: 2px 0 10px;
	border: 0;
	border-bottom: 1px solid var(--line-soft);
	background: transparent;
	color: var(--muted);
	cursor: pointer;
	font: inherit;
	font-size: 13px;
	text-align: left;
}
.turn-header:hover {
	color: var(--ink);
}
.turn-header-chevron {
	width: 14px;
	height: 14px;
	flex: none;
	color: var(--faint);
	opacity: 0;
	transition:
		opacity 0.15s ease,
		transform 0.15s ease;
}
.turn-header:hover .turn-header-chevron,
.turn-header:focus-visible .turn-header-chevron {
	opacity: 1;
}
.turn-header-chevron.open {
	transform: rotate(90deg);
}
</style>
