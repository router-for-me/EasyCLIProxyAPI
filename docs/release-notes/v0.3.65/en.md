- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Added

- **Automatic WSL Environment Detection & One-click Switcher**: Redesigned the configuration directory section under Agents → Configuration Management with a segmented switcher between Windows Local and WSL Subsystem; automatically scans installed WSL distributions and Linux user directories on Windows so selecting a distribution and user immediately applies the corresponding `\\wsl.localhost\<Distro>\home\<user>\...` configuration path without manual UNC path entry, while retaining an expandable custom path section for advanced overrides.
- **Flow-based Routing Orchestration Tier Ladder & Gateway Policy Sidebar**: Redesigned the Routing Orchestration page into a two-column workspace with a vertical request-flow tier ladder and a sticky gateway policy sidebar; displays primary serving, standby, and skipped tier states alongside per-credential traffic shares, provider brand icons, drag-to-gap tier creation, quick tier step/split buttons with `Alt + ↑/↓` keyboard shortcuts, and on-demand weight chips (`×1`) shown only under weighted round-robin routing.

## Fixed

- **Explicit Empty Key Prefix Override in Routing Orchestration**: Fixed an issue where a provider key that explicitly cleared an inherited group prefix (`prefix: ""`) still fell back to displaying the group prefix on routing cards.
