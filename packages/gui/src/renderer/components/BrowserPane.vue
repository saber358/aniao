<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
	type BrowserAction,
	type BrowserLayout,
	type BrowserState,
	normalizeBrowserUrl,
} from "../../shared/browser.ts";
import { createLogger } from "../../shared/logger.ts";
import { UButton, UIcon } from "../ui.ts";

const props = defineProps<{
	active: boolean;
	cwd?: string;
	initialUrl?: string;
	initialFile?: string;
	browserId?: string;
}>();
const bridge = window.piDesktop;
const logger = createLogger("browser-pane");
const id = props.browserId ?? crypto.randomUUID();
const address = ref("");
const addressFocused = ref(false);
const addressDirty = ref(false);
const error = ref("");
const initialized = ref(false);
const obscured = ref(false);
const viewport = ref<HTMLElement | null>(null);
const state = ref<BrowserState>({
	id,
	url: "",
	title: "",
	loading: false,
	canGoBack: false,
	canGoForward: false,
	error: null,
	notice: null,
});
const securityLabel = computed(() => {
	if (state.value.url.startsWith("file:")) return "本地文件";
	return state.value.url.startsWith("https:") ? "HTTPS 连接" : "HTTP 连接";
});
let alive = true;
let frame = 0;
let lastLayout = "";
let unsubscribe: (() => void) | undefined;
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;

/*
 * ========================================================================
 * 步骤1：连接隔离网页状态并保持地址栏草稿
 * ========================================================================
 * 数据源：主进程浏览器事件与当前标签身份。
 * 操作：1) 先订阅再创建；2) 导航事件不覆盖用户正在输入的网址。
 */
function receive(next: BrowserState): void {
	if (!alive || next.id !== id) return;
	// 1.1 地址栏正在编辑时保留输入，网页跳转仍同步标题和历史。
	state.value = next;
	if (!addressFocused.value || !addressDirty.value) address.value = next.url;
	scheduleLayout();
}

onMounted(async () => {
	logger.info("开始连接内置浏览器面板");
	try {
		unsubscribe = bridge.subscribeBrowser(receive);
		const initial = await bridge.browserCreate(id);
		if (!alive) {
			bridge.browserClose(id);
			return;
		}
		receive(initial);
		initialized.value = true;
		if (props.initialFile && props.cwd) {
			await bridge.browserNavigateFile({ id, cwd: props.cwd, path: props.initialFile });
		} else if (props.initialUrl) {
			address.value = props.initialUrl;
			await bridge.browserNavigate({ id, url: props.initialUrl });
		}
		// 1.2 原生视图跟随占位区域，并在 DOM 弹窗出现时让出显示位置。
		resizeObserver = new ResizeObserver(scheduleLayout);
		if (viewport.value) resizeObserver.observe(viewport.value);
		mutationObserver = new MutationObserver(scheduleLayout);
		mutationObserver.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-state", "style", "class", "hidden", "open"],
		});
		window.addEventListener("resize", scheduleLayout);
		window.addEventListener("scroll", scheduleLayout, true);
		document.addEventListener("visibilitychange", scheduleLayout);
		scheduleLayout();
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : "浏览器初始化失败";
	} finally {
		logger.info("内置浏览器面板连接结束");
	}
});

/*
 * ========================================================================
 * 步骤2：提交地址与固定浏览动作
 * ========================================================================
 * 数据源：用户点击或地址栏回车。
 * 操作：1) 本地地址自动补 HTTP；2) 系统浏览器仅在用户点击时打开。
 */
async function navigate(): Promise<void> {
	if (!initialized.value) return;
	logger.info("开始提交网页地址");
	error.value = "";
	try {
		// 2.1 前后端分别校验网址，错误输入保留在地址栏供修改。
		const url = normalizeBrowserUrl(address.value);
		address.value = url;
		addressDirty.value = false;
		await bridge.browserNavigate({ id, url });
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : "无法打开网页";
	} finally {
		logger.info("网页地址提交结束");
	}
}

async function act(action: BrowserAction["action"]): Promise<void> {
	logger.info("开始提交网页浏览操作");
	error.value = "";
	try {
		// 2.2 刷新和历史操作使用已加载的地址，不采用未提交输入。
		addressDirty.value = false;
		await bridge.browserAction({ id, action });
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : "浏览操作失败";
	} finally {
		logger.info("网页浏览操作提交结束");
	}
}

async function openExternal(): Promise<void> {
	logger.info("开始在系统浏览器打开网页");
	try {
		await bridge.openExternal(normalizeBrowserUrl(state.value.url));
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : "无法打开系统浏览器";
	} finally {
		logger.info("系统浏览器打开请求结束");
	}
}

/*
 * ========================================================================
 * 步骤3：同步可见区域并让出弹窗层级
 * ========================================================================
 * 数据源：当前标签、占位区域、可见弹窗和下拉菜单。
 * 操作：1) 合并同帧布局变化；2) 隐藏保留网页，卸载关闭网页进程。
 */
function scheduleLayout(): void {
	if (!alive || frame) return;
	frame = requestAnimationFrame(syncLayout);
}

function syncLayout(): void {
	frame = 0;
	if (!alive || !initialized.value || !viewport.value) return;
	// 3.1 原生网页不参与 DOM 层叠，弹窗和菜单显示期间必须主动隐藏。
	const blockers = document.querySelectorAll<HTMLElement>(
		'[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
	);
	obscured.value = Array.from(blockers).some(
		(element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
	);
	const rect = viewport.value.getBoundingClientRect();
	const layout: BrowserLayout = {
		id,
		visible:
			props.active &&
			!obscured.value &&
			!document.hidden &&
			!document.body.classList.contains("resizing-side-panel") &&
			rect.width > 0 &&
			rect.height > 0,
		x: Math.max(0, rect.x),
		y: Math.max(0, rect.y),
		width: Math.max(0, Math.min(rect.right, innerWidth) - Math.max(0, rect.x)),
		height: Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(0, rect.y)),
	};
	const serialized = JSON.stringify(layout);
	if (serialized === lastLayout) return;
	lastLayout = serialized;
	bridge.browserLayout(layout);
}

watch(
	() => props.active,
	() => void nextTick(scheduleLayout),
);
onBeforeUnmount(() => {
	logger.info("开始释放内置浏览器面板");
	// 3.2 旧标签的迟到事件按身份丢弃，不能关闭重新打开的网页。
	alive = false;
	cancelAnimationFrame(frame);
	unsubscribe?.();
	resizeObserver?.disconnect();
	mutationObserver?.disconnect();
	window.removeEventListener("resize", scheduleLayout);
	window.removeEventListener("scroll", scheduleLayout, true);
	document.removeEventListener("visibilitychange", scheduleLayout);
	bridge.browserClose(id);
	logger.info("内置浏览器面板释放结束");
});
</script>

<template>
	<div class="browser-panel">
		<form class="browser-form" @submit.prevent="navigate">
			<UButton
				icon="i-lucide-arrow-left"
				color="neutral"
				variant="ghost"
				size="xs"
				aria-label="网页后退"
				title="后退"
				:disabled="!state.canGoBack"
				@click="act('back')"
			/>
			<UButton
				icon="i-lucide-arrow-right"
				color="neutral"
				variant="ghost"
				size="xs"
				aria-label="网页前进"
				title="前进"
				:disabled="!state.canGoForward"
				@click="act('forward')"
			/>
			<UButton
				:icon="state.loading ? 'i-lucide-x' : 'i-lucide-rotate-cw'"
				color="neutral"
				variant="ghost"
				size="xs"
				:aria-label="state.loading ? '停止加载网页' : '刷新网页'"
				:title="state.loading ? '停止加载' : '刷新'"
				:disabled="!state.url"
				@click="act(state.loading ? 'stop' : 'reload')"
			/>
			<input
				v-model="address"
				aria-label="网址"
				placeholder="输入网址或 localhost:5173"
				spellcheck="false"
				autocomplete="off"
				:disabled="!initialized"
				@focus="addressFocused = true"
				@blur="addressFocused = false"
				@input="addressDirty = true"
			/>
			<UButton
				type="submit"
				icon="i-lucide-arrow-up-right"
				color="neutral"
				variant="ghost"
				size="xs"
				aria-label="打开网页"
				title="打开网页"
				:disabled="!initialized || !address.trim()"
			/>
			<UButton
				icon="i-lucide-external-link"
				color="neutral"
				variant="ghost"
				size="xs"
				aria-label="在系统浏览器打开"
				title="在系统浏览器打开"
				:disabled="!state.url"
				@click="openExternal"
			/>
		</form>
		<div v-if="state.url" class="browser-page-info" aria-live="polite">
			<UIcon
				:name="
					state.loading
						? 'i-lucide-loader-circle'
						: state.url.startsWith('https:')
							? 'i-lucide-lock-keyhole'
							: 'i-lucide-globe'
				"
				:class="{ 'browser-loading-icon': state.loading }"
				:title="securityLabel"
				aria-hidden="true"
			/>
			<span :title="state.url">{{ state.loading ? "正在加载…" : state.title || state.url }}</span>
		</div>
		<p v-if="error || state.notice" class="side-error" role="alert">{{ error || state.notice }}</p>
		<div ref="viewport" class="browser-viewport" role="region" aria-label="内置网页" :aria-busy="state.loading">
			<div v-if="state.error" class="browser-empty" role="alert">
				<UIcon name="i-lucide-wifi-off" class="browser-symbol" aria-hidden="true" />
				<strong>无法显示网页</strong>
				<p>{{ state.error }}</p>
				<UButton color="neutral" variant="soft" size="sm" @click="act('reload')">重新加载</UButton>
			</div>
			<div v-else-if="!state.url" class="browser-empty">
				<UIcon name="i-lucide-globe" class="browser-symbol" aria-hidden="true" />
				<strong>在这里浏览网页</strong>
				<p>输入网站地址，或打开本地开发服务。</p>
				<small>例如 localhost:5173</small>
			</div>
			<div v-else class="browser-empty" aria-hidden="true">
				<p>{{ obscured ? "关闭弹窗后继续浏览" : state.loading ? "正在加载网页…" : "网页已在此处打开" }}</p>
			</div>
		</div>
	</div>
</template>
