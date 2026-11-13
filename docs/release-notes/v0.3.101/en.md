- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Fixed

- **Request Details column preferences**: In Usage → Request Details, deliberately hiding the Key column now persists across tab changes, navigation away and back, and app restarts. Valid saved selections are no longer reset to defaults; new installations retain the 10 default columns.
- **ZCode provider configuration**: Remove stale and duplicate model entries while preserving saved selections and ordering. Invalid context/output limits and empty or duplicate reasoning levels no longer cause custom providers to disappear.
- **Codex sign-in switching**: Switching between API-key and OAuth sign-in preserves the selected profile's settings. Closing managed configuration restores the original profile and credential-storage preference.
