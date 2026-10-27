# Goal 会话隔离

目标栏只展示当前会话分支最后一条 `pi-goal-focus` 记录绑定的 Goal。没有焦点、显式取消焦点或插件已清理目标时，目标栏不显示。应用启动恢复与手动切换遵循同一规则。同项目的其他目标不会因为共用目标池而自动出现在当前会话。

读取链路为 Renderer → preload → WorkspaceService → UtilityHostClient → AgentHost → 插件 `get_goal`。每次读取携带 `cwd`、`sessionId` 和 `generation`，主进程与宿主都核对身份，切换后拒绝迟到回复。焦点取自 SDK 内存会话树，不再遍历用户会话目录。目标池位置由插件解析，因此支持自定义 Agent 目录、`PI_GOAL_ROOT`、`goalsRoot` 与已保存的外部目标池焦点。

暂停、继续和归档同时携带目标 ID。宿主读取插件公开的全局/项目设置，选择来自 `get_goal` 同一扩展的注册命令处理器，不把命令交给模型。空别名列表保持禁用；别名冲突或加载后配置变化会明确报错，要求修正并重载。暂停或继续被插件拒绝时，宿主检查实际状态后报告失败。

归档保留插件自己的确认框。控制请求等待确认、取消或交互超时，不套用普通查询的十秒超时。确认未结束时，后台读取不会解除按钮禁用。关闭会话会取消交互并结束请求。

目标状态逐项保留。插件返回 `complete` 时显示完成且不提供继续按钮；插件完成后清理焦点或不再返回目标时隐藏目标栏。审计标签合并设置中的禁用字段与目标自身的 `skipAuditor`。

同会话读取失败时保留上次成功数据，显示错误和重试入口。切换会话立即清空旧目标。读取完成后间隔 2.5 秒刷新，避免慢请求重叠。长标题、合同和原因会生成有界展示内容，并显示截断提示；原文不改写。

回归入口：`test/goal-service.test.ts`、`test/goal-host.test.ts`、`test/goal-workspace.test.ts`、`test/renderer/goals.test.ts` 与 `test/utility-host-client.test.ts`。浏览器验收从本包运行 `node e2e/goals.mjs`；可用 `PLAYWRIGHT_CHROMIUM_CHANNEL=msedge` 指定本机 Edge。脚本使用隔离端口，不请求模型。
