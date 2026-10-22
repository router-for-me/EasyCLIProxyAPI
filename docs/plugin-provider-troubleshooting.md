# Checking an OAuth provider plugin

EasyCLIProxyAPI discovers provider features from the running core's plugin metadata.
A plugin can provide OAuth login, models, execution and credential quota information
through the existing core endpoint. The desktop app does not need a provider-specific
login button for each plugin.

## Check the running plugin first

In **Plugins → Local plugins**, confirm that the plugin is running. Configuration
entries can remain after a binary has been removed; they are not proof that the
plugin was loaded. If inspecting the authenticated Management API, use
`GET /v8/management/plugins` and check:

| Field | What it confirms |
| --- | --- |
| `registered` and `effective_enabled` | The running core registered and enabled the plugin. |
| `supports_oauth` and `oauth_provider` | The OAuth page can discover the plugin's login card. |
| `supports_quota` and `quota_provider` | The plugin declares a quota capability. |
| `metadata.version` and `path` | The version and binary actually selected by the core. |

Use the configured management key for management requests. Client API keys and the
management key have separate roles; do not publish either in diagnostics.

## Login completes, but the model list is empty

OAuth completion means that the core accepted the credential. Model discovery is a
separate operation. Check the credential's **Models** dialog and `/v1/models`, then
inspect the core log for `models for auth ... failed`. An adapter exception or a
catalog format mismatch can leave valid credentials without registered models.

Plugin authors should exercise the original upstream model-discovery result in
tests, in addition to simulated HTTP responses. Keep model registration bound to the
selected credential and preserve account disablement. A discovered model does not
guarantee that the account's subscription allows its use.

## Quota is unavailable

The desktop app obtains quota through the core's `QuotaProvider` capability. OAuth
and model support alone do not enable quota queries. Check `supports_quota` on the
plugin and the credential before treating a missing quota panel as an empty balance.

Implement `quota.identifier`, `quota.describe` and `quota.fetch` for a native ABI
provider. The core routes credential requests through
`POST /v8/management/plugins/<plugin-id>/quota` using `auth_index`. Return normalized
`groups`, `summary` and optional `subscription` fields. Numeric summaries can show
credits without inventing a percentage when the upstream supplies no total.
Failed or unavailable upstream quota queries should remain errors, not zero balances.

## A local binary is present, but a different version is selected

The core understands both `<id>.dll` and `<id>-v<version>.dll` on Windows, with
equivalent `.so` and `.dylib` filenames on other platforms. A configured desired
version can exclude an unversioned binary or a differently versioned file.

Inspect the plugin's existing store version selection before copying a local file.
Use the store's version selector for store-managed upgrades and confirm the active
`path` and `metadata.version` afterward. The ZIP layout of a store release is
different: its library must be named `<id>.dll` at the archive root; the core's
installer handles the installed filename. See the official
[registry release requirements](https://github.com/router-for-me/CLIProxyAPI-Plugins-Store#release-requirements).

## A browser stays on the regional selection page

Test the actual browser path, including response headers. A successful `303` checked
by an HTTP client does not prove that browser navigation succeeded. Chromium can
block a form redirect to an external authorization site under a restrictive
`form-action 'self'` policy. Ordinary navigation links avoid submitting a form while
allowing the page to retain that policy. Repeated selection should reuse an active
authorization attempt instead of stranding the user on a conflict page.

The official authorization page performs the user's login. Local guidance pages
should expose short-lived tickets, not account access or refresh tokens. A plugin
that uses the host endpoint does not need to start a separate HTTP gateway.

## 中文速查

- 插件卡片“运行中”与配置中 `enabled: true` 不同；同时检查实际注册状态、文件路径和版本。
- OAuth 成功与模型注册是两条链路。模型为空时查看内核模型注册日志，保留原版目录格式的回归测试。
- “暂不支持额度查询”表示没有可用的额度能力或路由，不能据此判断余额为零。
- 商店 ZIP 根目录使用不带版本的动态库名；本地文件选择还受已有商店版本配置影响。
- 浏览器授权需要验证实际导航及 CSP；单测看到 HTTP 303 不能替代浏览器测试。
- 不在诊断材料中公开 API Key、管理密钥、账号 Token 或用户凭据文件。
