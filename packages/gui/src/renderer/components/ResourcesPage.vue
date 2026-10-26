<script setup lang="ts">
import { computed, ref } from "vue";
import type { ResourceSnapshot } from "../../shared/resources.ts";
import { UIcon } from "../ui.ts";

type ResourceTab = "extensions" | "skills" | "prompts" | "commands" | "diagnostics";

const props = defineProps<{ resources: ResourceSnapshot | null }>();
const active = ref<ResourceTab>("extensions");
const tabs = computed(() => [
	{ id: "extensions" as const, label: "扩展", count: props.resources?.extensions.length ?? 0 },
	{ id: "skills" as const, label: "技能", count: props.resources?.skills.length ?? 0 },
	{ id: "prompts" as const, label: "模板", count: props.resources?.prompts.length ?? 0 },
	{ id: "commands" as const, label: "命令", count: props.resources?.commands.length ?? 0 },
	{ id: "diagnostics" as const, label: "诊断", count: props.resources?.diagnostics.length ?? 0 },
]);
const total = computed(() =>
	props.resources
		? props.resources.extensions.length +
			props.resources.skills.length +
			props.resources.prompts.length +
			props.resources.commands.length
		: 0,
);

function scopeLabel(scope: string): string {
	if (scope === "project") return "项目";
	if (scope === "user") return "用户";
	if (scope === "temporary") return "临时";
	return "未知";
}
</script>

<template>
	<section class="main-page resources-page">
		<div class="main-page-inner">
			<header class="page-head">
				<div>
					<h1>插件</h1>
					<p>查看当前会话已加载的扩展、技能、模板、命令和诊断。资源由宿主发现，界面只读展示。</p>
				</div>
				<span class="page-count">{{ total }} 项资源</span>
			</header>

			<div v-if="!resources" class="page-empty">当前会话没有资源快照，连接宿主后可查看。</div>
			<template v-else>
				<section class="overview-grid">
					<button
						v-for="tab in tabs.slice(0, 4)"
						:key="tab.id"
						type="button"
						class="overview-card"
						:class="{ active: active === tab.id }"
						@click="active = tab.id"
					>
						<span class="overview-icon">
							<UIcon
								:name="
									tab.id === 'extensions'
										? 'i-lucide-puzzle'
										: tab.id === 'skills'
											? 'i-lucide-sparkles'
											: tab.id === 'prompts'
												? 'i-lucide-file-text'
												: 'i-lucide-terminal'
								"
								aria-hidden="true"
							/>
						</span>
						<span class="overview-copy">
							<strong>{{ tab.label }}</strong>
							<small>{{ tab.count }} 项已加载</small>
						</span>
					</button>
				</section>

				<section class="page-section">
					<header class="section-head">
						<div>
							<h2>资源明细</h2>
							<p>诊断 {{ resources.diagnostics.length }} 条 · 仅展示宿主快照</p>
						</div>
						<div class="page-tabs" role="tablist" aria-label="资源类型">
							<button
								v-for="tab in tabs"
								:key="tab.id"
								type="button"
								role="tab"
								:aria-selected="active === tab.id"
								:class="{ active: active === tab.id }"
								@click="active = tab.id"
							>
								{{ tab.label }}<em>{{ tab.count }}</em>
							</button>
						</div>
					</header>

					<div class="resource-list">
						<template v-if="active === 'extensions'">
							<article v-for="extension in resources.extensions" :key="extension.path" class="resource-row">
								<div class="resource-row-main">
									<strong>{{ extension.name }}</strong>
									<span class="resource-scope">{{ scopeLabel(extension.scope) }}</span>
									<span class="resource-source">{{ extension.source }}</span>
								</div>
								<p>{{ extension.path }}</p>
								<small>
									工具 {{ extension.tools.length }} · 命令 {{ extension.commands.length }}
									<template v-if="extension.tools.length"> · {{ extension.tools.join("、") }}</template>
								</small>
							</article>
							<div v-if="resources.extensions.length === 0" class="page-empty">尚未加载扩展。</div>
						</template>

						<template v-else-if="active === 'skills'">
							<article v-for="skill in resources.skills" :key="skill.path" class="resource-row">
								<div class="resource-row-main">
									<strong>{{ skill.name }}</strong>
									<span class="resource-scope">{{ scopeLabel(skill.scope) }}</span>
									<span v-if="skill.disableModelInvocation" class="resource-flag">仅手动</span>
								</div>
								<p>{{ skill.description }}</p>
								<small>{{ skill.path }}</small>
							</article>
							<div v-if="resources.skills.length === 0" class="page-empty">尚未加载技能。</div>
						</template>

						<template v-else-if="active === 'prompts'">
							<article v-for="prompt in resources.prompts" :key="prompt.path" class="resource-row">
								<div class="resource-row-main">
									<strong>{{ prompt.name }}</strong>
									<span class="resource-scope">{{ scopeLabel(prompt.scope) }}</span>
									<span v-if="prompt.argumentHint" class="resource-source">{{ prompt.argumentHint }}</span>
								</div>
								<p>{{ prompt.description }}</p>
								<small>{{ prompt.path }}</small>
							</article>
							<div v-if="resources.prompts.length === 0" class="page-empty">尚未加载提示模板。</div>
						</template>

						<template v-else-if="active === 'commands'">
							<article
								v-for="command in resources.commands"
								:key="`${command.source}:${command.name}`"
								class="resource-row"
							>
								<div class="resource-row-main">
									<strong>{{ command.name }}</strong>
									<span class="resource-scope">{{ scopeLabel(command.scope) }}</span>
									<span class="resource-source">{{ command.source }}</span>
								</div>
								<p v-if="command.description">{{ command.description }}</p>
								<small v-if="command.path">{{ command.path }}</small>
							</article>
							<div v-if="resources.commands.length === 0" class="page-empty">当前会话没有可用命令。</div>
						</template>

						<template v-else>
							<article
								v-for="(diagnostic, index) in resources.diagnostics"
								:key="index"
								class="resource-row diagnostic"
							>
								<div class="resource-row-main">
									<strong>{{ diagnostic.type }}</strong>
									<span class="resource-source">{{ diagnostic.path ?? "全局" }}</span>
								</div>
								<p>{{ diagnostic.message }}</p>
							</article>
							<div v-if="resources.diagnostics.length === 0" class="page-empty">资源加载没有诊断信息。</div>
						</template>
					</div>
				</section>
			</template>
		</div>
	</section>
</template>

<style scoped>
.main-page {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	background: var(--surface);
}
.main-page-inner {
	width: min(100%, 1000px);
	margin: 0 auto;
	padding: 34px 38px 48px;
}
.page-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 20px;
	margin-bottom: 26px;
}
.page-head h1 {
	margin: 0;
	color: var(--ink);
	font-size: 24px;
	font-weight: 650;
	letter-spacing: -0.5px;
}
.page-head p:not(.page-kicker) {
	max-width: 620px;
	margin: 6px 0 0;
	color: var(--muted);
	font-size: 12px;
	line-height: 1.65;
}
.page-count {
	flex: none;
	padding-top: 22px;
	color: var(--faint);
	font-size: 11px;
}
.overview-grid {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: 8px;
	margin-bottom: 26px;
}
.overview-card {
	display: flex;
	align-items: center;
	gap: 10px;
	min-width: 0;
	padding: 13px;
	border: 1px solid var(--line-soft);
	border-radius: 11px;
	background: var(--surface-raised);
	color: var(--ink);
	cursor: pointer;
	text-align: left;
}
.overview-card:hover,
.overview-card.active {
	border-color: var(--line);
	background: var(--card-hover);
}
.overview-icon {
	display: grid;
	flex: none;
	width: 32px;
	height: 32px;
	place-items: center;
	border-radius: 8px;
	background: var(--sage-soft);
	color: var(--sage);
	font-size: 16px;
}
.overview-copy {
	display: grid;
	gap: 2px;
	min-width: 0;
}
.overview-copy strong {
	font-size: 12px;
	font-weight: 550;
}
.overview-copy small {
	overflow: hidden;
	color: var(--faint);
	font-size: 9px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.page-section {
	border-top: 1px solid var(--line-soft);
	padding-top: 20px;
}
.section-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 18px;
	margin-bottom: 8px;
}
.section-head h2 {
	margin: 0;
	color: var(--ink);
	font-size: 14px;
	font-weight: 550;
}
.section-head p {
	margin: 4px 0 0;
	color: var(--faint);
	font-size: 10px;
}
.page-tabs {
	display: flex;
	gap: 2px;
	flex-wrap: wrap;
	justify-content: flex-end;
}
.page-tabs button {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px 7px;
	border: 1px solid transparent;
	border-radius: 5px;
	background: transparent;
	color: var(--muted);
	cursor: pointer;
	font-size: 10px;
}
.page-tabs button.active {
	border-color: var(--line-soft);
	background: var(--surface-raised);
	color: var(--ink);
}
.page-tabs em {
	color: var(--faint);
	font-size: 8px;
	font-style: normal;
}
.resource-list {
	display: grid;
}
.resource-row {
	display: grid;
	gap: 4px;
	padding: 11px 2px;
	border-bottom: 1px solid var(--line-soft);
}
.resource-row-main {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 7px;
	min-width: 0;
}
.resource-row-main strong {
	overflow: hidden;
	color: var(--ink);
	font-size: 12px;
	font-weight: 550;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.resource-row p {
	margin: 0;
	color: var(--muted);
	font-size: 11px;
	line-height: 1.55;
	white-space: pre-wrap;
}
.resource-row small {
	overflow: hidden;
	color: var(--faint);
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 9px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.resource-scope,
.resource-flag {
	flex: none;
	padding: 2px 5px;
	border-radius: 3px;
	background: var(--sage-soft);
	color: var(--sage);
	font-size: 8px;
}
.resource-flag {
	background: var(--line-soft);
	color: var(--faint);
}
.resource-source {
	overflow: hidden;
	margin-left: auto;
	color: var(--faint);
	font-size: 9px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.resource-row.diagnostic .resource-row-main strong {
	color: #bd5a4b;
}
.page-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	min-height: 120px;
	color: var(--faint);
	font-size: 11px;
	text-align: center;
}
@media (max-width: 900px) {
	.main-page-inner {
		padding: 24px 20px 36px;
	}
	.overview-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.section-head {
		flex-direction: column;
	}
	.page-tabs {
		justify-content: flex-start;
	}
}
</style>
