# ZCode compatibility fixture

`zcode-provider-config-3.14.4.json` is a synthetic fixture checked with the
configuration decoder bundled with ZCode Desktop 3.14.4. All keys are test
values; it contains no personal credentials.

The personal provider file still uses `schemaVersion: 1` and lives at
`~/.zcode/v2/provider_config.json` for both the desktop app and CLI.

- Smart model rules are partial overrides and can inherit ZCode defaults.
- Manual model rules require complete editable properties and option specs.
  In particular, `contextWindow` must remain present when CPA has no runtime
  context value. Known CPA runtime values still replace it.
- Default model selection options currently support `reasoningLevel`.
- New CPA configurations explicitly use `/v1`; legacy origin-only URLs remain
  valid because ZCode normalizes them before sending Messages requests.

Regression tests cover model options, idempotent updates, legacy URL detection,
and restoration without overwriting later edits to other providers:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked zcode -- --test-threads=1
```
