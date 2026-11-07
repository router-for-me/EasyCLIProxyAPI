This release makes the plugin centre usable out of the box, fixes installing plugins from the store and the missing upgrade prompt after switching update channels on a formal build, and ships the newest bundled kernel while routing manual downloads through the mirror you selected.

If you hit problems, tell us on [Discord](https://discord.gg/your-discord-invite) or open an issue on [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Added

- **ECPA featured plugins work out of the box**: opening the Plugins page now registers the ECPA source automatically, so there is no longer a button to press or a permanent "source registered" banner. Loading, empty and error states on the featured tab were reworked so an unavailable source explains why instead of just saying the plugin was not found.
- **Plugin store installs through registered sources**: featured plugins now go through the shared install flow with progress, failure reasons and installed state.
- **Model alias creation form**: aliases can be created in the UI by picking the original model and a speed mode, with the alias generated for you instead of hand-editing config.
- **Quota account notes**: quota rows can carry a note, and the editor is now an inline underlined field where adding and clearing both happen in place instead of behind a dialog.
- **Batch Codex model visibility**: several models can be enabled or hidden at once, and the quota page gained a compact view.

## Fixed

- **No upgrade button after switching update channels**: timestamped builds use versions like `0.3.6-preview.20261106-1137`, which semantic versioning always ranks below `0.3.6`, so switching a formal build to another update channel reported "no update available" and only offered a download button. These builds are now recognised as a newer version, so the in-app upgrade appears after switching channels.
- **Manual downloads ignored the selected download source**: the download button opened the raw GitHub asset URL from the manifest, so the selected mirror only affected version-list fetching. The download link now applies the selected mirror prefix.
- **No settings entry from the plugin centre**: the GitHub token used to be entered in a collapsible panel on the plugins page. A lightweight text link now jumps straight to Settings → Server → GitHub token, and rate-limit hints point there too.
- **The plugin card link button was too small**: it was a tiny icon button and is now a normal button with a visible label and a hit area of at least 32px.
- **The routing confirmation dialog did not match the rest of the app**: applying routing changes opened a plain sequential form. It now uses the same dialog as the close-window prompt, with a bordered change list, aligned rows and the actions in a fixed footer.
- **Usage charts clipped wide axis labels**: labels such as currency-prefixed ticks were cut off at the chart edge. The gutter is now sized from the widest label in the current locale.
- **ZCode preset validation failed**: the `maxOutputTokens` option spec carried an invalid map field that broke config validation for that provider. It has been removed.

## Improved

- **Bundled kernel updated to 8.0.58**: release packages now carry the newest kernel, so a fresh install runs on it from the first launch.
- **DeepSeek Harness default sensitive words**: Devin's default sensitive word list now includes DeepSeek Harness.
- **Clearer channel explanation**: the version page's description of formal versus timestamped builds was rewritten, and builds are distinguished by build time.