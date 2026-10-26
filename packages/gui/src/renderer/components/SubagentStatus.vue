<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { countSubagents, isSubagentActive, type SubagentNode, type SubagentSnapshot } from "../../shared/subagents.ts";
import { UIcon } from "../ui.ts";

const props = defineProps<{ snapshot: SubagentSnapshot }>();
const emit = defineEmits<{ open: [runId: string, childId?: string] }>();

interface Row {
	id: string;
	runId: string;
	childId: string;
	agent: string;
	label: string;
	state: SubagentNode["state"];
	active: boolean;
	activity?: SubagentNode["activity"];
	startedAt?: number;
	updatedAt?: number;
}

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	timer = setInterval(() => {
		now.value = Date.now();
	}, 1000);
});
onBeforeUnmount(() => {
	if (timer) clearInterval(timer);
});

function taskLabel(node: SubagentNode): string {
	if (/^task-\d+$/u.test(node.label)) return "";
	return node.label || node.activity?.currentTool || "";
}

function toolAction(tool: string): string {
	const normalized = tool.toLocaleLowerCase();
	if (["bash", "powershell", "shell"].includes(normalized)) return "执行命令";
	if (normalized === "read") return "读取文件";
	if (["grep", "find", "search", "tool_search"].includes(normalized)) return "搜索内容";
	if (["edit", "write"].includes(normalized)) return "修改文件";
	if (normalized === "subagent") return "调度子智能体";
	return `调用 ${tool}`;
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stepText(row: Row): string {
	const toolCount = row.activity?.toolCount;
	const turns = row.activity?.turnCount;
	if (!row.active) {
		const result = row.state === "failed" || row.state === "rejected" ? "执行失败" : "已完成";
		return [result, toolCount ? `${toolCount} 个工具` : ""].filter(Boolean).join(" · ");
	}
	const action = row.activity?.currentTool ? toolAction(row.activity.currentTool) : "正在思考";
	const since = row.activity?.currentToolStartedAt ?? row.updatedAt ?? row.startedAt;
	const parts = [action, since ? formatElapsed(now.value - since) : ""];
	if (turns) parts.push(`第 ${turns} 轮`);
	if (toolCount) parts.push(`${toolCount} 个工具`);
	return parts.filter(Boolean).join(" · ");
}

const rows = computed<Row[]>(() => {
	const result: Row[] = [];
	for (const run of props.snapshot.runs) {
		const children = run.children?.length ? run.children : [run];
		children.forEach((child, index) => {
			const baseAgent = child.agent || run.agent || run.label || "子智能体";
			result.push({
				id: `${run.id}:${child.id}`,
				runId: run.id,
				childId: child.id,
				agent: run.children && run.children.length > 1 ? `${baseAgent} #${index + 1}` : baseAgent,
				label: taskLabel(child),
				state: child.state,
				active: isSubagentActive(child),
				activity: child.activity,
				startedAt: child.startedAt,
				updatedAt: child.updatedAt,
			});
		});
	}
	return result.slice(0, 8);
});
const counts = computed(() => countSubagents(props.snapshot));
const active = computed(() => counts.value.active > 0);
</script>

<template>
	<section v-if="rows.length" class="subagent-status" aria-label="子智能体状态">
		<div v-for="row in rows" :key="row.id" class="subagent-item">
			<button
				type="button"
				class="subagent-row"
				:class="{ done: !row.active }"
				@click="emit('open', row.runId, row.childId)"
			>
				<UIcon name="i-lucide-bot" class="subagent-icon" aria-hidden="true" />
				<span class="subagent-prefix">子智能体</span>
				<strong class="subagent-agent">{{ row.agent }}</strong>
				<template v-if="row.label">
					<span class="subagent-separator">·</span>
					<span class="subagent-label">{{ row.label }}</span>
				</template>
				<UIcon
					v-if="!row.active"
					:name="row.state === 'failed' || row.state === 'rejected' ? 'i-lucide-circle-alert' : 'i-lucide-check'"
					class="subagent-end-icon"
					aria-hidden="true"
				/>
				<span class="subagent-live" :class="{ done: !row.active }">
					<UIcon v-if="row.active" name="i-lucide-loader-circle" class="subagent-step-spin" aria-hidden="true" />
					{{ stepText(row) }}
				</span>
			</button>
		</div>
		<div v-if="active" class="subagent-waiting">
			<UIcon name="i-lucide-loader-circle" class="spin" aria-hidden="true" />
			<span>等待子智能体完成</span>
		</div>
	</section>
</template>

<style scoped>
.subagent-status {
	display: grid;
	gap: 8px;
	padding: 4px 2px 6px;
	color: var(--muted);
	font-size: 12px;
}
.subagent-item {
	display: grid;
	gap: 2px;
	min-width: 0;
}
.subagent-row {
	display: flex;
	align-items: center;
	gap: 5px;
	width: 100%;
	min-width: 0;
	min-height: 22px;
	padding: 0;
	border: 0;
	background: transparent;
	color: inherit;
	cursor: pointer;
	font: inherit;
	text-align: left;
}
.subagent-row:hover {
	color: var(--ink);
}
.subagent-row.done {
	opacity: 0.65;
}
.subagent-live {
	display: flex;
	align-items: center;
	flex: none;
	gap: 4px;
	max-width: 46%;
	margin-left: auto;
	overflow: hidden;
	color: var(--faint);
	font-size: 10px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.subagent-live.done {
	opacity: 0.6;
}
.subagent-step-spin {
	flex: none;
	animation: subagent-spin 1s linear infinite;
}
.subagent-icon {
	flex: none;
	color: var(--faint);
	font-size: 14px;
}
.subagent-prefix {
	flex: none;
	color: var(--faint);
}
.subagent-agent {
	flex: none;
	color: var(--accent);
	font-weight: 550;
}
.subagent-separator {
	flex: none;
	color: var(--faint);
}
.subagent-label {
	overflow: hidden;
	min-width: 0;
	flex: 1;
	color: var(--muted);
	text-overflow: ellipsis;
	white-space: nowrap;
}
.subagent-end-icon {
	flex: none;
	color: var(--faint);
	font-size: 12px;
}
.subagent-waiting {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 3px 0 2px 2px;
	color: var(--faint);
	font-size: 11px;
}
.spin {
	animation: subagent-spin 1s linear infinite;
}
@keyframes subagent-spin {
	to {
		transform: rotate(360deg);
	}
}
</style>
