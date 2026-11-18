If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **Automatic updates in Version Management**: the application and the core can now update themselves without a manual download. Pick which targets to follow, and new versions download quietly while the app runs and install on the next launch, before local services start. It is off by default, and manual and automatic updates never run at the same time. Changing the download source, channel or proxy discards the queued download, and a version that failed to install stays blocked until you clear the failure rather than retrying forever. See [automatic updates](docs/automatic-updates.md).

## Improved

- **Version Management is denser**: the page uses the available width and tighter spacing, so the update settings and both version cards fit without the tall empty rows that pushed actions below the fold.

## Fixed

- **Plugin executor usage was mis-priced**: records from plugin executors fell back to the OpenAI token convention, but those executors follow the upstream protocol convention. A cache-write-only Claude request reported a 100% cache hit rate, billed uncached input at zero and charged cache writes twice, while Gemini thinking tokens were dropped from output and left unbilled. Records now read the protocol-agnostic `token_breakdown` the core already provides.
- **Alias saves failed on configs with a trailing section**: the YAML editor rejects a document followed by tokens it cannot attach, so a config whose own reader stops at the end of the document failed every alias save with "Content after the document could not be parsed". The trailing part is now split off, edited separately and appended back byte for byte.
- **Core updates failed when the kernel binary was read-only**: copying reproduced the source permission bits, so overwriting a `0555` kernel produced a read-only temporary file and the next write failed with `EACCES`. The temporary file is now synced through a read-only handle on Unix, the write-opened handle is kept on Windows, and the owner write bit is restored so later updates stay replaceable.
- **A half-finished automatic update setting could switch the feature off silently**: a config with updating enabled but no target selected was replaced wholesale with defaults during sanitization, and the sanitized config was written back, so the reset became permanent. Only the unreachable part is now narrowed, the rest of the record is kept, and the reload writes nothing when the record is already coherent.
- **`codex` word replacement used the wrong casing**.
