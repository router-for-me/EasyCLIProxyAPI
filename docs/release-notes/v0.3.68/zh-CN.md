- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 新增

- **本地 Agent 使用记录与仪表盘重构**：将 Agent 使用记录持久化存储至本地 SQLite 数据库（`agent_usage.db`），支持增量极速同步与历史留存；页面支持自定义时间范围与统计粒度、多选筛选 Agent，提供 Token、成本及缓存命中率 KPI 卡片（含走势微图与环比变化）、趋势与 Token 结构图表、活跃度热力图（含全量日历与 30 天时段热力分布）以及模型/Agent 详细数据统计；同时支持在「数据管理」中自定义后台同步周期（5分钟至1小时，或关闭）（#564）。
