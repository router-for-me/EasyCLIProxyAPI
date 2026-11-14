- 關於軟體，如果您有任何問題或建議，請透過 [QQ 群組](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回報，我們會儘快處理。

## 修正

- **Codex CLI 尋找**：Codex CLI 現在也會辨識桌面應用程式內建的可執行檔，包括透過 Windows 商店/MSIX 安裝的套件、Windows 桌面版獨立資源目錄以及 macOS 應用程式套件。
- **Codex CLI 選擇**：候選項目改為比較語意化版本，不再直接使用第一個可用的候選項目，避免選中過期的重新定位快取。版本相同時優先選擇搜尋目錄中的獨立 CLI，其次是桌面應用程式內建版本，最後是舊版快取。
- **正式版與預先發行版排序**：僅在同一核心版本下正式版才優先於預先發行版，因此核心版本較新的預先發行版仍會優先於較舊的正式版。