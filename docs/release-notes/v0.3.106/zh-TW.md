- 關於軟體，如果您有任何問題或建議，請透過 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 改進

- **發佈打包可靠性**：macOS 的 DMG 建立失敗會自動重試，並且只卸載該映像自身掛載的卷；Intel 版 macOS 改為在 Apple Silicon 建置機器上交叉編譯；Linux 使用 mold 連結；下載發佈附件時，尚未上傳完成的附件會重試，不再直接導致建置失敗。

## 修正

- **外掛商店樣式**：外掛標誌之後的樣式不再脫離元件層，商店結果列恢復應有的間距，樣式表也不再產生語法錯誤。
