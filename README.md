<p align="center">
  <strong>English</strong> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="src/assets/logo.jpg" width="112" alt="EasyCLIProxyAPI Logo">
</p>

<h1 align="center">EasyCLIProxyAPI</h1>

<p align="center">
  A portable desktop console for CLIProxyAPI.<br>
  Our goal is to make tokens free—as in freedom.
</p>

## Overview

EasyCLIProxyAPI is a graphical desktop management tool built on
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). It brings core lifecycle management,
OAuth authorization, API provider aggregation, protocol conversion, credential management,
quota inspection, usage records, model aliases, and agent client configuration into one interface.

The application is built with Tauri, React, and Rust. It can carry a matching CLIProxyAPI core
archive, making first-time setup and offline installation easier.

## Feature Tour

### Core dashboard and version management

![Core dashboard and version management](docs/images/1.png)

The core dashboard provides a complete view of the local proxy runtime:

- Start, stop, restart, and refresh the CLIProxyAPI core.
- View installation state, runtime state, process ID, listening port, and LAN access settings.
- Compare the installed, latest, and bundled core versions.
- Install the latest core, reinstall it, or use an offline package when GitHub is unavailable.
- Copy ready-to-use OpenAI, Claude, and Gemini-compatible API endpoints.
- Check the EasyCLIProxyAPI application version and local connectivity from one page.

### OAuth account authorization

![OAuth account authorization](docs/images/2.png)

The OAuth page centralizes browser-based authorization for supported providers:

- Codex OAuth
- Claude OAuth
- Antigravity OAuth
- Kimi OAuth
- xAI OAuth

EasyCLIProxyAPI opens the authorization page in the browser and supports completing the callback
flow when an automatic redirect is unavailable.

### API provider aggregation

![API provider aggregation](docs/images/3.png)

The provider workspace manages upstream API credentials and endpoints by protocol or provider:

- Codex
- OpenAI-compatible providers
- DeepSeek
- Claude
- Gemini

You can add multiple connections, search existing entries, refresh provider state, and use them
through the unified local CLIProxyAPI endpoint. Requests and responses can be converted between
supported OpenAI, Claude, Gemini, and compatible formats.

### Agent client configuration

![Agent client configuration](docs/images/4.png)

The agent client page detects installed desktop and CLI clients and helps connect them to the
local proxy. Supported clients include:

- Claude Code
- Claude Desktop
- Codex
- OpenCode
- OpenClaw
- Hermes Agent

For supported clients, the application can synchronize the available model catalog, select a
default model, back up the original configuration before applying managed settings, restore the
previous configuration, and launch an available desktop or CLI entry point.

## Additional Capabilities

- Manage core settings, API keys, remote management credentials, plugins, and routing strategy.
- Create client-visible model aliases and map them to provider models and reasoning levels.
- Upload, download, inspect, and manage authentication files.
- Review provider quotas and account availability.
- Browse local usage records and token statistics.
- Keep the application available from the macOS menu bar or Windows system tray.

## Quick Start

1. Download the package for your operating system from
   [GitHub Releases](https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest).
2. Extract the Windows or Linux archive, or open the macOS DMG.
3. Launch EasyCLIProxyAPI.
4. Open the **Core** page and install the bundled or latest CLIProxyAPI core.
5. Start the core, then copy the required local endpoint or configure an OAuth/API provider.

## Supported Platforms

GitHub Actions builds the following release packages:

| Operating System | Architecture | Package |
| --- | --- | --- |
| Windows | amd64, aarch64 | ZIP |
| macOS | amd64, aarch64 | DMG |
| Linux | amd64, aarch64 | TAR.GZ |

## Related Project

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — the proxy core managed by this application.
