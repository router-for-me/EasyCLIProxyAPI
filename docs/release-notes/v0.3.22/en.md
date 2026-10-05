## v0.3.22 Release Notes

- The project is currently improving its UI. Suggestions and feedback are welcome in the community chat or on GitHub.

## Added

- Added quota reset support for Claude accounts.

## Fixed

- Fixed layout issues on the quota lookup page.

## v0.3.21 Release Notes
## Added

- Added plugin management and a plugin store with support for installation, updates, version selection, enabling and disabling, uninstallation, configuration editing, and OAuth authorization provided by plugins.
- Added Muse (Meta) OAuth device authorization, along with support for detecting and launching DeepSeek Harness Desktop on Windows.
- Added support for custom system prompts for Codex models. Saved prompts are synchronized to the model catalog, and model defaults can be restored.
- Added batch model health checks. Request records now show the actual response model and flag cases where it differs from the requested model.
- Added per-request cost estimates and CSV export to request records. Reasoning effort is shown by default to make usage review and troubleshooting easier.

## Improved

- Updated the bundled CLIProxyAPI core to **8.0.13** and adapted the management API and configuration editor for v8.
- Redesigned the dashboard, usage analytics, and main management pages with a consistent light theme, navigation, and table styling; improved dark-mode contrast and narrow-window layouts.
- Reworked credential management into a compact list showing plans, status, request statistics, and quotas, with pagination, enable/disable controls, expandable details, and improved cooldown countdowns and reset operations.
- Added more structured settings for requests, OAuth, plugins, concurrency, and providers; improved search, validation, conflict warnings, restoring defaults, and restart notices.
- Added support in API access for native v8 provider groups and per-credential editing, deletion, and reordering. Model aliases are displayed in a separate tab.
- Added search, pagination, and saved display preferences to the client list; expanded installation-path detection and prioritized installed clients.
- Added “Install Bundled Core” to version management, allowing direct installation from the local core package included with the application.

## Fixed

- Fixed migration from v7 to v8 and migration of mixed-format configurations; improved preservation of keys, providers, model aliases, and custom fields, and prevented external refreshes from overwriting unsaved configuration drafts.
- Fixed cooldown states being mixed up for same-named credentials from different accounts, and fixed OAuth model-exclusion updates affecting other providers.
- Fixed cost aggregation when requests with different context lengths are combined, and improved the display of the coverage of cost estimates.
- Fixed model-alias source validation and inconsistent Codex model ID usage; installed plugins and runtime data are now preserved when rebuilding portable distributions.
