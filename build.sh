#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BUILD_JOBS="${CARGO_BUILD_JOBS:-20}"
APP_BIN="$ROOT_DIR/src-tauri/target/release/cpa-gui"
BIN_DIR="$ROOT_DIR/bin-work"
BIN_OUT="$BIN_DIR/Easy_CLIProxyAPI"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed or not in PATH."
  exit 1
fi

echo "Cargo build jobs: $BUILD_JOBS"
bun install
CARGO_BUILD_JOBS="$BUILD_JOBS" bun tauri build --no-bundle

if [ ! -x "$APP_BIN" ]; then
  echo "Build finished, but executable not found: $APP_BIN"
  exit 1
fi

mkdir -p "$BIN_DIR"
bun "$ROOT_DIR/scripts/prepare-portable.mjs" \
  --binary "$APP_BIN" \
  --output "$BIN_DIR"
chmod +x "$BIN_OUT"

echo "Built: $APP_BIN"
echo "Copied: $BIN_OUT"
