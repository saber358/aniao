<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ProjectSummary, SessionChange, SessionItem, SessionRuntime } from "../../shared/workspace.ts";
import { createLogger } from "../../shared/logger.ts";
import { UIcon, UButton, UDropdownMenu, UInput, UModal } from "../ui.ts";
import SidebarHeader from "./SidebarHeader.vue";

const props = defineProps<{
	sessions: SessionItem[];
	projects: ProjectSummary[];
	activeId?: string;
	runtimes: SessionRuntime[];
	disabled: boolean;
	connected: boolean;
	resourcesDisabled: boolean;
	automationDisabled: boolean;
	activePage: "plugins" | "automation" | null;
	cwd?: string;
	error: string;
	update: (change: SessionChange) => Promise<boolean>;
	rename: (cwd: string, name: string) => Promise<boolean>;
	remove: (cwd: string) => Promise<boolean>;
}>();
const emit = defineEmits<{
	create: [];
	openProject: [];
	openWorkspace: [cwd: string];
	newSessionAt: [cwd: string];
	select: [id: string];
	selectAt: [selection: { cwd: string; sessionId: string }];
	refresh: [];
	openResources: [];
	openAutomation: [];
	showConversation: [];
}>();
const logger = createLogger("session-sidebar");
const runtimeById = computed(() => new Map(props.runtimes.map((runtime) => [runtime.sessionId, runtime])));
const query = ref("");
const searchOpen = ref(false);
const archived = ref(false);
const limit = ref(50);
const renaming = ref<SessionItem | null>(null);
const title = ref("");
const saving = ref(false);
const collapsed = ref(new Set<string>());
const renamingProject = ref<ProjectSummary | null>(null);
const removingProject = ref<ProjectSummary | null>(null);
const projectTitle = ref("");
const projectSaving = ref(false);
const projectRemoving = ref(false);
const projectName = computed(() => props.cwd?.replaceAll("\\", "/").split("/").at(-1) ?? "");
const visibleProjects = computed<ProjectSummary[]>(() => {
	if (!props.cwd) return props.projects;
	if (props.projects.some((project) => project.cwd === props.cwd)) return props.projects;
	return [{ cwd: props.cwd, name: projectName.value, sessions: [] }, ...props.projects];
});
const workspaceMenu = computed(() => [
	{
		label: archived.value ? "显示最近会话" : "显示已归档会话",
		icon: "i-lucide-archive",
		onSelect: () => {
			archived.value = !archived.value;
		},
	},
	{
		label: "刷新工作区",
		icon: "i-lucide-refresh-cw",
		disabled: !props.connected,
		onSelect: () => emit("refresh"),
	},
]);
const filtered = computed(() =>
	props.sessions.filter(
		(item) =>
			item.archived === archived.value &&
			`${item.title}\n${item.preview}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()),
	),
);
function relativeTime(updatedAt: number): string {
	const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60_000));
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes}分钟`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}小时`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}天`;
	return new Date(updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
watch([query, archived], () => {
	limit.value = 50;
});

function isExpanded(cwd: string): boolean {
	return !collapsed.value.has(cwd);
}
function toggleExpanded(cwd: string): void {
	const next = new Set(collapsed.value);
	if (next.has(cwd)) next.delete(cwd);
	else next.add(cwd);
	collapsed.value = next;
}
function openProject(project: ProjectSummary): void {
	if (project.cwd === props.cwd) {
		// 插件/自动化等页面下点击当前工作区应回到对话，而不是只折叠列表。
		if (props.activePage) {
			emit("showConversation");
			return;
		}
		toggleExpanded(project.cwd);
		return;
	}
	const next = new Set(collapsed.value);
	next.delete(project.cwd);
	collapsed.value = next;
	emit("openWorkspace", project.cwd);
}
function projectActions(project: ProjectSummary) {
	return [
		{
			label: "重命名",
			icon: "i-lucide-pencil",
			onSelect: () => {
				renamingProject.value = project;
				projectTitle.value = project.name;
			},
		},
		{
			label: "删除工作区",
			icon: "i-lucide-trash-2",
			color: "error" as const,
			onSelect: () => {
				removingProject.value = project;
			},
		},
	];
}
async function saveProjectName(): Promise<void> {
	if (!renamingProject.value || !projectTitle.value.trim()) return;
	logger.info("开始提交工作区名称");
	projectSaving.value = true;
	try {
		if (await props.rename(renamingProject.value.cwd, projectTitle.value.trim())) renamingProject.value = null;
	} finally {
		projectSaving.value = false;
		logger.info("工作区名称提交结束");
	}
}
async function confirmRemoveProject(): Promise<void> {
	if (!removingProject.value) return;
	logger.info("开始移除工作区");
	projectRemoving.value = true;
	try {
		if (await props.remove(removingProject.value.cwd)) removingProject.value = null;
	} finally {
		projectRemoving.value = false;
		logger.info("工作区移除结束");
	}
}

/*
 * ========================================================================
 * 步骤1：组织当前项目会话列表
 * ========================================================================
 * 数据源：主进程返回的摘要与偏好。
 * 操作：
 *   1) 搜索标题和首条消息，按批次展开列表
 *   2) 菜单仅发业务意图，重命名成功后关闭弹窗
 */
function actions(session: SessionItem) {
	return [
		{
			label: "重命名",
			icon: "i-lucide-pencil",
			onSelect: () => {
				renaming.value = session;
				title.value = session.title;
			},
		},
		{
			label: session.pinned ? "取消置顶" : "置顶",
			icon: "i-lucide-pin",
			onSelect: () => props.update({ sessionId: session.id, pinned: !session.pinned }),
		},
		{
			label: session.archived ? "取消归档" : "归档",
			icon: "i-lucide-archive",
			onSelect: () => props.update({ sessionId: session.id, archived: !session.archived }),
		},
	];
}
async function rename() {
	if (!renaming.value || !title.value.trim()) return;
	logger.info("开始提交会话名称");
	saving.value = true;
	try {
		if (await props.update({ sessionId: renaming.value.id, title: title.value.trim() })) renaming.value = null;
	} finally {
		saving.value = false;
		logger.info("会话名称提交结束");
	}
}
</script>

<template>
	<aside class="sidebar">
		<SidebarHeader
			:disabled="!activeId || disabled"
			:resources-disabled="resourcesDisabled"
			:automation-disabled="automationDisabled"
			:active-page="activePage"
			@create="emit('create')"
			@open-resources="emit('openResources')"
			@open-automation="emit('openAutomation')"
		/>
		<div class="sidebar-section">
			<span class="section-label">工作区</span>
			<div class="workspace-actions">
				<UButton
					icon="i-lucide-search"
					aria-label="搜索会话"
					title="搜索会话"
					:aria-pressed="searchOpen"
					color="neutral"
					variant="ghost"
					size="xs"
					:disabled="!activeId || !connected"
					@click="searchOpen = !searchOpen"
				/>
				<UDropdownMenu :items="workspaceMenu">
					<UButton
						icon="i-lucide-sliders-horizontal"
						aria-label="工作区选项"
						title="工作区选项"
						color="neutral"
						variant="ghost"
						size="xs"
						:disabled="!activeId || !connected"
					/>
				</UDropdownMenu>
				<UButton
					icon="i-lucide-folder-plus"
					aria-label="打开项目"
					title="打开项目"
					color="neutral"
					variant="ghost"
					size="xs"
					:disabled="disabled"
					@click="emit('openProject')"
				/>
			</div>
		</div>
		<UInput
			v-if="searchOpen && activeId"
			v-model="query"
			aria-label="搜索当前工作区会话"
			placeholder="搜索当前工作区会话"
			icon="i-lucide-search"
			size="sm"
			variant="soft"
			class="workspace-search"
			autofocus
		/>
		<div class="workspace-tree">
			<div v-for="project in visibleProjects" :key="project.cwd" class="workspace-node">
				<div class="project-row" :class="{ current: project.cwd === cwd }">
					<button
						type="button"
						class="project-toggle"
						:aria-label="isExpanded(project.cwd) ? '收起工作区' : '展开工作区'"
						:aria-expanded="isExpanded(project.cwd)"
						@click="toggleExpanded(project.cwd)"
					>
						<UIcon
							:name="project.cwd === cwd ? 'i-lucide-folder-open' : 'i-lucide-folder'"
							class="project-icon project-folder"
						/>
						<UIcon
							name="i-lucide-chevron-down"
							class="project-chevron"
							:class="{ collapsed: !isExpanded(project.cwd) }"
						/>
					</button>
					<button
						type="button"
						class="project-open"
						:title="project.cwd"
						:disabled="disabled"
						@click="openProject(project)"
					>
						<span class="project-name">{{ project.name }}</span>
					</button>
					<div class="project-actions">
						<UDropdownMenu :items="projectActions(project)"
							><UButton
								icon="i-lucide-ellipsis"
								:aria-label="`工作区操作：${project.name}`"
								color="neutral"
								variant="ghost"
								size="xs"
								:disabled="disabled || !connected"
						/></UDropdownMenu>
						<UButton
							icon="i-lucide-plus"
							aria-label="在此工作区新建会话"
							title="在此工作区新建会话"
							color="neutral"
							variant="ghost"
							size="xs"
							class="project-new"
							:disabled="disabled"
							@click="emit('newSessionAt', project.cwd)"
						/>
					</div>
				</div>
				<div v-if="isExpanded(project.cwd) && project.cwd === cwd && activeId" class="project-sessions">
					<nav class="session-list" aria-label="历史会话">
						<div
							v-for="session in filtered.slice(0, limit)"
							:key="session.id"
							:class="[
								'session-row',
								{ active: session.id === activeId, running: runtimeById.get(session.id)?.running },
							]"
						>
							<button
								type="button"
								class="session-open"
								:aria-current="session.id === activeId ? 'page' : undefined"
								:aria-busy="runtimeById.get(session.id)?.running ?? false"
								:disabled="disabled"
								:title="session.preview || session.title"
								@click="emit('select', session.id)"
							>
								<span
									v-if="runtimeById.get(session.id)?.running"
									class="session-running-spinner"
									role="status"
									aria-label="正在运行"
									title="正在运行"
								></span>
								<span v-if="session.pinned" class="pin-indicator">置顶</span
								><span class="session-name">{{ runtimeById.get(session.id)?.title || session.title }}</span>
							</button>
							<span v-if="runtimeById.get(session.id)?.connected === false" class="session-attention"
								>已断开</span
							>
							<span class="session-time">{{ relativeTime(session.updatedAt) }}</span>
							<UDropdownMenu :items="actions(session)"
								><UButton
									icon="i-lucide-ellipsis"
									:aria-label="`会话操作：${session.title}`"
									color="neutral"
									variant="ghost"
									size="xs"
									:disabled="disabled || !connected"
							/></UDropdownMenu>
						</div>
						<p v-if="!filtered.length" class="sidebar-hint">
							{{ query ? "没有匹配的会话" : archived ? "没有已归档会话" : "没有会话" }}
						</p>
						<UButton v-if="filtered.length > limit" color="neutral" variant="ghost" size="xs" @click="limit += 50"
							>显示更多</UButton
						>
					</nav>
				</div>
				<div v-else-if="isExpanded(project.cwd) && project.sessions.length" class="project-sessions">
					<button
						v-for="session in project.sessions.slice(0, 3)"
						:key="session.id"
						type="button"
						class="tree-session"
						:title="session.preview || session.title"
						:disabled="disabled"
						@click="emit('selectAt', { cwd: project.cwd, sessionId: session.id })"
					>
						<span
							v-if="runtimeById.get(session.id)?.running"
							class="session-running-spinner"
							role="status"
							aria-label="正在运行"
						></span>
						<span class="session-name">{{ runtimeById.get(session.id)?.title || session.title }}</span>
						<span v-if="runtimeById.get(session.id)?.connected === false" class="session-attention">已断开</span>
						<span class="session-time">{{ relativeTime(session.updatedAt) }}</span>
					</button>
					<button
						v-if="project.sessions.length > 3"
						type="button"
						class="tree-more"
						:disabled="disabled"
						@click="emit('openWorkspace', project.cwd)"
					>
						查看全部 {{ project.sessions.length }} 个会话
					</button>
				</div>
			</div>
			<p v-if="!visibleProjects.length" class="sidebar-hint">打开一个项目，开始工作。</p>
		</div>
		<div class="sidebar-spacer"></div>
		<UModal
			:open="!!renaming"
			title="重命名会话"
			description="名称写入 Pi 原生会话记录。"
			@update:open="
				(value) => {
					if (!value) renaming = null;
				}
			"
		>
			<template #body
				><form class="settings-form" @submit.prevent="rename">
					<label for="session-title">会话名称</label
					><UInput id="session-title" v-model="title" :maxlength="200" autofocus class="w-full" />
					<p v-if="error" role="alert" class="workspace-error">{{ error }}</p>
					<UButton type="submit" :disabled="!title.trim() || saving" :loading="saving">保存名称</UButton>
				</form></template
			>
		</UModal>
		<UModal
			:open="!!renamingProject"
			title="重命名工作区"
			description="只修改侧栏显示名称，不改变磁盘目录。"
			@update:open="
				(value) => {
					if (!value) renamingProject = null;
				}
			"
		>
			<template #body
				><form class="settings-form" @submit.prevent="saveProjectName">
					<label for="workspace-title">工作区名称</label
					><UInput id="workspace-title" v-model="projectTitle" :maxlength="100" autofocus class="w-full" />
					<p v-if="error" role="alert" class="workspace-error">{{ error }}</p>
					<UButton type="submit" :disabled="!projectTitle.trim() || projectSaving" :loading="projectSaving"
						>保存名称</UButton
					>
				</form></template
			>
		</UModal>
		<UModal
			:open="!!removingProject"
			title="删除工作区"
			description="仅从侧栏移除，不会删除磁盘文件。"
			@update:open="
				(value) => {
					if (!value) removingProject = null;
				}
			"
		>
			<template #body>
				<div class="settings-form">
					<p class="muted">确定移除“{{ removingProject?.name }}”？该工作区的会话不会再显示在侧栏。</p>
					<p v-if="error" role="alert" class="workspace-error">{{ error }}</p>
					<div class="modal-actions">
						<UButton color="neutral" variant="ghost" @click="removingProject = null">取消</UButton>
						<UButton color="error" :loading="projectRemoving" @click="confirmRemoveProject">删除</UButton>
					</div>
				</div>
			</template>
		</UModal>
		<slot name="footer" />
	</aside>
</template>

<style scoped>
.session-attention {
	flex: none;
	color: var(--accent);
	font-size: 10px;
}
.tree-session .session-running-spinner {
	position: static;
	margin: 0;
}
</style>
