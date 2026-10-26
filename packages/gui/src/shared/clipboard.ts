// 剪贴板只开放写入；上限同时约束界面、preload 和主进程。
export const CLIPBOARD_TEXT_LIMIT = 2_000_000;

export interface ClipboardPort {
	writeClipboard(text: string): Promise<void>;
}
