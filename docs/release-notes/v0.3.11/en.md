## Improved

- The sidebar contact entry now invites Traditional Chinese, Japanese, and English users to join the [Discord server](https://discord.gg/PxvX4D9kgs). The Simplified Chinese entry continues to open the existing QQ group.

## Fixed

- Fixed WorkBuddy / WorkBuddy AI detection on macOS by locating the executable named in the app bundle's `Info.plist`. Detection still uses the existing path when that information is missing or invalid.
- Fixed subsequent core configuration changes sometimes failing to reach a running core after repeated saves. Settings such as usage statistics and client API keys now take effect when saved.
- Fixed existing OAuth credentials not being restored from the macOS update backup when the replacement app bundle already contains an empty OAuth directory.
