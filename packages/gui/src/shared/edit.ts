import { z } from "zod";

// 1.1 仅允许原生编辑命令，不暴露剪贴板读取或任意主进程调用。
export const editActionSchema = z.enum(["undo", "redo", "cut", "copy", "paste", "delete", "selectAll"]);
export type EditAction = z.infer<typeof editActionSchema>;
