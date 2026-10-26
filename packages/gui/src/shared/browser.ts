import { z } from "zod";

// 1.1 网页只接受网络地址，浏览器会话编号不能复用工作台身份。
export const browserIdSchema = z.string().uuid();
export const browserNavigateSchema = z
	.object({ id: browserIdSchema, url: z.string().trim().min(1).max(8192) })
	.strict();
export const browserNavigateFileSchema = z
	.object({
		id: browserIdSchema,
		cwd: z.string().min(1).max(4096),
		path: z.string().min(1).max(4096),
	})
	.strict();
export const browserActionSchema = z
	.object({ id: browserIdSchema, action: z.enum(["back", "forward", "reload", "stop"]) })
	.strict();
export const browserLayoutSchema = z
	.object({
		id: browserIdSchema,
		visible: z.boolean(),
		x: z.number().finite().min(0).max(32768),
		y: z.number().finite().min(0).max(32768),
		width: z.number().finite().min(0).max(32768),
		height: z.number().finite().min(0).max(32768),
	})
	.strict();
export const browserStateSchema = z.object({
	id: browserIdSchema,
	url: z.string().max(8192),
	title: z.string().max(4096),
	loading: z.boolean(),
	canGoBack: z.boolean(),
	canGoForward: z.boolean(),
	error: z.string().max(1024).nullable(),
	notice: z.string().max(1024).nullable(),
});

export type BrowserState = z.infer<typeof browserStateSchema>;
export type BrowserNavigate = z.infer<typeof browserNavigateSchema>;
export type BrowserNavigateFile = z.infer<typeof browserNavigateFileSchema>;
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type BrowserLayout = z.infer<typeof browserLayoutSchema>;

export interface BrowserPort {
	browserCreate(id: string): Promise<BrowserState>;
	browserNavigate(request: BrowserNavigate): Promise<void>;
	browserNavigateFile(request: BrowserNavigateFile): Promise<void>;
	browserAction(request: BrowserAction): Promise<void>;
	browserLayout(request: BrowserLayout): void;
	browserClose(id: string): void;
	subscribeBrowser(listener: (state: BrowserState) => void): () => void;
}

/*
 * ========================================================================
 * 步骤1：归一化网页地址并限制协议
 * ========================================================================
 * 数据源：地址栏输入或网页导航目标。
 * 操作：1) 本地开发地址默认 HTTP；2) 拒绝文件、脚本、凭据和系统协议。
 */
export function normalizeBrowserUrl(input: string): string {
	// 1.2 纯地址转换不记录输入，日志由调用方按导航生命周期打点。
	const value = input.trim();
	if (
		!value ||
		value.length > 8192 ||
		Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	)
		throw new Error("请输入有效网址");
	let target = value.startsWith("//") ? `https:${value}` : value;
	if (!target.includes("://")) {
		if (/^[a-z][a-z\d+.-]*:(?!\d+(?:[/?#]|$))/i.test(target)) throw new Error("仅支持 HTTP 和 HTTPS 网页");
		const local = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(target);
		target = `${local ? "http" : "https"}://${target.replace(/^\/\//, "")}`;
	}
	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		throw new Error("请输入有效网址");
	}
	if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new Error("仅支持 HTTP 和 HTTPS 网页");
	if (parsed.username || parsed.password) throw new Error("网址中不能包含用户名或密码");
	if (parsed.href.length > 8192) throw new Error("网址过长");
	return parsed.href;
}
