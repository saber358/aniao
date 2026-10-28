import { z } from "zod";

export const mcpTransportSchema = z.enum(["stdio", "http", "builtin"]);
export const mcpConnectionSchema = z.object({
	name: z.string().max(64),
	state: z.enum(["connecting", "connected", "disconnected", "failed"]),
	toolCount: z.number().int().min(0).max(20000),
	error: z.string().max(2000).optional(),
});
export type McpConnection = z.infer<typeof mcpConnectionSchema>;
export const mcpServerNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, "MCP 名称只能包含字母、数字、下划线和连字符");

export const mcpServerSummarySchema = z.object({
	name: mcpServerNameSchema,
	type: mcpTransportSchema,
	command: z.string().max(4096).optional(),
	args: z.array(z.string().max(2048)).max(100).optional(),
	url: z.string().max(8192).optional(),
	enabled: z.boolean(),
	title: z.string().max(100).optional(),
	description: z.string().max(1000).optional(),
	connection: mcpConnectionSchema.optional(),
});

export const mcpServerInputSchema = z
	.object({
		name: mcpServerNameSchema,
		type: z.enum(["stdio", "http"]),
		command: z.string().trim().max(4096).optional(),
		args: z.array(z.string().max(2048)).max(100).optional(),
		url: z.string().trim().max(8192).optional(),
		enabled: z.boolean().optional(),
	})
	.refine((value) => (value.type === "stdio" ? !!value.command : !!value.url), {
		message: "stdio 需要命令，HTTP 需要 URL",
	});

export type McpServerSummary = z.infer<typeof mcpServerSummarySchema>;
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

export interface McpPort {
	listMcpServers(): Promise<McpServerSummary[]>;
	saveMcpServer(request: McpServerInput): Promise<McpServerSummary[]>;
	removeMcpServer(name: string): Promise<McpServerSummary[]>;
	setMcpServerEnabled(name: string, enabled: boolean): Promise<McpServerSummary[]>;
	reconnectMcpServers(): Promise<McpServerSummary[]>;
}
