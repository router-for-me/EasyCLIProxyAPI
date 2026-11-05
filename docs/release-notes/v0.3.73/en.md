- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Fixed

- **The apply button no longer greys out silently**: on the routing page, when the plan fails validation the reason now appears next to "Apply plan" instead of leaving a disabled button with no explanation.
- **Session lifetime format guidance**: entering a session lifetime without a unit (for example `3`) now highlights the field and shows "Session lifetime must be a duration with a unit, e.g. 1h, 30m or 1h30m." The field still only accepts durations with a unit; `1h`, `30m` and `1h30m` all apply normally.

## Improved

- **Gateway policy field descriptions**: request retries, retry credentials, maximum retry wait, transient cooldown and the disable-cooldown switch each gained a one-line description, instead of a bare label and number box.

## Added

- **MCP servers and agent skills in one page**: a new "MCP & Skills" page lists the MCP servers and the agent skills the app can see, with a detail panel for each.
  - Servers show their transport (stdio, HTTP or SSE), command or URL, the arguments and environment they run with, and whether they are enabled. You can add, edit, delete, enable or disable a server, and import or export the whole list as JSON.
  - Skills are grouped by where they come from (OpenClaw, the project, the workshop or a custom directory), show their description, path and file count, and can be toggled on or off. Files from a skill are shown in a reading pane.
  - A chip filter on each tab narrows the list by transport or by source, and the page keeps working down to the 640px window minimum.
- **Built-in reverse proxy**: an optional reverse proxy service can now terminate TLS for the local core service, configurable from the settings page with certificate and listen port.
