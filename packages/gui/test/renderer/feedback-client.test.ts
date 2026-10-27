import { describe, expect, it, vi } from "vitest";
import { sendAnonymousFeedback } from "../../src/renderer/feedback-client.ts";

const logger = console;

/*
 * ========================================================================
 * 步骤1：核对匿名提交的 HTTP 契约与失败反馈
 * ========================================================================
 * 数据源：真实 FormData、File 与可控请求端口。
 * 操作：1) 无令牌或 Cookie 发送正文与附件；2) 网关错误、取消和超限可见。
 */
describe("anonymous feedback client", () => {
	it("sends multipart text and files without credentials", async () => {
		logger.info("开始验证匿名反馈请求");
		try {
			// 1.1 保留原文件名，Content-Type 边界由 Fetch 生成。
			const file = new File(["fixture"], "截图.png", { type: "image/png" });
			const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
			await sendAnonymousFeedback("  反馈正文  ", [file], new AbortController().signal, request);
			const [url, init] = request.mock.calls[0];
			expect(url).toBe("http://117.72.245.101/api/feedback");
			expect(init?.credentials).toBe("omit");
			expect(init?.headers).toBeUndefined();
			const body = init?.body;
			expect(body).toBeInstanceOf(FormData);
			if (!(body instanceof FormData)) throw new Error("Multipart missing");
			expect(body.get("content")).toBe("反馈正文");
			expect(body.get("images")).toEqual(file);
		} finally {
			logger.info("匿名反馈请求验证完成");
		}
	});
	it("reports JSON and HTML errors without parsing successful empty replies", async () => {
		logger.info("开始验证反馈失败提示");
		try {
			const request = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(new Response(JSON.stringify({ message: "内容无效" }), { status: 400 }))
				.mockResolvedValueOnce(new Response("<html>gateway</html>", { status: 502 }))
				.mockResolvedValueOnce(new Response(null, { status: 204 }));
			await expect(sendAnonymousFeedback("反馈", [], new AbortController().signal, request)).rejects.toThrow(
				"内容无效",
			);
			await expect(sendAnonymousFeedback("反馈", [], new AbortController().signal, request)).rejects.toThrow("502");
			await expect(sendAnonymousFeedback("反馈", [], new AbortController().signal, request)).resolves.toBeUndefined();
		} finally {
			logger.info("反馈失败提示验证完成");
		}
	});
	it("validates input before sending and forwards cancellation without retry", async () => {
		logger.info("开始验证反馈输入边界和取消");
		try {
			const request = vi.fn<typeof fetch>();
			await expect(sendAnonymousFeedback(" ", [], new AbortController().signal, request)).rejects.toThrow("1-5000");
			const file = new File(["x"], "x.txt", { type: "text/plain" });
			await expect(sendAnonymousFeedback("反馈", [file], new AbortController().signal, request)).rejects.toThrow(
				"仅支持",
			);
			expect(request).not.toHaveBeenCalled();
			const abort = new AbortController();
			abort.abort();
			request.mockImplementationOnce(async (_url, init) => {
				init?.signal?.throwIfAborted();
				return new Response();
			});
			await expect(sendAnonymousFeedback("反馈", [], abort.signal, request)).rejects.toThrow();
			expect(request).toHaveBeenCalledOnce();
		} finally {
			logger.info("反馈输入边界和取消验证完成");
		}
	});
});
