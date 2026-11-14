- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 改进

- **发布打包可靠性**：macOS 的 DMG 创建失败会自动重试，并且只卸载该镜像自身挂载的卷；Intel 版 macOS 改为在 Apple Silicon 构建机上交叉编译；Linux 使用 mold 链接；下载发布附件时，尚未上传完成的附件会重试，不再直接导致构建失败。

## 修复

- **插件商店样式**：插件 Logo 之后的样式不再脱离组件层，商店结果栏恢复应有的间距，样式表也不再产生语法错误。
