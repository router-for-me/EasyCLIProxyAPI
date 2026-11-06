- If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Fixed

- **Agent discovery burned CPU on machines with many environment directories**: when starting up and probing agents, every directory under `.local/state/fnm_multishells` and `.nvm/versions/node` is visited, and each newly collected path was compared against every path already collected. With a large accumulated FNM directory tree (one report had roughly 199,000 entries) the number of comparisons grows quadratically, keeping the CPU busy even with no model requests running (measured at 57%–62%). Deduplication now uses a hash set while keeping the original path order and the first-seen spelling.

## Improved

- **Deduplication results are unchanged**: duplicates, trailing slashes, equivalent paths that differ only by `/./`, and empty entries all behave exactly as before, so executable search precedence is unaffected.
