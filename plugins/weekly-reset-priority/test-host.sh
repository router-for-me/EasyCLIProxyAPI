#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
mkdir -p .build/logs
sdk=$(go list -m -f '{{.Dir}}' github.com/router-for-me/CLIProxyAPI/v8)
root=$PWD
(cd "$sdk" && CGO_ENABLED=1 go build -mod=readonly -o "$root/.build/cli-proxy-api" ./cmd/server)
WEEKLY_LOG_DIR="$root/.build/logs" WEEKLY_CORE="$root/.build/cli-proxy-api" WEEKLY_PLUGIN="$root/artifacts/$(go env GOOS)-$(go env GOARCH)/weekly-reset-priority/weekly-reset-priority.$(case $(go env GOOS) in darwin) echo dylib;; windows) echo dll;; *) echo so;; esac)" go test -timeout=3m -count=1 -v ./integration 2>&1 | tee .build/logs/integration.log
