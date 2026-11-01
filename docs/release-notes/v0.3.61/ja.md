- アプリに関するご質問やご提案は、[QQ グループ](https://qm.qq.com/q/3queDaIG) または [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) までお寄せください。できる限り速やかに対応します。

## 新機能

- エージェント認証 API キーの個別選択と永続化：各エージェント設定で個別の認証 API キーを選択できるようになり、有効な既定キーへの自動フォールバックおよび多言語の国際化に対応しました（[#544](https://github.com/router-for-me/EasyCLIProxyAPI/pull/544)、[#545](https://github.com/router-for-me/EasyCLIProxyAPI/pull/545)）。
- ZCode エージェントのモデルカタログとサブエージェント設定：ZCode のモデルカタログ選択ダイアログとサブエージェント（Sub-agent）設定パネルを新たに追加し、複数段階の推論レベル（reasoning levels）および Spark 1M コンテキスト仕様に対応しました。

## 不具合修正

- Windows 環境における CLI 起動の修正：Windows 環境でグローバルに npm インストールされた CLI shims の起動が失敗またはクラッシュする問題を修正しました。
- Claude Desktop のエイリアスマッチングとルーティングの修正：特定のプロバイダーエイリアスが無効化または除外されている場合に、プライマリモデルへ正しくフォールバックされない問題を修正しました。
- ZCode 設定の永続化とスキーマ準拠の修正：`maxOutputTokens` が Zod スキーマに厳密に準拠するよう改善し、モデルカタログ選択、トークン制限の継承、設定保存時の借用競合および状態同期の問題を修正しました。
- UI レイアウトと操作性の最適化：ZCode サブエージェントダイアログのレイアウトやサイドバーのスクロールバー表示を最適化し、モデルカタログ設定の保存後にダイアログを自動で閉じるようにしました。
