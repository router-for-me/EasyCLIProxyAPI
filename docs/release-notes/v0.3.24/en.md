## v0.3.24 Release Notes

- This release continues the improvements to usage records and kernel configuration management. Suggestions and issue reports are welcome in the community chat or on GitHub.

## Added

- Added a Usage Records “Display Settings” panel. Users can choose visible columns and enable fixed record row heights. When enabled, the row height can be adjusted with a draggable slider; when disabled, rows fit their content automatically.
- Usage Records pagination, visible columns, and column widths are now saved in the application data directory and restored after app updates.

## Improved

- Standardized the management-key wording as “Management Key” and “web management console” across the Chinese, English, and Japanese interfaces.
- When the management key cannot be read or recovered as usable plaintext, the application uses `123456` as the recovery value and synchronizes it between GUI requests and the kernel configuration.
- Clarified the Usage Records toolbar with “Show columns” and “Reset Widths” actions.

## Fixed

- Fixed startup failures after the v8 core rewrote the management key as a bcrypt/argon2 hash and the GUI tried to write its plaintext value back into the configuration.
- Fixed valid v8 configurations producing a duplicate top-level `management` mapping during startup, preventing the kernel from starting ([Issue #351](https://github.com/router-for-me/EasyCLIProxyAPI/issues/351)).
- Fixed Usage Records display settings being reset to defaults after an application update.
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
