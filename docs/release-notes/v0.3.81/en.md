This release targets one thing on the ECPA featured plugins page: being usable at first sight. Cards and install buttons are actionable as soon as the page renders instead of sitting grey behind a chain of initialization calls; a finished install shows Installed immediately; installed plugins surface a newer release with a one-click Update; and when the plugin store endpoint is temporarily unavailable the page now falls back to its bundled catalog data instead of a wall of grey buttons. The bundled kernel moves to 8.0.59.

If you hit problems, tell us on [Discord](https://discord.gg/your-discord-invite) or open an issue on [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Improved

- **Featured plugins page is actionable on open**: cards render from the bundled catalog first and the install button waits only for the plugin listing, no longer queueing behind the support probe, plugin source registration and version lookup. While the listing is still in flight the button reads as loading instead of an unexplained grey button.
- **Version lookup moved to the background**: latest versions fill in after the page is usable, so refreshing versions can no longer turn the button grey again.

## Fixed

- **Installed state appears as soon as the install succeeds**: previously a finished install only changed colour after the plugin listing refreshed, and could even revert to the install button in between. A successful install now shows Installed right away and stays that way for the session, without being overwritten by a stale listing.
- **Installed plugins surface updates**: the update badge and Update button now derive from the installed version and the catalog's latest, handling a `v` prefix and preview version numbers, so plugins installed from another source are recognised and updated too.
- **No grey wall when the plugin store endpoint fails**: when the store listing fails and returns no entries, the page synthesizes installable entries from the catalog data it already has, registers the plugin source and retries once on install, and surfaces the error rather than leaving the button silently unclickable.
