## Improved

- Added support for the latest ZCode `.zcode/v2/provider_config.json` format. The app can set, detect, and restore its proxy connection and default model while preserving other provider configurations.
- App and core updates are now checked whenever you enter Version Management. Return to the page to check again.
- Provider priorities now accept negative integers, with input range validation before saving.
- Session affinity TTL is validated before saving and accepts durations such as `30m` and `1h30m`. Leave it blank to use the default; valid values below one second are saved as one second.
- Core v8 Management API errors now show both the error type and detailed reason, making invalid configurations easier to identify.

## Fixed

- Fixed macOS updates being interrupted when a DMG was temporarily busy and could not be unmounted. Unmounting is retried, and cleanup is deferred when necessary.
- Fixed core v8 provider group names and remarks sometimes being lost after reading or saving. Duplicate detection no longer depends on group names.
- Fixed DeepSeek credentials being rejected by the core on save when group names were written to the wrong fields.
- Fixed model reasoning settings being overwritten when editing a provider. Existing settings for each model are preserved when reasoning levels are unchanged, while manually clearing them no longer restores old values.
- Added compatibility with reasoning fields in model discovery results and removed the legacy “Test Model” configuration item.
- Fixed the “Disable Cooldown” and Claude user ID cache settings not being saved correctly when turned off. You can now explicitly choose the default, enabled, or disabled state.
- Fixed empty nodes and mixed old and new fields in core v8 configurations causing TLS, sensitive word, and other settings to be read or written incorrectly.
- Corrected the displayed defaults for the listening address, usage statistics, retry count, and retry interval to match the core’s behavior when these settings are omitted.
- Fixed API provider editing and model selection dialogs extending beyond the screen and failing to scroll properly in narrow windows or macOS WebKit.
