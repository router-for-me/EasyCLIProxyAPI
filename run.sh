#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_BIN="$ROOT_DIR/bin-work/Easy_CLIProxyAPI"

if [ ! -x "$APP_BIN" ]; then
  echo "Executable not found: $APP_BIN"
  echo "Run ./build.sh first."
  exit 1
fi

exec "$APP_BIN"
