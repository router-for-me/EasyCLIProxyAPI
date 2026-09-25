## Improved

- Automatically upgrade to the bundled core on launch: If the installed core version is older than the version bundled with the app, CPA now automatically installs the bundled core and restores its runtime state (previously, this only ran when no core was installed).
- Renamed “Advanced Settings” to “Advanced Features” across navigation and API Access.

## Fixed

- Fixed app updates potentially using cached responses or stale task state by adding cache-busting headers to update requests and refreshing release metadata before starting a download.

---

## Included from v0.3.3

### Added

- Added a separate proxy URL setting for each API connection in API Access and Easy Mode. It supports HTTP, HTTPS and SOCKS5 proxies.
- Model prices in Usage Records can now be fetched from Models.dev or LiteLLM. Preview matches, edit prices, and select which models to save before applying an update. Existing manually entered prices are unselected by default.

### Improved

- Updated bundled model prices with entries for GPT-6 Sol, GPT-6 Luna, Grok 4.7, and more.
- Refined cost estimates for cache reads, cache creation, and long contexts. Missing cache prices are no longer inferred automatically.
- Updated the bundled core to 7.3.17.
