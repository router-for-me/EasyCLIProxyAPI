<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <strong>日本語</strong>
</p>

<p align="center">
  <img src="src/assets/logo.jpg" width="112" alt="EasyCLIProxyAPI Logo">
</p>

<h1 align="center">EasyCLIProxyAPI</h1>

<p align="center">
  CLIProxyAPI のポータブルデスクトップコンソール。<br>
  私たちの目標は、トークンを free（無料ではなく、自由という意味）にすることです。
</p>

## 概要

EasyCLIProxyAPI は、[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
をベースにしたグラフィカルなデスクトップ管理ツールです。コアのライフサイクル管理、OAuth 認証、
API プロバイダー統合、プロトコル変換、認証情報管理、クォータ確認、使用履歴、モデルエイリアス、
エージェントクライアント設定を一つの画面にまとめます。

本アプリケーションは Tauri、React、Rust で構築されています。対応する CLIProxyAPI コアの
アーカイブを同梱できるため、初回セットアップやオフラインインストールも簡単です。

## 機能紹介

### コアダッシュボードとバージョン管理

![コアダッシュボードとバージョン管理](docs/images/1.png)

コア画面では、ローカルプロキシの状態確認と操作を一か所で行えます。

- CLIProxyAPI コアの起動、停止、再起動、状態更新。
- インストール状態、実行状態、プロセス ID、待受ポート、LAN アクセス設定の確認。
- インストール済み、最新、アプリ同梱のコアバージョンを比較。
- 最新版のインストール、再インストール、または GitHub に接続できない場合のオフラインインストール。
- OpenAI、Claude、Gemini 互換の API エンドポイントをそのままコピー。
- EasyCLIProxyAPI のバージョンとローカル接続状態を同じ画面で確認。

### OAuth アカウント認証

![OAuth アカウント認証](docs/images/2.png)

OAuth 画面では、対応プロバイダーのブラウザー認証をまとめて管理できます。

- Codex OAuth
- Claude OAuth
- Antigravity OAuth
- Kimi OAuth
- xAI OAuth

EasyCLIProxyAPI はブラウザーで認証ページを開きます。自動リダイレクトが利用できない場合は、
コールバックを手動で完了することもできます。

### API プロバイダー統合

![API プロバイダー統合](docs/images/3.png)

API 接続画面では、プロトコルまたはプロバイダーごとに上流 API の認証情報と接続先を管理できます。

- Codex
- OpenAI 互換プロバイダー
- DeepSeek
- Claude
- Gemini

複数の接続設定を追加し、既存設定の検索やプロバイダー状態の更新を行えます。すべての接続は、
統一されたローカル CLIProxyAPI エンドポイントから利用できます。リクエストとレスポンスは、
OpenAI、Claude、Gemini、およびその他の互換形式の間で変換できます。

### エージェントクライアント設定

![エージェントクライアント設定](docs/images/4.png)

エージェント画面は、インストール済みのデスクトップクライアントと CLI クライアントを検出し、
ローカルプロキシへの接続を支援します。対応クライアントは次のとおりです。

- Claude Code
- Claude Desktop
- Codex
- OpenCode
- OpenClaw
- Hermes Agent

対応クライアントでは、利用可能なモデルカタログの同期、デフォルトモデルの選択、管理設定を適用する前の
元設定のバックアップ、以前の設定への復元、利用可能なデスクトップまたは CLI エントリーポイントの起動ができます。

## その他の機能

- コア設定、API Key、リモート管理用認証情報、プラグイン、ルーティング戦略の管理。
- クライアント向けモデルエイリアスを作成し、プロバイダーモデルや推論レベルへマッピング。
- 認証ファイルのアップロード、ダウンロード、確認、管理。
- プロバイダーのクォータとアカウント利用状態を確認。
- ローカルの使用履歴とトークン統計を閲覧。
- macOS メニューバーまたは Windows システムトレイからバックグラウンド動作を継続。

## クイックスタート

1. [GitHub Releases](https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest)
   から、お使いの OS に対応するパッケージをダウンロードします。
2. Windows または Linux のアーカイブを展開します。macOS では DMG を開きます。
3. EasyCLIProxyAPI を起動します。
4. **コア** 画面を開き、同梱版または最新版の CLIProxyAPI コアをインストールします。
5. コアを起動し、必要なローカル API エンドポイントをコピーするか、OAuth/API プロバイダーを設定します。

## 対応プラットフォーム

GitHub Actions では、次のリリースパッケージをビルドします。

| OS | アーキテクチャ | 形式 |
| --- | --- | --- |
| Windows | amd64、aarch64 | ZIP |
| macOS | amd64、aarch64 | DMG |
| Linux | amd64、aarch64 | TAR.GZ |

## 関連プロジェクト

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — 本アプリケーションが管理するプロキシコアです。
