<script setup lang="ts">
import { computed, ref } from "vue";
import { createLogger } from "../../shared/logger.ts";

const props = defineProps<{ href?: string }>();
const logger = createLogger("link");
const error = ref(false);
const external = computed(() => /^(https?:|mailto:)/i.test(props.href ?? ""));

/*
 * ========================================================================
 * 步骤1：经受限桌面接口打开外链
 * ========================================================================
 * 数据源：Markdown 的链接属性。
 * 操作：
 *   1) 文件链接先保留文本，不给内容通用文件权限
 *   2) 网页链接交给右侧内置浏览器，不直接打开系统浏览器
 */
async function open() {
	logger.info("开始打开外链");
	error.value = false;
	try {
		// 1.1 不记录 URL，避免链接查询参数中的凭据进入日志。
		if (external.value && props.href) window.dispatchEvent(new CustomEvent("aniao:open-url", { detail: props.href }));
	} catch {
		error.value = true;
	} finally {
		logger.info("外链打开结束");
	}
}
</script>

<template>
	<a v-if="external" :href="href" @click.prevent="open"><slot /></a>
	<span v-else><slot /></span>
	<span v-if="error" role="alert" class="link-error">链接无法打开</span>
</template>
