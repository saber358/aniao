<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { EditAction } from "../../shared/edit.ts";
import { createLogger } from "../../shared/logger.ts";
import { UDropdownMenu } from "../ui.ts";

const emit = defineEmits<{ settings: [] }>();
const logger = createLogger("edit-menu");
const open = ref(false);
const error = ref("");
let target: HTMLElement | null = null;
let range: Range | null = null;
let selection: { start: number; end: number; direction: "forward" | "backward" | "none" } | null = null;
let pointerSnapshot = false;
const restoreOnClose = ref(false);

function rememberFocus(event: FocusEvent): void {
	if (open.value) return;
	const element = event.target;
	if (
		element instanceof HTMLInputElement ||
		element instanceof HTMLTextAreaElement ||
		(element instanceof HTMLElement && element.isContentEditable)
	)
		target = element;
}

/*
 * ========================================================================
 * 步骤1：保留打开菜单前的编辑目标
 * ========================================================================
 * 数据源：当前输入焦点或页面文字选择，不读取剪贴板。
 * 操作：1) 在菜单抢走焦点前保存选择；2) 键盘打开沿用最近输入焦点。
 */
function captureTarget(): void {
	logger.info("开始保留编辑焦点");
	try {
		// 1.1 输入框选择与页面 Range 分开保存，避免菜单覆盖原光标。
		const active = document.activeElement;
		if (
			active instanceof HTMLInputElement ||
			active instanceof HTMLTextAreaElement ||
			(active instanceof HTMLElement && active.isContentEditable)
		)
			target = active;
		const selected = window.getSelection();
		if (
			!(active instanceof HTMLElement && active.matches('[aria-label="编辑"]')) &&
			!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
			selected &&
			!selected.isCollapsed &&
			selected.rangeCount
		) {
			range = selected.getRangeAt(0).cloneRange();
			target = active instanceof HTMLElement && active.isContentEditable ? active : null;
		} else range = null;
		selection =
			target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
				? {
						start: target.selectionStart ?? 0,
						end: target.selectionEnd ?? 0,
						direction: target.selectionDirection ?? "none",
					}
				: null;
		error.value = "";
	} finally {
		logger.info("编辑焦点保留结束");
	}
}

function updateOpen(value: boolean): void {
	// 1.2 鼠标按下时已保留原焦点，打开回调不能再用菜单按钮覆盖它。
	if (value && !pointerSnapshot) captureTarget();
	pointerSnapshot = false;
	open.value = value;
}

function preparePointerOpen(): void {
	captureTarget();
	pointerSnapshot = true;
}

/*
 * ========================================================================
 * 步骤2：菜单关闭后恢复选择并提交编辑命令
 * ========================================================================
 * 数据源：用户明确选择的菜单项和仍连接的原始元素。
 * 操作：1) 避免自动聚焦菜单按钮；2) 用 Chromium 原生命令更新输入与撤销记录。
 */
async function selectAction(action: EditAction | "settings"): Promise<void> {
	logger.info("开始处理编辑菜单选择");
	try {
		// 2.1 关闭状态生效后立即提交动作，不等退场动画才修改选择。
		open.value = false;
		await nextTick();
		restoreTarget();
		if (action === "settings") emit("settings");
		else await window.piDesktop.edit(action);
	} catch {
		error.value = "编辑操作失败，请重新选择文字后重试";
	} finally {
		logger.info("编辑菜单选择处理结束");
	}
}

function restoreTarget(): void {
	// 2.2 目标已随项目切换销毁时不重建旧输入，页面选择只恢复仍连接的 Range。
	if (target?.isConnected) {
		target.focus({ preventScroll: true });
		if (
			selection &&
			(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
			target.selectionStart !== null
		)
			target.setSelectionRange(selection.start, selection.end, selection.direction);
	}
	if (range?.commonAncestorContainer.isConnected) {
		const selected = window.getSelection();
		selected?.removeAllRanges();
		selected?.addRange(range);
	}
}

function closeMenu(event: Event): void {
	event.preventDefault();
	// 2.3 Escape 恢复原输入；点击菜单外部时保留用户刚选择的新焦点。
	if (restoreOnClose.value) restoreTarget();
	restoreOnClose.value = false;
}

const items = [
	[
		{
			label: "撤销",
			kbds: ["Ctrl", "Z"],
			onSelect: () => {
				void selectAction("undo");
			},
		},
		{
			label: "重做",
			kbds: ["Ctrl", "Y"],
			onSelect: () => {
				void selectAction("redo");
			},
		},
	],
	[
		{
			label: "剪切",
			kbds: ["Ctrl", "X"],
			onSelect: () => {
				void selectAction("cut");
			},
		},
		{
			label: "复制",
			kbds: ["Ctrl", "C"],
			onSelect: () => {
				void selectAction("copy");
			},
		},
		{
			label: "粘贴",
			kbds: ["Ctrl", "V"],
			onSelect: () => {
				void selectAction("paste");
			},
		},
		{
			label: "删除",
			kbds: ["Del"],
			onSelect: () => {
				void selectAction("delete");
			},
		},
	],
	[
		{
			label: "全选",
			kbds: ["Ctrl", "A"],
			onSelect: () => {
				void selectAction("selectAll");
			},
		},
	],
	[
		{
			label: "设置",
			kbds: ["Ctrl", ","],
			onSelect: () => {
				void selectAction("settings");
			},
		},
	],
];

onMounted(() => document.addEventListener("focusin", rememberFocus));
onBeforeUnmount(() => document.removeEventListener("focusin", rememberFocus));
</script>

<template>
	<UDropdownMenu
		:open="open"
		:modal="false"
		:items="items"
		:content="{
			align: 'start',
			sideOffset: 4,
			onCloseAutoFocus: closeMenu,
			onEscapeKeyDown: () => {
				restoreOnClose = true;
			},
		}"
		:ui="{ content: 'edit-menu-content', item: 'edit-menu-item' }"
		@update:open="updateOpen"
	>
		<button
			type="button"
			class="thread-nav-item"
			:class="{ active: open }"
			aria-label="编辑"
			@pointerdown="preparePointerOpen"
		>
			编辑
		</button>
		<template #item-trailing="{ item }">
			<span class="edit-menu-shortcut">{{ item.kbds?.join("+") }}</span>
		</template>
	</UDropdownMenu>
	<span v-if="error" class="edit-menu-error" role="alert">{{ error }}</span>
</template>
