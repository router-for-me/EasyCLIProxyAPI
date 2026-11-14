- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 修复

- **Codex CLI 查找**：Codex CLI 现在也会识别桌面应用内置的可执行文件，包括通过 Windows 商店/MSIX 安装的软件包、Windows 桌面版独立资源目录以及 macOS 应用包。
- **Codex CLI 选择**：候选项改为比较语义化版本，不再直接使用第一个可用的候选项，避免选中过期的重定位缓存。版本相同时优先选择搜索目录中的独立 CLI，其次是桌面应用内置版本，最后是旧版缓存。
- **正式版与预发布版排序**：仅在同一核心版本下正式版才优先于预发布版，因此核心版本更新的预发布版仍会优先于较旧的正式版。