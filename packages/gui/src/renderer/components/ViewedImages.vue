<script setup lang="ts">
import { ref } from "vue";
import type { ViewedImagesData } from "../adapters/chat-view.ts";
import { createLogger } from "../../shared/logger.ts";
import { UIcon } from "../ui.ts";
import ImageAttachment from "./ImageAttachment.vue";

defineProps<{ data: ViewedImagesData; sessionId: string; generation: string }>();
const logger = createLogger("viewed-images");
const expanded = ref(false);

/*
 * ========================================================================
 * 步骤1：展开已查看图片的单行缩略图
 * ========================================================================
 * 数据源：当前会话内工具返回的图片身份。
 * 操作：1) 默认仅显示查看数量；2) 展开时才读取缩略图，点击图片可放大。
 */
function toggle(): void {
	logger.info("开始切换图片查看步骤");
	try {
		// 1.1 缩略图使用会话图片端口，不读取原始文件或重新调用工具。
		expanded.value = !expanded.value;
	} finally {
		logger.info("图片查看步骤切换结束");
	}
}
</script>

<template>
	<div class="viewed-images">
		<button type="button" class="viewed-images-trigger" :aria-expanded="expanded" @click="toggle">
			<UIcon name="i-lucide-images" class="viewed-images-icon" aria-hidden="true" />
			<span>已查看 {{ data.imageIds.length }} 张图片</span>
			<UIcon
				name="i-lucide-chevron-down"
				class="viewed-images-chevron"
				:class="{ open: expanded }"
				aria-hidden="true"
			/>
		</button>
		<div v-if="expanded" class="viewed-images-thumbnails" aria-label="已查看图片缩略图">
			<ImageAttachment
				v-for="(imageId, index) in data.imageIds"
				:key="`${data.id}-${index}`"
				:input="{ sessionId, generation, imageId, source: 'message' }"
			/>
		</div>
	</div>
</template>

<style scoped>
.viewed-images {
	min-width: 0;
	padding: 4px 0;
}
.viewed-images-trigger {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	padding: 0;
	border: 0;
	background: transparent;
	color: var(--muted);
	cursor: pointer;
	font: inherit;
	font-size: 13px;
}
.viewed-images-trigger:hover {
	color: var(--ink);
}
.viewed-images-icon {
	width: 16px;
	height: 16px;
	flex: none;
}
.viewed-images-chevron {
	width: 13px;
	height: 13px;
	flex: none;
	opacity: 0;
	transform: rotate(-90deg);
	transition: transform 0.15s ease;
}
.viewed-images-trigger:hover .viewed-images-chevron,
.viewed-images-trigger:focus-visible .viewed-images-chevron,
.viewed-images-chevron.open {
	opacity: 1;
}
.viewed-images-chevron.open {
	transform: rotate(0);
}
.viewed-images-thumbnails {
	display: flex;
	gap: 10px;
	margin-top: 12px;
	padding-bottom: 4px;
	overflow-x: auto;
}
.viewed-images-thumbnails :deep(.image-attachment) {
	flex: none;
}
.viewed-images-thumbnails :deep(.image-thumbnail) {
	display: grid;
	width: 96px;
	height: 96px;
	place-items: center;
	padding: 6px;
	border: 1px solid var(--line-soft);
	border-radius: 12px;
	background: var(--sidebar);
}
.viewed-images-thumbnails :deep(.image-thumbnail img) {
	width: 82px;
	height: 82px;
	object-fit: contain;
}
</style>
