- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **Update ECPA without restarting the core**: Windows and macOS users can now clear "Restart the core as well" during an app update to keep the current core and agents connected directly to it running. Restarting the core remains the default. The newly bundled core is deferred until a manual core update. ECPA-hosted proxy connections and the managed DeepSeek Harness still stop when the GUI restarts; Linux currently requires a core restart.

## Improved

- **Plugin page layout**: unified the subpage tab style with other pages and aligned the local/store search and action controls on narrow windows.
- **Model catalog loading**: ZCode now loads the external capability catalog once per editor load or configuration generation, instead of rereading it for every model.

## Fixed

- **Excessive disk reads in ZCode configuration**: removed automatic model capability calibration from request history. Opening the model editor or generating configuration no longer repeatedly scans historical usage records for each model. Model defaults, external catalog data and manual settings remain available.
- **Saved ZCode settings overridden by defaults**: preserved explicitly saved context windows and empty reasoning-level selections instead of replacing them with inferred defaults.
