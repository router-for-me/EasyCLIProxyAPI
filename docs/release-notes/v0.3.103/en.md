- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Improved

- **Codex CLI detection and startup**: Reuse the validated executable and version within each detection or launch operation, avoiding repeated version probes and keeping startup aligned with the detected CLI.

## Fixed

- **Codex CLI selection**: Prefer the manually selected executable, `CODEX_CLI_PATH`, then PATH and existing CLI installation fallbacks. Desktop-private CLI folders are no longer scanned automatically or allowed to override the command-line installation.
- **Invalid paths and slow launchers**: Report unusable explicit CLI paths instead of silently switching installations. On Unix, clean up version-probe child processes so launcher descendants cannot keep detection waiting beyond its timeout.
