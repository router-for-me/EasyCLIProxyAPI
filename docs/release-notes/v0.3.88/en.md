- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **Enable or disable models from the health check dialog**: every model row in the health check dialog now has its own switch, so you no longer need to open the edit dialog to change the exclusion list. The switch writes back to that provider's existing `excluded-models` setting, adding or removing only this model's exact rule while keeping provider-wide wildcard exclusions and any hand-written rules untouched.
- **Disabled models are visible at a glance**: a disabled model row gets a muted background, and both the model name and the result pill fade together, so the currently available set is obvious.

## Improved

- **Health check list at narrow widths**: model rows stack vertically on narrow windows, laying out the name, switch, result and action button in order instead of squeezing the result pill.
- **Warning text wrapping**: the explanatory text now breaks only at punctuation, so Chinese words are no longer split across lines.

## Fixed

- **Switch rolls back when saving fails**: if a model toggle cannot be saved, the switch returns to its previous state and reports the error, instead of showing a state that does not match the saved configuration.