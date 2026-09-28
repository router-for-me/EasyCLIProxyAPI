## Added

- Added a system tray on Linux. Open the main window, view core status, start or stop the core, restart it, or quit from the tray. Closing to the tray and silent startup are also supported.

## Improved

- Updated the bundled core to 8.0.3. The app now supports the v8 configuration layout and Management API for reading and saving API providers, access keys, OAuth model aliases, request settings, and related data.
- Improved layouts in narrow windows. Language menus, page tabs, dialogs, and Usage Records now have better keyboard controls, focus handling, and accessibility labels. Usage Records column widths can also be changed with the keyboard.
- English is now the default when the system language is not supported. Previously hardcoded Chinese backend messages now use English, while tray menus follow the app language.

## Fixed

- Fixed macOS updates losing access to OAuth credentials stored inside the old app bundle. Credentials and their logs are now recovered from the update backup into persistent storage. If configuration loading fails after an automatic update, startup stops so the updater can roll back instead of accepting default settings.
- Fixed core updates overwriting existing settings with v8 template defaults. Upgrades from v7 and updates to partially migrated v8 configurations now preserve existing settings, including the OAuth credential directory, port, and access keys.
- Fixed upstream API credentials being overwritten with client access keys during startup or access-key changes when a v8 configuration has no version marker.
- Core startup logs now append to existing output, preserving startup history when the core starts or restarts.
- Fixed failures when optional v8 configuration nodes are absent. Improved first-time model alias creation and rollback after a failed save so empty parent nodes are not mistaken for unrelated changes.
- Fixed Claude Code triggering server-side auto mode checks when used through a CPA gateway.
- Fixed a macOS upgrade issue where a legacy relative OAuth directory setting could hide existing credentials. If the relative directory has no credentials and the persistent directory does, the app automatically uses the existing credentials again.
- Kept the main window available when a Linux system tray is unavailable, preventing silent startup or minimizing from leaving the app inaccessible.
- Extended recovery of legacy relative OAuth credential directories to Windows and Linux, and improved path checks on macOS. Existing configuration and credentials are preserved if recovery fails.
- Corrected OAuth credential and core log directory resolution across platforms so opened directories and startup logs match the paths used by the core.
- Fixed TLS, logging, and OAuth directory settings being written to the wrong place when a configuration uses the v8 layout without a version marker. Updates to flow-style YAML mappings are now supported.
