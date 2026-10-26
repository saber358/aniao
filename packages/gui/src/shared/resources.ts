import { z } from "zod";

const scopeSchema = z.enum(["user", "project", "temporary", "unknown"]);
const text = z.string().max(4096);
const name = z.string().min(1).max(512);

export const resourceExtensionSchema = z.object({
	name,
	path: text,
	source: z.string().max(512),
	scope: scopeSchema,
	tools: z.array(name).max(200),
	commands: z.array(name).max(200),
});

export const resourceSkillSchema = z.object({
	name,
	description: z.string().max(8192),
	path: text,
	source: z.string().max(512),
	scope: scopeSchema,
	disableModelInvocation: z.boolean(),
});

export const resourcePromptSchema = z.object({
	name,
	description: z.string().max(8192),
	argumentHint: z.string().max(512).optional(),
	path: text,
	source: z.string().max(512),
	scope: scopeSchema,
});

export const resourceCommandSchema = z.object({
	name,
	description: z.string().max(8192).optional(),
	source: z.enum(["extension", "prompt", "skill"]),
	scope: scopeSchema,
	path: text.optional(),
});

export const resourceDiagnosticSchema = z.object({
	type: z.enum(["warning", "error", "collision"]),
	message: z.string().max(8192),
	path: text.optional(),
});

export const resourceSnapshotSchema = z.object({
	extensions: z.array(resourceExtensionSchema).max(200),
	skills: z.array(resourceSkillSchema).max(500),
	prompts: z.array(resourcePromptSchema).max(500),
	commands: z.array(resourceCommandSchema).max(1000),
	diagnostics: z.array(resourceDiagnosticSchema).max(500),
});

export type ResourceExtension = z.infer<typeof resourceExtensionSchema>;
export type ResourceSkill = z.infer<typeof resourceSkillSchema>;
export type ResourcePrompt = z.infer<typeof resourcePromptSchema>;
export type ResourceCommand = z.infer<typeof resourceCommandSchema>;
export type ResourceDiagnostic = z.infer<typeof resourceDiagnosticSchema>;
export type ResourceSnapshot = z.infer<typeof resourceSnapshotSchema>;
