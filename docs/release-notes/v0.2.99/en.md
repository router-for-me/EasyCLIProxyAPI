## Added

- The version management page now shows software release notes and the latest version's publication date.
- Release notes support Simplified Chinese, Traditional Chinese, English, and Japanese, following the interface language. Notes can be expanded or collapsed, with a link to the full release page. Missing translations show a notice instead of another language's content.

## Improved

- Improved horizontal scrolling in request details on the usage records page, fixing lag and content jumping back during rapid dragging. Scroll positions and ranges stay synchronized when resizing the window or columns, or changing visible columns.
- Updated logging guidance to explain which failed requests are recorded and remind users to turn off "Write logs to files" when no longer needed to avoid excessive storage use.

## Fixed

- Fixed saving Claude and Codex connections that share an API key and base URL but use different model mappings or priorities. Identical configurations are still rejected as duplicates. ([#276](https://github.com/router-for-me/EasyCLIProxyAPI/issues/276))
- Fixed interference between connections sharing an API key when editing, toggling, reordering, deleting, or managing remarks. Existing remarks are preserved and migrated, and actions target only the selected connection.
- Improved configuration restoration when disconnecting agent integrations, preserving settings users changed after connecting. Custom Claude Code subagent models and Claude Desktop Cowork network access settings are also preserved.
- Fixed removal of the provider configuration when restoring Codex's native configuration or disconnecting the integration, retaining the configuration needed by historical sessions.
