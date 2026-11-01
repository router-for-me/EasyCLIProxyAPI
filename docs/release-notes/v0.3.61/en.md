- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Added

- Independent Agent Authentication API Key Selection & Persistence: Support selecting an individual authentication API key for each agent configuration, with automatic fallback to the effective default key and full internationalization ([#544](https://github.com/router-for-me/EasyCLIProxyAPI/pull/544), [#545](https://github.com/router-for-me/EasyCLIProxyAPI/pull/545)).
- ZCode Agent Model Catalog & Sub-agent Configuration: Added a model catalog picker dialog and sub-agent settings panel for ZCode, supporting multiple reasoning levels and Spark 1M context window specification.

## Fixed

- Windows CLI Launch Fix: Fixed an issue where launching globally npm-installed CLI shims failed or crashed on Windows.
- Claude Desktop Alias Matching & Routing Fix: Fixed an issue where the client failed to fall back to the primary model when specific provider aliases were disabled or filtered out.
- ZCode Configuration Persistence & Schema Conformance: Ensured `maxOutputTokens` strictly adheres to the Zod object schema, and resolved issues with catalog selection, token limit inheritance, borrow conflicts, and state synchronization during settings save.
- UI Layout & Interaction Refinements: Optimized the ZCode sub-agent dialog layout, refined the sidebar scrollbar experience, and automatically close the model catalog dialog after saving.
