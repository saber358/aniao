<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ResourceSnapshot } from "../../shared/resources.ts";
import { UIcon } from "../ui.ts";

interface CommandItem {
	id: string;
	group: "添加" | "指令" | "技能" | "命令";
	label: string;
	alias: string;
	description: string;
	icon: string;
	insert?: string;
	action?: "file" | "plan" | "model";
}

const props = defineProps<{
	textarea: HTMLTextAreaElement | null;
	draft: string;
	resources: ResourceSnapshot | null;
	planActive: boolean;
	busy: boolean;
}>();
const emit = defineEmits<{
	"set-draft": [text: string, cursor: number];
	file: [];
	plan: [];
	model: [];
}>();
const open = ref(false);
const active = ref(0);
const list = ref<HTMLElement | null>(null);
const candidates = computed(() => {
	const query = props.draft.startsWith("/") ? props.draft.slice(1).trim().toLocaleLowerCase() : "";
	const items: CommandItem[] = [
		{
			id: "file",
			group: "添加",
			label: "文件",
			alias: "file",
			description: "引用项目文件",
			icon: "i-lucide-paperclip",
			action: "file",
		},
		{
			id: "plan",
			group: "添加",
			label: props.planActive ? "退出计划" : "计划",
			alias: "plan",
			description: props.planActive ? "退出计划模式" : "进入或退出计划模式",
			icon: "i-lucide-list-checks",
			action: "plan",
		},
		{
			id: "model",
			group: "指令",
			label: "模型",
			alias: "model",
			description: "选择本会话使用的模型",
			icon: "i-lucide-cpu",
			action: "model",
		},
	];
	for (const skill of props.resources?.skills ?? []) {
		items.push({
			id: `skill:${skill.name}`,
			group: "技能",
			label: skill.name,
			alias: "skill",
			description: skill.description || skill.path,
			icon: "i-lucide-sparkles",
			insert: `/skill:${skill.name} `,
		});
	}
	for (const command of props.resources?.commands ?? []) {
		if (command.name.startsWith("skill:")) continue;
		items.push({
			id: `command:${command.source}:${command.name}`,
			group: "命令",
			label: command.name,
			alias: command.source,
			description: command.description || command.path || "",
			icon: "i-lucide-terminal",
			insert: `/${command.name} `,
		});
	}
	return items.filter(
		(item) => !query || `${item.label}\n${item.alias}\n${item.description}`.toLocaleLowerCase().includes(query),
	);
});
const groups = computed(() => {
	const result: Array<{ label: CommandItem["group"]; items: CommandItem[] }> = [];
	for (const item of candidates.value) {
		const group = result.find((entry) => entry.label === item.group);
		if (group) group.items.push(item);
		else result.push({ label: item.group, items: [item] });
	}
	return result;
});
const flat = computed(() => groups.value.flatMap((group) => group.items));
const visible = computed(() => open.value && flat.value.length > 0);

watch(candidates, () => {
	active.value = 0;
});
watch(
	() => [props.draft, props.textarea] as const,
	() => sync(),
	{ immediate: true },
);
watch(
	() => props.busy,
	(busy) => {
		if (busy) open.value = false;
	},
);

function sync(): void {
	const element = props.textarea;
	open.value =
		!props.busy &&
		!!element &&
		document.activeElement === element &&
		/^\/(?:[^\s]*)?$/.test(element.value) &&
		element.selectionStart === element.value.length;
}

function stop(event: KeyboardEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function select(item: CommandItem): void {
	if (item.action === "file") {
		emit("set-draft", "@", 1);
		emit("file");
	} else if (item.action === "plan") {
		emit("set-draft", "", 0);
		emit("plan");
	} else if (item.action === "model") {
		emit("set-draft", "", 0);
		emit("model");
	} else if (item.insert) {
		emit("set-draft", item.insert, item.insert.length);
	}
	open.value = false;
}

function keydown(event: KeyboardEvent): void {
	if (event.target !== props.textarea || !visible.value) return;
	if (event.key === "Escape") {
		open.value = false;
		stop(event);
		return;
	}
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		const size = flat.value.length;
		if (!size) return;
		active.value = (active.value + (event.key === "ArrowDown" ? 1 : size - 1)) % size;
		nextTick(() => {
			list.value?.children.item(active.value)?.scrollIntoView({ block: "nearest" });
		});
		stop(event);
		return;
	}
	if (event.key === "Enter" || event.key === "Tab") {
		const item = flat.value[active.value];
		if (item) {
			stop(event);
			select(item);
		}
	}
}

const capture = { capture: true };
onMounted(() => {
	window.addEventListener("keydown", keydown, capture);
});
watch(
	() => props.textarea,
	() => sync(),
);
onBeforeUnmount(() => {
	window.removeEventListener("keydown", keydown, capture);
});
</script>

<template>
	<div v-if="visible" class="slash-menu" role="listbox" aria-label="命令菜单">
		<div ref="list" class="slash-scroll">
			<section v-for="group in groups" :key="group.label" class="slash-group">
				<div class="slash-group-label">{{ group.label }}</div>
				<button
					v-for="item in group.items"
					:key="item.id"
					type="button"
					class="slash-item"
					:class="{ active: flat.indexOf(item) === active }"
					role="option"
					:aria-selected="flat.indexOf(item) === active"
					@pointermove="active = flat.indexOf(item)"
					@click="select(item)"
				>
					<UIcon :name="item.icon" class="slash-icon" aria-hidden="true" />
					<span class="slash-label">{{ item.label }}</span>
					<span v-if="item.group !== '技能'" class="slash-alias">{{ item.alias }}</span>
					<span class="slash-description">{{ item.description }}</span>
				</button>
			</section>
		</div>
	</div>
</template>

<style scoped>
.slash-menu {
	position: absolute;
	z-index: 30;
	bottom: calc(100% + 8px);
	left: 12px;
	right: 12px;
	width: auto;
	max-height: 420px;
	overflow: hidden;
	border: 1px solid var(--line-soft);
	border-radius: 12px;
	background: var(--surface);
	box-shadow: 0 12px 30px #0f11151a;
}
.slash-scroll {
	max-height: 420px;
	overflow-y: auto;
	padding: 6px;
}
.slash-group {
	display: grid;
	gap: 1px;
	padding: 5px 0;
}
.slash-group + .slash-group {
	border-top: 1px solid var(--line-soft);
}
.slash-group-label {
	padding: 4px 9px;
	color: var(--faint);
	font-size: 11px;
}
.slash-item {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	padding: 7px 9px;
	border: 0;
	border-radius: 7px;
	background: transparent;
	color: var(--ink);
	cursor: pointer;
	font: inherit;
	font-size: 13px;
	text-align: left;
}
.slash-item.active {
	background: var(--active);
}
.slash-icon {
	flex: none;
	color: var(--faint);
	font-size: 15px;
}
.slash-label {
	flex: none;
	font-weight: 500;
}
.slash-alias {
	flex: none;
	color: var(--faint);
	font-size: 11px;
}
.slash-description {
	overflow: hidden;
	flex: 1;
	min-width: 0;
	color: var(--faint);
	font-size: 11px;
	text-align: right;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>
