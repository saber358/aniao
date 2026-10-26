<script setup lang="ts">
import { Markdown } from "@comark/vue";
import security from "@comark/vue/plugins/security";
import shiki from "@comark/vue/plugins/shiki";
import SafeLink from "./SafeLink.vue";
import CodeBlock from "./CodeBlock.vue";

defineProps<{ text: string; streaming?: boolean }>();

/*
 * ========================================================================
 * 步骤1：限制模型正文的渲染能力
 * ========================================================================
 * 数据源：消息中的文本快照，不执行 HTML 或组件语法。
 * 操作：
 *   1) 禁用默认扩展语法并清洗标签与协议
 *   2) 高亮只产生展示内容，外链交给受限组件
 */
// 1.1 插件实例由组件模块复用，不为每个 token 重建高亮器。
const plugins = [
	shiki(),
	security({
		allowedTags: [
			"p",
			"span",
			"strong",
			"em",
			"s",
			"a",
			"code",
			"pre",
			"blockquote",
			"ul",
			"ol",
			"li",
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"h6",
			"hr",
			"br",
			"table",
			"thead",
			"tbody",
			"tr",
			"th",
			"td",
		],
		allowedProtocols: ["http", "https", "mailto"],
		allowDataImages: false,
	}),
];
const components = { a: SafeLink, pre: CodeBlock };
</script>

<template>
	<div class="markdown-body" :class="{ streaming }">
		<Suspense>
			<Markdown
				:value="text"
				:streaming="streaming"
				:options="{ registerDefaultPlugins: false }"
				:plugins="plugins"
				:components="components"
			/>
			<template #fallback
				><p class="plain-message">{{ text }}</p></template
			>
		</Suspense>
	</div>
</template>
