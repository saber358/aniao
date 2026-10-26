<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { PlanState } from "../../shared/plan.ts";
import { UButton, UIcon } from "../ui.ts";

const props = defineProps<{ plan: PlanState; disabled: boolean }>();
const emit = defineEmits<{ approve: [text: string]; edit: [text: string]; reject: []; dismiss: []; abort: [] }>();
const text = ref(props.plan.text);
const awaiting = computed(() => props.plan.phase === "awaiting" || props.plan.phase === "interrupted");
const canApprove = computed(() => awaiting.value && text.value.trim().length > 0 && !props.disabled);

watch(
	() => props.plan.text,
	(value) => {
		if (value !== text.value) text.value = value;
	},
);
</script>

<template>
	<section class="plan-card" :class="plan.phase" aria-label="计划">
		<header class="plan-card-head">
			<div>
				<UIcon
					:name="plan.phase === 'drafting' ? 'i-lucide-loader-circle' : 'i-lucide-file-text'"
					:class="{ spin: plan.phase === 'drafting' }"
					aria-hidden="true"
				/>
				<strong>{{
					plan.phase === "drafting"
						? "正在生成计划"
						: plan.phase === "interrupted"
							? "计划已中断，待核对"
							: plan.phase === "awaiting"
								? "待确认计划"
								: plan.phase === "executing"
									? "正在执行计划"
									: "计划已结束"
				}}</strong>
			</div>
			<span v-if="plan.phase === 'awaiting'" class="plan-note">只读工具 · 确认后才修改</span>
			<UButton
				v-if="plan.phase === 'completed'"
				color="neutral"
				variant="ghost"
				size="xs"
				aria-label="关闭计划"
				@click="emit('dismiss')"
				>关闭</UButton
			>
		</header>

		<p v-if="plan.phase === 'drafting'" class="plan-hint">正在分析代码并整理步骤，不会修改工作区。</p>
		<p v-if="plan.phase === 'executing'" class="plan-hint">计划已经确认，正在使用完整工具执行。</p>
		<p v-if="plan.phase === 'completed'" class="plan-hint">本轮计划执行已收束，可关闭此提示。</p>
		<p v-if="plan.reason" class="plan-hint" role="alert">{{ plan.reason }}</p>

		<textarea
			v-if="awaiting"
			v-model="text"
			class="plan-text"
			rows="6"
			maxlength="200000"
			aria-label="待确认计划"
		></textarea>
		<pre v-else-if="plan.text" class="plan-text preview">{{ plan.text }}</pre>

		<footer v-if="awaiting" class="plan-actions">
			<UButton
				color="neutral"
				variant="outline"
				size="sm"
				:disabled="disabled || text === plan.text"
				@click="emit('edit', text)"
				>保存修改</UButton
			>
			<UButton color="neutral" size="sm" :disabled="!canApprove" @click="emit('approve', text.trim())"
				>批准并执行</UButton
			>
			<UButton color="neutral" variant="ghost" size="sm" :disabled="disabled" @click="emit('reject')">拒绝</UButton>
			<span>修改后可保存；批准后开始执行。</span>
		</footer>
		<footer v-else-if="plan.phase === 'drafting' || plan.phase === 'executing'" class="plan-actions">
			<UButton color="neutral" variant="ghost" size="sm" :disabled="disabled" @click="emit('abort')">停止</UButton>
		</footer>
	</section>
</template>

<style scoped>
.plan-card {
	display: grid;
	gap: 8px;
	margin-bottom: 8px;
	padding: 10px 12px;
	border: 1px solid var(--line);
	border-radius: 12px;
	background: var(--surface-raised);
}
.plan-card.awaiting {
	border-color: color-mix(in srgb, var(--accent) 34%, var(--line));
}
.plan-card-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	color: var(--ink);
	font-size: 11px;
}
.plan-card-head > div {
	display: flex;
	align-items: center;
	gap: 7px;
}
.plan-card-head svg {
	color: var(--accent);
	font-size: 14px;
}
.plan-card-head strong {
	font-weight: 550;
}
.plan-note {
	margin-left: auto;
	color: var(--faint);
	font-size: 9px;
}
.plan-hint {
	margin: 0;
	color: var(--faint);
	font-size: 10px;
	line-height: 1.5;
}
.plan-text {
	width: 100%;
	margin: 0;
	padding: 8px 9px;
	border: 1px solid var(--line-soft);
	border-radius: 8px;
	background: var(--surface);
	color: var(--ink);
	font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
	font-size: 11px;
	line-height: 1.55;
	resize: vertical;
}
.plan-text.preview {
	max-height: 160px;
	overflow: auto;
	white-space: pre-wrap;
}
.plan-actions {
	display: flex;
	align-items: center;
	gap: 4px;
	flex-wrap: wrap;
}
.plan-actions span {
	margin-left: auto;
	color: var(--faint);
	font-size: 9px;
}
.spin {
	animation: plan-spin 900ms linear infinite;
}
@keyframes plan-spin {
	to {
		transform: rotate(360deg);
	}
}
@media (prefers-reduced-motion: reduce) {
	.spin {
		animation: none;
	}
}
</style>
