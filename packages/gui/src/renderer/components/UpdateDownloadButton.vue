<script setup lang="ts">
import { computed } from "vue";
import type { UpdateState } from "../../shared/update.ts";
import { createLogger } from "../../shared/logger.ts";
import { UIcon } from "../ui.ts";

const props = defineProps<{ state: UpdateState | null; pending: boolean }>();
const emit = defineEmits<{ download: []; details: [] }>();
const logger = createLogger("update-download-button");
/*
 * ========================================================================
 * 步骤1：按更新阶段展示侧栏下载入口
 * ========================================================================
 * 数据源：与设置、帮助共用的更新快照。
 * 操作：1) 有新版本时显示蓝色入口；2) 下载时替换为圆环与百分比。
 */
logger.info("开始绑定侧栏更新入口");
// 1.1 已下载时只打开安装选项，仍需用户确认重启。
const visible = computed(() => !!props.state?.availableVersion && props.state.phase !== "disabled");
const downloading = computed(() => props.state?.phase === "downloading");
const downloaded = computed(() => props.state?.phase === "downloaded");
const progress = computed(() => Math.floor(props.state?.progress ?? 0));
const label = computed(() => {
	if (downloading.value) return `正在下载更新 ${progress.value}%`;
	if (downloaded.value) return "更新已下载，查看安装选项";
	if (props.state?.phase === "checking") return "正在检查更新";
	return `${props.state?.phase === "error" ? "重试下载" : "下载更新"} v${props.state?.availableVersion}`;
});
logger.info("侧栏更新入口绑定结束");
</script>

<template>
	<div v-if="visible" class="update-download-slot">
		<div
			v-if="downloading"
			class="update-download-button is-progress"
			role="progressbar"
			:aria-label="label"
			:aria-valuenow="progress"
			:aria-valuemin="0"
			:aria-valuemax="100"
			:title="label"
		>
			<span class="download-disc">
				<svg class="download-ring" viewBox="0 0 32 32" aria-hidden="true">
					<circle class="download-track" cx="16" cy="16" r="13" />
					<circle cx="16" cy="16" r="13" pathLength="100" :stroke-dasharray="`${progress} 100`" />
				</svg>
				<span class="download-percent">{{ progress }}<small>%</small></span>
			</span>
		</div>
		<button
			v-else
			type="button"
			class="update-download-button"
			:aria-label="label"
			:title="label"
			:disabled="pending || state?.phase === 'checking'"
			@click="downloaded ? emit('details') : emit('download')"
		>
			<span class="download-disc"
				><UIcon :name="downloaded ? 'i-lucide-check' : 'i-lucide-download'" aria-hidden="true"
			/></span>
		</button>
	</div>
</template>

<style scoped>
.update-download-slot {
	display: flex;
	flex: none;
	align-items: center;
}
.update-download-slot .update-download-button {
	position: relative;
	display: grid;
	flex: none;
	width: 28px;
	height: 28px;
	place-items: center;
	border: 0;
	border-radius: 50%;
	padding: 0;
	background: transparent;
	color: #fff;
	cursor: pointer;
	font-size: 12px;
}
.download-disc {
	position: relative;
	display: grid;
	width: 20px;
	height: 20px;
	place-items: center;
	border-radius: 50%;
	background: var(--accent);
}
.update-download-button:hover:not(:disabled) .download-disc {
	background: var(--accent-hover);
}
.update-download-button:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 3px;
}
.update-download-button:disabled {
	cursor: wait;
	opacity: 0.65;
}
.update-download-button.is-progress {
	cursor: progress;
}
.download-ring {
	position: absolute;
	inset: 0;
	width: 20px;
	height: 20px;
	transform: rotate(-90deg);
}
.download-ring circle {
	fill: none;
	stroke: #fff;
	stroke-width: 1.5;
	stroke-linecap: round;
}
.download-ring .download-track {
	opacity: 0.25;
}
.download-percent {
	font-size: 7px;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
}
.download-percent small {
	font-size: 6px;
}
</style>
