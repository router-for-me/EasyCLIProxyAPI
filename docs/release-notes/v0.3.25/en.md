## v0.3.25 Release Notes

- This release continues the improvements to usage records and credential settings. Suggestions and issue reports are welcome in the community chat or on GitHub.

## Improved

- Usage record filters for model, provider, source, key, and result now use fixed-width selection menus, without the extra border or green focus halo.
- Changing a filter updates the current view in place instead of rebuilding the page.
- The request records footer groups the record count with the column, width, and export actions, and places pagination separately.
- Per-credential model aliases now use direct inputs for the model name and alias. Display name, keeping the original model, and rewriting response model names are available in an expandable section.
- Closing credential settings discards unsaved changes directly, without a confirmation prompt.
- Updated the bundled CLIProxyAPI core to **8.0.16**.
