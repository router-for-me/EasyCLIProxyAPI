<p align="center">
  <a href="README.md">English</a> |
  <strong>简体中文</strong> |
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="src/assets/logo.jpg" width="112" alt="EasyCLIProxyAPI Logo">
</p>

<h1 align="center">EasyCLIProxyAPI</h1>

<p align="center">
  CLIProxyAPI 的便携桌面控制台。<br>
  我们的目标是实现 token free（free 在这里的意思是自由）。
</p>

## 项目简介

EasyCLIProxyAPI 是基于 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
构建的图形化桌面管理工具。它将内核生命周期管理、OAuth 授权、API Provider 聚合、协议转换、
凭证管理、配额查询、使用记录、模型别名和智能体客户端配置集中到一个界面中。

软件基于 Tauri、React 和 Rust 构建，并可携带匹配版本的 CLIProxyAPI 内核压缩包，
让首次安装和离线安装更加方便。

## 赞助商

[![https://go.apimart.ai/gh-easycliproxyapi](./assets/apimart-zh.png)](https://go.apimart.ai/gh-easycliproxyapi)

感谢 APIMart 对本项目的赞助！

APIMart 是一个低成本的 AI 图像与视频生成 API 平台——GPT-Image-2 每张图片低至 0.006 美元，1 美元可生成 160 多张图片。一个异步 API 即可处理图像和视频：提交任务、获取任务 ID，再通过轮询或回调获取结果。无需担心超时，即可批量生成数万张图片；切换模型也无需修改代码。按量付费，无月费——[立即注册](https://go.apimart.ai/gh-easycliproxyapi)即可开始使用。

## 功能导览

### 首页与本地 API 地址

![首页与本地 API 地址](docs/screenshots/zh-CN/1.png)

首页集中展示本地代理服务的运行情况，并提供常用的本地 API 地址：

- 启动、关闭、重启和刷新 CLIProxyAPI 内核状态。
- 查看安装状态、运行状态、进程 PID、内核版本和软件版本。
- 复制可直接使用的 OpenAI、Claude 和 Gemini 兼容 API 地址。
- 查看本地连接状态。

内核安装、版本对比和离线安装功能位于 **版本管理** 页面；可在此切换 GitHub 官方源、GitCode 国内源或 GitHub 镜像代理，也可以添加自定义 HTTPS 镜像前缀。软件与内核更新会优先使用所选渠道，并在失败时自动回退。

### OAuth 账号授权

![OAuth 账号授权](docs/screenshots/zh-CN/2.png)

OAuth 页面集中管理支持的浏览器授权登录：

- Codex OAuth
- Claude OAuth
- Antigravity OAuth
- Kimi OAuth
- xAI OAuth

EasyCLIProxyAPI 会自动打开浏览器授权页面；当浏览器无法自动跳转回来时，也支持手动完成回调流程。

### API 接入与 Provider 聚合

![API 接入与 Provider 聚合](docs/screenshots/zh-CN/3.png)

API 接入页面按照协议或 Provider 管理上游 API 凭证和服务地址：

- Codex
- OpenAI 兼容 Provider
- DeepSeek
- Claude
- Gemini

你可以添加多个接入配置、搜索已有配置、刷新 Provider 状态并执行健康检测，
然后通过统一的本地 CLIProxyAPI 地址调用它们。请求和响应可以在 OpenAI、Claude、Gemini
及其他兼容协议之间转换。

### 使用记录与 Token 统计

![使用记录与 Token 统计](docs/screenshots/zh-CN/4.png)

使用记录页面帮助你了解本地请求活动和 Token 消耗情况：

- 查看请求总数、Token 总量、成功率、TPS、缓存命中率和预估成本。
- 按时间、模型、Provider、来源、密钥和结果筛选数据。
- 查看请求与 Token 趋势，以及输入、输出、思考和缓存用量构成。
- 浏览请求明细、分析视图和价格统计。
- 通过 CPA 实时订阅和本地持久化 inbox 采集记录，订阅不可用时自动降级到 HTTP。
- 启动时一次性迁移旧版使用记录数据库，并在 `usage-records/backups` 下保留迁移前备份。

### 智能体客户端配置

![智能体客户端配置](docs/screenshots/zh-CN/5.png)

智能体页面会检测本机已安装的桌面端和命令行客户端，并帮助它们连接本地代理。支持的客户端包括：

- Claude Code
- Claude Desktop
- Codex
- OpenCode
- OpenClaw
- Hermes Agent
- Pi（通过 CLIProxyAPI provider 插件）
- ZCode
- Kimi Code
- Grok Build

对于受支持的客户端，软件可以同步可用模型目录、选择默认模型、在应用托管配置前备份原始配置，
以及恢复之前的配置。

## 其他功能

- 管理内核配置、API Key、远程管理凭证和路由策略。
- 创建客户端可见的模型别名，并映射到 Provider 模型和推理等级。
- 上传、下载、检查和管理认证文件。
- 查看 Provider 配额和账号可用状态。
- 通过 macOS 菜单栏或 Windows 系统托盘保持软件在后台运行。

## 快速开始

1. 前往 [GitHub Releases](https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest)
   下载对应操作系统的发行包。
2. 解压 Windows 或 Linux 压缩包，macOS 用户打开 DMG。
3. 启动 EasyCLIProxyAPI。
4. 打开 **版本管理** 页面，安装内置版本或最新版本的 CLIProxyAPI 内核。
5. 返回 **首页** 启动内核，然后复制所需的本地 API 地址，或配置 OAuth/API Provider。

## 升级

每个 Windows 版本都会同时发布完整 ZIP 和兼容旧客户端的 `update` ZIP。这样尚未及时迁移的旧客户端仍可使用应用内更新；新版客户端则使用完整包，同时更新内置 core。

当前 Windows、Linux 和 macOS 发行包都支持应用内自动升级。Linux 会替换便携版程序文件并保留运行数据；macOS 会整体替换已签名的应用包。各平台都会等待新版完成启动确认，启动失败时自动回滚。安装目录必须允许当前用户写入。

现有 Linux 和 macOS 安装需要先手动升级一次，安装带有跨平台自动更新标识的版本；成功启动该版本后，后续即可使用应用内自动升级。

如果当前版本是 v0.2.5 或更早版本，请执行一次手动迁移：退出 EasyCLIProxyAPI，下载最新版对应架构的完整 Windows ZIP，将 ZIP 顶层目录内的内容复制到现有安装目录并覆盖同名文件。不要先删除现有安装目录；`config.toml`、`oauth` 和 `cpa-core/config.yaml` 等用户数据会被保留。启动新版后，后续版本即可继续使用应用内自动升级。

## 支持的平台

GitHub Actions 会构建以下发行包：

| 操作系统 | 架构 | 格式 |
| --- | --- | --- |
| Windows | amd64、aarch64 | ZIP |
| macOS | amd64、aarch64 | DMG |
| Linux | amd64、aarch64 | TAR.GZ |

## 相关项目

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — 本软件负责管理的代理内核。
- [WebBrain](https://github.com/webbrain-one/webbrain) — 可连接 EasyCLIProxyAPI 本地 OpenAI 兼容端点的浏览器智能体。请参阅[设置、安全与账号风险指南](https://webbrain.one/docs/zh/easy-cli-proxy/)。
