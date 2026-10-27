<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { PROJECT_IMAGE_PATTERN, type ProjectFilePreview } from "../../shared/project-browser.ts";
import { createLogger } from "../../shared/logger.ts";
import { UButton } from "../ui.ts";

const props = defineProps<{ cwd: string; path: string }>();
const preview = ref<ProjectFilePreview | null>(null);
const loading = ref(true);
const error = ref("");
const name = computed(() => props.path.split("/").at(-1) ?? props.path);
const logger = createLogger("file-preview");
const imageViewport = useTemplateRef<HTMLElement>("imageViewport");
const imageSize = ref<{ width: number; height: number } | null>(null);
const viewportSize = ref({ width: 0, height: 0 });
const zoom = ref<number | null>(null);
const scale = computed(() => {
	if (zoom.value !== null) return zoom.value;
	const image = imageSize.value;
	const viewport = viewportSize.value;
	if (!image || !viewport.width || !viewport.height) return 1;
	return Math.min(1, viewport.width / image.width, viewport.height / image.height);
});
const imageStyle = computed(() =>
	imageSize.value
		? { width: `${imageSize.value.width * scale.value}px`, height: `${imageSize.value.height * scale.value}px` }
		: {},
);
let request = 0;

/*
 * ========================================================================
 * 步骤1：读取当前文件并隔离迟到结果
 * ========================================================================
 * 数据源：主进程已校验项目归属的文件预览。
 * 操作：1) 文件切换或关闭后丢弃旧回复；2) 读取或图片解码失败时允许重试。
 */
async function load(): Promise<void> {
	logger.info("开始读取侧栏文件预览");
	const current = ++request;
	loading.value = true;
	error.value = "";
	preview.value = null;
	imageSize.value = null;
	zoom.value = null;
	try {
		// 1.1 只在请求身份仍有效时安装结果，重试也使用新的序号。
		const result = await window.piDesktop.previewProjectFile({ cwd: props.cwd, path: props.path });
		if (current === request) preview.value = result;
	} catch (reason) {
		if (current === request) error.value = reason instanceof Error ? reason.message : "无法打开文件";
	} finally {
		if (current === request) loading.value = false;
		logger.info("侧栏文件预览读取结束");
	}
}

/*
 * ========================================================================
 * 步骤2：按图片原始尺寸缩放与适应面板
 * ========================================================================
 * 数据源：浏览器解码尺寸和预览区域的实际大小。
 * 操作：1) 默认完整显示图片；2) 放大后滚动查看，切换标签不重置缩放。
 */
function resizeImage(value: number | null): void {
	logger.info("开始调整侧栏图片缩放");
	try {
		// 2.1 相对当前显示比例缩放，适应窗口时也不会反向放大。
		zoom.value = value === null ? null : Math.max(0.05, Math.min(4, value));
	} finally {
		logger.info("侧栏图片缩放调整结束");
	}
}

function imageLoaded(event: Event): void {
	logger.info("开始读取侧栏图片尺寸");
	try {
		// 2.2 解码后的固有尺寸作为 100% 的基准，不重复读取磁盘。
		const image = event.currentTarget as HTMLImageElement;
		imageSize.value = { width: image.naturalWidth, height: image.naturalHeight };
	} finally {
		logger.info("侧栏图片尺寸读取结束");
	}
}

watch(imageViewport, (element, _previous, onCleanup) => {
	if (!element) return;
	logger.info("开始观察图片预览区域");
	// 2.3 面板拖拽、放大与标签重新显示后，按实际内容区重新计算适应比例。
	const observer = new ResizeObserver(([entry]) => {
		viewportSize.value = { width: entry.contentRect.width, height: entry.contentRect.height };
	});
	observer.observe(element);
	onCleanup(() => {
		observer.disconnect();
		logger.info("图片预览区域观察结束");
	});
});
watch([() => props.cwd, () => props.path], load, { immediate: true });
onBeforeUnmount(() => {
	request++;
});
</script>

<template>
	<div class="file-document">
		<header class="file-document-head">
			<strong>{{ name }}</strong>
			<span v-if="preview?.kind === 'document'">{{ preview.format }} · 只读预览</span>
			<span v-else-if="preview?.kind === 'pdf'">PDF</span>
			<span v-else-if="preview?.kind === 'image'">图片</span>
			<span v-else>文本</span>
		</header>
		<div v-if="loading" class="side-empty">正在打开…</div>
		<div v-else-if="error" class="file-document-error">
			<p class="side-error" role="alert">{{ error }}</p>
			<UButton color="neutral" variant="outline" size="sm" @click="load">重新加载</UButton>
		</div>
		<template v-else-if="preview?.kind === 'image'">
			<div class="file-image-toolbar" aria-label="图片查看工具">
				<span class="file-image-size">{{
					imageSize ? `${imageSize.width} × ${imageSize.height}` : "正在读取图片"
				}}</span>
				<div class="file-image-actions">
					<UButton
						icon="i-lucide-minus"
						color="neutral"
						variant="ghost"
						size="xs"
						aria-label="缩小图片"
						:disabled="!imageSize || scale <= 0.05"
						@click="resizeImage(scale / 1.25)"
					/>
					<span class="file-image-scale">{{ Math.round(scale * 100) }}%</span>
					<UButton
						icon="i-lucide-plus"
						color="neutral"
						variant="ghost"
						size="xs"
						aria-label="放大图片"
						:disabled="!imageSize || scale >= 4"
						@click="resizeImage(scale * 1.25)"
					/>
					<UButton
						color="neutral"
						variant="ghost"
						size="xs"
						aria-label="图片原始大小"
						:disabled="!imageSize"
						@click="resizeImage(1)"
						>100%</UButton
					>
					<UButton color="neutral" variant="ghost" size="xs" :disabled="!imageSize" @click="resizeImage(null)"
						>适应窗口</UButton
					>
				</div>
			</div>
			<div ref="imageViewport" class="file-document-image" aria-label="图片预览">
				<img
					:src="preview.dataUrl"
					:alt="name"
					:style="imageStyle"
					decoding="async"
					@load="imageLoaded"
					@error="error = '图片无法打开，文件可能已损坏。'"
				/>
			</div>
		</template>
		<iframe v-else-if="preview?.kind === 'pdf'" class="file-document-frame" :src="preview.url" :title="name" />
		<pre v-else-if="preview?.kind === 'text' || preview?.kind === 'document'" class="file-document-text">{{
			preview.text
		}}</pre>
		<div v-else-if="preview?.kind === 'unsupported' && PROJECT_IMAGE_PATTERN.test(props.path)" class="side-empty">
			图片超过 8 MiB，暂不支持预览。
		</div>
		<div v-else class="side-empty">当前格式暂不支持侧栏预览。</div>
	</div>
</template>

<style scoped>
.file-document {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}
.file-document-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
	padding: 4px 12px 10px;
	border-bottom: 1px solid var(--line-soft);
}
.file-document-head strong {
	overflow: hidden;
	min-width: 0;
	color: var(--ink);
	font-size: 13px;
	font-weight: 500;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.file-document-head span {
	flex: none;
	color: var(--faint);
	font-size: 11px;
}
.file-document-text {
	flex: 1;
	min-height: 0;
	margin: 0;
	padding: 16px;
	overflow: auto;
	color: var(--ink);
	font:
		13px/1.8 Consolas,
		"Cascadia Code",
		monospace;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.file-document-image {
	display: flex;
	flex: 1;
	min-height: 0;
	padding: 16px;
	overflow: auto;
}
.file-document-image img {
	display: block;
	flex: none;
	max-width: none;
	max-height: none;
	margin: auto;
	object-fit: contain;
}
.file-image-toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 4px 12px;
	padding: 8px 12px;
	border-bottom: 1px solid var(--line-soft);
}
.file-image-actions {
	display: flex;
	align-items: center;
	gap: 2px;
}
.file-image-size,
.file-image-scale {
	color: var(--faint);
	font-size: 11px;
	white-space: nowrap;
}
.file-image-scale {
	min-width: 34px;
	text-align: center;
}
.file-document-error {
	padding: 16px;
}
.file-document-frame {
	flex: 1;
	width: 100%;
	min-height: 0;
	border: 0;
	background: #fff;
}
</style>
