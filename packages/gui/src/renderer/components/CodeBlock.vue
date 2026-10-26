<script setup lang="ts">
import { computed, useAttrs } from "vue";
import type { ElementNode } from "@comark/vue";
import { codeText } from "../adapters/markdown-view.ts";
import CopyButton from "./CopyButton.vue";

/*
 * ========================================================================
 * 步骤1：复用高亮内容并提供代码复制
 * ========================================================================
 * 数据源：Comark 公开节点属性与已清洗的 pre 属性。
 * 操作：
 *   1) 高亮仍由 Shiki 插槽展示，不创建第二个解析器
 *   2) 复制内容从 AST 提取，工具栏不进入正文
 */
defineOptions({ inheritAttrs: false });
const props = defineProps<{ __node: ElementNode; language?: string }>();
const attrs = useAttrs();
const text = computed(() => codeText(props.__node));
</script>

<template>
	<div class="code-block">
		<div class="code-toolbar">
			<span>{{ language || "代码" }}</span
			><CopyButton :text="text" label="复制代码" />
		</div>
		<pre v-bind="attrs"><slot /></pre>
	</div>
</template>
