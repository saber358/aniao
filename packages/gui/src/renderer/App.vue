<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import { zh_cn } from "@nuxt/ui/locale";
import { isTaskRunning, type ThinkingLevel } from "../shared/protocol.ts";
import type { ParallelJob } from "../shared/parallel.ts";
import type { CustomProviderInput } from "../shared/provider.ts";
import type { UpdateState } from "../shared/update.ts";
import { createLogger } from "../shared/logger.ts";
import { queueTexts } from "../domain/queue-view.ts";
import { resolveAppAction } from "../domain/app-keybindings.ts";
import { useWorkspace } from "./composables/use-workspace.ts";
import { UApp, UButton, UChatPrompt, UDropdownMenu, UIcon, USplitter } from "./ui.ts";
import ConversationPane from "./components/ConversationPane.vue";
import FeedbackDialog from "./components/FeedbackDialog.vue";
import GoalBar from "./components/GoalBar.vue";
import EditMenu from "./components/EditMenu.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import SessionSidebar from "./components/SessionSidebar.vue";
import ModelPicker from "./components/ModelPicker.vue";
import ContextUsageRing from "./components/ContextUsageRing.vue";
import SidePanel from "./components/SidePanel.vue";
import TaskQueue from "./components/TaskQueue.vue";
import ImageAttachment from "./components/ImageAttachment.vue";
import ImageInputZone from "./components/ImageInputZone.vue";
import ProjectFileSearch from "./components/ProjectFileSearch.vue";
import ComposerFileCompletion from "./components/ComposerFileCompletion.vue";
import ComposerCommandMenu from "./components/ComposerCommandMenu.vue";
import ComposerReferenceLayer from "./components/ComposerReferenceLayer.vue";
import PluginsPage from "./components/PluginsPage.vue";
import AutomationPage from "./components/AutomationPage.vue";
import ParallelTasksDialog from "./components/ParallelTasksDialog.vue";
import InteractionDialog from "./components/InteractionDialog.vue";
import ExtensionPanel from "./components/ExtensionPanel.vue";
import OAuthProgress from "./components/OAuthProgress.vue";
import PlanCard from "./components/PlanCard.vue";
import AboutDialog from "./components/AboutDialog.vue";
import UpdateDownloadButton from "./components/UpdateDownloadButton.vue";

const {
	state,
	controller,
	changing,
	actionError,
	changeProject,
	library,
	projects,
	sessionRuntimes,
	refreshLibrary,
	openWorkspace,
	newSessionAt,
	renameWorkspace,
	removeWorkspace,
	openSession,
	openSessionAt,
	forkSession,
	updateSession,
} = useWorkspace();
const logger = createLogger("workspace-actions");
const bridge = window.piDesktop;
const settingsOpen = ref(false);
const feedbackOpen = ref(false);
const updateDialogOpen = ref(false);
const parallelOpen = ref(false);
const updateState = ref<UpdateState | null>(null);
const updateAction = ref<"check" | "download" | "install" | null>(null);
const updateError = ref<string | null>(null);
let unsubscribeUpdate: (() => void) | undefined;
const sidebarOpen = ref(true);
const sidebarWidth = ref(280);
const sidePanelOpen = ref(false);
const viewMode = ref<"app" | "plugins" | "automation">("app");
const workspaceSplitter = useTemplateRef<{
	$el: HTMLElement;
	panelsRef: { resize(size: number): void }[];
}>("workspaceSplitter");
let workspaceResizeObserver: ResizeObserver | undefined;
let workspaceWasHidden = false;
const splitterItems = computed(() => [
	{
		id: "workspace-sidebar",
		slot: "sidebar",
		order: 0,
		sizeUnit: "px" as const,
		defaultSize: sidebarOpen.value ? sidebarWidth.value : 0,
		minSize: sidebarOpen.value ? 240 : 0,
		maxSize: sidebarOpen.value ? 380 : 0,
	},
	// 主区吸收剩余空间；1100 px 最小窗口与侧栏 380 px 上限保证主区至少 712 px。
	{ id: "workspace-main", slot: "main", order: 1 },
]);

/*
 * ========================================================================
 * 步骤7：保持左侧栏顺序、宽度与拖拽状态
 * ========================================================================
 * 数据源：分栏组件的像素尺寸与窗口实际宽度。
 * 操作：1) 保留面板和分隔条，收起只归零宽度；2) 主区吸收窗口变化，网页让出拖拽区域。
 */
function rememberSidebarWidth(index: number, size: number): void {
	// 7.1 主区使用百分比，只有左侧栏像素尺寸可成为重新展开的默认值。
	if (sidebarOpen.value && index === 0 && Number.isFinite(size))
		sidebarWidth.value = Math.min(380, Math.max(240, size));
}
function setSidebarDragging(index: number, dragging: boolean): void {
	if (index !== 0) return;
	if (dragging) logger.info("开始调整左侧栏宽度");
	// 7.2 复用侧面板拖拽标记，避免原生网页截走鼠标移动或松开事件。
	document.body.classList.toggle("resizing-side-panel", dragging);
	if (!dragging) logger.info("左侧栏宽度调整结束");
}
function restoreSidebarOnReveal(entries: ResizeObserverEntry[]): void {
	const current = entries[0];
	if (!current) return;
	if (current.contentRect.width === 0) {
		workspaceWasHidden = true;
		return;
	}
	if (!workspaceWasHidden) return;
	workspaceWasHidden = false;
	logger.info("开始恢复左侧栏像素宽度");
	try {
		// 7.3 设置页隐藏期间窗口仍可缩放，重新显示前恢复既有像素尺寸。
		if (sidebarOpen.value) workspaceSplitter.value?.panelsRef[0]?.resize(sidebarWidth.value);
	} finally {
		logger.info("左侧栏像素宽度恢复结束");
	}
}
const saving = ref(false);
const planMode = ref(false);
const composer = useTemplateRef("composer");
const fileCompletion = useTemplateRef("fileCompletion");
const modelPicker = useTemplateRef<{ openPicker(): void }>("modelPicker");
const sidePanel = useTemplateRef<{
	openTool(type: "files" | "terminal" | "browser" | "changes"): void;
	openFile(path: string): void;
	openUrl(url: string): void;
	openHtmlFile(path: string): void;
	openSubagent(runId: string, childId?: string): void;
}>("sidePanel");
const dark = ref(document.documentElement.classList.contains("dark"));
const snapshot = computed(() => state.value.snapshot);
const extensionState = computed(() => {
	const extensions = snapshot.value?.extensions;
	if (!extensions) return undefined;
	// Goal 由原生看板展示；隐藏插件自己的 goal 状态条、文本组件和 TUI 仪表盘通知。
	return {
		...extensions,
		notices: extensions.notices.filter((notice) => !isGoalDashboardNotice(notice.message)),
		statuses: extensions.statuses.filter((status) => status.key !== "goal"),
		widgets: extensions.widgets.filter((widget) => widget.key !== "goal"),
	};
});
function isGoalDashboardNotice(message: string): boolean {
	const text = message.trim();
	// Goal 的生命周期提示统一由原生看板展示，不再重复显示插件的 TUI 通知。
	return /^(?:[●○]\s*)?Goal\b/u.test(text);
}
const plan = computed(() => snapshot.value?.plan);
const planAwaiting = computed(() => plan.value?.phase === "awaiting" || plan.value?.phase === "interrupted");
const planActive = computed(
	() => plan.value?.phase === "drafting" || planAwaiting.value || plan.value?.phase === "executing",
);
const planToggleDisabled = computed(
	() => !snapshot.value || planActive.value || busy.value || changing.value || state.value.connection !== "connected",
);
watch(planActive, (active) => {
	if (active) planMode.value = false;
});
watch(snapshot, (value) => {
	if (!value) {
		viewMode.value = "app";
		sidePanelOpen.value = false;
		planMode.value = false;
	}
});
watch(viewMode, (value) => {
	if (value !== "app") sidePanelOpen.value = false;
});
watch(
	() => snapshot.value?.sessionId,
	() => {
		planMode.value = false;
		sidePanelOpen.value = false;
	},
);
const busy = computed(
	() =>
		state.value.connection === "connected" &&
		(state.value.submitting ||
			snapshot.value?.authentication.flow?.phase === "working" ||
			!!snapshot.value?.dialogs.length ||
			state.value.queueBusy ||
			state.value.selectingFiles ||
			(!!snapshot.value && snapshot.value.run.phase !== "idle")),
);
const canEnqueue = computed(
	() =>
		snapshot.value?.run.phase === "working" &&
		!snapshot.value.dialogs.length &&
		state.value.connection === "connected" &&
		!changing.value &&
		!state.value.submitting &&
		!state.value.selectingFiles &&
		!state.value.queueBusy,
);
const hasQueue = computed(() => !!snapshot.value && queueTexts(snapshot.value.queue).length > 0);
const canAttachImages = computed(
	() =>
		!!snapshot.value?.configuration.model?.supportsImages &&
		!snapshot.value.dialogs.length &&
		snapshot.value.authentication.flow?.phase !== "working" &&
		["idle", "working"].includes(snapshot.value.run.phase) &&
		!state.value.submitting &&
		!state.value.queueBusy &&
		!state.value.selectingFiles,
);
const draft = computed({ get: () => state.value.draft, set: (text: string) => controller.setDraft(text) });
const parentSession = computed(() => {
	const entries = library.value?.sessions ?? [];
	const parentId = entries.find((entry) => entry.id === snapshot.value?.sessionId)?.parentId;
	return entries.find((entry) => entry.id === parentId);
});

/*
 * ========================================================================
 * 步骤1：将界面操作交给业务 Controller
 * ========================================================================
 * 数据源：用户输入、宿主能力和模型配置。
 * 操作：
 *   1) 模型与思考等级从实际配置生成
 *   2) 未接通的工程能力不显示空按钮
 */
async function saveAuthentication(provider: string, key: string) {
	logger.info("开始保存认证");
	// 1.1 凭据只交给宿主写入，记录不包含服务商负载。
	saving.value = true;
	try {
		if (await controller.send({ type: "setApiKey", provider, key })) settingsOpen.value = false;
	} finally {
		saving.value = false;
		logger.info("认证保存结束");
	}
}
async function saveCustomProvider(provider: CustomProviderInput) {
	logger.info("开始保存自定义 Provider");
	saving.value = true;
	try {
		if (await controller.send({ type: "saveProvider", provider })) settingsOpen.value = false;
	} finally {
		saving.value = false;
		logger.info("自定义 Provider 保存结束");
	}
}
function goalAction(action: "pause" | "resume" | "delete", goalId: string): Promise<boolean> {
	return controller.send({ type: "goalCommand", action, goalId });
}
async function queueAction(action: "steer" | "remove" | "edit", itemId: string, text?: string): Promise<boolean> {
	logger.info("开始提交队列条目操作");
	try {
		// 1.6 成功结果交回编辑组件，失败时保留编辑文本。
		if (changing.value) return false;
		return await controller.send({ type: "queueAction", action, itemId, ...(text ? { text } : {}) });
	} finally {
		logger.info("队列条目操作提交结束");
	}
}
async function deleteCustomProvider(provider: string) {
	logger.info("开始删除自定义 Provider");
	saving.value = true;
	try {
		await controller.send({ type: "deleteProvider", provider });
	} finally {
		saving.value = false;
		logger.info("自定义 Provider 删除结束");
	}
}
/*
 * ========================================================================
 * 步骤4：统一设置、帮助和侧栏更新操作
 * ========================================================================
 * 数据源：受限更新桥与主进程共享状态。
 * 操作：1) 检查与下载由不同用户动作触发；2) 同步进度并展示操作失败。
 */
async function runUpdateAction(action: "check" | "download" | "install") {
	if (updateAction.value) return;
	logger.info("开始处理用户更新操作");
	updateAction.value = action;
	updateError.value = null;
	try {
		// 4.1 所有入口共用操作锁，重复点击不追加请求。
		if (action === "install") await bridge.installUpdate();
		else updateState.value = await (action === "check" ? bridge.checkForUpdates() : bridge.downloadUpdate());
	} catch (error) {
		updateError.value = error instanceof Error ? error.message : "更新操作失败，请重试";
		logger.info("用户更新操作失败");
	} finally {
		updateAction.value = null;
		logger.info("用户更新操作处理结束");
	}
}
async function openSkillsDirectory() {
	await bridge.openSkillsDirectory();
}
/*
 * ========================================================================
 * 步骤5：在版本弹窗内检查更新
 * ========================================================================
 * 数据源：帮助菜单或设置页的检查操作。
 * 操作：1) 保留当前工作页面；2) 显示弹窗并只检查版本信息。
 */
function openUpdateDialog() {
	logger.info("开始打开版本检查弹窗");
	// 5.1 不叠放设置弹窗，下载仍由弹窗中的独立按钮触发。
	settingsOpen.value = false;
	updateDialogOpen.value = true;
	void runUpdateAction("check");
	logger.info("版本检查弹窗打开结束");
}
function setThinking(level: unknown) {
	logger.info("开始提交思考等级");
	// 1.2 只接受宿主实际支持的等级。
	if (typeof level === "string" && snapshot.value?.configuration.thinkingLevels.includes(level as ThinkingLevel)) {
		void controller.send({ type: "setThinking", level: level as ThinkingLevel });
	}
	logger.info("思考等级提交结束");
}
function selectModel(key: string) {
	void controller.send({ type: "setModel", key });
}
function setTheme(value: boolean) {
	logger.info("开始切换界面主题");
	// 1.3 主题是界面偏好，不写入会话。
	dark.value = value;
	document.documentElement.classList.toggle("dark", dark.value);
	localStorage.setItem("pi-gui-theme", dark.value ? "dark" : "light");
	logger.info("界面主题切换完成");
}
function toggleTheme() {
	setTheme(!dark.value);
}
function openConfigFile() {
	logger.info("开始打开配置文件");
	void window.piDesktop.openConfig().catch(() => logger.info("打开配置文件失败"));
	logger.info("配置文件打开请求结束");
}
function openPluginsFromSettings() {
	settingsOpen.value = false;
	viewMode.value = "plugins";
}
function submitDraft() {
	logger.info("开始提交输入区消息");
	// 1.4 忙碌时 Enter 默认排队；引导使用独立按钮。
	const requestPlan = planMode.value && !canEnqueue.value && !planActive.value;
	const text = draft.value;
	void controller.send(
		canEnqueue.value
			? { type: "enqueue", mode: "followUp", text }
			: { type: "prompt", text, ...(requestPlan ? { plan: true } : {}) },
	);
	if (requestPlan) planMode.value = false;
	logger.info("输入区消息提交结束");
}

function approvePlan(text: string) {
	controller.send({ type: "approvePlan", text });
}

function rejectPlan() {
	controller.send({ type: "rejectPlan" });
}

function dismissPlan() {
	controller.send({ type: "dismissPlan" });
}

function abortPlan() {
	controller.send({ type: "abort" });
}
async function forkFromMessage(entryId: string) {
	logger.info("开始从消息打开分支");
	try {
		// 1.5 成功后聚焦新草稿，供用户修改；不自动发送模型请求。
		const previousId = snapshot.value?.sessionId;
		await forkSession(entryId);
		if (snapshot.value?.sessionId !== previousId) {
			await nextTick();
			composer.value?.textareaRef?.focus();
		}
	} finally {
		logger.info("消息分支打开结束");
	}
}

/*
 * ========================================================================
 * 步骤2：为草稿插入项目文件路径
 * ========================================================================
 * 数据源：Controller 的选择结果，不在组件中读文件或拼接引用。
 * 操作：
 *   1) 用户点击后才打开原生选择框
 *   2) 插入成功后恢复输入焦点，取消或失败保持原输入
 */
async function referenceFiles() {
	logger.info("开始处理输入区文件引用");
	try {
		// 2.1 草稿与持久化由业务层统一处理，组件只恢复焦点。
		if (await controller.referenceProjectFiles()) {
			await nextTick();
			composer.value?.textareaRef?.focus();
		}
	} finally {
		logger.info("输入区文件引用处理结束");
	}
}

async function focusComposer() {
	await nextTick();
	composer.value?.textareaRef?.focus();
}
async function enterCompletionDirectory(
	completion: { source: string; start: number; end: number },
	path: string,
): Promise<boolean> {
	const next = `${completion.source.slice(0, completion.start)}@${path}/${completion.source.slice(completion.end)}`;
	const cursor = completion.start + path.length + 2;
	draft.value = next;
	await nextTick();
	const textarea = composer.value?.textareaRef;
	if (!textarea) return false;
	textarea.focus();
	textarea.setSelectionRange(cursor, cursor);
	return true;
}
async function referenceCompletionDirectory(
	completion: { source: string; start: number; end: number },
	path: string,
): Promise<boolean> {
	const folder = `${path.replace(/\/+$/, "")}/`;
	const token = `@${JSON.stringify(folder)}`;
	const suffix = completion.source.slice(completion.end);
	const separator = /^\s/u.test(suffix) ? "" : " ";
	const next = `${completion.source.slice(0, completion.start)}${token}${separator}${suffix}`;
	const cursor = completion.start + token.length + separator.length;
	draft.value = next;
	await nextTick();
	const textarea = composer.value?.textareaRef;
	if (!textarea) return false;
	textarea.focus();
	textarea.setSelectionRange(cursor, cursor);
	return true;
}
async function listCompletionDirectory(path: string) {
	if (!snapshot.value) return { path, entries: [], truncated: false };
	return bridge.listDirectory({ cwd: snapshot.value.cwd, path });
}
async function setComposerText(text: string, cursor: number): Promise<void> {
	draft.value = text;
	await nextTick();
	const textarea = composer.value?.textareaRef;
	if (!textarea) return;
	textarea.focus();
	textarea.setSelectionRange(cursor, cursor);
}
function openComposerModelPicker(): void {
	modelPicker.value?.openPicker();
	void focusComposer();
}

function applyReviewFeedback(text: string) {
	const current = draft.value.trimEnd();
	controller.setDraft(current ? `${current}\n\n${text}` : text);
	viewMode.value = "app";
	void focusComposer();
}

async function openWorktree(cwd: string) {
	/*
	 * ========================================================================
	 * 步骤3：关联工作树并切换会话视图
	 * ========================================================================
	 * 数据源：主进程验证过的工作树；复用草稿保存与切换通道。
	 * 操作：1) 只请求一次关联；2) 保留失败提示，不再追加失败的新建请求。
	 */
	logger.info("开始打开工作树会话");
	try {
		// 3.1 新工作树的会话创建和索引登记在主进程一次完成。
		viewMode.value = "app";
		await openWorkspace(cwd);
	} finally {
		logger.info("工作树会话打开结束");
	}
}

// 插件和自动化页保留侧栏，切换项目或会话时回到对话视图。
function showConversation(): void {
	if (viewMode.value !== "app") viewMode.value = "app";
}

async function selectSession(sessionId: string) {
	showConversation();
	if (snapshot.value?.sessionId === sessionId && state.value.connection === "connected") return;
	await openSession(sessionId);
}

async function selectSessionAt(selection: { cwd: string; sessionId: string }) {
	showConversation();
	await openSessionAt(selection.cwd, selection.sessionId);
}

async function switchWorkspace(cwd: string) {
	showConversation();
	await openWorkspace(cwd);
}

async function startSessionAt(cwd: string) {
	showConversation();
	await newSessionAt(cwd);
}

async function createSession() {
	showConversation();
	await changeProject(true);
}

async function openParallelJob(job: ParallelJob) {
	if (!job.sessionId) return;
	parallelOpen.value = false;
	actionError.value = "";
	try {
		await bridge.openParallelJob({ id: job.id });
		await refreshLibrary();
	} catch (error) {
		actionError.value = error instanceof Error ? error.message : "无法打开并行任务会话";
	}
}

function handleSidePanelShortcut(event: KeyboardEvent): void {
	if (!(event.ctrlKey || event.metaKey) || event.repeat || event.isComposing) return;
	const action = resolveAppAction(event, undefined, logger);
	if (!action) return;
	if (action !== "settings" && (!snapshot.value || changing.value || viewMode.value !== "app")) return;
	event.preventDefault();
	event.stopPropagation();
	if (action === "settings") settingsOpen.value = true;
	else openSideTool(action);
}

/*
 * ========================================================================
 * 步骤6：从对话右侧打开工作工具
 * ========================================================================
 * 数据源：当前工作区与右侧工具标签。
 * 操作：1) 保持对话和草稿可见；2) 复用同一变更面板与评审事件。
 */
function openSideTool(tool: "files" | "terminal" | "browser" | "changes"): void {
	if (!snapshot.value || changing.value) return;
	logger.info("开始打开右侧工作工具");
	// 6.1 等待右侧面板挂载后激活标签，不切换整页工程视图。
	sidePanelOpen.value = true;
	void nextTick(() => sidePanel.value?.openTool(tool));
	logger.info("右侧工作工具打开结束");
}
function openFileInSidePanel(path: string): void {
	if (!snapshot.value || changing.value) return;
	sidePanelOpen.value = true;
	const html = /\.html?$/i.test(path);
	void nextTick(() => (html ? sidePanel.value?.openHtmlFile(path) : sidePanel.value?.openFile(path)));
}
function openUrlInSidePanel(url: string): void {
	if (!snapshot.value || changing.value) return;
	sidePanelOpen.value = true;
	void nextTick(() => sidePanel.value?.openUrl(url));
}
function handleOpenUrl(event: Event): void {
	const url = (event as CustomEvent<string>).detail;
	if (typeof url === "string") openUrlInSidePanel(url);
}
function openSubagentTab(runId: string, childId?: string): void {
	if (!snapshot.value || changing.value) return;
	sidePanelOpen.value = true;
	void nextTick(() => sidePanel.value?.openSubagent(runId, childId));
}

onMounted(() => {
	workspaceResizeObserver = new ResizeObserver(restoreSidebarOnReveal);
	if (workspaceSplitter.value) workspaceResizeObserver.observe(workspaceSplitter.value.$el);
	window.addEventListener("keydown", handleSidePanelShortcut, true);
	window.addEventListener("aniao:open-url", handleOpenUrl);
	unsubscribeUpdate = window.piDesktop.subscribeUpdate((state) => {
		updateState.value = state;
	});
	void window.piDesktop
		.getUpdateState()
		.then((state) => {
			updateState.value = state;
		})
		.catch(() => {
			updateError.value = "无法读取更新状态，请重新打开应用";
		});
});
onBeforeUnmount(() => {
	workspaceResizeObserver?.disconnect();
	document.body.classList.remove("resizing-side-panel");
	window.removeEventListener("keydown", handleSidePanelShortcut, true);
	window.removeEventListener("aniao:open-url", handleOpenUrl);
	unsubscribeUpdate?.();
});
</script>

<template>
	<UApp :locale="zh_cn">
		<div class="app-shell">
			<header class="thread-header app-header">
				<div class="thread-top">
					<div class="thread-nav">
						<UButton
							icon="i-lucide-panel-left"
							color="neutral"
							variant="ghost"
							size="sm"
							:aria-label="sidebarOpen ? '收起侧栏' : '展开侧栏'"
							:title="sidebarOpen ? '收起侧栏' : '展开侧栏'"
							@click="sidebarOpen = !sidebarOpen"
						/>
						<button
							type="button"
							class="thread-nav-item"
							:class="{ active: viewMode === 'app' }"
							@click="
								settingsOpen = false;
								viewMode = 'app';
							"
						>
							应用
						</button>
						<EditMenu @settings="settingsOpen = true" />
					</div>
					<div class="window-controls">
						<UDropdownMenu
							:items="[
								{ label: '检查更新', icon: 'i-lucide-refresh-cw', onSelect: openUpdateDialog },
								{ label: '发送反馈', icon: 'i-lucide-message-square', onSelect: () => (feedbackOpen = true) },
							]"
							:content="{ align: 'end' }"
						>
							<UButton
								icon="i-lucide-circle-question-mark"
								color="neutral"
								variant="ghost"
								size="sm"
								class="help-toolbar-button"
								aria-label="帮助"
								title="帮助"
								>帮助</UButton
							>
						</UDropdownMenu>
						<button
							type="button"
							class="window-control"
							aria-label="最小化"
							title="最小化"
							@click="bridge.minimizeWindow()"
						>
							<UIcon name="i-lucide-minus" />
						</button>
						<button
							type="button"
							class="window-control"
							aria-label="最大化或还原"
							title="最大化或还原"
							@click="bridge.toggleMaximizeWindow()"
						>
							<UIcon name="i-lucide-square" />
						</button>
						<button
							type="button"
							class="window-control close"
							aria-label="关闭"
							title="关闭"
							@click="bridge.closeWindow()"
						>
							<UIcon name="i-lucide-x" />
						</button>
					</div>
				</div>
			</header>
			<USplitter
				ref="workspaceSplitter"
				v-show="!settingsOpen"
				:items="splitterItems"
				:disabled="!sidebarOpen"
				:ui="{ handle: sidebarOpen ? undefined : 'hidden' }"
				class="workspace-splitter"
				@resize="rememberSidebarWidth"
				@dragging="setSidebarDragging"
			>
				<template #sidebar>
					<SessionSidebar
						v-show="sidebarOpen"
						:projects="projects"
						:active-id="snapshot?.sessionId"
						:runtimes="sessionRuntimes"
						:cwd="snapshot?.cwd"
						:disabled="state.selectingFiles"
						:navigating="changing"
						:connected="state.connection === 'connected'"
						:resources-disabled="!snapshot || state.connection !== 'connected'"
						:automation-disabled="!snapshot || state.connection !== 'connected'"
						:active-page="viewMode === 'plugins' ? 'plugins' : viewMode === 'automation' ? 'automation' : null"
						:error="actionError"
						:update="updateSession"
						:rename="renameWorkspace"
						:remove="removeWorkspace"
						@create="createSession"
						@open-project="changeProject()"
						@open-workspace="switchWorkspace"
						@new-session-at="startSessionAt"
						@select="selectSession"
						@select-at="selectSessionAt"
						@refresh="refreshLibrary"
						@open-resources="viewMode = 'plugins'"
						@open-automation="viewMode = 'automation'"
						@show-conversation="showConversation"
					>
						<template #footer>
							<div class="sidebar-footer">
								<div class="user-profile" aria-label="当前用户：Aniao">
									<span class="user-avatar" aria-hidden="true">A</span>
									<span class="user-name">Aniao</span>
								</div>
								<div class="sidebar-footer-actions">
									<UpdateDownloadButton
										:state="updateState"
										:pending="updateAction !== null"
										@download="runUpdateAction('download')"
										@details="updateDialogOpen = true"
									/>
									<UButton
										icon="i-lucide-settings"
										color="neutral"
										variant="ghost"
										size="sm"
										aria-label="设置"
										title="设置"
										:disabled="busy"
										@click="settingsOpen = true"
									/>
									<UButton
										:icon="dark ? 'i-lucide-sun' : 'i-lucide-moon'"
										:aria-label="dark ? '切换浅色主题' : '切换深色主题'"
										:title="dark ? '切换浅色主题' : '切换深色主题'"
										color="neutral"
										variant="ghost"
										size="sm"
										@click="toggleTheme"
									/>
								</div>
							</div>
						</template>
					</SessionSidebar>
				</template>
				<template #main>
					<main class="main-workspace">
						<template v-if="viewMode === 'app'">
							<div class="app-workspace">
								<section class="conversation-column">
									<header class="conversation-header">
										<h1 class="conversation-title">{{ snapshot ? snapshot.title : "新会话" }}</h1>
										<div class="conversation-tools">
											<UButton
												icon="i-lucide-panel-right"
												color="neutral"
												:variant="sidePanelOpen ? 'soft' : 'ghost'"
												size="sm"
												:aria-label="sidePanelOpen ? '收起右侧面板' : '展开右侧面板'"
												:title="sidePanelOpen ? '收起右侧面板' : '展开右侧面板'"
												:disabled="!snapshot"
												@click="sidePanelOpen = !sidePanelOpen"
											/>
										</div>
									</header>
									<div v-if="parentSession" class="branch-origin">
										<span>分支来源</span>
										<UButton
											color="neutral"
											variant="link"
											size="xs"
											:disabled="busy || changing || state.connection !== 'connected'"
											@click="openSession(parentSession.id)"
											>{{ parentSession.title }}</UButton
										>
									</div>
									<ConversationPane
										v-if="snapshot?.messages.length"
										:key="snapshot.sessionId"
										:snapshot="snapshot"
										:disabled="busy || changing || state.connection !== 'connected'"
										@fork="forkFromMessage"
										@open-file="openFileInSidePanel"
										@open-subagent="openSubagentTab"
									/>
									<section v-else class="welcome">
										<UIcon name="i-lucide-terminal" class="welcome-symbol" aria-hidden="true" />
										<h1>{{ snapshot ? "从这个项目开始" : "打开项目，开始工作" }}</h1>
										<p>
											{{ snapshot ? "描述要解决的问题，或先读一遍代码。" : "把想法变成可以运行的代码。" }}
										</p>
										<UButton
											v-if="!snapshot"
											icon="i-lucide-folder-open"
											color="neutral"
											variant="outline"
											:loading="changing"
											@click="changeProject()"
											>打开项目</UButton
										>
										<p v-if="!snapshot" class="trust-note">选择的项目将在本机运行工具。</p>
									</section>
									<div class="composer-region">
										<PlanCard
											v-if="plan && plan.phase !== 'off'"
											:plan="plan"
											:disabled="changing || state.connection !== 'connected'"
											@approve="approvePlan"
											@edit="(text) => controller.send({ type: 'editPlan', text })"
											@reject="rejectPlan"
											@dismiss="dismissPlan"
											@abort="abortPlan"
										/>
										<OAuthProgress
											v-if="
												snapshot?.authentication.flow?.phase === 'working' &&
												!settingsOpen &&
												!snapshot.dialogs.some((dialog) => dialog.scope === 'oauth')
											"
											:flow="snapshot.authentication.flow"
											cancel
											@cancel="controller.send({ type: 'cancelLogin' })"
										/>
										<ExtensionPanel
											v-if="extensionState"
											:state="extensionState"
											placement="aboveEditor"
											@dismiss="(id) => controller.send({ type: 'dismissNotice', id })"
										/>
										<TaskQueue
											v-if="snapshot"
											:key="`${snapshot.sessionId}-${snapshot.generation}`"
											:queue="snapshot.queue"
											:idle="snapshot.run.phase === 'idle'"
											:busy="
												state.queueBusy ||
												state.submitting ||
												changing ||
												state.connection !== 'connected' ||
												!!snapshot.dialogs.length
											"
											:submit-action="queueAction"
											@restore="controller.restoreQueue()"
											@clear="controller.send({ type: 'clearQueue' })"
										/>
										<p
											v-if="state.error || actionError || state.draftError"
											class="workspace-error"
											role="alert"
										>
											{{ actionError || state.error || state.draftError }}
										</p>
										<div v-if="snapshot && !snapshot.configuration.model?.available" class="auth-notice">
											<span>{{
												snapshot.configuration.model ? "当前模型尚未认证。" : "尚未配置可用模型。"
											}}</span
											><UButton variant="link" size="sm" @click="settingsOpen = true">配置服务商</UButton>
										</div>
										<GoalBar
											v-if="snapshot"
											:cwd="snapshot.cwd"
											:session-id="snapshot.sessionId"
											:generation="snapshot.generation"
											:control="goalAction"
										/>
										<ImageInputZone
											:import-images="(read) => controller.attachImages(read)"
											:available="canAttachImages"
											:disabled="changing"
										>
											<UChatPrompt
												ref="composer"
												v-model="draft"
												v-bind="fileCompletion?.inputAttributes"
												class="composer"
												:disabled="
													!snapshot ||
													planAwaiting ||
													changing ||
													state.selectingFiles ||
													state.draftStatus === 'loading' ||
													state.connection !== 'connected'
												"
												placeholder="描述任务，或询问代码…"
												:maxrows="8"
												:autofocus="false"
												@submit="submitDraft"
											>
												<template #header>
													<ComposerReferenceLayer
														:textarea="composer?.textareaRef ?? null"
														:draft="draft"
														placeholder="描述任务，或询问代码…"
														@change="setComposerText"
													/>
													<ComposerFileCompletion
														v-if="snapshot"
														ref="fileCompletion"
														:key="`${snapshot.sessionId}-${snapshot.generation}`"
														:textarea="composer?.textareaRef ?? null"
														:draft="draft"
														:selection="{
															sessionId: snapshot.sessionId,
															generation: snapshot.generation,
														}"
														:disabled="
															busy ||
															changing ||
															state.connection !== 'connected' ||
															state.draftStatus === 'loading'
														"
														:error="state.error || state.draftError"
														:directory="listCompletionDirectory"
														:enter-directory="enterCompletionDirectory"
														:reference-directory="referenceCompletionDirectory"
														:search="bridge.searchProjectFiles"
														:reference="
															(input, completion) => controller.referenceProjectFiles(input, completion)
														"
													/>
													<ComposerCommandMenu
														v-if="snapshot"
														:textarea="composer?.textareaRef ?? null"
														:draft="draft"
														:resources="snapshot.resources ?? null"
														:plan-active="planMode"
														:busy="busy || changing"
														@set-draft="setComposerText"
														@file="focusComposer"
														@plan="planMode = !planMode"
														@model="openComposerModelPicker"
													/>
													<div
														v-if="snapshot && state.imageIds.length"
														class="attachment-list"
														aria-label="草稿图片附件"
													>
														<ImageAttachment
															v-for="imageId in state.imageIds"
															:key="`${snapshot.sessionId}-${imageId}`"
															:input="{
																sessionId: snapshot.sessionId,
																generation: snapshot.generation,
																imageId,
																source: 'draft',
															}"
															removable
															:disabled="state.selectingFiles || changing"
															@remove="controller.removeImage(imageId)"
														/>
													</div>
												</template>
												<template #footer>
													<div class="composer-options">
														<UButton
															icon="i-lucide-file-plus-2"
															color="neutral"
															variant="ghost"
															size="sm"
															aria-label="引用项目文件"
															title="把项目文件路径加入草稿"
															:loading="state.selectingFiles"
															:disabled="
																!snapshot ||
																busy ||
																changing ||
																state.draftStatus === 'loading' ||
																state.connection !== 'connected'
															"
															@click="referenceFiles"
															>引用文件</UButton
														>
														<ProjectFileSearch
															v-if="snapshot"
															:key="`${snapshot.sessionId}-${snapshot.generation}`"
															:selection="{
																sessionId: snapshot.sessionId,
																generation: snapshot.generation,
															}"
															:disabled="
																busy ||
																changing ||
																state.connection !== 'connected' ||
																state.draftStatus === 'loading'
															"
															:error="state.error || state.draftError"
															:search="bridge.searchProjectFiles"
															:reference="(input) => controller.referenceProjectFiles(input)"
															@inserted="focusComposer"
															@native="referenceFiles"
														/>
														<UButton
															icon="i-lucide-file-text"
															color="neutral"
															:variant="planMode ? 'soft' : 'ghost'"
															size="sm"
															aria-label="切换计划模式"
															:aria-pressed="planMode"
															title="计划模式会先只读分析，生成可确认的计划"
															:disabled="planToggleDisabled"
															@click="planMode = !planMode"
															>计划</UButton
														>
													</div>
													<div class="composer-actions">
														<div v-if="snapshot" class="composer-model-group">
															<ContextUsageRing :usage="snapshot.contextUsage" />
															<ModelPicker
																ref="modelPicker"
																:configuration="snapshot.configuration"
																:disabled="busy || state.connection !== 'connected'"
																:thinking="snapshot.configuration.thinking"
																:thinking-levels="snapshot.configuration.thinkingLevels"
																:thinking-disabled="busy || state.connection !== 'connected'"
																@select="selectModel"
																@set-thinking="setThinking"
															/>
														</div>
														<UButton
															v-if="
																snapshot && busy && isTaskRunning(snapshot.run.phase) && !draft.trim()
															"
															icon="i-lucide-square"
															aria-label="停止任务"
															color="neutral"
															variant="solid"
															size="sm"
															:disabled="
																['stopping', 'preparing', 'settling'].includes(snapshot.run.phase)
															"
															@click="controller.send({ type: 'abort' })"
														/>
														<UButton
															v-else
															type="submit"
															icon="i-lucide-arrow-up"
															aria-label="发送任务"
															color="neutral"
															size="sm"
															:disabled="
																!snapshot?.configuration.model?.available ||
																!draft.trim() ||
																planAwaiting ||
																changing ||
																(canEnqueue
																	? false
																	: busy || hasQueue || state.connection !== 'connected')
															"
														/>
													</div>
												</template>
											</UChatPrompt>
										</ImageInputZone>
										<ExtensionPanel v-if="extensionState" :state="extensionState" placement="belowEditor" />
										<p v-if="state.imageIds.length" class="muted attachment-note">
											运行中发送会加入排队；排队消息可选择引导或删除。中断后请核对聊天记录再发送。
										</p>
									</div>
								</section>
								<SidePanel
									v-if="sidePanelOpen && snapshot"
									ref="sidePanel"
									:key="`${snapshot.sessionId}-${snapshot.generation}`"
									:cwd="snapshot.cwd"
									:subagents="snapshot.extensions.subagents ?? null"
									@close="sidePanelOpen = false"
									@review="applyReviewFeedback"
									@open-worktree="openWorktree"
								/>
							</div>
						</template>
						<PluginsPage
							v-else-if="viewMode === 'plugins' && snapshot"
							:cwd="snapshot.cwd"
							:resources="snapshot.resources ?? null"
						/>
						<AutomationPage
							v-else-if="viewMode === 'automation' && snapshot"
							:cwd="snapshot.cwd"
							@open-parallel="parallelOpen = true"
						/>
						<section v-else class="welcome">
							<h1>打开项目，开始工作</h1>
						</section>
					</main>
				</template>
			</USplitter>
			<AboutDialog
				v-model="updateDialogOpen"
				:update-state="updateState"
				:pending="updateAction !== null"
				:installing="updateAction === 'install'"
				:error="updateError"
				@check-update="runUpdateAction('check')"
				@download-update="runUpdateAction('download')"
				@install-update="runUpdateAction('install')"
			/>
			<SettingsDialog
				v-model="settingsOpen"
				:configuration="snapshot?.configuration ?? null"
				:authentication="snapshot?.authentication ?? { providers: [], flow: null }"
				:resources="snapshot?.resources ?? null"
				:dark="dark"
				:update-state="updateState"
				:update-pending="updateAction !== null"
				:update-installing="updateAction === 'install'"
				:update-error="updateError"
				:saving="saving"
				:resources-busy="
					changing ||
					state.connection !== 'connected' ||
					state.submitting ||
					!!snapshot?.dialogs.length ||
					(!!snapshot && snapshot.run.phase !== 'idle') ||
					(!!snapshot?.plan && !['off', 'completed'].includes(snapshot.plan.phase))
				"
				:error="state.error"
				@save="saveAuthentication"
				@save-provider="saveCustomProvider"
				@delete-provider="deleteCustomProvider"
				@login="(provider) => controller.send({ type: 'login', provider })"
				@logout="(provider) => controller.send({ type: 'logout', provider })"
				@cancel-login="controller.send({ type: 'cancelLogin' })"
				@set-theme="setTheme"
				@open-config="openConfigFile"
				@open-plugins="openPluginsFromSettings"
				@check-update="openUpdateDialog"
				@download-update="runUpdateAction('download')"
				@install-update="runUpdateAction('install')"
				@open-skills="openSkillsDirectory"
				@data-changed="
					async () => {
						await controller.refresh();
						await refreshLibrary();
					}
				"
			/>
			<FeedbackDialog v-model="feedbackOpen" />
			<ParallelTasksDialog v-model="parallelOpen" :cwd="snapshot?.cwd ?? null" @open-session="openParallelJob" />
			<InteractionDialog
				v-if="snapshot?.dialogs[0] && state.connection === 'connected'"
				:key="snapshot.dialogs[0].id"
				:request="snapshot.dialogs[0]"
				:login="snapshot.authentication.flow"
				:respond="(reply) => controller.send({ type: 'reply', reply })"
			/>
		</div>
	</UApp>
</template>

<style scoped>
.composer-model-group {
	display: flex;
	align-items: center;
	gap: 4px;
	min-width: 0;
}
.help-toolbar-button {
	align-self: center;
	margin-right: 14px;
	font-size: 12px;
}
</style>
