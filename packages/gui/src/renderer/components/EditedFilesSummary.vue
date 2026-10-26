<script setup lang="ts">
import { computed, ref } from "vue";
import type { EditedFilesSummary } from "../adapters/chat-view.ts";
import { UIcon } from "../ui.ts";

const props = defineProps<{ data: EditedFilesSummary }>();
const expanded = ref(false);
const visibleFiles = computed(() => (expanded.value ? props.data.files : props.data.files.slice(0, 3)));
const single = computed(() => props.data.files.length === 1);
const title = computed(() =>
	single.value ? `已编辑 ${baseName(props.data.files[0]?.path ?? "")}` : `已编辑 ${props.data.files.length} 个文件`,
);

function baseName(path: string): string {
	return path.split("/").pop() || path;
}
</script>

<template>
	<article class="edited-files" aria-label="已编辑文件">
		<header class="edited-head">
			<span class="edited-icon" aria-hidden="true">
				<UIcon name="i-lucide-file-diff" />
			</span>
			<div class="edited-heading">
				<strong>{{ title }}</strong>
				<span v-if="!single" class="edited-subtitle">在侧边栏预览</span>
				<span v-else class="edited-stats">
					<span class="edited-add">+{{ data.additions }}</span>
					<span class="edited-del">-{{ data.deletions }}</span>
				</span>
			</div>
		</header>
		<div v-if="!single" class="edited-rows">
			<div v-for="file in visibleFiles" :key="file.path" class="edited-row">
				<span class="edited-path">{{ file.path }}</span>
				<span class="edited-stats">
					<span class="edited-add">+{{ file.additions }}</span>
					<span class="edited-del">-{{ file.deletions }}</span>
				</span>
			</div>
			<button
				v-if="data.files.length > 3"
				type="button"
				class="edited-expand"
				:aria-expanded="expanded"
				@click="expanded = !expanded"
			>
				<span>{{ expanded ? "收起" : `全部 ${data.files.length} 个文件` }}</span>
				<UIcon :name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" aria-hidden="true" />
			</button>
		</div>
	</article>
</template>

<style scoped>
.edited-files {
	overflow: hidden;
	margin-top: 8px;
	border: 1px solid var(--line-soft);
	border-radius: 12px;
	background: var(--surface-raised);
}
.edited-head {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 14px 16px;
}
.edited-icon {
	display: grid;
	place-items: center;
	width: 40px;
	height: 40px;
	flex: none;
	border-radius: 10px;
	background: color-mix(in srgb, var(--accent) 11%, var(--surface));
	color: var(--accent);
	font-size: 19px;
}
.edited-heading {
	display: grid;
	min-width: 0;
	gap: 4px;
}
.edited-heading strong {
	color: var(--ink);
	font-size: 13px;
	font-weight: 600;
}
.edited-subtitle {
	color: var(--faint);
	font-size: 10px;
}
.edited-stats {
	display: inline-flex;
	gap: 7px;
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 10px;
	font-weight: 500;
}
.edited-add {
	color: #16835b;
}
.edited-del {
	color: #d14343;
}
.edited-rows {
	border-top: 1px solid var(--line-soft);
}
.edited-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 18px;
	padding: 10px 16px;
	border-top: 1px solid var(--line-soft);
}
.edited-row:first-child {
	border-top: 0;
}
.edited-path {
	overflow: hidden;
	min-width: 0;
	color: var(--muted);
	font-size: 10px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.edited-expand {
	display: flex;
	align-items: center;
	gap: 5px;
	width: 100%;
	padding: 10px 16px;
	border: 0;
	border-top: 1px solid var(--line-soft);
	background: transparent;
	color: var(--muted);
	font: inherit;
	font-size: 10px;
	text-align: left;
	cursor: pointer;
}
.edited-expand:hover {
	background: var(--hover);
	color: var(--ink);
}
.edited-expand svg {
	font-size: 12px;
}
</style>
