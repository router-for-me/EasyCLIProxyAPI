- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Fixed

- **Black screen when restoring a window minimized from the taskbar**: on Windows, clicking the taskbar icon to minimize and restore repeatedly could show a solid black window for 0.3–1 second, or leave only a thin titlebar strip in the top-left corner. The WebView controller now stays attached while minimized, so the compositor surface survives and the main view is no longer squeezed into the iconic minimize size; the interface appears immediately on restore.
- **Stale visibility after restoring from the tray**: restoring from the tray now resynchronizes the window state, so the app no longer keeps running as if the window were still minimized.

## Improved

- **No idle polling while the window is hidden**: the reverse-proxy status query and the pre-restore delay no longer run when the window is not visible, noticeably lowering CPU use while minimized.
- **Lower-frequency kernel status and usage-queue polling**: once the kernel is ready, its status probe runs every 10 seconds, and an idle usage queue backs off instead of hitting the kernel every second.