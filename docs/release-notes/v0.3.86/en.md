- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **Russian interface**: the language list now includes Русский. The console, tray menu, plugin and template help tables, and the MCP & Skills page all switch to Russian without a restart.
- **Complete Russian dictionary**: every interface string is translated, so the Russian UI no longer falls back to English. Regional variants such as `ru-RU` and `ru-BY` normalize to Russian.
- **Russian release notes**: update manifests can carry `ru.md`, so version management switches to Russian notes with the interface. GitHub Release pages keep English first and Simplified Chinese second.

## Improved

- **Language order**: the selector lists 简体中文, 繁體中文, 日本語, English and Русский, and every entry keeps its native name.
- **Russian theme labels**: custom theme `name` and `description` accept `ru` translations, and theme lists follow the active interface language.
- **Terminology**: API Key, Base URL, Token, model and provider IDs stay in Latin script in Russian, matching how the Japanese interface handles them.

## Fixed

- **Russian branch caught up with the mainline**: added the 137 strings introduced since the last sync for agent arguments, quota, usage statistics and the plugin store, so Russian screens no longer show English fragments.
- **Release note tests**: the publication tests now match the live English-plus-Simplified-Chinese body rule and cover Russian manifests.
