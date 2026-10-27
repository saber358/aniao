<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { isTaskRunning, type SessionSnapshot } from "../../shared/protocol.ts";
import type { SubagentSnapshot } from "../../shared/subagents.ts";
import { type ChatViewMessage, toChatView } from "../adapters/chat-view.ts";
import { UButton, UChatMessages, UIcon } from "../ui.ts";
import MarkdownBlock from "./MarkdownBlock.vue";
import ThinkingBlock from "./ThinkingBlock.vue";
import ToolActivityBlock from "./ToolActivityBlock.vue";
import CreatedFilesSummary from "./CreatedFilesSummary.vue";
import EditedFilesSummary from "./EditedFilesSummary.vue";
import TurnHeader from "./TurnHeader.vue";
import CopyButton from "./CopyButton.vue";
import ImageAttachment from "./ImageAttachment.vue";
import SubagentStatus from "./SubagentStatus.vue";
import ViewedImages from "./ViewedImages.vue";

const props = defineProps<{ snapshot: SessionSnapshot; disabled: boolean }>();
const emit = defineEmits<{
	fork: [entryId: string];
	"open-file": [path: string];
	"open-subagent": [runId: string, childId?: string];
}>();
const running = computed(() => isTaskRunning(props.snapshot.run.phase));
const root = ref<HTMLElement | null>(null);
const runStartedAt = ref<number | null>(null);
const lastDuration = ref<{ sessionId: string; ms: number } | undefined>(undefined);
const messages = computed(() =>
	toChatView(props.snapshot.messages, props.snapshot.tools, {
		running: running.value,
		lastDurationMs: lastDuration.value?.sessionId === props.snapshot.sessionId ? lastDuration.value.ms : undefined,
		cwd: props.snapshot.cwd,
		collapseTurns: true,
	}),
);
const expandedTurns = ref(new Set<string>());
const visibleMessages = computed(() =>
	messages.value.filter(
		(message) => !message.metadata?.turnProcess || expandedTurns.value.has(message.metadata.turnId ?? ""),
	),
);
const subagentAnchor = ref<string | null>(null);
const timelineMessages = computed<ChatViewMessage[]>(() => {
	const base = visibleMessages.value;
	const subagents = props.snapshot.extensions.subagents;
	if (!subagents) return base;
	const synthetic: ChatViewMessage = {
		id: `subagent-status-${props.snapshot.sessionId}`,
		role: "assistant",
		parts: [{ type: "data-subagent", data: subagents }],
		metadata: { copyText: "" },
	};
	const anchor = subagentAnchor.value;
	let index = base.length;
	if (anchor === "__start__") index = 0;
	else if (anchor) {
		const found = base.findIndex((message) => message.id === anchor);
		if (found >= 0) index = found + 1;
	}
	return [...base.slice(0, index), synthetic, ...base.slice(index)];
});
watch(
	() => props.snapshot.extensions.subagents,
	(subagents) => {
		if (!subagents) {
			subagentAnchor.value = null;
			return;
		}
		if (subagentAnchor.value === null) subagentAnchor.value = visibleMessages.value.at(-1)?.id ?? "__start__";
	},
	{ immediate: true },
);
watch(
	() => props.snapshot.sessionId,
	() => {
		subagentAnchor.value = null;
	},
);

function toggleTurn(turnId: string): void {
	const next = new Set(expandedTurns.value);
	if (next.has(turnId)) next.delete(turnId);
	else next.add(turnId);
	expandedTurns.value = next;
}

watch(
	running,
	(value, previous) => {
		if (value) {
			runStartedAt.value = Date.now();
			lastDuration.value = undefined;
			return;
		}
		if (previous === true && runStartedAt.value !== null) {
			lastDuration.value = { sessionId: props.snapshot.sessionId, ms: Date.now() - runStartedAt.value };
		}
		runStartedAt.value = null;
	},
	{ immediate: true },
);
watch(
	() => props.snapshot.queue.steering.length,
	async (value, previous) => {
		if (value <= previous) return;
		await nextTick();
		root.value?.scrollTo({ top: root.value.scrollHeight, behavior: "smooth" });
	},
);
watch(
	() => props.snapshot.sessionId,
	() => {
		lastDuration.value = undefined;
		runStartedAt.value = running.value ? Date.now() : null;
	},
);

/*
 * ========================================================================
 * 步骤1：展示消息与工具事实
 * ========================================================================
 * 数据源：会话 ViewModel，仅适配组件属性。
 * 操作：
 *   1) 用户消息保持纯文本，助手正文走受限 Markdown
 *   2) 工具按所属助手消息插入，累计输出不再拼接
 */
</script>

<template>
	<div ref="root" class="conversation-scroll" :class="{ running }" aria-label="对话记录">
		<UChatMessages
			:messages="timelineMessages"
			:status="running ? 'streaming' : 'ready'"
			should-auto-scroll
			:user="{ side: 'right', variant: 'soft' }"
		>
			<template #content="{ message }">
				<div v-if="message.metadata?.imageIds?.length" class="attachment-list" aria-label="消息图片附件">
					<ImageAttachment
						v-for="imageId in message.metadata.imageIds"
						:key="imageId"
						:input="{
							sessionId: snapshot.sessionId,
							generation: snapshot.generation,
							imageId,
							source: 'message',
						}"
					/>
				</div>
				<template v-for="(part, index) in message.parts" :key="index">
					<SubagentStatus
						v-if="part.type === 'data-subagent'"
						:snapshot="part.data"
						@open="(runId, childId) => emit('open-subagent', runId, childId)"
					/>
					<TurnHeader
						v-else-if="part.type === 'data-turn'"
						:data="part.data"
						:expanded="expandedTurns.has(part.data.turnId)"
						@toggle="toggleTurn(part.data.turnId)"
					/>
					<ThinkingBlock
						v-else-if="part.type === 'reasoning'"
						:text="part.text"
						:duration-ms="message.metadata?.thinkingDurations?.[part.text]"
						:running="running && message.id === messages.at(-1)?.id"
					/>
					<p
						v-else-if="part.type === 'text' && (message.role === 'user' || message.metadata?.textTruncated)"
						class="plain-message"
					>
						{{ part.text }}
					</p>
					<MarkdownBlock
						v-else-if="part.type === 'text'"
						:text="part.text"
						:streaming="message.metadata?.streaming === true"
					/>
					<ToolActivityBlock v-else-if="part.type === 'data-tool'" :tool="part.data" />
					<ViewedImages
						v-else-if="part.type === 'data-viewedImages'"
						:data="part.data"
						:session-id="snapshot.sessionId"
						:generation="snapshot.generation"
					/>
					<CreatedFilesSummary
						v-else-if="part.type === 'data-files'"
						:data="part.data"
						@open="emit('open-file', $event)"
					/>
					<EditedFilesSummary v-else-if="part.type === 'data-edits'" :data="part.data" />
					<p v-else-if="part.type === 'data-error'" role="alert" class="message-error">{{ part.data }}</p>
				</template>
				<p v-if="message.metadata?.textTruncated" class="muted" role="status">
					正文过长，仅展示部分内容，暂不可整段复制。
				</p>
			</template>
			<template #actions="{ message }">
				<CopyButton
					v-if="message.metadata?.copyText"
					:text="message.metadata.copyText"
					:label="message.role === 'user' ? '复制用户消息' : '复制助手消息'"
				/>
				<UButton
					v-if="message.role === 'user' && message.metadata?.forkEntryId"
					icon="i-lucide-git-branch"
					aria-label="从此消息分支"
					title="保留此前历史，把这条消息放入新会话草稿"
					color="neutral"
					variant="ghost"
					size="xs"
					:disabled="disabled || running"
					@click="emit('fork', message.metadata.forkEntryId)"
				/>
			</template>
		</UChatMessages>
		<div v-if="snapshot.queue.steering.length" class="pending-steering-list" aria-label="等待发送的引导">
			<div v-for="(item, index) in snapshot.queue.steering" :key="index" class="pending-steering">
				<p>{{ item.text }}</p>
				<span class="pending-steering-meta">
					<span v-if="item.imageIds?.length">图片 {{ item.imageIds.length }} 张</span>
					<UIcon name="i-lucide-clock" aria-hidden="true" />
					<span>引导</span>
				</span>
			</div>
		</div>
	</div>
</template>

<style scoped>
.pending-steering-list {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 8px;
	padding: 4px 0 14px;
}
.pending-steering {
	max-width: min(82%, 620px);
	padding: 9px 14px;
	border-radius: 12px;
	background: color-mix(in srgb, var(--ink) 4%, var(--surface));
	color: var(--ink);
}
.pending-steering p {
	margin: 0;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	font-size: 14px;
	line-height: 1.75;
}
.pending-steering-meta {
	display: flex;
	align-items: center;
	gap: 4px;
	margin-top: 4px;
	color: var(--faint);
	font-size: 10px;
}
.pending-steering-meta svg {
	width: 11px;
	height: 11px;
}
</style>
