<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { QueueState } from "../../shared/queue.ts";
import { createLogger } from "../../shared/logger.ts";
import { UIcon } from "../ui.ts";

/*
 * ========================================================================
 * 步骤1：队列直接附着在输入框上方
 * ========================================================================
 * 数据源：会话投影；组件不维护第二份队列。
 * 操作：
 *   1) 每条后续消息可直接编辑、引导或删除
 *   2) 不显示队列标题、数量或折叠栏
 */
const props = defineProps<{
	queue: QueueState;
	idle: boolean;
	busy: boolean;
	submitAction: (action: "steer" | "remove" | "edit", itemId: string, text?: string) => Promise<boolean>;
}>();
const emit = defineEmits<{ restore: []; clear: [] }>();
const logger = createLogger("task-queue");
const editingId = ref<string | null>(null);
const editingText = ref("");
const editInput = ref<HTMLInputElement | null>(null);

interface QueueRow {
	key: string;
	text: string;
	imageCount: number;
	recovery: boolean;
	itemId?: string;
	steering?: boolean;
}

const rows = computed<QueueRow[]>(() => [
	...props.queue.recovery.steering.map((item, index) => ({
		key: `recovery-steer-${index}`,
		text: item.text,
		imageCount: item.imageIds?.length ?? 0,
		recovery: true,
	})),
	...props.queue.recovery.followUp.map((item, index) => ({
		key: `recovery-follow-${index}`,
		text: item.text,
		imageCount: item.imageIds?.length ?? 0,
		recovery: true,
	})),
	...props.queue.steering.map((item, index) => ({
		key: item.id ?? `steer-${index}`,
		text: item.text,
		imageCount: item.imageIds?.length ?? 0,
		recovery: false,
		steering: true,
	})),
	...props.queue.followUp.map((item, index) => ({
		key: item.id ?? `follow-${index}`,
		text: item.text,
		imageCount: item.imageIds?.length ?? 0,
		recovery: false,
		itemId: item.id,
	})),
]);
const count = computed(() => rows.value.length);
const hasRecovery = computed(() => rows.value.some((row) => row.recovery));

function startEdit(itemId: string, text: string): void {
	logger.info("开始编辑排队消息");
	// 1.1 编辑器独立保留身份和正文，不跟随队首消费后变化的数组位置。
	editingId.value = itemId;
	editingText.value = text;
	void nextTick(() => editInput.value?.focus());
	logger.info("排队消息编辑已打开");
}

function setEditInput(element: unknown): void {
	editInput.value = element instanceof HTMLInputElement ? element : null;
}

function cancelEdit(): void {
	editingId.value = null;
	editingText.value = "";
}

async function saveEdit(): Promise<void> {
	const text = editingText.value.trim();
	const itemId = editingId.value;
	if (!text || !itemId || props.busy || props.idle) return;
	logger.info("开始保存排队消息编辑");
	try {
		// 1.2 拒绝旧目标或存储失败时，用户编辑文本仍留在输入框中。
		if (await props.submitAction("edit", itemId, text)) cancelEdit();
	} finally {
		logger.info("排队消息编辑保存结束");
	}
}
</script>

<template>
	<section v-if="count || queue.error || editingId" class="queue-dock" aria-label="待处理消息">
		<div v-if="idle && count" class="queue-recovery-actions">
			<button type="button" :disabled="busy" @click="emit('restore')">恢复到输入</button>
			<button type="button" :disabled="busy" @click="emit('clear')">清空队列</button>
		</div>
		<div v-if="editingId" class="queue-edit-bar">
			<input
				:ref="setEditInput"
				v-model="editingText"
				class="queue-edit-input"
				maxlength="1000000"
				aria-label="编辑排队消息"
				:disabled="busy"
				@keydown.enter.stop.prevent="saveEdit"
				@keydown.esc.stop.prevent="cancelEdit"
			/>
			<button
				type="button"
				class="queue-row-action"
				aria-label="保存排队消息"
				:disabled="busy || idle || !editingText.trim()"
				@click="saveEdit"
			>
				<UIcon name="i-lucide-check" aria-hidden="true" />
			</button>
			<button type="button" class="queue-row-action" aria-label="取消编辑" :disabled="busy" @click="cancelEdit">
				<UIcon name="i-lucide-x" aria-hidden="true" />
			</button>
		</div>
		<div v-if="count" class="queue-panel">
			<ul class="queue-list">
				<li v-for="row in rows" :key="row.key" class="queue-row" :class="{ recovery: row.recovery }">
					<UIcon name="i-lucide-list-checks" class="queue-row-icon" aria-hidden="true" />
					<span class="queue-preview">{{ row.text }}</span>
					<span v-if="row.imageCount" class="queue-image-count">图片 {{ row.imageCount }}</span>
					<span v-if="row.recovery" class="queue-row-kind">待核对</span>
					<span v-else-if="row.steering" class="queue-row-kind">引导</span>
					<span v-else-if="row.itemId" class="queue-row-actions">
						<button
							type="button"
							class="queue-row-action"
							:disabled="busy || idle"
							title="编辑排队消息"
							aria-label="编辑排队消息"
							@click.stop="startEdit(row.itemId, row.text)"
						>
							<UIcon name="i-lucide-pencil" aria-hidden="true" />
						</button>
						<button
							type="button"
							class="queue-row-action"
							:disabled="busy || idle"
							title="引导这条排队消息"
							aria-label="引导这条排队消息"
							@click.stop="submitAction('steer', row.itemId)"
						>
							<UIcon name="i-lucide-send" aria-hidden="true" />
						</button>
						<button
							type="button"
							class="queue-row-action"
							:disabled="busy || idle"
							title="删除这条排队消息"
							aria-label="删除这条排队消息"
							@click.stop="submitAction('remove', row.itemId)"
						>
							<UIcon name="i-lucide-trash-2" aria-hidden="true" />
						</button>
					</span>
				</li>
			</ul>
		</div>
		<p v-if="hasRecovery" class="queue-note">上次中断的输入可能已被处理。核对聊天记录后再发送。</p>
		<p v-if="queue.error" class="workspace-error" role="alert">{{ queue.error }}</p>
	</section>
</template>

<style scoped>
.queue-edit-bar,
.queue-recovery-actions {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 10px;
	background: var(--composer);
}
.queue-recovery-actions button {
	border: 0;
	background: transparent;
	color: var(--muted);
	font-size: 11px;
	cursor: pointer;
}
.queue-recovery-actions button:disabled {
	opacity: 0.4;
	cursor: default;
}
.queue-dock {
	position: relative;
	z-index: 2;
	margin: 0 8px -7px;
	padding: 0 7px;
}
.queue-panel {
	overflow: hidden;
	border: 1px solid var(--line);
	border-bottom: 0;
	border-radius: 13px 13px 0 0;
	background: color-mix(in srgb, var(--composer) 94%, var(--sidebar));
	box-shadow: 0 -4px 16px rgb(0 0 0 / 2%);
}
.queue-list {
	max-height: 180px;
	margin: 0;
	padding: 0;
	overflow-y: auto;
	list-style: none;
}
.queue-row {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 34px;
	padding: 4px 10px 4px 12px;
	border-top: 1px solid var(--line-soft);
}
.queue-row:first-child {
	border-top: 0;
}
.queue-row-icon {
	flex: none;
	color: var(--faint);
	font-size: 13px;
}
.queue-preview {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	color: var(--muted);
	font-size: 12px;
	line-height: 1.5;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.queue-edit-input {
	flex: 1;
	min-width: 0;
	height: 25px;
	padding: 0 7px;
	border: 1px solid var(--line);
	border-radius: 5px;
	background: var(--surface);
	color: var(--ink);
	font: inherit;
	font-size: 12px;
	outline: none;
}
.queue-edit-input:focus {
	border-color: var(--accent);
}
.queue-row.recovery .queue-preview {
	color: var(--faint);
}
.queue-image-count,
.queue-row-kind {
	flex: none;
	padding: 1px 5px;
	border-radius: 4px;
	background: var(--active);
	color: var(--faint);
	font-size: 9px;
	white-space: nowrap;
}
.queue-row-kind {
	color: var(--muted);
}
.queue-row-actions {
	display: flex;
	align-items: center;
	gap: 1px;
	flex: none;
}
.queue-row-action {
	display: grid;
	width: 24px;
	height: 24px;
	place-items: center;
	border: 0;
	border-radius: 5px;
	background: transparent;
	color: var(--faint);
	cursor: pointer;
	font-size: 12px;
}
.queue-row-action:hover:not(:disabled) {
	background: var(--active);
	color: var(--ink);
}
.queue-row-action:disabled {
	cursor: default;
	opacity: 0.35;
}
.queue-note {
	margin: 5px 4px 0;
	color: var(--faint);
	font-size: 10px;
	line-height: 1.55;
}
.queue-dock .workspace-error {
	margin: 5px 4px 0;
}
</style>
