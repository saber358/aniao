<script setup lang="ts">
import { computed } from "vue";
import type { ContextUsage } from "../../shared/protocol.ts";

const props = defineProps<{ usage?: ContextUsage }>();
const radius = 6.3;
const circumference = 2 * Math.PI * radius;
const percent = computed(() => Math.min(100, Math.max(0, props.usage?.percent ?? 0)));
const dashOffset = computed(() => circumference * (1 - percent.value / 100));
const color = computed(() => {
	if (!props.usage || props.usage.percent === null) return "var(--line)";
	if (percent.value >= 90) return "#d14343";
	if (percent.value >= 75) return "#d97706";
	return "var(--accent)";
});
const label = computed(() => {
	const usage = props.usage;
	if (!usage) return "上下文用量未知";
	const current = usage.tokens === null ? "未知" : usage.tokens.toLocaleString();
	const total = usage.contextWindow.toLocaleString();
	const value = usage.percent === null ? "未知" : `${Math.round(usage.percent)}%`;
	return `上下文 ${current} / ${total} tokens（${value}）`;
});
</script>

<template>
	<div class="context-usage-ring" role="img" :aria-label="label" :title="label">
		<svg viewBox="0 0 20 20" aria-hidden="true">
			<circle class="context-ring-track" cx="10" cy="10" :r="radius" />
			<circle
				class="context-ring-value"
				cx="10"
				cy="10"
				:r="radius"
				:stroke="color"
				:stroke-dasharray="circumference"
				:stroke-dashoffset="dashOffset"
			/>
		</svg>
	</div>
</template>

<style scoped>
.context-usage-ring {
	position: relative;
	top: 1px;
	display: grid;
	place-items: center;
	align-self: center;
	width: 16px;
	height: 16px;
	flex: none;
	line-height: 0;
}
.context-usage-ring svg {
	width: 16px;
	height: 16px;
	overflow: visible;
	transform: rotate(-90deg);
}
.context-ring-track,
.context-ring-value {
	fill: none;
	stroke-width: 3.2;
}
.context-ring-track {
	stroke: var(--line);
}
.context-ring-value {
	stroke-linecap: round;
	transition: stroke-dashoffset 0.2s ease;
}
</style>
