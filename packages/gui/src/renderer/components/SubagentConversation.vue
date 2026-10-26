<script setup lang="ts">
import { computed, ref } from "vue";
import { parseSubagentTranscript } from "../../shared/subagent-transcript.ts";
import { toChatView } from "../adapters/chat-view.ts";
import { UChatMessages } from "../ui.ts";
import MarkdownBlock from "./MarkdownBlock.vue";
import ThinkingBlock from "./ThinkingBlock.vue";
import ToolActivityBlock from "./ToolActivityBlock.vue";
import TurnHeader from "./TurnHeader.vue";

const props = defineProps<{ transcript: string; running?: boolean }>();
const expandedTurns = ref(new Set<string>());
const parsed = computed(() => parseSubagentTranscript(props.transcript));
const messages = computed(() =>
	toChatView(parsed.value.messages.slice(-300), parsed.value.tools.slice(-500), {
		running: props.running === true,
		collapseTurns: true,
	}),
);
const visibleMessages = computed(() =>
	messages.value.filter(
		(message) => !message.metadata?.turnProcess || expandedTurns.value.has(message.metadata.turnId ?? ""),
	),
);

function toggleTurn(turnId: string): void {
	const next = new Set(expandedTurns.value);
	if (next.has(turnId)) next.delete(turnId);
	else next.add(turnId);
	expandedTurns.value = next;
}
</script>

<template>
	<div class="conversation-scroll subagent-conversation" aria-label="子智能体对话记录">
		<UChatMessages
			v-if="visibleMessages.length"
			:messages="visibleMessages"
			:status="running ? 'streaming' : 'ready'"
			should-auto-scroll
			:user="{ side: 'right', variant: 'soft' }"
		>
			<template #content="{ message }">
				<template v-for="(part, index) in message.parts" :key="index">
					<TurnHeader
						v-if="part.type === 'data-turn'"
						:data="part.data"
						:expanded="expandedTurns.has(part.data.turnId)"
						@toggle="toggleTurn(part.data.turnId)"
					/>
					<ThinkingBlock v-else-if="part.type === 'reasoning'" :text="part.text" :running="false" />
					<p v-else-if="part.type === 'text' && message.role === 'user'" class="plain-message">
						{{ part.text }}
					</p>
					<MarkdownBlock v-else-if="part.type === 'text'" :text="part.text" />
					<ToolActivityBlock v-else-if="part.type === 'data-tool'" :tool="part.data" />
				</template>
			</template>
		</UChatMessages>
		<p v-else class="subagent-conversation-empty">该子智能体还没有可显示的消息记录。</p>
	</div>
</template>

<style scoped>
.subagent-conversation {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 24px 18px 20px;
}
.subagent-conversation [data-slot="content"] {
	font-size: 14px;
	line-height: 1.75;
}
.subagent-conversation-empty {
	margin: 0;
	color: var(--faint);
	font-size: 11px;
}
</style>
