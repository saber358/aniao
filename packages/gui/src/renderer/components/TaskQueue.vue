<script setup lang="ts">
import { computed } from "vue";
import { queueTexts } from "../../domain/queue-view.ts";
import type { QueueState } from "../../shared/queue.ts";
import { UButton } from "../ui.ts";

/*
 * ========================================================================
 * 步骤1：展示 SDK 队列与待核对输入
 * ========================================================================
 * 数据源：会话投影；组件不调度消息、不维护第二份队列。
 * 操作：
 *   1) 区分引导、后续任务和中断恢复记录
 *   2) 只有任务收束后才提供整体恢复与清空
 */
const props = defineProps<{ queue: QueueState; disabled: boolean; idle: boolean; busy: boolean }>();
const emit = defineEmits<{ restore: []; clear: [] }>();
const count = computed(() => queueTexts(props.queue).length);
const groups = computed(() => [
	{ label: "待核对的引导", texts: props.queue.recovery.steering },
	{ label: "待核对的任务", texts: props.queue.recovery.followUp },
	{ label: "引导当前任务", texts: props.queue.steering },
	{ label: "后续任务", texts: props.queue.followUp },
]);
</script>

<template>
	<section v-if="count || queue.error" class="task-queue" aria-label="待处理消息">
		<div class="queue-heading">
			<span>待处理 {{ count }}</span>
			<div v-if="idle && count" class="queue-actions">
				<UButton
					color="neutral"
					variant="ghost"
					size="xs"
					:disabled="disabled || busy"
					:loading="busy"
					@click="emit('restore')"
					>恢复到输入</UButton
				>
				<UButton color="neutral" variant="ghost" size="xs" :disabled="disabled || busy" @click="emit('clear')"
					>清空队列</UButton
				>
			</div>
		</div>
		<p v-if="queue.recovery.steering.length || queue.recovery.followUp.length" class="queue-note">
			上次中断的输入可能已被处理。核对聊天记录后，可恢复到输入再发送。
		</p>
		<p v-if="queue.error" class="workspace-error" role="alert">{{ queue.error }}</p>
		<div class="queue-items">
			<template v-for="group in groups" :key="group.label">
				<div v-for="(item, index) in group.texts" :key="`${group.label}-${index}`" class="queue-item">
					<span class="queue-kind">{{ group.label }}</span>
					<p>{{ item.text }}</p>
					<span v-if="item.imageIds?.length" class="muted">图片 {{ item.imageIds.length }} 张</span>
				</div>
			</template>
		</div>
	</section>
</template>
