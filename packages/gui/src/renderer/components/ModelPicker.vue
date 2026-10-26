<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Configuration, ThinkingLevel } from "../../shared/protocol.ts";
import { UButton, UIcon } from "../ui.ts";

const props = defineProps<{
	configuration: Configuration | null;
	disabled: boolean;
	thinking: ThinkingLevel;
	thinkingLevels: ThinkingLevel[];
	thinkingDisabled: boolean;
}>();
const emit = defineEmits<{ select: [key: string]; "set-thinking": [level: ThinkingLevel] }>();

const providerNames: Record<string, string> = {
	anthropic: "Anthropic",
	deepseek: "DeepSeek",
	google: "Google",
	openai: "OpenAI",
	openrouter: "OpenRouter",
};
const thinkingLabels: Record<ThinkingLevel, string> = {
	off: "关闭",
	minimal: "最低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "更高",
	max: "最高",
};
const open = ref(false);
const selectedProvider = ref("");
const providerMenuOpen = ref(false);
let providerCloseTimer: ReturnType<typeof setTimeout> | undefined;

interface ProviderGroup {
	id: string;
	name: string;
	models: Configuration["models"];
}

const availableModels = computed(() => props.configuration?.models.filter((model) => model.available) ?? []);
const providers = computed<ProviderGroup[]>(() => {
	const groups = new Map<string, ProviderGroup>();
	for (const model of availableModels.value) {
		const name = model.providerName ?? providerLabel(model.provider);
		const group = groups.get(model.provider);
		if (group) group.models.push(model);
		else groups.set(model.provider, { id: model.provider, name, models: [model] });
	}
	return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
});
const currentGroup = computed(() => providers.value.find((group) => group.id === selectedProvider.value));
const currentModel = computed(
	() => availableModels.value.find((model) => model.key === props.configuration?.model?.key) ?? null,
);
const triggerLabel = computed(() => currentModel.value?.name ?? "选择模型");
const thinkingLabel = computed(() => thinkingLabels[props.thinking] ?? props.thinking);
const thinkingIndex = computed(() => {
	const index = props.thinkingLevels.indexOf(props.thinking);
	return index < 0 ? 0 : index;
});

function setThinkingIndex(event: Event): void {
	const index = Number((event.target as HTMLInputElement).value);
	const level = props.thinkingLevels[index];
	if (level) emit("set-thinking", level);
}

function providerLabel(provider: string): string {
	const known = providerNames[provider];
	if (known) return known;
	return provider
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function toggle() {
	if (props.disabled) return;
	open.value = !open.value;
	providerMenuOpen.value = false;
	clearProviderClose();
	if (open.value) selectedProvider.value = currentModel.value?.provider ?? "";
}

function openPicker() {
	if (props.disabled) return;
	open.value = true;
	providerMenuOpen.value = false;
	clearProviderClose();
	selectedProvider.value = currentModel.value?.provider ?? "";
}
defineExpose({ openPicker });

function close() {
	open.value = false;
	selectedProvider.value = "";
	providerMenuOpen.value = false;
	clearProviderClose();
}

function chooseProvider(provider: string) {
	selectedProvider.value = provider;
	providerMenuOpen.value = false;
	clearProviderClose();
}

function openProviderMenu() {
	clearProviderClose();
	providerMenuOpen.value = true;
}

function scheduleProviderClose() {
	clearProviderClose();
	providerCloseTimer = setTimeout(() => {
		providerMenuOpen.value = false;
		providerCloseTimer = undefined;
	}, 250);
}

function clearProviderClose() {
	if (providerCloseTimer) clearTimeout(providerCloseTimer);
	providerCloseTimer = undefined;
}

function toggleProviderMenu() {
	if (providerMenuOpen.value) {
		providerMenuOpen.value = false;
		clearProviderClose();
	} else {
		openProviderMenu();
	}
}

function chooseModel(key: string) {
	emit("select", key);
	close();
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === "Escape" && open.value) close();
}

watch(
	() => props.disabled,
	(disabled) => {
		if (disabled) close();
	},
);

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
	window.removeEventListener("keydown", onKeydown);
	clearProviderClose();
});
</script>

<template>
	<div class="model-picker">
		<UButton
			variant="ghost"
			size="sm"
			class="model-select"
			:disabled="disabled"
			aria-haspopup="dialog"
			:aria-expanded="open"
			aria-label="模型和思考等级"
			@click="toggle"
		>
			<span class="model-select-name">{{ triggerLabel }}</span>
			<span class="model-select-thinking">{{ thinkingLabel }}</span>
			<UIcon name="i-lucide-chevron-down" aria-hidden="true" />
		</UButton>
		<template v-if="open">
			<div class="model-picker-scrim" @click="close" />
			<div class="model-picker-popovers">
				<div class="model-picker-panel model-picker-main" role="dialog" aria-label="模型和思考等级">
					<div class="model-picker-api" @mouseenter="openProviderMenu">
						<button
							type="button"
							class="model-picker-api-row"
							:aria-expanded="providerMenuOpen"
							@mouseleave="scheduleProviderClose"
							@click="toggleProviderMenu"
						>
							<span class="model-picker-name">{{ currentGroup?.name ?? "选择 API" }}</span>
							<span class="model-picker-api-label">API</span>
							<UIcon name="i-lucide-chevron-right" aria-hidden="true" />
						</button>
						<div
							v-if="providerMenuOpen"
							class="model-picker-api-flyout"
							role="listbox"
							aria-label="选择 API"
							@mouseenter="openProviderMenu"
							@mouseleave="scheduleProviderClose"
						>
							<button
								v-for="provider in providers"
								:key="provider.id"
								type="button"
								role="option"
								class="model-picker-row"
								:class="{ selected: provider.id === selectedProvider }"
								:aria-selected="provider.id === selectedProvider"
								@click="chooseProvider(provider.id)"
							>
								<span class="model-picker-name">{{ provider.name }}</span>
								<span class="model-picker-api-label">API</span>
								<UIcon v-if="provider.id === selectedProvider" name="i-lucide-check" aria-hidden="true" />
							</button>
							<p v-if="!providers.length" class="model-picker-empty">还没有已配置的模型提供商。</p>
						</div>
					</div>
					<div class="model-picker-title">模型</div>
					<div v-if="currentGroup" role="listbox" :aria-label="currentGroup.name">
						<button
							v-for="model in currentGroup.models"
							:key="model.key"
							type="button"
							role="option"
							class="model-picker-row"
							:class="{ selected: model.key === currentModel?.key }"
							:aria-selected="model.key === currentModel?.key"
							@click="chooseModel(model.key)"
						>
							<span class="model-picker-name">{{ model.name }}</span>
							<span v-if="model.supportsImages" class="model-picker-badge">视觉</span>
							<UIcon v-if="model.key === currentModel?.key" name="i-lucide-check" aria-hidden="true" />
						</button>
						<div v-if="thinkingLevels.length > 1" class="model-picker-thinking">
							<div class="model-picker-thinking-head">
								<span>思考强度</span>
								<strong>{{ thinkingLabel }}</strong>
							</div>
							<input
								type="range"
								:min="0"
								:max="thinkingLevels.length - 1"
								step="1"
								:value="thinkingIndex"
								:disabled="thinkingDisabled"
								:aria-label="`思考强度：${thinkingLabel}`"
								@input="setThinkingIndex"
							/>
						</div>
					</div>
					<p v-else class="model-picker-empty">选择上方的 API 后查看模型。</p>
				</div>
			</div>
		</template>
	</div>
</template>

<style scoped>
.model-picker {
	position: relative;
	display: inline-flex;
	min-width: 0;
}
.model-select {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	max-width: 300px;
	min-width: 100px;
	font-size: 13px;
}
.model-select-name {
	overflow: hidden;
	max-width: 180px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.model-select-thinking {
	flex: none;
	color: var(--faint);
	font-size: 12px;
}
.model-select svg {
	flex: none;
	color: var(--faint);
	font-size: 12px;
}
.model-picker-scrim {
	position: fixed;
	inset: 0;
	z-index: 40;
}
.model-picker-popovers {
	position: absolute;
	right: 0;
	bottom: calc(100% + 8px);
	z-index: 41;
	display: flex;
	align-items: flex-end;
	gap: 2px;
}
.model-picker-panel {
	display: grid;
	gap: 2px;
	flex: none;
	width: 184px;
	max-height: none;
	overflow: visible;
	padding: 6px;
	border: 1px solid var(--line);
	border-radius: 10px;
	background: var(--surface);
	box-shadow: 0 12px 30px #0f11151f;
}
.model-picker-main {
	width: 244px;
}
.model-picker-api {
	position: relative;
	padding-bottom: 4px;
	border-bottom: 1px solid var(--line-soft);
}
.model-picker-api-row {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	min-height: 34px;
	padding: 0 7px;
	border: 0;
	border-radius: 6px;
	background: transparent;
	color: var(--ink);
	font: inherit;
	font-size: 11px;
	text-align: left;
	cursor: pointer;
}
.model-picker-api-row:hover {
	background: var(--active);
}
.model-picker-api-row > svg:last-child {
	flex: none;
	color: var(--faint);
	font-size: 12px;
}
.model-picker-api-label {
	flex: none;
	padding: 1px 4px;
	border: 1px solid var(--line);
	border-radius: 4px;
	color: var(--faint);
	font-size: 8px;
}
.model-picker-api-flyout {
	position: absolute;
	top: 0;
	left: calc(100% + 5px);
	z-index: 2;
	display: grid;
	gap: 2px;
	width: 184px;
	padding: 6px;
	border: 1px solid var(--line);
	border-radius: 10px;
	background: var(--surface);
	box-shadow: 0 12px 30px #0f11151f;
}
.model-picker-api-flyout::before {
	content: "";
	position: absolute;
	top: 0;
	bottom: 0;
	left: -8px;
	width: 8px;
}
.model-picker-title {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 5px 7px;
	color: var(--faint);
	font-size: 10px;
}
.model-picker-row {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	min-height: 30px;
	padding: 0 7px;
	border: 0;
	border-radius: 6px;
	background: transparent;
	color: var(--muted);
	cursor: pointer;
	font: inherit;
	font-size: 11px;
	text-align: left;
}
.model-picker-row:hover {
	background: var(--active);
	color: var(--ink);
}
.model-picker-row.selected {
	color: var(--ink);
}
.model-picker-row svg {
	flex: none;
	font-size: 13px;
}
.model-picker-name {
	overflow: hidden;
	flex: 1;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.model-picker-count {
	color: var(--faint);
	font-size: 9px;
}
.model-picker-badge {
	flex: none;
	padding: 1px 4px;
	border: 1px solid var(--line);
	border-radius: 4px;
	color: var(--faint);
	font-size: 8px;
}
.model-picker-thinking {
	display: grid;
	gap: 8px;
	margin-top: 5px;
	padding: 9px 7px 6px;
	border-top: 1px solid var(--line-soft);
}
.model-picker-thinking-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	color: var(--faint);
	font-size: 10px;
}
.model-picker-thinking-head strong {
	color: var(--muted);
	font-weight: 500;
}
.model-picker-thinking input[type="range"] {
	width: 100%;
	height: 18px;
	margin: 0;
	appearance: none;
	background: transparent;
	cursor: pointer;
}
.model-picker-thinking input[type="range"]::-webkit-slider-runnable-track {
	height: 12px;
	border-radius: 999px;
	background: linear-gradient(90deg, #0d8a58, #11a9cc 55%, #3277ff);
}
.model-picker-thinking input[type="range"]::-webkit-slider-thumb {
	width: 16px;
	height: 16px;
	margin-top: -2px;
	appearance: none;
	border: 1px solid #ffffff80;
	border-radius: 50%;
	background: #ffffff;
	box-shadow: 0 1px 4px #00000024;
}
.model-picker-thinking input[type="range"]:disabled {
	opacity: 0.5;
	cursor: default;
}
.model-picker-empty {
	margin: 0;
	padding: 8px 7px;
	color: var(--faint);
	font-size: 10px;
	line-height: 1.5;
}
</style>
