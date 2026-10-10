## Improved

- Claude Code now displays models as “Role · model name,” adds a `[1m]` marker for models with 1M enabled, and clearly shows the auto-compaction window size.
- Added a “Use model aliases” filter to Claude Desktop model mappings to switch between original models and aliases.

## Fixed

- Fixed one-click setup reporting `OpenCode is not installed` after manually selecting the OpenCode desktop executable ([#389](https://github.com/router-for-me/EasyCLIProxyAPI/issues/389)). Applying, updating, and enabling agent configurations now respects the configured executable paths.
- Fixed Pi plugin installation, updates, and uninstallation ignoring the manually configured CLI path.
- Fixed original models being hidden in Claude Code and Claude Desktop when aliases existed. Disabling “Use model aliases” now keeps all available original models searchable and selectable. This fix applies to all models.
- Fixed enabling 1M in Claude Code overwriting a custom auto-compaction window. The default 200K / 1M values still follow the toggle; other custom values are preserved.
- Completed Claude Code context and auto-compaction window configuration writes to keep the related settings consistent.
- Fixed Fable not inheriting Sonnet’s 1M setting when falling back to Sonnet without a separate mapping.

---

## v0.3.30

## Added

- If you have any questions or suggestions about the software, please contact us on [Discord](https://discord.gg/PxvX4D9kgs) or submit them through [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), and we will address them as soon as possible.
- Agents with both a command-line program and a desktop app—Codex, OpenCode, and DeepSeek Harness—can now use separate paths. When automatic detection fails, launch and detection use the matching path.
- A model alias can now be shared by multiple sources. Identical aliases can be edited and deleted independently without overwriting one another.

## Improved

- Redesigned the sidebar with more compact navigation and a clearer current page. Beginner mode and contact are now plain entries, and the language and theme controls share one toolbar.
- Adjusted the model alias list so reasoning levels and Fast badges no longer shift the edit and delete buttons.
- The agent configuration page keeps the selected model. If a refresh temporarily omits it, the selection is not replaced by the first item, and the page notes that it is unavailable.
- The app update progress now shows only the current stage, so the progress text no longer repeats or jumps.
- Renamed session recovery to “Sync Historical Sessions,” and clarified that ChatGPT keeps each API’s conversations separate. Older conversations can be synced from Session Management.

## Fixed

- The API access page now remembers the last selected provider category.
- Saving a model alias now preserves unrelated configuration changes.
