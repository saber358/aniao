<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { SubagentNode, SubagentSnapshot } from "../../shared/subagents.ts";
import MarkdownBlock from "./MarkdownBlock.vue";
import SubagentConversation from "./SubagentConversation.vue";

const props = defineProps<{
	snapshot: SubagentSnapshot | null;
	runId: string;
	childId?: string;
}>();

function findNode(node: SubagentNode, id: string): SubagentNode | undefined {
	if (node.id === id) return node;
	for (const child of node.children ?? []) {
		const found = findNode(child, id);
		if (found) return found;
	}
	return undefined;
}

const run = computed(() => props.snapshot?.runs.find((item) => item.id === props.runId));
const node = computed(() => {
	if (!run.value) return undefined;
	return (props.childId ? findNode(run.value, props.childId) : undefined) ?? run.value;
});
const active = computed(() => node.value?.state === "queued" || node.value?.state === "running");

const output = ref<string | null>(null);
const transcript = ref<string | null>(null);
const loading = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
	loading.value = true;
	try {
		const [nextOutput, nextTranscript] = await Promise.all([
			window.piDesktop.readSubagentOutput(props.runId, props.childId),
			window.piDesktop.readSubagentTranscript(props.runId, props.childId),
		]);
		output.value = nextOutput;
		transcript.value = nextTranscript;
	} catch {
		output.value = null;
		transcript.value = null;
	} finally {
		loading.value = false;
	}
}

watch(
	() => [props.runId, props.childId, props.snapshot?.generatedAt, node.value?.state] as const,
	() => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		void load();
		if (active.value) timer = setInterval(() => void load(), 2500);
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	if (timer) clearInterval(timer);
});
</script>

<template>
	<div v-if="node" class="subagent-detail">
		<SubagentConversation v-if="transcript" :transcript="transcript" :running="active" />
		<div v-else-if="output" class="subagent-detail-output">
			<MarkdownBlock :text="output" />
		</div>
		<p v-else class="subagent-detail-empty">
			{{ loading ? "正在读取子智能体记录…" : "该子智能体还没有可显示的对话记录。" }}
		</p>
	</div>
	<p v-else class="subagent-detail-empty">子智能体状态已结束或不存在。</p>
</template>

<style scoped>
.subagent-detail {
	display: flex;
	flex: 1;
	min-height: 0;
	flex-direction: column;
	overflow: hidden;
}
.subagent-detail-output {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 24px 20px;
}
.subagent-detail-empty {
	margin: 0;
	padding: 24px 20px;
	color: var(--faint);
	font-size: 11px;
	line-height: 1.6;
}
</style>
