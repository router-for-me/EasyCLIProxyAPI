- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Improvements & Bug Fixes

- Plugin Logo & Icon Display Improvements: The installed plugins list, plugin store, and OAuth login page now display logos provided by plugins; also fixed an issue where third-party credentials without a built-in icon incorrectly fell back to the Gemini icon (#556).
- Usage Record Model Matching Improvements: Requests for models with reasoning tier suffixes (such as -high or -low), date-based versions, or -build identifiers are no longer erroneously flagged as model substitutions (#551).
- Safe Rollback for Application Updates: Portable builds now wait for the new proxy kernel to start successfully and become ready before removing the previous version's backup; if the new kernel fails to start, the update safely rolls back to keep the application usable (#555).
- Configuration Sync Protection: When importing or reading a minimal kernel configuration file that omits auth-dir or api-keys, the credential directory and annotated API key list configured in the desktop client are automatically preserved rather than accidentally wiped (#553).
- Codex Agent Configuration & Session Fixes: Added context window size and reasoning effort options for OAuth models; fixed an issue where switching providers prevented Codex Desktop from correctly syncing and displaying historical sessions (#552, #554).
