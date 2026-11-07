This release rounds out multi-entry OAuth sign-in for plugins: when a plugin declares several OAuth providers, the sign-in panel now shows one card per provider, each with the name and logo the plugin itself supplies, and the login portal can be chosen per entry.

If you hit problems, tell us on [Discord](https://discord.gg/your-discord-invite) or open an issue on [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Added

- **Separate cards for each plugin OAuth provider**: a plugin that offers several OAuth sign-in entries now renders one card per provider using that plugin's declared name and logo instead of collapsing them into a single entry.
- **Per-entry portal selection**: the sign-in portal can now be set per provider rather than once for the whole plugin.
- **More robust provider discovery**: only plugins that are actually enabled and declare a valid OAuth provider are read, entries are deduplicated by provider, built-ins are excluded, and providers added by the backend show up without a frontend allowlist.
