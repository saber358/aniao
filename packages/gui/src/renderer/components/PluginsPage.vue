<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { PluginCatalogItem, PluginPackage, PluginScope } from "../../shared/plugins.ts";
import { PLUGIN_CATALOG } from "../../shared/plugins.ts";
import type { ResourceExtension, ResourceSnapshot } from "../../shared/resources.ts";
import { UButton, UIcon, UInput, UModal } from "../ui.ts";

const props = defineProps<{
	cwd: string;
	resources: ResourceSnapshot | null;
}>();

const installed = ref<PluginPackage[]>([]);
const loading = ref(false);
const busy = ref("");
const error = ref("");
const notice = ref("");
const catalogOpen = ref(false);
const addOpen = ref(false);
const source = ref("npm:");
const installingId = ref("");

const installedSources = computed(() => new Set(installed.value.map((item) => item.source)));
function builtinExtension(extension: ResourceExtension) {
	if (extension.source === "inline") {
		if (extension.tools.includes("codemode"))
			return { name: "Codemode", description: "官方内置的代码执行模式", icon: "i-lucide-code-xml" };
		if (extension.tools.includes("tool_search"))
			return { name: "Tool Search", description: "官方内置的工具搜索", icon: "i-lucide-search" };
		if (extension.commands.includes("mcp"))
			return { name: "MCP", description: "官方内置的 Model Context Protocol 支持", icon: "i-lucide-plug" };
	}
	return {
		name: extension.name,
		description: [`工具 ${extension.tools.length}`, `命令 ${extension.commands.length}`, extension.source]
			.filter(Boolean)
			.join(" · "),
		icon: "i-lucide-puzzle",
	};
}
const builtins = computed(() => {
	const extensions = (props.resources?.extensions ?? []).map((extension) => {
		const info = builtinExtension(extension);
		return {
			id: `extension:${extension.path}`,
			name: info.name,
			description: info.description,
			icon: info.icon,
			kind: extension.source === "inline" ? "官方" : "扩展",
		};
	});
	const skills = (props.resources?.skills ?? []).map((skill) => ({
		id: `skill:${skill.path}`,
		name: skill.name,
		description: skill.description || skill.path,
		icon: "i-lucide-sparkles",
		kind: "技能",
	}));
	return [...extensions, ...skills];
});
const diagnostics = computed(() => props.resources?.diagnostics ?? []);

function packageName(source: string): string {
	return source.replace(/^npm:/u, "").replace(/^git:/u, "") || source;
}

function scopeLabel(scope: PluginScope): string {
	return scope === "project" ? "项目" : "用户";
}

function typeLabel(type: PluginCatalogItem["type"]): string {
	if (type === "skill") return "技能";
	if (type === "package") return "包";
	return "扩展";
}

function isInstalled(source: string): boolean {
	return installedSources.value.has(source);
}

async function load(): Promise<void> {
	if (!props.cwd) return;
	loading.value = true;
	error.value = "";
	try {
		installed.value = await window.piDesktop.listPlugins(props.cwd);
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : "读取插件失败";
	} finally {
		loading.value = false;
	}
}

async function install(itemSource: string, id = ""): Promise<void> {
	if (busy.value || !props.cwd) return;
	busy.value = itemSource;
	installingId.value = id;
	error.value = "";
	notice.value = "";
	try {
		installed.value = await window.piDesktop.installPlugin(props.cwd, itemSource);
		notice.value = "安装完成。重启 Aniao 后新插件才会加载。";
		source.value = "npm:";
		addOpen.value = false;
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : "插件安装失败";
	} finally {
		busy.value = "";
		installingId.value = "";
	}
}

async function remove(item: PluginPackage): Promise<void> {
	if (busy.value || !props.cwd) return;
	if (!window.confirm(`移除插件 ${packageName(item.source)}？`)) return;
	busy.value = item.source;
	error.value = "";
	notice.value = "";
	try {
		installed.value = await window.piDesktop.removePlugin(props.cwd, item.source, item.scope);
		notice.value = "已移除。重启 Aniao 后生效。";
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : "插件移除失败";
	} finally {
		busy.value = "";
	}
}

watch(
	() => props.cwd,
	() => void load(),
);
onMounted(() => void load());
</script>

<template>
	<section class="plugin-page">
		<div class="plugin-inner">
			<header class="plugin-head">
				<div>
					<h1>插件</h1>
					<p>用 Pi 包扩展 Agent 的工具、技能和命令。第三方插件拥有系统权限，只安装可信来源。</p>
				</div>
			</header>

			<div class="plugin-toolbar">
				<div class="plugin-count">
					<strong>已安装</strong>
					<span>{{ installed.length }}</span>
				</div>
				<div class="plugin-actions">
					<UButton
						color="neutral"
						variant="ghost"
						icon="i-lucide-refresh-cw"
						aria-label="刷新插件"
						:loading="loading"
						@click="load"
					/>
					<UButton color="neutral" variant="outline" @click="catalogOpen = true">浏览插件市场</UButton>
					<UButton color="neutral" variant="solid" icon="i-lucide-plus" @click="addOpen = true"> 添加 </UButton>
				</div>
			</div>

			<p v-if="error" class="plugin-error" role="alert">{{ error }}</p>
			<p v-if="notice" class="plugin-notice" role="status">{{ notice }}</p>

			<div v-if="installed.length === 0" class="plugin-empty">
				<UIcon name="i-lucide-package" aria-hidden="true" />
				<strong>尚未安装插件</strong>
				<p>浏览并安装插件，以添加 MCP、网页访问、子 Agent、LSP、Todo 等能力。</p>
				<UButton color="neutral" variant="solid" icon="i-lucide-store" @click="catalogOpen = true">
					浏览插件市场
				</UButton>
			</div>
			<div v-else class="installed-list">
				<article v-for="item in installed" :key="item.source" class="installed-row">
					<div class="installed-main">
						<span class="plugin-row-icon"><UIcon name="i-lucide-package" aria-hidden="true" /></span>
						<div>
							<div class="plugin-name-line">
								<strong>{{ packageName(item.source) }}</strong>
								<span class="plugin-status">已启用</span>
								<span class="plugin-scope">{{ scopeLabel(item.scope) }}</span>
							</div>
							<p>{{ item.source }}</p>
							<small v-if="item.path">{{ item.path }}</small>
						</div>
					</div>
					<UButton
						color="neutral"
						variant="ghost"
						icon="i-lucide-trash-2"
						aria-label="移除插件"
						:loading="busy === item.source"
						@click="remove(item)"
					/>
				</article>
			</div>

			<section class="builtin-section">
				<header class="builtin-head">
					<div>
						<h2>内置能力</h2>
						<p>由当前 Pi 会话加载。安装的插件包重启后会加入这里。</p>
					</div>
					<span>{{ builtins.length }}</span>
				</header>
				<div v-if="builtins.length === 0" class="builtin-empty">当前会话没有已加载的扩展或技能。</div>
				<div v-else class="builtin-list">
					<article v-for="item in builtins" :key="item.id" class="builtin-row">
						<span class="plugin-row-icon"><UIcon :name="item.icon" aria-hidden="true" /></span>
						<div class="builtin-main">
							<div class="plugin-name-line">
								<strong>{{ item.name }}</strong>
								<span class="plugin-status builtin-status">{{ item.kind }}</span>
							</div>
							<p>{{ item.description }}</p>
						</div>
						<span class="plugin-enabled">已加载</span>
					</article>
				</div>
				<p v-if="diagnostics.length" class="plugin-diagnostics">
					{{ diagnostics.length }} 条资源加载诊断。可在设置 → 内置插件中查看。
				</p>
			</section>
		</div>

		<UModal v-model:open="catalogOpen" title="插件市场" description="精选 Pi 社区扩展。安装后重启 Aniao 生效。">
			<template #body>
				<div class="market-list">
					<article v-for="item in PLUGIN_CATALOG" :key="item.id" class="market-card">
						<span class="market-icon"><UIcon :name="item.icon" aria-hidden="true" /></span>
						<div class="market-main">
							<div class="plugin-name-line">
								<strong>{{ item.name }}</strong>
								<span class="plugin-status">{{ typeLabel(item.type) }}</span>
								<span class="market-author">{{ item.author }}</span>
							</div>
							<p>{{ item.description }}</p>
							<small>{{ item.source }}</small>
						</div>
						<UButton
							color="neutral"
							:variant="isInstalled(item.source) ? 'ghost' : 'solid'"
							:disabled="isInstalled(item.source)"
							:loading="installingId === item.id"
							@click="install(item.source, item.id)"
						>
							{{ isInstalled(item.source) ? "已安装" : "安装" }}
						</UButton>
					</article>
				</div>
			</template>
		</UModal>

		<UModal v-model:open="addOpen" title="添加插件" description="支持 npm、Git 或本地路径来源。">
			<template #body>
				<div class="add-plugin-form">
					<label for="plugin-source">插件来源</label>
					<UInput
						id="plugin-source"
						v-model="source"
						placeholder="npm:pi-mcp-adapter"
						autocomplete="off"
						spellcheck="false"
					/>
					<p>
						示例：<code>npm:pi-web-access</code>、<code>git:github.com/user/repo</code>、<code
							>D:\\plugins\\my-plugin</code
						>
					</p>
					<p v-if="error" class="plugin-error" role="alert">{{ error }}</p>
					<div class="add-actions">
						<UButton color="neutral" variant="ghost" @click="addOpen = false">取消</UButton>
						<UButton color="neutral" variant="solid" :loading="!!busy" @click="install(source.trim())">
							安装
						</UButton>
					</div>
				</div>
			</template>
		</UModal>
	</section>
</template>

<style scoped>
.plugin-page {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	background: var(--surface);
}
.plugin-inner {
	width: min(100%, 1000px);
	margin: 0 auto;
	padding: 34px 38px 48px;
}
.plugin-head h1 {
	margin: 0;
	color: var(--ink);
	font-size: 24px;
	font-weight: 650;
	letter-spacing: -0.5px;
}
.plugin-head p {
	max-width: 680px;
	margin: 7px 0 0;
	color: var(--muted);
	font-size: 12px;
	line-height: 1.65;
}
.plugin-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	margin: 28px 0 14px;
}
.plugin-count {
	display: flex;
	align-items: baseline;
	gap: 8px;
	color: var(--ink);
	font-size: 15px;
}
.plugin-count span {
	color: var(--faint);
	font-size: 12px;
}
.plugin-actions {
	display: flex;
	align-items: center;
	gap: 7px;
}
.plugin-error,
.plugin-notice {
	margin: 0 0 12px;
	padding: 8px 10px;
	border-radius: 7px;
	font-size: 11px;
}
.plugin-error {
	background: #fff1f0;
	color: #b42318;
}
.plugin-notice {
	background: var(--sage-soft);
	color: var(--sage);
}
.plugin-empty {
	display: grid;
	justify-items: center;
	gap: 8px;
	padding: 40px 20px;
	border: 1px dashed var(--line);
	border-radius: 12px;
	background: var(--surface-raised);
	text-align: center;
}
.plugin-empty > svg {
	color: var(--faint);
	font-size: 22px;
}
.plugin-empty strong {
	color: var(--ink);
	font-size: 13px;
	font-weight: 550;
}
.plugin-empty p {
	max-width: 480px;
	margin: 0 0 4px;
	color: var(--faint);
	font-size: 11px;
	line-height: 1.5;
}
.installed-list {
	display: grid;
	gap: 8px;
}
.installed-row,
.builtin-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 14px;
	padding: 12px 13px;
	border: 1px solid var(--line-soft);
	border-radius: 10px;
	background: var(--surface-raised);
}
.installed-main {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	min-width: 0;
	flex: 1;
}
.plugin-row-icon {
	display: grid;
	flex: none;
	width: 30px;
	height: 30px;
	place-items: center;
	border-radius: 8px;
	background: var(--active);
	color: var(--muted);
	font-size: 15px;
}
.installed-main > div,
.builtin-main {
	display: grid;
	gap: 3px;
	min-width: 0;
	flex: 1;
}
.plugin-name-line {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 6px;
}
.plugin-name-line strong {
	color: var(--ink);
	font-size: 12px;
	font-weight: 550;
}
.plugin-status,
.plugin-scope {
	padding: 1px 5px;
	border-radius: 4px;
	background: var(--active);
	color: var(--faint);
	font-size: 9px;
}
.builtin-status {
	background: var(--sage-soft);
	color: var(--sage);
}
.plugin-scope {
	background: transparent;
}
.installed-main p,
.builtin-main p {
	overflow: hidden;
	margin: 0;
	color: var(--faint);
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 9px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.installed-main small {
	overflow: hidden;
	color: var(--faint);
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 9px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.builtin-section {
	margin-top: 28px;
	padding-top: 20px;
	border-top: 1px solid var(--line-soft);
}
.builtin-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 10px;
}
.builtin-head h2 {
	margin: 0;
	color: var(--ink);
	font-size: 13px;
	font-weight: 550;
}
.builtin-head p {
	margin: 3px 0 0;
	color: var(--faint);
	font-size: 10px;
}
.builtin-head > span {
	color: var(--faint);
	font-size: 10px;
}
.builtin-list {
	display: grid;
	gap: 2px;
}
.builtin-row {
	border-color: transparent;
	background: transparent;
	padding: 8px 4px;
}
.builtin-row:hover {
	background: var(--card-hover);
}
.plugin-enabled {
	flex: none;
	color: var(--faint);
	font-size: 10px;
}
.builtin-empty,
.plugin-diagnostics {
	margin: 0;
	padding: 12px 4px;
	color: var(--faint);
	font-size: 11px;
}
.market-list {
	display: grid;
	gap: 8px;
	max-height: min(560px, 70vh);
	overflow-y: auto;
	padding: 2px;
}
.market-card {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	padding: 12px;
	border: 1px solid var(--line-soft);
	border-radius: 10px;
}
.market-icon {
	display: grid;
	flex: none;
	width: 32px;
	height: 32px;
	place-items: center;
	border-radius: 8px;
	background: var(--active);
	color: var(--muted);
	font-size: 16px;
}
.market-main {
	display: grid;
	gap: 3px;
	min-width: 0;
	flex: 1;
}
.market-author {
	color: var(--faint);
	font-size: 9px;
}
.market-main p {
	margin: 0;
	color: var(--muted);
	font-size: 10px;
	line-height: 1.5;
}
.market-main small {
	overflow: hidden;
	color: var(--faint);
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 9px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.add-plugin-form {
	display: grid;
	gap: 8px;
}
.add-plugin-form label {
	color: var(--muted);
	font-size: 11px;
}
.add-plugin-form p {
	margin: 0;
	color: var(--faint);
	font-size: 10px;
	line-height: 1.5;
}
.add-plugin-form code {
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 9px;
}
.add-actions {
	display: flex;
	justify-content: flex-end;
	gap: 6px;
	padding-top: 4px;
}
@media (max-width: 720px) {
	.plugin-inner {
		padding: 24px 18px 40px;
	}
	.plugin-toolbar {
		align-items: flex-start;
		flex-direction: column;
	}
	.market-card {
		flex-wrap: wrap;
	}
}
</style>
