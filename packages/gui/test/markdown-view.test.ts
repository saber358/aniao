import { createMarkdownParser, parseMarkdown } from "@comark/vue/parse";
import shiki from "@comark/vue/plugins/shiki";
import { describe, expect, it } from "vitest";
import { codeText } from "../src/renderer/adapters/markdown-view.ts";

/*
 * ========================================================================
 * 步骤1：验证真实解析与高亮后的代码复制
 * ========================================================================
 * 数据源：Comark / Shiki，包含中文、缩进和特殊字符的代码。
 * 操作：
 *   1) 不用 DOM innerText，换行和实体按代码原文保留
 *   2) 无语言代码块与尚未闭合的流式代码都能提取
 */
describe("Markdown code text", () => {
	it("preserves whitespace and literal entities after syntax highlighting", async () => {
		const text = '\tconst 中文 = "<span>&amp;</span>";\n\n  console.log(中文);';
		const document = await parseMarkdown(`\`\`\`ts\n${text}\n\`\`\``, {
			registerDefaultPlugins: false,
			plugins: [shiki()],
		});
		const node = document.nodes.find((entry) => Array.isArray(entry) && entry[0] === "pre");
		if (!node) throw new Error("Code block not parsed");
		expect(codeText(node)).toBe(text);
	});

	it("extracts an unclosed code block without copying its fence or language", async () => {
		const parse = createMarkdownParser({ registerDefaultPlugins: false });
		const document = await parse("```\n未闭合 <code>\n第二行", { streaming: true });
		const node = document.nodes.find((entry) => Array.isArray(entry) && entry[0] === "pre");
		if (!node) throw new Error("Streaming code block not parsed");
		expect(codeText(node)).toBe("未闭合 <code>\n第二行");
	});

	it("preserves trailing blank lines apart from the fence separator", async () => {
		// 1.1 Comark 去除围栏前一个结构换行，代码内的尾部空行仍须保留。
		const document = await parseMarkdown("```text\n第一行\n\n\n```", {
			registerDefaultPlugins: false,
			plugins: [shiki()],
		});
		const node = document.nodes.find((entry) => Array.isArray(entry) && entry[0] === "pre");
		if (!node) throw new Error("Code block not parsed");
		expect(codeText(node)).toBe("第一行\n\n");
	});
});
