- 關於軟體，如果您有任何問題或建議，請透過 [QQ群組](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 新增

- 智慧代理鑑權 API Key 獨立選擇與持久化：支援為每個智慧代理設定單獨選擇鑑權 API Key，支援自動回退至有效預設 Key，並包含全語言國際化（[#544](https://github.com/router-for-me/EasyCLIProxyAPI/pull/544), [#545](https://github.com/router-for-me/EasyCLIProxyAPI/pull/545)）。
- ZCode 智慧代理模型目錄與子代理設定：新增 ZCode 模型目錄選擇對話框與子代理（Sub-agent）設定面板，支援多檔推理等級（reasoning levels）及 Spark 1M 上下文規格。

## 修復

- Windows 環境 CLI 啟動修復：修復 Windows 下啟動全域 npm 安裝的 CLI shims 失敗或崩潰的問題。
- Claude Desktop 別名比對與路由修復：修復當特定 Provider 別名被停用或過濾時，未正確回退至主模型的問題。
- ZCode 設定持久化與規範性修復：確保 `maxOutputTokens` 嚴格符合 Zod schema，修復模型目錄選擇、Token 限制繼承及設定儲存時的借用與狀態同步問題。
- 介面版面與互動優化：優化 ZCode 子代理對話框版面、側邊欄捲軸體驗，並在儲存模型目錄設定後自動關閉對話框。
