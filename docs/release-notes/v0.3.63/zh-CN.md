- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 新增

- 本地智能体用量统计与多源会话扫描：新增本地智能体用量统计页面（`AgentUsageView`），支持自动扫描并解析 Claude Code、Codex、Gemini CLI、Antigravity、OpenCode、Kimi Code、Pi、OMP、MCode、Copilot、ZCode 等主流编程智能体的本地会话记录（内置目录深度限制与大文件保护）；支持按时间范围（当天、近 24 小时、近 7 天、近 30 天、全部）和来源筛选，提供 Token 总量、预估总成本、输入/输出 Token、缓存命中/写入概览卡片，以及每日明细与模型成本统计（[#538](https://github.com/router-for-me/EasyCLIProxyAPI/pull/538)）。
- 路由编排与实时路由监控：新增路由编排页面与实时路由可视化监控面板，支持配置路由策略、会话亲和性、失败重试、冷却时间以及多层级（Tier）密钥与凭据权重编排，并实时展示请求分发流向与冷却倒计时。
- WSL 智能体配置目录支持：在「智能体 → 管理」页面支持为各智能体自定义配置目录路径（支持本地路径及 Windows 下的 WSL UNC 路径如 `\\wsl$\Ubuntu\home\...` 或 `\\wsl.localhost\...`），底层完整适配 WSL UNC 路径原子写入、模板预览与备份恢复（[#523](https://github.com/router-for-me/EasyCLIProxyAPI/issues/523)）。
- Muse (Meta) 额度查询支持：在额度查询页面新增 Muse (Meta) 供应商支持，支持自动识别凭据并查询窗口期额度、周额度、重置时间及套餐信息（[#496](https://github.com/router-for-me/EasyCLIProxyAPI/issues/496)）。
- 内核指定版本选择与安装：版本管理页面支持拉取并选择指定的 CPA 内核历史版本（含预发布版本标记）进行安装，并增强多下载源获取版本列表时的自动回退机制（[#528](https://github.com/router-for-me/EasyCLIProxyAPI/issues/528), [#539](https://github.com/router-for-me/EasyCLIProxyAPI/pull/539)）。
- ZCode 模型能力自动校准与目录重构：支持根据本地调用记录自动校准 ZCode 模型能力（自动过滤不支持的推理等级），默认下发完整思考等级列表，将模型目录弹窗重构为统一的 Codex 风格双栏编辑器，并增强 Codex CLI 路径探测（[#547](https://github.com/router-for-me/EasyCLIProxyAPI/pull/547)）。

## 修复

- 凭据标签持久化与批量打标优化：修复刷新凭据列表后自定义标签丢失的问题，新增本地持久化标签合并层；优化账号卡片标签展示与点击筛选交互，并在批量管理弹窗中支持批量添加/移除标签及按标签整组选择（[#546](https://github.com/router-for-me/EasyCLIProxyAPI/issues/546)）。
- 更新或重启后自动启动内核与端口探测重试：修复更新内核或应用自动升级重启后未自动拉起内核导致上游请求 502 的问题；在启动与进程接管阶段增加存活校验与管理端口短暂占用重试机制，并优化更新确认弹窗提示文案。
