# 可选语义自动路由插件

这不是内置或强制路由。未安装、全局插件关闭、单插件关闭时均不生效。
仅当客户端精确请求配置的 `alias`（默认 `semantic-auto`）时，才用已有分类模型根据问题的语义和候选描述选择目标。
直接请求其他模型完全绕过分类。不是关键词匹配，不添加任何外部服务地址或新服务凭据。
分类请求使用核心的 `host.model.execute` 和现有供应商凭据；该调用可能产生现有供应商的正常用量。

## 构建与安装

要求：Go 1.26.10、C 编译器、CGO；核心 8.0.48 或更新版本，支持原生插件 ABI 1 / schema 6。
在本插件目录运行 `bash build.sh`，构建当前平台的动态库及可分发压缩包。
有本地核心源码时可以使用 `CPA_SDK_DIR=/path/to/CLIProxyAPI bash build.sh`；脚本只读取其 `v8.0.48` SDK 快照，不修改源码。
没有本地源码时，Go 按 `go.mod` 获取官方 SDK 依赖。跨平台分发须在对应平台构建，不能把 Linux `.so` 安装到 Windows。

Linux 产物：`dist/semantic-router-0.1.0-linux-amd64/semantic-router.so`；同目录包含清单、校验和、说明和许可证。
`manifest.json` 是压缩包内的说明性清单，不是商店索引，不会自动注册商店或启动任何进程。

1. 打开 EasyCLIProxyAPI → **插件 → 本地安装**，选择平台对应的 `semantic-router.so` / `.dylib` / `.dll`，不要选压缩包或 manifest。
2. 如果全局插件未开启，在插件设置中开启。按界面提示重启核心，刷新已安装列表。
3. 打开 `semantic-router` 的**配置**，填写下列字段。已有通用配置对话框原生支持对象/数组 JSON 编辑；无需额外页面。
4. 最后开启该插件并保存；如要求重启则重启核心。只安装但不配置/启用不会发送分类请求。

## 持久配置

配置由现有管理 API 持久化到 `plugins.configs.semantic-router`。不修改其他插件、供应商或客户端凭据。
先在应用的供应商/模型配置中配置可正常调用的模型，再从这些已存在模型中选择候选、分类器和回退。
`provider` 是核心供应商标识：原生如 `claude`、`codex`，OpenAI 兼容供应商使用 `openai-compatible-` 加配置名称（例如名称为 `local` 时填 `openai-compatible-local`，不是统一填写 `openai`）。
`model` 使用该供应商在核心注册的模型 ID/别名。候选是否仍存在会通过核心 `host.auth.models` 核验，不接受分类器自由生成模型名。
可以通过带客户端认证的 `/v1/models` 核对 ID；供应商名称以应用配置为准。

在通用配置对话框中按字段输入 JSON（以下 ID 仅为示例，必须替换为已有模型）：

| 字段 | 示例 |
| --- | --- |
| `alias` | `semantic-auto`（不能与实际模型 ID 冲突） |
| `classifier` | `{"provider":"my-provider","model":"small-model"}` |
| `fallback` | `{"provider":"my-provider","model":"general-model"}` |
| `timeout_ms` | `3000`（50–30000） |
| `candidates` | `[{"provider":"my-provider","model":"code-model","description":"程序设计、调试和代码审查"},{"provider":"my-provider","model":"writing-model","description":"翻译、文学创作和文案写作"}]` |

最多 32 个候选，每个描述 1–2048 字符，供应商/模型组合不能重复，分类器、回退和候选都不能指回 `alias`。
启用时必须提供所有必需项。无效配置不会替换当前内存中的有效配置；若核心已将无效值写入磁盘，需要在对话框更正后保存，不能把“保存成功”视为插件已有效加载。
插件不注册虚拟模型目录项：客户端若只允许选择目录模型，请手动填入别名 `semantic-auto`。

```sh
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer $CPA_CLIENT_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"semantic-auto","messages":[{"role":"user","content":"请解释这个函数的时间复杂度"}],"stream":true}'
```

分类仅提取聊天文本（Chat Completions / Messages 文本块、Responses `input` 字符串或消息数组），含最近上下文，最多末尾 12000 个字符。
别名不能使用核心预先处理的保留名 `auto`；插件会拒绝该值，默认使用 `semantic-auto`。
图片、音频和工具结果不发送给分类器；无可用文本使用回退。因此纯多模态任务不能靠此插件自动识别。
原始消息、流式模式、工具调用、温度及其他参数均不重建：插件只返回目标，核心完成供应商转换和上游请求。
选择候选时请确保它支持客户端的工具和多模态能力，本插件不能为不支持的供应商补齐协议能力。

## 失败与安全边界

- 分类器出错、格式错误、返回 0/越界值、无候选、无内部调用上下文、达到等待上限，使用配置的回退。
- 核心注册目录中已移除的候选不参与选择，选择完成后再次核验。回退也不存在时不做路由，由核心返回正常模型不可用错误，不尝试陌生模型。
- 已注册但运行中限额耗尽/临时不可用的模型，由核心现有重试与冷却机制处理。本插件不重放已执行的目标请求，避免重复工具动作/费用。
- 分类调用携带核心的 `host_callback_id`；核心跳过该插件的递归路由。别名也不允许作为分类器和目标。
- 同时最多 8 个内部主机调用（分类与目录查询共享限额）。分类最多使用配置等待上限的一半，为回退目录核验预留时间；总等待上限不变。SDK 没有取消单次 `host.model.execute` 的接口，已有上游调用可能继续至核心取消或供应商超时，仍占用槽位。回退必须通过本次目录查询核验；目录错误、查询超时或槽位已满时不做路由，不使用过期结果。停用/卸载等待已有调用安全退出。
- 没有请求文本日志、额外遥测或外部分类服务。使用分类器即同意将所提取的文本发送至**你配置的**分类模型供应商。
- 禁用单插件并将客户端改为实际模型名即可停止自动路由；可通过现有卸载入口删除动态库。

## 验证

```sh
go test -race ./...
bash build.sh
CPA_CORE=/path/to/cli-proxy-api python3 smoke_test.py
CPA_CORE=/path/to/cli-proxy-api python3 build_test.py -v
CPA_GUI=/path/to/release/cpa-gui CPA_CORE=/path/to/cli-proxy-api bash verify_gui.sh
```

集成测试启动临时本地核心和确定性的本地分类/上游 HTTP 服务，所有配置、凭据均为临时测试数据；退出时清理子进程和端口。
`build_test.py` 使用隔离 PATH 验证缺少 `sha256sum` 时的 `shasum -a 256` 打包路径，并在没有 `.build` 的临时目录运行真实核心集成测试，不删除已有构建文件。打包回归使用模拟编译器，不代表 macOS 原生构建验证。
它验证真实动态库加载、语义决策、显式模型绕过、畸形结果/HTTP 错误/超时回退、流式工具载荷和关闭插件后的行为。
