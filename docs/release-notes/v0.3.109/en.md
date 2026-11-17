If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **ACP access (Antigravity)**: the OAuth page has a new ACP Access tab. Sign in to the Antigravity CLI with official Google authorization, save several accounts and switch between them — all accounts share one CLI while login state is stored per account. After connecting you can send one test message to verify a model; enabling API access registers the account's models as `acp/<model-id>` under a reserved OpenAI-compatible provider, callable with your existing CPA endpoint and key. The tab also carries CLI detection and install entry points, the current account identity and connection details.
- **Thinking levels for ACP**: `reasoning_effort`, `reasoning.effort` and `thinking.effort` are resolved to the official model's matching level variant, with levels detected from official model ID suffixes. A model without declared levels, an unknown level or conflicting values returns an explicit error instead of being ignored. The ACP provider does not write thinking-level declarations automatically; levels stay configured manually the usual CPA way.
- **Multi-turn chat for ACP**: the bridge now accepts `system`, `user` and `assistant` messages and flattens the history into one prompt as `System:` / `User:` / `Assistant:` blocks, because each request uses a separate official CLI session. The last message must come from the user. A single user message is still passed through verbatim.

## Improved

- **ACP card layout**: the two cards on the access page are now equal height, and the disconnected state is a compact lock state with an icon and explanation instead of a dashed box inside a box. When connected or with the API enabled, the heading icon switches to the success colour, the card lifts slightly on hover, and buttons wrap on narrow widths.

## Fixed

- **Health probe budget**: the probe request budget is higher, and an exhausted generation budget is reported as its own distinct reason instead of being lumped in with other failures.
- **New Gemini Interactions event names**: the health check only recognised the legacy `content.delta` / `interaction.complete` events and only read text from `interaction.outputs`, so a valid stream using `step.delta` / `interaction.completed` / `steps` was reported as missing its first token. Both event generations are accepted now, completion text is read from `steps` or `outputs`, a missing status counts as success, and failed or cancelled statuses are rejected explicitly.
- **Alias sync with multi-word keys**: alias and agent YAML updates went through `yaml_serde_edit`, whose transitive parser truncated mappings at unquoted multi-word plain keys, so legitimate edits during One-Click Connect were reported as a compatibility-check failure. Every related path now uses `serde_norway` parsing and the `yaml-edit` renderer, and multi-word alias keys sync correctly again.
