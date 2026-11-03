- アプリについてご質問やご提案がある場合は、[QQ グループ](https://qm.qq.com/q/3queDaIG) または [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) までお知らせください。できるだけ早く対応いたします。

## 修正

- **Agent 使用記録の読み取り失敗の誤表示**: Agent 使用記録ページ上部に表示され続けていた警告バナー（例: `Copilot CLI: Unable to read local usage records`）を修正しました。これまでは Copilot ディレクトリ全体を走査して無関係な設定ファイルまで解析していたため、1 つのファイルが読めないだけでソース全体が失敗扱いになっていました。現在は Copilot の session-state ディレクトリのみを読み取り、解析できない過去のファイルは同期エラーとして扱わないため、ステータスはエラーではなく待機状態に戻り、警告バナーも表示されません。
