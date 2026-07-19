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
  Our goal is to make tokens free—as in freedom.<br>
</p>


## Overview

EasyCLIProxyAPI is a portable tool built on [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). It provides a graphical interface for managing the core, OAuth accounts, API providers, model routing, authentication files, quota information, usage records, and agent client configurations.

The application is built with Tauri, React, and Rust.

## Key Features

- OAuth account sign-in
  - Supports signing in with Codex, Claude, Gemini, and more

- API aggregation management
  - Supports API Key integrations using OpenAI, Claude, Gemini, and other protocols

- API format conversion
  - Converts request and response formats between OpenAI, Claude, Gemini, and other protocols

- Agent client configuration
  - Automatically configures popular agent clients including Claude Code, Claude Desktop, Codex, OpenCode, OpenClaw, and Hermes Agent

## Supported Platforms

GitHub Actions currently produces the following portable release packages:

| Operating System | Architecture |
| --- | --- |
| Windows | amd64, aarch64 |
| Linux | amd64, aarch64 |
