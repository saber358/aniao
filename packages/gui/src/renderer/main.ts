import "./styles.css";
import ui from "@nuxt/ui/vue-plugin";
import { createApp } from "vue";
import { createLogger } from "../shared/logger.ts";
import App from "./App.vue";

const logger = createLogger("renderer-main");
/*
 * ========================================================================
 * 步骤1：挂载桌面界面
 * ========================================================================
 * 数据源：系统主题与本机界面偏好，不读取认证。
 * 操作：
 *   1) 在挂载前设置主题，避免首屏闪烁
 *   2) 注册单一组件体系，业务组合由 App 持有
 */
logger.info("开始挂载 Vue 界面");
// 1.1 仅外观偏好写入 localStorage。
const theme = localStorage.getItem("pi-gui-theme");
document.documentElement.classList.toggle(
	"dark",
	theme === "dark" || (!theme && matchMedia("(prefers-color-scheme: dark)").matches),
);
createApp(App).use(ui).mount("#app");
logger.info("Vue 界面挂载完成");
