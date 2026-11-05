- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Fixed

- **False Agent Usage Read Failures**: Fixed the persistent warning banner at the top of the Agent Usage page (for example `Copilot CLI: Unable to read local usage records`). The Copilot scan previously walked the entire Copilot directory and tried to parse unrelated configuration files, so a single unreadable file marked the whole source as failed. It now reads only Copilot's session-state directory, and unreadable historical files are no longer treated as sync errors — the source falls back to an idle status instead of an error and the banner no longer appears.
