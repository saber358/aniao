import type { Logger } from "../shared/logger.ts";

interface AppKey {
	key: string;
	ctrl?: boolean;
	meta?: boolean;
}
interface AppKeyInput {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

export const DEFAULT_APP_KEYBINDINGS = {
	settings: [
		{ key: ",", ctrl: true },
		{ key: ",", meta: true },
	],
	files: [
		{ key: "p", ctrl: true },
		{ key: "p", meta: true },
	],
	terminal: [
		{ key: "`", ctrl: true },
		{ key: "`", meta: true },
	],
	browser: [
		{ key: "t", ctrl: true },
		{ key: "t", meta: true },
	],
} as const satisfies Record<string, readonly AppKey[]>;
export type AppAction = keyof typeof DEFAULT_APP_KEYBINDINGS;
export type AppKeybindings = Partial<Record<AppAction, readonly AppKey[]>>;

/*
 * ========================================================================
 * 步骤1：从统一配置解析桌面快捷操作
 * ========================================================================
 * 数据源：标准按键字段、默认设置和可选覆盖。
 * 操作：1) 完整匹配修饰键；2) 空数组禁用动作，不拦截系统编辑快捷键。
 */
export function resolveAppAction(
	input: AppKeyInput,
	bindings: AppKeybindings | undefined,
	logger: Logger,
): AppAction | null {
	logger.info("开始解析桌面快捷操作");
	try {
		// 1.1 保留原生文本编辑键，只解析明确登记的应用动作。
		if (input.altKey || input.shiftKey) return null;
		for (const action of Object.keys(DEFAULT_APP_KEYBINDINGS) as AppAction[]) {
			const keys: readonly AppKey[] = bindings?.[action] ?? DEFAULT_APP_KEYBINDINGS[action];
			if (
				keys.some(
					(key) =>
						key.key.toLowerCase() === input.key.toLowerCase() &&
						Boolean(key.ctrl) === input.ctrlKey &&
						Boolean(key.meta) === input.metaKey,
				)
			)
				return action;
		}
		return null;
	} finally {
		logger.info("桌面快捷操作解析结束");
	}
}
