<script setup lang="ts">
import { PRODUCT_NAME } from "../../shared/product.ts";
import { UButton, UIcon } from "../ui.ts";

defineProps<{
	disabled: boolean;
	resourcesDisabled: boolean;
	automationDisabled: boolean;
	activePage: "plugins" | "automation" | null;
}>();
const emit = defineEmits<{
	create: [];
	openResources: [];
	openAutomation: [];
}>();
</script>

<template>
	<div class="sidebar-header">
		<div class="sidebar-brand" :aria-label="PRODUCT_NAME">
			<UIcon name="i-lucide-terminal" class="sidebar-brand-icon" aria-hidden="true" />
			<span class="sidebar-brand-name">Aniao</span>
			<span class="sidebar-brand-edition">Harness</span>
		</div>
		<UButton
			icon="i-lucide-message-circle-plus"
			color="neutral"
			variant="outline"
			class="new-thread"
			:disabled="disabled"
			@click="emit('create')"
			>新会话</UButton
		>
		<nav class="sidebar-navigation" aria-label="应用导航">
			<UButton
				icon="i-lucide-puzzle"
				color="neutral"
				variant="ghost"
				class="sidebar-nav-item"
				:class="{ active: activePage === 'plugins' }"
				title="查看当前会话加载的资源与扩展"
				:disabled="resourcesDisabled"
				@click="emit('openResources')"
				>插件</UButton
			>
			<span title="自动化任务">
				<UButton
					icon="i-lucide-clock"
					color="neutral"
					variant="ghost"
					class="sidebar-nav-item"
					:class="{ active: activePage === 'automation' }"
					:disabled="automationDisabled"
					@click="emit('openAutomation')"
					>自动化任务</UButton
				>
			</span>
		</nav>
	</div>
</template>

<style scoped>
.sidebar-header {
	flex: none;
	padding: 4px 0 22px;
}
.sidebar-brand {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	height: 34px;
	margin: 0 5px 20px;
	color: var(--ink);
}
.sidebar-brand-icon {
	width: 26px;
	height: 26px;
	flex: none;
}
.sidebar-brand-name {
	font-size: 23px;
	font-weight: 650;
	letter-spacing: -0.8px;
	line-height: 1;
}
.sidebar-brand-edition {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	height: 22px;
	min-width: 62px;
	flex: none;
	border-radius: 4px;
	padding: 0 7px;
	background: var(--ink);
	color: var(--sidebar);
	font-size: 10px;
	font-weight: 650;
	line-height: 1;
	letter-spacing: 0.55px;
	text-transform: uppercase;
}
.sidebar-header .new-thread {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	width: 100%;
	height: 38px;
	margin: 0 0 16px;
	padding: 0 12px;
	border: 1px solid var(--line);
	border-radius: 12px;
	background: var(--composer);
	box-shadow: none;
	color: var(--ink);
	font-size: 15px;
	font-weight: 400;
	transition: background-color 120ms ease;
}
.sidebar-header .new-thread:hover:not(:disabled) {
	background: var(--hover);
}
.sidebar-header .new-thread svg {
	width: 13px;
	height: 13px;
}
.sidebar-navigation {
	display: grid;
	gap: 3px;
}
.sidebar-nav-item {
	justify-content: flex-start;
	gap: 11px;
	width: 100%;
	height: 40px;
	padding: 0 8px;
	border-radius: 9px;
	color: var(--ink);
	font-size: 13px;
	font-weight: 400;
}
.sidebar-nav-item svg {
	width: 15px;
	height: 15px;
}
.sidebar-nav-item:disabled {
	opacity: 0.6;
}
.sidebar-nav-item.active {
	background: var(--active);
	color: var(--ink);
}
@media (prefers-reduced-motion: reduce) {
	.sidebar-header .new-thread {
		transition: none;
	}
}
</style>
