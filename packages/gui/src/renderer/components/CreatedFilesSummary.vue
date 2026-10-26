<script setup lang="ts">
import { computed } from "vue";
import type { CreatedFile, CreatedFilesSummary } from "../adapters/chat-view.ts";
import { UIcon } from "../ui.ts";

const props = defineProps<{ data: CreatedFilesSummary }>();
const emit = defineEmits<{ open: [path: string] }>();
const files = computed(() => props.data.files);

function icon(file: CreatedFile): string {
	if (file.kind === "document") return "i-lucide-file-text";
	if (file.kind === "spreadsheet") return "i-lucide-table-2";
	if (file.kind === "presentation") return "i-lucide-presentation";
	if (file.kind === "image") return "i-lucide-image";
	if (file.kind === "code") return "i-lucide-file-code";
	return "i-lucide-file";
}

function typeLabel(file: CreatedFile): string {
	const kind =
		file.kind === "document"
			? "文档"
			: file.kind === "spreadsheet"
				? "表格"
				: file.kind === "presentation"
					? "演示文稿"
					: file.kind === "image"
						? "图片"
						: file.kind === "code"
							? "代码"
							: "文件";
	return file.extension ? `${kind} · ${file.extension}` : kind;
}
</script>

<template>
	<div class="created-files" aria-label="新建文件">
		<div v-for="file in files" :key="file.path" class="created-file">
			<span class="created-file-icon" aria-hidden="true">
				<UIcon :name="icon(file)" />
			</span>
			<div class="created-file-copy">
				<strong :title="file.name">{{ file.name }}</strong>
				<span>{{ typeLabel(file) }}</span>
			</div>
			<button type="button" class="created-file-open" @click="emit('open', file.path)">
				<span>打开</span>
				<UIcon name="i-lucide-chevron-down" aria-hidden="true" />
			</button>
		</div>
	</div>
</template>

<style scoped>
.created-files {
	display: grid;
	gap: 8px;
	margin: 12px 0;
}
.created-file {
	display: flex;
	align-items: center;
	gap: 12px;
	min-width: 0;
	padding: 12px 14px;
	border: 1px solid var(--line-soft);
	border-radius: 12px;
	background: var(--surface);
}
.created-file-icon {
	display: grid;
	place-items: center;
	width: 38px;
	height: 38px;
	flex: none;
	border-radius: 8px;
	background: var(--sidebar);
	color: var(--accent);
	font-size: 20px;
}
.created-file-copy {
	display: grid;
	min-width: 0;
	flex: 1;
	gap: 2px;
}
.created-file-copy strong {
	overflow: hidden;
	color: var(--ink);
	font-size: 14px;
	font-weight: 500;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.created-file-copy span {
	color: var(--faint);
	font-size: 12px;
}
.created-file-open {
	display: inline-flex;
	align-items: center;
	gap: 2px;
	flex: none;
	padding: 5px 9px;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: transparent;
	color: var(--ink);
	cursor: pointer;
	font: inherit;
	font-size: 13px;
}
.created-file-open:hover {
	background: var(--hover);
}
.created-file-open svg {
	width: 13px;
	height: 13px;
	color: var(--faint);
}
</style>
