# 配置环境切换器

配置管理页支持在本地与 WSL 配置目录之间切换。切换只影响配置文件位置，不改变程序启动方式。

- Windows 下通过 `wsl.exe --list --quiet` 和 WSL 共享目录发现发行版，读取 `/home` 与可访问的 `/root`，推荐当前客户端对应的默认配置目录。
- 优先使用 `\\wsl.localhost`，不可访问时尝试 `\\wsl$`。未创建的配置目录会单独提示；无法读取用户目录时保留自定义路径入口。
- 选择发行版或用户即应用目录；高级路径与浏览入口折叠显示。现有目录覆盖存储、验证、读写、备份和恢复流程保持不变。
- 非 Windows 平台不探测 WSL，并显示本地默认目录与友好提示。探测失败可重试，不会清除已保存目录。

## 验证

```sh
bun run check
bun run build
bun test tests/agentEnvironments.test.ts
bun run test:ui:agent-environment
cargo test --manifest-path src-tauri/Cargo.toml environments
cargo test --manifest-path src-tauri/Cargo.toml agent_directories
bun tauri build --debug --no-bundle
```

浏览器测试需要安装 Playwright 与 Chromium；可通过 `PLAYWRIGHT_MODULE` 指定已有安装路径。测试覆盖中英日文、键盘选择、发行版与用户选择、自定义输入与浏览、失败回滚、持久化、空环境、探测错误及窄屏布局，截图保存在 `bin-work/environment-*.png`。

原生 Linux 桌面验收使用独立用户数据目录，在 Xvfb、窗口管理器及 D-Bus 会话中启动 `tauri-driver --port 4459 --native-port 4460`，再运行 `bun run test:desktop:agent-environment`。测试直接操作构建产物的 WebKit 窗口，调用真实探测命令，检查环境切换、自定义路径入口与响应式布局。`WEBDRIVER_URL` 和 `DESKTOP_BINARY` 可覆盖驱动地址与程序路径。

## Windows 实机验收

浏览器夹具不代替 Windows WSL 实机测试。在安装并启动发行版的 Windows 桌面上确认：

1. 发行版、普通用户与 root 用户可正确列出，两个 WSL 共享别名均可识别。
2. 选择用户后目录立即应用；嵌套目录使用一致的 Windows 路径分隔符。
3. 自定义非标准路径可保存，重新打开页面后仍保持 WSL 环境。
4. 对测试目录执行配置写入、备份和恢复，确认不会改写本地配置。
5. 停止发行版、取消访问权限或未安装 WSL 时，提示与重试正常。

已有 UNC 原子写入集成测试需要显式提供可写测试目录：

```powershell
$env:ECPA_TEST_WSL_CONFIG_ROOT = '\\wsl.localhost\Ubuntu\home\user\configuration-tests'
cargo test --manifest-path src-tauri/Cargo.toml atomic_configuration_write_replaces_existing_wsl_unc_file -- --ignored
```
