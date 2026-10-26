<script setup lang="ts">
import { computed, nextTick, ref, useId } from "vue";
import { createLogger } from "../../shared/logger.ts";
import type {
	ProjectFileMatches,
	ProjectFileReference,
	ProjectFileSearch,
	ProjectFileSelection,
} from "../../shared/project-files.ts";
import { PROJECT_FILE_LIMIT, PROJECT_QUERY_LIMIT } from "../../shared/project-files.ts";
import { useFileSearch } from "../composables/use-file-search.ts";
import { UButton, UCommandPalette, UModal } from "../ui.ts";

const props = defineProps<{
	selection: ProjectFileSelection;
	disabled: boolean;
	error: string | null;
	search: (input: ProjectFileSearch) => Promise<ProjectFileMatches>;
	reference: (input: ProjectFileReference) => Promise<boolean>;
}>();
const emit = defineEmits<{ inserted: []; native: [] }>();
const open = ref(false);
const query = ref("");
const saving = ref(false);
const completion = ref<"inserted" | "native" | null>(null);
const selectionError = ref("");
const searchInputId = useId();
const logger = createLogger("file-search");
const input = computed(() => (open.value ? { ...props.selection, query: query.value } : null));
const { matches, loading, error, retry } = useFileSearch(() => input.value, props.search, logger);
const groups = computed(() => [
	{
		id: "project-files",
		ignoreFilter: true,
		items: matches.value.paths.map((path) => ({
			label: path,
			disabled: saving.value || props.disabled,
			onSelect: () => {
				void select(path);
			},
		})),
	},
]);

/*
 * ========================================================================
 * 步骤1：把搜索结果选择交给同一草稿入口
 * ========================================================================
 * 数据源：主进程返回的相对路径，携带弹窗所属会话身份。
 * 操作：
 *   1) 选择期间禁用重复提交，验证失败保留搜索和输入
 *   2) 成功关闭后才恢复输入焦点，Enter 不提交模型请求
 */
async function select(path: string) {
	if (saving.value || props.disabled || loading.value || !matches.value.paths.includes(path)) return;
	logger.info("开始插入搜索文件引用");
	saving.value = true;
	selectionError.value = "";
	try {
		// 1.1 选中后重新验证文件，不把搜索结果当作永久有效的文件句柄。
		if (await props.reference({ ...props.selection, paths: [path] })) {
			completion.value = "inserted";
			open.value = false;
		} else selectionError.value = props.error || "文件引用失败，请重新搜索后重试";
	} finally {
		saving.value = false;
		logger.info("搜索文件引用插入结束");
	}
}
function show() {
	query.value = "";
	selectionError.value = "";
	completion.value = null;
	open.value = true;
}
async function finish(event: Event) {
	if (!completion.value) return;
	// 1.2 使用关闭焦点事件接管成功路径，取消仍交给组件库恢复触发按钮。
	event.preventDefault();
	await nextTick();
	if (completion.value === "inserted") emit("inserted");
	else if (completion.value === "native") emit("native");
}
</script>

<template>
	<UModal
		v-model:open="open"
		title="搜索项目文件"
		description="选择文件，把相对路径加入草稿。发送任务后，模型按需读取文件。"
		:dismissible="!saving"
		:close="!saving"
		:content="{ onCloseAutoFocus: finish }"
	>
		<UButton
			icon="i-lucide-search"
			color="neutral"
			variant="ghost"
			size="sm"
			aria-label="搜索项目文件"
			title="搜索文件并引用"
			:disabled="disabled"
			@click="show"
		/>
		<template #body>
			<label :for="searchInputId" class="sr-only">搜索文件名</label>
			<UCommandPalette
				v-model:search-term="query"
				:groups="groups"
				:loading="loading"
				:disabled="saving"
				:input="{ id: searchInputId, maxlength: PROJECT_QUERY_LIMIT, disabled: saving }"
				:fuse="{ resultLimit: PROJECT_FILE_LIMIT }"
				placeholder="输入文件名或项目相对路径"
				class="project-file-search"
			>
				<template #empty
					><span role="status">{{
						loading ? "正在搜索文件" : error || (query.trim() ? "没有匹配文件" : "输入文件名开始搜索")
					}}</span></template
				>
				<template #item-label="{ item }"
					><span class="file-match-path">{{ item.label }}</span></template
				>
			</UCommandPalette>
			<p v-if="matches.incomplete" class="muted" role="status">搜索结果不完整，请缩小查询或使用原生选择。</p>
			<p v-if="selectionError" role="alert" class="workspace-error">{{ selectionError }}</p>
			<div class="file-search-actions">
				<UButton v-if="error" color="neutral" variant="ghost" size="sm" @click="retry">重试搜索</UButton>
				<UButton
					color="neutral"
					variant="ghost"
					size="sm"
					:disabled="saving"
					@click="
						completion = 'native';
						open = false;
					"
					>使用原生文件选择</UButton
				>
			</div>
		</template>
	</UModal>
</template>
