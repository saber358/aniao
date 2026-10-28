<script setup lang="ts">
import { computed } from "vue";
import type { UpdateState } from "../../shared/update.ts";
import { createLogger } from "../../shared/logger.ts";
import { UButton, UIcon } from "../ui.ts";

const props = defineProps<{
	state: UpdateState | null;
	pending: boolean;
	installing: boolean;
	error: string | null;
	dialog?: boolean;
}>();
const emit = defineEmits<{ check: []; download: []; install: [] }>();
const logger = createLogger("app-update-panel");
/*
 * ========================================================================
 * 步骤1：从共享快照派生更新面板
 * ========================================================================
 * 数据源：主进程更新状态和用户操作状态。
 * 操作：1) 按阶段展示按钮与版本；2) 打开面板不触发检查或下载。
 */
logger.info("开始绑定应用更新面板");
// 1.1 百分比向下取整，校验完成前不提前显示下载完成。
const progress = computed(() => Math.floor(props.state?.progress ?? 0));
const canDownload = computed(
	() => !!props.state?.availableVersion && ["available", "error"].includes(props.state.phase),
);
const checkDisabled = computed(
	() =>
		props.pending ||
		!props.state ||
		["disabled", "checking", "downloading", "downloaded"].includes(props.state.phase),
);
const message = computed(() => {
	if (!props.state) return "正在读取更新状态…";
	if (props.state.phase === "downloading") return `正在下载更新 · ${progress.value}%`;
	return props.state.message ?? "尚未检查更新";
});
logger.info("应用更新面板绑定结束");
</script>

<template>
	<section class="app-update-panel" :class="{ 'update-dialog-panel': dialog }" aria-label="应用更新">
		<div class="update-panel-content">
			<slot />
			<header v-if="!dialog" class="update-panel-header">
				<h2>应用更新</h2>
				<UIcon
					v-if="state?.phase === 'downloaded' || state?.message === '当前已是最新版本'"
					name="i-lucide-check"
					class="update-check"
					aria-hidden="true"
				/>
			</header>
			<dl v-if="!dialog" class="update-versions">
				<div>
					<dt>当前版本</dt>
					<dd>{{ state?.currentVersion ? `v${state.currentVersion}` : "读取中…" }}</dd>
				</div>
				<div v-if="state?.availableVersion">
					<dt>最新版本</dt>
					<dd class="new-version">v{{ state.availableVersion }}</dd>
				</div>
			</dl>
			<p v-else-if="state?.availableVersion" class="update-latest">最新版本 v{{ state.availableVersion }}</p>
			<p class="update-status" :class="{ failed: state?.phase === 'error' }" role="status">{{ message }}</p>
			<progress
				v-if="state?.phase === 'downloading'"
				class="update-progress"
				:value="progress"
				max="100"
				:aria-label="`更新下载进度 ${progress}%`"
			/>
			<p v-if="error" class="update-error" role="alert">{{ error }}</p>
			<details v-if="state?.releaseNotes" class="update-notes">
				<summary>更新说明</summary>
				<p>{{ state.releaseNotes }}</p>
			</details>
		</div>
		<div class="update-actions">
			<UButton
				v-if="canDownload"
				icon="i-lucide-download"
				color="neutral"
				size="sm"
				:disabled="pending"
				@click="emit('download')"
				>{{ state?.phase === "error" ? "重试下载" : "下载更新" }}</UButton
			>
			<UButton v-else-if="state?.phase === 'downloading'" color="neutral" size="sm" disabled
				>正在下载 {{ progress }}%</UButton
			>
			<UButton
				v-else-if="state?.phase === 'downloaded'"
				icon="i-lucide-refresh-cw"
				color="neutral"
				size="sm"
				:loading="installing"
				:disabled="pending"
				@click="emit('install')"
				>重启并安装</UButton
			>
			<UButton
				color="neutral"
				variant="outline"
				size="sm"
				:loading="state?.phase === 'checking'"
				:disabled="checkDisabled"
				@click="emit('check')"
				>检查更新</UButton
			>
			<slot name="confirm" />
		</div>
	</section>
</template>

<style scoped>
.app-update-panel {
	display: grid;
	gap: 14px;
	padding: 20px;
	border: 1px solid var(--line-soft);
	border-radius: 12px;
	background: var(--surface-raised);
}
.update-panel-content {
	display: grid;
	gap: 14px;
}
.update-panel-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.update-panel-header h2 {
	margin: 0;
	color: var(--ink);
	font-size: var(--settings-section-heading-size, 14px);
	font-weight: 600;
}
.update-check {
	color: var(--accent);
	font-size: 18px;
}
.update-versions {
	display: grid;
	gap: 9px;
	margin: 0;
	font-size: var(--settings-body-size, 12px);
}
.update-versions > div {
	display: flex;
	justify-content: space-between;
	gap: 16px;
}
.update-versions dt {
	color: var(--muted);
}
.update-versions dd {
	margin: 0;
	color: var(--ink);
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}
.update-versions .new-version {
	color: var(--accent);
	font-weight: 600;
}
.update-status,
.update-error,
.update-hint {
	margin: 0;
	font-size: var(--settings-body-size, 12px);
	line-height: 1.7;
	overflow-wrap: anywhere;
}
.update-status {
	color: var(--ink);
}
.update-status.failed,
.update-error {
	color: var(--ui-error);
}
.update-hint {
	color: var(--faint);
	font-size: var(--settings-caption-size, 11px);
}
.update-progress {
	width: 100%;
	height: 5px;
	overflow: hidden;
	border: 0;
	border-radius: 3px;
	background: var(--line-soft);
	accent-color: var(--accent);
}
.update-progress::-webkit-progress-bar {
	background: var(--line-soft);
}
.update-progress::-webkit-progress-value {
	border-radius: 3px;
	background: var(--accent);
}
.update-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}
.update-notes {
	border-top: 1px solid var(--line-soft);
	padding-top: 12px;
	color: var(--muted);
	font-size: var(--settings-caption-size, 11px);
}
.update-notes summary {
	cursor: pointer;
}
.update-notes p {
	max-height: 180px;
	overflow-y: auto;
	margin: 10px 0 0;
	line-height: 1.7;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.app-update-panel.update-dialog-panel {
	display: flex;
	flex: 1;
	flex-direction: column;
	min-height: 0;
	gap: 0;
	padding: 0;
	border: 0;
	border-radius: 0;
	background: var(--surface);
}
.update-dialog-panel .update-panel-content {
	flex: 1;
	min-height: 340px;
	align-content: start;
	justify-items: center;
	gap: 12px;
	overflow-y: auto;
	padding: 32px 36px 24px;
	text-align: center;
}
.update-dialog-panel .update-actions {
	flex: none;
	align-items: center;
	justify-content: flex-end;
	min-height: 64px;
	padding: 12px 18px;
	border-top: 1px solid var(--line-soft);
	background: var(--sidebar);
}
.update-latest {
	margin: 0;
	color: var(--accent);
	font-size: 13px;
}
.update-dialog-panel .update-notes {
	width: 100%;
	text-align: left;
}
.update-dialog-panel .update-progress {
	max-width: 280px;
}
</style>
