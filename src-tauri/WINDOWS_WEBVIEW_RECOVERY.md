# Windows main WebView recovery (#557)

The main WebView subscribes to WebView2's `BrowserProcessExited` event, including
normal exits. A matching browser PID and current controller generation mark it
dead. Deferred UI-thread work closes only that WebView and recreates label `main`
in the existing native window using its configured URL and browser options.
The original WRY content container is removed after its controller closes;
replacement child containers use WRY's own child-window teardown.
Native window geometry/visibility and core processes are not replaced. Recovery
releases the lost frontend's plugin ownership and placement even when React
cleanup never ran. A plugin controller with the exited browser PID is closed and
its session invalidated; a healthy controller from another browser is hidden,
retaining its session for the next explicit show. Window-activity synchronization
cannot reshow an unowned plugin. The main UI reloads; its in-memory frontend state
is not restored.

Session, display, DPI, restore and focus notifications coalesce into a physical
client-bounds refresh, not an unconditional replacement. `GetClientRect` avoids
applying stale RDP logical scaling; WebView2 also receives a parent-position
notification to refresh monitor information. Zero-sized/minimized clients defer
recovery until restore. Healthy tray/focus cycles never mark the browser dead.

Recovery attempts are at least five seconds apart, with at most three attempts in
a rolling minute. There is no polling/retry loop: a subsequent restore/session
notification can retry a failure after cooldown. Old generation callbacks and
all requests after shutdown begins are ignored. Native/COM notifications only
schedule work; controller replacement runs later on the UI thread.
Plugin PID capture runs on the UI thread and returns only its result to the
serialized show operation. Recovery defers while a plugin operation holds its
state lock, avoiding a UI-thread wait on a worker awaiting native dispatch.
Old show completions, bounds and hide requests cannot affect a newer owner.

## Automated verification

Run from the repository root:

```sh
cargo test --offline --manifest-path src-tauri/Cargo.toml --bin cpa-gui webview_recovery
cargo test --offline --manifest-path src-tauri/Cargo.toml --bin cpa-gui plugin_webview
cargo test --offline --manifest-path src-tauri/Cargo.toml --bin cpa-gui physical_window_size_uses_display_scale
PATH="/usr/lib/llvm-18/bin:$PATH" cargo xwin check --offline --manifest-path src-tauri/Cargo.toml --bin cpa-gui --target x86_64-pc-windows-msvc
```

The last command needs the installed Windows Rust target, cached xwin SDK/CRT,
clang-cl, lld-link and llvm-lib. Linux tests exercise decisions and physical-size
selection, not Windows COM/native behavior. A Windows typecheck does not establish
that RDP delivers the expected events or that WebView2 recovers successfully.

## Required Windows validation

Use a disposable portable profile on Windows 11 with WebView2 156. Capture Windows
debug output (for example, DebugView's Win32 capture) before launch; recovery
messages have the `[WebView recovery]` prefix and include PID, generation, exit
kind, replacement client size, rate-limit notices and operation errors. They are
also written to stderr when a console/debug launch exposes it.

1. Enable silent start and minimize-to-tray. Launch hidden, connect RDP at 125%,
   disconnect, unlock the console at 100%, and restore through the tray. Verify
   the UI renders and the main WRY host matches the actual physical client
   (for example 1920x1032, not stale 2400x1290). Repeat with a visible window,
   maximized window, and a window minimized during the session transition.
2. Repeat healthy focus, tray hide/show and single-instance activation cycles.
   Verify no browser replacement messages, no duplicate `main` label, unchanged
   native placement/maximized state and unchanged managed core PID.
3. Open a plugin child WebView, then terminate the main browser PID in an isolated
   test session to exercise actual teardown. Verify exactly one replacement,
   restored rendering, unchanged native/core windows, and no destruction of a
   healthy plugin child. Without navigating away or unmounting React first,
   verify the recovered home has no plugin overlay, including after tray/focus
   synchronization. Show the plugin again: a separate-browser session must retain
   its navigation/state; a same-browser controller must be recreated and usable.
   Delay old show/bounds/hide requests across recovery and a new plugin show;
   verify they cannot reshow or hide the new owner's controller.
   Forced termination tests failure exits; separately reproduce the reported
   **normal** exit via RDP and confirm the event kind and replacement.
4. Inject repeated browser exits/creation failures. Verify cooldown and the
   three-attempt rolling limit; restore after cooldown to retry. Check errors
   identify the failed operation rather than restarting the app or core.
5. Quit normally, including while recovery is queued or the window is hidden.
   Confirm no replacement after shutdown begins and no app/core respawn.

Native RDP/COM execution is unavailable on the Linux verification host. Event
delivery for the reported normal browser teardown, physical DPI transitions,
replacement stacking/visibility and shutdown races require these Windows checks.

## Local verification — November 2, 2026

Logs are saved outside the worktree at
`/home/lzt404/cpa-project/workflow/logs/issue557-native-20261102/`.

| Command (from repository root) | Exact result | Log |
| --- | --- | --- |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml --bin cpa-gui webview_recovery` | exit 0; 4 passed, 0 failed | `recovery.log` |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml --bin cpa-gui plugin_webview` | exit 0; 11 passed, 0 failed, including 2 abrupt-loss regressions without React cleanup | `plugin-webview.log` |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml --bin cpa-gui physical_window_size_uses_display_scale` | exit 0; 1 passed, 0 failed | `geometry.log` |
| `PLAYWRIGHT_MODULE=/home/lzt404/cpa-project/workflow/node_modules/playwright node tests/plugin-webview-lifecycle-ui.cjs` | exit 0; 8 PASS assertions | `lifecycle-ui.log` |
| `bun run build` | exit 0; TypeScript and Vite build completed | `build.log` |
| `PATH="/usr/lib/llvm-18/bin:$PATH" cargo xwin check --offline --manifest-path src-tauri/Cargo.toml --bin cpa-gui --target x86_64-pc-windows-msvc` | exit 0; Windows typecheck completed, 1 existing warning | `windows-check.log` |

Rust test builds report four unrelated existing warnings: an unused import in
`src/tests/deepseek_desktop.rs`, an unused `scale_factor` in
`src/core_config/settings.rs`, and unused functions in
`src/agents/deepseek_desktop.rs` and `src/agents/discovery.rs`. The Windows
typecheck reports only the existing `scale_factor` warning. These were not changed.

`tests/plugin-webview-ui.cjs` was deliberately not run: its known unrelated layout
failure is Y=4 versus expected 0, with process-chain cleanup concerns. No layout
changes or broad process cleanup were performed. The lifecycle UI test still
tests React unmount; the new Rust regressions cover abrupt frontend loss directly.

Native Windows/RDP execution is unavailable on E5; the Windows fix is not runtime
verified. The required Windows checklist remains outstanding. Pipeline-nomerge
must rerun full review, build, real GUI and screenshots; review findings or a
WARN/failure override a nominal `exit=ok`. Local command success is not a claim
that those gates have passed.
