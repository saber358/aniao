<script setup lang="ts">
import { nextTick, ref } from "vue";
import { createLogger } from "../../shared/logger.ts";
import { readImageFiles } from "../adapters/image-input.ts";

const props = defineProps<{
	importImages: (read: () => Promise<string[]>) => Promise<boolean>;
	available: boolean;
	disabled: boolean;
}>();
const logger = createLogger("image-input");
const dragging = ref(false);

/*
 * ========================================================================
 * 步骤1：只接收输入区中的显式文件粘贴和拖放
 * ========================================================================
 * 数据源：当前事件的 DataTransfer，不轮询或读取系统剪贴板。
 * 操作：
 *   1) 同步捕获 File 引用，再由 Controller 建立互斥后读取内容
 *   2) 纯文本保留浏览器默认行为，文件事件阻止默认导航和路径插入
 */
async function importFiles(files: File[]) {
	logger.info("开始处理图片粘贴或拖放");
	try {
		// 1.1 项目切换期间不启动内容读取；其他状态交给 Controller 再核对。
		if (!props.disabled && (await props.importImages(() => readImageFiles(files, logger)))) {
			// 1.2 使用已有输入框恢复焦点，图片不会自动发送。
			await nextTick();
			zone.value?.querySelector("textarea")?.focus();
		}
	} finally {
		logger.info("图片粘贴或拖放处理结束");
	}
}
const zone = ref<HTMLDivElement>();
function paste(event: ClipboardEvent) {
	if (!(event.target instanceof HTMLTextAreaElement)) return;
	const files = Array.from(event.clipboardData?.files ?? []);
	if (!files.length) return;
	event.preventDefault();
	event.stopPropagation();
	void importFiles(files);
}
function dragOver(event: DragEvent) {
	if (!event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
	event.stopPropagation();
	event.dataTransfer.dropEffect = props.available && !props.disabled ? "copy" : "none";
	dragging.value = true;
}
function dragLeave(event: DragEvent) {
	if (event.relatedTarget instanceof Node && zone.value?.contains(event.relatedTarget)) return;
	dragging.value = false;
}
function drop(event: DragEvent) {
	dragging.value = false;
	const files = Array.from(event.dataTransfer?.files ?? []);
	if (!files.length && !event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
	event.stopPropagation();
	void importFiles(files);
}
</script>

<template>
	<div
		ref="zone"
		class="image-input-zone"
		:class="{ 'image-dragging': dragging && !disabled }"
		@paste.capture="paste"
		@dragover="dragOver"
		@dragleave="dragLeave"
		@drop="drop"
	>
		<slot />
		<span v-if="dragging && !disabled" class="image-drop-hint" role="status">
			{{ available ? "松开以添加 PNG 或 JPEG 图片" : "当前状态暂不可添加图片" }}
		</span>
	</div>
</template>
