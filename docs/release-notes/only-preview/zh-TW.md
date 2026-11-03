- 關於軟體，如果您有任何問題或建議，請透過 [QQ群組](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 修復

- **OpenCode 客戶端圖片與附件貼上支援**：為 OpenCode 設定檔中產生的自訂 provider 模型宣告 `attachment` 與 `modalities` 欄位。針對多模態模型提供 `text`、`image` 與 `pdf` 輸入支援，針對影像生成模型宣告包含 `image` 的輸出能力，修復因 custom provider 缺少模型元資料導致客戶端攔截圖片貼上與附件上傳的問題（#567）。
