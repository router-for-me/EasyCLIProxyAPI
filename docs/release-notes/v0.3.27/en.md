## v0.3.27 Release Notes

- Suggestions and issue reports are welcome in the community chat or on GitHub.
- This release adds Oh My Pi support, substantially improves Claude Code configuration, and makes quota and desktop UI behavior more reliable.

## Added

- Added Oh My Pi as a managed agent client through the OpenAI Responses API. CPA discovers available models dynamically, applies the managed provider and model settings, and backs up and restores the original Oh My Pi configuration.
- Added persistent desktop theme preferences for Light, Dark, and System modes.

## Improved

- Claude Code model settings now follow Claude Code's model structure, with independent startup and Subagent models, per-role model mappings, and 1M context options.
- Claude Code runtime settings are persisted correctly and managed configuration is cleaned up safely when management is disabled or restored.
- Grok quota reporting now keeps weekly and monthly usage aligned, identifies subscription tiers more accurately, and displays prepaid balances when available.
- Usage request rows now size themselves to their content. Credential cards and action controls are more compact and avoid overlapping content.
- Updated the bundled CLIProxyAPI core to **8.0.20**.

## Fixed

- Fixed Claude Code model selectors and credential quota panels that could overlap or display incomplete information.
- Fixed Grok quota cache enrichment so subscription details do not overwrite newer quota results.
- Credential action buttons now use neutral styling for clearer status feedback.
