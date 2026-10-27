import { createLogger } from "../shared/logger.ts";

const logger = createLogger("feedback-client");
const FEEDBACK_URL = "http://117.72.245.101/api/feedback";

/*
 * ========================================================================
 * 步骤1：匿名提交正文与图片
 * ========================================================================
 * 数据源：用户确认提交的内容与浏览器 File，不读取本地账号。
 * 操作：1) 校验数量与大小；2) 有界等待请求，不携带令牌或 Cookie。
 */
export async function sendAnonymousFeedback(
	content: string,
	images: File[],
	signal: AbortSignal,
	request: typeof fetch = fetch,
): Promise<void> {
	logger.info("开始提交匿名反馈");
	try {
		// 1.1 校验在网络请求之前完成，失败时由调用方保留原表单。
		const text = content.trim();
		if (!text || text.length > 5000) throw new Error("反馈内容需为 1-5000 字");
		if (images.length > 4) throw new Error("最多上传 4 张图片");
		for (const image of images) {
			if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.type))
				throw new Error("仅支持 PNG、JPEG、WebP 或 GIF 图片");
			if (!image.size || image.size > 5 * 1024 * 1024) throw new Error("图片不能为空，且单张不能超过 5MB");
		}
		const form = new FormData();
		form.append("content", text);
		for (const image of images) form.append("images", image, image.name);
		// 1.2 multipart 边界由浏览器生成；超时和取消都不自动重发。
		const response = await request(FEEDBACK_URL, {
			method: "POST",
			body: form,
			credentials: "omit",
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
		});
		if (!response.ok) {
			let message = `反馈提交失败 (${response.status})`;
			try {
				const payload: unknown = await response.json();
				if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string")
					message = payload.message;
			} catch {
				// 网关可能返回 HTML，仍保留可读状态码。
			}
			throw new Error(message);
		}
	} finally {
		logger.info("匿名反馈提交结束");
	}
}
