- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **Plugin update notice**: after startup, installed plugins are checked for newer releases in the background, and the Plugins entry in the sidebar shows the same amber light used by version management when updates are found. The check never installs automatically; you still update each plugin, or all of them, on the plugin page. Offline sources stay silent, and a found update is kept until the plugin is installed or removed.

## Improved

- **Plugin page layout**: the local plugin and store toolbars are now grouped, with the search field and action buttons wrapping onto separate rows in narrow windows. Plugin cards are wider, and card titles, identifiers and metadata share a consistent style.
- **Tag selection**: the tag filter keeps common tags apart from its picker, and the picker shows only the selected count and the tag name. Long tags can be read in full on hover.

## Fixed

- **Gemini quota group**: the Gemini model group now shows a group summary instead of listing each model name.
- **Saved Claude Desktop 1M context flags cleared**: changing other settings or reloading the configuration now keeps the saved 1M context checkbox of each model row instead of resetting it.