- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Improved

- **One set of rules for providers and credentials**: model exclusions are no longer accounted per credential file; provider-level and credential-level rules are handled in the same save and no longer overwrite each other.
- **Saving can synchronize to every credential of a provider**: saving exclusions at provider level writes them to all credential files of that provider, with the dialog telling you this save will synchronize so you no longer edit files one by one.
- **Models excluded by a provider rule are clearly labelled**: entries blocked by provider rules show the rule that matched, so it is obvious whether to adjust the credential rule or the provider rule.
