<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { ProjectFilePreview } from "../../shared/project-browser.ts";

const props = defineProps<{ cwd: string; path: string }>();
const preview = ref<ProjectFilePreview | null>(null);
const loading = ref(true);
const error = ref("");
const name = computed(() => props.path.split("/").at(-1) ?? props.path);

async function load(): Promise<void> {
	loading.value = true;
	error.value = "";
	preview.value = null;
	try {
		preview.value = await window.piDesktop.previewProjectFile({ cwd: props.cwd, path: props.path });
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : "无法打开文件";
	} finally {
		loading.value = false;
	}
}

onMounted(load);
watch(() => [props.cwd, props.path], load);
</script>

<template>
	<div class="file-document">
		<header class="file-document-head">
			<strong>{{ name }}</strong>
			<span v-if="preview?.kind === 'document'">{{ preview.format }} · 只读预览</span>
			<span v-else-if="preview?.kind === 'pdf'">PDF</span>
			<span v-else-if="preview?.kind === 'image'">图片</span>
			<span v-else>文本</span>
		</header>
		<div v-if="loading" class="side-empty">正在打开…</div>
		<p v-else-if="error" class="side-error" role="alert">{{ error }}</p>
		<div v-else-if="preview?.kind === 'image'" class="file-document-image">
			<img :src="preview.dataUrl" :alt="name" />
		</div>
		<iframe v-else-if="preview?.kind === 'pdf'" class="file-document-frame" :src="preview.url" :title="name" />
		<pre v-else-if="preview?.kind === 'text' || preview?.kind === 'document'" class="file-document-text">{{
			preview.text
		}}</pre>
		<div v-else class="side-empty">当前格式暂不支持侧栏预览。</div>
	</div>
</template>

<style scoped>
.file-document {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}
.file-document-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
	padding: 4px 12px 10px;
	border-bottom: 1px solid var(--line-soft);
}
.file-document-head strong {
	overflow: hidden;
	min-width: 0;
	color: var(--ink);
	font-size: 13px;
	font-weight: 500;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.file-document-head span {
	flex: none;
	color: var(--faint);
	font-size: 11px;
}
.file-document-text {
	flex: 1;
	min-height: 0;
	margin: 0;
	padding: 16px;
	overflow: auto;
	color: var(--ink);
	font:
		13px/1.8 Consolas,
		"Cascadia Code",
		monospace;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.file-document-image {
	display: grid;
	place-items: center;
	flex: 1;
	min-height: 0;
	padding: 16px;
	overflow: auto;
}
.file-document-image img {
	max-width: 100%;
	max-height: 100%;
	object-fit: contain;
}
.file-document-frame {
	flex: 1;
	width: 100%;
	min-height: 0;
	border: 0;
	background: #fff;
}
</style>
