import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
	type GoalAction,
	type GoalSnapshot,
	type GoalTaskView,
	type GoalView,
	goalSnapshotSchema,
} from "../shared/goals.ts";
import type { Logger } from "../shared/logger.ts";

const actionNames = { pause: "goal-pause", resume: "goal-resume", delete: "goal-clear" } as const;
const commandIds = [
	"goal",
	"sisyphus",
	"goal-direct",
	"sisyphus-direct",
	"goal-tweak",
	"goal-pause",
	"goal-resume",
	"goal-clear",
	"goal-list",
	"goal-status",
	"goal-refresh",
	"goal-recovery",
	"goal-focus",
	"goal-unfocus",
	"goal-settings",
	"goal-cancel",
] as const;
const commandPaths = z
	.array(
		z
			.string()
			.trim()
			.regex(/^[a-z][a-z0-9_-]*(?: [a-z][a-z0-9_-]*)*$/u)
			.max(96),
	)
	.max(16);
const preferencesSchema = z.object({
	disabled: z.boolean().optional(),
	commands: z.record(z.string(), commandPaths).optional(),
});
const storedTaskSchema: z.ZodType<StoredTask> = z.lazy(() =>
	z.object({
		id: z.string().min(1),
		title: z.string().min(1),
		status: z.enum(["pending", "complete", "skipped"]),
		verificationContract: z.string().optional(),
		evidence: z.string().optional(),
		subtasks: z.array(storedTaskSchema).optional(),
	}),
);
interface StoredTask {
	id: string;
	title: string;
	status: "pending" | "complete" | "skipped";
	verificationContract?: string;
	evidence?: string;
	subtasks?: StoredTask[];
}
const goalDetailsSchema = z.object({
	version: z.literal(3),
	goal: z
		.object({
			id: z.string().min(1).max(200),
			objective: z.string().min(1),
			status: z.enum(["active", "paused", "blocked", "budget_limited", "complete"]),
			autoContinue: z.boolean(),
			sisyphus: z.boolean(),
			skipAuditor: z.boolean().optional(),
			usage: z.object({
				tokensUsed: z.number().finite().nonnegative(),
				activeSeconds: z.number().finite().nonnegative(),
			}),
			taskList: z.object({ tasks: z.array(storedTaskSchema) }).optional(),
			currentTaskId: z.string().optional(),
			verificationContract: z.string().optional(),
			pauseReason: z.string().optional(),
			activePath: z.string().optional(),
			updatedAt: z.string().optional(),
		})
		.nullable(),
});
const focusSchema = z.object({ version: z.literal(1), focusedGoalId: z.string().min(1).max(200).nullable() });

/*
 * ========================================================================
 * 步骤1：用当前会话的官方工具读取目标
 * ========================================================================
 * 数据源：SessionManager 当前分支焦点与 get_goal 返回的结构化状态。
 * 操作：1) 没有焦点就返回空列表；2) 存储根和状态由插件解析，GUI 不扫描用户目录。
 */
export class HostGoalService {
	private readonly session: AgentSession;
	private readonly logger: Logger;
	private controlling = false;
	private loadedCommands: Awaited<ReturnType<HostGoalService["preferences"]>>["commands"] | undefined;

	constructor(session: AgentSession, logger: Logger) {
		this.session = session;
		this.logger = logger;
	}

	async bind(): Promise<void> {
		this.logger.info("开始绑定目标控制路由");
		try {
			// 1.3 记录本次扩展加载的别名；外部配置变化后须重载，不能误调旧路由。
			this.loadedCommands = this.session.getToolDefinition("get_goal")
				? (await this.preferences()).commands
				: undefined;
		} finally {
			this.logger.info("目标控制路由绑定结束");
		}
	}

	async read(): Promise<GoalSnapshot> {
		this.logger.info("开始读取当前会话目标");
		try {
			// 1.1 只认当前分支的最后一条焦点记录，不从同项目其他会话推断目标。
			const focusedGoalId = this.focusedGoalId();
			if (!focusedGoalId) return { goals: [], generatedAt: Date.now() };
			const tool = this.session.getToolDefinition("get_goal");
			if (!tool) throw new Error("目标插件尚未加载，请重载会话资源");
			const toolCallId = `desktop-goal-${randomUUID()}`;
			const result = await tool.execute(
				toolCallId,
				{},
				undefined,
				undefined,
				this.session.extensionRunner.createToolContext(toolCallId, undefined),
			);
			const parsed = goalDetailsSchema.safeParse(result.details);
			if (result.isError || !parsed.success) throw new Error("目标插件返回的数据格式无效");
			// 1.2 读取期间焦点变化时拒绝旧结果；插件自己处理已完成目标的延迟归档。
			if (this.focusedGoalId() !== focusedGoalId) throw new Error("当前目标已更换，请刷新");
			const raw = parsed.data.goal;
			if (!raw) return { goals: [], generatedAt: Date.now() };
			if (raw.id !== focusedGoalId) throw new Error("目标不属于当前会话焦点");
			const settings = await this.preferences();
			return goalSnapshotSchema.parse({ goals: [this.project(raw, settings.disabled)], generatedAt: Date.now() });
		} finally {
			this.logger.info("当前会话目标读取结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤2：将控制按钮绑定到焦点和插件注册命令
	 * ========================================================================
	 * 数据源：有效命令别名、get_goal 的扩展来源与按钮携带的目标 ID。
	 * 操作：1) 防止并发控制和旧目标操作；2) 直接调用处理器，缺失命令不得进入模型。
	 */
	async control(action: GoalAction, goalId: string): Promise<void> {
		this.logger.info("开始处理当前目标控制");
		try {
			// 2.1 控制期间仍可读取和回复弹窗，但不接受第二个目标控制。
			if (this.controlling) throw new Error("上一条目标操作尚未结束");
			if (this.focusedGoalId() !== goalId) throw new Error("当前目标已更换，请刷新后重试");
			this.controlling = true;
			try {
				const settings = await this.preferences();
				if (!this.loadedCommands || JSON.stringify(settings.commands) !== JSON.stringify(this.loadedCommands))
					throw new Error("目标控制配置已变化，请重载会话资源");
				const name = actionNames[action];
				const paths = settings.commands[name];
				if (!paths.length) throw new Error("该目标操作已在插件设置中禁用");
				const source = this.session.getAllTools().find((tool) => tool.name === "get_goal")?.sourceInfo.path;
				if (!source) throw new Error("目标插件尚未加载，请重载会话资源");
				const commands = this.session.extensionRunner.getRegisteredCommands();
				const route = paths
					.map((path) => {
						const [root, ...args] = path.split(" ");
						return {
							command: commands.find((command) => command.name === root && command.sourceInfo.path === source),
							args: args.join(" "),
						};
					})
					.find((route) => route.command);
				if (!route?.command) throw new Error("目标控制命令尚未加载，请重载会话资源");
				const focused = (await this.read()).goals[0];
				if (focused?.id !== goalId) throw new Error("当前目标已更换，请刷新后重试");
				if (this.focusedGoalId() !== goalId) throw new Error("当前目标已更换，请刷新后重试");
				await route.command.handler(route.args, this.session.extensionRunner.createCommandContext());
				// 2.2 暂停/继续被插件拒绝时明确失败；归档取消保留用户选择，不伪报删除成功。
				if (action !== "delete") {
					const goal = (await this.read()).goals[0];
					if (goal?.id !== goalId || goal.status !== (action === "pause" ? "paused" : "running"))
						throw new Error(
							action === "pause" ? "目标未暂停，请核对插件提示" : "目标未继续，请检查预算、运行额度和插件设置",
						);
				}
			} finally {
				this.controlling = false;
			}
		} finally {
			this.logger.info("当前目标控制处理结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤3：解析稀疏设置与当前分支焦点
	 * ========================================================================
	 * 数据源：插件公开的全局/项目设置路径与内存会话树。
	 * 操作：1) 项目字段覆盖全局字段；2) 无效配置明确报错，不切换到其他操作。
	 */
	private async preferences() {
		this.logger.info("开始读取目标控制设置");
		try {
			// 3.1 环境覆盖与相对路径基准遵循插件公开约定，只读取展示和控制所需字段。
			const cwd = this.session.sessionManager.getCwd();
			const paths = [
				process.env.PI_GOAL_GLOBAL_SETTINGS_FILE?.trim()
					? resolve(homedir(), process.env.PI_GOAL_GLOBAL_SETTINGS_FILE.trim())
					: join(getAgentDir(), "pi-goal-x-settings.json"),
				process.env.PI_GOAL_SETTINGS_FILE?.trim()
					? resolve(cwd, process.env.PI_GOAL_SETTINGS_FILE.trim())
					: join(cwd, ".pi", "pi-goal-x-settings.json"),
			];
			const layers = await Promise.all(
				paths.map(async (path) => {
					try {
						return preferencesSchema.parse(JSON.parse(await readFile(path, "utf8")));
					} catch (error) {
						if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
							return preferencesSchema.parse({});
						throw new Error("目标设置无法读取或格式无效，请检查插件设置");
					}
				}),
			);
			const [global, project] = layers;
			// 3.3 检查所有公开动作的重复路由，防止插件回退默认命令后误调归档或创建。
			const owners = new Map<string, string>();
			for (const id of commandIds) {
				for (const route of project.commands?.[id] ?? global.commands?.[id] ?? [id]) {
					if (owners.has(route) && owners.get(route) !== id)
						throw new Error("目标命令别名存在冲突，请修正插件设置后重载");
					owners.set(route, id);
				}
			}
			return {
				disabled: project.disabled ?? global.disabled ?? false,
				commands: {
					"goal-pause": project.commands?.["goal-pause"] ?? global.commands?.["goal-pause"] ?? ["goal-pause"],
					"goal-resume": project.commands?.["goal-resume"] ?? global.commands?.["goal-resume"] ?? ["goal-resume"],
					"goal-clear": project.commands?.["goal-clear"] ?? global.commands?.["goal-clear"] ?? ["goal-clear"],
				},
			};
		} finally {
			this.logger.info("目标控制设置读取结束");
		}
	}

	private focusedGoalId(): string | null {
		this.logger.info("开始核对会话目标焦点");
		try {
			// 3.2 最后的显式 unfocus 必须生效，其他分支上的记录不能覆盖当前分支。
			const entry = this.session.sessionManager
				.getBranch()
				.reverse()
				.find((entry) => entry.type === "custom" && entry.customType === "pi-goal-focus");
			if (!entry || entry.type !== "custom") return null;
			const parsed = focusSchema.safeParse(entry.data);
			if (!parsed.success) throw new Error("当前会话的目标焦点记录无效");
			return parsed.data.focusedGoalId;
		} finally {
			this.logger.info("会话目标焦点核对结束");
		}
	}

	/*
	 * ========================================================================
	 * 步骤4：生成有界展示数据
	 * ========================================================================
	 * 数据源：插件返回的完整目标和任务树，不修改原记录。
	 * 操作：1) 保留真实生命周期；2) 截断提示计入上限并显式告知界面。
	 */
	private project(raw: NonNullable<z.infer<typeof goalDetailsSchema>["goal"]>, disabled: boolean): GoalView {
		this.logger.info("开始转换目标展示数据");
		try {
			let truncated = false;
			const clip = (value: string, limit: number): string => {
				if (value.length <= limit) return value;
				truncated = true;
				return `${value.slice(0, limit - 1)}…`;
			};
			// 4.1 统一收束长字段与任务数量，不能让一个长标题使整栏消失。
			const tasks: GoalTaskView[] = [];
			const visit = (items: StoredTask[], depth: number) => {
				for (const task of items) {
					if (depth > 20 || tasks.length >= 500) {
						truncated = true;
						return;
					}
					tasks.push({
						id: clip(task.id, 200),
						title: clip(task.title, 2000),
						status: task.status,
						depth,
						current: false,
						...(task.verificationContract ? { verificationContract: clip(task.verificationContract, 8000) } : {}),
						...(task.evidence ? { evidence: clip(task.evidence, 8000) } : {}),
					});
					if (task.subtasks) visit(task.subtasks, depth + 1);
				}
			};
			visit(raw.taskList?.tasks ?? [], 0);
			const current =
				raw.status === "complete"
					? undefined
					: (tasks.find((task) => task.id === raw.currentTaskId && task.status === "pending") ??
						tasks.find((task) => task.status === "pending"));
			for (const task of tasks) task.current = task === current;
			const top = tasks.filter((task) => task.depth === 0);
			const completed = top.filter((task) => task.status === "complete" || task.status === "skipped").length;
			const view: GoalView = {
				id: raw.id,
				title: clip(
					raw.objective
						.split(/\r?\n/u)
						.map((line) => line.replace(/^#+\s*/u, "").trim())
						.find(Boolean) ?? raw.objective,
					500,
				),
				objective: clip(raw.objective, 20000),
				status: raw.status === "active" ? (raw.autoContinue ? "running" : "idle") : raw.status,
				autoContinue: raw.autoContinue,
				sisyphus: raw.sisyphus,
				auditor: !disabled && raw.skipAuditor !== true,
				usage: {
					tokensUsed: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(raw.usage.tokensUsed)),
					activeSeconds: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(raw.usage.activeSeconds)),
				},
				tasks,
				...(top.length
					? { progress: { completed, total: top.length, percentage: Math.round((completed / top.length) * 100) } }
					: {}),
				...(current ? { currentTask: { id: current.id, title: current.title } } : {}),
				...(raw.verificationContract ? { verificationContract: clip(raw.verificationContract, 20000) } : {}),
				...(raw.pauseReason ? { pauseReason: clip(raw.pauseReason, 8000) } : {}),
				...(raw.activePath ? { activePath: clip(raw.activePath, 1000) } : {}),
				...(raw.updatedAt ? { updatedAt: clip(raw.updatedAt, 100) } : {}),
			};
			return { ...view, truncated };
		} finally {
			this.logger.info("目标展示数据转换结束");
		}
	}
}
