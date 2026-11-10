- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Fixed

- **macOS update helper is no longer killed**: when quitting the app to start an update on macOS, the update helper now runs in its own process group, so system cleanup of the exiting UI process no longer takes it down and the update completes and restarts normally.
- **macOS app-only updates keep the running core**: when only the app itself needs updating, the running core process is no longer terminated and keeps serving after the update. Normal shutdown behaviour is unchanged.
