# ECPA native ACP Responses executor

Optional source-built component for **same-machine** ECPA + CPA 8.0.78 (`db7f177d`, ABI 1 / RPC schema 10). It keeps CPA's existing API authentication, model catalog and routing: only HTTP `POST /v1/responses` for a registered `acp/...` model on the ECPA ACP provider is dispatched to the native backend. Chat and other models keep their existing routes. There is no public listener of its own, no alternate authentication path, and no auto-install or default enablement. Home-mode dispatch, WebSocket, compact and cross-process resume are outside this opt-in route.

## Build and opt in

1. Build on the matching target using Go 1.26.10+ and a CGO compiler: `sh plugins/acp-responses/build.sh`. For the verified Linux amd64 target the result is `plugins/acp-responses/dist/linux/amd64/ecpa-acp-responses.so`. Only Linux amd64 with the pinned CPA binary is currently verified. The library is not included in desktop installer resources or release CI; macOS and Windows native builds, packaging and acceptance are pending.
2. With ECPA's ordinary ACP API access enabled for the selected account, place the library in CPA's existing plugin directory under `<goos>/<goarch>/` (e.g. `plugins/linux/amd64/`). Use the exact library base name `ecpa-acp-responses`. This component uses the same ACP model registration as the existing Chat provider; do not replace that registration or add a Codex API key group.
3. Merge the following settings into the existing CPA configuration and restart the **intended local CPA instance**. Do not replace an existing `plugins.dir` or other plugin entries. Use the ECPA global ACP profile (`core_base_dir()/acp/antigravity`), not the selected account's home. CPA and ECPA must run as the same OS user: the executor reads the already private bridge settings and bearer file at runtime; the bearer does not belong in the plugin configuration or in client settings.

   ```yaml
   plugins:
     enabled: true
     configs:
       ecpa-acp-responses:
         enabled: true
         bridge_profile: /absolute/path/to/ecpa/acp/antigravity
   ```

4. Confirm `ecpa-acp-responses` is registered and effectively enabled (CPA plugin status). Call the existing CPA `/v1/responses` with the **CPA client key**, not the bridge key. For a next turn, send `previous_response_id` with only new user input or the entire pending function-output batch. Use only IDs returned by this plugin's native route (`resp_acp_…`), keep them private, and start a new turn if the live ACP session expired. When the plugin is not active, CPA's old Responses-to-Chat adapter remains available; it cannot continue these IDs. Do not automatically resend a failed native turn through the adapter. Codex HTTP can also send its whole transcript: live reuse then requires an exact append-only match under the same CPA client key. Use different CPA keys for independent callers.

The executor reaches ECPA through direct IPv4 loopback IPC, not through the CPA host HTTP callback, which respects CPA's global proxy. The relay sends only its own internal bridge key and the Responses body; it cannot forward to another host or follow redirects. CPA receives bounded SSE events through its official stream callbacks, and its request lifecycle cancels the private connection on client abort. It does not retry after a request was sent. Private key files and the bridge port rely on the same trusted-local-host assumptions as the ECPA ACP bridge.

## Codex CLI opt-in profile

Use a separate Codex configuration for ACP. In the user-owned profile, set `model_instructions_file` to an absolute path to [the ACP instruction template](codex-acp-instructions.md), then set the model and provider to the advertised ACP model and **your existing CPA API endpoint**. For example:

```toml
model = "acp/gemini-3.8-flash-high"
model_provider = "ecpa_acp"
model_instructions_file = "/absolute/path/to/codex-acp-instructions.md"

[model_providers.ecpa_acp]
name = "ECPA ACP"
base_url = "http://127.0.0.1:8317/v1" # Replace with your CPA endpoint.
env_key = "ECPA_CPA_API_KEY"          # Your CPA client key, not the bridge key.
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
```

This is an explicit Codex instruction override, not a gateway rewrite. Use a separate profile so it does not affect other providers. ECPA still sends all instructions the client submits and retains the client's declared functions and tool approval policy. Do not add local filesystem, shell, or other tools merely to make this profile work.

Linux live acceptance with Codex CLI `0.166.0`, CPA `8.0.78`, and the signed-in official CLI `1.5.14` verified two HTTP turns including `exec resume`, reuse of the same ACP process/session with only new input, and a separate, approved read-only MCP tool call and result on the original ACP prompt. The default long Codex instruction payload timed out before text in the same setup, including a test-only request without the tool catalog; the original tool catalog with a short instruction set completed. With the same model and the same advertised system-append channel, an independent 19,800-byte benign instruction completed. This rules out a simple byte-length cutoff at that size, but does not establish why the original instruction content stalled. The installed CLI did not advertise another system-instruction format. Use the opt-in template for this tested setup rather than assuming the default Codex instructions work unchanged.

## Reproduce the checks

```sh
cd plugins/acp-responses
GOPROXY=off go test -race ./...
CPA_CORE=/absolute/path/to/cli-proxy-api \
  ACP_RELAY_LIBRARY="$PWD/dist/linux/amd64/ecpa-acp-responses.so" python3 smoke_test.py
```

The smoke test starts a temporary real CPA host with synthetic keys, a recording bridge and a recording proxy. It asserts discovery and auth, JSON/SSE continuation and tool item fidelity, Chat fallback, no replay (including truncated streams), and pre-header disconnect in both modes. An ECPA-side integration test independently exercises the built library through real CPA, the actual Rust bridge and a simulated ACP process:

```sh
ECPA_ACP_TEST_CORE=/absolute/path/to/cli-proxy-api \
  ECPA_ACP_TEST_NATIVE_PLUGIN=/absolute/path/to/ecpa-acp-responses.so \
  cargo test --manifest-path src-tauri/Cargo.toml \
  acp::bridge::tests::real_cpa_native_executor_reuses_acp_session_and_returns_tool_results \
  -- --exact --ignored --nocapture
```

The repository smoke and integration tests above use synthetic services; the live acceptance described under the Codex profile is separate.
