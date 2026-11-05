- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Fixed

- **Preview builds always offered an older build**: the integer type used to parse the preview tag timestamp was too small, so a stamp like `202611041750` always overflowed and "find the latest preview build" silently failed. It now parses as a 64-bit integer, so updates point at the newest preview build again.
- **Reverse proxy disabled state was lost on restart**: turning the reverse proxy off and restarting the app brought the switch back to enabled. The state is now saved and restored correctly.
- **Reverse proxy restart flag was overwritten**: after changing reverse proxy settings, the restart-required marker is no longer cleared by later writes, and the core config path resolves correctly.

## Improved

- **Unique tags for preview builds**: every preview build now uses a unique timestamped tag and older preview releases are pruned automatically, so builds no longer overwrite each other.
- **Clearer download channel description**: the version management page now distinguishes preview and stable download targets and explains what each channel contains.
- **Better MCP and Skill page states**: a failed load shows an inline error strip and an empty state instead of a blank page, and list spacing and layout were polished.
- **MCP entries sync to OpenClaw config**: MCP servers and agent skills can now be written through to the OpenClaw configuration instead of being copied by hand.
