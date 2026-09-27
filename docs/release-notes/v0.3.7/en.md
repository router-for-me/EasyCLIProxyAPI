## Added

- Added a system tray on Linux. Open the main window, view core status, start or stop the core, restart it, or quit from the tray. Closing to the tray and silent startup are also supported.

## Improved

- Updated the bundled core to 8.0.2. The app now supports the v8 configuration layout and Management API for reading and saving API providers, access keys, OAuth model aliases, request settings, and related data.
- Improved layouts in narrow windows. Language menus, page tabs, dialogs, and Usage Records now have better keyboard controls, focus handling, and accessibility labels. Usage Records column widths can also be changed with the keyboard.
- English is now the default when the system language is not supported. Previously hardcoded Chinese backend messages now use English, while tray menus follow the app language.

## Fixed

- Fixed failures when optional v8 configuration nodes are absent. Improved first-time model alias creation and rollback after a failed save so empty parent nodes are not mistaken for unrelated changes.
- Fixed Claude Code triggering server-side auto mode checks when used through a CPA gateway.
- Fixed a macOS upgrade issue where a legacy relative OAuth directory setting could hide existing credentials. If the relative directory has no credentials and the persistent directory does, the app automatically uses the existing credentials again.
- Kept the main window available when a Linux system tray is unavailable, preventing silent startup or minimizing from leaving the app inaccessible.

## Development

- Added a browser mock mode for developing, previewing, and checking the UI without running the desktop core.
