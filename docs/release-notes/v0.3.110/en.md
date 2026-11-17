If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **ACP tool round trips**: function tools are now exposed to the official CLI through a built-in authenticated MCP adapter, so Chat Completions and Responses clients can receive `tool_calls`, execute them, and return results into the same execution. Streaming is supported, pending calls keep their CLI process and expire after ten minutes, and a completed tool ID cannot be delivered twice. No user-side MCP installation is required.

## Improved

- **ACP client compatibility**: empty or null `tools`, `tool_choice` auto without tools and explicit `tool_choice: none` are accepted. Common client fields — `n: 1`, `store: false`, `response_format` text, `parallel_tool_calls`, `user`, `metadata`, `prompt_cache_key` and `safety_identifier` — are validated and accepted. `max_tokens`, `max_completion_tokens`, `temperature` and `top_p` are accepted for compatibility, and values the CLI cannot apply are listed in the `x-ecpa-ignored-parameters` response header instead of rejecting the request.
- **ACP system instructions**: system and developer instructions are now delivered separately through the CLI's advertised system-prompt append capability or the official Antigravity extension, preserving the agent's own defaults instead of being flattened into the user turn. A CLI without either capability returns a clear update-required error when instructions are present.
- **ACP API start and stop**: the API card now uses an explicit start/stop switch with separate states for stopped, starting, started-and-waiting and started. Stopping stays available whenever access is on, even with a disconnected account or no models; starting requires a connected account and explains the missing prerequisite in place. Errors are shown in the card and the switch returns to an operable state.

## Fixed

- **ACP API access was not reliably disableable**: access is now off by default, and signing in, refreshing, switching accounts or restarting the app no longer appears to turn it on. Disabling saves the off intent atomically, clears pending tool sessions and the listener, and removes the managed provider from both legacy and v8 configuration layouts. The operation is idempotent and fails closed, so a cleanup error cannot leave stale access that resumes on the next launch.
