# 周重置临近优先调度插件

这是 issue #379 的**可选本地安装插件**，不是内置调度修改，也不改变界面排序或保存的账号优先级。未安装、关闭、卸载或缓存不可用时，使用宿主原来的调度策略。

## 兼容与支持范围

- 固定 SDK `github.com/router-for-me/CLIProxyAPI/v8 v8.0.48`，核心版本 **8.0.48**，C ABI 1；使用正式 `scheduler.pick` 契约。其他核心版本需重新验证，不能仅凭 ABI 编号认定兼容。
- **仅支持有实体凭据文件的 Codex OAuth 账号**：通过宿主 `host.auth.list` 匹配本次候选 ID，再通过 `host.auth.get` 取得宿主提供的凭据，调用宿主 HTTP 回调访问固定的 `https://chatgpt.com/backend-api/wham/usage`。不扫描目录、不直接读取凭据文件、不调用管理接口、不使用任意外部配额服务。
- Codex API key、运行时虚拟凭据以及 Claude、Antigravity、其他供应商暂不支持。其他供应商出现在同一最高优先级候选集合时，整个选择回退，不偏袒已支持供应商。
- 仅识别普通 `rate_limit` 中明确标注 `limit_window_seconds: 604800` 的窗口及其 `used_percent`、`reset_at`；不把令牌有效期、每日、5 小时、代码审查专用额度当成通用周额度。`reset_at` 支持 Unix 秒、毫秒（数字或数字字符串）、RFC3339 时间。
- 不承诺模型专用的额外额度：模型路由、候选资格、粘性绑定、禁用、冷却及不可用过滤仍归核心负责。本插件只选择当前传入的候选 ID。

## 构建与安装

在本目录执行（Go **1.26.10+**、本机 C 编译器、Bash、tar）：

```bash
./build.sh
go test -race ./...
./test-host.sh
```

输出（Linux amd64 示例）：

```text
artifacts/linux-amd64/weekly-reset-priority/weekly-reset-priority.so
artifacts/linux-amd64/weekly-reset-priority/weekly-reset-priority.h
artifacts/weekly-reset-priority-0.1.0-linux-amd64.tar.gz
artifacts/weekly-reset-priority-0.1.0-linux-amd64.tar.gz.sha256
.build/cli-proxy-api
.build/logs/integration.log
.build/logs/core-true.log
.build/logs/core-false.log
```

归档包含共享库、C 头文件、说明、描述性 `manifest.json` 和许可证。manifest 供检查与分发使用，不是另一套插件加载协议。**现有本地安装入口选择实际平台共享库，不选择归档或 manifest**：解压归档 → EasyCLIProxyAPI「插件」→「本地安装」→ 选择 `.so`（Linux）、`.dylib`（macOS）或 `.dll`（Windows）。GUI 将文件放入核心插件目录的 `<os>/<arch>/`；不覆盖已有同名库。随后在插件页启用全局插件开关和本插件、保存配置。原生插件属于可信进程内代码，只安装可信构建。

只打包本机目标，禁止脚本伪造跨平台产物。macOS 在对应架构原生构建；Windows 需 Go、MinGW C 编译器及 Git Bash。其他系统和跨编译未验证；不能把 Linux `.so` 改名当成其他平台库。构建产物留在本目录，不注册商店、不发布资源。

## 持久配置

通过已有插件配置对话框编辑（字段来自真实 ABI 元数据），或配置文件中的标准插件字段：

```yaml
plugins:
  enabled: true
  dir: plugins
  configs:
    weekly-reset-priority:
      enabled: true
      priority: 0
      providers: [codex]
      refresh_seconds: 60
      freshness_seconds: 180
      timeout_seconds: 10
```

`priority` 是宿主的**插件调用顺序**，不是账号优先级。插件始终 `scheduler_across_priorities: false`，不提供跨手动层级抢占选项。配置校验：providers 仅允许 `codex`（空数组暂停），刷新 1–3600 秒，缓存年龄 ≥ 刷新间隔且 ≤7200 秒，HTTP 超时 1–30 秒；未知字段及错误类型拒绝。无效重配不会安装新配置。

## 优先级、刷新与回退

1. 核心首先维护资格与亲和关系，正常仅交付最高可用手动优先级层。插件也防御性地保留最高层；不会修改任何账号字段。
2. 该层所有候选都有可信、新鲜、未来的周重置时间且尚有额度时，选择最早重置的账号。相同时间按稳定账号 ID 排序轮转；模型、供应商、流式模式和候选集合分别计数（有界内存计数，不持久化）。
3. 无数据、无剩余额度字段、格式错误、周窗口不明确、额度耗尽、过去重置、时钟异常、缓存过期或查询失败时，保守地将整次选择交回宿主。不把未知当成 0，也不提升已耗尽账号。其他窗口明确耗尽也会使快照失效。
4. 首次请求立即回退并将候选加入后台队列；之后有流量时按刷新间隔更新，不要求先打开额度页。单工作线程、256 待处理项、最多 1024 账号缓存；请求线程不等待网络、不进行同步网络扇出。队列满时保持回退。停止流量后不主动轮询。
5. 默认最多接受 180 秒旧快照。刷新失败立即清除该账号旧快照；重置时间已过去时即使缓存未到期也不能继续使用，必须重新获得有效配额。上游周重置不应比当前时间远 7 天加 5 分钟。
6. HTTP 通过 `host.http.operation_open` / `host.http.do` / `host.http.cancel` 运行，受宿主全局代理和传输策略约束。超时、关闭、重配、quiesce、卸载会取消在途操作并等待工作线程退出。不自行刷新或持久化令牌，不打印凭据或配额响应。

关闭插件页的本插件开关（或全局开关）即可恢复原调度；卸载前先关闭，再通过已有卸载入口删除库。Go C 共享库的运行时可能按核心设计保留在内存直到核心退出，但逻辑卸载后不再调度或刷新。

## 数据链路与测试

SDK/核心 v8.0.48 的实际链路：

- `sdk/pluginapi/types.go`：SchedulerPickRequest、ConfigField、HostAuthGetResponse、HTTPResponse。
- `sdk/cliproxy/auth/conductor_selection.go`：`schedulerAuthCandidates` 仅传递安全属性，**未提供周配额或原始凭据元数据**。
- `sdk/cliproxy/auth/types.go`：QuotaState 记录限流/恢复及响应信号，不等于可供本插件调用的周额度缓存。
- `internal/pluginhost/host_callbacks.go` 和 `auth_callbacks.go`：真实凭据/HTTP/取消回调；没有 `host.quota.fetch`。`sdk/pluginhost.FetchQuota` 是宿主调用配额插件的能力，不能冒充插件侧回调。
- GUI 的 `src/services/quotaService.ts` 也查询 Codex wham usage，但其浏览器缓存不是调度器数据源。本插件独立通过正式宿主接口自动获取真实数据，不依赖 UI 开启。

单元测试覆盖时间格式、周窗口、未知/零剩余、回退、优先级、平局、模型/供应商隔离及并发/取消。`test-host.sh` 构建固定版本的**真实核心服务器**并启动隔离子进程，加载实际共享库；本机 TLS 配额/上游及 CONNECT 代理只接收测试凭据，验证重置顺序变化导致上游收到的账号变化、缺数据与关闭后恢复 fill-first。临时配置、测试凭据、日志和证书均在测试临时目录，测试结束停止子进程；不连接或修改正在运行的服务。普通 `go test ./...` 在未传入测试二进制路径时会明确跳过真实核心测试，不冒充 ABI 联调通过。

联调等待 `/v1/models` 确认固定版本内嵌目录中的测试模型已真正注册，不使用该版本不存在的 `gpt-5`。各调度阶段要求连续三次实际上游请求命中预期账号，并确认关闭后不再查询配额。子进程仅使用显式测试环境，不继承外部存储或控制面配置；全局代理及 HTTP(S) 环境代理都指向本机拒绝代理，仅将 `chatgpt.com:443` 隧道转发给本机 TLS mock。`--local-model` 禁止模型目录更新、关闭控制面下载；核心仍发起的 Antigravity/npm 版本探测只在本机被拒绝，不访问真实上游。日志保存到 `.build/logs/`，失败时保留错误与核心日志便于排查。清理只向本测试通过 `exec.Command` 启动的核心进程句柄发送信号，等待退出后再关闭本机连接；不按进程名或进程组终止其他任务。

没有修改前端；现有插件页和配置对话框直接渲染元数据。浏览器模拟插件列表不属于实际 ABI 集成证明。
