## Added

- Added a unified credential settings dialog for model prefixes, proxy URLs, priorities, scheduling weights, exponential cooldown, WebSockets, excluded models, custom request headers, and notes. Saving updates only changed fields, and closing the dialog warns about unsaved changes.
- Added request statistics to credential cards, showing success and failure counts. When recent data is available from the core, cards also show the success rate over the last 200 minutes and request details for each 10-minute interval.
- Added credential health and cooldown details, including error reasons, cooldown countdowns for credentials or individual models, HTTP status codes, and estimated cooldown end times. Countdowns use data supplied by the core; refresh the list after a countdown ends to confirm the latest status.
- Added Codex quota resets to credential management. When a credential supports resets and has reset credits available, you can reset its quota directly from the card, with the same confirmation and result feedback as the quota page.

## Improved

- Replaced the credential list with responsive cards. Progress bars show remaining quota alongside reset times, subscription details, and reset credits. Notes now appear above the action buttons, making multiple accounts easier to browse and manage.
- Standardized font sizes, weights, and line heights, improved font selection for different languages, and refined text hierarchy in credential cards, dialogs, and usage tables.
- Improved text contrast in light and dark themes, making supporting text, input placeholders, and table content easier to read.

## Fixed

- Fixed credential settings and enable/disable actions being available for API connections or runtime entries. These actions now apply only to OAuth credential files. The OAuth model exclusion provider list also includes only providers with OAuth credential files and clarifies that exclusions do not affect API connections.
- Fixed agent model selection failing in WebKit environments, including macOS, when clicking an option dismissed the picker before the selection took effect.
- Fixed the macOS menu bar icon not respecting the system's show/hide settings, with support for remembering its visibility state.
