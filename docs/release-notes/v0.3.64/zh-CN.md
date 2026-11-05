- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 修复

- Linux 重复启动唤醒窗口与静默启动优化：修复在 Linux 系统下应用在后台/托盘运行时，从启动器或桌面快捷方式再次点击无响应的问题；实例锁持有进程通过本地 Unix Socket 监听激活请求，后续启动尝试会请求正在运行的实例显示、恢复并前置主窗口。优化静默启动规则，仅在 Linux 登录开机自启时生效（传入 `--autostart` 参数、检测到 gnome-session 的 `DESKTOP_AUTOSTART_ID` 或 systemd 自启服务）；从应用菜单或快捷方式手动启动时将正常显示主窗口，解决部分无托盘/Waybar 桌面环境下无法唤醒应用窗口的问题（[#550](https://github.com/router-for-me/EasyCLIProxyAPI/pull/550)）。
