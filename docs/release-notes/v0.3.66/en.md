- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Added

- **Dedicated "Live routing" Tab in Usage Records**: Separated Live Routing from Overview into its own tab, keeping the 6-item summary bar (total requests, TPS, total tokens, success rate, cache hit rate, and estimated cost) at the top; the three-column topology view below ("Models → Gateway → Upstreams") displays request paths, average latency, failure counts, and credential cooldown timers over a rolling 60-second window, while restoring the side-by-side two-chart layout on the Overview tab.
- **Agent Usage Records Layout Update**: Updated the top summary bar to a single 6-column divided card; changed the Agent sources list to a 4-column horizontal card grid with client brand icons, token share percentages, and cost breakdowns; arranged the Daily Breakdown and Agent Pricing tables side by side on desktop.

## Fixed

- **Kernel Version Dropdown Overflow in Version Management**: Replaced the native `<select>` elements for Select Core Version and Download Source with custom dropdown menus capped at `280px` height with internal scrolling, preventing long version lists from covering the screen, and aligned the action buttons across the Desktop Client and Proxy Kernel cards.
