## v0.3.21 Release Notes

- We are currently improving the UI. Suggestions and feedback are welcome in the community chat or on GitHub.

## Added

- Added quota reset support for Claude accounts.

## Improved

- Improved the quota lookup page UI.

## v0.3.20 Release Notes

## Added

- Added plugin management and a plugin store with installation, updates, version selection, enable/disable controls, removal, configuration editing, and plugin-provided OAuth authorization.
- Added Muse (Meta) OAuth device authorization and detection and launch support for DeepSeek Harness Desktop on Windows.
- Added custom system prompts for Codex models, with synchronization to the model catalog on save and an option to restore model defaults.
- Added batch model health checks. Request records now show the actual response model and flag differences between requested and response models.
- Added per-request cost estimates and CSV export. Reasoning effort is now shown by default to help review usage and troubleshoot requests.

## Improved

- Updated the bundled CLIProxyAPI core to **8.0.13** and aligned management API calls and configuration editing with v8.
- Redesigned the dashboard, usage analytics, and main management pages with consistent light-theme surfaces, navigation, and tables, better dark-mode contrast, and improved layouts for narrow windows.
- Reworked credential management into a compact list showing plans, status, request statistics, and quotas, with pagination, enable/disable controls, expandable details, and improved cooldown countdowns and reset controls.
- Expanded structured settings for requests, OAuth, plugins, concurrency, and providers, with improved search, validation, conflict warnings, default restoration, and restart notices.
- Added support for native v8 provider groups and individual credential editing, removal, and reordering in API access. Model aliases now have a dedicated tab.
- Added client search, pagination, and saved visibility preferences, expanded installation-path detection, and prioritized installed clients.
- Added “Install Bundled Core” to version management to install directly from the local core archive included with the app.

## Fixed

- Fixed migration of v7 and mixed-format configurations to v8, improved preservation of keys, providers, model aliases, and custom fields, and prevented external refreshes from overwriting unsaved settings drafts.
- Fixed cooldown states being mixed up for same-named credentials from different accounts and OAuth model exclusion updates affecting other providers.
- Fixed cost aggregation for requests with different context lengths and clarified how much usage is covered by cost estimates.
- Fixed model alias source validation and inconsistent use of Codex model IDs, and preserved installed plugins and runtime data when rebuilding portable distributions.
