- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 新增

- **ACP 接入（Antigravity）**：OAuth 页面新增「ACP 接入」标签页，可用 Google 官方授权登录 Antigravity CLI，并保存多个账号按需切换，账号共用同一份 CLI、登录状态分别保存。连接后可发送一条测试消息验证模型，启用 API 后账号下的模型会以 `acp/<模型ID>` 注册成保留的 OpenAI 兼容 provider，用现有的 CPA 地址和密钥即可调用。该标签页也提供 CLI 检测与安装入口、当前账号身份和连接详情。
- **ACP 的思考等级**：请求里的 `reasoning_effort`、`reasoning.effort` 或 `thinking.effort` 会被解析到官方模型对应的等级变体，等级从官方模型 ID 后缀识别。未声明等级、等级不存在或取值冲突时返回明确错误，不会静默忽略。ACP provider 不会自动写入思考等级声明，等级仍需按 CPA 的常规方式手动配置。
- **ACP 的多轮对话**：桥接现在接受 `system`、`user`、`assistant` 消息，历史会按 `System:` / `User:` / `Assistant:` 合并进单次提示（官方 CLI 每次请求使用独立会话），最后一条必须是用户消息。单条用户消息保持原样直传，不受影响。

## 改进

- **ACP 卡片布局**：接入页的两张卡片改为等高排列，未连接时用图标加说明的紧凑锁定态，去掉了框内套框的虚线。已连接或 API 已启用时，卡片标题图标转为成功色，鼠标悬停有轻微阴影反馈，窄屏下按钮自动换行。

## 修复

- **健康检查的探针预算**：探测请求的预算上调，并把「生成额度已用尽」作为一种独立原因上报，不再与其它失败混在一起。
- **Gemini Interactions 的新事件名**：健康检查此前只识别旧版 `content.delta` / `interaction.complete` 并只从 `interaction.outputs` 取文本，使用 `step.delta` / `interaction.completed` / `steps` 的合法流会被误判为缺少首字。现在两代事件名都支持，完成文本从 `steps` 或 `outputs` 读取，缺少状态视为成功，失败和取消状态明确拒绝。
- **模型别名同步遇到多词键**：别名与智能体的 YAML 更新此前经由 `yaml_serde_edit`，其传递依赖的解析器会在未加引号的多词键处截断映射，导致一键连接时合法修改被判定为兼容性检查失败。现在所有相关路径改用 `serde_norway` 解析与 `yaml-edit` 渲染，多词键的别名同步恢复正常。
