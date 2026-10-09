## Added

- If you have any questions or suggestions about the software, please contact us in the community chat or submit them through [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues), and we will address them as soon as possible.
- Added Vertex AI credential import. Select a Google service account JSON on the sign-in page, optionally set a GCP location, and view the project, service account, and credential file after import.
- Agent configuration management now lets you select an executable manually. When automatic detection fails, the selected path is used for detection and launch.
- Usage records now show a Fast badge for `priority` and `fast` requests.

## Improved

- Redesigned the home dashboard with a lighter overview layout that puts status and summary information first.
- Added an error-detail wrapping option to usage display settings. Messages stay on one line by default and can be expanded; the preference is saved.
- Improved ZCode configuration updates and detection to accept existing base URL forms and preserve context windows in manually configured models.
- Improved Hermes and OpenClaw compatibility: recognize Hermes v12 provider entries, honor OpenClaw custom configuration paths, and preserve existing model metadata.
- Clarified that credential usage totals cover the current core session, made credential enablement and its action button clearer, and translated remaining interface labels.
- Updated the bundled CLIProxyAPI core to **8.0.22**.
- Improved Claude Code model mapping.

## Fixed

- Fixed an issue with symlink paths.
