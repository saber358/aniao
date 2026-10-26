<script setup lang="ts">
import { ref, watch } from "vue";
import type { ImageRead } from "../../shared/images.ts";
import { createLogger } from "../../shared/logger.ts";
import { UButton, UModal } from "../ui.ts";

const props = defineProps<{ input: ImageRead; removable?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ remove: [] }>();
const logger = createLogger("image-preview");
const url = ref("");
const error = ref("");
const expanded = ref(false);

/*
 * ========================================================================
 * 步骤1：按需读取受限图片并展示预览
 * ========================================================================
 * 数据源：当前会话的内容身份，不接收文件路径或远程 URL。
 * 操作：
 *   1) 图片读取只随身份变化，文字输入不重复读取
 *   2) 组件销毁或身份变化后丢弃旧结果，失败保留移除和重试入口
 */
async function load(isCurrent: () => boolean) {
	logger.info("开始读取图片缩略图");
	error.value = "";
	try {
		// 1.1 每个请求只读取一张有界 PNG，响应不能覆盖下一会话。
		const result = await window.piDesktop.readImage(props.input);
		if (isCurrent()) url.value = result;
	} catch {
		if (isCurrent()) error.value = "图片预览不可用";
	} finally {
		logger.info("图片缩略图读取结束");
	}
}
let currentRequest = 0;
function retry() {
	const request = ++currentRequest;
	void load(() => currentRequest === request);
}
watch(
	[() => props.input.sessionId, () => props.input.generation, () => props.input.imageId, () => props.input.source],
	(_value, _previous, onCleanup) => {
		const request = ++currentRequest;
		url.value = "";
		expanded.value = false;
		onCleanup(() => {
			currentRequest++;
		});
		void load(() => currentRequest === request);
	},
	{ immediate: true },
);
</script>

<template>
	<div class="image-attachment">
		<button
			v-if="url && !error"
			type="button"
			class="image-thumbnail"
			aria-label="查看图片附件"
			@click="expanded = true"
		>
			<img :src="url" alt="图片附件" decoding="async" @error="error = '图片预览不可用'" />
		</button>
		<UButton v-else-if="error" color="neutral" variant="ghost" size="xs" aria-label="重试图片预览" @click="retry"
			>{{ error }} · 重试</UButton
		>
		<span v-else class="muted" role="status">正在读取图片</span>
		<UButton
			v-if="removable"
			icon="i-lucide-x"
			aria-label="移除图片附件"
			color="neutral"
			variant="ghost"
			size="xs"
			:disabled="disabled"
			@click="emit('remove')"
		/>
		<UModal v-model:open="expanded" title="图片附件" description="当前会话的图片预览。">
			<template #body><img v-if="url" :src="url" alt="图片附件预览" class="image-expanded" /></template>
		</UModal>
	</div>
</template>
