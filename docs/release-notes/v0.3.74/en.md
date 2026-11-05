- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **MCP servers and skills can sync to OpenClaw**: MCP server and agent skill entries can now be written into the OpenClaw configuration instead of being copied by hand.
- **Custom Codex model ordering**: the model list can be reordered, and the order is saved and restored on the next launch.
- **Bulk credential tags**: set, clear or keep tags across several credentials at once, with existing tags preserved and non-editable entries excluded from the selection.
- **z.ai Coding Plan quota lookup**: view z.ai Coding Plan quota, including weekly and team windows.
- **Optional semantic model routing**: pick an upstream by model semantics, off by default, with the routing path verified before it is enabled.
- **Confirm before applying a routing plan**: applying a plan now opens a confirmation dialog that lists every change about to be written.
- **Custom CLI launch arguments**: extra core launch arguments are supported, and the script execution policy is preserved.
- **Preview releases use timestamped tags**: each preview build publishes its own timestamped release, keeps the newest eight, and the client picks the latest one automatically. The download channel descriptions now separate preview and stable targets.
- **Missing core v8 options**: the settings page exposes the core options that were previously missing, grouped by purpose.

## Fixed

- **Broken layout in the MCP server dialog**: the form body was squeezed into a thin strip with the name and command fields hidden behind a tiny scrollbar and the footer buttons stretched. The form now has its normal height and every field is visible at once.
- **Reverse proxy state lost on restart**: turning the reverse proxy off and restarting brought the switch back to enabled. The state is now saved and restored, and the restart-required marker is no longer cleared by later writes.
- **Blank embedded pages after the main WebView exited**: the main and child WebViews now recover, and an unknown core status no longer clears them.
- **Copilot usage accounting**: CLI config comments and unparsable JSON are no longer treated as errors, and dead sessions are not counted twice.
- **Claude cloud credit display**: cloud balance is separated from other credit figures instead of being mixed together.
- **Per-key token statistics**: the per-key token view is restored.
- **GitCode fallback URLs**: an unconfigured GitCode no longer receives fallback requests (Refs #548).
- **Corporate root certificates**: #408 now trusts the system's native corporate roots.
- **Routing validation failures**: a rejected routing plan now shows the failure reason instead of falling back silently.
- **Release note locale order**: notes are now published in en, zh-CN, zh-TW, ja order.

## Improved

- **MCP and skills pages**: a failed load shows an inline error strip and an empty state instead of a blank page, and list spacing and layout were polished.
- **Reverse proxy settings card**: laid out as an access-route summary plus hardening status, with clearer grouping.
