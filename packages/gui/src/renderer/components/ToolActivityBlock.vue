<script setup lang="ts">
import { computed } from "vue";
import type { ToolActivity } from "../../shared/protocol.ts";
import { UChatTool } from "../ui.ts";

const props = defineProps<{ tool: ToolActivity }>();
const labels = { running: "运行中", failed: "失败", interrupted: "未完成", succeeded: "完成" } as const;
const icons: Record<string, string> = {
	bash: "i-lucide-terminal",
	powershell: "i-lucide-terminal",
	read: "i-lucide-file-text",
	write: "i-lucide-file-plus-2",
	edit: "i-lucide-pencil",
	apply_patch: "i-lucide-pencil",
	grep: "i-lucide-search",
	glob: "i-lucide-search",
	find: "i-lucide-search",
	ls: "i-lucide-search",
	skill: "i-lucide-sparkles",
	todo: "i-lucide-square",
	web: "i-lucide-globe",
};
const names: Record<string, string> = {
	bash: "终端",
	powershell: "终端",
	read: "查阅",
	write: "写入",
	edit: "编辑",
	apply_patch: "编辑",
	grep: "搜索",
	glob: "搜索",
	find: "搜索",
	ls: "搜索",
	skill: "技能",
	todo: "待办",
	web: "浏览",
};
const icon = computed(() => icons[props.tool.name] ?? "i-lucide-wrench");
const label = computed(() => names[props.tool.name] ?? props.tool.name);
const detail = computed(() => {
	const input = parseInput(props.tool.input);
	if (!input) return props.tool.name;
	if (props.tool.name === "bash" || props.tool.name === "powershell") return stringValue(input.command);
	if (["read", "write", "edit", "apply_patch"].includes(props.tool.name))
		return stringValue(input.path) ?? stringValue(input.file_path) ?? stringValue(input.file) ?? props.tool.name;
	if (["grep", "glob", "find", "ls"].includes(props.tool.name))
		return stringValue(input.pattern) ?? stringValue(input.query) ?? stringValue(input.path) ?? props.tool.name;
	if (props.tool.name === "skill") return stringValue(input.name) ?? stringValue(input.skill) ?? props.tool.name;
	if (props.tool.name === "todo") return stringValue(input.text) ?? stringValue(input.content) ?? props.tool.name;
	return stringValue(input.query) ?? stringValue(input.prompt) ?? props.tool.name;
});
const suffix = computed(() =>
	props.tool.state === "succeeded" ? `· ${detail.value}` : `· ${detail.value} · ${labels[props.tool.state]}`,
);

function parseInput(input: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(input);
		if (typeof value !== "object" || value === null) return undefined;
		return value as Record<string, unknown>;
	} catch {
		return undefined;
	}
}
function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
</script>

<template>
	<div class="tool-activities" aria-label="工具活动">
		<UChatTool
			:text="label"
			:suffix="suffix"
			:loading="tool.state === 'running'"
			:icon="icon"
			chevron-icon="i-lucide-chevron-right"
			unmount-on-hide
		>
			<pre class="tool-input">{{ tool.input }}</pre>
			<p v-if="tool.truncated" class="muted">仅展示最后 256 KiB，完整结果保存在 Pi 会话中。</p>
			<pre class="tool-output">{{
				tool.output ||
				(tool.state === "interrupted"
					? "没有已保存的工具结果"
					: tool.state === "running"
						? "等待输出…"
						: "无文本输出")
			}}</pre>
		</UChatTool>
	</div>
</template>

<style scoped>
.tool-activities :deep([data-slot="trigger"]) {
	width: 100%;
	max-width: 100%;
	min-width: 0;
	text-align: left;
}
.tool-activities :deep([data-slot="label"]) {
	display: flex;
	align-items: center;
	gap: 0;
	min-width: 0;
	max-width: 100%;
}
.tool-activities :deep([data-slot="suffix"]) {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.tool-activities :deep([data-slot="trailingIcon"]) {
	opacity: 0;
	transition:
		opacity 0.15s ease,
		transform 0.15s ease;
}
.tool-activities :deep([data-slot="trigger"]:hover [data-slot="trailingIcon"]),
.tool-activities :deep([data-slot="trigger"]:focus-visible [data-slot="trailingIcon"]) {
	opacity: 1;
}
.tool-activities :deep([data-slot="root"][data-state="open"] [data-slot="trailingIcon"]) {
	transform: rotate(90deg);
}
</style>
