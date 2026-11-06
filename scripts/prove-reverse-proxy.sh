#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CPA_V8_TEST_CORE:?Set CPA_V8_TEST_CORE to an installed CPA v8 executable}"
export CPA_V8_TEST_CORE
build=$(mktemp)
root=$(mktemp -d /tmp/cpa-rp-proof.XXXXXX)
trap 'rm -f "$build"; rm -rf "$root"' EXIT
cargo test --manifest-path src-tauri/Cargo.toml --bin cpa-gui --no-run --message-format=json-render-diagnostics >"$build"
binary=$(python3 -c 'import json,sys
for line in open(sys.argv[1]):
    try: item=json.loads(line)
    except ValueError: continue
    if item.get("reason")=="compiler-artifact" and item.get("profile",{}).get("test") and item.get("executable"): print(item["executable"])' "$build" | tail -1)
cp "$binary" "$root/proof"
for scenario in "${@:-http tls stale save manual restart}"; do
    for case in $scenario; do
        rm -rf "$root/cpa-core"
        CPA_RP_ISOLATED_DIR="$root" CPA_RP_CASE="$case" "$root/proof" real_kernel_messages_chain --ignored --nocapture --test-threads=1
    done
done
