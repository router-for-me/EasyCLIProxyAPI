- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **On-demand model catalog refresh**: the homepage now has a refresh button so the model catalog is fetched when you ask for it, instead of syncing periodically in the background. Fewer wasted requests and less waiting in the UI.

## Fixed

- **Codex catalog sync no longer runs in the background**: the background catalog sync is gone; it is triggered by the manual homepage refresh, so your model list is not rewritten without you noticing.
- **No more unsupported model toggles for OpenAI-compatible providers**: the API access page now hides the toggle for providers that do not support it, instead of leaving the setting in a meaningless state.
- **Update checks and downloads use the selected source**: both now honour the download source you picked, so checking and downloading can no longer use different sources.
- **ZCode save flow aligns with the Codex catalog**: ZCode catalog saving and persistence now behave like Codex, and gains the ultra reasoning level.

## Changed

- **Cleaner auth file card actions**: card actions stay tidy, with model exclusions now managed centrally in the settings dialog.
