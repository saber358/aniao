<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { GitWorktree } from "../../shared/git-worktree.ts";
import { UButton } from "../ui.ts";

const props = defineProps<{ cwd: string }>();
const emit = defineEmits<{ open: [cwd: string] }>();
const bridge = window.piDesktop;
const worktrees = ref<GitWorktree[]>([]);
const loading = ref(false);
const error = ref("");
const branch = ref("");
const baseRef = ref("HEAD");
const creating = ref(false);
const createError = ref("");

function message(reason: unknown): string {
	return reason instanceof Error ? reason.message : "工作树操作失败";
}

async function refresh(): Promise<void> {
	loading.value = true;
	error.value = "";
	try {
		worktrees.value = await bridge.listWorktrees(props.cwd);
	} catch (reason) {
		error.value = message(reason);
	} finally {
		loading.value = false;
	}
}

async function create(): Promise<void> {
	if (!branch.value.trim() || creating.value) return;
	creating.value = true;
	createError.value = "";
	try {
		await bridge.createWorktree({
			cwd: props.cwd,
			branch: branch.value.trim(),
			baseRef: baseRef.value.trim() || "HEAD",
		});
		branch.value = "";
		baseRef.value = "HEAD";
		await refresh();
	} catch (reason) {
		createError.value = message(reason);
	} finally {
		creating.value = false;
	}
}

async function remove(worktree: GitWorktree): Promise<void> {
	if (worktree.current || !window.confirm(`移除工作树「${worktree.path}」？分支会保留。`)) return;
	error.value = "";
	try {
		worktrees.value = await bridge.removeWorktree({
			cwd: props.cwd,
			path: worktree.path,
			expectedHead: worktree.head,
		});
	} catch (reason) {
		error.value = message(reason);
	}
}

onMounted(() => {
	void refresh();
});
</script>

<template>
	<div class="worktree-panel">
		<div class="worktree-intro">
			<p>为并行任务创建独立目录。分支被其他工作树占用时不会重复创建；移除前会检查未提交和忽略文件。</p>
			<UButton
				icon="i-lucide-refresh-cw"
				color="neutral"
				variant="ghost"
				size="xs"
				:loading="loading"
				aria-label="刷新工作树"
				@click="refresh"
			/>
		</div>

		<form class="worktree-create" @submit.prevent="create">
			<label>
				<span>新分支</span>
				<input v-model="branch" placeholder="feature/my-change" maxlength="120" />
			</label>
			<label>
				<span>起点</span>
				<input v-model="baseRef" placeholder="HEAD" maxlength="200" />
			</label>
			<UButton type="submit" color="neutral" size="sm" :loading="creating" :disabled="!branch.trim()">
				创建工作树
			</UButton>
		</form>
		<p v-if="createError" class="worktree-error" role="alert">{{ createError }}</p>

		<div v-if="error" class="worktree-error" role="alert">{{ error }}</div>
		<div v-if="loading && worktrees.length === 0" class="engineering-empty">正在读取工作树…</div>
		<div v-else-if="worktrees.length === 0" class="engineering-empty">
			<strong>还没有工作树</strong>
			<span>从当前仓库创建一个独立分支目录。</span>
		</div>
		<div v-else class="worktree-list">
			<div v-for="worktree in worktrees" :key="worktree.path" class="worktree-row">
				<div class="worktree-info">
					<div>
						<strong>{{ worktree.branch ?? "detached HEAD" }}</strong>
						<em v-if="worktree.current">当前</em>
					</div>
					<span :title="worktree.path">{{ worktree.path }}</span>
					<small>{{ worktree.head.slice(0, 10) }}</small>
				</div>
				<div class="worktree-actions">
					<UButton color="neutral" variant="outline" size="xs" @click="emit('open', worktree.path)">
						打开
					</UButton>
					<UButton color="error" variant="ghost" size="xs" :disabled="worktree.current" @click="remove(worktree)">
						移除
					</UButton>
				</div>
			</div>
		</div>
	</div>
</template>
