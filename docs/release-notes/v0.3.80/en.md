This release makes the ECPA featured plugins page actually usable: descriptions now follow the interface language, installed plugins surface newer releases and update in place, the page gained a manual refresh button, and the bundled catalog now includes FreeTier 2API. It also corrects two calculation errors in the usage page TPS average.

If you hit problems, tell us on [Discord](https://discord.gg/your-discord-invite) or open an issue on [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Added

- **Featured plugins update in place**: installed featured plugins resolve their latest GitHub release on load. When a newer version exists, the version label reads "current → latest" and the card shows an "Update available" badge plus an Update button that downloads and installs the release; the badge clears as soon as the install finishes. Plugins already on the latest release keep the plain Installed badge.
- **Manual refresh on the featured plugins page**: a Refresh button next to the search box re-fetches the featured catalog past the local cache and refreshes the plugin source list at the same time, so a catalog update no longer requires waiting out the cache or restarting the app.
- **Plugin descriptions follow the interface language**: featured entries now use the localized description supplied by the catalog. A Simplified Chinese interface shows the Chinese text, Traditional Chinese falls back to Simplified Chinese, and every other language uses the catalog default.

## Fixed

- **TPS average no longer dragged down by failed requests**: the usage throughput statistic used to include failed requests in the average; it now counts successful requests only.
- **TPS computed per request**: throughput now derives from each request's own output token count and latency instead of dividing a period total, so the number tracks real response speed.

## Improved

- **Bundled featured catalog includes FreeTier 2API**: when the network is unavailable the app falls back to its bundled catalog; that data now ships FreeTier 2API as well, so the page no longer collapses to a single plugin.
