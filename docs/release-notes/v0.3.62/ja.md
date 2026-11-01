- アプリに関するご質問やご提案は、[QQ グループ](https://qm.qq.com/q/3queDaIG) または [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) までお寄せください。できる限り速やかに対応します。

## 新機能

- アカウントのカスタムタグと一括グループ管理：OAuth / 認証情報アカウントにカスタムタグ（`tags`）を設定できるようになり、アカウントカードにタグバッジを表示し、一覧でのタグ絞り込みに対応しました。一括管理ダイアログからタグごとにグループ全選択を行い、一括有効化・無効化・更新・削除を実行できます（[#546](https://github.com/router-for-me/EasyCLIProxyAPI/issues/546)）。

## 不具合修正

- アニメテーマにおけるモデル選択ドロップダウンのズレとレイアウトシフトの修正：アニメ（ライト）/ 画像背景テーマにおいて、`backdrop-filter` が包含ブロックを形成することでエージェントモデル選択ドロップダウン（`AgentModelPicker`）が画面右下にズレる問題を修正しました。包含ブロックの `offsetParent` 座標補正を追加し、セカンダリタブや見出しの余白の乱れを解消しました（[#543](https://github.com/router-for-me/EasyCLIProxyAPI/pull/543)）。
