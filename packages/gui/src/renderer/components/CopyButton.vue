<script setup lang="ts">
import { onScopeDispose, ref, watch } from "vue";
import { CLIPBOARD_TEXT_LIMIT } from "../../shared/clipboard.ts";
import { createLogger } from "../../shared/logger.ts";
import { UButton } from "../ui.ts";

const props = defineProps<{ text: string; label: string }>();
const logger = createLogger("copy-button");
const busy = ref(false);
const copied = ref(false);
const error = ref("");
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/*
 * ========================================================================
 * 步骤1：复制点击时的文本并显示确认
 * ========================================================================
 * 数据源：消息原文或代码 AST，不读取渲染后的 DOM 文本。
 * 操作：
 *   1) 保留空白与 Markdown，超限时拒绝，不静默截断
 *   2) 文本变化或组件释放后，迟到响应不能更新新内容状态
 */
async function copy() {
	if (busy.value || !props.text || props.text.length > CLIPBOARD_TEXT_LIMIT) return;
	logger.info("开始复制选定内容");
	const request = ++revision;
	busy.value = true;
	copied.value = false;
	error.value = "";
	try {
		// 1.1 明确点击才写入剪贴板，不把正文、代码或错误记录到日志。
		await window.piDesktop.writeClipboard(props.text);
		if (request !== revision) return;
		copied.value = true;
		clearTimeout(timer);
		timer = setTimeout(() => {
			copied.value = false;
		}, 1500);
	} catch {
		if (request === revision) error.value = "复制失败，请重试";
	} finally {
		if (request === revision) busy.value = false;
		logger.info("选定内容复制结束");
	}
}
watch(
	() => props.text,
	() => {
		revision++;
		clearTimeout(timer);
		busy.value = false;
		copied.value = false;
		error.value = "";
	},
);
onScopeDispose(() => {
	revision++;
	clearTimeout(timer);
});
</script>

<template>
	<span class="copy-action">
		<UButton
			:icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
			:aria-label="label"
			:title="text.length > CLIPBOARD_TEXT_LIMIT ? '文本过长，无法整段复制' : copied ? '已复制' : label"
			color="neutral"
			variant="ghost"
			size="xs"
			:loading="busy"
			:disabled="!text || text.length > CLIPBOARD_TEXT_LIMIT"
			@click="copy"
		/>
		<span v-if="copied" class="muted" role="status">已复制</span>
		<span v-if="error" class="message-error" role="alert">{{ error }}</span>
	</span>
</template>
