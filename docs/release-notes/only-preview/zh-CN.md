- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 修复

- **OpenCode 客户端图片与附件粘贴支持**：为 OpenCode 配置文件中生成的自定义 provider 模型声明 `attachment` 与 `modalities` 字段。针对多模态模型提供 `text`、`image` 和 `pdf` 输入支持，针对图像生成模型声明包含 `image` 的输出能力，修复因 custom provider 缺失模型元数据导致客户端拦截图片粘贴及附件上传的问题（#567）。
