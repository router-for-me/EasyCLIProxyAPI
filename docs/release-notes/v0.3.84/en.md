This release makes credential model exclusions stop living in separate silos. Previously a rule edited on one credential only affected that file, and provider-wide rules frequently contradicted per-credential ones. Saving now also synchronizes to every credential of the provider when you ask for it, and models blocked by a provider rule are labelled with the rule that excludes them.

If you hit problems, tell us on [Discord](https://discord.gg/your-discord-invite) or open an issue on [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Improved

- **One set of rules for providers and credentials**: model exclusions are no longer accounted per credential file; provider-level and credential-level rules are handled in the same save and no longer overwrite each other.
- **Saving can synchronize to every credential of a provider**: saving exclusions at provider level writes them to all credential files of that provider, with the dialog telling you this save will synchronize so you no longer edit files one by one.
- **Models excluded by a provider rule are clearly labelled**: entries blocked by provider rules show the rule that matched, so it is obvious whether to adjust the credential rule or the provider rule.
