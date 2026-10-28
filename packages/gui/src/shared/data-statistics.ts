import { z } from "zod";
import { sessionIdSchema, sessionItemSchema } from "./workspace.ts";

/*
 * ========================================================================
 * 步骤1：限定统计和归档的跨进程数据
 * ========================================================================
 * 数据源：本机 SDK 历史与桌面归档偏好。
 * 操作：1) 界面只收摘要，不收历史路径；2) 批量操作只接受已登记会话身份。
 */
const tokenCount = z.number().nonnegative().finite();
export const usageDaySchema = z.object({
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	model: z.string().max(4096),
	provider: z.string().max(4096),
	tokens: tokenCount,
});
export const usageSnapshotSchema = z.object({
	generatedAt: z.number().nonnegative(),
	totalTokens: tokenCount,
	peakTokens: tokenCount,
	longestChatMs: tokenCount,
	activityDates: z.array(z.string().max(10)).max(40000),
	dailyTurns: z
		.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), turns: z.number().int().nonnegative() }))
		.max(40000),
	daily: z.array(usageDaySchema).max(200000),
	skippedSessions: z.number().int().nonnegative(),
});
export const archivePolicySchema = z
	.object({
		enabled: z.boolean(),
		retentionDays: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)]),
	})
	.strict();
export const archivedSessionSchema = sessionItemSchema.extend({
	cwd: z.string().max(4096),
	projectName: z.string().max(200),
	running: z.boolean(),
});
export const archiveSnapshotSchema = z.object({
	policy: archivePolicySchema,
	sessions: z.array(archivedSessionSchema).max(20000),
});
export const archiveSelectionSchema = z.object({ sessionIds: z.array(sessionIdSchema).min(1).max(20000) }).strict();
// 1.1 文件路径只用于受管进程之间定位，不能进入 DesktopBridge 返回值。
export const historyScanSchema = z.object({
	usage: usageSnapshotSchema,
	files: z
		.array(z.object({ id: sessionIdSchema, cwd: z.string().max(4096), path: z.string().min(1).max(8192) }))
		.max(20000),
});
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
export type ArchivePolicy = z.infer<typeof archivePolicySchema>;
export type ArchivedSession = z.infer<typeof archivedSessionSchema>;
export type ArchiveSnapshot = z.infer<typeof archiveSnapshotSchema>;
export type ArchiveSelection = z.infer<typeof archiveSelectionSchema>;
export type HistoryScan = z.infer<typeof historyScanSchema>;
export interface DataStatisticsPort {
	getUsageStatistics(): Promise<UsageSnapshot>;
	getArchiveSnapshot(): Promise<ArchiveSnapshot>;
	saveArchivePolicy(policy: ArchivePolicy): Promise<ArchiveSnapshot>;
	restoreArchived(selection: ArchiveSelection): Promise<ArchiveSnapshot>;
	deleteArchived(selection: ArchiveSelection): Promise<ArchiveSnapshot>;
}
