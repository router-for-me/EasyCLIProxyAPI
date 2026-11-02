#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
os=$(go env GOOS)
arch=$(go env GOARCH)
if [[ "$os" != "$(go env GOHOSTOS)" || "$arch" != "$(go env GOHOSTARCH)" ]]; then
  echo 'Build natively on the target platform with its C compiler; cross builds are not packaged.' >&2
  exit 1
fi
case "$os" in
  linux) ext=so ;;
  darwin) ext=dylib ;;
  windows) ext=dll ;;
  *) echo "Unsupported platform: $os" >&2; exit 1 ;;
esac
stage="artifacts/$os-$arch/weekly-reset-priority"
mkdir -p "$stage"
CGO_ENABLED=1 go build -mod=readonly -trimpath -buildmode=c-shared -o "$stage/weekly-reset-priority.$ext" .
cp manifest.json README.zh-CN.md LICENSE THIRD_PARTY_NOTICES.txt "$stage/"
archive="artifacts/weekly-reset-priority-0.1.0-$os-$arch.tar.gz"
tar -czf "$archive" -C "artifacts/$os-$arch" weekly-reset-priority
if command -v sha256sum >/dev/null; then sha256sum "$archive" > "$archive.sha256"; else shasum -a 256 "$archive" > "$archive.sha256"; fi
printf 'Library: %s/weekly-reset-priority.%s\nArchive: %s\n' "$stage" "$ext" "$archive"
