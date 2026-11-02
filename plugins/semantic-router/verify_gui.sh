#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${CPA_GUI:?Set CPA_GUI to the release cpa-gui binary}"
: "${CPA_CORE:?Set CPA_CORE to a kernel binary}"
gui="$(realpath "$CPA_GUI")"
core="$(realpath "$CPA_CORE")"
mkdir -p .build
temporary="$(mktemp -d "$PWD/.build/gui-verify-XXXXXX")"
gui_pid= core_pid= wm_pid= xvfb_pid=
cleanup() {
  for pid in "$gui_pid" "$core_pid" "$wm_pid" "$xvfb_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$temporary"
}
trap cleanup EXIT
mkdir -p "$temporary/home" "$temporary/tmp" "$temporary/xdg" "$temporary/cpa-core"
cp "$gui" "$temporary/EasyCLIProxyAPI"
cp "$core" "$temporary/cpa-core/cli-proxy-api"
cp ../../core-version.txt "$temporary/core-version.txt"
port="$(python3 -c 'import socket; connection=socket.socket(); connection.bind(("127.0.0.1",0)); print(connection.getsockname()[1]); connection.close()')"
cat > "$temporary/config.toml" <<EOF
locale = "zh-CN"
host = "127.0.0.1"
port = $port
start-core-on-launch = false
silent-start = false
management-secret-key = "gui-smoke-management"
auth-dir = "$temporary/auth"
api-keys = ["gui-smoke-client"]
EOF
cat > "$temporary/config.yaml" <<EOF
host: "127.0.0.1"
port: $port
auth-dir: "$temporary/auth"
api-keys: ["gui-smoke-client"]
remote-management:
  secret-key: "gui-smoke-management"
  disable-control-panel: true
EOF
export HOME="$temporary/home" TMPDIR="$temporary/tmp" XDG_CONFIG_HOME="$temporary/xdg"
Xvfb -displayfd 3 -screen 0 1280x900x24 3>"$temporary/display" >"$temporary/xvfb.log" 2>&1 &
xvfb_pid=$!
for attempt in {1..50}; do [[ -s "$temporary/display" ]] && break; sleep 0.1; done
export DISPLAY=":$(cat "$temporary/display")"
xfwm4 >"$temporary/wm.log" 2>&1 &
wm_pid=$!
(cd "$temporary"; exec ./cpa-core/cli-proxy-api -config config.yaml --local-model) >"$temporary/core.log" 2>&1 &
core_pid=$!
(cd "$temporary"; WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 exec ./EasyCLIProxyAPI) >"$temporary/app.log" 2>&1 &
gui_pid=$!
window=
for attempt in {1..80}; do
  window="$(xwininfo -root -tree 2>/dev/null | awk '/"EasyCLIProxyAPI"/ && /[0-9][0-9][0-9]+x[0-9][0-9][0-9]+/ { print $1; exit }')"
  [[ -n "$window" ]] && break
  if ! kill -0 "$gui_pid" 2>/dev/null; then cat "$temporary/app.log"; exit 1; fi
  sleep 0.25
done
if [[ -z "$window" ]]; then
  cat "$temporary/app.log" "$temporary/wm.log" "$temporary/xvfb.log"
  xwininfo -root -tree
  echo "No GUI window" >&2
  exit 1
fi
sleep 5
screenshot="${GUI_SCREENSHOT:-/tmp/ecpa_issue-536-auto-router-plugin-1102_ui_verify-gui.png}"
xwd -id "$window" -silent >"$temporary/window.xwd"
convert "xwd:$temporary/window.xwd" "$screenshot"
identify "$screenshot"
colors="$(convert "$screenshot" -format '%k' info:)"
[[ "$colors" -gt 100 ]] || { echo "GUI appears blank" >&2; exit 1; }
[[ "$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/models")" == 401 ]]
[[ "$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer gui-smoke-client' "http://127.0.0.1:$port/v1/models")" == 200 ]]
echo "PASS: isolated release GUI window=$window colors=$colors, core unauthenticated=401 authenticated=200; $screenshot"
