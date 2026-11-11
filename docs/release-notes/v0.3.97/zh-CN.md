- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 修复

- **macOS 更新助手不再被误杀**：在 macOS 上退出应用触发更新时，更新助手会运行在独立的进程组中，不再随界面进程一起被系统清理，更新能完整走完并正常重启。
- **macOS 仅更新应用时保留内核**：只有应用本体需要更新时，正在运行的内核进程不再被一并结束，更新完成后继续使用原内核；正常退出应用时的内核关闭行为保持不变。
