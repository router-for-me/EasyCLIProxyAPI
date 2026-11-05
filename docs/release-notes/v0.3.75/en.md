- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Fixed

- **Preview channel wrongly reported "no preview release"**: the latest preview lookup used only the GitHub API, so once the anonymous request was rate limited (60 per hour) it concluded there was no preview build, even though one existed. It now retries through GitHub's feed and only reports an error when both sources fail.
- **Update checks now use the configured GitHub token**: the GitHub access token in settings was only used by the plugin store, while version checks still went out anonymously. Both now share the same token, raising the quota from 60 to 6000 requests per hour, with the anonymous request and feed still used when no token is set.
- **Failed checks stayed on "Detecting"**: when the application update check failed, the Latest Version tile stayed on "Detecting" forever, contradicting the "Check Failed" badge above it. It now shows the failure state.
- **Agent usage tab lost its state when reopened**: returning to Agent Usage from another page showed "Waiting for Core" in the top bar even though local collection was still running. The collector status is now reloaded and shows "Collecting Locally".

## Added

- **Custom date ranges for usage statistics**: the fixed "Last 24 hours" range is replaced by "Custom", which opens quick picks (yesterday, this/last week, this/last month, last 90 days, this/last year) plus start and end dates, comparing against the previous period of the same length.
- **Activity calendar fits the available width**: it no longer always draws a full year. It fills the space and ends at today, scrolling only when the history is longer, and the hours heatmap stays on the same row whenever it fits.
- **Year shown on cross-year labels**: the January calendar label and trend axis labels now include the year.
- **Granularity is kept when switching ranges**: the selected hour/day/week/month granularity survives a range change, falling back to day only where hourly data is unavailable (All, or a custom range older than the 30-day hourly history).

## Improved

- **A failed upstream lookup no longer breaks a release**: the build queries the newest upstream kernel version, and previously aborted that platform's build when all three sources failed. It now keeps the pinned kernel version and continues; only an explicit update check still fails hard.
- **Pushing the main branch no longer triggers a full build**: every push to `main` used to compile all six platforms just to warm caches, wasting runner time. Builds now happen on release tags only, while caches are still written so later compiles keep hitting them.
