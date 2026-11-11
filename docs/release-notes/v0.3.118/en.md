## Added

- Connect to an external CLIProxyAPI v8 server from the sidebar CPA selector and manage its client API keys in a separate Remote workspace. HTTP, HTTPS and reverse-proxy prefixes are supported; conditional saves protect against concurrent edits. Switching between Built-in and Remote CPA takes effect after fully quitting and reopening ECPA.

## Improved

- ACP account sign-ins now use isolated CLI profiles, support adding and reauthorizing accounts without replacing other saved accounts, and provide a manual authorization-link flow. Windows CLI launchers and paths are handled more reliably, failed capability checks remain retryable, and authorization errors distinguish timeouts, rejected responses, missing links and network failures.
- Stable and Preview versions are compared independently. Click the desktop logo to switch the version reference shown in Version Management without changing the installed package or background-update channel; automatic updates stay within the installed release family.
- Provider model selection now reports accurate counts and retains configured models omitted by the upstream list, marking them clearly instead of silently losing them.
- Credential cards keep common actions visible and group secondary actions in a keyboard-accessible More menu. Built-in light and dark themes now include descriptions, and the CPA selector follows the sidebar palette.

## Fixed

- Accept valid update manifests containing only one architecture while still validating every listed package. This supports the Windows x64-only Preview channel; stable packages remain available for Windows, macOS and Linux on x64 and ARM64.
