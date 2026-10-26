<script setup lang="ts">
import { useId } from "vue";
import { createLogger } from "../../shared/logger.ts";
import { type FileCompletionOptions, useFileCompletion } from "../composables/use-file-completion.ts";
import { UButton, UIcon } from "../ui.ts";

const props = defineProps<FileCompletionOptions>();
const logger = createLogger("file-completion");
const {
	panel,
	list,
	listId,
	target,
	active,
	candidates,
	directoryLoading,
	directoryError,
	matches,
	loading,
	error,
	selectionError,
	saving,
	inputAttributes,
	retry,
	select,
	enterDirectory,
	referenceDirectory,
	leavePanel,
} = useFileCompletion(props, logger, useId());
defineExpose({ inputAttributes });
</script>

<template>
	<div v-if="target" ref="panel" class="file-completion" @focusout="leavePanel">
		<div class="file-completion-heading">文件与文件夹</div>
		<div
			:id="listId"
			ref="list"
			role="listbox"
			aria-label="文件补全候选"
			:aria-busy="loading || directoryLoading"
			class="file-completion-list"
		>
			<UButton
				v-for="(candidate, index) in candidates"
				:id="`${listId}-${index}`"
				:key="`${candidate.type}:${candidate.path}`"
				role="option"
				:aria-selected="index === active"
				:tabindex="-1"
				color="neutral"
				variant="ghost"
				class="file-completion-option"
				:class="{ 'file-completion-active': index === active }"
				:disabled="saving || disabled"
				@pointerdown.prevent
				@pointermove="active = index"
				@click="candidate.type === 'directory' ? enterDirectory(candidate.path) : select(candidate.path)"
			>
				<UIcon
					:name="candidate.type === 'directory' ? 'i-lucide-folder' : 'i-lucide-file-text'"
					class="file-completion-icon"
					aria-hidden="true"
				/>
				<span class="file-match-path">{{ candidate.name }}</span>
				<span v-if="candidate.type === 'directory'" class="file-completion-hint">
					<kbd>Tab</kbd> 进入 · <kbd>Enter</kbd> 引用
					<UIcon name="i-lucide-chevron-right" aria-hidden="true" />
				</span>
			</UButton>
		</div>
		<p v-if="!candidates.length" role="status" class="file-completion-note">
			{{
				loading || directoryLoading
					? "正在读取"
					: directoryError || error || (target.query.trim() ? "没有匹配文件" : "继续输入文件名")
			}}
		</p>
		<p v-if="matches.incomplete" role="status" class="file-completion-note">结果不完整，可缩小查询或使用文件搜索。</p>
		<p v-if="selectionError" role="alert" class="workspace-error">{{ selectionError }}</p>
		<UButton v-if="error" color="neutral" variant="ghost" size="xs" @pointerdown.prevent @click="retry"
			>重试搜索</UButton
		>
	</div>
</template>
