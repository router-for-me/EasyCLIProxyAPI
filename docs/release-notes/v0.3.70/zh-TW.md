- 關於軟體，如果您有任何問題或建議，請透過 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 修復

- **Agent 使用記錄誤報讀取失敗**：修復「Agent 使用記錄」頁面上方長期出現的黃色提示（如 `Copilot CLI: Unable to read local usage records`）。此前掃描 Copilot 目錄時會把無關的設定檔一併納入解析，任一個檔案無法解析就整源標記為失敗；現在只讀取 Copilot 的會話紀錄目錄，且無法解析的歷史檔案不再視為同步錯誤，來源狀態回到空閒而非錯誤，頁面也不再顯示該提示。
