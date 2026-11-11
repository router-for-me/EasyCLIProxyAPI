If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **Import custom themes**: choose a ZIP archive or a theme folder in the theme picker. Replacing an existing theme folder requires confirmation.
- **Edit system prompts for supported agents**: customize the default prompt or set per-model overrides for ZCode and other supported agents. Prompt rewriting is blocked when the core uses TLS so the connection is not downgraded to plain HTTP; existing overrides can still be cleared.
- **Antigravity suspension settings**: the desktop app now bundles core 8.0.78 and exposes the protective pause window for terms-of-service suspensions. Active suspensions offer an appeal link when one is available.

## Improved

- **Automatic updates are part of the Desktop App card**: app and core targets are hidden until the switch is turned on, and a short hint explains background downloads and installation on the next launch. Core updates can still be configured when app auto-updates are unavailable. Startup behavior is unchanged.
- **Catch up on skipped releases**: when checking for a stable update, the app shows available notes for skipped versions alongside the latest notes.
- **See where requests came from and where they went**: Live Routing groups recorded paths by client, model, and credential, and lets you pin a recent completed request for inspection. Session affinity also has a “Never rebind” option to keep an established session on its original credential.
- **Review and edit model prices more easily**: searchable cards show manual, synced, and missing prices, plus how many requests are covered by prices. A side panel edits per-million-token rates, and price sync lets you choose which models to update.
- **See why an agent cannot connect**: the disabled connect action now explains blockers such as missing model mappings or an unsupported platform.

## Fixed

- **Credential suspension history survives a restart**: past Antigravity suspensions can be distinguished from active ones, and lengthy details are shown separately instead of crowding the status badge.
