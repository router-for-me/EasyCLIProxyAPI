# ACP 与 OpenAI 协议接入评审

评审日期：2026-11-17。代码基线：`dev` 的 `a0fa48e5`；本机官方 Antigravity CLI `1.4.12`，CPA 内核 `8.0.63`。本文件记录验证结果和实现边界，不代表通用工具调用已经实现。

## 后续修复与验收（2026-11-17）

本分支已实现内部 MCP 工具传输与等待状态。它不要求用户安装 MCP，也不会取消 ACP prompt 来模拟正常工具结束。返回工具调用后保留原 CLI 执行，客户端下一次回传结果时交回原 MCP 请求。

已在用户提供的本机 8317 端点、CPA 8.0.75、官方 gemini-3.8-flash-high 实测：

- 历史记录中的真实三工具请求不再报 tools 400。
- Chat Completions 与 Responses 均完成真实工具发起、随机结果回传和最终回复。
- 使用历史记录内 automation_repl、automation_repl_reset、fs_read 定义，完成 automation_repl 的流式调用和结果续接；未执行用户的真实自动化操作，结果由测试客户端提供。
- 连续调用 lookup(alpha)、回传、lookup(beta)、回传，最终回复正确包含两个随机结果。
- max_tokens/max_completion_tokens/temperature/top_p 作为兼容参数接受，类型错误仍拒绝，未应用项有响应头与诊断；精确预算和采样仍由 CLI 默认行为决定。
- Responses 省略助手 content 时不再 panic；未知/重复调用 ID、身份或历史不匹配拒绝，等待取消有测试。

构建必须使用 `bunx tauri build --no-bundle`，直接 `cargo build --release` 未启用 Tauri custom-protocol 时会让 GUI 访问开发地址 localhost:1420。此前为验证临时部署的构建造成过此错误，已恢复原 GUI 并改用正式构建流程。

以下是改造前的研究记录，不应当作本分支最终功能说明；当前范围见 acp-access.md。

## 结论

基线 ACP 接入是一个文本请求桥接，尚不满足通用 OpenAI Chat Completions / Responses 客户端的使用要求。截图中的 `tools` 报错来自 ECPA 的请求字段白名单，基线中甚至 `tools: []` 也会触发；本分支已修复空或明确禁用工具的情况，非空启用工具仍不支持。`dev` 已有的多轮处理是把历史拼进一次用户输入，不是复用官方会话。

OpenAI Responses 与 Chat Completions 的互转应继续交给 CPA。缺失的主要能力位于 ACP 执行与会话管理层。仅增加 `/v1/responses` 路由、放宽字段白名单或把工具通知包装为 `tool_calls`，都不能解决这一层的问题。

对于当前 CLI，尚未验证出一条同时满足以下条件的通用客户端工具调用路径：不引入额外 MCP 服务；真实注入客户端工具定义；把调用返回客户端执行；随后把结果送回同一次 Agent 执行。不能据此宣称“绝对无法实现”，也不能把尚未验证的私有扩展当成支持。

## 本次已实施修复

- 空或 null 工具列表、无工具时的 auto，以及明确 none 的工具选择不再被字段白名单拒绝。非空启用工具仍返回明确的能力错误，不能宣称完整工具兼容。
- 接收 developer 指令；system 与 developer 指令通过协商后的官方系统提示字段传递，与用户消息分离。
- 接收单回复、关闭存储、普通文本格式及客户端标识等常见字段，并校验其类型与可支持值。
- 回归测试覆盖上述请求；真实 CPA 测试覆盖带 instructions、developer 和空 tools 的两种入口及流式返回；另有真实模型随机标记检查。

初次 live 检查使用“how are you”并强制指定固定输出，官方模型两次未遵循该要求。随后改成只在系统指令中提供随机标记、在用户消息中询问标记，检查模型是否真正收到该字段；此检查通过。它证明指令传递，不保证每种用户请求下的指令遵循。

以下评审中的“当前桥接”限制描述基线代码；以上条目描述本分支的修复。

## 实测结果

| 能力 | 结果 | 实际含义与限制 |
| --- | --- | --- |
| ACP 初始化、创建会话 | 通过 | 协商版本为 1，当前账号返回 10 个模型；未读取凭据文件 |
| 官方系统提示扩展 | 通过 | `_meta.antigravity.systemPrompt.append` 获声明支持；真实模型响应遵循追加指令。仅验证 append，不代表可以替换 Agent 默认提示 |
| 会话跨进程恢复 | 通过 | `session/close` 后结束进程，新进程 `session/resume` 成功；第二次真实模型请求复述了第一轮随机标记 |
| 原生思考等级配置 | 已发现 | `session/new.configOptions` 返回 `thought_level` 和可用值；这次未对每个值执行推理测试 |
| MCP-over-ACP | 未声明 | 初始化没有 `mcpCapabilities.acp`；官方规范页面仍列为 Draft，不应发送该扩展并假定 CLI 支持 |
| Chat Completions 普通 / SSE | 通过 | 真实 CPA 内核连接 ECPA 测试监听器，ACP 上游为模拟服务器 |
| Responses 普通 / SSE | 通过 | 同一真实 CPA 内核完成协议互转；核验输出文本、`response.completed` 和完成状态。上游仍是模拟 ACP，不是 Codex 客户端实测 |
| 客户端工具调用闭环 | 未通过验证 | 当前桥接直接拒绝工具；未增加 MCP 服务，未执行本机文件或终端工具 |

真实模型探测仅发送两条短消息；两个回合均以 `end_turn` 结束，无工具进度事件、无权限请求。该结果证明系统提示与普通会话恢复，不能外推为未完成工具调用可跨进程恢复。

## 为什么工具通知不能直接转换成 OpenAI 工具请求

OpenAI API 的常见调用边界是：

```text
请求 A（消息 + 工具定义）
  → 返回 tool_calls / function_call，响应 A 完成
客户端执行工具
请求 B（历史 + tool / function_call_output）
  → 模型继续生成
```

ACP v1 的边界是：

```text
session/prompt 运行中
  → Agent 决定调用自己的工具
  → session/update 报告工具进度
  → 必要时询问权限，工具实际执行
  → Agent 收到工具结果并继续生成
  → session/prompt 返回 stopReason
```

`tool_call` / `tool_call_update` 是通知；它们不要求客户端返回工具执行结果。`session/request_permission` 返回选择的权限选项或取消，也不接受任意工具结果。`session/resume` 恢复上下文，不等价于 OpenAI `function_call_output`。

ACP 的标准外部工具入口是 `session/new.mcpServers`。MCP 可以承载真实工具定义与结果，但单独增加它仍然需要一个正确的执行状态机：在 HTTP 响应完成后保留等待中的工具请求，随后把客户端结果交回原请求。取消、超时、进程死亡和重复请求必须有各自的语义。把取消当正常 `tool_calls` 完成会破坏这套约定。

MCP-over-ACP 草案旨在把工具传输保留在同一个 ACP 通道上，不需要额外监听端口或子进程。然而当前官方 CLI 未声明该能力，即使未来支持，也仍需验证跨 HTTP 请求等待和结果回传的完整生命周期。

## 建议的职责与实施顺序

对外入口继续使用 CPA 的鉴权、路由、协议转换和响应事件生成。ECPA 管理官方登录与 CLI 进程。ACP 上游执行层负责能力协商、系统提示、模型配置、会话所有权、工具等待状态和取消。不要在 ECPA 再维护一套 Responses 转换器。

现有 OpenAI-compatible 上游注册方式已经能复用 CPA 的两种入口，不需要仅为 Responses 支持就改造成插件。若后续需要 CPA 原始会话身份、请求方隔离、重试控制或未被转换保留的信息，应评估在 CPA 的 `ProviderExecutor` 扩展点接入 ACP；移动代码本身不能填补官方 Agent 缺失的能力。

1. 先建立可记录、可测试的 ACP 能力协商；使用已声明的官方系统提示扩展和 `configOptions`，不要把未实现的参数静默吞掉。允许无语义影响的空工具集合可以单独修复，但不应标为完成工具支持。
2. 普通会话按调用方、账号、模型、指令和历史身份隔离。复用会话必须验证历史前缀；编辑、重试、分叉和配置变化需要明确分支策略。请求失败或用户断线与正常结束分别处理。
3. 通用工具支持先做独立能力验证：工具定义注册、调用身份、等待、结果注入、连续调用、取消、过期、进程退出、重复请求。没有通过这一闭环前，不向 Codex 声称工具兼容。
4. 对当前版本，若必须同时满足完整工具兼容与不外挂 MCP，需要寻找并验证官方的其他执行接口或等待官方支持；不能用提示词模拟函数调用或把工具结果拼进用户文本代替。官方 Python SDK 也是 Agent 运行时，文档示例使用 API key，不能直接假定它可复用现有 Google OAuth 和模型权益。
5. 验收覆盖真实 CPA 两种协议、普通 / 流式响应、客户端工具往返和真实 Codex 请求。`previous_response_id`、`/responses/compact`、WebSocket 等须各自验证，不能由一个 `/v1/responses` 文本测试推断全部可用。

## 复现

无模型推理的能力与跨进程生命周期探测：

```powershell
python scripts/probe-acp-capabilities.py --profile <官方登录配置目录> --output bin-work/acp-research/capabilities.json
```

增加 `--live` 才发送两条真实模型消息，验证系统提示与历史恢复。报告仅记录能力、配置选项和验证布尔值，不输出账号邮箱、会话 ID、模型回复或凭据。会话由官方 CLI 保存在指定 profile；探测脚本不删除官方会话存储。

本次本机报告：`bin-work/acp-research/native-live-probe.json`（忽略文件，不提交）。

真实 CPA 协议链路验证：

```powershell
$env:ECPA_ACP_TEST_CORE = (Resolve-Path 'bin-work/cpa-core/cli-proxy-api.exe').Path
cargo test --manifest-path src-tauri/Cargo.toml acp::bridge::tests::real_cpa_lists_and_routes_registered_acp_models -- --ignored --nocapture
```

此测试使用独立配置和端口，不修改正在运行的 CPA 配置，也不调用真实模型。

## 依据

- [ACP v1 工具调用](https://agentclientprotocol.com/protocol/v1/tool-calls)：工具由 Agent 执行，通知用于呈现进度与结果。
- [ACP v1 会话与 MCP](https://agentclientprotocol.com/protocol/v1/session-setup)：会话加载、恢复和工具接入边界。
- [MCP-over-ACP 草案](https://agentclientprotocol.com/rfds/mcp-over-acp)：原生通道传输及能力声明要求。
- [官方 Antigravity ACP 文档](https://antigravity.google/docs/ide/extensions/acp)：官方 Agent 运行方式与取消行为。
- [官方更新日志](https://antigravity.google/docs/changelog)：系统提示追加与思考等级配置扩展。
- [官方 SDK 概览](https://antigravity.google/docs/sdk/overview)：Python Agent 运行时及其接入示例。
- 本地 CPA：`internal/runtime/executor/openai_compat_executor.go`、`internal/translator/openai/openai/responses/`、`sdk/cliproxy/auth/conductor.go`、`sdk/pluginapi/types.go`。
