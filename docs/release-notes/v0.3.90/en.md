- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **Two ways to measure output speed**: the Usage overview and the request details now share one speed mode setting, switchable between "after the first token" and "total latency". After the first token counts only the generation phase, which tracks how fast the model actually writes; total latency includes the wait for the first token, which tracks what the request feels like end to end. The overview TPS card and its tooltip follow the selected mode, and the choice is remembered across sessions.
- **Import model capabilities from external catalogs**: agent configuration can now pull model capability metadata from an external catalog, so supported options and capability flags stay current with it.

## Improved

- **Speed samples and eligibility**: short replies are no longer dropped from the speed figures — they report a value too. Only failed, canceled, empty-output and untimed records are excluded, and the default mode is now the first-token-subtracted one.
- **Overview TPS explanation**: the tooltip now describes the calculation and the sample conditions for whichever mode is active, in Chinese, English, Japanese and Russian.

## Fixed

- **Missing output limit on manual zcode model rules**: hand-written model rules now get the required `maxOutputTokens`, so saving no longer produces calls that fail on the missing field.
- **Sticky event table header corners**: removed the stray rounding so the pinned header no longer shows split white corners while scrolling.
- **Russian TPS tooltip mismatched the formula**: corrected the description of the calculation baseline in Russian.