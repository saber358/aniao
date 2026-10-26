import { z } from "zod";

export const terminalCreateSchema = z.object({
	cwd: z.string().min(1).max(4096),
	cols: z.number().int().min(2).max(500),
	rows: z.number().int().min(2).max(200),
});

export const terminalWriteSchema = z.object({
	id: z.string().uuid(),
	data: z.string().max(100_000),
});

export const terminalResizeSchema = z.object({
	id: z.string().uuid(),
	cols: z.number().int().min(2).max(500),
	rows: z.number().int().min(2).max(200),
});

export const terminalCloseSchema = z.object({
	id: z.string().uuid(),
});

export const terminalEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("data"), id: z.string().uuid(), data: z.string() }),
	z.object({ type: z.literal("exit"), id: z.string().uuid(), exitCode: z.number().int() }),
]);

export interface TerminalSession {
	id: string;
	shell: string;
}

export type TerminalEvent = z.infer<typeof terminalEventSchema>;
export type TerminalCreate = z.infer<typeof terminalCreateSchema>;
export type TerminalWrite = z.infer<typeof terminalWriteSchema>;
export type TerminalResize = z.infer<typeof terminalResizeSchema>;
export type TerminalClose = z.infer<typeof terminalCloseSchema>;
