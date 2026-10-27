<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AuthenticationState } from "../../shared/interactions.ts";
import type { McpServerSummary } from "../../shared/mcp.ts";
import type { Configuration } from "../../shared/protocol.ts";
import type { CustomModelInput, CustomProviderInput } from "../../shared/provider.ts";
import type { ResourceSnapshot } from "../../shared/resources.ts";
import type { UpdateState } from "../../shared/update.ts";
import { createLogger } from "../../shared/logger.ts";
import { UButton, UIcon, UInput, UModal, USelectMenu } from "../ui.ts";
import OAuthProgress from "./OAuthProgress.vue";
import AppUpdatePanel from "./AppUpdatePanel.vue";
import UpdateDownloadButton from "./UpdateDownloadButton.vue";

type SettingsSection = "account" | "general" | "models" | "mcp" | "skills" | "plugins" | "agent";
type ProviderAddMode = "builtin" | "custom";
type ProviderThinkingLevel = NonNullable<CustomModelInput["thinkingLevels"]>[number];

const props = defineProps<{
	configuration: Configuration | null;
	authentication: AuthenticationState;
	resources: ResourceSnapshot | null;
	dark: boolean;
	updateState: UpdateState | null;
	updatePending: boolean;
	updateInstalling: boolean;
	updateError: string | null;
	saving: boolean;
	error: string | null;
	resourcesBusy?: boolean;
}>();
const open = defineModel<boolean>({ default: false });
const emit = defineEmits<{
	save: [provider: string, key: string];
	"save-provider": [provider: CustomProviderInput];
	"delete-provider": [provider: string];
	login: [provider: string];
	logout: [provider: string];
	cancelLogin: [];
	"set-theme": [dark: boolean];
	"open-config": [];
	"open-plugins": [];
	"check-update": [];
	"download-update": [];
	"install-update": [];
	"open-skills": [];
}>();
const logger = createLogger("settings");
const active = ref<SettingsSection>("account");
const editingProvider = ref("");
const editKey = ref("");
const removingProvider = ref("");
const adding = ref(false);
const addMode = ref<ProviderAddMode>("builtin");
const newProvider = ref("");
const newKey = ref("");
const customId = ref("");
const customName = ref("");
const customBaseUrl = ref("");
const customApi = ref<CustomProviderInput["api"]>("openai-completions");
const customModels = ref<CustomModelInput[]>([]);
const customKey = ref("");
const modelEditorOpen = ref(false);
const editingModelIndex = ref(-1);
const modelId = ref("");
const modelReasoning = ref(true);
const modelContextWindow = ref("");
const modelMaxTokens = ref("");
const modelImageInput = ref(false);
const modelStructuredOutput = ref(false);
const modelSystemMessages = ref(false);
const modelThinkingLevels = ref<ProviderThinkingLevel[]>(["off", "minimal", "low", "medium", "high"]);
const modelError = ref("");
const thinkingLevelOptions: Array<{ label: string; value: ProviderThinkingLevel }> = [
	{ label: "disabled", value: "off" },
	{ label: "minimal", value: "minimal" },
	{ label: "low", value: "low" },
	{ label: "medium", value: "medium" },
	{ label: "high", value: "high" },
	{ label: "xhigh", value: "xhigh" },
	{ label: "max", value: "max" },
];
const customError = ref("");
const customApiTypes: Array<{ label: string; value: CustomProviderInput["api"] }> = [
	{ label: "OpenAI Chat Completions", value: "openai-completions" },
	{ label: "OpenAI Responses", value: "openai-responses" },
	{ label: "Anthropic Messages", value: "anthropic-messages" },
	{ label: "Google Generative AI", value: "google-generative-ai" },
];
const sections: Array<{ id: SettingsSection; label: string; icon: string }> = [
	{ id: "account", label: "账号与余额", icon: "i-lucide-user-round" },
	{ id: "general", label: "通用设置", icon: "i-lucide-settings-2" },
	{ id: "models", label: "模型", icon: "i-lucide-sliders-horizontal" },
	{ id: "mcp", label: "MCP 服务器", icon: "i-lucide-server" },
	{ id: "skills", label: "技能", icon: "i-lucide-book-open" },
	{ id: "plugins", label: "插件", icon: "i-lucide-puzzle" },
	{ id: "agent", label: "Agent 预设", icon: "i-lucide-bot" },
];
const sectionGroups = [
	{ label: "基础设置", items: sections.slice(0, 3) },
	{ label: "Agent 能力", items: sections.slice(3) },
];
const mcpServers = ref<McpServerSummary[]>([]);
const mcpBusy = ref(false);
const mcpEditing = ref(false);
const mcpError = ref("");
const mcpResult = ref("");
const mcpName = ref("");
const mcpType = ref<"stdio" | "http">("stdio");
const mcpCommand = ref("");
const mcpArgs = ref("");
const mcpUrl = ref("");
const mcpTypes: Array<{ label: string; value: "stdio" | "http" }> = [
	{ label: "stdio（本地命令）", value: "stdio" },
	{ label: "HTTP", value: "http" },
];
const skillQuery = ref("");
const skillGroups = computed(() => {
	const query = skillQuery.value.trim().toLocaleLowerCase();
	const skills = (props.resources?.skills ?? []).filter(
		(skill) => !query || `${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(query),
	);
	const labels: Record<string, string> = { user: "用户", project: "项目", temporary: "临时", unknown: "其他" };
	const groups = new Map<string, typeof skills>();
	for (const skill of skills) {
		const label = labels[skill.scope] ?? "其他";
		groups.set(label, [...(groups.get(label) ?? []), skill]);
	}
	return [...groups.entries()].map(([label, items]) => ({ label, items }));
});
const skillDiagnostics = computed(
	() =>
		props.resources?.diagnostics.filter(
			(item) =>
				item.message.toLocaleLowerCase().includes("skill") || item.path?.toLocaleLowerCase().includes("skill.md"),
		) ?? [],
);
const providerNames: Record<string, string> = {
	anthropic: "Anthropic",
	deepseek: "DeepSeek",
	google: "Google",
	openai: "OpenAI",
	openrouter: "OpenRouter",
};
const oauthBusy = computed(() => props.authentication.flow?.phase === "working");
const availableProviders = computed(
	() => new Set(props.configuration?.models.filter((model) => model.available).map((model) => model.provider) ?? []),
);
const oauthAuthenticated = computed(() => props.authentication.providers.filter((item) => item.authenticated).length);
const availableModels = computed(() => props.configuration?.models.filter((model) => model.available) ?? []);
const allProviders = computed(() => [...new Set(props.configuration?.models.map((model) => model.provider) ?? [])]);
const configuredProviders = computed(() => {
	const ids = new Set<string>(availableProviders.value);
	for (const provider of props.authentication.providers) if (provider.authenticated) ids.add(provider.id);
	for (const provider of props.configuration?.customProviders ?? []) ids.add(provider);
	return [...ids].sort((left, right) => providerLabel(left).localeCompare(providerLabel(right)));
});
const unconfiguredProviders = computed(() =>
	allProviders.value.filter((provider) => !configuredProviders.value.includes(provider)),
);
const unconfiguredItems = computed(() =>
	unconfiguredProviders.value.map((provider) => ({ value: provider, label: providerLabel(provider) })),
);
const modelLabel = computed(() => {
	const model = props.configuration?.model;
	return model ? `${model.provider} / ${model.name}` : "未选择";
});
const extensions = computed(() => props.resources?.extensions ?? []);
const diagnostics = computed(() => props.resources?.diagnostics ?? []);

function providerLabel(provider: string): string {
	const configuredName = props.configuration?.models.find((model) => model.provider === provider)?.providerName;
	if (configuredName) return configuredName;
	const known = providerNames[provider];
	if (known) return known;
	return provider
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function providerOauth(provider: string) {
	return props.authentication.providers.find((item) => item.id === provider);
}

function providerStatus(provider: string): string {
	if (providerOauth(provider)?.authenticated) return "账号 · 已登录";
	return availableProviders.value.has(provider) ? "API Key · 已认证" : "未认证";
}

function isCustomProvider(provider: string): boolean {
	return props.configuration?.customProviders?.includes(provider) ?? false;
}

const removeIsCustom = computed(() => isCustomProvider(removingProvider.value));

function askRemoveProvider(provider: string) {
	removingProvider.value = provider;
}

function confirmRemoveProvider() {
	if (!removingProvider.value) return;
	logger.info("开始删除自定义 Provider");
	emit("delete-provider", removingProvider.value);
	removingProvider.value = "";
	logger.info("自定义 Provider 删除请求结束");
}

function startEdit(provider: string) {
	editingProvider.value = provider;
	editKey.value = "";
	adding.value = false;
}

function startAdd() {
	editingProvider.value = "";
	adding.value = true;
	addMode.value = "builtin";
	newProvider.value = unconfiguredProviders.value[0] ?? "";
	newKey.value = "";
	customId.value = "";
	customName.value = "";
	customBaseUrl.value = "";
	customApi.value = "openai-completions";
	customModels.value = [];
	customKey.value = "";
	customError.value = "";
	modelEditorOpen.value = false;
	resetModelDraft();
}

function saveEdit() {
	if (!editingProvider.value) return;
	logger.info("开始保存 Provider 认证");
	emit("save", editingProvider.value, editKey.value);
	editKey.value = "";
	logger.info("Provider 认证提交结束");
}

function saveAdd() {
	if (!newProvider.value) return;
	logger.info("开始添加 Provider");
	emit("save", newProvider.value, newKey.value);
	newKey.value = "";
	logger.info("Provider 添加提交结束");
}

function customIssue(): string {
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(customId.value.trim())) {
		return "Provider ID 只能包含小写字母、数字、点、下划线和连字符，且必须以字母或数字开头";
	}
	if (!/^https?:\/\//.test(customBaseUrl.value.trim())) return "Base URL 需要以 http:// 或 https:// 开头";
	if (!customModels.value.length) return "请至少添加一个模型";
	if (!customKey.value.trim()) return "请填写 API Key；本地无需 Key 的服务可填写任意占位值";
	return "";
}

function isPositiveInteger(value: string): boolean {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 && number <= 10_000_000;
}

function resetModelDraft() {
	editingModelIndex.value = -1;
	modelId.value = "";
	modelReasoning.value = true;
	modelContextWindow.value = "";
	modelMaxTokens.value = "";
	modelImageInput.value = false;
	modelStructuredOutput.value = false;
	modelSystemMessages.value = false;
	modelThinkingLevels.value = ["off", "minimal", "low", "medium", "high"];
	modelError.value = "";
}

function startAddModel() {
	resetModelDraft();
	modelEditorOpen.value = true;
}

function startEditModel(index: number) {
	const model = customModels.value[index];
	if (!model) return;
	editingModelIndex.value = index;
	modelId.value = model.id;
	modelReasoning.value = model.reasoning === true;
	modelContextWindow.value = model.contextWindow ? String(model.contextWindow) : "";
	modelMaxTokens.value = model.maxTokens ? String(model.maxTokens) : "";
	modelImageInput.value = model.input?.includes("image") ?? false;
	modelStructuredOutput.value = model.supportsStructuredOutput === true;
	modelSystemMessages.value = model.supportsSystemMessages === true;
	modelThinkingLevels.value = model.thinkingLevels?.length
		? [...model.thinkingLevels]
		: ["off", "minimal", "low", "medium", "high"];
	modelError.value = "";
	modelEditorOpen.value = true;
}

function toggleModelThinkingLevel(level: ProviderThinkingLevel) {
	const index = modelThinkingLevels.value.indexOf(level);
	if (index >= 0) modelThinkingLevels.value = modelThinkingLevels.value.filter((item) => item !== level);
	else modelThinkingLevels.value = [...modelThinkingLevels.value, level];
}

function textValue(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}

function modelIssue(): string {
	const id = modelId.value.trim();
	if (!id) return "请输入模型 ID";
	if (customModels.value.some((model, index) => index !== editingModelIndex.value && model.id === id)) {
		return "模型 ID 已存在";
	}
	if (textValue(modelContextWindow.value).trim() && !isPositiveInteger(textValue(modelContextWindow.value))) {
		return "上下文窗口必须是正整数";
	}
	if (textValue(modelMaxTokens.value).trim() && !isPositiveInteger(textValue(modelMaxTokens.value))) {
		return "最大输出 Token 必须是正整数";
	}
	return "";
}

function saveModelDraft() {
	const issue = modelIssue();
	if (issue) {
		modelError.value = issue;
		return;
	}
	const model: CustomModelInput = {
		id: modelId.value.trim(),
		...(modelReasoning.value ? { reasoning: true, thinkingLevels: [...modelThinkingLevels.value] } : {}),
		...(textValue(modelContextWindow.value).trim()
			? { contextWindow: Number(textValue(modelContextWindow.value)) }
			: {}),
		...(textValue(modelMaxTokens.value).trim() ? { maxTokens: Number(textValue(modelMaxTokens.value)) } : {}),
		input: ["text", ...(modelImageInput.value ? (["image"] as const) : [])],
		supportsStructuredOutput: modelStructuredOutput.value || undefined,
		supportsSystemMessages: modelSystemMessages.value || undefined,
	};
	const next = [...customModels.value];
	if (editingModelIndex.value >= 0) next[editingModelIndex.value] = model;
	else next.push(model);
	customModels.value = next;
	modelEditorOpen.value = false;
	modelError.value = "";
}

function removeModel(index: number) {
	customModels.value = customModels.value.filter((_, item) => item !== index);
}

function formatModelContext(value: number | undefined): string | null {
	if (!value) return null;
	if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return String(value);
}

function saveCustomProvider() {
	const issue = customIssue();
	if (issue) {
		customError.value = issue;
		return;
	}
	customError.value = "";
	logger.info("开始添加自定义 Provider");
	emit("save-provider", {
		id: customId.value.trim(),
		name: customName.value.trim() || undefined,
		baseUrl: customBaseUrl.value.trim(),
		api: customApi.value,
		models: customModels.value,
		apiKey: customKey.value.trim(),
	});
	customKey.value = "";
	logger.info("自定义 Provider 添加提交结束");
}

/*
 * ========================================================================
 * 步骤6：互斥提交 MCP 变更并显示应用结果
 * ========================================================================
 * 数据源：主进程原子配置与当前会话重载结果。
 * 操作：1) 禁止连点；2) 失败保留表单，成功后同步列表和状态。
 */
async function loadMcpServers() {
	if (mcpBusy.value) return;
	logger.info("开始读取 MCP 配置");
	mcpBusy.value = true;
	mcpError.value = "";
	try {
		mcpServers.value = await window.piDesktop.listMcpServers();
	} catch (error) {
		mcpError.value = error instanceof Error ? error.message : "MCP 配置读取失败";
	} finally {
		mcpBusy.value = false;
		logger.info("MCP 配置读取结束");
	}
}

function startAddMcp() {
	if (mcpBusy.value || props.resourcesBusy) return;
	mcpEditing.value = true;
	mcpError.value = "";
	mcpName.value = "";
	mcpType.value = "stdio";
	mcpCommand.value = "";
	mcpArgs.value = "";
	mcpUrl.value = "";
}

async function saveMcpServer() {
	if (mcpBusy.value || props.resourcesBusy) return;
	const name = mcpName.value.trim();
	if (!/^[A-Za-z0-9_-]+$/.test(name)) {
		mcpError.value = "MCP 名称只能包含字母、数字、下划线和连字符";
		return;
	}
	if (mcpType.value === "stdio" && !mcpCommand.value.trim()) {
		mcpError.value = "stdio 类型需要填写启动命令";
		return;
	}
	if (mcpType.value === "http" && !/^https?:\/\//.test(mcpUrl.value.trim())) {
		mcpError.value = "HTTP 类型需要填写以 http:// 或 https:// 开头的 URL";
		return;
	}
	logger.info("开始保存并应用 MCP 配置");
	// 6.1 原表单保留到宿主确认重载成功。
	mcpBusy.value = true;
	mcpError.value = "";
	mcpResult.value = "";
	try {
		mcpServers.value = await window.piDesktop.saveMcpServer({
			name,
			type: mcpType.value,
			command: mcpType.value === "stdio" ? mcpCommand.value.trim() : undefined,
			args:
				mcpType.value === "stdio"
					? mcpArgs.value
							.split(/\s+/)
							.map((item) => item.trim())
							.filter(Boolean)
					: undefined,
			url: mcpType.value === "http" ? mcpUrl.value.trim() : undefined,
			enabled: true,
		});
		mcpEditing.value = false;
		mcpResult.value = props.configuration ? "配置已应用到当前会话" : "配置已保存，打开项目后生效";
	} catch (error) {
		mcpError.value = error instanceof Error ? error.message : "MCP 保存失败";
	} finally {
		mcpBusy.value = false;
		logger.info("MCP 配置保存和应用结束");
	}
}

async function toggleMcpServer(server: McpServerSummary) {
	if (mcpBusy.value || props.resourcesBusy) return;
	logger.info("开始切换 MCP 启停状态");
	// 6.2 列表仅采用主进程返回值，不提前翻转本地开关。
	mcpBusy.value = true;
	mcpError.value = "";
	mcpResult.value = "";
	try {
		mcpServers.value = await window.piDesktop.setMcpServerEnabled(server.name, !server.enabled);
		mcpResult.value = props.configuration ? "配置已应用到当前会话" : "配置已保存，打开项目后生效";
	} catch (error) {
		mcpError.value = error instanceof Error ? error.message : "MCP 状态更新失败";
	} finally {
		mcpBusy.value = false;
		logger.info("MCP 启停状态切换结束");
	}
}

async function removeMcpServer(server: McpServerSummary) {
	if (mcpBusy.value || props.resourcesBusy) return;
	logger.info("开始删除并卸载 MCP 服务");
	// 6.3 删除失败不提前从可见列表移除。
	mcpBusy.value = true;
	mcpError.value = "";
	mcpResult.value = "";
	try {
		mcpServers.value = await window.piDesktop.removeMcpServer(server.name);
		mcpResult.value = props.configuration ? "配置已应用到当前会话" : "配置已保存，打开项目后生效";
	} catch (error) {
		mcpError.value = error instanceof Error ? error.message : "MCP 删除失败";
	} finally {
		mcpBusy.value = false;
		logger.info("MCP 服务删除和卸载结束");
	}
}

watch(open, (value) => {
	// 1.1 关闭时清空敏感输入；不保存到草稿、偏好或聊天内容。
	if (value && active.value === "mcp") void loadMcpServers();
	if (!value) {
		editKey.value = "";
		newKey.value = "";
		customKey.value = "";
		customError.value = "";
		editingProvider.value = "";
		removingProvider.value = "";
		adding.value = false;
		mcpEditing.value = false;
		mcpError.value = "";
	}
});

watch(active, (section) => {
	if (section === "mcp" && open.value) void loadMcpServers();
});

watch([customId, customBaseUrl, customModels, customKey], () => {
	customError.value = "";
});
</script>

<template>
	<div v-if="open" class="settings-page">
		<div class="settings-layout">
			<nav class="settings-nav" aria-label="设置分类">
				<button type="button" class="settings-back" @click="open = false">
					<UIcon name="i-lucide-arrow-left" aria-hidden="true" />
					<span>返回工作区</span>
				</button>
				<div v-for="group in sectionGroups" :key="group.label" class="settings-nav-group">
					<div class="settings-nav-label">{{ group.label }}</div>
					<button
						v-for="section in group.items"
						:key="section.id"
						type="button"
						:class="{ active: active === section.id }"
						:aria-current="active === section.id ? 'page' : undefined"
						@click="active = section.id"
					>
						<UIcon :name="section.icon" aria-hidden="true" />
						<span>{{ section.label }}</span>
					</button>
				</div>
				<div class="sidebar-footer settings-profile-footer">
					<div class="user-profile" aria-label="当前用户：Aniao">
						<span class="user-avatar" aria-hidden="true">A</span>
						<span class="user-name">Aniao</span>
					</div>
					<div class="sidebar-footer-actions">
						<UpdateDownloadButton
							:state="updateState"
							:pending="updatePending"
							@download="emit('download-update')"
							@details="emit('check-update')"
						/>
						<UButton
							icon="i-lucide-settings"
							color="neutral"
							variant="ghost"
							size="sm"
							aria-label="设置"
							title="返回工作区"
							@click="open = false"
						/>
						<UButton
							:icon="dark ? 'i-lucide-sun' : 'i-lucide-moon'"
							:aria-label="dark ? '切换浅色主题' : '切换深色主题'"
							:title="dark ? '切换浅色主题' : '切换深色主题'"
							color="neutral"
							variant="ghost"
							size="sm"
							@click="emit('set-theme', !dark)"
						/>
					</div>
				</div>
			</nav>

			<div class="settings-content">
				<section v-if="active === 'account'" class="settings-section">
					<h3>账号与余额</h3>
					<div class="account-card">
						<span class="account-avatar" aria-hidden="true">A</span>
						<div>
							<strong>Aniao</strong>
							<span>本机工作区账号</span>
						</div>
					</div>
					<div class="settings-card">
						<div class="card-head">
							<h4>认证概览</h4>
							<UButton color="neutral" variant="link" size="xs" @click="active = 'models'"
								>管理模型与认证</UButton
							>
						</div>
						<div class="metric-list">
							<div>
								<span>可用模型</span>
								<strong>{{ availableModels.length }}</strong>
							</div>
							<div>
								<span>已认证服务商</span>
								<strong>{{ availableProviders.size }}</strong>
							</div>
							<div>
								<span>OAuth 登录</span>
								<strong>{{ oauthAuthenticated }}</strong>
							</div>
						</div>
					</div>
					<div class="settings-card">
						<h4>余额与用量</h4>
						<p class="settings-muted">
							当前版本使用各服务商自己的账户计费，桌面端不读取或保存余额。API Key 和 OAuth 凭据只保存在本机 Pi
							认证存储中。
						</p>
					</div>
				</section>

				<section v-else-if="active === 'general'" class="settings-section">
					<h3>通用设置</h3>
					<div class="settings-card">
						<h4>外观主题</h4>
						<p class="settings-muted">只改变界面外观，不影响会话内容。</p>
						<div class="theme-options">
							<button type="button" :class="{ active: !dark }" @click="emit('set-theme', false)">
								<UIcon name="i-lucide-sun" aria-hidden="true" />
								<span>浅色</span>
							</button>
							<button type="button" :class="{ active: dark }" @click="emit('set-theme', true)">
								<UIcon name="i-lucide-moon" aria-hidden="true" />
								<span>深色</span>
							</button>
						</div>
					</div>
					<div class="settings-card">
						<h4>语言</h4>
						<div class="setting-row">
							<span>界面语言</span>
							<strong>简体中文</strong>
						</div>
					</div>
					<div class="settings-card">
						<div class="card-head">
							<h4>配置文件</h4>
							<UButton color="neutral" variant="outline" size="xs" @click="emit('open-config')">打开</UButton>
						</div>
						<code>~/.pi/agent</code>
					</div>
					<AppUpdatePanel
						:state="updateState"
						:pending="updatePending"
						:installing="updateInstalling"
						:error="updateError"
						@check="emit('check-update')"
						@download="emit('download-update')"
						@install="emit('install-update')"
					/>
				</section>

				<section v-else-if="active === 'models'" class="settings-section models-section">
					<h3>模型</h3>
					<p class="settings-muted">填入各提供商的 API 密钥即可使用其模型。</p>

					<div class="provider-list">
						<div v-for="providerId in configuredProviders" :key="providerId" class="provider-card">
							<div class="provider-main">
								<strong>{{ providerLabel(providerId) }}</strong>
								<span class="provider-state" :class="{ offline: providerStatus(providerId) === '未认证' }">
									<i class="provider-dot" aria-hidden="true" />
									{{ providerStatus(providerId) }}
								</span>
							</div>
							<div class="provider-actions">
								<UButton color="neutral" variant="outline" size="xs" @click="startEdit(providerId)"
									>编辑</UButton
								>
								<UButton
									icon="i-lucide-trash-2"
									color="error"
									variant="ghost"
									size="xs"
									:aria-label="`删除 ${providerLabel(providerId)}`"
									:title="`删除 ${providerLabel(providerId)}`"
									@click="askRemoveProvider(providerId)"
								/>
							</div>
						</div>
						<p v-if="!configuredProviders.length" class="settings-muted">当前还没有已配置的模型提供商。</p>
					</div>

					<div v-if="editingProvider" class="provider-editor">
						<h4>编辑 {{ providerLabel(editingProvider) }}</h4>
						<form class="provider-form" @submit.prevent="saveEdit">
							<label for="edit-provider-key">API Key</label>
							<UInput
								id="edit-provider-key"
								v-model="editKey"
								type="password"
								:disabled="oauthBusy || saving"
								autocomplete="off"
								class="w-full"
								placeholder="输入新的 API Key"
							/>
							<div class="settings-actions">
								<UButton
									type="submit"
									color="neutral"
									:disabled="!editKey.trim() || saving || oauthBusy"
									:loading="saving"
									>保存</UButton
								>
								<UButton color="neutral" variant="ghost" @click="editingProvider = ''">取消</UButton>
							</div>
						</form>
						<div v-if="providerOauth(editingProvider)" class="provider-oauth">
							<p class="settings-muted">
								{{
									providerOauth(editingProvider)?.authenticated
										? "账号已登录，可重新登录或退出。"
										: "该提供商支持 OAuth 账号登录。"
								}}
							</p>
							<OAuthProgress :flow="authentication.flow" cancel @cancel="emit('cancelLogin')" />
							<div class="settings-actions">
								<UButton
									v-if="!oauthBusy"
									color="neutral"
									:disabled="saving"
									@click="emit('login', editingProvider)"
									>{{ providerOauth(editingProvider)?.authenticated ? "重新登录" : "开始登录" }}</UButton
								>
								<UButton
									v-if="providerOauth(editingProvider)?.authenticated && !oauthBusy"
									color="neutral"
									variant="ghost"
									:disabled="saving"
									@click="emit('logout', editingProvider)"
									>退出登录</UButton
								>
							</div>
						</div>
					</div>

					<button type="button" class="provider-add" @click="startAdd">
						<UIcon name="i-lucide-plus" aria-hidden="true" />
						<span>添加模型提供商</span>
					</button>

					<div v-if="adding" class="provider-editor">
						<h4>添加模型提供商</h4>
						<div class="provider-add-mode">
							<button type="button" :class="{ active: addMode === 'builtin' }" @click="addMode = 'builtin'">
								内置 Provider
							</button>
							<button type="button" :class="{ active: addMode === 'custom' }" @click="addMode = 'custom'">
								自定义 API
							</button>
						</div>
						<form v-if="addMode === 'builtin'" class="provider-form" @submit.prevent="saveAdd">
							<label for="new-provider">提供商</label>
							<USelectMenu
								id="new-provider"
								v-model="newProvider"
								:items="unconfiguredItems"
								value-key="value"
								:disabled="!unconfiguredProviders.length || oauthBusy"
								class="w-full"
								placeholder="选择提供商"
							/>
							<label for="new-provider-key">API Key</label>
							<UInput
								id="new-provider-key"
								v-model="newKey"
								type="password"
								:disabled="!newProvider || oauthBusy"
								autocomplete="off"
								class="w-full"
								placeholder="输入 API Key"
							/>
							<p v-if="!unconfiguredProviders.length" class="settings-muted">
								所有已加载的提供商都已配置，可切换到「自定义 API」。
							</p>
							<div class="settings-actions">
								<UButton
									type="submit"
									color="neutral"
									:disabled="!newProvider || !newKey.trim() || saving || oauthBusy"
									:loading="saving"
									>添加</UButton
								>
								<UButton color="neutral" variant="ghost" @click="adding = false">取消</UButton>
							</div>
						</form>
						<form v-else class="provider-form" @submit.prevent="saveCustomProvider">
							<div class="provider-grid">
								<div>
									<label for="custom-provider-id">Provider ID</label>
									<UInput
										id="custom-provider-id"
										v-model="customId"
										:disabled="oauthBusy"
										class="w-full"
										placeholder="my-provider"
									/>
								</div>
								<div>
									<label for="custom-provider-name">显示名称</label>
									<UInput
										id="custom-provider-name"
										v-model="customName"
										:disabled="oauthBusy"
										class="w-full"
										placeholder="可选"
									/>
								</div>
							</div>
							<label for="custom-provider-api">API 类型</label>
							<USelectMenu
								id="custom-provider-api"
								v-model="customApi"
								:items="customApiTypes"
								value-key="value"
								:disabled="oauthBusy"
								class="w-full"
							/>
							<label for="custom-provider-url">Base URL</label>
							<UInput
								id="custom-provider-url"
								v-model="customBaseUrl"
								:disabled="oauthBusy"
								class="w-full"
								placeholder="https://api.example.com/v1"
							/>
							<div class="settings-card custom-models-card">
								<div class="card-head">
									<h4>模型列表</h4>
									<UButton icon="i-lucide-plus" color="neutral" variant="soft" size="xs" @click="startAddModel"
										>添加模型</UButton
									>
								</div>
								<div class="custom-models">
									<div v-for="(model, index) in customModels" :key="model.id" class="custom-model-row">
										<div class="custom-model-copy">
											<strong>{{ model.id }}</strong>
											<div class="model-badges">
												<span v-if="formatModelContext(model.contextWindow)" class="model-badge">
													{{ formatModelContext(model.contextWindow) }}
												</span>
												<span v-if="model.input?.includes('image')" class="model-badge">视觉</span>
												<span v-if="model.reasoning" class="model-badge">推理</span>
											</div>
										</div>
										<div class="custom-model-actions">
											<UButton
												icon="i-lucide-sliders-horizontal"
												color="neutral"
												variant="ghost"
												size="xs"
												:aria-label="`高级配置 ${model.id}`"
												@click="startEditModel(index)"
											/>
											<UButton
												icon="i-lucide-pencil"
												color="neutral"
												variant="ghost"
												size="xs"
												:aria-label="`编辑模型 ${model.id}`"
												@click="startEditModel(index)"
											/>
											<UButton
												icon="i-lucide-trash-2"
												color="error"
												variant="ghost"
												size="xs"
												:aria-label="`删除模型 ${model.id}`"
												@click="removeModel(index)"
											/>
										</div>
									</div>
									<p v-if="!customModels.length" class="settings-muted">还没有模型，点击“添加模型”创建。</p>
								</div>
							</div>
							<label for="custom-provider-key">API Key</label>
							<UInput
								id="custom-provider-key"
								v-model="customKey"
								type="password"
								:disabled="oauthBusy"
								autocomplete="off"
								class="w-full"
								placeholder="输入 API Key"
							/>
							<p class="settings-muted">保存到 models.json；API Key 单独写入本机认证存储，不会写进配置文件。</p>
							<p v-if="customError" class="workspace-error" role="alert">{{ customError }}</p>
							<div class="settings-actions">
								<UButton type="submit" color="neutral" :disabled="saving || oauthBusy" :loading="saving"
									>添加</UButton
								>
								<UButton color="neutral" variant="ghost" @click="adding = false">取消</UButton>
							</div>
						</form>
					</div>
					<p v-if="error" class="workspace-error" role="alert">{{ error }}</p>
				</section>

				<section v-else-if="active === 'mcp'" class="settings-section models-section">
					<h3>MCP 服务器</h3>
					<p v-if="resourcesBusy && !mcpBusy" class="settings-muted">请等待当前任务、交互或计划结束后再修改。</p>
					<p v-if="mcpResult" class="settings-muted" role="status">{{ mcpResult }}</p>
					<div class="provider-list">
						<div v-for="server in mcpServers" :key="server.name" class="provider-card">
							<div class="provider-main">
								<strong>{{ server.name }}</strong>
								<span class="provider-state" :class="{ offline: !server.enabled }">
									<i class="provider-dot" aria-hidden="true" />
									{{ server.enabled ? "已启用" : "已停用" }}
								</span>
								<span class="mcp-command">
									{{
										server.type === "stdio"
											? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
											: server.url
									}}
								</span>
							</div>
							<div class="provider-actions">
								<button
									type="button"
									class="mcp-switch"
									:disabled="mcpBusy || resourcesBusy"
									:class="{ on: server.enabled }"
									:aria-label="`${server.enabled ? '停用' : '启用'} ${server.name}`"
									@click="toggleMcpServer(server)"
								>
									<span />
								</button>
								<UButton
									icon="i-lucide-trash-2"
									color="error"
									variant="ghost"
									size="xs"
									:aria-label="`删除 ${server.name}`"
									:disabled="mcpBusy || resourcesBusy"
									@click="removeMcpServer(server)"
								/>
							</div>
						</div>
						<p v-if="!mcpServers.length && !mcpBusy" class="settings-muted">还没有 MCP 服务器。</p>
						<p v-if="mcpBusy" class="settings-muted" role="status">正在处理 MCP 配置…</p>
					</div>
					<button type="button" class="provider-add" :disabled="mcpBusy || resourcesBusy" @click="startAddMcp">
						<UIcon name="i-lucide-plus" aria-hidden="true" />
						<span>新建 MCP 服务器</span>
					</button>
					<div v-if="mcpEditing" class="provider-editor">
						<h4>新建 MCP 服务器</h4>
						<form class="provider-form" @submit.prevent="saveMcpServer">
							<label for="mcp-name">名称</label>
							<UInput
								id="mcp-name"
								v-model="mcpName"
								class="w-full"
								placeholder="my-mcp-server"
								:disabled="mcpBusy"
							/>
							<label for="mcp-type">类型</label>
							<USelectMenu
								id="mcp-type"
								v-model="mcpType"
								:items="mcpTypes"
								value-key="value"
								class="w-full"
								:disabled="mcpBusy"
							/>
							<template v-if="mcpType === 'stdio'">
								<label for="mcp-command">命令</label>
								<UInput
									id="mcp-command"
									v-model="mcpCommand"
									class="w-full"
									placeholder="npx"
									:disabled="mcpBusy"
								/>
								<label for="mcp-args">参数（空格分隔）</label>
								<UInput
									id="mcp-args"
									v-model="mcpArgs"
									class="w-full"
									placeholder="-y @modelcontextprotocol/server-memory"
									:disabled="mcpBusy"
								/>
							</template>
							<template v-else>
								<label for="mcp-url">URL</label>
								<UInput
									id="mcp-url"
									v-model="mcpUrl"
									class="w-full"
									placeholder="https://example.com/mcp"
									:disabled="mcpBusy"
								/>
							</template>
							<p v-if="mcpError" class="workspace-error" role="alert">{{ mcpError }}</p>
							<div class="settings-actions">
								<UButton type="submit" color="neutral" :loading="mcpBusy" :disabled="mcpBusy || resourcesBusy"
									>保存</UButton
								>
								<UButton color="neutral" variant="ghost" :disabled="mcpBusy" @click="mcpEditing = false"
									>取消</UButton
								>
							</div>
						</form>
					</div>
					<p v-if="mcpError && !mcpEditing" class="workspace-error" role="alert">{{ mcpError }}</p>
				</section>

				<section v-else-if="active === 'skills'" class="settings-section models-section">
					<h3>技能</h3>
					<div class="skills-toolbar">
						<UInput v-model="skillQuery" class="skills-search" placeholder="搜索技能…" aria-label="搜索技能" />
						<UButton color="neutral" variant="outline" size="sm" @click="emit('open-skills')"
							>打开技能目录</UButton
						>
					</div>
					<p v-if="skillDiagnostics.length" class="skill-warning">
						{{ skillDiagnostics.length }} 条技能加载诊断，详见插件页。
					</p>
					<div v-for="group in skillGroups" :key="group.label" class="skill-group">
						<h4>
							{{ group.label }} <span>{{ group.items.length }}</span>
						</h4>
						<div v-for="skill in group.items" :key="skill.path" class="skill-row">
							<UIcon name="i-lucide-sparkles" class="skill-icon" aria-hidden="true" />
							<div class="skill-copy">
								<strong>{{ skill.name }}</strong>
								<span>{{ skill.description }}</span>
							</div>
							<span class="skill-scope">{{ skill.scope }}</span>
						</div>
					</div>
					<p v-if="!skillGroups.length" class="settings-muted">没有匹配的技能。</p>
				</section>

				<section v-else-if="active === 'plugins'" class="settings-section">
					<h3>插件</h3>
					<p class="settings-muted">在插件页安装 npm、Git 或本地包；这里显示当前会话已加载的内置能力。</p>
					<div class="settings-card">
						<p v-if="!resources" class="settings-muted">当前会话没有资源快照，连接宿主后重新打开设置。</p>
						<div v-else class="metric-list">
							<div>
								<span>扩展</span>
								<strong>{{ resources?.extensions.length ?? 0 }}</strong>
							</div>
							<div>
								<span>技能</span>
								<strong>{{ resources?.skills.length ?? 0 }}</strong>
							</div>
							<div>
								<span>模板</span>
								<strong>{{ resources?.prompts.length ?? 0 }}</strong>
							</div>
							<div>
								<span>命令</span>
								<strong>{{ resources?.commands.length ?? 0 }}</strong>
							</div>
						</div>
					</div>
					<div class="settings-card">
						<h4>已加载扩展</h4>
						<div v-if="extensions.length" class="extension-list">
							<div v-for="extension in extensions" :key="extension.path">
								<strong>{{ extension.name }}</strong>
								<span>{{ extension.path }}</span>
							</div>
						</div>
						<p v-else class="settings-muted">当前会话没有已加载扩展。</p>
						<p v-if="diagnostics.length" class="settings-muted">
							{{ diagnostics.length }} 条资源诊断，详情在插件页查看。
						</p>
					</div>
					<div class="settings-actions">
						<UButton color="neutral" variant="outline" @click="emit('open-plugins')">打开插件页</UButton>
					</div>
				</section>

				<section v-else class="settings-section">
					<h3>Agent 预设</h3>
					<p class="settings-muted">当前会话的 Agent 运行配置。</p>
					<div class="settings-card">
						<div class="setting-row">
							<span>模型</span>
							<strong>{{ modelLabel }}</strong>
						</div>
						<div class="setting-row">
							<span>思考等级</span>
							<strong>{{ configuration?.thinking ?? "—" }}</strong>
						</div>
						<div class="setting-row">
							<span>可用思考等级</span>
							<strong>{{ configuration?.thinkingLevels.join(" / ") || "—" }}</strong>
						</div>
					</div>
					<div class="settings-card">
						<h4>预设</h4>
						<p class="settings-muted">
							当前版本按会话保存模型和思考等级，独立的 Agent 预设管理尚未接入。可先在模型页切换默认模型。
						</p>
						<UButton
							class="settings-inline-button"
							color="neutral"
							variant="outline"
							size="sm"
							@click="active = 'models'"
							>修改模型</UButton
						>
					</div>
				</section>
			</div>
		</div>
	</div>
	<UModal
		v-model:open="modelEditorOpen"
		:title="editingModelIndex >= 0 ? '编辑模型' : '添加模型'"
		:ui="{ content: 'model-dialog' }"
	>
		<template #content>
			<div class="model-dialog-body">
				<div class="model-dialog-head">
					<h3>{{ editingModelIndex >= 0 ? "编辑模型" : "添加模型" }}</h3>
					<UButton
						icon="i-lucide-x"
						color="neutral"
						variant="ghost"
						size="xs"
						aria-label="关闭模型对话框"
						@click="modelEditorOpen = false"
					/>
				</div>
				<div class="advanced-grid">
					<label class="advanced-field">
						<span>模型 ID</span>
						<UInput v-model="modelId" class="w-full" placeholder="模型 ID" />
					</label>
					<label class="advanced-field">
						<span>上下文窗口</span>
						<UInput v-model="modelContextWindow" inputmode="numeric" class="w-full" placeholder="例如 1000000" />
					</label>
					<label class="advanced-field">
						<span>最大输出 Token</span>
						<UInput v-model="modelMaxTokens" inputmode="numeric" class="w-full" placeholder="例如 384000" />
					</label>
				</div>
				<label class="provider-check">
					<input v-model="modelReasoning" type="checkbox" />
					<span>支持思考/推理</span>
				</label>
				<details class="provider-advanced">
					<summary>高级配置</summary>
					<div class="advanced-block">
						<span>输入类型</span>
						<div class="advanced-chips">
							<button type="button" class="advanced-chip active" disabled>文本</button>
							<button
								type="button"
								class="advanced-chip"
								:class="{ active: modelImageInput }"
								@click="modelImageInput = !modelImageInput"
							>
								图片
							</button>
							<button type="button" class="advanced-chip" disabled>视频（暂不支持）</button>
							<button type="button" class="advanced-chip" disabled>PDF（暂不支持）</button>
						</div>
					</div>
					<div class="advanced-block">
						<span>模型能力</span>
						<div class="advanced-chips">
							<button
								type="button"
								class="advanced-chip"
								:class="{ active: modelStructuredOutput }"
								@click="modelStructuredOutput = !modelStructuredOutput"
							>
								结构化输出
							</button>
							<button
								type="button"
								class="advanced-chip"
								:class="{ active: modelSystemMessages }"
								@click="modelSystemMessages = !modelSystemMessages"
							>
								对话中系统消息
							</button>
							<button type="button" class="advanced-chip" disabled>原生联网搜索（暂不支持）</button>
						</div>
					</div>
					<div v-if="modelReasoning" class="advanced-block">
						<span>推理等级（从低到高）</span>
						<div class="advanced-chips">
							<button
								v-for="level in thinkingLevelOptions"
								:key="level.value"
								type="button"
								class="advanced-chip"
								:class="{ active: modelThinkingLevels.includes(level.value) }"
								@click="toggleModelThinkingLevel(level.value)"
							>
								{{ level.label }}
							</button>
						</div>
					</div>
				</details>
				<p v-if="modelError" class="workspace-error" role="alert">{{ modelError }}</p>
				<div class="model-dialog-actions">
					<UButton color="neutral" variant="ghost" @click="modelEditorOpen = false">取消</UButton>
					<UButton color="neutral" @click="saveModelDraft">保存</UButton>
				</div>
			</div>
		</template>
	</UModal>
	<UModal
		:open="!!removingProvider"
		:title="removeIsCustom ? '删除自定义 Provider' : '删除 Provider 配置'"
		:description="
			removeIsCustom
				? '模型配置和本机凭据会被移除，其他 Provider 不受影响。'
				: '只移除本机凭据；内置模型目录不会删除，可重新配置后使用。'
		"
		@update:open="
			(value) => {
				if (!value) removingProvider = '';
			}
		"
	>
		<template #body>
			<div class="settings-form">
				<p class="settings-muted">
					{{
						removeIsCustom
							? `确定删除“${providerLabel(removingProvider)}”？`
							: `确定移除“${providerLabel(removingProvider)}”的本机认证？`
					}}
				</p>
				<p v-if="error" class="workspace-error" role="alert">{{ error }}</p>
				<div class="settings-actions">
					<UButton color="neutral" variant="ghost" @click="removingProvider = ''">取消</UButton>
					<UButton color="error" :loading="saving" @click="confirmRemoveProvider">删除</UButton>
				</div>
			</div>
		</template>
	</UModal>
</template>

<style scoped>
:global(.settings-modal) {
	width: min(92vw, 860px);
	max-width: 860px !important;
	height: min(86vh, 740px);
	padding: 0 !important;
	overflow: hidden;
	border-radius: 16px;
	background: var(--surface);
}
.settings-shell {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}
.settings-header {
	display: flex;
	flex: none;
	align-items: center;
	justify-content: space-between;
	height: 58px;
	padding: 0 18px 0 22px;
	border-bottom: 1px solid var(--line-soft);
}
.settings-header h2 {
	margin: 0;
	color: var(--ink);
	font-size: 17px;
	font-weight: 600;
}
.settings-header p {
	margin: 2px 0 0;
	color: var(--faint);
	font-size: 9px;
}
.settings-header-actions {
	display: flex;
	align-items: center;
	gap: 6px;
}
.settings-page {
	display: flex;
	flex: 1;
	min-height: 0;
	background: var(--surface);
}
.settings-layout {
	display: grid;
	grid-template-columns: 244px minmax(0, 1fr);
	flex: 1;
	min-height: 0;
}
.settings-nav {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 20px 14px 18px;
	overflow-y: auto;
	border-right: 1px solid var(--line-soft);
	background: var(--sidebar);
}
.settings-nav-group {
	display: grid;
	gap: 2px;
}
.settings-nav-label {
	padding: 0 10px 4px;
	color: var(--faint);
	font-size: 11px;
	font-weight: 500;
}
.settings-nav > button,
.settings-nav-group > button {
	display: flex;
	align-items: center;
	gap: 10px;
	height: 36px;
	padding: 0 10px;
	border: 0;
	border-radius: 7px;
	background: transparent;
	color: var(--muted);
	cursor: pointer;
	font: inherit;
	font-size: 13px;
	text-align: left;
}
.settings-nav > button:hover,
.settings-nav-group > button:hover {
	background: var(--hover);
	color: var(--ink);
}
.settings-nav > button.active,
.settings-nav-group > button.active {
	background: var(--active);
	color: var(--ink);
}
.settings-nav > button svg,
.settings-nav-group > button svg {
	flex: none;
	font-size: 15px;
}
.settings-back {
	margin-bottom: 2px;
	border: 1px solid var(--line-soft) !important;
	background: var(--surface) !important;
	color: var(--ink) !important;
	font-weight: 500 !important;
}
.settings-open-config {
	margin-top: auto;
	border-top: 1px solid var(--line-soft) !important;
	border-radius: 0 !important;
	color: var(--faint) !important;
}
.settings-profile-footer {
	margin-top: auto;
	padding: 8px 4px 0;
	gap: 4px;
}
.settings-content {
	min-width: 0;
	overflow-y: auto;
	padding: 34px clamp(28px, 8vw, 150px);
}
.settings-section {
	display: grid;
	gap: 14px;
	max-width: 760px;
}
.settings-section.models-section {
	max-width: none;
}
.settings-section h3 {
	margin: 0 0 2px;
	color: var(--ink);
	font-size: 16px;
	font-weight: 600;
}
.provider-list {
	display: grid;
	gap: 8px;
}
.provider-card {
	display: flex;
	align-items: center;
	justify-content: space-between;
	min-height: 58px;
	padding: 12px 16px;
	border: 1px solid var(--line-soft);
	border-radius: 11px;
	background: var(--surface-raised);
}
.provider-actions {
	display: flex;
	align-items: center;
	gap: 2px;
	flex: none;
}
.mcp-command {
	overflow: hidden;
	max-width: min(52vw, 620px);
	color: var(--faint);
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 9px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.mcp-switch {
	position: relative;
	width: 32px;
	height: 18px;
	padding: 0;
	border: 0;
	border-radius: 999px;
	background: var(--line);
	cursor: pointer;
}
.mcp-switch span {
	position: absolute;
	top: 2px;
	left: 2px;
	width: 14px;
	height: 14px;
	border-radius: 50%;
	background: var(--surface);
	transition: transform 0.15s ease;
}
.mcp-switch.on {
	background: var(--ink);
}
.mcp-switch.on span {
	transform: translateX(14px);
}
.skills-toolbar {
	display: flex;
	align-items: center;
	gap: 6px;
}
.skills-search {
	min-width: 0;
	flex: 1;
}
.skill-warning {
	margin: 0;
	padding: 8px 10px;
	border: 1px solid color-mix(in srgb, #d97706 25%, var(--line));
	border-radius: 8px;
	background: color-mix(in srgb, #d97706 7%, transparent);
	color: #b45309;
	font-size: 10px;
}
.skill-group {
	display: grid;
	gap: 6px;
}
.skill-group h4 {
	margin: 0;
	color: var(--faint);
	font-size: 10px;
	font-weight: 500;
}
.skill-group h4 span {
	margin-left: 4px;
}
.skill-row {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	padding: 11px 12px;
	border: 1px solid var(--line-soft);
	border-radius: 10px;
	background: var(--surface-raised);
}
.skill-icon {
	flex: none;
	margin-top: 1px;
	color: var(--accent);
}
.skill-copy {
	display: grid;
	min-width: 0;
	flex: 1;
	gap: 3px;
}
.skill-copy strong {
	color: var(--ink);
	font-size: 12px;
	font-weight: 550;
}
.skill-copy span {
	display: -webkit-box;
	overflow: hidden;
	color: var(--faint);
	font-size: 10px;
	line-height: 1.45;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
}
.skill-scope {
	flex: none;
	padding: 2px 5px;
	border-radius: 4px;
	background: var(--sidebar);
	color: var(--faint);
	font-size: 9px;
}
.provider-main {
	display: grid;
	gap: 4px;
	min-width: 0;
}
.provider-main strong {
	overflow: hidden;
	color: var(--ink);
	font-size: 14px;
	font-weight: 500;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.provider-state {
	display: flex;
	align-items: center;
	gap: 5px;
	color: #16a34a;
	font-size: 10px;
}
.provider-state.offline {
	color: var(--faint);
}
.provider-dot {
	display: block;
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: #22c55e;
}
.provider-state.offline .provider-dot {
	background: var(--faint);
}
.provider-add {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	min-height: 46px;
	padding: 0 14px;
	border: 1px dashed var(--line);
	border-radius: 11px;
	background: transparent;
	color: var(--muted);
	cursor: pointer;
	font: inherit;
	font-size: 12px;
}
.provider-add:hover {
	border-color: var(--accent);
	color: var(--ink);
}
.provider-add svg {
	font-size: 14px;
}
.provider-editor {
	display: grid;
	gap: 10px;
	padding: 14px;
	border: 1px solid var(--line-soft);
	border-radius: 11px;
	background: var(--surface-raised);
}
.provider-editor h4 {
	margin: 0;
	color: var(--ink);
	font-size: 12px;
	font-weight: 550;
}
.provider-form {
	display: grid;
	gap: 8px;
}
.provider-add-mode {
	display: flex;
	gap: 2px;
	padding: 2px;
	border-radius: 7px;
	background: var(--sidebar);
}
.provider-add-mode button {
	flex: 1;
	padding: 6px 8px;
	border: 0;
	border-radius: 5px;
	background: transparent;
	color: var(--faint);
	cursor: pointer;
	font: inherit;
	font-size: 10px;
}
.provider-add-mode button.active {
	background: var(--surface);
	color: var(--ink);
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
.provider-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 8px;
}
.provider-grid > div {
	display: grid;
	gap: 8px;
}
.provider-form label {
	color: var(--muted);
	font-size: 11px;
}
.provider-check {
	display: flex;
	align-items: center;
	gap: 7px;
	color: var(--muted);
	font-size: 11px;
}
.provider-check input {
	width: 13px;
	height: 13px;
	accent-color: var(--accent);
}
.provider-advanced {
	display: grid;
	gap: 10px;
	padding: 10px;
	border: 1px solid var(--line-soft);
	border-radius: 8px;
	background: var(--sidebar);
}
.provider-advanced summary {
	color: var(--muted);
	font-size: 11px;
	cursor: pointer;
}
.provider-advanced[open] summary {
	margin-bottom: 2px;
	color: var(--ink);
}
.advanced-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
	gap: 10px;
}
.advanced-field {
	display: grid;
	min-width: 0;
	gap: 5px;
}
.advanced-field > span,
.advanced-grid > label {
	align-self: end;
	color: var(--muted);
	font-size: 11px;
}
.custom-models {
	display: grid;
	gap: 5px;
}
.custom-models-card {
	gap: 0;
	padding: 0 !important;
	overflow: hidden;
}
.custom-models-card .card-head {
	padding: 12px 14px;
	border-bottom: 1px solid var(--line-soft);
}
.custom-models-card .custom-models {
	gap: 0;
}
.custom-model-row {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 10px 14px;
	border: 0;
	border-top: 1px solid var(--line-soft);
	border-radius: 0;
	background: var(--surface);
}
.custom-model-row:first-child {
	border-top: 0;
}
.custom-model-copy {
	display: grid;
	min-width: 0;
	flex: 1;
	gap: 4px;
}
.custom-model-copy strong {
	overflow: hidden;
	color: var(--ink);
	font-size: 13px;
	font-weight: 500;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.model-badges {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}
.model-badge {
	padding: 1px 5px;
	border: 1px solid var(--line-soft);
	border-radius: 4px;
	color: var(--faint);
	font-size: 9px;
}
.custom-model-actions {
	display: flex;
	align-items: center;
	gap: 1px;
	flex: none;
}
:global(.model-dialog) {
	width: min(92vw, 560px);
	max-width: 560px !important;
	padding: 0 !important;
}
.model-dialog-body {
	display: grid;
	gap: 14px;
	max-height: calc(100dvh - 120px);
	overflow-y: auto;
	padding: 22px;
}
.model-dialog-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.model-dialog-head h3 {
	margin: 0;
	color: var(--ink);
	font-size: 16px;
	font-weight: 600;
}
.model-dialog-body .advanced-grid {
	grid-template-columns: 1fr;
}
.model-dialog-actions {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	padding-top: 4px;
}
.model-editor {
	display: grid;
	gap: 10px;
	padding: 12px;
	border: 1px solid var(--line);
	border-radius: 9px;
	background: var(--surface);
}
.model-editor-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.model-editor-head strong {
	color: var(--ink);
	font-size: 11px;
	font-weight: 600;
}
.advanced-block {
	display: grid;
	gap: 5px;
}
.advanced-block > span {
	color: var(--muted);
	font-size: 11px;
}
.advanced-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}
.advanced-chip {
	padding: 5px 8px;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--surface);
	color: var(--muted);
	font: inherit;
	font-size: 10px;
	cursor: pointer;
}
.advanced-chip:hover:not(:disabled) {
	border-color: var(--faint);
	color: var(--ink);
}
.advanced-chip.active {
	border-color: var(--line);
	background: var(--active);
	color: var(--ink);
}
.advanced-chip:disabled {
	opacity: 0.55;
	cursor: default;
}
.provider-oauth {
	display: grid;
	gap: 8px;
	padding-top: 10px;
	border-top: 1px solid var(--line-soft);
}
.settings-card {
	display: grid;
	gap: 9px;
	padding: 13px 14px;
	border: 1px solid var(--line-soft);
	border-radius: 10px;
	background: var(--surface-raised);
}
.settings-card h4 {
	margin: 0;
	color: var(--ink);
	font-size: 12px;
	font-weight: 550;
}
.card-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}
.settings-muted {
	margin: 0;
	color: var(--faint);
	font-size: 10px;
	line-height: 1.65;
}
.settings-card code {
	overflow: hidden;
	padding: 5px 7px;
	border-radius: 4px;
	background: var(--sidebar);
	color: var(--muted);
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 10px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.account-card {
	display: flex;
	align-items: center;
	gap: 11px;
	padding: 14px;
	border: 1px solid var(--line-soft);
	border-radius: 10px;
	background: var(--surface-raised);
}
.account-avatar {
	display: grid;
	width: 38px;
	height: 38px;
	place-items: center;
	border-radius: 50%;
	background: var(--ink);
	color: var(--surface);
	font-size: 16px;
	font-weight: 600;
}
.account-card > div {
	display: grid;
	gap: 3px;
}
.account-card strong {
	color: var(--ink);
	font-size: 13px;
	font-weight: 550;
}
.account-card span:not(.account-avatar) {
	color: var(--faint);
	font-size: 10px;
}
.metric-list {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 8px;
}
.metric-list > div {
	display: grid;
	gap: 3px;
	padding: 8px;
	border-radius: 7px;
	background: var(--sidebar);
}
.metric-list span {
	color: var(--faint);
	font-size: 9px;
}
.metric-list strong {
	color: var(--ink);
	font-size: 16px;
	font-weight: 550;
}
.theme-options {
	display: flex;
	gap: 7px;
}
.theme-options button {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: 1;
	padding: 10px;
	border: 1px solid var(--line-soft);
	border-radius: 7px;
	background: var(--surface);
	color: var(--muted);
	cursor: pointer;
	font: inherit;
	font-size: 11px;
}
.theme-options button.active {
	border-color: var(--accent);
	color: var(--ink);
}
.theme-options svg {
	font-size: 15px;
}
.setting-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	color: var(--faint);
	font-size: 11px;
}
.setting-row strong {
	overflow: hidden;
	max-width: 70%;
	color: var(--ink);
	font-size: 11px;
	font-weight: 450;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.settings-actions {
	display: flex;
	gap: 5px;
	flex-wrap: wrap;
}
.settings-inline-button {
	justify-self: start;
	width: auto;
}
.extension-list {
	display: grid;
	gap: 5px;
}
.extension-list > div {
	display: grid;
	gap: 2px;
	padding-top: 5px;
	border-top: 1px solid var(--line-soft);
}
.extension-list strong {
	color: var(--ink);
	font-size: 11px;
	font-weight: 500;
}
.extension-list span {
	overflow: hidden;
	color: var(--faint);
	font-family: "Cascadia Code", Consolas, monospace;
	font-size: 9px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.settings-form {
	display: grid;
	gap: 9px;
}
.settings-form label {
	color: var(--muted);
	font-size: 11px;
}
.settings-form button[type="submit"] {
	justify-self: start;
	margin-top: 2px;
}
@media (max-width: 720px) {
	:global(.settings-modal) {
		width: 96vw;
		height: 90vh;
	}
	.settings-layout {
		grid-template-columns: 1fr;
	}
	.settings-nav {
		flex-direction: row;
		overflow-x: auto;
		border-right: 0;
		border-bottom: 1px solid var(--line-soft);
	}
	.settings-nav button {
		flex: none;
	}
	.settings-content {
		padding: 18px;
	}
}
</style>
