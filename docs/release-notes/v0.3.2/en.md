## Added

- Added official GPT-6 Sol and GPT-6 Luna templates to Codex model configuration in Agent Management.
- Added a Sensitive Words page in Advanced Settings for editing Antigravity and Devin system-prompt terms separately. Add, edit, or remove entries individually, or paste multiple lines at once.

## Improved

- Updated the Windows build script to detect and refresh stale Tauri build caches after moving the workspace. Use `-SkipCopy` to build without copying over a running portable app.
- Adjusted the quota reset countdown to show remaining days, hours, and minutes without rounding them up.

## Fixed

- Fixed old usage records remaining at the top of the list when multiple events from one request share the same request ID (#298).
