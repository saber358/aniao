<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SubagentSnapshot } from "../../shared/subagents.ts";
import { PROJECT_IMAGE_PATTERN } from "../../shared/project-browser.ts";
import { UButton, UIcon } from "../ui.ts";
import { createLogger } from "../../shared/logger.ts";
import BrowserPane from "./BrowserPane.vue";
import EngineeringPanel from "./EngineeringPanel.vue";
import FilePreview from "./FilePreview.vue";
import SubagentDetail from "./SubagentDetail.vue";
import TerminalPanel from "./TerminalPanel.vue";
import WorkspaceFiles from "./WorkspaceFiles.vue";

type SideTool = "start" | "files" | "terminal" | "browser" | "changes" | "file" | "subagent";

interface SideTab {
	id: string;
	type: SideTool;
	path?: string;
	url?: string;
	file?: string;
	runId?: string;
	childId?: string;
	browserId?: string;
}

const MIN_WIDTH = 360;
const MAX_WIDTH = 900;
const WIDTH_KEY = "pi-gui-side-panel-width";
const props = defineProps<{ cwd: string; sessionKey: string; active: boolean; subagents?: SubagentSnapshot | null }>();
const emit = defineEmits<{ close: []; review: [text: string]; "open-worktree": [cwd: string] }>();
const logger = createLogger("side-panel");
const tabs = ref<SideTab[]>([{ id: "1", type: "start" }]);
const activeId = ref<string | null>("1");
const groups = ref([{ key: props.sessionKey, cwd: props.cwd, tabs: tabs.value, activeId: "1" as string | null }]);
watch(
	() => props.sessionKey,
	(current, previous) => {
		const old = groups.value.find((group) => group.key === previous);
		if (old) old.activeId = activeId.value;
		let group = groups.value.find((group) => group.key === current);
		if (!group) {
			group = { key: current, cwd: props.cwd, tabs: [{ id: String(nextId++), type: "start" }], activeId: null };
			group.activeId = group.tabs[0].id;
			groups.value.push(group);
		}
		tabs.value = group.tabs;
		activeId.value = group.activeId;
	},
);
const maximized = ref(false);
const panelRef = ref<HTMLElement | null>(null);
const maxWidth = ref(MAX_WIDTH);
const storedWidth = Number(localStorage.getItem(WIDTH_KEY));
const width = ref(Number.isFinite(storedWidth) && storedWidth >= MIN_WIDTH ? Math.min(storedWidth, MAX_WIDTH) : 560);
let nextId = 2;
let workspaceResizeObserver: ResizeObserver | undefined;
let drag: { pointerId: number; startX: number; startWidth: number; target: HTMLElement } | null = null;

const panelStyle = computed(() =>
	maximized.value ? {} : { width: `${width.value}px`, flexBasis: `${width.value}px` },
);

function availableWidth(): number {
	const parentWidth = panelRef.value?.parentElement?.clientWidth ?? window.innerWidth;
	return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parentWidth - 320));
}

function clampWidth(value: number): number {
	return Math.min(maxWidth.value, Math.max(MIN_WIDTH, Math.round(value)));
}

function persistWidth(): void {
	localStorage.setItem(WIDTH_KEY, String(width.value));
}

/*
 * ========================================================================
 * 步骤2：调整原生网页面板宽度
 * ========================================================================
 * 数据源：分界线指针位置与已保存宽度。
 * 操作：1) 拖拽期间隐藏网页并捕获指针；2) 结束时释放监听并保存宽度。
 */
function startResize(event: PointerEvent): void {
	if (maximized.value || event.button !== 0) return;
	logger.info("开始调整右侧面板宽度");
	event.preventDefault();
	maxWidth.value = availableWidth();
	// 2.1 原生网页暂时让出指针区域，捕获指针后跨越分界线仍能结束拖拽。
	const target = event.currentTarget as HTMLElement;
	target.setPointerCapture(event.pointerId);
	drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width.value, target };
	document.body.classList.add("resizing-side-panel");
	window.addEventListener("pointermove", moveResize);
	window.addEventListener("pointerup", stopResize);
	window.addEventListener("pointercancel", stopResize);
}

function moveResize(event: PointerEvent): void {
	if (!drag) return;
	width.value = clampWidth(drag.startWidth + drag.startX - event.clientX);
}

function stopResize(): void {
	if (!drag) return;
	if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
	drag = null;
	document.body.classList.remove("resizing-side-panel");
	window.removeEventListener("pointermove", moveResize);
	window.removeEventListener("pointerup", stopResize);
	window.removeEventListener("pointercancel", stopResize);
	persistWidth();
	logger.info("右侧面板宽度调整结束");
}

function resizeWithKey(event: KeyboardEvent): void {
	if (maximized.value) return;
	maxWidth.value = availableWidth();
	if (event.key === "ArrowLeft") width.value = clampWidth(width.value + 24);
	else if (event.key === "ArrowRight") width.value = clampWidth(width.value - 24);
	else if (event.key === "Home") width.value = MIN_WIDTH;
	else if (event.key === "End") width.value = maxWidth.value;
	else return;
	event.preventDefault();
	persistWidth();
}

function clampToWindow(): void {
	// 3.2 设置页会隐藏主区，零宽度不代表用户把面板缩到了最小。
	if (panelRef.value?.parentElement?.clientWidth === 0) return;
	maxWidth.value = availableWidth();
	if (width.value > maxWidth.value) {
		width.value = maxWidth.value;
		persistWidth();
	}
}

onMounted(() => {
	/*
	 * ========================================================================
	 * 步骤3：随工作区可用宽度约束右栏
	 * ========================================================================
	 * 数据源：主区实际边界，不只读取整个窗口。
	 * 操作：1) 左栏拖动时重新计算右栏上限；2) 保留至少 320 px 对话区域。
	 */
	logger.info("开始绑定工作区尺寸变化");
	clampToWindow();
	// 3.1 左栏改变宽度不会触发 window.resize，需要观察右栏父容器。
	workspaceResizeObserver = new ResizeObserver(clampToWindow);
	if (panelRef.value?.parentElement) workspaceResizeObserver.observe(panelRef.value.parentElement);
	window.addEventListener("resize", clampToWindow);
	logger.info("工作区尺寸变化绑定结束");
});
onBeforeUnmount(() => {
	stopResize();
	workspaceResizeObserver?.disconnect();
	window.removeEventListener("resize", clampToWindow);
});
const tools: Array<{ type: SideTool; title: string; note: string; icon: string; shortcut: string }> = [
	{
		type: "changes",
		title: "变更",
		note: "查看文件差异、暂存改动与工作树",
		icon: "i-lucide-git-branch",
		shortcut: "",
	},
	{
		type: "files",
		title: "工作区文件",
		note: "浏览会话工作区的文件",
		icon: "i-lucide-folder-open",
		shortcut: "Ctrl P",
	},
	{
		type: "terminal",
		title: "新建终端",
		note: "在会话工作区运行命令",
		icon: "i-lucide-terminal",
		shortcut: "Ctrl `",
	},
	{
		type: "browser",
		title: "浏览器",
		note: "浏览网页与本地开发页面",
		icon: "i-lucide-globe",
		shortcut: "Ctrl T",
	},
];

function title(tab: SideTab): string {
	if (tab.type === "start") return "开始";
	if (tab.type === "changes") return "变更";
	if (tab.type === "terminal") return "终端";
	if (tab.type === "browser") return "浏览器";
	if (tab.type === "subagent") return "子智能体";
	if (tab.type === "file") return tab.path?.split("/").at(-1) ?? "文件";
	return "文件";
}

function icon(tab: SideTab): string {
	if (tab.type === "start") return "i-lucide-compass";
	if (tab.type === "changes") return "i-lucide-git-branch";
	if (tab.type === "terminal") return "i-lucide-terminal";
	if (tab.type === "browser") return "i-lucide-globe";
	if (tab.type === "subagent") return "i-lucide-bot";
	if (tab.type === "file") return PROJECT_IMAGE_PATTERN.test(tab.path ?? "") ? "i-lucide-image" : "i-lucide-file-text";
	return "i-lucide-file-text";
}

/*
 * ========================================================================
 * 步骤1：复用右侧工具标签与变更状态
 * ========================================================================
 * 数据源：当前工作区的工具类型与现有标签。
 * 操作：1) 每次打开都创建独立标签；2) 切换标签保留变更选择、评论和终端。
 */
function openTool(type: SideTool): void {
	logger.info("开始激活右侧工具标签");
	try {
		if (type === "start") {
			openStart();
			return;
		}
		const tab = { id: String(nextId++), type, ...(type === "browser" ? { browserId: crypto.randomUUID() } : {}) };
		tabs.value.push(tab);
		activeId.value = tab.id;
	} finally {
		logger.info("右侧工具标签激活结束");
	}
}

function openStart(): void {
	const tab: SideTab = { id: String(nextId++), type: "start" };
	tabs.value.push(tab);
	activeId.value = tab.id;
}

function openSubagent(runId: string, childId?: string): void {
	const existing = tabs.value.find((tab) => tab.type === "subagent" && tab.runId === runId && tab.childId === childId);
	if (existing) {
		activeId.value = existing.id;
		return;
	}
	const tab: SideTab = { id: String(nextId++), type: "subagent", runId, ...(childId ? { childId } : {}) };
	tabs.value.push(tab);
	activeId.value = tab.id;
}

function openFile(path: string): void {
	const existing = tabs.value.find((tab) => tab.type === "file" && tab.path === path);
	if (existing) {
		activeId.value = existing.id;
		return;
	}
	const tab: SideTab = { id: String(nextId++), type: "file", path };
	tabs.value.push(tab);
	activeId.value = tab.id;
}

function openUrl(url: string): void {
	const tab: SideTab = { id: String(nextId++), type: "browser", url, browserId: crypto.randomUUID() };
	tabs.value.push(tab);
	activeId.value = tab.id;
}

/*
 * ========================================================================
 * 步骤4：展示模型绑定的真实浏览器标签
 * ========================================================================
 * 数据源：主进程核对后的标签 UUID，不由网页请求创建工作台工具。
 * 操作：1) 复用已有网页身份；2) 模型关闭时同步移除对应标签。
 */
function openAgentBrowser(id: string, closed = false): void {
	logger.info("开始同步模型浏览器标签");
	try {
		const existing = tabs.value.find((tab) => tab.browserId === id);
		if (closed) {
			if (existing) closeTab(existing.id);
			return;
		}
		if (existing) {
			activeId.value = existing.id;
			return;
		}
		const tab: SideTab = { id: String(nextId++), type: "browser", browserId: id };
		tabs.value.push(tab);
		activeId.value = tab.id;
	} finally {
		logger.info("模型浏览器标签同步结束");
	}
}

function openHtmlFile(path: string): void {
	const existing = tabs.value.find((tab) => tab.type === "browser" && tab.file === path);
	if (existing) {
		activeId.value = existing.id;
		return;
	}
	const tab: SideTab = { id: String(nextId++), type: "browser", file: path, browserId: crypto.randomUUID() };
	tabs.value.push(tab);
	activeId.value = tab.id;
}

function closeTab(id: string): void {
	const index = tabs.value.findIndex((tab) => tab.id === id);
	if (index < 0) return;
	tabs.value.splice(index, 1);
	if (tabs.value.length === 0) {
		const tab: SideTab = { id: String(nextId++), type: "start" };
		tabs.value.push(tab);
		activeId.value = tab.id;
		return;
	}
	if (activeId.value === id) activeId.value = tabs.value[Math.max(0, index - 1)]?.id ?? tabs.value[0].id;
}

defineExpose({ openTool, openFile, openUrl, openHtmlFile, openStart, openSubagent, openAgentBrowser });
</script>

<template>
	<aside ref="panelRef" class="side-panel" :class="{ maximized }" :style="panelStyle">
		<div
			v-if="!maximized"
			class="side-resizer"
			role="separator"
			aria-orientation="vertical"
			aria-label="调整右侧面板宽度"
			:aria-valuemin="MIN_WIDTH"
			:aria-valuemax="maxWidth"
			:aria-valuenow="width"
			tabindex="0"
			@pointerdown="startResize"
			@keydown="resizeWithKey"
		></div>
		<header class="side-header">
			<div class="side-tabs" role="tablist" aria-label="右侧面板">
				<button
					v-for="tab in tabs"
					:key="tab.id"
					type="button"
					class="side-tab"
					:class="{ active: activeId === tab.id }"
					role="tab"
					:aria-selected="activeId === tab.id"
					@click="activeId = tab.id"
				>
					<UIcon :name="icon(tab)" aria-hidden="true" />
					<span>{{ title(tab) }}</span>
					<span class="side-tab-close" role="button" tabindex="0" @click.stop="closeTab(tab.id)">×</span>
				</button>
				<button type="button" class="side-tab-add" aria-label="打开开始页" @click="openStart">+</button>
			</div>
			<div class="side-controls">
				<UButton
					:icon="maximized ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
					color="neutral"
					variant="ghost"
					size="xs"
					:aria-label="maximized ? '还原面板宽度' : '放大面板'"
					:title="maximized ? '还原面板宽度' : '放大面板'"
					@click="maximized = !maximized"
				/>
				<UButton
					icon="i-lucide-panel-right"
					color="neutral"
					variant="ghost"
					size="xs"
					aria-label="关闭右侧面板"
					title="关闭右侧面板"
					@click="emit('close')"
				/>
			</div>
		</header>

		<div class="side-body">
			<template v-for="group in groups" :key="group.key">
				<template v-for="tab in group.tabs" :key="tab.id">
					<div v-show="group.key === props.sessionKey && tab.id === activeId" class="side-view">
						<div v-if="tab.type === 'start'" class="side-start">
							<div class="side-start-mark" aria-hidden="true">
								<UIcon name="i-lucide-compass" />
							</div>
							<button
								v-for="tool in tools"
								:key="tool.type"
								type="button"
								class="side-tool"
								@click="openTool(tool.type)"
							>
								<span class="side-tool-icon"><UIcon :name="tool.icon" aria-hidden="true" /></span>
								<span class="side-tool-copy">
									<strong>{{ tool.title }}</strong>
									<small>{{ tool.note }}</small>
								</span>
								<kbd v-if="tool.shortcut">{{ tool.shortcut }}</kbd>
							</button>
						</div>
						<EngineeringPanel
							v-else-if="tab.type === 'changes'"
							:cwd="group.cwd"
							@review="emit('review', $event)"
							@open-worktree="emit('open-worktree', $event)"
						/>
						<TerminalPanel v-else-if="tab.type === 'terminal'" :cwd="group.cwd" :with-header="false" />
						<WorkspaceFiles v-else-if="tab.type === 'files'" :cwd="group.cwd" @open="openFile" />
						<FilePreview v-else-if="tab.type === 'file' && tab.path" :cwd="group.cwd" :path="tab.path" />
						<SubagentDetail
							v-else-if="tab.type === 'subagent'"
							:snapshot="props.subagents ?? null"
							:run-id="tab.runId ?? ''"
							:child-id="tab.childId"
						/>
						<BrowserPane
							v-else
							:active="props.active && group.key === props.sessionKey && tab.id === activeId"
							:cwd="group.cwd"
							:initial-url="tab.url"
							:initial-file="tab.file"
							:browser-id="tab.browserId"
						/>
					</div>
				</template>
			</template>
		</div>
	</aside>
</template>
