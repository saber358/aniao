import { z } from "zod";
import { subagentSnapshotSchema } from "./subagents.ts";

export const dialogRequestSchema = z.object({
	id: z.string().uuid(),
	scope: z.enum(["oauth", "extension"]),
	kind: z.enum(["select", "confirm", "input", "editor"]),
	title: z.string().max(4096),
	message: z.string().max(8192).optional(),
	placeholder: z.string().max(4096).optional(),
	prefill: z.string().max(1_000_000).optional(),
	secret: z.boolean().optional(),
	allowEmpty: z.boolean().optional(),
	options: z
		.array(z.object({ value: z.string().max(4096), label: z.string().max(4096) }))
		.min(1)
		.max(200)
		.optional(),
	expiresAt: z.number().int().positive(),
});
export const dialogReplySchema = z
	.object({
		id: z.string().uuid(),
		cancelled: z.boolean(),
		value: z.union([z.string().max(1_000_000), z.boolean()]).optional(),
	})
	.strict();
export type DialogRequest = z.infer<typeof dialogRequestSchema>;
export type DialogReply = z.infer<typeof dialogReplySchema>;

export const authenticationSchema = z.object({
	providers: z
		.array(z.object({ id: z.string().max(4096), name: z.string().max(4096), authenticated: z.boolean() }))
		.max(200),
	flow: z
		.object({
			id: z.string().uuid(),
			provider: z.string().max(4096),
			phase: z.enum(["working", "succeeded", "cancelled", "failed"]),
			message: z.string().max(8192),
			url: z.string().url().max(8192).optional(),
			userCode: z.string().max(4096).optional(),
		})
		.nullable(),
});
export type AuthenticationState = z.infer<typeof authenticationSchema>;

export const extensionStateSchema = z.object({
	notices: z
		.array(
			z.object({ id: z.string().uuid(), message: z.string().max(8192), level: z.enum(["info", "warning", "error"]) }),
		)
		.max(20),
	statuses: z.array(z.object({ key: z.string().max(256), text: z.string().max(8192) })).max(20),
	widgets: z
		.array(
			z.object({
				key: z.string().max(256),
				lines: z.array(z.string().max(4096)).max(40),
				placement: z.enum(["aboveEditor", "belowEditor"]),
			}),
		)
		.max(20),
	supported: z.array(z.string().max(128)).max(20),
	subagents: subagentSnapshotSchema.optional(),
});
export type ExtensionState = z.infer<typeof extensionStateSchema>;
