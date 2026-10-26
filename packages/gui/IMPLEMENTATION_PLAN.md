**Pi GUI 实施方案**

核对日期：2026-10-23。当前阶段：M3 核心路径通过，M4 已补齐工作树打开、后台任务隔离与计划跨重启恢复，M5 已通过生产编译、NSIS 构建和打包目录离线验收，安装器安装/升级与干净机器验收尚未完成。历史、草稿、任务队列、复制、会话分支、项目文件搜索引用、PNG / JPEG 图片、图片队列、OAuth、可移植扩展 UI、Git 核对、独立终端、工作树、资源诊断、计划契约、并行后台任务和本地定时任务已接通。下文保留完整产品目标，已交付范围以本节和 README 为准。

当前可用：选项目、新对话、模型与思考等级、API Key、流式正文、可折叠思考与工具结果、停止、主题、重载恢复、重启恢复和宿主故障后重开。侧栏已支持当前项目历史搜索、切换、重命名、置顶和归档，草稿按会话跨重载与重启保存。忙碌时可排队或引导，停止后可恢复待处理输入。正文与代码可独立复制；用户消息可分支成独立会话并返回来源。空闲时可搜索项目文件或从原生对话框引用文件，路径随草稿恢复。复用 Nuxt UI、Comark 与 Shiki，没有另建模型请求链路。

当前边界：前台只有一个活动宿主，后台另有最多两个独立宿主；准备阶段不可取消。队列目前只支持整体恢复与清空，每轮追加上限 20 条、200 万字符；中断记录须人工核对，不自动重放。文件引用只提供相对路径，模型须用工具读取。PNG / JPEG 支持选择、粘贴、拖放、空闲发送、排队和引导；恢复保留图片，超过草稿上限时保留队列。扩展支持选择、确认、输入、编辑、通知、状态和文本小组件。资源启停/重载、斜杠菜单、用量统计、hunk 操作、提交/推送、终端专有扩展组件和扩展发起会话替换仍未提供。干净机器、安装器升级、人工输入法和大规模性能尚未验收，当前更新通道仍缺 HTTPS 与代码签名。

**1. 交付范围与技术决定**

```text
┌──────────────┬──────────────────────────────────────────────┐
│ 项目         │ 决定                                         │
├──────────────┼──────────────────────────────────────────────┤
│ 包目录       │ packages/gui                                 │
│ 工作区名称   │ @earendil-works/pi-gui                       │
│ 当前交付     │ 源码桌面闭环、检查与离线验收                 │
│ 目标产品     │ 本地桌面编程工作台                           │
│ 技术路线     │ Electron + Vue 3 + Vite + TypeScript         │
│ 组件策略     │ Nuxt UI 为主，专用组件按阶段加入             │
│ Agent 接入   │ SDK 宿主，复用 TUI 的命令与事件语义          │
│ 首发平台     │ Windows，保留跨平台进程边界                  │
│ 首版闭环     │ 选项目、发任务、看过程、查改动               │
└──────────────┴──────────────────────────────────────────────┘
```

本次交付包含独立包、实现方案、桌面运行入口和真实 SDK 宿主。M1 先保证会话链路可验证，M2 再补齐日常操作；下文未列入当前可用清单的能力仍是规划。

前端使用 Vue 3 Composition API 与单文件组件。消息通信参照现有 TUI 的业务链路：输入形成命令，AgentSession 产生事件，界面根据事件更新。新增 AgentPort 把业务契约与 Electron IPC、Vue 状态、终端渲染分开。

Codex 对照来自 OpenAI 官方文档。原 Codex App 文档部分已转到统一桌面应用文档，本文取其中 Codex 与本地工程工作流；文档没有证明的布局尺寸、组件名称和内部技术栈，均作为 Pi GUI 自身设计决定。

```text
[Pi GUI] ──┬── 界面 ── 项目、会话与辅助面板
           ├── 交互 ── 发出意图并显示处理状态
           ├── 展示 ── 把消息、工具和改动分开呈现
           └── 功能 ── 复用 Pi 核心，补齐桌面服务
```

首版先完成本地工程闭环。远程主机、云端运行、商店分发插件与跨设备同步放在独立后续议题，不能仅凭一个入口声称已具备对应能力。

**2. 界面对照**

```text
┌──────────────┬────────────────────────────┬────────────────────────────────────┐
│ 区域         │ Codex 对照                 │ Pi GUI 设计                        │
├──────────────┼────────────────────────────┼────────────────────────────────────┤
│ 侧边栏       │ 项目与聊天组织             │ 项目分组、最近会话、置顶与归档     │
│ 会话顶部     │ 执行位置与项目上下文       │ 项目、cwd、分支、运行状态          │
│ 主内容区     │ 对话及工作过程             │ 用户消息、过程分组、最终回答       │
│ 底部输入区   │ 提示词与附加上下文         │ 输入框、附件、模型、思考等级       │
│ 辅助面板     │ 文件、审查、终端           │ 文件预览、Diff、终端标签页         │
│ 设置页       │ 应用偏好与工作配置         │ 服务商、认证、外观、快捷键         │
└──────────────┴────────────────────────────┴────────────────────────────────────┘
```

项目与聊天组织参考[官方项目文档](https://learn.chatgpt.com/docs/projects)；审查面板与终端入口参考[代码审查](https://learn.chatgpt.com/docs/code-review?surface=app)和[集成终端](https://learn.chatgpt.com/docs/integrated-terminal)。这些是能力依据；下面的尺寸与视觉规范是本方案设计值。

**2.1 布局**

- 主窗口最小尺寸建议 1100 × 720；侧栏默认 256 px，可在 200–360 px 调整。
- 主内容区承载会话。右侧面板默认 420 px，关闭后让出空间；窄窗口改成覆盖面板，避免挤压消息。
- 终端作为辅助面板标签页，可停靠到底部。文件、差异和终端保留各自滚动位置。
- 输入框固定在会话底部，随内容增高；超过上限后内部滚动。草稿按会话保存。
- 顶部始终显示当前项目与实际 cwd。选择新会话、工作树或恢复旧会话后立即更新。

**2.2 页面与组件**

- `AppShell`：窗口布局、面板尺寸、主题和全局快捷键。
- `ProjectSidebar`：添加目录、项目分组、会话列表、搜索、置顶、归档。
- `ThreadHeader`：会话名、项目路径、Git 分支、执行位置、运行状态。
- `ConversationView`：用户消息、助手消息、工具活动组、异常和最终结果。
- `Composer`：多行文本、文件引用、附件、模型、思考等级、发送与停止。
- `WorkspacePanel`：文件预览、差异、行评论与终端。
- `SettingsView`：服务商认证、模型偏好、外观、快捷键和环境诊断。

首屏没有项目时，展示“打开项目”与已有会话入口；没有认证时，发送区展示配置入口。空状态、加载、无结果、失败和目录已删除分别设计，避免用空白页面代替状态。

**2.3 视觉与可访问性**

浅色、深色主题共用语义色变量。正文建议 14 px，代码使用等宽字体；Windows 中文回退到系统中文字体。层级靠间距、字号和细分隔线表达。状态不能只靠颜色区分；图标必须有可访问名称。键盘可访问所有主要操作，弹窗正确管理焦点，减少动画偏好必须生效。

**3. 交互对照**

```text
┌────────────────┬────────────────────────────────────┬──────────────────────────────────────┐
│ 操作           │ 界面行为                           │ 宿主接入                             │
├────────────────┼────────────────────────────────────┼──────────────────────────────────────┤
│ 空闲时发送     │ Enter 发送，Shift+Enter 换行       │ AgentSession.prompt                  │
│ 忙碌时追加     │ 默认排队，显示待处理消息           │ prompt(...followUp) / followUp       │
│ 调整当前任务   │ 单独选择“引导当前任务”             │ prompt(...steer) / steer             │
│ 停止           │ 显示“正在停止”，等停止结果         │ abort / agent_settled                │
│ 选择模型       │ 搜索服务商和模型，确认后回显       │ ModelRegistry / setModel             │
│ 思考等级       │ 只展示当前模型支持的等级           │ getAvailableThinkingLevels           │
│ 文件与图片     │ @ 文件引用，拖入或粘贴图片         │ 文件上下文 / PromptOptions.images    │
│ 斜杠命令       │ 区分 GUI 命令与 Pi 资源命令        │ GUI 命令表 / 会话资源                │
│ 分支会话       │ 从指定用户消息另开会话             │ SessionManager.createBranchedSession │
│ 扩展提问       │ 选项、确认、输入与编辑弹窗         │ ExtensionUIContext 适配器            │
└────────────────┴────────────────────────────────────┴──────────────────────────────────────┘
```

Codex 的队列、引导、附件与行评论工作流可见[官方工程工作流说明](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)。Pi GUI 的发送规则参照 InteractiveMode 对 AgentSession 的调用；GUI 自有命令与事件经 AgentPort 传递，快捷键统一登记到可配置命令表。

**3.1 输入与发送**

1. 空闲时发送新任务。先保留草稿，再标记发送中，收到明确接受响应后更新为已发送。
2. 输入法组词期间，Enter 只提交候选字；检查 composition 状态，不能误发消息。
3. 忙碌时主操作为“排队”，映射为 `prompt(..., { streamingBehavior: "followUp" })`；“引导当前任务”映射为 `prompt(..., { streamingBehavior: "steer" })`。普通排队可用 `followUp/steer`，斜杠资源仍经 prompt 处理。
4. 引导消息在当前助手回合的工具调用结束后交给模型，不能显示成已经强制打断正在运行的工具。
5. 待处理消息以队列条目显示，使用现有 `queue_update` 同步。SDK 已有队列查询与整体清空能力；单条移除、改写需要带稳定身份的命令契约，完成后再提供对应按钮。
6. 发送被拒绝时保留原文和附件。发送结果不明时先恢复状态，不能自动重发可能已接受的任务。
7. 对照 InteractiveMode，先处理 GUI 自有命令，再把扩展、模板、技能交给会话。命令发现由宿主汇总资源与扩展注册信息；Vue 不自行读取资源文件，也不复制 TUI 的整段命令分派。

文件引用支持“引用文件”原生选择、搜索弹窗和输入框行内 @ 补全。原生选择每次最多 20 个，搜索按字面量查询返回最多 20 条相对路径，单选后插入。主进程使用项目内逐层 .gitignore，有扫描条目、深度、时间和规则大小上限，受限结果明确提示不完整。新查询取消旧查询，关闭或换代丢弃迟到结果。选中时重新解析真实路径并核对项目归属，目录链接不能越界；Controller 复用原草稿入口，保留原输入与保存顺序。行内补全按 UTF-16 光标替换当前片段，查询与校验期间草稿变化会拒绝旧选择。Enter、Tab 和方向键优先处理候选，Esc 保留焦点，Shift+Enter 换行；组词与长按不误发任务。默认键位可覆盖，当前无设置页编辑入口。取消和超限不改内容，保存失败保留输入。引用不读取正文、不自动发送。

PNG / JPEG 图片持久化已接通：原生选择、输入区粘贴与拖放共用字节和像素检查，再完整解码、统一重编码为 PNG 并保存本地副本。JPEG 在解码前核对有界帧头。文件事件只读取当前事件中的 File，纯文字保留浏览器行为，混合普通文件或无效图片整批拒绝。草稿只引用内容 ID，每份最多 4 张、每张最多 3 MiB。支持图片的模型在空闲时可连同文字说明发送，历史与草稿复用按需预览。图片草稿在正常收束后清理；重载或中断后保留供核对，不自动重发。图片排队和引导复用 SDK steer / followUp，附件 ID 随写前记录保存；恢复先合并并保存文字与图片，再清空队列，超限或失败保留原记录。内容库回收另行接入。

**3.2 模型与思考等级**

从 ModelRegistry 实际可用列表生成选择器，不硬编码服务商与模型名称。宿主调用 `setModel` 成功后返回最新快照。等级用 `getAvailableThinkingLevels()`，切换用 `setThinkingLevel()`；界面依据返回快照与 `thinking_level_changed` 更新，以会话实际等级为准。

首版在运行中禁用模型与思考等级修改，避免界面选择值与在途请求混用。用户可停止后再切换。服务商认证变更后刷新模型列表，并让相关 Agent 进程重新加载凭据。

**3.3 停止、切换与恢复**

停止按钮只提交取消请求，随后显示“正在停止”。等待运行收束或进程终结后才能显示已停止。停止不会回滚已写文件，也不能保证忽略取消信号的外部程序立即结束。

当前实现先把 SDK 队列撤下并保留写前记录，再请求 abort，防止后续消息自动续跑。记录可能包含本轮已消费输入；重启和故障恢复后只展示待核对内容。用户整理到草稿后再发送，保存失败时不清空原队列。

分支从当前上下文中已有助手历史的纯文本用户消息开始。保留该消息之前的历史，把选中文本放回新草稿，不自动发送。主进程校验原生 entry ID 和宿主代次；待接替宿主先用 SessionManager 建立新文件，再初始化运行时，避免 SDK 补写来源文件。草稿和索引保存成功后才关闭原宿主。来源可返回，原草稿和队列不迁移。首条消息、图片和超过草稿上限的输入暂不开放。

完整目标是切换到另一会话时让原任务继续运行，并保留状态和未读标记。M1 只持有一个宿主，在途操作结束后才允许切换项目或新建会话。后续新建、恢复、fork、clone 必须串行处理，并正确展示扩展返回的 `cancelled`。

**4. 展示对照**

```text
┌──────────────┬────────────────────────────────────────┬──────────────────────────────────┐
│ 内容         │ 展示规则                               │ 数据依据                         │
├──────────────┼────────────────────────────────────────┼──────────────────────────────────┤
│ 最终回答     │ Markdown、代码高亮、复制与文件链接     │ assistant 消息的文本块           │
│ 推理过程     │ 可折叠，只展示模型实际提供的内容       │ thinking_* 事件                  │
│ 工具活动     │ 名称、参数摘要、耗时、状态与结果       │ tool_execution_* 事件            │
│ 工具输出     │ 流式替换累计快照，支持展开长输出       │ partialResult / result           │
│ 文件变更     │ 文件列表、增删统计、统一差异视图       │ GitService 实时读取仓库          │
│ 任务状态     │ 生成、工具、压缩、重试、等待输入       │ 会话事件与进程状态               │
│ 用量信息     │ 上下文、token、可获得的成本数据        │ getSessionStats / 模型元数据     │
│ 附件预览     │ 图片缩略图、文本预览与打开原文件       │ 附件元信息 / 文件预览服务        │
└──────────────┴────────────────────────────────────────┴──────────────────────────────────┘
```

消息视图按一次助手回合组织过程，工具详情默认折叠；最终回答保持完整可读。Git 面板读取仓库事实，其范围与 Codex 审查面板一致地说明为当前仓库改动，不能把所有未提交文件都标成 Agent 所改。

**4.1 流式消息与工具**

- 以会话、进程代次、回合和内容块标识定位更新；工具结果按 `toolCallId` 关联。
- 对照 TUI，默认用 message_update.message 替换对应助手消息快照，保留内容块原始顺序；不再追加该快照已包含的 delta。
- `tool_execution_update.partialResult` 是累计快照，必须替换显示，不能逐次拼接导致重复。
- 工具完成事件与持久化的 toolResult 是同一次执行的不同投影，界面合并成同一工具条目。
- thinking 内容只使用服务商实际返回的事件。未返回时显示运行状态，不补写推理文本。
- 工具失败显示在工具条目里，并允许模型继续处理；它不必然意味着整个任务失败。
- 工具进度结束、`message_end` 与整个任务结束分别处理。

**4.2 文件、差异与输出**

文本预览只读，标明相对路径、编码和行号；图片单独预览。二进制文件和过大文件给出打开原文件入口。路径链接由主进程校验归属后打开，外链按允许的协议交给系统浏览器。

Diff 包含文件列表、增删统计、上下文、换行切换以及行评论。行评论先保存在 GUI，用户发送后才变成新提示词；评论定位携带文件、左右侧、行号和所评审版本，仓库变化后提示定位已过期。

长工具输出做显示截断或虚拟化，保留“查看完整输出”。滚动只在用户停留底部时自动跟随，向上阅读时累计新内容提示，不抢滚动位置。

**4.3 用量与运行状态**

显示实际服务商、模型和思考等级。token、上下文和费用只展示可获得的字段；缺失值显示未知，不按零处理。费用是已知模型价格下的估算，不代表服务商最终账单。

生成、工具运行、压缩、重试和等待用户输入分开显示。后台任务只在完成、失败或需要用户处理时通知，切换聊天不会弹出重复完成通知。

**5. 功能覆盖与分期**

```text
┌────────────────┬──────────────────────────────┬──────────────────────────────────┬──────────┐
│ 功能           │ Pi 当前基础                  │ GUI 还需补充                     │ 阶段     │
├────────────────┼──────────────────────────────┼──────────────────────────────────┼──────────┤
│ 项目与会话     │ 会话 JSONL、恢复、重命名     │ 项目目录、搜索、置顶、归档       │ M1–M2    │
│ 模型与认证     │ ModelRegistry、AuthStorage   │ 服务商设置、OAuth 交互           │ M1–M2    │
│ Agent 对话     │ SDK、AgentSessionEvent       │ 宿主、AgentPort、会话投影        │ M1–M2    │
│ 文件上下文     │ read / 图片输入              │ 文件树、引用、预览、大小限制     │ M2       │
│ 会话分支       │ Runtime.fork、会话树         │ 分支选择与来源展示               │ M2       │
│ 代码审查       │ 编辑工具可返回差异           │ 仓库级差异、行评论、Git 操作     │ M3       │
│ 集成终端       │ bash 工具与命令结果          │ PTY 会话、尺寸与焦点管理         │ M3       │
│ 工作树         │ Git 仓库可作为 cwd           │ 创建、关联、保留与清理流程       │ M4       │
│ 技能与扩展     │ 资源加载与 UIContext         │ 资源列表、弹窗与能力诊断         │ M2–M4    │
│ 计划与并行     │ 可用扩展与多个独立宿主       │ 计划状态、会话调度与隔离         │ M4       │
│ 定时任务       │ 单次 Agent 运行能力          │ 本地调度、记录、通知与补偿       │ M4       │
│ 应用分发       │ 现有 SDK 与本地资源          │ 桌面打包、签名与升级验证         │ M5       │
└────────────────┴──────────────────────────────┴──────────────────────────────────┴──────────┘
```

Codex 的执行位置参考[环境文档](https://learn.chatgpt.com/docs/environments/modes)，工作树生命周期参考[工作树文档](https://learn.chatgpt.com/docs/environments/git-worktrees)，调度参考[定时任务文档](https://learn.chatgpt.com/docs/automations)。这些能力在 Pi GUI 中按表中阶段建设，不能把 Pi 现有工具能力等同于完整桌面功能。

**5.1 会话与认证**

项目目录与侧栏组织由 GUI 保存；会话内容继续使用 Pi 原生 JSONL。列表发现用 `SessionManager.list/listAll`；打开后由独立宿主持有 AgentSessionRuntime，操作与事件经过 AgentPort。置顶、归档和未读属于 GUI 元数据；归档保留会话文件，不等于删除。

认证复用 `AuthStorage`。API Key 录入走宿主专用写入接口，成功后清空输入；查询只返回认证状态与来源，不回传凭据。OAuth 的打开链接、用户输入、进度和取消回调映射为请求与响应。AuthService 持有登录回调，Electron 负责打开外部浏览器，Vue 只显示输入、进度与结果。

**5.2 Git 审查与工作树**

仓库级差异需要新建 GitService。先交付只读查看，再补文件或 hunk 级暂存、取消暂存、还原，以及提交和推送。所有修改仓库的动作都重新验证当前 HEAD、索引和所选差异，避免操作旧视图。Git 参数以参数数组传递，不能拼接用户路径到 shell。

“上轮改动”需要运行前后快照及明确归属信息，首版先标记为未提供。多个写入者存在时，不能只用时间范围推断作者。

工作树阶段新增 WorktreeService：选择明确起点、创建目录、关联会话、展示实际 cwd、检查分支占用。清理前处理未提交内容与需要保留的忽略文件。会话 fork 与 Git 工作树是不同动作，分别显示。首轮不做自动清理或自动 Handoff。

**5.3 终端与扩展**

真正的集成终端需要主进程 PTY 服务及 Windows ConPTY 验证。Pi 的 bash 执行能力是会话中的命令操作，不能当成完整交互终端。用户终端与 Agent 工具输出分别持有生命周期；停止 Agent 不关闭用户终端。

对照 InteractiveMode 绑定 ExtensionUIContext 的方式，宿主提供桌面 UIContext 适配器，先覆盖 `select/confirm/input/editor`、通知、状态和文本小组件。宿主保存待完成回调，跨进程只传可序列化请求与结果；超时、取消、会话更换后拒绝过期响应。

终端专有的 `custom()` 工厂、页脚组件、编辑器组件和 ANSI 渲染需要单独能力声明。Vue 不接收这些组件或执行其渲染函数。需要新增 GUI mode 或宿主能力字段时，先完善核心类型与回归，不能把桌面端声明为拥有完整 TUI 能力。

**5.4 计划、并行与自动化**

计划模式先定义产品契约：待确认计划、允许修改的范围、用户确认后的状态转换，再以受控工具集合或扩展接入。只有提示词标签不代表计划模式已落实。

并行以独立会话进程为单位；同项目需要改文件时优先独立工作树。首版设置运行数量上限，超限任务排队。现有实验性 orchestrator 不作为 GUI 首版前提。

本地定时任务阶段新增调度存储、最近运行、暂停、失败记录、通知和去重。文档中明确电脑休眠和应用关闭时的行为；重启后补跑还是跳过须由任务策略决定。调度 id 防重复安排与单次 run id 防重复执行分别验证，不能靠内存计时器宣称跨重启可靠。

**6. 按 TUI 对照的通信架构**

```text
┌──────────────────────────────────────────┬──────────────────────────────────────────────┐
│ 现有 TUI 落点                            │ GUI 对应落点                                 │
├──────────────────────────────────────────┼──────────────────────────────────────────────┤
│ EditorComponent.onSubmit                 │ Composer 提交业务意图                        │
│ InteractiveMode 的命令分派               │ GuiController / 命令注册表                   │
│ session.prompt / steer / followUp        │ AgentPort → AgentHost → SDK                  │
│ session.subscribe(handleEvent)           │ 宿主订阅 → EventEnvelope → 纯投影            │
│ AssistantMessageComponent                │ AssistantMessage.vue                         │
│ pendingTools / updateResult              │ 按 toolCallId 管理工具 ViewModel             │
│ ui.requestRender()                       │ Vue 响应式状态触发 DOM 更新                  │
│ Terminal 输入和 ANSI 输出                │ 仅留给 TUI；GUI 使用 DOM 事件                │
└──────────────────────────────────────────┴──────────────────────────────────────────────┘
```

代码边界已经核对：`packages/tui` 定义终端、组件、输入与渲染；真正连接 Agent 的是 coding-agent 中的 InteractiveMode。GUI 复用它的命令与事件语义，保持独立展示层，不传 ANSI 文本或 TUI 组件。

```text
[同一会话语义] ──┬── TUI ── InteractiveMode ── AgentSession
                 └── GUI ── AgentPort ── AgentHost ── AgentSession
```

现有 TUI 暂不改造。AgentPort 先在 gui 包中建立，以一致行为测试约束两种界面；确实出现可复用逻辑后，再评估提取共享模块，避免为 GUI 开发先重构整个终端应用。

**6.1 进程与职责**

```text
[Vue 组件] ── GuiController ── AgentPort
                              ├── 桌面传输 ── preload IPC → 主进程 → MessagePort
                              ├── 测试传输 ── 内存 FakeAgentPort
                              └── 业务宿主 ── utilityProcess → AgentSessionRuntime
```

生产路径为 Vue → GuiController → AgentPort 的 IPC 适配器 → Electron 主进程 → utilityProcess 中的 AgentHost → SDK。内存 FakeAgentPort 仅用于测试。AgentPort 是接口，前端不依赖实际传输；Electron IPC 与 MessagePort 只搬运经过校验的契约数据。

- Vue 单文件组件负责布局、输入与展示，只读取 ViewModel。
- GuiController 负责命令分派、草稿确认、视图动作与订阅释放；不持有 SDK 实例。
- SessionProjection 是纯 TypeScript 投影器，消费会话事件；不导入 Vue、Electron、文件系统或 Provider SDK。
- preload 提供有限 AgentPort 方法，不能把完整 ipcRenderer 暴露给页面。
- Electron 主进程管理窗口、宿主进程注册、文件选择、外部浏览器、Git 和 PTY。
- AgentHost 在 utilityProcess 中使用 SDK；持有会话、模型注册、认证、资源和扩展 UI 回调。

前台保留一个活动 AgentHost，空闲时替换；后台调度另持有最多两个独立宿主。Electron 自带 Node 运行时承载宿主。开发模式从工作区源码加载 SDK，打包模式使用随包宿主与资源根。仓库外的中文空格路径、无全局 Node/Pi 的应用 PATH 已通过 SDK 写文件、Monaco 和 PTY 用户路径；干净机器与完整安装仍需单独验收。

**6.2 命令、结果与事件契约**

```text
┌──────────────────────────┬────────────────────────────────────────────────────────┐
│ 契约                     │ 必要内容                                               │
├──────────────────────────┼────────────────────────────────────────────────────────┤
│ CommandEnvelope          │ requestId、sessionId、generation、type、payload        │
│ CommandResult            │ requestId、received/accepted/rejected、data/error      │
│ SessionEventEnvelope     │ sessionId、generation、seq、AgentSessionEvent          │
│ SessionSnapshot          │ version、lastSeq、消息、模型、队列、状态、能力         │
│ HostEvent                │ 认证进度、连接变化、可恢复诊断                         │
│ UIRequest / UIResponse   │ uiRequestId、方法、展示参数或回复结果                  │
└──────────────────────────┴────────────────────────────────────────────────────────┘
```

已建立命令 Envelope、SessionSnapshot、归一化 SessionEvent、队列快照和连接通知；认证进度、扩展能力和待答请求同样进入受限快照与事件。SDK 原始对象只在宿主内使用，跨进程数据经 Zod schema 归一化；shared 不引用 SDK、Vue 或 Electron 类型。

当前 AgentPort 提供 `dispatch(envelope)`、`getSnapshot()` 和 `subscribe(listener)`，订阅返回释放函数。GuiController.dispose 释放界面订阅，桌面组合入口管理宿主生命周期。业务层不区分内存调用和 Electron 消息。

```text
┌────────────────────┬──────────────────────────────────────────┬────────────────────────────────┐
│ 业务意图           │ AgentHost 调用                           │ 返回事实                       │
├────────────────────┼──────────────────────────────────────────┼────────────────────────────────┤
│ 提交消息           │ session.prompt(text, options)            │ 接受结果 + 会话事件            │
│ 普通引导/排队      │ session.steer / followUp                 │ 队列事件与实际消费结果         │
│ 停止任务           │ session.abort                            │ 停止请求与后续 settled         │
│ 读取状态           │ session 状态 + SessionManager            │ 可序列化快照                   │
│ 切换模型           │ ModelRegistry + session.setModel         │ 模型和思考等级快照             │
│ 切换思考等级       │ session.setThinkingLevel                 │ thinking_level_changed         │
│ 新建/恢复/fork     │ AgentSessionRuntime                      │ 新会话身份与重新订阅           │
│ 统计/压缩          │ getSessionStats / compact                │ 统计快照与压缩事件             │
│ 扩展 UI            │ session.bindExtensions(uiContext)        │ UI 请求与对应响应              │
└────────────────────┴──────────────────────────────────────────┴────────────────────────────────┘
```

普通用户输入统一经 session.prompt，保留 TUI 中模板展开、扩展命令和 streamingBehavior 的处理路径。查询与变更命令分别返回快照或结果；新建、恢复和 fork 成功后先释放旧订阅，再绑定新会话，不能让旧事件写入当前界面。

命令用 requestId 关联结果，事件用 sessionId + generation + seq 排序，扩展交互另用 uiRequestId。工具仍按 toolCallId 关联；这几类 id 不能混用。只传结构化数据，异常、函数、回调、SDK 对象和凭据不进入普通事件通道。

现有 PromptOptions.preflightResult 注释为 RPC 内部钩子，M1 不接入。命令 Promise 只表示这次调用结束；草稿以用户消息进入会话为接受依据，任务以 agent_settled 为收束依据。准备状态单独投影，预检失败主动回到空闲。将来若需要精确的 accepted/rejected，再完善核心稳定契约和回归。

**6.3 状态投影对照 TUI**

```text
┌──────────────────────────┬──────────────────────────────────────────────────┐
│ 收到的事实               │ 界面处理                                         │
├──────────────────────────┼──────────────────────────────────────────────────┤
│ command received         │ 仅表示宿主收到命令，保留待确认状态               │
│ command accepted         │ 预检通过或入队；不代表任务完成                   │
│ command rejected         │ 显示发送失败；保留草稿与附件                     │
│ message_update           │ 替换对应助手消息快照，与 TUI 一致                │
│ tool_execution_update    │ 按 toolCallId 替换累计工具输出                   │
│ agent_end                │ 结束一次底层循环；检查后续处理                   │
│ agent_settled            │ 本次运行收束，允许完成通知                       │
│ 宿主退出 / 重新连接      │ 终结旧请求，再用快照恢复界面                     │
└──────────────────────────┴──────────────────────────────────────────────────┘
```

InteractiveMode 用 message_update.message 替换助手内容，用 pendingTools 按 toolCallId 更新工具结果。GUI 投影器沿用这一方式；Vue 只触发视图更新，不再次拼接已包含在快照中的 delta。entry_appended、session_info_changed、thinking_level_changed 也要覆盖，避免只显示文本而遗漏会话状态。

```text
[会话运行] ──┬── 请求 ── received → accepted / rejected
             ├── 工作 ── 模型生成 ↔ 工具执行
             ├── 延续 ── 压缩 / 重试 / 队列 → 继续工作
             └── 收束 ── agent_settled → 成功 / 失败 / 已取消
```

agent_end 仍可能跟随重试、压缩或队列继续。完成判断使用 agent_settled，再检查最终消息和持久化事实。连接状态独立记录启动中、已连接、断开与关闭，不能和任务成功失败合成一个布尔值。

**6.4 订阅、背压与恢复**

先在宿主订阅会话，再建立带 lastSeq 的快照；Renderer 安装快照后处理后续事件。事件进入缓冲时立即复制，不能让 SDK 可变消息对象在发送前发生变化。GUI 渲染节流只合并可替代的进度快照，不能丢弃消息结束、工具结束和运行收束事件。

AgentSession.subscribe 不是跨进程背压协议。宿主回调只做快照与入队，不等待 Vue 渲染；适配器设置缓冲上限、丢弃规则和缺口检测。超限或发现缺口时重新获取完整快照，不继续猜测状态。

Renderer 重载不结束 AgentHost，重新连接读取宿主快照即可。AgentHost 崩溃则重建运行时，从 JSONL 恢复已落盘消息，并增加 generation。迟到的旧代次事件和扩展回复均丢弃。SDK 没有跨重启请求幂等，不能自动重发可能已经接受的 prompt。

```text
┌──────────────────┬────────────────────────────────────┬────────────────────────────────────┐
│ 数据             │ 归属                               │ 恢复依据                           │
├──────────────────┼────────────────────────────────────┼────────────────────────────────────┤
│ 消息与工具事实   │ Pi SessionManager                  │ 原会话 JSONL 与活动分支            │
│ 运行中状态       │ AgentHost 与有序事件缓冲           │ SDK 快照与后续事件                 │
│ 置顶与归档       │ GUI 元数据                         │ GUI 状态文件                       │
│ 模型与服务商     │ Pi 配置和认证存储                  │ ModelRegistry / AuthStorage        │
│ 文件改动         │ 项目文件与 Git                     │ 工作区、索引与提交                 │
│ 输入草稿与布局   │ GUI 偏好                           │ 按会话保存的草稿和布局             │
└──────────────────┴────────────────────────────────────┴────────────────────────────────────┘
```

JSONL 是会话事实来源。GUI 状态文件只保存项目、排序、置顶、归档、草稿和布局，原子写入并带 schema 版本；不另写一份聊天真相，不存密码或 token。

GUI 内同一会话只允许一个 AgentHost，跨窗口共享注册表。现有 CLI 不遵守 GUI 私有租约，不能同时写同一会话；发现外部写入后阻止新发送并提示重开。若要支持完整跨进程写锁，必须由核心共同落实。

应用退出时先处理仍在运行的任务，停止请求之后等待实际收束与输出处理，超时才终结受管进程树。强制结束只能恢复已落盘事实，不能标成任务正常完成。

**6.5 桌面边界**

启用 Electron context isolation，关闭 Renderer 的 Node integration。preload 只暴露经校验的业务接口；普通事件不含凭据。认证使用单独写入与状态查询通道，Vue 不持有 Provider SDK 或访问 token。

目录由主进程选择并规范化。文件引用、附件、预览和 Git 动作校验最终路径；大文件、软链接、目录失效、Windows 盘符和中文路径分别处理。Markdown 默认禁用原始 HTML，外链只允许明确协议。

Pi 当前没有内置操作系统沙箱。项目信任控制项目资源和扩展加载，不等同于限制全部进程、文件或网络访问。“仅阅读工具”只表示工具配置；要对照 Codex 的系统权限边界，需另做可验证的执行隔离。

**6.6 代码对照入口**

输入  `packages/tui/src/editor-component.ts`
onSubmit/onChange 定义编辑器输入回调边界。

渲染  `packages/tui/src/tui.ts`
Component、handleInput 和 requestRender 定义终端展示职责。

调度  `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
setupEditorSubmitHandler、subscribeToAgent 和 handleEvent 连接输入、会话与组件。

消息  `packages/coding-agent/src/core/agent-session.ts`
AgentSessionEvent、prompt、队列、subscribe、模型和思考等级。

运行  `packages/coding-agent/src/core/agent-session-runtime.ts`
新建、恢复和分支时更换当前会话及 cwd 资源。

组装  `packages/coding-agent/src/core/sdk.ts`
创建会话并接入认证、模型、工具与资源。

**7. 组件复用、目录与依赖**

**7.1 基础组件选型**

```text
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ 候选             │ 适合之处                       │ 本方案决定                     │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Nuxt UI          │ 成套组件、主题与聊天展示       │ 首选，走纯 Vue / Vite 接入     │
│ shadcn-vue       │ 源码可控，已有 Agent 界面模式  │ 备选，需自行维护复制的源码     │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

默认采用 [Nuxt UI](https://ui.nuxt.com/docs/getting-started/installation/vue)。它提供纯 Vue 的 Vite 插件，能覆盖首版大部分交互，也便于统一主题；不需要引入 Nuxt 应用或服务端。[shadcn-vue AI Elements](https://www.shadcn-vue.com/docs/ai-elements) 以复制源码的方式提供 Agent 界面模式，可作为备选，但需要自行维护这些源码。首版只采用一套基础组件体系；Reka UI 由所选组件库复用，不另搭一套样式与交互。

选型依据是成套程度、业务接入成本和可维护性。官网示例与源码核对只说明 API 可接入；Electron、中文输入和大输出的实际体验，仍以 M1 验收为准。若必需交互只能靠大范围修改组件内部才能满足，再评估替换基础库。

**7.2 复用位置**

```text
┌──────────────────┬────────────────────────────────────┬────────────────────────────────┐
│ 使用位置         │ 复用组件或库                       │ 仍由 GUI 负责                  │
├──────────────────┼────────────────────────────────────┼────────────────────────────────┤
│ 窗口布局         │ Sidebar / Splitter / Tabs          │ 项目组织与布局持久化           │
│ 聊天展示         │ ChatMessages / ChatMessage         │ Pi 消息投影与回合分组          │
│ 输入区           │ ChatPrompt / ChatPromptSubmit      │ 草稿、排队、引导和停止         │
│ 过程展示         │ ChatReasoning / ChatTool           │ 实际状态与 toolCallId 关联     │
│ 通用交互         │ Modal / SelectMenu / Popover       │ 模型数据、命令与扩展回复       │
│ 文件与长列表     │ Tree / ScrollArea                  │ 目录查询、分页与窗口化策略     │
│ Markdown         │ @comark/vue + Shiki 插件           │ 安全配置与本地文件链接         │
│ 代码与差异       │ monaco-editor                      │ 版本校验、行评论与 Git 操作    │
│ 交互终端         │ @xterm/xterm + addon-fit           │ PTY、尺寸同步与进程退出        │
│ 图标             │ Iconify + 本地 Lucide 图标集       │ 离线打包与可访问名称           │
└──────────────────┴────────────────────────────────────┴────────────────────────────────┘
```

表中的布局、聊天和通用交互组件均来自 Nuxt UI；[Markdown](https://comark.dev/rendering/vue)、[Monaco](https://github.com/microsoft/monaco-editor) 与 [xterm.js](https://xtermjs.org/) 分别接入专用能力。组件解决渲染和交互细节，Controller、会话投影、权限请求、Git 与进程生命周期继续按第 6 节划分。

```text
[组件复用] ──┬── Nuxt UI ── 布局、输入、聊天与弹窗
             ├── Comark / Shiki ── 流式正文与代码高亮
             ├── Monaco ── 文件与差异视图
             └── xterm.js ── 用户交互终端
```

**7.3 接入约束**

1. **聊天组件只接展示。** 现有 [ChatMessages](https://ui.nuxt.com/docs/components/chat-messages) 支持消息属性和自定义插槽；[源码](https://github.com/nuxt/ui/blob/v4/src/runtime/components/ChatMessages.vue) 不负责发模型请求。renderer 中的薄适配层把 Pi ViewModel 映射为所需 props 或插槽内容；组件类型、AI SDK 消息形状不能进入 shared/domain。发送仍走 Composer → GuiController → AgentPort → AgentHost → AgentSession，事件返回后再更新 ViewModel。
2. **保留完整运行状态。** 组件的 submitted/streaming/ready/error 只是展示状态，不能替代排队、工具运行、重试、等待输入和 agent_settled。工具和推理用对应组件的内容插槽展示 Pi 数据，不把工具调用交给组件库调度。官方聊天模板中的 useChat、streamText、HTTP/SSE 路由不接入本方案；不用另一套聊天存储或模型请求链路。
3. **输入先保持文本语义。** M1 复用 ChatPrompt 的多行、自动增高和组合输入保护。M2 用 SelectMenu、CommandPalette 与 Popover 补模型、@ 文件和斜杠提示；先复用菜单，不为这些功能默认引入富文本编辑器。组件默认快捷键须纳入可配置命令表，发生冲突时用其 body 插槽接管输入。中文候选、补全菜单与发送键的优先级必须单独验收。
4. **Markdown 使用受限配置。** 采用官方 Vue 聊天示例使用的 @comark/vue 与 Shiki 插件。输入为投影后的累计文本快照，streaming 依据该消息实际状态切换；消息结束后重新完成解析。Markdown 异步组件按官方要求包在 Suspense 内。设置 registerDefaultPlugins: false，按需启用任务列表等语法，并明确加入 security 插件和标签/协议白名单；不开 HTML、组件语法、属性绑定或动态组件解析。本地路径由自有链接组件交给主进程校验，不能让 Markdown 内容调用桌面接口。
5. **自动滚动与虚拟化分开处理。** ChatMessages 有底部跟随与回到底部入口，但不等于虚拟列表。普通会话先复用其滚动行为；历史分段加载，长工具输出按行窗口化，列表优先用 ScrollArea 的 virtualize。会话本身若需要窗口化，单独验证动态高度和阅读锚点，不直接叠两套滚动容器。
6. **编辑器和终端按阶段加入。** M3 直接用官方 Monaco ESM API 薄封装只读预览与 DiffEditor，不先引入额外 Vue 包装库；模型、事件和编辑器在关闭时释放，worker 与语言资源随应用本地分发。行评论、hunk 操作及 Git 状态校验仍需自写。xterm.js 只承载独立 PTY 终端，首版用 addon-fit 同步尺寸；Agent 的 bash 工具输出继续用 ChatTool 与文本视图。
7. **桌面资源完全离线。** 图标使用 @iconify-json/lucide 本地数据，通过 Nuxt UI 的 icon.clientBundle 显式登记或扫描；动态名称必须登记全集，不能依赖 Iconify 在线请求。字体用系统字体或本地文件；高亮主题、语法、WASM 与 worker 也随包携带。按 Electron CSP 验证资源加载，不为组件放开任意远程脚本。

**7.4 规划目录与依赖**

以下目录按职责组织；main、host、preload、shared、domain、renderer、test 和 e2e 已创建，工程服务和分发资源按阶段加入：

- `src/main/`：窗口、主进程 AgentPort 代理、文件选择、Git、PTY 与宿主进程注册。
- `src/host/`：utilityProcess 入口、AgentSessionRuntime、认证、资源与扩展 UI 适配。
- `src/preload/`：有限 AgentPort 业务方法与事件订阅。
- `src/shared/`：无界面框架依赖的命令、结果、事件 Envelope、schema 和 AgentPort 契约。
- `src/domain/`：纯 TypeScript 的 GuiController、会话投影与命令注册表。
- `src/renderer/components/`：Vue 页面、业务组件与第三方 UI 薄封装。
- `src/renderer/adapters/`：ViewModel 到组件 props 的映射，隔离第三方消息类型。
- `src/renderer/composables/`：订阅、焦点、滚动与 Vue 响应式接入。
- `test/`：FakeAgentPort、TUI 事件轨迹对照、纯投影、宿主与进程恢复测试。
- `e2e/`：Electron 交互回归与截图验收。
- `resources/`：图标、桌面资源与打包配置。

M1 添加 Electron、Vue 3、Vite、Vue SFC 编译与 Vite 插件、vue-tsc、Nuxt UI、Tailwind CSS、本地图标集，以及 @comark/vue 所需高亮依赖。M3 再加 monaco-editor、@xterm/xterm 与 @xterm/addon-fit。其余依赖只在明确使用时添加；不重复引入 Element Plus、Ant Design Vue 或第二套聊天组件。

Nuxt UI 将 ai 声明为可选 peer，但聊天组件的公开声明引用其类型。M1 须在干净安装下核对 vue-tsc；若类型解析要求安装 ai，固定版本并仅在 renderer 适配层使用类型，不调用它的运行时请求 API，也不据此引入 @ai-sdk/vue 或 Provider 适配器。Nuxt UI 自带依赖较多，验收同时记录安装体积、Renderer 产物与启动开销，不能只按使用的组件数量估计成本。

具体版本在落地时核实 API 并固定到精确版本，内部 Pi 包沿用仓库版本策略。Nuxt UI、Comark、Shiki、Monaco 和 xterm.js 的主项目采用 MIT；复制代码、图标和传递依赖分别核对许可，保留所需声明。默认 npm install --ignore-scripts，依赖与锁文件一起审查；Electron 下载、PTY 编译等生命周期脚本按仓库规则另行处理。

已提供 dev、dev:server、build、start、check、check:e2e 和 check:workflows 脚本。main/preload 输出 CJS；SDK 宿主由 esbuild 独立输出 ESM，避免改写 import.meta.resolve。Node、Vue 和测试分别检查类型；check:types 先用官方 Vite 配置钩子生成主题声明，移走生成目录后已验证可重新生成。根检查调用 GUI 自身检查，并从根 tsconfig 排除 GUI，让它使用对应环境配置。生产编译与 Windows 打包目录已通过离线工作流验收；当前未把安装器构建等同于安装或升级通过。

Vue 组件不得直接导入 coding-agent、Node 或 Electron 运行时代码；domain 与 shared 不导入 .vue、Electron 或第三方 UI 类型。依赖边界检查同时覆盖基础组件库和聊天类型，保持核心会话语义独立。

**8. 实施顺序与交付门槛**

```text
┌────────────────────┬──────────────────────────────────────────┬────────────────────────────────────┐
│ 阶段               │ 交付                                     │ 通过条件                           │
├────────────────────┼──────────────────────────────────────────┼────────────────────────────────────┤
│ M0 包与方案        │ 当前工作区与本文                         │ npm 识别工作区，方案可追溯         │
│ M1 最小闭环        │ 窗口、项目、认证、宿主与基本聊天         │ 离线模型完成发送、流式与停止       │
│ M2 日常使用        │ 模型、队列、附件、历史与扩展弹窗         │ 切换会话和重启不丢历史             │
│ M3 工程面板        │ 文件差异、行评论、Git 与终端             │ 改动可核对，终端可独立使用         │
│ M4 高级工作流      │ 工作树、资源管理、计划与定时任务         │ 并行隔离与故障恢复可验证           │
│ M5 分发验收        │ 安装包、环境诊断、升级与清理             │ Windows 干净环境可完成任务         │
└────────────────────┴──────────────────────────────────────────┴────────────────────────────────────┘
```

阶段按依赖推进，不以页面数量计算完成。每个阶段必须能运行完整用户路径；界面上的入口必须有真实后端结果，未交付能力不摆放可点击的空按钮。

**M1：先贯通一个真实会话**

1. 建立 Electron、preload、Vue 3 与 utilityProcess 开发入口；接入 Nuxt UI、聊天展示与受限 Markdown，用 FakeAgentPort 验证主题、中文输入、流式滚动和离线资源；落实进程退出和日志路径。
2. 先定义无框架依赖的 AgentPort 和命令/事件 schema，用 FakeAgentPort 验证 Controller；再实现 SDK 宿主、Electron 传输、项目选择和基础 API Key 认证。
3. 接入离线 faux provider，对照 TUI 的 AgentSessionEvent 轨迹验证发送、流式消息、工具往返、取消和再次发送，并验证提交确认不误当运行完成。
4. 验证 GUI 重载仍能看到在途会话，应用重启能恢复落盘历史。
5. 在仓库之外的目录启动，验证中文路径、Git Bash、fd、rg 和模型未配置时的诊断。
6. 验证 utilityProcess、SDK、原生依赖与 WASM 的分发路径；AgentHost 在没有全局 node/pi 的干净环境中也应能启动。

**M2：形成日常可用版本**

补齐侧边栏、历史搜索、重命名、置顶归档、模型与思考等级、队列、文件引用、图片、消息复制、会话分支、扩展对话框和 OAuth。优先复用 Nuxt UI 菜单、Tree、Modal 与虚拟列表，文件搜索和扩展回复仍走宿主。跑通“打开项目 → 选择模型 → 提交任务 → 查看工具 → 恢复会话”全流程。

已交付历史与草稿阶段：受限历史端口、SDK 摘要适配、可测试的 WorkspaceService、独立原子草稿存储和侧栏菜单。队列阶段补上 SDK 两类队列、写前记录、停止与中断恢复。复制阶段复用消息原文与 Comark AST，提供正文和代码复制、反馈与重试，超长片段不伪装成全文。分支阶段复用 SDK 原生父链与分支文件，补充来源、独立草稿、失败回退和旧代次校验。文件引用阶段接通原生选择、真实路径归属、引用草稿与恢复；搜索阶段复用 CommandPalette，补上有界扫描、逐层忽略规则、取消、键盘选择、选后重验与原生回退；行内补全保留 ChatPrompt，增加有界片段替换、候选优先级和键位配置。图片阶段接通有界 PNG / JPEG 选择、粘贴与拖放，复用独立内容存储、图片草稿、SDK 发送和历史预览；图片队列保留附件身份并支持中断恢复。132 项 GUI 聚焦测试、SDK 模式缓存回归与 Electron 用户路径通过，覆盖原有会话链路、行内补全与旧草稿、文件搜索与失效候选、图片存储损坏、模型能力、原图删除、事件文件整批拒绝、预览读取次数和故障恢复。OAuth 复用 Pi 注册表与 AuthStorage，覆盖登录选择、设备码、浏览器、手工输入、取消和退出，凭据不进入展示协议。扩展 UI 复用同一有界请求服务，支持重载恢复、超时和取消；会话切换先询问来源扩展。打包宿主使用 SDK 的显式虚拟模块模式，保留原有发现与信任规则。终端专有组件、扩展发起会话替换和资源管理不在 M2 范围。

**M3：核对并处理工程结果**

先用 Monaco 完成只读文件与仓库差异，再做行评论反馈、暂存与还原。用 xterm.js 接入独立 PTY 终端。每种修改 Git 状态的操作都验证旧视图、部分失败、重命名、二进制和同文件 staged/unstaged 并存，同时检查关闭面板后释放编辑器、worker 相关资源与终端订阅。

已交付：`GitService` 读取分支、ahead/behind、staged/unstaged、未跟踪、重命名与二进制状态；只读版本差异使用 Monaco DiffEditor，按活动工作区校验路径并限制 1.5 MiB。暂存、取消暂存、还原提交前校验 HEAD、状态、索引对象与工作区内容摘要，文件正文改变但状态未变也会拒绝旧视图；未跟踪文件可暂存。差异读取前后核对版本，拒绝混合快照。行评论绑定左右侧、行号、暂存范围、原路径和版本，发回草稿前再次核对。xterm.js 接入 `node-pty` 独立 shell，终端拥有独立生命周期、尺寸同步和关闭回收。真实打包程序已验证 PTY 往返、停止 Agent 后终端仍可用，以及退出后 Electron 报告的子进程回收；hunk 操作与提交/推送尚未提供。

**M4：扩展到持续工作**

按工作树隔离、资源与扩展管理、计划契约、并行会话调度、定时任务的顺序推进。先解决生命周期与恢复，再增加入口。任何后台自动运行都必须有持久化记录、失败状态与明确的关闭后行为。

已交付工作树：WorktreeService 使用 `git worktree` 读取/创建/移除，创建时检查分支占用和显式起点，移除前核对 HEAD、未提交改动与忽略文件，且不删除分支。工程页可列出工作树；打开未登记的工作树时先验证其属于当前仓库，再关联项目和独立会话。失败保留原活动会话，不再追加重复的新建动作。会话 fork 与 Git 工作树仍是两个独立动作，未提供自动清理或 Handoff。

已交付资源管理第一段：宿主从 SDK 资源加载器汇总扩展、技能、提示模板、已注册命令和诊断，经有界 schema 放入会话快照；侧栏「插件」打开只读资源面板，按类型展示来源、作用域、路径、能力计数和加载失败信息。尚未提供启用/禁用、重载资源或扩展配置编辑。

已交付计划契约与恢复：输入区可切换到计划模式，宿主实际把活动工具限制为 `read`、`grep`、`find`、`ls` 后再请求分析；模型输出进入待确认计划，界面允许修改文本并「保存修改」，再批准或拒绝。PlanJournal 按会话原子保存计划和原工具集合，生成或执行前先落盘。重启恢复待确认文本和只读限制；生成中或执行中转为中断，不自动重放。批准先持久化执行状态，再恢复原工具集合并请求执行；取消或模型错误保留中断状态，不标记成功。再次批准可能重复已有改动，界面提示先核对历史。长批准命令不受普通查询的十秒超时限制。

已交付隔离并行任务：每个任务从来源仓库 HEAD 创建独立工作树与 `codex/task-<id>` 分支，再启动独立会话进程；不带入来源目录未提交内容。准备失败即记录失败，不回退共享目录。最多两个任务同时运行，取消后宿主关闭完毕才释放名额；超出任务持久化排队。检查最终助手结果与错误后才记录完成，按实际工作树路径打开原生会话。任务记录原子保存，损坏文件保留且拒绝覆盖；重启后运行中或排队任务标记为中断，不自动重放。工作树与分支保留供核对，不自动合并或清理。

已交付本地定时任务：任务按分钟间隔循环，记录下次运行时间、暂停状态和最近运行/失败结果；应用关闭或休眠时按 catchUp 策略补跑一次或跳到下次。任务复用隔离后台队列；任务与运行记录原子保存，启动前先推进并落盘下次时间，配合运行中任务去重。损坏文件不覆盖，活动运行不因历史裁剪丢失；未完成任务重启后标记中断，不自动重放。完成后通过系统通知提示，任务和失败结果在侧栏自动化面板查看。

**M5：交付安装包**

验证 Windows 安装、首次运行、路径含空格和中文、缺少 Git Bash、工具下载失败、证书或代理失败、升级保留认证与历史，以及退出不遗留受管进程。首个安装包通过后，再验证 macOS 和 Linux。

已通过生产编译与 Windows 打包目录验收。候选程序复制到仓库外中文空格路径，应用 PATH 移除全局 Node/Pi，使用独立数据和本机 SSE 驱动真实 SDK。9 项用户路径通过：旧包历史/认证/中文草稿恢复、旧 diff 拒绝、工作树打开、计划编辑与重启后批准、隔离后台写入、模型失败、定时失败、PTY 独立使用、退出子进程回收。更新服务离线测试覆盖开发模式、网络/证书失败重试、下载后等待用户安装和安装前等待关闭。当前测试包使用无效离线凭据，不是可发布版本；未在用户应用上安装或升级。

剩余门槛：干净 Windows 安装/卸载与安装器升级、缺失 Git Bash 和工具下载失败的桌面诊断、正式签名与 HTTPS 更新源、人工输入法/剪贴板/拖放，以及千条消息和大输出压力验收。资源管理后半段、命令菜单、用量统计和 Git 细粒度操作仍属于未交付功能。M5 与完整产品目标均不能标记全部完成。

**9. 验证方案**

- 契约：命令关联、事件序号、进程代次、不可序列化负载、未知事件、失败响应、取消、请求超时和宿主退出。
- 解耦：同一组会话事件输入纯投影器与 TUI 对照断言；内存 AgentPort 和 Electron 适配器遵守同一契约。Controller 测试不启动 Electron，Vue 测试不调用模型。
- 边界：Renderer 不导入后端运行时；domain/shared 不依赖 Vue 或 Electron；工具快照在跨进程发送前冻结或复制。
- 状态：接受不等于完成、`agent_end` 后重试、压缩后续跑、队列继续、扩展弹窗取消，以及取消后不误报成功。
- 展示：多个交错工具、累计输出不重复、最终消息不重复、用户向上滚动不被抢回底部、大输出受控渲染。
- 持久化：GUI 重载、Agent 崩溃、应用重启、同会话重复打开、外部修改检测和目录已删除。
- 桌面：中文输入法、键盘导航、焦点恢复、深浅主题、1280 × 800 与高 DPI，以及中文文件名和空格路径。
- 组件易用性：中文组词 Enter 不发送、补全菜单 Enter 只选项、Shift+Enter 换行、失败保留草稿、弹窗关闭后恢复焦点；拖动分栏、切换主题与复制代码正常。
- 组件性能：固定回放千条消息、5 MB 累计工具输出与每秒 30 次进度更新，记录主线程耗时、内存与 DOM 数量；输入和停止保持可用，向上阅读不跳动。重复切换会话与面板后，订阅、编辑器模型和内存不持续增长。
- 组件边界：断网时图标、高亮、worker 与主题完整；未闭合代码块可流式展示；HTML、组件语法和危险链接不能触发桌面能力；干净安装可通过 GUI 类型检查，不依赖本机生成文件或 AI SDK transport。
- 工程：Git 非仓库、空仓库、改名、未跟踪文件、staged/unstaged 并存、旧 diff 操作拒绝和 PTY 进程退出。
- Electron E2E 默认使用离线 Agent 或固定事件回放；不依赖真实 API Key，不消耗付费模型 token。
- coding-agent 的提交确认或宿主契约若有变化，在其 suite 中用现有 harness 与 faux provider 增加聚焦回归；GUI 自己维护投影、UIContext 和桌面服务测试。
- 有源代码变更后按仓库要求运行 `npm run check`；只运行新增或修改的聚焦测试，完整构建与全量测试依照仓库约束开展。

2026-10-23，35 个 GUI 测试文件、187 个用例，以及 GUI 架构、格式和四组类型检查通过；全仓检查在课程代码的既有 2 个 lint 错误、3 个警告处停止。已验证源码开发入口、生产编译、Windows 打包目录和真实 Electron 离线路径，最新报告为 `artifacts/workflows-1792726056199/results.json`。验收使用本机 OpenAI 兼容 SSE 替身驱动真实 SDK 与工具，不调用真实服务商。中文输入、图片粘贴和拖放只测试合成事件；干净机器、安装器升级、人工 Windows 输入法、系统剪贴板、资源管理器拖放与压力验收仍未通过。详细范围见 ARCHITECTURE.md。

**10. 参考依据**

**OpenAI 官方文档**

- [桌面应用](https://learn.chatgpt.com/docs/app)：桌面工作区、项目与文件入口。
- [项目与聊天](https://learn.chatgpt.com/docs/projects)：项目、聊天、搜索、置顶与归档。
- [工程工作流说明](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)：队列、引导、附件与审查反馈；该文面向远程端，本文只取跨端工作流概念。
- [本地、工作树与云端环境](https://learn.chatgpt.com/docs/environments/modes)：执行位置及边界。
- [代码审查](https://learn.chatgpt.com/docs/code-review?surface=app)：差异范围、行评论和暂存操作。
- [集成终端](https://learn.chatgpt.com/docs/integrated-terminal)：项目或工作树内终端。
- [工作树](https://learn.chatgpt.com/docs/environments/git-worktrees)：独立工作目录与生命周期。
- [定时任务](https://learn.chatgpt.com/docs/automations)：本地调度和应用运行条件。

**前端组件官方依据**

- [Nuxt UI 的 Vue / Vite 接入](https://ui.nuxt.com/docs/getting-started/installation/vue)：无需 Nuxt 服务端的安装方式与声明生成要求。
- [聊天组件](https://ui.nuxt.com/docs/components/chat)：消息、输入、工具与推理展示；只采用展示层，不沿用示例请求链路。
- [ChatPrompt 源码](https://github.com/nuxt/ui/blob/v4/src/runtime/components/ChatPrompt.vue)：submit 事件、body 插槽与组合输入保护。
- [Splitter](https://ui.nuxt.com/docs/components/splitter) 与 [ScrollArea](https://ui.nuxt.com/docs/components/scroll-area)：分栏、折叠与列表虚拟化。
- [Vue 图标打包](https://ui.nuxt.com/docs/getting-started/integrations/icons/vue)：本地图标数据与 clientBundle；避免运行时在线请求。
- [Nuxt UI 包声明](https://github.com/nuxt/ui/blob/v4/package.json)：MIT、依赖规模与 ai 可选 peer。
- [shadcn-vue AI Elements](https://www.shadcn-vue.com/docs/ai-elements)：备选的源码复制模式与组件组合。
- [Comark Vue 渲染](https://comark.dev/rendering/vue)、[默认插件控制](https://comark.dev/plugins) 与 [安全插件](https://comark.dev/plugins/built-in/security)：流式内容、Suspense、限制语法与链接。
- [Monaco 官方仓库](https://github.com/microsoft/monaco-editor)：ESM、公共类型与 model/editor 资源释放。
- [xterm.js 官方文档](https://xtermjs.org/docs/)：浏览器终端与后端 PTY 的分工。
- [Comark 许可](https://github.com/comarkdown/comark/blob/main/LICENSE)、[Shiki 许可](https://github.com/shikijs/shiki/blob/main/LICENSE) 与 [xterm.js 许可](https://github.com/xtermjs/xterm.js/blob/master/LICENSE)：打包与复制时保留相应声明。

**仓库依据**

- [TUI 组件边界](../tui/src/tui.ts)：输入、组件和终端渲染。
- [TUI 编辑器](../tui/src/editor-component.ts)：提交与编辑回调。
- [InteractiveMode](../coding-agent/src/modes/interactive/interactive-mode.ts)：输入分派、会话订阅与事件展示。
- [AgentSession](../coding-agent/src/core/agent-session.ts)：现有命令与 AgentSessionEvent。
- [SDK 文档](../coding-agent/docs/sdk.md)：会话、模型、认证与资源接入。
- [会话运行时](../coding-agent/src/core/agent-session-runtime.ts)：会话更换与资源生命周期。
- [认证存储](../coding-agent/src/core/auth-storage.ts)：凭据保存和 OAuth。
- [会话管理](../coding-agent/src/core/session-manager.ts)：会话索引与持久化。
