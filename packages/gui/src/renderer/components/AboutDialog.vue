<script setup lang="ts">
import type { UpdateState } from "../../shared/update.ts";
import { createLogger } from "../../shared/logger.ts";
import { PRODUCT_NAME } from "../../shared/product.ts";
import { UButton, UIcon, UModal } from "../ui.ts";
import brandMark from "../assets/startup-terminal.svg";
import AppUpdatePanel from "./AppUpdatePanel.vue";

const logger = createLogger("about-dialog");
/*
 * ========================================================================
 * 步骤1：连接版本弹窗与共享更新面板
 * ========================================================================
 * 数据源：应用级更新快照，不依赖项目或模型连接。
 * 操作：1) 用居中品牌和版本信息呈现检查结果；2) 仅转发用户点击的更新操作。
 */
logger.info("开始绑定版本弹窗");
// 1.1 关闭弹窗不取消下载，重新打开仍读取同一个更新快照。
defineProps<{
	updateState: UpdateState | null;
	pending: boolean;
	installing: boolean;
	error: string | null;
}>();
const emit = defineEmits<{ "check-update": []; "download-update": []; "install-update": [] }>();
const open = defineModel<boolean>({ default: false });
logger.info("版本弹窗绑定结束");
</script>

<template>
	<UModal
		v-model:open="open"
		:title="`关于 ${PRODUCT_NAME}`"
		description="版本信息与应用更新"
		:ui="{ content: 'about-modal' }"
	>
		<template #content>
			<header class="about-header">
				<div>
					<UIcon name="i-lucide-terminal" aria-hidden="true" /><span>关于 {{ PRODUCT_NAME }}</span>
				</div>
				<UButton
					icon="i-lucide-x"
					color="neutral"
					variant="ghost"
					size="sm"
					aria-label="关闭版本信息"
					title="关闭版本信息"
					@click="open = false"
				/>
			</header>
			<AppUpdatePanel
				dialog
				:state="updateState"
				:pending="pending"
				:installing="installing"
				:error="error"
				@check="emit('check-update')"
				@download="emit('download-update')"
				@install="emit('install-update')"
			>
				<div class="about-brand">
					<img class="about-mark" :src="brandMark" width="72" height="72" alt="" />
					<h2>{{ PRODUCT_NAME }}</h2>
					<p>桌面客户端</p>
					<p class="about-version">版本 {{ updateState?.currentVersion ?? "读取中…" }}</p>
				</div>
				<template #confirm>
					<UButton color="neutral" variant="outline" size="sm" class="about-confirm" @click="open = false"
						>确定</UButton
					>
				</template>
			</AppUpdatePanel>
		</template>
	</UModal>
</template>

<style scoped>
:global(.about-modal) {
	width: min(520px, calc(100vw - 40px));
	max-width: 520px !important;
	max-height: calc(100vh - 48px);
	padding: 0 !important;
	overflow: hidden;
	border-radius: 12px;
	background: var(--surface);
}
.about-header {
	display: flex;
	flex: none;
	align-items: center;
	justify-content: space-between;
	height: 44px;
	padding: 0 8px 0 16px;
	border-bottom: 1px solid var(--line-soft);
	background: var(--sidebar);
}
.about-header > div {
	display: flex;
	align-items: center;
	gap: 8px;
	color: var(--ink);
	font-size: 13px;
}
.about-header > div > :first-child {
	font-size: 18px;
}
.about-brand {
	display: flex;
	flex-direction: column;
	align-items: center;
	min-height: 0;
	margin-bottom: 6px;
}
.about-mark {
	margin-bottom: 18px;
}
:global(.dark .about-mark) {
	filter: invert(1);
}
.about-brand h2 {
	margin: 0 0 22px;
	color: var(--ink);
	font-size: 22px;
	font-weight: 600;
	line-height: 1.4;
	letter-spacing: -0.03em;
}
.about-brand p {
	margin: 0;
	color: var(--muted);
	font-size: 13px;
	line-height: 1.8;
}
.about-version {
	font-variant-numeric: tabular-nums;
}
.about-confirm {
	justify-content: center;
	min-width: 84px;
}
</style>
