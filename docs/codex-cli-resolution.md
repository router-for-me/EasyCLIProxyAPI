# Codex CLI resolution

Codex CLI and Codex App are independent installation and launch targets.
CLI resolution uses, in order:

1. The manually selected CLI executable.
2. A nonempty `CODEX_CLI_PATH` executable path (whitespace-only values are ignored).
3. Process `PATH`, in directory order.
4. Windows registered PATH supplements and the existing CLI/package-manager directories.

An explicit manual or environment override that cannot run `--version` produces
a detection error; it does not silently select another installation. Automatic
discovery skips unusable candidates and stops at the first successful version
probe. App-managed private directories are not scanned. A directory explicitly
added to PATH, or a manually selected executable in such a directory, is respected.
App detection, metadata versions, and App launch routes remain separate.

Resolution returns the executable path and its already-probed version together.
Each fresh status inspection probes a successful candidate once. CLI launch does
one fresh inspection and reuses that inspection's executable, without another
lookup or version probe. An earlier UI refresh and a later launch are separate
operations, each with one probe; no resolver cache is introduced. Existing status
display caching is unchanged, and the explicit refresh command performs detection
again. File changes, PATH changes, and override changes are read on each fresh
resolution, so launch does not trust an old status display.
The production CLI launch route and isolated fixture tests share a Codex-only
launch plan containing the executable, arguments and environment PATH. Preparing
that plan consumes the inspected executable without another resolution or probe.
Daemon command construction also uses CLI resolution, not App discovery, and
rejects invalid explicit overrides instead of switching installations.

Version probes keep the five-second timeout, null stdin, captured stdout/stderr,
Windows batch handling, and executable-directory/CLI search PATH support.
Codex CLI launches also receive the helper PATH used for probing. Probes do not
install, update, or invoke a daemon. On Unix, Codex probes own a separate process
group and clean up descendants as well, so shim children cannot hold captured
pipes open past the timeout. Other agents keep their existing probe behavior.
Windows wrapper execution still needs native
Windows validation; portable argument construction is covered on Linux.

Reference: Cockpit commit `3a96a72a57d1282486137c9c1e7bf9daa0e761dc`,
`codex_wakeup.rs` (`build_usable_resolved_binary`, `probe_binary_version`,
`resolve_binary_with_runtime_config`, `fetch_binary_version`) and
`codex_instance.rs` (`build_launch_command`). The implementation follows the
single validated-result pattern, not Cockpit's implicit `official_app` fallback,
fallback after an invalid explicit override, or three-second timeout.
