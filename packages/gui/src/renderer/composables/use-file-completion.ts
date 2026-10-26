import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from "vue";
import { type EditorKeybindings, resolveEditorAction } from "../../domain/editor-keybindings.ts";
import { type FileCompletion, readFileCompletion } from "../../domain/file-completion.ts";
import type { Logger } from "../../shared/logger.ts";
import type { ProjectDirectory, ProjectEntry } from "../../shared/project-browser.ts";
import type {
	ProjectFileMatches,
	ProjectFileReference,
	ProjectFileSearch,
	ProjectFileSelection,
} from "../../shared/project-files.ts";
import { useFileSearch } from "./use-file-search.ts";

export interface FileCompletionOptions {
	textarea: HTMLTextAreaElement | null;
	draft: string;
	selection: ProjectFileSelection;
	disabled: boolean;
	error: string | null;
	keybindings?: EditorKeybindings;
	directory: (path: string) => Promise<ProjectDirectory>;
	enterDirectory: (completion: FileCompletion, path: string) => Promise<boolean>;
	referenceDirectory: (completion: FileCompletion, path: string) => Promise<boolean>;
	search: (input: ProjectFileSearch) => Promise<ProjectFileMatches>;
	reference: (input: ProjectFileReference, completion: FileCompletion) => Promise<boolean>;
}

/*
 * ========================================================================
 * 步骤1：为已有多行输入接入文件补全状态
 * ========================================================================
 * 数据源：当前 textarea 的选择位置、草稿与有限文件搜索端口。
 * 操作：
 *   1) 只在当前输入拥有焦点时查询，复用延迟、取消和迟到结果处理
 *   2) 身份或输入节点变化时清理监听、组词计时器和旧片段
 */
export function useFileCompletion(options: FileCompletionOptions, logger: Logger, listId: string) {
	logger.info("开始绑定行内文件补全");
	const panel = ref<HTMLDivElement | null>(null);
	const list = ref<HTMLDivElement | null>(null);
	const fragment = shallowRef<FileCompletion | null>(null);
	const dismissed = shallowRef<FileCompletion | null>(null);
	const focused = ref(false);
	const composing = ref(false);
	const saving = ref(false);
	const active = ref(0);
	const selectionError = ref("");
	const directoryEntries = ref<ProjectEntry[]>([]);
	const directoryLoading = ref(false);
	const directoryError = ref("");
	let directoryRequest = 0;
	let disposed = false;
	let compositionJustEnded = false;
	let compositionTimer: ReturnType<typeof setTimeout> | undefined;
	let suppressedKey: string | null = null;
	const target = computed(() => {
		const value = fragment.value;
		if (!focused.value || composing.value || (options.disabled && !saving.value) || value?.source !== options.draft)
			return null;
		if (dismissed.value?.source === value?.source && dismissed.value?.cursor === value?.cursor) return null;
		return value;
	});
	const { matches, loading, error, retry } = useFileSearch(
		() => (target.value ? { ...options.selection, query: target.value.query } : null),
		(input) => options.search(input),
		logger,
	);
	const directoryQuery = computed(() => {
		const query = target.value?.query ?? "";
		const slash = query.lastIndexOf("/") + 1;
		return {
			path: query.slice(0, slash).replace(/\/+$/, ""),
			filter: query.slice(slash).toLocaleLowerCase(),
		};
	});
	const candidates = computed(() => {
		const entries = directoryEntries.value
			.filter(
				(entry) => !directoryQuery.value.filter || entry.name.toLocaleLowerCase().includes(directoryQuery.value.filter),
			)
			.map((entry) => ({ path: entry.path, type: entry.type, name: entry.name }));
		const seen = new Set(entries.map((entry) => entry.path));
		const files = matches.value.paths
			.filter((path) => !seen.has(path))
			.map((path) => ({ path, type: "file" as const, name: path.split("/").at(-1) ?? path }));
		return [...entries, ...files];
	});
	watch(
		() => [target.value?.query, options.selection.sessionId, options.selection.generation] as const,
		() => void refreshDirectory(),
		{ immediate: true },
	);
	async function refreshDirectory(): Promise<void> {
		if (!target.value) {
			directoryEntries.value = [];
			directoryError.value = "";
			return;
		}
		const current = ++directoryRequest;
		directoryLoading.value = true;
		directoryError.value = "";
		try {
			const directory = await options.directory(directoryQuery.value.path);
			if (current !== directoryRequest) return;
			directoryEntries.value = directory.entries;
		} catch {
			if (current === directoryRequest) directoryError.value = "无法读取文件夹";
		} finally {
			if (current === directoryRequest) directoryLoading.value = false;
		}
	}
	const inputAttributes = computed(() => ({
		"aria-autocomplete": "list" as const,
		"aria-expanded": !!target.value,
		"aria-controls": target.value ? listId : undefined,
		"aria-activedescendant": target.value && candidates.value[active.value] ? `${listId}-${active.value}` : undefined,
	}));
	watch(candidates, () => {
		if (active.value >= candidates.value.length) active.value = 0;
	});
	watch(
		() => target.value?.query,
		() => {
			active.value = 0;
		},
	);
	watch([active, candidates], async () => {
		await nextTick();
		list.value?.children.item(active.value)?.scrollIntoView({ block: "nearest" });
	});
	watch([() => target.value?.source, () => target.value?.cursor], () => {
		selectionError.value = "";
	});
	function sync() {
		const element = options.textarea;
		const next = element
			? readFileCompletion(element.value, element.selectionStart, element.selectionEnd, logger)
			: null;
		if (!next || next.source !== dismissed.value?.source || next.cursor !== dismissed.value?.cursor)
			dismissed.value = null;
		fragment.value = next;
	}

	/*
	 * ========================================================================
	 * 步骤2：把当前候选交给统一引用入口
	 * ========================================================================
	 * 数据源：当前片段与搜索候选，文件校验和草稿写入由 Controller 持有。
	 * 操作：
	 *   1) 等待校验期间阻止重复选择，失败保留输入和可重试状态
	 *   2) 成功后按实际草稿长度恢复光标，不假设重验返回的路径没有变化
	 */
	async function select(path: string) {
		const completion = target.value;
		const element = options.textarea;
		if (!completion || !element || saving.value || loading.value || options.disabled) return;
		logger.info("开始插入行内文件引用");
		const selection = { ...options.selection };
		saving.value = true;
		selectionError.value = "";
		try {
			// 2.1 片段只留在 Renderer 与 Controller，不传入文件系统 IPC。
			const inserted = await options.reference({ ...selection, paths: [path] }, completion);
			await nextTick();
			if (
				disposed ||
				!element.isConnected ||
				options.textarea !== element ||
				options.selection.sessionId !== selection.sessionId ||
				options.selection.generation !== selection.generation
			)
				return;
			if (!inserted) {
				selectionError.value = options.error || "文件引用失败，请重试";
				if (options.draft === completion.source) {
					element.focus();
					element.setSelectionRange(completion.cursor, completion.cursor);
				}
				return;
			}
			// 2.2 保留原后缀，仅跨过原有的单个横向空白，避免把光标移到下一行。
			const suffix = completion.source.slice(completion.end);
			if (!options.draft.endsWith(suffix)) return;
			const position = options.draft.length - suffix.length + (/^[ \t]/u.test(suffix) ? 1 : 0);
			fragment.value = null;
			element.focus();
			element.setSelectionRange(position, position);
		} catch {
			if (!disposed) selectionError.value = "文件引用失败，请重试";
		} finally {
			saving.value = false;
			logger.info("行内文件引用插入结束");
		}
	}

	async function enterDirectory(path: string) {
		const completion = target.value;
		if (!completion || saving.value || options.disabled) return;
		saving.value = true;
		selectionError.value = "";
		try {
			const entered = await options.enterDirectory(completion, path);
			if (entered) {
				fragment.value = null;
				dismissed.value = null;
			}
		} catch {
			selectionError.value = "无法进入文件夹";
		} finally {
			saving.value = false;
		}
	}

	async function referenceDirectory(path: string) {
		const completion = target.value;
		if (!completion || saving.value || options.disabled) return;
		saving.value = true;
		selectionError.value = "";
		try {
			const referenced = await options.referenceDirectory(completion, path);
			if (referenced) {
				fragment.value = null;
				dismissed.value = null;
			}
		} catch {
			selectionError.value = "无法引用文件夹";
		} finally {
			saving.value = false;
		}
	}

	function keydown(event: KeyboardEvent) {
		if (event.target !== options.textarea) return;
		// 1.1 组词和刚结束的候选确认只交给系统，不冒泡到 ChatPrompt 的发送处理。
		if (composing.value || event.isComposing || event.keyCode === 229 || compositionJustEnded) {
			event.stopPropagation();
			return;
		}
		const physicalKey = event.code || event.key;
		if (event.repeat && suppressedKey === physicalKey) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (!event.repeat && suppressedKey === physicalKey) suppressedKey = null;
		sync();
		const completion = target.value;
		if (!completion) return;
		const action = resolveEditorAction(event, options.keybindings, logger);
		if (!action) return;
		const path = matches.value.paths[active.value];
		const candidate = candidates.value[active.value];
		// 1.2 没有可选项时 Tab 仍能离开输入区；Enter 保留草稿，不误发查询文字。
		if (action === "completionTab" && (loading.value || !candidate)) {
			dismissed.value = completion;
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (action === "completionDismiss") dismissed.value = completion;
		else if (action === "completionPrevious" || action === "completionNext") {
			const size = candidates.value.length;
			if (size) active.value = (active.value + (action === "completionNext" ? 1 : size - 1)) % size;
		} else {
			suppressedKey = physicalKey;
			if (!event.repeat && !loading.value && candidate) {
				if (candidate.type === "directory") {
					if (action === "completionTab") void enterDirectory(candidate.path);
					else if (action === "completionAccept") void referenceDirectory(candidate.path);
				} else if (path) void select(path);
			}
		}
	}
	function leavePanel(event: FocusEvent) {
		if (
			event.relatedTarget === options.textarea ||
			(event.relatedTarget instanceof Node && panel.value?.contains(event.relatedTarget))
		)
			return;
		focused.value = false;
	}
	watch(
		[() => options.textarea, () => options.selection.sessionId, () => options.selection.generation],
		(_value, _previous, onCleanup) => {
			const element = options.textarea;
			fragment.value = null;
			dismissed.value = null;
			focused.value = false;
			if (!element) return;
			const focus = () => {
				focused.value = true;
				dismissed.value = null;
				sync();
			};
			const blur = (event: FocusEvent) => {
				if (!saving.value) leavePanel(event);
			};
			const keyup = (event: KeyboardEvent) => {
				if (suppressedKey === (event.code || event.key)) suppressedKey = null;
				sync();
			};
			const start = () => {
				composing.value = true;
			};
			const end = () => {
				composing.value = false;
				compositionJustEnded = true;
				clearTimeout(compositionTimer);
				compositionTimer = setTimeout(() => {
					compositionJustEnded = false;
				}, 50);
				sync();
			};
			// 1.3 捕获阶段优先处理补全，保持原组件的换行、提交和自动增高。
			const capture = { capture: true };
			const keydownHost = typeof window === "undefined" ? element : window;
			const keydownListener: EventListener = (event) => keydown(event as KeyboardEvent);
			keydownHost.addEventListener("keydown", keydownListener, capture);
			element.addEventListener("keyup", keyup);
			element.addEventListener("input", sync);
			element.addEventListener("select", sync);
			element.addEventListener("click", sync);
			element.addEventListener("focus", focus);
			element.addEventListener("blur", blur);
			element.addEventListener("compositionstart", start, capture);
			element.addEventListener("compositionend", end, capture);
			if (document.activeElement === element) focus();
			onCleanup(() => {
				keydownHost.removeEventListener("keydown", keydownListener, capture);
				element.removeEventListener("keyup", keyup);
				element.removeEventListener("input", sync);
				element.removeEventListener("select", sync);
				element.removeEventListener("click", sync);
				element.removeEventListener("focus", focus);
				element.removeEventListener("blur", blur);
				element.removeEventListener("compositionstart", start, capture);
				element.removeEventListener("compositionend", end, capture);
				clearTimeout(compositionTimer);
				compositionJustEnded = false;
				composing.value = false;
				suppressedKey = null;
			});
		},
		{ immediate: true },
	);
	onScopeDispose(() => {
		disposed = true;
	});
	logger.info("行内文件补全绑定完成");
	return {
		panel,
		list,
		listId,
		target,
		active,
		candidates,
		directoryLoading,
		directoryError,
		matches,
		loading,
		error,
		selectionError,
		saving,
		inputAttributes,
		retry,
		select,
		enterDirectory,
		referenceDirectory,
		leavePanel,
	};
}
