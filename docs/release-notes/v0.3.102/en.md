- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Fixed

- **Codex CLI discovery**: The Codex CLI now also resolves executables bundled with the desktop app, including packages installed through the Windows Store/MSIX, standalone Windows desktop resources, and macOS app bundles.
- **Codex CLI selection**: Candidates are now compared by semantic version instead of using the first usable one, so stale relocated caches are no longer chosen over a current install. When versions are equal, the standalone search-directory CLI is preferred, then the desktop bundle, then the legacy cache.
- **Stable and prerelease ordering**: A stable release outranks a prerelease only at the same core version, so a prerelease with a newer core version still outranks an older stable.