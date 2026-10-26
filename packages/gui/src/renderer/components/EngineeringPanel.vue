<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { GitDiff, GitFileChange, GitStatus } from "../../shared/git.ts";
import { createLogger } from "../../shared/logger.ts";
import { UButton } from "../ui.ts";
import MonacoDiff from "./MonacoDiff.vue";
import TerminalPanel from "./TerminalPanel.vue";
import WorktreePanel from "./WorktreePanel.vue";

const props = defineProps<{ cwd: string }>();
const emit = defineEmits<{ review: [text: string]; "open-worktree": [cwd: string] }>();
const bridge = window.piDesktop;
const logger = createLogger("review");
const activeTab = ref<"changes" | "worktrees" | "terminal">("changes");
const status = ref<GitStatus | null>(null);
const statusError = ref("");
const loading = ref(false);
const selected = ref<GitFileChange | null>(null);
const selectedStaged = ref(false);
const diff = ref<GitDiff | null>(null);
const diffError = ref("");
const diffLoading = ref(false);
const mutating = ref(false);
const mutationError = ref("");
const diffView = ref<{ getLocation(): { line: number; side: "left" | "right" } } | null>(null);
const comments = ref<
	Array<{
		path: string;
		originalPath?: string;
		line: number;
		side: "left" | "right";
		staged: boolean;
		version: string;
		text: string;
	}>
>([]);
const sendingFeedback = ref(false);
const commenting = ref(false);
const commentLine = ref(1);
const commentSide = ref<"left" | "right">("right");
const commentText = ref("");
const commentError = ref("");
let statusRequest = 0;
let diffRequest = 0;
let disposed = false;

const files = computed(() => status.value?.files ?? []);
const branchLabel = computed(() => {
	const value = status.value;
	if (!value) return "";
	const parts = [value.branch];
	if (value.ahead) parts.push(`↑${value.ahead}`);
	if (value.behind) parts.push(`↓${value.behind}`);
	return parts.join(" · ");
});
const summary = computed(() => {
	if (!status.value) return "";
	return `${files.value.length} 个文件有改动`;
});
const currentComments = computed(() => comments.value.filter((comment) => comment.path === diff.value?.path));

function message(error: unknown): string {
	return error instanceof Error ? error.message : "无法读取 Git 状态";
}

function letter(file: GitFileChange): string {
	if (file.untracked) return "U";
	if (file.index === "R" || file.worktree === "R") return "R";
	if (file.index === "A" || file.worktree === "A") return "A";
	if (file.index === "D" || file.worktree === "D") return "D";
	if (file.index === "M" || file.worktree === "M") return "M";
	return "?";
}

function select(file: GitFileChange, staged = file.staged && !file.unstaged): void {
	selected.value = file;
	selectedStaged.value = staged;
	commenting.value = false;
	commentText.value = "";
	commentError.value = "";
	void loadDiff(file);
}

function beginComment(): void {
	if (!diff.value) return;
	const location = diffView.value?.getLocation() ?? { line: 1, side: "right" as const };
	commentLine.value = location.line;
	commentSide.value = location.side;
	commentText.value = "";
	commentError.value = "";
	commenting.value = true;
}

function addComment(): void {
	const text = commentText.value.trim();
	if (!text) {
		commentError.value = "请输入评论内容";
		return;
	}
	const path = diff.value?.path;
	if (!path) return;
	/*
	 * ========================================================================
	 * 步骤1：将行评论绑定到用户查看的差异
	 * ========================================================================
	 * 数据源：当前差异摘要、左右侧和光标行号。
	 * 操作：1) 保留评审版本；2) 限制评论数量，避免无限累积。
	 */
	logger.info("开始保存行评论定位");
	try {
		// 1.1 版本变化后必须重新评论，不能把旧行号套到新内容。
		if (!diff.value || comments.value.length >= 100) {
			commentError.value = "每次最多保留 100 条评论";
			return;
		}
		comments.value.push({
			path,
			originalPath: diff.value.originalPath,
			line: commentLine.value,
			side: commentSide.value,
			staged: selectedStaged.value,
			version: diff.value.version,
			text,
		});
	} finally {
		logger.info("行评论定位保存结束");
	}
	commentText.value = "";
	commenting.value = false;
	commentError.value = "";
}

function removeComment(index: number): void {
	const target = currentComments.value[index];
	if (!target) return;
	comments.value = comments.value.filter((comment) => comment !== target);
}

async function sendFeedback(): Promise<void> {
	/*
	 * ========================================================================
	 * 步骤2：重新验证行评论版本后写入草稿
	 * ========================================================================
	 * 数据源：主进程重新读取的差异，不按时间推断定位有效性。
	 * 操作：1) 逐个核对评论版本；2) 有一条过期就保留评论并提示重审。
	 */
	if (comments.value.length === 0 || sendingFeedback.value) return;
	logger.info("开始核对行评论版本");
	sendingFeedback.value = true;
	commentError.value = "";
	try {
		// 2.1 同一份文件版本只查询一次。
		const checked = new Map<string, string>();
		const pending = [...comments.value];
		for (const comment of pending) {
			const key = JSON.stringify([comment.path, comment.originalPath, comment.staged]);
			let version = checked.get(key);
			if (!version) {
				version = (
					await bridge.gitDiff({
						cwd: props.cwd,
						path: comment.path,
						originalPath: comment.originalPath,
						staged: comment.staged,
					})
				).version;
				checked.set(key, version);
			}
			if (version !== comment.version) throw new Error(`「${comment.path}」已变化，请删除旧评论并重新核对`);
		}
		if (disposed) return;
		if (JSON.stringify(pending) !== JSON.stringify(comments.value)) throw new Error("评论已变化，请重新核对后发送");
		// 2.2 只写入草稿，不自动发送模型请求。
		emit(
			"review",
			[
				"行评论反馈：",
				...pending.map(
					(comment) =>
						`- ${comment.path}:${comment.line} (${comment.side === "left" ? "原始侧" : "修改侧"}，${comment.staged ? "暂存区" : "工作区"}，版本 ${comment.version}) — ${comment.text}`,
				),
			].join("\n"),
		);
	} catch (error) {
		commentError.value = message(error);
	} finally {
		sendingFeedback.value = false;
		logger.info("行评论版本核对结束");
	}
}

async function loadDiff(file: GitFileChange): Promise<void> {
	const request = ++diffRequest;
	diffLoading.value = true;
	diffError.value = "";
	diff.value = null;
	try {
		const next = await bridge.gitDiff({
			cwd: props.cwd,
			path: file.path,
			originalPath: file.originalPath,
			staged: selectedStaged.value,
		});
		if (request === diffRequest) diff.value = next;
	} catch (error) {
		if (request === diffRequest) diffError.value = message(error);
	} finally {
		if (request === diffRequest) diffLoading.value = false;
	}
}

async function refresh(): Promise<void> {
	const request = ++statusRequest;
	loading.value = true;
	statusError.value = "";
	try {
		const next = await bridge.gitStatus(props.cwd);
		if (request !== statusRequest) return;
		applyStatus(next, true);
	} catch (error) {
		if (request === statusRequest) {
			status.value = null;
			selected.value = null;
			diff.value = null;
			statusError.value = message(error);
		}
	} finally {
		if (request === statusRequest) loading.value = false;
	}
}

function applyStatus(next: GitStatus, preserveStage = false): void {
	status.value = next;
	const previous = selected.value;
	const current = previous
		? next.files.find((file) => file.path === previous.path && file.originalPath === previous.originalPath)
		: undefined;
	if (current) select(current, preserveStage ? selectedStaged.value : undefined);
	else if (next.files[0]) select(next.files[0]);
	else {
		selected.value = null;
		diff.value = null;
	}
}

async function mutate(action: "stage" | "unstage" | "discard"): Promise<void> {
	const file = selected.value;
	const current = status.value;
	const version = diff.value?.version;
	if (!file || !current || !version || mutating.value) return;
	if (action === "discard" && !window.confirm(`确定还原「${file.path}」的工作区改动？`)) return;
	mutating.value = true;
	mutationError.value = "";
	try {
		const next = await bridge.gitMutate({
			cwd: props.cwd,
			path: file.path,
			originalPath: file.originalPath,
			action,
			expectedHead: current.head,
			expectedIndex: file.index,
			expectedWorktree: file.worktree,
			expectedVersion: version,
		});
		applyStatus(next);
	} catch (error) {
		mutationError.value = message(error);
	} finally {
		mutating.value = false;
	}
}

watch(
	() => props.cwd,
	() => {
		selected.value = null;
		diff.value = null;
		void refresh();
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	disposed = true;
	statusRequest += 1;
	diffRequest += 1;
});
</script>

<template>
	<section class="engineering-panel">
		<header class="engineering-header">
			<div>
				<p class="engineering-kicker">工程</p>
				<h2>
					{{ activeTab === "changes" ? "工作区改动" : activeTab === "worktrees" ? "工作树" : "终端" }}
				</h2>
				<p v-if="status && activeTab === 'changes'" class="engineering-meta">
					<span>{{ branchLabel }}</span
					><span>·</span><span>{{ summary }}</span>
				</p>
			</div>
			<div class="engineering-header-end">
				<div class="engineering-tabs">
					<button type="button" :class="{ active: activeTab === 'changes' }" @click="activeTab = 'changes'">
						改动
					</button>
					<button type="button" :class="{ active: activeTab === 'worktrees' }" @click="activeTab = 'worktrees'">
						工作树
					</button>
					<button type="button" :class="{ active: activeTab === 'terminal' }" @click="activeTab = 'terminal'">
						终端
					</button>
				</div>
				<UButton
					v-if="activeTab === 'changes'"
					icon="i-lucide-refresh-cw"
					color="neutral"
					variant="ghost"
					size="sm"
					aria-label="刷新 Git 状态"
					title="刷新 Git 状态"
					:loading="loading"
					@click="refresh"
				/>
			</div>
		</header>

		<TerminalPanel v-if="activeTab === 'terminal'" :cwd="cwd" />
		<WorktreePanel v-else-if="activeTab === 'worktrees'" :cwd="cwd" @open="emit('open-worktree', $event)" />
		<div v-else class="engineering-body">
			<aside class="change-list" aria-label="改动文件">
				<div v-if="loading && !status" class="engineering-empty">正在读取 Git 状态…</div>
				<div v-else-if="statusError" class="engineering-empty error">
					<strong>无法打开工程面板</strong>
					<span>{{ statusError }}</span>
					<UButton color="neutral" variant="outline" size="xs" @click="refresh">重试</UButton>
				</div>
				<div v-else-if="files.length === 0" class="engineering-empty">
					<strong>工作区没有未提交改动</strong>
					<span>修改文件后刷新即可核对差异。</span>
				</div>
				<div v-else class="change-rows">
					<button
						v-for="file in files"
						:key="`${file.originalPath ?? ''}:${file.path}`"
						type="button"
						class="change-row"
						:class="{ active: selected?.path === file.path && selected?.originalPath === file.originalPath }"
						@click="select(file)"
					>
						<span class="change-letter" :class="letter(file).toLowerCase()">{{ letter(file) }}</span>
						<span class="change-path" :title="file.path">{{ file.path }}</span>
						<span class="change-flags">
							<em v-if="file.staged">暂存</em>
							<em v-if="file.untracked" class="untracked">未跟踪</em>
							<em v-else-if="file.unstaged && !file.staged">未暂存</em>
						</span>
					</button>
				</div>
			</aside>

			<section class="diff-area" aria-label="文件差异">
				<div v-if="diffLoading" class="engineering-empty">正在读取文件差异…</div>
				<div v-else-if="diffError" class="engineering-empty error">
					<strong>无法读取差异</strong>
					<span>{{ diffError }}</span>
				</div>
				<div v-else-if="!diff" class="engineering-empty">
					<strong>选择一个文件</strong>
					<span>查看工作区与暂存区之间的差异。</span>
				</div>
				<template v-else>
					<div class="diff-toolbar">
						<div class="diff-file">
							<strong>{{ diff.path }}</strong>
							<span v-if="diff.originalPath">← {{ diff.originalPath }}</span>
						</div>
						<div class="diff-toolbar-end">
							<div v-if="selected?.staged && selected?.unstaged" class="diff-switch">
								<button type="button" :class="{ active: !selectedStaged }" @click="select(selected, false)">
									工作区
								</button>
								<button type="button" :class="{ active: selectedStaged }" @click="select(selected, true)">
									已暂存
								</button>
							</div>
							<div class="diff-actions">
								<UButton
									v-if="selected?.staged"
									color="neutral"
									variant="ghost"
									size="xs"
									:loading="mutating"
									@click="mutate('unstage')"
									>取消暂存</UButton
								>
								<UButton
									v-if="selected?.unstaged || selected?.untracked"
									color="neutral"
									variant="outline"
									size="xs"
									:loading="mutating"
									@click="mutate('stage')"
									>暂存</UButton
								>
								<UButton
									v-if="selected?.unstaged && !selected?.untracked"
									color="error"
									variant="ghost"
									size="xs"
									:loading="mutating"
									@click="mutate('discard')"
									>还原</UButton
								>
								<UButton color="neutral" variant="ghost" size="xs" @click="beginComment">行评论</UButton>
							</div>
						</div>
					</div>
					<p v-if="mutationError" class="engineering-inline-error" role="alert">{{ mutationError }}</p>
					<div v-if="diff.binary" class="engineering-empty">
						<strong>二进制文件</strong>
						<span>当前版本只显示文本差异。</span>
					</div>
					<div v-else-if="diff.truncated" class="engineering-empty">
						<strong>文件过大</strong>
						<span>差异超过 1.5 MiB，已停止加载。</span>
					</div>
					<MonacoDiff
						v-else
						ref="diffView"
						:key="`${diff.path}:${selectedStaged}`"
						:original="diff.original"
						:modified="diff.modified"
						:path="diff.path"
					/>
					<div v-if="commenting || currentComments.length" class="review-comments">
						<div class="review-head">
							<strong>行评论</strong>
							<UButton
								v-if="comments.length"
								color="neutral"
								variant="outline"
								size="xs"
								:loading="sendingFeedback"
								@click="sendFeedback"
								>发送给 Agent</UButton
							>
						</div>
						<div
							v-for="(comment, index) in currentComments"
							:key="`${comment.path}:${comment.line}:${index}`"
							class="review-item"
						>
							<span>{{ comment.side === "left" ? "原始" : "修改" }} L{{ comment.line }}</span>
							<p>{{ comment.text }}</p>
							<button type="button" aria-label="删除评论" @click="removeComment(index)">×</button>
						</div>
						<div v-if="commenting" class="review-editor">
							<span>第 {{ commentLine }} 行</span>
							<textarea
								v-model="commentText"
								rows="2"
								placeholder="写下对这一行的评论…"
								@keydown.ctrl.enter.prevent="addComment"
								@keydown.meta.enter.prevent="addComment"
							></textarea>
							<div class="review-actions">
								<UButton color="neutral" size="xs" @click="addComment">添加</UButton>
								<UButton color="neutral" variant="ghost" size="xs" @click="commenting = false">取消</UButton>
							</div>
							<p v-if="commentError" class="review-error">{{ commentError }}</p>
						</div>
						<p v-if="commentError && !commenting" class="review-error" role="alert">{{ commentError }}</p>
					</div>
				</template>
			</section>
		</div>
	</section>
</template>
