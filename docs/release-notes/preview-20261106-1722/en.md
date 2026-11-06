This preview fixes the two things that directly affected upgrading and downloading. A stable build switched to the preview channel now correctly recognises a newer preview build and offers an in-app upgrade. And the manual download button no longer bypasses the download source you picked: it builds the download link from the currently selected mirror (GitHub official, gh-proxy, ghfast, or a custom prefix), so people who cannot reach GitHub directly can still download the package.

If you hit problems, tell us on [Discord](https://discord.gg/your-discord-invite) or open an issue on [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Fixed

- **No upgrade button after switching a stable build to the preview channel**: preview builds use versions like `0.3.6-preview.20261106-1137`, which semantic versioning always ranks below `0.3.6`. Switching from a formal build to the preview channel therefore reported "no update available" and only offered a download button. Timestamped preview builds on the preview channel are now recognised as a newer version, so the in-app upgrade appears after switching channels.
- **Manual downloads ignored the selected download source**: the download button opened the raw GitHub asset URL from the manifest, so the selected mirror only affected version-list fetching and not the package itself. The download link now applies the selected mirror prefix, so choosing `ghfast.top` or `gh-proxy.com` downloads through that mirror.

## Notes

- Preview builds share one version prefix and are distinguished by build time; the "latest build" timestamp on the version page is how you tell two preview builds apart.
- This build does not yet include the fix for the Advanced settings tab strip click hot zone at 1280 width; that is still in progress.