- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Improved

- **Plugin settings page**: removed two redundant hint lines under the store source and authentication fields. The note explaining that the ECPA featured catalog registers itself as a plugin source is kept, since it names a source the app adds for you.

## Fixed

- **Featured plugin list frozen at an old snapshot**: the ECPA featured page no longer falls back to a registry copy bundled into the application. A failed read now shows an empty list with an explicit error instead of silently presenting plugins that were frozen at build time.
- **Featured plugins missing after the registry moved to schema version 2**: the registry parser rejected `schema_version` 2 outright, so a successful download was discarded and the page reported a read failure. Both schema generations are now accepted; unknown versions are still rejected.
- **Stale failure banner after a successful refresh**: pressing Refresh now clears the previous "failed to read the plugin source" notice, and a failed refresh clears the old list, so the page never shows cards next to a failure message.
- **SOCKS proxy URLs rejected in network settings**: `socks://`, `socks5://` and `socks5h://` are accepted regardless of letter case, with `socks://` normalized to `socks5://`.
