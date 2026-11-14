- 關於軟體，如果您有任何問題或建議，請透過 [QQ 群組](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回報，我們會儘快處理。

## 改進

- **Codex CLI 偵測與啟動**：在每次偵測或啟動操作中重用已驗證的程式路徑與版本，減少重複版本探測，確保啟動目標與偵測到的 CLI 一致。

## 修正

- **Codex CLI 路徑選擇**：依序優先使用手動指定路徑、`CODEX_CLI_PATH`、PATH 與原有 CLI 安裝目錄備援，不再主動掃描桌面版私有 CLI 目錄，亦不讓其覆蓋命令列安裝。
- **無效路徑與緩慢啟動器**：明確指定的 CLI 無法使用時直接回報錯誤，不再默默改用其他安裝；Unix 下清理版本探測的子行程，避免啟動器後代行程占用輸出管線，導致偵測逾時後仍持續等待。
