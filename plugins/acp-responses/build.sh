#!/bin/sh
set -eu

# Build in place or into a caller-owned directory; never install into a live host.
cd "$(dirname "$0")"
platform=$(go env GOOS)
architecture=$(go env GOARCH)
case "$platform" in
  linux) suffix=so ;;
  darwin) suffix=dylib ;;
  windows) suffix=dll ;;
  *) printf 'Unsupported native platform: %s\n' "$platform" >&2; exit 1 ;;
esac
out=${1:-"dist/$platform/$architecture"}
mkdir -p "$out"
CGO_ENABLED=1 go build -mod=readonly -trimpath -buildmode=c-shared -o "$out/ecpa-acp-responses.$suffix" .
printf '%s\n' "$out/ecpa-acp-responses.$suffix"
