# ACP access in OAuth

OAuth contains an ACP Access tab beside sign-in and authentication files. The new tab is independent of the sidebar and existing OAuth credential lists.

The page uses the full available width, with account identity and controls side by side in wide windows. Model verification and API access occupy separate compact panels below; expanding one does not stretch the other. CLI status lives in the account card footer. The Google account → Antigravity CLI → CPA API connection flow, runtime paths, and reauthentication stay in collapsible connection details. Before connecting, model and API panels explain their prerequisites. Adding an account expands a labeled sign-in form; reauthentication explains that it logs out the selected account first. The test model selection does not restrict API models: enabling access exposes all models advertised by the active account. Saved API enablement with a disconnected account is shown as waiting for connection, and can still be disabled.

## Available operations

Account selectors prefer the email reported by the official CLI and append any user label. ACP 1.0 does not expose account identity directly: after a successful connection, ECPA reads only the owned CLI process's recent `server_oauth.go` login-result line from that account profile, without reading credential storage. Only the email is saved as optional private account metadata. A missing or changed log format falls back to the account label. Reauthorization clears the previous identity before starting; privacy mode masks both emails and labels at display time.

- Detect the installed official Antigravity CLI through existing agent discovery.
- Authenticate using its official personal Google OAuth flow.
- Add labeled accounts and switch saved logins. All accounts share one installed CLI executable; only runtime data and model selection are stored separately. The existing default login stays in its original directory.
- Reauthenticate the selected account using official ACP logout, then Google authorization. ECPA does not copy, delete or exchange credential files.
- Check an existing login by creating an ACP session and reading account models.
- Save a selected model and explicitly apply it with session/set_model before testing.
- Send a fixed, real text probe and report the completed response, elapsed time, and first text latency.
- Cancel login, refresh, or test operations. Switching tabs preserves the native operation; app exit signals cancellation.
- Keep the latest successful probe in native memory so switching tabs during or after a test restores its result, including the tested model. Starting another operation or changing the model clears the previous result.
- Bound each ACP request: 30 seconds for initialization/session/model configuration, 5 minutes for browser authentication, and 2 minutes for a text probe. Progress events do not extend the deadline. Timeout and cancellation terminate the owned CLI process before releasing the operation slot.

Runtime data is under core_base_dir()/acp/antigravity. The default account uses this directory; additional accounts use accounts/<generated-id>. These are data directories, not separate CLI installations. accounts.json stores labels and the active account. ECPA does not copy normal Antigravity settings, CPA connection files, or OAuth credentials. The official CLI manages credentials. Each operation launches the same executable directly without a shell. Model endpoint and credential environment overrides are removed to avoid routing back into CPA. The ECPA network proxy is applied to the child process.

The ACP client advertises no filesystem or terminal capabilities and rejects permission requests. This is a connection/test interface, not a general Agent execution environment or OS sandbox.

## Model list and API access

Enable API access in the ACP tab after connecting an account. ECPA binds an authenticated loopback listener and registers its reserved ecpa-antigravity-acp OpenAI-compatible provider, preserving other entries. Account models appear as acp/<official-model-id> in CPA /v1/models and ECPA model lists. Use the existing CPA endpoint and client API key for POST /v1/chat/completions. Disabling removes the managed provider. Legacy and v8 configuration layouts are supported.

The bridge supports one user text message per request (string or text content blocks), regular responses and SSE. Each request explicitly selects the official model in a fresh CLI process/session. History, system/tool messages, tools, images, sampling, max_tokens and structured output parameters return errors. stream_options.include_usage is accepted for CPA compatibility; token usage is not fabricated. Input and response text are each limited to 1 MiB.

Only one native operation runs at a time; concurrent requests return 429. A dropped HTTP/SSE client cancels the operation. Account switching reserves the same slot, clears old capabilities, verifies the selected login and updates models. Saved API enablement restores after app startup by verifying the active account. ECPA must remain running while clients use ACP. Model selection and labels are persisted privately; test results and connection capabilities stay in memory.

## Verification

- bun run check and bun run build.
- cargo test --manifest-path src-tauri/Cargo.toml acp::tests -- --nocapture.
- cargo test --manifest-path src-tauri/Cargo.toml acp:: -- --nocapture covers account isolation, both provider config schemas, invalid inputs, HTTP replies/SSE, concurrency and disconnect cancellation with a simulated official server.
- Set ECPA_ACP_TEST_CORE to a CPA v8 executable and run cargo test --manifest-path src-tauri/Cargo.toml acp::bridge::tests::real_cpa_lists_and_routes_registered_acp_models -- --ignored --nocapture for isolated CPA model discovery, regular/SSE forwarding and hot-reload removal without a real model call.
- cargo test --manifest-path src-tauri/Cargo.toml acp::rpc::tests -- --nocapture covers silent and continuously updating processes, timeout cleanup, and cancellation before/during a request using isolated test child processes.
- node tests/acp-access-ui.cjs with Playwright available through PLAYWRIGHT_MODULE or node_modules. Covers Chinese/English, model selection, test results, tab remount, keyboard navigation, and narrow layout using synthetic mock data.
- Opt-in real native probe: set ECPA_ACP_PROBE_PROFILE to an officially authenticated isolated profile and ECPA_ACP_PROBE_CLI to the official executable. Run cargo test --manifest-path src-tauri/Cargo.toml acp::tests::official_acp_native_probe -- --ignored --nocapture. The test selects a non-default advertised model and verifies a completed ACP_OK response; it does not print credentials.

Windows verification on 2026-11-16 used official Antigravity CLI 1.4.12. The Rust client successfully selected gemini-4-argon-high and received ACP_OK. macOS and Linux have not been exercised with native CLI installations.
