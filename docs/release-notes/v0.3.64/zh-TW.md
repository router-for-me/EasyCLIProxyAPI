- 關於軟體，如果您有任何問題或建議，請透過 [QQ群組](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 回饋，我們會盡快處理。

## 修復

- Linux 重複啟動喚醒視窗與靜默啟動最佳化：修復在 Linux 系統下應用程式於背景/系統匣執行時，再次點擊啟動器或桌面捷徑沒有回應的問題；持有執行個體鎖的程序透過本機 Unix Socket 監聽啟用請求，後續啟動嘗試會請求正在執行的執行個體顯示、還原主視窗並將其移至最前方。最佳化靜默啟動規則，僅在 Linux 登入自動啟動時生效（傳入 `--autostart` 參數、偵測到 gnome-session 的 `DESKTOP_AUTOSTART_ID` 或 systemd 自動啟動服務）；從應用程式選單或捷徑手動啟動時將正常顯示主視窗，解決部分無系統匣/Waybar 桌面環境下無法喚醒應用程式視窗的問題（[#550](https://github.com/router-for-me/EasyCLIProxyAPI/pull/550)）。
