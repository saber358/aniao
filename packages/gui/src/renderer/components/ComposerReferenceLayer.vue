<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { UIcon } from "../ui.ts";

const props = defineProps<{
	textarea: HTMLTextAreaElement | null;
	draft: string;
	placeholder: string;
}>();
const emit = defineEmits<{
	change: [text: string, cursor: number];
}>();

interface TextPart {
	kind: "text";
	key: string;
	text: string;
}
interface ReferencePart {
	kind: "reference";
	key: string;
	raw: string;
	path: string;
	name: string;
	folder: boolean;
}
type Part = TextPart | ReferencePart;

const host = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const metrics = ref<Record<string, string>>({});
let attached: HTMLTextAreaElement | null = null;
let previousPosition = "";
let previousZIndex = "";
let previousBackground = "";

const parts = computed<Part[]>(() => {
	const source = props.draft;
	const result: Part[] = [];
	const pattern = /@"((?:\\.|[^"\\])*)"[ \t]?/g;
	let last = 0;
	for (const match of source.matchAll(pattern)) {
		const index = match.index ?? 0;
		let path: unknown;
		try {
			path = JSON.parse(`"${match[1]}"`);
		} catch {
			continue;
		}
		if (typeof path !== "string" || !path) continue;
		if (index > last) result.push({ kind: "text", key: `t-${last}`, text: source.slice(last, index) });
		const trimmed = path.replace(/\/+$/, "");
		const name = path.endsWith("/") ? `${trimmed}/` : trimmed;
		result.push({
			kind: "reference",
			key: `r-${index}`,
			raw: match[0],
			path,
			name,
			folder: path.endsWith("/"),
		});
		last = index + match[0].length;
	}
	if (last < source.length) result.push({ kind: "text", key: `t-${last}`, text: source.slice(last) });
	return result;
});
const empty = computed(() => props.draft.length === 0);

function attach(): void {
	const textarea = props.textarea;
	if (textarea === attached && host.value === textarea?.parentElement) return;
	detach();
	if (!textarea) return;
	const parent = textarea.parentElement;
	if (!parent) return;
	attached = textarea;
	host.value = parent;
	previousPosition = textarea.style.position;
	previousZIndex = textarea.style.zIndex;
	previousBackground = textarea.style.background;
	textarea.style.position = "relative";
	textarea.style.zIndex = "1";
	textarea.style.background = "transparent";
	textarea.classList.add("composer-token-textarea");
	const style = getComputedStyle(textarea);
	metrics.value = {
		fontFamily: style.fontFamily,
		fontSize: style.fontSize,
		fontWeight: style.fontWeight,
		lineHeight: style.lineHeight,
		letterSpacing: style.letterSpacing,
		paddingTop: style.paddingTop,
		paddingRight: style.paddingRight,
		paddingBottom: style.paddingBottom,
		paddingLeft: style.paddingLeft,
		whiteSpace: style.whiteSpace,
		overflowWrap: style.overflowWrap,
		wordBreak: style.wordBreak,
		tabSize: style.tabSize,
		textAlign: style.textAlign,
	};
	scrollTop.value = textarea.scrollTop;
	textarea.addEventListener("scroll", syncScroll);
	window.addEventListener("keydown", keydown, true);
}

function detach(): void {
	if (attached) {
		attached.classList.remove("composer-token-textarea");
		attached.style.position = previousPosition;
		attached.style.zIndex = previousZIndex;
		attached.style.background = previousBackground;
		attached.removeEventListener("scroll", syncScroll);
	}
	window.removeEventListener("keydown", keydown, true);
	attached = null;
	host.value = null;
}

function syncScroll(): void {
	scrollTop.value = props.textarea?.scrollTop ?? 0;
}

function keydown(event: KeyboardEvent): void {
	const textarea = props.textarea;
	if (event.target !== textarea || !textarea) return;
	if (event.altKey || event.ctrlKey || event.metaKey || textarea.selectionStart !== textarea.selectionEnd) return;
	const start = textarea.selectionStart;
	if (event.key === "Backspace" && start > 0) {
		const before = props.draft.slice(0, start);
		const match = before.match(/@"(?:\\.|[^"\\])*"[ \t]?$/);
		if (!match) return;
		event.preventDefault();
		event.stopPropagation();
		const end = start;
		const next = props.draft.slice(0, end - match[0].length) + props.draft.slice(end);
		emit("change", next, end - match[0].length);
		return;
	}
	if (event.key === "Delete" && start < props.draft.length) {
		const after = props.draft.slice(start);
		const match = after.match(/^[ \t]?@"(?:\\.|[^"\\])*"/);
		if (!match) return;
		event.preventDefault();
		event.stopPropagation();
		const next = props.draft.slice(0, start) + props.draft.slice(start + match[0].length);
		emit("change", next, start);
	}
}

watch(() => props.textarea, attach, { immediate: true });
watch(
	() => props.draft,
	() => {
		scrollTop.value = props.textarea?.scrollTop ?? 0;
	},
);
onMounted(attach);
onBeforeUnmount(detach);
</script>

<template>
	<Teleport v-if="host" :to="host">
		<div class="composer-token-layer" aria-hidden="true">
			<div class="composer-token-content" :style="{ ...metrics, transform: `translateY(-${scrollTop}px)` }">
				<span v-if="empty" class="composer-token-placeholder">{{ placeholder }}</span>
				<template v-for="part in parts" :key="part.key">
					<span v-if="part.kind === 'text'" class="composer-token-text">{{ part.text }}</span>
					<span v-else class="composer-token-reference" :title="part.path">
						<span class="composer-token-raw">{{ part.raw }}</span>
						<span class="composer-token-chip">
							<UIcon :name="part.folder ? 'i-lucide-folder' : 'i-lucide-file-text'" aria-hidden="true" />
							<span class="composer-token-name">{{ part.name }}</span>
						</span>
					</span>
				</template>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.composer-token-layer {
	position: absolute;
	z-index: 0;
	inset: 0;
	overflow: hidden;
	pointer-events: none;
	color: var(--ink);
}
.composer-token-content {
	box-sizing: border-box;
	width: 100%;
	min-height: 100%;
	white-space: pre-wrap;
	overflow-wrap: break-word;
	word-break: break-word;
}
.composer-token-text {
	white-space: pre-wrap;
}
.composer-token-placeholder {
	color: var(--faint);
}
.composer-token-reference {
	position: relative;
	display: inline;
	white-space: pre;
}
.composer-token-raw {
	visibility: hidden;
}
.composer-token-chip {
	position: absolute;
	top: 50%;
	left: 0;
	display: inline-flex;
	align-items: center;
	gap: 4px;
	max-width: 100%;
	height: 1.65em;
	overflow: hidden;
	transform: translateY(-50%);
	color: var(--accent);
	cursor: text;
	white-space: nowrap;
}
.composer-token-chip svg {
	flex: none;
	width: 14px;
	height: 14px;
}
.composer-token-name {
	overflow: hidden;
	text-overflow: ellipsis;
}
</style>
