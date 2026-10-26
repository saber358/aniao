# Aniao Harness

Aniao Harness 是一个把对话、文件、终端、浏览器和任务过程放进同一张工作台的桌面 Agent 应用。它使用 Pi 作为 Agent 内核，提供面向 Windows 的桌面界面，并把模型调用、工具执行、会话历史和项目文件组织在一个窗口中。

> 这是基于 Pi 的独立桌面项目，不是 Pi 官方项目。

## 下载

Windows x64 安装包：

```text
http://117.72.245.101/downloads/Aniao-Harness-Setup-0.80.18.exe
```

SHA-256：

```text
4123d265c27bcb708ada8357383668c2f5b5fec4495f2cb709a69fb55b30db93
```

应用内支持检查更新；`0.80.9` 及之后的版本会先获取更新元数据，点击下载后才获取完整安装包。

## 主要能力

- **桌面工作台**：会话列表、项目管理、任务队列和独立的右侧工具面板。
- **Pi Agent 内核**：工具调用、扩展、技能、Prompt 模板、计划模式和会话压缩。
- **过程可见**：完成轮次折叠为“已工作”时间线，展开后查看思考、工具调用和中间回答。
- **文件引用**：输入 `@` 浏览文件和文件夹，`Enter` 引用，`Tab` 进入目录；引用以行内 chip 显示，支持退格整块删除。
- **命令菜单**：输入 `/` 快速引用文件、切换计划模式、选择模型，或运行当前会话加载的技能和扩展命令。
- **文件与网页**：新建和编辑文件卡片、文本/Office/PDF/图片预览，以及右侧内置浏览器。
- **插件管理**：浏览精选 Pi 社区插件，通过 npm、Git 或本地路径安装和移除；内置能力与当前会话加载状态集中查看。
- **多模型**：内置模型目录、自定义 Provider、模型能力配置和上下文用量显示。
- **并行与自动化**：后台任务、并行任务、独立工作树和定时任务记录。

## 从源码运行

环境要求：Node.js 22 或更高版本、npm，以及 Windows 桌面环境。

```bash
npm install --ignore-scripts
npm run dev --workspace @earendil-works/pi-gui
```

构建 Windows 安装包：

```bash
npm run package:win --workspace @earendil-works/pi-gui
```

构建产物位于 `packages/gui/release/`。

## 检查

```bash
npm run check
```

该命令执行 Biome、依赖锁定检查、架构边界检查、TypeScript 类型检查和浏览器冒烟测试。

针对单独测试文件：

```bash
cd packages/gui
node ../../node_modules/vitest/dist/cli.js --run test/renderer/file-completion.test.ts
```

## 仓库结构

| 路径 | 说明 |
|------|------|
| `packages/gui` | Electron + Vue 桌面客户端，包含主进程、宿主进程、渲染器和侧边面板 |
| `packages/coding-agent` | Pi 编码 Agent、工具、扩展加载和会话运行时 |
| `packages/agent` | Agent 运行时和工具调用状态管理 |
| `packages/ai` | 多 Provider 模型 API |
| `packages/tui` | Pi 终端界面 |
| `packages/orchestrator` | 任务编排与并行执行 |
| `packages/coding-agent/examples` | 扩展、技能和主题示例 |

## 技术栈

- Electron 44
- Vue 3 + Vite
- TypeScript
- Nuxt UI
- Pi SDK 1.4.0
- Zod IPC 协议
- xterm.js、Monaco Editor、Playwright 冒烟测试

## 安全说明

Aniao Harness 和 Pi 默认以当前用户权限运行，不是安全沙箱。扩展、技能和工具可以执行系统命令并访问项目文件；只安装可信来源的扩展，并在处理敏感项目时使用独立的系统账户、虚拟机或容器。

## 上游与许可

桌面界面和 Aniao 相关改动位于本仓库。Agent 内核来自 [Pi](https://github.com/earendil-works/pi)，遵循 MIT License；原始版权归 Mario Zechner 及 Pi 贡献者所有。本仓库保留上游 `LICENSE` 和归属信息。

本项目使用 MIT License，详见 [LICENSE](LICENSE)。

## 链接

- 产品站点：http://117.72.245.101/
- 源码：https://github.com/saber358/aniao
- Pi 项目：https://pi.dev
- Pi 文档：https://pi.dev/docs/latest
