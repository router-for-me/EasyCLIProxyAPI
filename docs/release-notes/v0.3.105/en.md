- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Improved

- **Empty rows are discarded**: Rules without source text are dropped when saving, switching pages, or leaving the row, so a blank placeholder never ends up in the core configuration or the rule count.

## Fixed

- **Undo placement**: Undo after a delete now sits in the page header instead of a status strip, restores only rules that still have source text, and no longer leaves a stale message behind.
- **Error display**: Load and save errors open in a dialog so the page content stays readable, and an empty page no longer shows a retry button after loading has already finished.
