<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ArchiveSnapshot, ArchivedSession, ArchivePolicy } from "../../shared/data-statistics.ts";
import { createLogger } from "../../shared/logger.ts";
import { UIcon, UModal, UDropdownMenu } from "../ui.ts";

const emit = defineEmits<{ changed: [] }>();
const logger = createLogger("archive-management");
const bridge = window.piDesktop;
const snapshot = ref<ArchiveSnapshot | null>(null);
const busy = ref(false);
const error = ref("");
const query = ref("");
const sort = ref("updated");
const project = ref("");
const expanded = ref(new Set<string>());
const deleting = ref<ArchivedSession[]>([]);
const projectOptions = computed(() => [
	...new Map((snapshot.value?.sessions ?? []).map((session) => [session.cwd, session.projectName])).entries(),
]);
const groups = computed(() => {
	const grouped = new Map<string, { cwd: string; name: string; items: ArchivedSession[] }>();
	const search = query.value.trim().toLocaleLowerCase();
	for (const session of snapshot.value?.sessions ?? []) {
		if (project.value && session.cwd !== project.value) continue;
		if (
			search &&
			!`${session.title}\n${session.preview}\n${session.projectName}`.toLocaleLowerCase().includes(search)
		)
			continue;
		const group = grouped.get(session.cwd) ?? { cwd: session.cwd, name: session.projectName, items: [] };
		group.items.push(session);
		grouped.set(session.cwd, group);
	}
	return [...grouped.values()].map((group) => ({
		...group,
		items: [...group.items].sort((a, b) =>
			sort.value === "title"
				? a.title.localeCompare(b.title, "zh-CN")
				: sort.value === "oldest"
					? a.updatedAt - b.updatedAt
					: b.updatedAt - a.updatedAt,
		),
	}));
});
function toggle(cwd: string): void {
	const next = new Set(expanded.value);
	if (next.has(cwd)) next.delete(cwd);
	else next.add(cwd);
	expanded.value = next;
}
function timestamp(value: number): string {
	return new Date(value).toLocaleString("zh-CN", {
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

/*
 * ========================================================================
 * 步骤1：保存策略和归档操作后同步真实状态
 * ========================================================================
 * 数据源：主进程原子索引和实时运行状态。
 * 操作：1) 请求成功后更新开关与列表；2) 删除先展示明确的数量确认。
 */
async function run(operation: () => Promise<ArchiveSnapshot>, changed = true): Promise<void> {
	if (busy.value) return;
	logger.info("开始处理归档管理操作");
	busy.value = true;
	error.value = "";
	try {
		snapshot.value = await operation();
		if (changed) emit("changed");
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : "归档操作失败";
	} finally {
		busy.value = false;
		logger.info("归档管理操作处理结束");
	}
}
function savePolicy(change: Partial<ArchivePolicy>): void {
	if (!snapshot.value) return;
	const policy = { ...snapshot.value.policy, ...change };
	void run(() => window.piDesktop.saveArchivePolicy(policy));
}
function restore(items: ArchivedSession[]): void {
	void run(() => window.piDesktop.restoreArchived({ sessionIds: items.map((item) => item.id) }));
}
function groupMenu(items: ArchivedSession[]) {
	return [
		{ label: "取消本组归档", icon: "i-lucide-archive", disabled: busy.value, onSelect: () => restore(items) },
		{
			label: "删除本组会话",
			icon: "i-lucide-trash-2",
			color: "error" as const,
			disabled: busy.value || items.some((item) => item.running),
			onSelect: () => {
				deleting.value = items;
			},
		},
	];
}
async function confirmDelete(): Promise<void> {
	const selected = deleting.value;
	await run(async () => {
		const result = await window.piDesktop.deleteArchived({ sessionIds: selected.map((item) => item.id) });
		deleting.value = [];
		return result;
	});
}
onMounted(() => void run(() => window.piDesktop.getArchiveSnapshot(), false));
</script>

<template>
	<section class="data-settings archive-management" :aria-busy="busy">
		<header class="data-heading"><h2>归档管理</h2></header>
		<p v-if="error" class="data-error" role="alert">{{ error }}</p>
		<div v-if="snapshot" class="archive-policy-card">
			<div class="archive-policy-row">
				<div>
					<strong>自动归档旧会话</strong>
					<p>定时扫描，将最后活动时间超过保留期的会话自动归档；置顶和运行中的会话不受影响。</p>
				</div>
				<button
					type="button"
					role="switch"
					aria-label="自动归档旧会话"
					:aria-checked="snapshot.policy.enabled"
					:disabled="busy"
					class="archive-switch"
					:class="{ enabled: snapshot.policy.enabled }"
					@click="savePolicy({ enabled: !snapshot.policy.enabled })"
				>
					<span></span>
				</button>
			</div>
			<div class="archive-policy-row">
				<div>
					<strong>归档保留时长</strong>
					<p>会话最后更新时间早于该时长后，才会进入自动归档候选。</p>
				</div>
				<select
					aria-label="归档保留时长"
					:value="snapshot.policy.retentionDays"
					:disabled="busy"
					@change="
						savePolicy({
							retentionDays: Number(
								($event.target as HTMLSelectElement).value,
							) as ArchivePolicy['retentionDays'],
						})
					"
				>
					<option v-for="days in [7, 14, 30, 90]" :key="days" :value="days">{{ days }} 天后归档</option>
				</select>
			</div>
		</div>
		<div class="data-row archived-title">
			<h3>已归档的会话</h3>
			<button
				type="button"
				class="archive-delete-all"
				:disabled="busy || !snapshot?.sessions.length || snapshot.sessions.some((item) => item.running)"
				@click="deleting = [...(snapshot?.sessions ?? [])]"
			>
				<UIcon name="i-lucide-trash-2" />全部删除
			</button>
		</div>
		<div class="archive-filters">
			<label class="archive-search"
				><UIcon name="i-lucide-search" /><input
					v-model="query"
					type="search"
					aria-label="搜索已归档会话"
					placeholder="搜索已归档会话" /></label
			><label class="archive-sort"
				><span>排序方式</span
				><select v-model="sort" aria-label="归档排序方式">
					<option value="updated">更新时间</option>
					<option value="oldest">最早更新</option>
					<option value="title">会话名称</option>
				</select></label
			><select v-model="project" aria-label="归档项目筛选">
				<option value="">所有项目</option>
				<option v-for="[cwd, name] in projectOptions" :key="cwd" :value="cwd">{{ name }}</option>
			</select>
		</div>
		<p v-if="!snapshot && busy" class="data-muted">正在读取归档记录…</p>
		<div v-if="groups.length" class="archive-projects">
			<div v-for="group in groups" :key="group.cwd" class="archive-project">
				<div class="archive-project-header">
					<button
						type="button"
						class="archive-project-open"
						:aria-expanded="expanded.has(group.cwd)"
						:aria-label="`${expanded.has(group.cwd) ? '收起' : '展开'}归档项目：${group.name}`"
						@click="toggle(group.cwd)"
					>
						<UIcon name="i-lucide-folder" /><span>{{ group.name }}</span
						><UIcon
							:name="expanded.has(group.cwd) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
						/></button
					><span class="archive-count">{{ group.items.length }} 个会话</span
					><UDropdownMenu :items="groupMenu(group.items)"
						><button type="button" class="archive-menu" :aria-label="`归档项目操作：${group.name}`">
							<UIcon name="i-lucide-ellipsis" /></button
					></UDropdownMenu>
				</div>
				<div v-if="expanded.has(group.cwd)" class="archived-session-list">
					<article v-for="session in group.items" :key="session.id" class="archived-session">
						<div>
							<strong>{{ session.title }}</strong
							><time :datetime="new Date(session.updatedAt).toISOString()">{{
								timestamp(session.updatedAt)
							}}</time>
						</div>
						<span v-if="session.running" class="data-muted">运行中</span
						><button
							type="button"
							class="archive-menu"
							:aria-label="`删除归档会话：${session.title}`"
							:disabled="busy || session.running"
							@click="deleting = [session]"
						>
							<UIcon name="i-lucide-trash-2" /></button
						><button
							type="button"
							class="archive-restore"
							:aria-label="`取消归档：${session.title}`"
							:disabled="busy"
							@click="restore([session])"
						>
							取消归档
						</button>
					</article>
				</div>
			</div>
		</div>
		<p v-if="snapshot && !groups.length" class="archive-empty">
			{{ query || project ? "没有匹配的归档会话" : "暂无已归档会话" }}
		</p>
		<footer class="data-footer">
			<button
				type="button"
				class="data-button"
				:disabled="busy"
				@click="run(() => bridge.getArchiveSnapshot(), false)"
			>
				<UIcon name="i-lucide-refresh-cw" />刷新
			</button>
		</footer>
		<UModal
			:open="deleting.length > 0"
			title="删除归档会话"
			description="删除后，这些会话将从应用中移除，已保存的历史文件会移入系统回收站。项目文件不受影响。"
			@update:open="
				(value) => {
					if (!value && !busy) deleting = [];
				}
			"
			><template #body
				><div class="archive-confirm">
					<p>确定删除选中的 {{ deleting.length }} 个归档会话？</p>
					<p v-if="error" class="data-error" role="alert">{{ error }}</p>
					<div class="data-footer">
						<button type="button" class="data-button" :disabled="busy" @click="deleting = []">取消</button
						><button type="button" class="data-button danger" :disabled="busy" @click="confirmDelete">
							{{ busy ? "正在删除…" : "确认删除" }}
						</button>
					</div>
				</div></template
			></UModal
		>
	</section>
</template>

<style scoped>
.archive-policy-card {
	display: grid;
	grid-auto-rows: 1fr;
	border: 1px solid var(--data-line);
	border-radius: 16px;
	background: var(--surface);
	overflow: hidden;
	margin-top: 12px;
}
.archive-policy-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 28px;
	min-height: 80px;
	padding: 16px 18px;
}
.archive-policy-row + .archive-policy-row {
	border-top: 1px solid var(--data-line);
}
.archive-policy-row:first-child p {
	max-width: 740px;
}
.archive-policy-row > div {
	min-width: 0;
	max-width: 66%;
}
.archive-policy-row strong {
	font-size: var(--settings-section-heading-size);
	font-weight: 550;
}
.archive-policy-row p {
	color: var(--data-muted);
	font-size: var(--settings-caption-size);
	line-height: 1.65;
	margin: 6px 0 0;
}
.archive-policy-row select {
	width: 34%;
	flex: none;
}
.archive-switch {
	position: relative;
	width: 48px;
	height: 28px;
	border-radius: 16px;
	background: #b5b5b5;
	flex: none;
}
.archive-switch > span {
	position: absolute;
	top: 1px;
	left: 1px;
	width: 26px;
	height: 26px;
	border-radius: 50%;
	background: white;
	box-shadow: 0 0 1px #0004;
	transition: transform 0.15s;
}
.archive-switch.enabled {
	background: var(--accent);
}
.archive-switch.enabled > span {
	transform: translateX(20px);
}
.archived-title {
	margin-top: 6px;
}
h3 {
	font-weight: 550;
	font-size: var(--settings-section-heading-size);
	margin: 0;
}
.archive-delete-all {
	display: flex;
	align-items: center;
	gap: 6px;
	background: #d7352712;
	color: #d73527;
	padding: 6px 10px;
	border-radius: 8px;
	font-size: var(--settings-body-size);
}
.archive-filters {
	display: grid;
	grid-template-columns: minmax(160px, 1fr) auto minmax(150px, 25%);
	gap: 10px;
}
.archive-search {
	display: flex;
	align-items: center;
	gap: 9px;
	padding: 0 14px;
	background: var(--surface);
	border: 1px solid var(--data-line);
	border-radius: 8px;
	min-width: 0;
}
.archive-search > span {
	color: var(--data-muted);
	flex: none;
	font-size: 18px;
}
.archive-search input {
	height: 32px;
	width: 100%;
	min-width: 0;
	outline: none;
	font-size: var(--settings-body-size);
}
.archive-search:focus-within {
	outline: 2px solid var(--accent);
	outline-offset: 1px;
}
.archive-search input::placeholder {
	color: #a4a4a4;
}
.archive-sort {
	display: flex;
	align-items: center;
	gap: 9px;
	color: var(--data-muted);
	font-size: var(--settings-body-size);
	white-space: nowrap;
}
.archive-management select {
	border: 1px solid var(--data-line);
	border-radius: 10px;
	padding: 6px 10px;
	background: var(--surface);
	color: var(--ink);
	font-size: var(--settings-body-size);
	min-width: 0;
	height: 34px;
}
.archive-projects {
	display: grid;
	gap: 6px;
}
.archive-project-header {
	display: flex;
	align-items: center;
	gap: 12px;
	height: 36px;
}
.archive-project-open {
	display: flex;
	align-items: center;
	gap: 10px;
	min-width: 0;
	font-size: var(--settings-section-heading-size);
}
.archive-project-open > span:nth-child(2) {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.archive-project-open > span:first-child {
	color: var(--data-muted);
	font-size: 19px;
}
.archive-project-open > span:last-child {
	color: var(--data-muted);
	font-size: 14px;
}
.archive-count {
	margin-left: auto;
	font-size: var(--settings-caption-size);
	color: var(--data-muted);
	white-space: nowrap;
}
.archive-menu {
	display: grid;
	place-items: center;
	padding: 5px;
	border-radius: 6px;
	font-size: 17px;
	color: var(--data-muted);
}
.archive-menu:hover {
	background: var(--data-control);
	color: var(--ink);
}
.archived-session-list {
	margin-top: 8px;
	background: var(--data-card);
	border: 1px solid var(--data-line);
	border-radius: 16px;
	padding: 0 18px;
}
.archived-session {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 18px 0;
}
.archived-session + .archived-session {
	border-top: 1px solid var(--data-line);
}
.archived-session > div {
	flex: 1;
	display: grid;
	gap: 5px;
	min-width: 0;
}
.archived-session strong {
	font-size: var(--settings-body-size);
	font-weight: 500;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.archived-session time {
	font-size: var(--settings-caption-size);
	color: var(--data-muted);
}
.archive-restore {
	font-size: var(--settings-body-size);
	padding: 5px 9px;
	border-radius: 8px;
	background: var(--data-control);
	white-space: nowrap;
}
.archive-empty {
	text-align: center;
	color: var(--data-muted);
	font-size: var(--settings-caption-size);
	padding: 32px;
}
.archive-confirm {
	display: grid;
	gap: 20px;
	font-size: var(--settings-body-size, 13px);
}
@media (max-width: 1200px) {
	.archive-sort > span {
		display: none;
	}
	.archive-filters {
		grid-template-columns: minmax(120px, 1fr) 125px 150px;
	}
}
</style>
