## v0.3.26 Release Notes

- Suggestions and issue reports for this project are welcome in the community chat or on GitHub.
- This release fixes a configuration failure when disabling API keys, and improves Claude Code model management and the usage records interface.

## Added

- Claude Code now has separate controls for whether CPA manages the startup model and the Subagent model. When disabled, CPA no longer overwrites Claude Code's saved default model, and Subagents without a specified model inherit the main session model.

## Improved

- Usage record filter menus now size themselves to their options.
- The Token and request toggle now matches the protocol selector on the home page.
- The model name field in credential settings is searchable again and filters matches by that credential's model IDs while typing.

## Fixed

- Disabling native API keys such as Codex, Claude, and Gemini no longer writes the unsupported `disabled` field, which prevented the entire configuration from loading.
- Existing configurations are repaired automatically before the core starts, with no manual edit required. OpenAI-compatible providers continue to use their existing disable switch.
