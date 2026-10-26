import type { QueueItem, QueueState } from "../shared/queue.ts";

/*
 * ========================================================================
 * 步骤1：按展示顺序汇总待处理文本
 * ========================================================================
 * 数据源：只读队列投影，不导入校验器或调度器运行时。
 * 操作：
 *   1) 先显示待核对记录，再显示活动 SDK 队列
 *   2) 保留重复文本，不用内容去重用户任务
 */
export function queueItems(queue: QueueState): QueueItem[] {
	return [...queue.recovery.steering, ...queue.recovery.followUp, ...queue.steering, ...queue.followUp];
}
export function queueTexts(queue: QueueState): string[] {
	return queueItems(queue).map((item) => item.text);
}
