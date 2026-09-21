## Added

- Added WorkBuddy / WorkBuddy AI support in agent management. You can detect the installation, apply or disable configuration, back up and restore settings, and launch or restart the client. Both object and array `models.json` formats are supported, and existing custom models are preserved. After applying, select `CPA:model name` in WorkBuddy. Existing conversations keep their current model; restart the app if the CPA model is missing.
- Added Cursor CLI (`cursor-agent`) support in agent management. CPA can detect a local installation and launch it with a chosen terminal and working directory. Cursor CLI uses its own configuration and account system rather than CPA local model routing.
- Added Antigravity CLI support in agent management. It connects through CPA’s Gemini-compatible API. After applying the configuration, launch it from this page so CPA can inject the endpoint and API key for that process. Running `agy` directly requires setting those environment variables yourself.

## Improved

- Redesigned the home API access cards into full-width rows, one protocol per line, aligned with the control panel. Click a URL to copy the local or LAN address, with clear copy feedback.
- Compacted the usage overview into a single row of 6 statistic cards with tighter content and full-width alignment, making request volume, performance, tokens, and cost easier to scan.
- Updated the bundled core to 7.3.10.

## Fixed

- Fixed the usage trend tooltip disappearing shortly after hover. The tooltip now stays visible while the pointer remains over the chart, and closes only when the pointer leaves or you press Esc.

---

## Included from v0.2.101

### Fixed

- Fixed automatic exclusions in API connections blocking a selected model when its alias matched an unchecked upstream model name. For example, assigning the alias `dsv4` to upstream model `dsv4.1` no longer makes the mapping unavailable just because the original `dsv4` model is unchecked.
- After applying a model selection, editing model names or aliases now updates automatic exclusions accordingly. Saving also protects additional existing aliases for the same model. Manually edited exclusion lists, wildcard rules, and provider disabled states are preserved.

**Existing configurations:** If conflicting exclusions were previously saved, use “Fetch Models → Apply Selection → Save” again to clear the automatically generated conflicts.
