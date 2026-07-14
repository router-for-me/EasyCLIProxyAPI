#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BIN_DIR="$ROOT_DIR/bin-work"

rm -rf dist
rm -rf src-tauri/target
rm -rf src-tauri/gen
mkdir -p "$BIN_DIR"
find "$BIN_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +

echo "Cleaned build output."
