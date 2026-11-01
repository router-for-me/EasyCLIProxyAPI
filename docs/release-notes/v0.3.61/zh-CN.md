- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 新增

- 智能体鉴权 API Key 独立选择与持久化：支持为每个智能体配置单独选择鉴权 API Key，支持自动回退至有效默认 Key，并包含全语言国际化（[#544](https://github.com/router-for-me/EasyCLIProxyAPI/pull/544), [#545](https://github.com/router-for-me/EasyCLIProxyAPI/pull/545)）。
- ZCode 智能体模型目录与子代理设置：新增 ZCode 模型目录选择对话框与子代理（Sub-agent）配置面板，支持多档推理等级（reasoning levels）及 Spark 1M 上下文规格。

## 修复

- Windows 环境 CLI 启动修复：修复 Windows 下启动全局 npm 安装的 CLI shims 失败或崩溃的问题。
- Claude Desktop 别名匹配与路由修复：修复当特定 Provider 别名被禁用或过滤时，未正确回退至主模型的问题。
- ZCode 配置持久化与规范性修复：确保 `maxOutputTokens` 严格符合 Zod schema，修复模型目录选择、Token 限制继承及配置保存时的借用与状态同步问题。
- 界面布局与交互优化：优化 ZCode 子代理对话框布局、侧边栏滚动条体验，并在保存模型目录配置后自动关闭对话框。
