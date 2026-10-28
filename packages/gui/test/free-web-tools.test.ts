import { describe, expect, it, vi } from "vitest";
import { FreeWebTools } from "../src/main/free-web-tools.ts";
import type { BuiltinResult } from "../src/shared/builtin-mcp.ts";

const logger = { info: vi.fn() };
function text(result: BuiltinResult): string {
	const block = result.content[0];
	if (block.type !== "text") throw new Error("预期文本结果");
	return block.text;
}

/*
 * ========================================================================
 * 步骤1：验证免费网络工具的数据与网络边界
 * ========================================================================
 * 数据源：HTTP 响应替身，不访问搜索服务和真实账号。
 * 操作：1) 正文去脚本、保留来源；2) 搜索范围、体积、取消与限流均可核对。
 */
describe("free web MCP", () => {
	it("keeps large JSON results valid and within the IPC text limit", async () => {
		logger.info("开始验证大型公开响应裁切");
		const response = new Response(JSON.stringify({ title: '"'.repeat(100000) }), {
			headers: { "content-type": "application/json" },
		});
		const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
		try {
			// 2.1 JSON 转义会放大结果，裁切后仍必须能由调用方解析。
			const result = await new FreeWebTools(logger, request).execute(
				{ server: "harness_github", name: "github_read", arguments: { repository: "vuejs/core", kind: "repository" } },
				new AbortController().signal,
			);
			const value = text(result);
			expect(value.length).toBeLessThan(100000);
			expect(JSON.parse(value).truncated).toBe(true);
		} finally {
			logger.info("大型公开响应裁切验证结束");
		}
	});
	it("extracts UTF-8 text and follows validated redirects without credentials", async () => {
		logger.info("开始验证免费正文读取");
		const request = vi.fn<typeof fetch>();
		request
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/docs" } }))
			.mockResolvedValueOnce(
				new Response("<title>文档</title><script>SECRET_SCRIPT</script><h1>说明</h1><p>中文 &amp; text</p>", {
					headers: { "content-type": "text/html" },
				}),
			);
		try {
			// 1.1 先校验每次跳转地址，发送固定公开读取头。
			const tools = new FreeWebTools(logger, request);
			const result = JSON.parse(
				text(
					await tools.execute(
						{ server: "harness_web", name: "fetch_page", arguments: { url: "https://example.com/start" } },
						new AbortController().signal,
					),
				),
			);
			expect(result.source).toBe("https://example.com/docs");
			expect(result.text).toContain("中文 & text");
			expect(result.text).not.toContain("SECRET_SCRIPT");
			expect(request.mock.calls[0][1]?.redirect).toBe("manual");
			expect(request.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
		} finally {
			logger.info("免费正文读取验证结束");
		}
	});
	it("rejects unsafe redirect protocols, oversized bodies and rate limits", async () => {
		logger.info("开始验证免费网络异常");
		try {
			// 1.2 失败不得变成伪造的空成功结果。
			for (const [response, error] of [
				[new Response(null, { status: 302, headers: { location: "file:///private" } }), "HTTP"],
				[new Response("x".repeat(2_000_001), { headers: { "content-type": "text/plain" } }), "2 MB"],
				[new Response("limited", { status: 429 }), "限流"],
			] as const) {
				const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
				await expect(
					new FreeWebTools(logger, request).execute(
						{ server: "harness_web", name: "fetch_page", arguments: { url: "https://example.com" } },
						new AbortController().signal,
					),
				).rejects.toThrow(error);
				expect(request).toHaveBeenCalledTimes(1);
			}
		} finally {
			logger.info("免费网络异常验证结束");
		}
	});
	it("filters documentation search by the requested domain and uses only free fallback pages", async () => {
		logger.info("开始验证官方文档搜索范围");
		const request = vi.fn<typeof fetch>();
		request
			.mockResolvedValueOnce(
				new Response(
					"<rss><channel><item><title>错误域名</title><link>https://evil-example.com/</link></item></channel></rss>",
					{ headers: { "content-type": "application/rss+xml" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvuejs.org%2Fguide%2F">Vue <b>Guide</b></a><a class="result__a" href="https://vuejs.org.evil-example.com/">伪域名</a>',
					{ headers: { "content-type": "text/html" } },
				),
			);
		try {
			// 1.3 搜索引擎未遵循 site 时仍不能混入其他域名。
			const result = JSON.parse(
				text(
					await new FreeWebTools(logger, request).execute(
						{ server: "harness_docs", name: "search_docs", arguments: { query: "reactivity", domain: "vuejs.org" } },
						new AbortController().signal,
					),
				),
			);
			expect(result.results).toEqual([{ title: "Vue Guide", url: "https://vuejs.org/guide/", snippet: "" }]);
			expect(request.mock.calls.map(([url]) => String(url))).toEqual([
				expect.stringContaining("bing.com/search?format=rss"),
				expect.stringContaining("duckduckgo.com/html/"),
			]);
		} finally {
			logger.info("官方文档搜索范围验证结束");
		}
	});
	it("reports search verification challenges without falling back to a paid service", async () => {
		logger.info("开始验证搜索验证页处理");
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("limited", { status: 429 }))
			.mockResolvedValueOnce(
				new Response("<form>captcha challenge</form>", { headers: { "content-type": "text/html" } }),
			);
		try {
			await expect(
				new FreeWebTools(logger, request).execute(
					{ server: "harness_web", name: "search_web", arguments: { query: "test" } },
					new AbortController().signal,
				),
			).rejects.toThrow("要求验证");
			expect(request).toHaveBeenCalledTimes(2);
		} finally {
			logger.info("搜索验证页处理验证结束");
		}
	});
	it("decodes a public GitHub file and rejects already-cancelled work", async () => {
		logger.info("开始验证 GitHub 免费公开读取");
		const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
			new Response(JSON.stringify({ content: Buffer.from("# 中文 README").toString("base64") }), {
				headers: { "content-type": "application/json" },
			}),
		);
		try {
			const tools = new FreeWebTools(logger, request);
			const result = JSON.parse(
				text(
					await tools.execute(
						{
							server: "harness_github",
							name: "github_read",
							arguments: { repository: "vuejs/core", kind: "file", path: "docs/README.md", ref: "v3.5.0" },
						},
						new AbortController().signal,
					),
				),
			);
			expect(result.text).toBe("# 中文 README");
			expect(request.mock.calls[0][0]).toBe(
				"https://api.github.com/repos/vuejs/core/contents/docs/README.md?ref=v3.5.0",
			);
			const aborted = new AbortController();
			aborted.abort();
			await expect(
				tools.execute(
					{ server: "harness_web", name: "fetch_page", arguments: { url: "https://example.com" } },
					aborted.signal,
				),
			).rejects.toThrow();
			expect(request).toHaveBeenCalledTimes(1);
		} finally {
			logger.info("GitHub 免费公开读取验证结束");
		}
	});
});
