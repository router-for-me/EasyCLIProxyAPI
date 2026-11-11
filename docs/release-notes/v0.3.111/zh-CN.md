关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 新增

- **内置 Codex 模型目录新增 `gpt-oss-120b-medium`**：该模型已加入随应用发布的模型目录（revision 9），在 Codex 模型选择器中直接可见，无需额外下载。

## 改进

- **ACP 模型改为直接发布原始模型名**：此前 ACP 服务在已改名的模型上再加一层别名，而 Claude Desktop 的别名表无法表达“重命名的重命名”。现在直接以 `acp/` 前缀的模型名发布，不再写入别名字段。
- **Claude Desktop 不再把托管配置标记为需要注意**：不再向托管模型条目写入 `behavesAs`，因为无法识别该字段的 Desktop 版本会把整个配置判为异常。改为直接发布 Desktop 已认识的系列路由（`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-4-5`），上游模型名保留在 `labelOverride` 中。旧版本写入的字段也不会再被恢复。
- **ACP API 流式输出修正**：Chat Completions 与 Responses 客户端现在能收到完整的 OpenAI 兼容流——首个 assistant 角色增量、文本或带索引的工具调用、唯一的结束原因与 `[DONE]`，各分片共用同一个 completion ID、模型名和创建时间。输出队列在拥塞时施加背压同时保持可取消，不再丢帧；CLI 未提供 token 计数时不编造用量。

## 修复

- **Antigravity 用量被重复计算且存在丢失**：用量扫描此前会把同一个会话的每份镜像（`transcript.jsonl`、`transcript_full.jsonl`、`chunks/**`、IDE 与备份副本）都统计一遍，总量达到真实用量的数倍，同时部分请求的模型显示为「unknown model」。现在每个会话只从一份规范 transcript 计入一次，模型按请求步骤从会话数据库读取并以设置标签作为回退，完全相同的样本会被去重，而重试与压缩检查点仍然保留。升级后首次同步会重建一次 Antigravity 数据，总量回落到真实值。
- **文件读不出来时 Antigravity 用量会消失**：此前只要会话里有任意一个文件读取成功，其余文件的缓存行就会被删除，即使它们读不出来。现在读取失败一律保留缓存行；对照的 transcript 按实际覆盖的请求比较而不是按文件名判断；旧键会被迁移，不再与新键并存重复计数。
- **ACP API 写入失败时丢失了根因**：保存 Claude Desktop 别名映射会以 `invalid_config` 失败，原因是 ACP 服务把 `proxy-url` 写在 provider 层，而核心不接受 `openai-compatibility` 条目的这种写法。现在写入 key 条目内部，已存在的 provider 层取值会被归一到 key 条目，并在写入失败的提示中附上核心的原始错误。
- **ACP API 可能在补全中途失败却显示成功**：首个分片之后的上游故障此前会被当作截断的成功结果。现在输出前的故障返回 HTTP 错误，输出后的故障发出终止性 SSE 错误且不带成功结束原因与 `[DONE]`，失败的回合不会再看起来像已完成。
