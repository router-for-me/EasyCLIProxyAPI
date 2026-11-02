#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -n "${CPA_SDK_DIR:-}" ]]; then
  mkdir -p .build/sdk
  git -C "$CPA_SDK_DIR" archive v8.0.48 go.mod go.sum LICENSE sdk/pluginabi sdk/pluginapi | tar -x -C .build/sdk
  if [[ -f go.work ]]; then
    go work use . ./.build/sdk
  else
    GOWORK=off go work init . ./.build/sdk
  fi
elif [[ ! -f go.work ]]; then
  go mod download github.com/router-for-me/CLIProxyAPI/v8 gopkg.in/yaml.v3
fi
go test -race ./...
os="$(go env GOOS)"
arch="$(go env GOARCH)"
case "$os" in
  linux) extension=so ;;
  darwin) extension=dylib ;;
  windows) extension=dll ;;
  *) echo "Unsupported platform: $os" >&2; exit 1 ;;
esac
package="dist/semantic-router-0.1.0-$os-$arch"
mkdir -p "$package"
CGO_ENABLED=1 go build -trimpath -buildmode=c-shared -o "$package/semantic-router.$extension" .
rm -f "$package/semantic-router.h"
cp manifest.json README.zh-CN.md "$package/"
cp ../../LICENSE "$package/LICENSE"
sdk="$(go list -m -f '{{.Dir}}' github.com/router-for-me/CLIProxyAPI/v8)"
cp -f "$sdk/LICENSE" "$package/SDK-LICENSE"
yaml="$(go list -m -f '{{.Dir}}' gopkg.in/yaml.v3)"
cp -f "$yaml/LICENSE" "$package/YAML-LICENSE"
if [[ -f "$yaml/NOTICE" ]]; then cp -f "$yaml/NOTICE" "$package/YAML-NOTICE"; fi
cp -f "$(go env GOROOT)/LICENSE" "$package/GO-LICENSE"
if command -v sha256sum >/dev/null 2>&1; then
  checksum=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  checksum=(shasum -a 256)
else
  echo "A SHA-256 checksum tool is required: sha256sum or shasum" >&2
  exit 1
fi
(cd "$package" && "${checksum[@]}" "semantic-router.$extension" > SHA256SUMS)
tar -czf "$package.tar.gz" -C dist "$(basename "$package")"
echo "Install: $package/semantic-router.$extension"
