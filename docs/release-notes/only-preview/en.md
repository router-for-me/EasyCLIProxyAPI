- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Fixed

- **The apply button no longer greys out silently**: on the routing page, when the plan fails validation the reason now appears next to "Apply plan" instead of leaving a disabled button with no explanation.
- **Session lifetime format guidance**: entering a session lifetime without a unit (for example `3`) now highlights the field and shows "Session lifetime must be a duration with a unit, e.g. 1h, 30m or 1h30m." The field still only accepts durations with a unit; `1h`, `30m` and `1h30m` all apply normally.

## Improved

- **Gateway policy field descriptions**: request retries, retry credentials, maximum retry wait, transient cooldown and the disable-cooldown switch each gained a one-line description, instead of a bare label and number box.

## Added

- **Built-in reverse proxy**: an optional reverse proxy service can now terminate TLS for the local core service, configurable from the settings page with certificate and listen port.
