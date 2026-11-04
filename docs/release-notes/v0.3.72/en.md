- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Fixed

- **No more empty reset-credit box on quota cards**: When an account has neither a credit balance nor any applicable reset credits, the card no longer shows an empty box at the bottom. A failed reset-credit lookup is now reported below the card instead of inside it.
- **Quota card follows the theme**: The reset-credit area now uses the theme's soft surface instead of a fixed dark one, so it no longer appears as a dark block in light themes.
- **Consistent quota limit names**: Every provider now names its limits with the same wording — "5-hour limit", "Weekly limit", "Weekly Opus limit" and so on — instead of mixing "window" and "quota". English, Simplified Chinese, Traditional Chinese and Japanese were updated together.
- **Usage panels no longer fill the window**: The Price Statistics and Data Management panels now end with their content instead of stretching to the bottom of the window; a long price list still scrolls inside its panel.
- **Current page stays visible in the narrow top navigation**: When the window is narrow enough that navigation becomes a row across the top, a page opened from a button on another page now scrolls its own navigation item into view. The side rail on wide windows is left untouched.

## Added

- Automated UI tests now cover the top navigation scrolling to the current item and the usage panel heights, from 640px up to 1920px windows.
