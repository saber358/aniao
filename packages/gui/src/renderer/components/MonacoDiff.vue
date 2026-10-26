<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { createLogger } from "../../shared/logger.ts";

type WorkerEnvironment = typeof self & {
	MonacoEnvironment: {
		getWorker: (_moduleId: string, label: string) => Worker;
	};
};

const environment = self as WorkerEnvironment;
environment.MonacoEnvironment = {
	getWorker: (_moduleId, label) => {
		switch (label) {
			case "json":
				return new JsonWorker();
			case "css":
			case "scss":
			case "less":
				return new CssWorker();
			case "html":
			case "handlebars":
			case "razor":
				return new HtmlWorker();
			case "typescript":
			case "javascript":
				return new TsWorker();
			default:
				return new EditorWorker();
		}
	},
};

const props = defineProps<{ original: string; modified: string; path: string }>();
const logger = createLogger("monaco-diff");
const container = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneDiffEditor | undefined;
let originalModel: monaco.editor.ITextModel | undefined;
let modifiedModel: monaco.editor.ITextModel | undefined;
let activeSide: "left" | "right" = "right";
const dark = () => document.documentElement.classList.contains("dark");

function language(path: string): string {
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	if (["ts", "tsx", "mts", "cts"].includes(extension)) return "typescript";
	if (["js", "jsx", "mjs", "cjs"].includes(extension)) return "javascript";
	if (extension === "json") return "json";
	if (extension === "css") return "css";
	if (["html", "htm", "vue", "svelte"].includes(extension)) return "html";
	if (extension === "md" || extension === "mdx") return "markdown";
	if (extension === "py") return "python";
	if (["sh", "bash", "zsh", "ps1"].includes(extension)) return "shell";
	if (["cpp", "cc", "cxx", "h", "hpp"].includes(extension)) return "cpp";
	if (extension === "rs") return "rust";
	if (extension === "go") return "go";
	if (["yml", "yaml"].includes(extension)) return "yaml";
	return "plaintext";
}

/*
 * ========================================================================
 * 步骤1：按差异容器宽度切换并排与行内展示
 * ========================================================================
 * 数据源：当前文件两侧内容与 Monaco 的容器尺寸。
 * 操作：1) 窄侧栏使用行内差异；2) 放大后恢复并排，评论仍关联实际一侧。
 */
function render(): void {
	logger.info("开始准备文件差异视图");
	try {
		if (!container.value) return;
		editor?.dispose();
		originalModel?.dispose();
		modifiedModel?.dispose();
		const lang = language(props.path);
		originalModel = monaco.editor.createModel(props.original, lang);
		modifiedModel = monaco.editor.createModel(props.modified, lang);
		editor = monaco.editor.createDiffEditor(container.value, {
			automaticLayout: true,
			readOnly: true,
			renderSideBySide: true,
			// 1.1 原生布局在容器缩小时自动转为行内，不缩窄两列到不可读。
			useInlineViewWhenSpaceIsLimited: true,
			renderSideBySideInlineBreakpoint: 680,
			renderOverviewRuler: false,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontSize: 12,
			lineHeight: 19,
			fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
			ignoreTrimWhitespace: false,
			theme: dark() ? "vs-dark" : "vs",
		});
		editor.setModel({ original: originalModel, modified: modifiedModel });
		// 1.1 记住编辑器焦点，点击评论按钮后仍能定位原始侧。
		editor.getOriginalEditor().onDidFocusEditorText(() => {
			activeSide = "left";
		});
		editor.getModifiedEditor().onDidFocusEditorText(() => {
			activeSide = "right";
		});
	} finally {
		logger.info("文件差异视图准备结束");
	}
}

defineExpose({
	getLocation: () => {
		const original = editor?.getOriginalEditor();
		const left = activeSide === "left";
		return {
			line: (left ? original : editor?.getModifiedEditor())?.getPosition()?.lineNumber ?? 1,
			side: left ? ("left" as const) : ("right" as const),
		};
	},
});

let observer: MutationObserver | undefined;
onMounted(() => {
	render();
	observer = new MutationObserver(() => {
		monaco.editor.setTheme(dark() ? "vs-dark" : "vs");
	});
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
});
watch(
	() => [props.original, props.modified, props.path],
	() => render(),
);
onBeforeUnmount(() => {
	observer?.disconnect();
	editor?.dispose();
	originalModel?.dispose();
	modifiedModel?.dispose();
});
</script>

<template>
	<div ref="container" class="monaco-diff"></div>
</template>
