# Aniao Harness 官方网站

线上地址：https://117.72.245.101/

静态官网，提供 Windows x64 `.exe` 与 Linux amd64 `.deb` 下载。源码位于 `public/`，后端反馈管理和桌面更新源保持独立。

视觉主线：浅色纸感与晴空色二次元插画，使用蓝色强调下载动作，品牌与产品界面保持清晰。

内容顺序：首屏主视觉与两个平台入口 → 真实工作台截图 → 多会话、工具与扩展能力 → 下载与安装说明 → 常见问题。

交互主线：首屏文字渐入、滚动内容轻量出现、下载按钮悬停反馈。下载和平台选择始终可用，开启减少动态效果时关闭动画。

页面使用本地资源，不引入运行时前端依赖。所有下载链接均指向已经核对过摘要的版本文件。Linux 只提供 Debian/Ubuntu 系 amd64 安装包，不提供 ARM 或 AppImage。

部署前先在本机浏览器核对 1440 px 桌面、390 px 手机和减少动态效果。上传页面资源及安装包到独立暂存目录，服务端校验 SHA-256 并备份现有首页后再切换入口。两个平台分别发布更新清单；旧版下载和管理页继续保留。

本地预览：`node services/aniao-website/scripts/serve.mjs`，访问 `http://127.0.0.1:4177`。浏览器验收：`node services/aniao-website/test/browser.mjs [官网地址]`。预览服务器只开放 public 和固定的两个安装包及校验文件。

发布：`python services/aniao-website/scripts/deploy.py --auth-helper <现有 SSH 连接模块>`。连接模块提供 `connect()`，认证信息不进入官网源码或发布清单。发布脚本把资源上传到独立暂存目录，服务端校验后先发布安装包，最后原子替换首页。备份保存在发布记录显示的服务器目录。

上线验收：`python services/aniao-website/scripts/verify-live.py --manifest <本次发布清单>`，然后用浏览器验收脚本检查 HTTPS 官网。完整下载两个安装包并比对 SHA-256，同时检查反馈管理认证、后端健康状态和更新清单。当前下载版本为 `0.80.23`，输入产物位于 `packages/gui/artifacts/publish-0.80.23-20261028/`。
