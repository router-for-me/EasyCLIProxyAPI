- 关于软件，如果您有任何问题或建议，请通过 [QQ群](https://qm.qq.com/q/3queDaIG) 或 [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) 反馈，我们会尽快处理。

## 改进

- **Codex CLI 检测与启动**：在每次检测或启动操作中复用已验证的程序路径和版本，减少重复版本探测，确保启动目标与检测到的 CLI 一致。

## 修复

- **Codex CLI 路径选择**：依次优先使用手动指定路径、`CODEX_CLI_PATH`、PATH 及原有 CLI 安装目录兜底，不再主动扫描桌面版私有 CLI 目录或让其覆盖命令行安装。
- **无效路径与缓慢启动器**：显式指定的 CLI 不可用时直接报错，不再悄悄切换其他安装；Unix 下清理版本探测的子进程，避免启动器后代进程占用输出管道导致检测超时后仍继续等待。
