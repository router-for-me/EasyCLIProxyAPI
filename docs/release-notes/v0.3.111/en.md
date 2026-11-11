If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **`gpt-oss-120b-medium` in the bundled Codex catalog**: the model is now part of the shipped catalog (revision 9), so it appears in the Codex model picker without a separate download.

## Improved

- **ACP model names are now published as-is**: the ACP provider emitted an alias on top of an already renamed model, which the Claude Desktop alias table cannot express. Models are now published under their `acp/` prefixed name with no alias indirection.
- **Claude Desktop no longer reports the managed configuration as needing attention**: `behavesAs` is no longer written into the managed model entries, because Desktop builds that do not recognise it flag the whole configuration. The family routes Desktop already knows (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`) are published directly and the upstream model stays in `labelOverride`. Files written by an older version cannot resurrect the field.
- **ACP API streaming correctness**: Chat Completions and Responses clients now receive a complete OpenAI-compatible stream — an initial assistant role delta, text or indexed tool calls, one terminal finish reason and `[DONE]`, with a stable completion ID, model and creation time across chunks. Output queues apply backpressure while staying cancellable instead of dropping frames under load, and usage is omitted rather than fabricated when the CLI reports no token counts.

## Fixed

- **Antigravity usage was inflated and lost**: the usage scanner counted every mirror of a session (`transcript.jsonl`, `transcript_full.jsonl`, `chunks/**`, IDE and backup copies), so the reported total was several times the real usage while some per-request models showed as "unknown model". Each session now contributes once from a single canonical transcript, models are read per request step from the session database with the settings label as a fallback, and identical samples are deduplicated while retries and compaction checkpoints are preserved. The first sync after upgrading rebuilds the Antigravity rows once, and the total drops to the real value.
- **Antigravity usage could disappear after an unreadable file**: a session whose transcript could not be read had its cached rows deleted anyway, because any other readable file in the session authorised the clean-up. Cached rows now survive whenever a read fails, mirrored transcripts are compared by the requests they actually cover rather than by file name, and legacy keys are migrated instead of being counted alongside their replacements.
- **ACP API write failures lost the underlying cause**: saving a Claude Desktop alias mapping failed with `invalid_config` because the ACP provider wrote `proxy-url` at the provider level, which the core rejects for `openai-compatibility` entries. The field is now written inside the key entry, an existing provider-level value is normalised into the key entries, and the core error text is appended to the write-failure message.
- **ACP API could fail mid-completion**: an upstream failure after the first chunk was reported as a truncated success. Failures before output now return an HTTP error, and failures after output emit a terminal SSE error without a success finish reason or `[DONE]`, so a failed turn can no longer look completed.
