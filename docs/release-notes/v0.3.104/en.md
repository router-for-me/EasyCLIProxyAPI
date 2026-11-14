- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **Sensitive word replacement rules**: A new sensitive words page lets you maintain per-provider source-text replacements, obfuscation words and system-prompt line filters. Saving writes them into the core configuration so they take effect immediately.
- **One-click cloud rule import**: Fetch the official rule file from the GitHub repository and add only the entries missing locally; clicking again does not duplicate them.

## Improved

- **Cloud rule merging**: Import preserves your current unsaved edits and saves the merged result automatically. A failed download or invalid file leaves the existing configuration untouched, while a failed save keeps the merged content and shows an error so you can retry.
- **Rule file documentation**: Added a format reference covering provider fields, entry limits and how to maintain the file locally.

## Fixed

- **GitHub token authentication**: Cloud rule downloads reuse the GitHub access token from settings, fall back to the `GITHUB_TOKEN` environment variable when it is empty, and respect the application proxy settings.
- **Token transmission scope**: The token is sent only to the GitHub API and never to public Raw downloads or redirect targets; the public file is used only as a fallback when the API request fails.
