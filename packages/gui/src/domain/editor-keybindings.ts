import type { Logger } from "../shared/logger.ts";

interface EditorKey {
	key: string;
	alt?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	shift?: boolean;
}
interface EditorKeyInput {
	key: string;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

export const DEFAULT_EDITOR_KEYBINDINGS = {
	completionPrevious: [{ key: "ArrowUp" }],
	completionNext: [{ key: "ArrowDown" }],
	completionAccept: [{ key: "Enter" }],
	completionTab: [{ key: "Tab" }],
	completionDismiss: [{ key: "Escape" }],
} as const satisfies Record<string, readonly EditorKey[]>;
export type EditorAction = keyof typeof DEFAULT_EDITOR_KEYBINDINGS;
export type EditorKeybindings = Partial<Record<EditorAction, readonly EditorKey[]>>;

/*
 * ========================================================================
 * 步骤1：从可覆盖的配置解析编辑器动作
 * ========================================================================
 * 数据源：标准键盘字段与声明的默认键位，不处理 DOM 或终端键码。
 * 操作：
 *   1) 完整匹配修饰键，换行和系统组合键不会误选补全
 *   2) 空数组可以禁用动作，界面组件不再硬编码按键判断
 */
export function resolveEditorAction(
	input: EditorKeyInput,
	bindings: EditorKeybindings | undefined,
	logger: Logger,
): EditorAction | null {
	logger.info("开始解析文件补全键盘动作");
	try {
		// 1.1 以默认动作顺序解决配置冲突，覆盖值替换整组默认按键。
		for (const action of Object.keys(DEFAULT_EDITOR_KEYBINDINGS) as EditorAction[]) {
			const keys: readonly EditorKey[] = bindings?.[action] ?? DEFAULT_EDITOR_KEYBINDINGS[action];
			if (
				keys.some(
					(key) =>
						key.key.toLowerCase() === input.key.toLowerCase() &&
						Boolean(key.alt) === input.altKey &&
						Boolean(key.ctrl) === input.ctrlKey &&
						Boolean(key.meta) === input.metaKey &&
						Boolean(key.shift) === input.shiftKey,
				)
			)
				return action;
		}
		return null;
	} finally {
		logger.info("文件补全键盘动作解析结束");
	}
}
