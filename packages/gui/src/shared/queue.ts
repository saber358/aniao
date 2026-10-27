import { z } from "zod";
import { imageIdsSchema } from "./image-schema.ts";

/*
 * ========================================================================
 * 步骤1：定义 SDK 队列与中断恢复的展示契约
 * ========================================================================
 * 数据源：SDK 两类消息队列和桌面写前记录。
 * 操作：
 *   1) 活队列使用宿主条目身份，恢复记录只提供整体恢复与清空
 *   2) 中断记录独立展示，重启后必须经用户核对再提交
 */
export const QUEUE_LIMIT = 20;
export const QUEUE_TEXT_LIMIT = 2_000_000;
export const queueModeSchema = z.enum(["steer", "followUp"]);
export const queueItemSchema = z.object({
	id: z.string().uuid().optional(),
	text: z.string().max(1_000_000),
	imageIds: imageIdsSchema.optional(),
});
export const queueContentSchema = z.object({
	steering: z.array(queueItemSchema).max(QUEUE_LIMIT),
	followUp: z.array(queueItemSchema).max(QUEUE_LIMIT),
});
export const queueStateSchema = queueContentSchema.extend({
	recovery: queueContentSchema,
	error: z.string().max(8192).nullable(),
});
export type QueueContent = z.infer<typeof queueContentSchema>;
export type QueueState = z.infer<typeof queueStateSchema>;
export type QueueMode = z.infer<typeof queueModeSchema>;
export type QueueItem = z.infer<typeof queueItemSchema>;
