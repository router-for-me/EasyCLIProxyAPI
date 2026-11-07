This release fixes the most failure-prone part of starting up: the kernel is no longer judged by a fixed stopwatch. Previously the app gave the management port 10 seconds after launch, so machines with many plugins were reported as a failed start before they finished loading, and updating the kernel could even roll a healthy new version back as "failed to start". The app now keeps waiting for as long as the kernel process is alive and reports readiness on its own; an exited process, application shutdown, or a listening management port are the only three outcomes. Request details also gain a choice of how output speed is calculated, between end-to-end throughput and pure generation time with first-token latency removed.

If you hit problems, tell us on [Discord](https://discord.gg/your-discord-invite) or open an issue on [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Fixed

- **Kernel startup is no longer cut off by a fixed timeout**: the readiness wait was hardcoded to 10 seconds, so machines with several plugins and a slow first load saw a failed start. The wait now ends only when the kernel process exits, the application is shutting down, or the management port accepts connections; a live process is simply waited for, and slow starts are no longer misreported as failures.
- **Updating the kernel no longer rolls back on a slow start**: upgrades and the Home start button share one startup path, where a slow boot previously surfaced as "the new version failed to start" and restored the old one. A slow start now just takes longer instead of reverting an install that was already in place.

## Added

- **Request details can switch how speed is calculated**: tokens per second can now be measured over total elapsed time (end-to-end throughput) or with first-token latency removed (pure generation), selectable in the display settings with the list recalculating immediately.