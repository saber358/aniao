import { fileURLToPath } from "node:url";
import ui from "@nuxt/ui/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "electron-vite";
import { build as bundleHost } from "esbuild";
import { copyKernelRuntimeFiles } from "./config/kernel-build.ts";
import { workspaceAliases } from "./config/workspace-aliases.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const logger = console;

/*
 * ========================================================================
 * 步骤1：分离主进程、宿主、预加载与界面构建
 * ========================================================================
 * 数据源：工作区源码与本地图标。
 * 操作：
 *   1) 内部 SDK 随宿主打包，外部原生依赖保持外置
 *   2) 沙箱 preload 输出单个 CJS 文件，Renderer 不接入 Node
 */
export default defineConfig({
	main: {
		resolve: { alias: workspaceAliases },
		plugins: [
			{
				name: "pi:agent-host",
				// 1.1 宿主独立使用 ESM，保留 SDK 的 import.meta.resolve 与外部依赖语义。
				async closeBundle() {
					logger.info("开始准备独立 SDK 宿主");
					await bundleHost({
						entryPoints: {
							host: fileURLToPath(new URL("./src/host/index.ts", import.meta.url)),
							"session-data": fileURLToPath(new URL("./src/host/session-data-worker.ts", import.meta.url)),
						},
						outdir: fileURLToPath(new URL("./dist/main", import.meta.url)),
						outExtension: { ".js": ".mjs" },
						bundle: true,
						platform: "node",
						format: "esm",
						target: "node22",
						packages: "external",
						// 1.1 官方注册模块的副作用必须保留，避免打包后缺少服务商。
						ignoreAnnotations: true,
						// 1.2 使用官方虚拟模块，扩展不依赖安装包外部的 SDK 目录布局。
						define: { PI_BUNDLED_NODE: "true" },
						alias: Object.fromEntries(workspaceAliases.map(({ find, replacement }) => [find, replacement])),
					});
					await copyKernelRuntimeFiles(fileURLToPath(new URL("./dist/main", import.meta.url)));
					logger.info("独立 SDK 宿主准备完成");
				},
			},
		],
		build: {
			outDir: fileURLToPath(new URL("./dist/main", import.meta.url)),
			externalizeDeps: true,
			rolldownOptions: {
				external: ["@silvia-odwyer/photon-node", "@mariozechner/clipboard"],
				output: { format: "cjs", entryFileNames: "[name].cjs", chunkFileNames: "chunks/[name]-[hash].cjs" },
				input: {
					index: fileURLToPath(new URL("./src/main/index.ts", import.meta.url)),
				},
			},
		},
	},
	preload: {
		build: {
			outDir: fileURLToPath(new URL("./dist/preload", import.meta.url)),
			externalizeDeps: false,
			isolatedEntries: true,
			rolldownOptions: {
				input: {
					index: fileURLToPath(new URL("./src/preload/index.ts", import.meta.url)),
					startup: fileURLToPath(new URL("./src/preload/startup.ts", import.meta.url)),
				},
				output: { format: "cjs", entryFileNames: "[name].cjs" },
			},
		},
	},
	renderer: {
		root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
		plugins: [
			vue(),
			ui({
				root,
				router: false,
				autoImport: false,
				components: false,
				dts: false,
				ui: { colors: { primary: "emerald", neutral: "neutral" } },
				icon: {
					clientBundle: {
						icons: [
							"lucide:plus",
							"lucide:message-circle-plus",
							"lucide:panel-left",
							"lucide:panel-right",
							"lucide:minus",
							"lucide:puzzle",
							"lucide:clock",
							"lucide:folder-open",
							"lucide:server",
							"lucide:book-open",
							"lucide:settings-2",
							"lucide:settings",
							"lucide:download",
							"lucide:circle-question-mark",
							"lucide:chevron-down",
							"lucide:chevron-up",
							"lucide:file-diff",
							"lucide:chevron-right",
							"lucide:arrow-up",
							"lucide:square",
							"lucide:message-square",
							"lucide:terminal",
							"lucide:check",
							"lucide:brain",
							"lucide:trash-2",
							"lucide:circle-alert",
							"lucide:loader-circle",
							"lucide:x",
							"lucide:sun",
							"lucide:moon",
							"lucide:search",
							"lucide:ellipsis",
							"lucide:pencil",
							"lucide:pin",
							"lucide:archive",
							"lucide:refresh-cw",
							"lucide:copy",
							"lucide:git-branch",
							"lucide:file-plus-2",
							"lucide:paperclip",
							"lucide:list-checks",
							"lucide:cpu",
							"lucide:image-plus",
							"lucide:images",
							"lucide:folder",
							"lucide:sparkles",
							"lucide:file-text",
							"lucide:file-code",
							"lucide:table-2",
							"lucide:presentation",
							"lucide:image",
							"lucide:save",
							"lucide:wrench",
							"lucide:compass",
							"lucide:globe",
							// 1.3 浏览控件随包提供，离线时也能显示导航、连接与失败图标。
							"lucide:arrow-left",
							"lucide:arrow-right",
							"lucide:arrow-up-right",
							"lucide:rotate-cw",
							"lucide:external-link",
							"lucide:lock-keyhole",
							"lucide:wifi-off",
							"lucide:maximize-2",
							"lucide:minimize-2",
							"lucide:sliders-horizontal",
							"lucide:folder-plus",
							"lucide:user-round",
							"lucide:bot",
							"lucide:plus",
							"lucide:package",
							"lucide:plug",
							"lucide:store",
							"lucide:scan-search",
							"lucide:notebook-pen",
							"lucide:target",
							"lucide:chart-no-axes-combined",
							"lucide:chart-no-axes-column",
							"lucide:send",
							"lucide:code-xml",
						],
					},
				},
			}),
		],
		build: {
			outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)),
			emptyOutDir: true,
			rolldownOptions: {
				input: {
					index: fileURLToPath(new URL("./src/renderer/index.html", import.meta.url)),
					startup: fileURLToPath(new URL("./src/renderer/startup.html", import.meta.url)),
				},
			},
		},
	},
});
