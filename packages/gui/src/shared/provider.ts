import { z } from "zod";

export const customProviderApiSchema = z.enum([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);

export const providerThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const providerInputSchema = z.enum(["text", "image"]);

export const customModelInputSchema = z.object({
	id: z.string().trim().min(1).max(200),
	reasoning: z.boolean().optional(),
	thinkingLevels: z.array(providerThinkingLevelSchema).max(7).optional(),
	input: z.array(providerInputSchema).min(1).max(2).optional(),
	contextWindow: z.number().int().positive().max(10_000_000).optional(),
	maxTokens: z.number().int().positive().max(10_000_000).optional(),
	supportsStructuredOutput: z.boolean().optional(),
	supportsSystemMessages: z.boolean().optional(),
});

export const customProviderInputSchema = z.object({
	id: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9][a-z0-9._-]*$/, "Provider ID 只能包含小写字母、数字、点、下划线和连字符"),
	name: z.string().trim().min(1).max(100).optional(),
	baseUrl: z
		.string()
		.trim()
		.max(2048)
		.refine((value) => /^https?:\/\//.test(value), "Base URL 必须使用 http 或 https"),
	api: customProviderApiSchema,
	models: z.array(customModelInputSchema).min(1).max(200),
	apiKey: z.string().trim().min(1).max(16384).optional(),
});

export type CustomModelInput = z.infer<typeof customModelInputSchema>;
export type CustomProviderInput = z.infer<typeof customProviderInputSchema>;
