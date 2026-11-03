- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 修复

- **Agent 使用记录误报读取失败**：修复「Agent 使用记录」页面上方长期出现的黄色提示（如 `Copilot CLI: Unable to read local usage records`）。此前扫描 Copilot 目录时会把无关的配置文件一并纳入解析，任何一个文件无法解析就整源标记为失败；现在只读取 Copilot 的会话记录目录，且无法解析的历史文件不再视为同步错误，来源状态回落为空闲而不是报错，页面也不再显示该提示。
