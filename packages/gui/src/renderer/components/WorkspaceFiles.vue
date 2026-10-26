<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { ProjectEntry, ProjectFileContent } from "../../shared/project-browser.ts";
import { UButton, UIcon } from "../ui.ts";

const props = defineProps<{ cwd: string }>();
const bridge = window.piDesktop;
const path = ref("");
const entries = ref<ProjectEntry[]>([]);
const loading = ref(false);
const error = ref("");
const truncated = ref(false);
const file = ref<ProjectFileContent | null>(null);
let request = 0;

const segments = computed(() => (path.value ? path.value.split("/") : []));

function message(reason: unknown): string {
	return reason instanceof Error ? reason.message : "无法读取项目文件";
}

async function load(next: string): Promise<void> {
	const current = ++request;
	loading.value = true;
	error.value = "";
	file.value = null;
	try {
		const result = await bridge.listDirectory({ cwd: props.cwd, path: next });
		if (current !== request) return;
		path.value = result.path;
		entries.value = result.entries;
		truncated.value = result.truncated;
	} catch (reason) {
		if (current === request) error.value = message(reason);
	} finally {
		if (current === request) loading.value = false;
	}
}

async function open(entry: ProjectEntry): Promise<void> {
	if (entry.type === "directory") {
		await load(entry.path);
		return;
	}
	loading.value = true;
	error.value = "";
	try {
		file.value = await bridge.readProjectFile({ cwd: props.cwd, path: entry.path });
	} catch (reason) {
		error.value = message(reason);
	} finally {
		loading.value = false;
	}
}

function up(): void {
	const next = segments.value.slice(0, -1).join("/");
	void load(next);
}

function jump(index: number): void {
	void load(segments.value.slice(0, index + 1).join("/"));
}

onMounted(() => {
	void load("");
});
watch(
	() => props.cwd,
	() => {
		void load("");
	},
);
</script>

<template>
	<div class="file-panel">
		<div class="file-toolbar">
			<UButton
				icon="i-lucide-arrow-up"
				color="neutral"
				variant="ghost"
				size="xs"
				aria-label="返回上级目录"
				:disabled="path === ''"
				@click="up"
			/>
			<nav class="file-breadcrumb" aria-label="文件路径">
				<button type="button" @click="jump(-1)">项目</button>
				<template v-for="(segment, index) in segments" :key="`${segment}-${index}`">
					<span>/</span>
					<button type="button" @click="jump(index)">{{ segment }}</button>
				</template>
			</nav>
		</div>

		<p v-if="error" class="side-error" role="alert">{{ error }}</p>
		<div v-if="loading" class="side-empty">正在读取…</div>
		<div v-else-if="file" class="file-preview">
			<div class="file-preview-head">
				<span :title="file.path">{{ file.path }}</span>
				<UButton color="neutral" variant="ghost" size="xs" @click="file = null">返回列表</UButton>
			</div>
			<div v-if="file.binary" class="side-empty">二进制文件不在此处预览。</div>
			<div v-else-if="file.truncated" class="side-empty">文件超过 1.5 MiB，已停止读取。</div>
			<pre v-else>{{ file.text }}</pre>
		</div>
		<div v-else class="file-list">
			<button
				v-for="entry in entries"
				:key="entry.path"
				type="button"
				class="file-row"
				:title="entry.path"
				@click="open(entry)"
			>
				<UIcon
					:name="entry.type === 'directory' ? 'i-lucide-folder' : 'i-lucide-file-text'"
					class="file-icon"
					aria-hidden="true"
				/>
				<span>{{ entry.name }}</span>
			</button>
			<div v-if="entries.length === 0" class="side-empty">目录为空。</div>
		</div>
		<p v-if="truncated" class="file-note">目录项目过多，仅显示前 500 项。</p>
	</div>
</template>
