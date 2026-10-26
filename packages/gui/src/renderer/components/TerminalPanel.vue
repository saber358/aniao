<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEvent } from "../../shared/terminal.ts";

const props = defineProps<{ cwd: string; withHeader?: boolean }>();
const bridge = window.piDesktop;
const container = ref<HTMLDivElement | null>(null);
const error = ref("");
const shell = ref("");
let terminal: XtermTerminal | undefined;
let fit: FitAddon | undefined;
let id: string | undefined;
let unsubscribe: (() => void) | undefined;
let resizeObserver: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;
let disposed = false;
const pending: TerminalEvent[] = [];

function theme() {
	const styles = getComputedStyle(document.documentElement);
	const dark = document.documentElement.classList.contains("dark");
	return {
		background: styles.getPropertyValue("--surface").trim() || (dark ? "#1b1b1c" : "#ffffff"),
		foreground: styles.getPropertyValue("--ink").trim() || (dark ? "#f2f2f0" : "#1a1c18"),
		cursor: styles.getPropertyValue("--accent").trim() || "#3f6ae0",
		selectionBackground: dark ? "#3a4048" : "#dce3ee",
	};
}

function handle(event: TerminalEvent): void {
	if (!terminal) return;
	if (!id) {
		pending.push(event);
		return;
	}
	if (event.id !== id) return;
	if (event.type === "data") terminal.write(event.data);
	else terminal.write(`\r\n[进程已退出，退出码 ${event.exitCode}]\r\n`);
}

function flush(): void {
	for (const event of pending) handle(event);
	pending.length = 0;
}

async function start(): Promise<void> {
	await nextTick();
	if (!container.value) return;
	terminal = new XtermTerminal({
		fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
		fontSize: 12,
		lineHeight: 1.25,
		cursorBlink: true,
		scrollback: 5000,
		theme: theme(),
	});
	fit = new FitAddon();
	terminal.loadAddon(fit);
	terminal.open(container.value);
	fit.fit();
	unsubscribe = bridge.subscribeTerminal(handle);
	terminal.onData((data) => {
		if (id) bridge.terminalWrite({ id, data });
	});
	terminal.onResize(({ cols, rows }) => {
		if (id) bridge.terminalResize({ id, cols, rows });
	});
	resizeObserver = new ResizeObserver(() => {
		try {
			fit?.fit();
		} catch {
			// 容器尚未完成布局时忽略一次尺寸同步。
		}
	});
	resizeObserver.observe(container.value);
	themeObserver = new MutationObserver(() => {
		if (terminal) terminal.options.theme = theme();
	});
	themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

	try {
		const session = await bridge.terminalCreate({ cwd: props.cwd, cols: terminal.cols, rows: terminal.rows });
		if (disposed) {
			bridge.terminalClose({ id: session.id });
			return;
		}
		id = session.id;
		shell.value = session.shell;
		terminal.focus();
		flush();
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : "无法启动终端";
	}
}

onMounted(() => {
	void start();
});
onBeforeUnmount(() => {
	disposed = true;
	unsubscribe?.();
	resizeObserver?.disconnect();
	themeObserver?.disconnect();
	if (id) bridge.terminalClose({ id });
	terminal?.dispose();
	terminal = undefined;
	id = undefined;
});
</script>

<template>
	<div class="terminal-panel">
		<div v-if="withHeader !== false" class="terminal-head">
			<span>终端</span>
			<span v-if="shell" class="terminal-shell">{{ shell }}</span>
			<span class="terminal-hint">当前项目目录</span>
		</div>
		<div ref="container" class="terminal-surface"></div>
		<div v-if="error" class="terminal-error">{{ error }}</div>
	</div>
</template>
