<p align="center">
  <a href="README.md">English</a> |
  <strong>简体中文</strong> |
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="src/assets/logo.jpg" width="112" alt="Easy_CLIProxyAPI Logo">
</p>

<h1 align="center">Easy_CLIProxyAPI</h1>

<p align="center">
  我们的目标是实现 token free（free 在这里的意思是自由）。<br>
</p>

> [!IMPORTANT]
> 当前仓库为正式版本，如需更为激进的实验性功能，请前往 [lzt404/Easy_CLIProxyAPI](https://github.com/lzt404/Easy_CLIProxyAPI)。

## 项目简介

Easy_CLIProxyAPI 是基于 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的便携工具，提供图形化界面管理内核、OAuth 账号、API 接入、模型路由、认证文件、配额查询、使用记录和智能体客户端配置。

软件基于 Tauri、React 和 Rust 构建。

## 主要功能

- OAuth 账号登录
  - 支持 Codex、Claude、Gemini 等账号登录

- API 聚合管理
  - 支持 OpenAI、Claude、Gemini 等协议的 API Key 接入

- API 格式互转
  - 支持 OpenAI、Claude、Gemini 等协议的请求和响应格式互转

- 智能体客户端配置
  - 自动配置 Claude Code、Claude Desktop、Codex、OpenCode、OpenClaw 和 Hermes Agent 等主流智能体客户端

## 支持的平台

当前 GitHub Actions 生成以下便携发行包：

| 系统 | 架构 |
| --- | --- |
| Windows | amd64、aarch64 |
| Linux | amd64、aarch64 |
