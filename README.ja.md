<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <strong>日本語</strong>
</p>

<p align="center">
  <img src="src/assets/logo.jpg" width="112" alt="Easy_CLIProxyAPI Logo">
</p>

<h1 align="center">Easy_CLIProxyAPI</h1>

<p align="center">
  私たちの目標は、トークンを free（無料ではなく、自由という意味）にすることです。<br>
</p>

> [!IMPORTANT]
> このリポジトリは正式版です。より先進的で実験的な機能については、[lzt404/Easy_CLIProxyAPI](https://github.com/lzt404/Easy_CLIProxyAPI) をご覧ください。

## 概要

Easy_CLIProxyAPI は、[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) をベースにしたポータブルツールです。コア、OAuth アカウント、API 接続、モデルルーティング、認証ファイル、クォータ情報、使用履歴、エージェントクライアント設定をグラフィカルなインターフェースから管理できます。

本アプリケーションは Tauri、React、Rust で構築されています。

## 主な機能

- OAuth アカウントログイン
  - Codex、Claude、Gemini などのアカウントログインに対応

- API 統合管理
  - OpenAI、Claude、Gemini などのプロトコルを使用した API Key 接続に対応

- API フォーマット変換
  - OpenAI、Claude、Gemini などのプロトコル間でリクエストとレスポンスの形式を相互変換

- エージェントクライアント設定
  - Claude Code、Claude Desktop、Codex、OpenCode、OpenClaw、Hermes Agent などの主要なエージェントクライアントを自動設定

## 対応プラットフォーム

現在、GitHub Actions では以下のポータブルリリースパッケージを生成しています。

| OS | アーキテクチャ |
| --- | --- |
| Windows | amd64、aarch64 |
| Linux | amd64、aarch64 |
