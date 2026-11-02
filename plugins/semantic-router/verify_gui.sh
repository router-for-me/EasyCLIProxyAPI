#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${CPA_GUI:?Set CPA_GUI to the release cpa-gui binary}"
: "${CPA_CORE:?Set CPA_CORE to a kernel binary}"
gui="$(realpath "$CPA_GUI")"
core="$(realpath "$CPA_CORE")"
mkdir -p .build
if [[ "${CPA_GUI_ISOLATED:-}" != 1 ]]; then
  temporary="$(mktemp -d "$PWD/.build/gui-verify-XXXXXX")"
  mkdir -p "$temporary"/{home,tmp,xdg,runtime,cache,data}
  chmod 700 "$temporary/runtime"
  env -u DBUS_SESSION_BUS_ADDRESS -u SESSION_MANAGER \
    HOME="$temporary/home" TMPDIR="$temporary/tmp" XDG_CONFIG_HOME="$temporary/xdg" \
    XDG_RUNTIME_DIR="$temporary/runtime" XDG_CACHE_HOME="$temporary/cache" XDG_DATA_HOME="$temporary/data" \
    CPA_GUI="$gui" CPA_CORE="$core" CPA_GUI_ISOLATED=1 CPA_GUI_TEMP="$temporary" \
    setsid dbus-run-session -- bash "$PWD/verify_gui.sh" &
  session_pid=$!
  trap 'kill -- "-$session_pid" 2>/dev/null || true' EXIT
  if wait "$session_pid"; then
    kill -- "-$session_pid" 2>/dev/null || true
    for attempt in {1..50}; do
      if rm -rf "$temporary" 2>/dev/null; then exit 0; fi
      sleep 0.1
    done
    echo "GUI verification cleanup failed: $temporary" >&2
    exit 1
  else
    echo "GUI verification failed; debug logs preserved: $temporary" >&2
    exit 1
  fi
  exit 0
fi
temporary="${CPA_GUI_TEMP:?}"
gui_pid= core_pid= wm_pid= xvfb_pid=
cleanup() {
  for pid in "$gui_pid" "$core_pid" "$wm_pid" "$xvfb_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
mkdir -p "$temporary/home" "$temporary/tmp" "$temporary/xdg" "$temporary/cpa-core"
mkdir -p "$temporary/xdg/autostart"
for desktop in /etc/xdg/autostart/*.desktop; do
  [[ -f "$desktop" ]] || continue
  printf '[Desktop Entry]\nType=Application\nHidden=true\n' > "$temporary/xdg/autostart/${desktop##*/}"
done
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
xfce4-session >"$temporary/wm.log" 2>&1 &
wm_pid=$!
(cd "$temporary"; exec ./cpa-core/cli-proxy-api -config config.yaml --local-model) >"$temporary/core.log" 2>&1 &
core_pid=$!
(cd "$temporary"; WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 exec ./EasyCLIProxyAPI) >"$temporary/app.log" 2>&1 &
gui_pid=$!
window=
for attempt in {1..80}; do
  for candidate in $(xwininfo -root -tree 2>/dev/null | awk '/"EasyCLIProxyAPI"/ { print $1 }'); do
    details="$(xwininfo -id "$candidate" 2>/dev/null || true)"
    if echo "$details" | awk '
      /Width:/ { width=$2 } /Height:/ { height=$2 }
      /Class: InputOutput/ { input=1 } /Map State: IsViewable/ { visible=1 }
      END { exit !(width>100 && height>100 && input && visible) }'; then
      window="$candidate"
      break
    fi
  done
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
convert "$screenshot" -format 'unique_colors=%k mean=%[fx:mean] stddev=%[fx:standard_deviation]\n' info:
[[ "$colors" -gt 100 ]] || { echo "GUI appears blank" >&2; exit 1; }
[[ "$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/models")" == 401 ]]
[[ "$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer gui-smoke-client' "http://127.0.0.1:$port/v1/models")" == 200 ]]
echo "PASS: isolated release GUI window=$window colors=$colors, core unauthenticated=401 authenticated=200; $screenshot"
