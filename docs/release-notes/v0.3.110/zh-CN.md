关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 新增

- **ACP 工具调用往返**：函数工具现在通过内置的带鉴权 MCP 适配器交给官方 CLI，Chat Completions 与 Responses 客户端可以收到 `tool_calls`、执行后把结果送回同一次执行。支持流式返回；等待中的调用会保留其 CLI 进程并在十分钟后过期，已完成的调用 ID 不会被重复投递。用户无需安装任何 MCP 服务。

## 改进

- **ACP 客户端兼容性**：空或 null 的 `tools`、无工具时的 `tool_choice` auto，以及明确指定的 `tool_choice: none` 都可以正常接受。常见客户端字段 `n: 1`、`store: false`、`response_format` 文本、`parallel_tool_calls`、`user`、`metadata`、`prompt_cache_key` 与 `safety_identifier` 会被校验并接受。`max_tokens`、`max_completion_tokens`、`temperature` 与 `top_p` 作为兼容参数接收，CLI 无法应用的非空取值会写入响应头 `x-ecpa-ignored-parameters`，不再直接拒绝请求。
- **ACP 系统指令传递**：system 与 developer 指令改为通过 CLI 声明的系统提示追加能力或官方 Antigravity 扩展单独传递，保留 Agent 自身的默认提示，不再被合并进用户消息。CLI 若不具备这两种能力，在存在指令时会返回明确的「需要更新」错误。
- **ACP API 的启动与关闭**：API 卡片改为明确的启动/关闭开关，状态区分已关闭、启动中、已启动等待连接和已启动。接入已开启时关闭随时可用，账号断开或模型为空也不影响关闭；启动需要账号已连接，并在卡片内直接说明缺少的前提。出错时在卡片内提示，开关回到可操作状态。

## 修复

- **ACP API 接入此前无法可靠关闭**：现在默认关闭，登录、刷新、切换账号或重启应用都不会再表现为自动开启。关闭会原子写入关闭意图、清理等待中的工具会话与监听器，并从旧版和 v8 两种配置布局中移除托管的 provider。关闭是幂等的并且失败即关闭，清理出错也不会留下残留接入在下次启动时重新生效。
