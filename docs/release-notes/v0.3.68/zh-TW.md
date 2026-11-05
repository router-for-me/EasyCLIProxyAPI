- 關於軟體，如果您有任何問題或建議，請透過 [QQ群組](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 新增

- **本機 Agent 使用記錄與儀表板重構**：將 Agent 使用記錄持久化儲存至本機 SQLite 資料庫（`agent_usage.db`），支援增量極速同步與歷史留存；頁面支援自訂時間範圍與統計粒度、多選篩選 Agent，提供 Token、成本及快取命中率 KPI 卡片（含走勢微圖與同期對比變化）、趨勢與 Token 結構圖表、活躍度熱力圖（含全量日曆與 30 天時段熱力分佈）以及模型/Agent 詳細數據統計；同時支援在「資料管理」中自訂背景同步週期（5分鐘至1小時，或關閉）（#564）。
