- アプリに関するご質問やご提案は、[QQ グループ](https://qm.qq.com/q/3queDaIG) または [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) までお寄せください。できる限り速やかに対応します。

## 不具合修正

- **OpenCode における画像貼り付けおよび添付ファイルのサポート**：OpenCode 設定ファイルで生成されるカスタムプロバイダーの各モデルに対して、`attachment` および `modalities` フィールドを出力するようにしました。マルチモーダルモデルには `text`、`image`、`pdf` の入力サポートを宣言し、画像生成モデルには `image` を含む出力機能を宣言することで、カスタムプロバイダーがテキスト専用として扱われ、画像の貼り付けや添付ファイルの送信がクライアント側でブロックされる問題を修正しました（#567）。
