#!/usr/bin/env python3
import contextlib
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent
CORE = os.environ.get("CPA_CORE")
if not CORE:
    raise SystemExit("Set CPA_CORE to a kernel >= 8.0.48 binary")
CORE = str(Path(CORE).resolve())
LIBRARY = ROOT / "dist/semantic-router-0.1.0-linux-amd64/semantic-router.so"
received = []
classifier_calls = []
mode = "normal"
lock = threading.Lock()


class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with lock:
            received.append(body)
        if body["model"] == "classifier":
            with lock:
                classifier_calls.append(body)
                current = mode
            if current == "timeout":
                time.sleep(0.6)
            if current == "error":
                self.send_error(503)
                return
            text = body["messages"][-1]["content"]
            answer = "1" if "程序" in text else "2"
            if current == "malformed":
                answer = "not a choice"
            payload = {"id": "classify", "object": "chat.completion", "model": "classifier", "choices": [{"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}]}
        elif body.get("stream"):
            payload = {"id": "stream", "object": "chat.completion.chunk", "model": body["model"], "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "run", "arguments": '{"ok":true}'}}]}, "finish_reason": None}]}
            terminal = {"id": "stream", "object": "chat.completion.chunk", "model": body["model"], "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}
            output = ("data: " + json.dumps(payload) + "\n\ndata: " + json.dumps(terminal) + "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(output)))
            self.end_headers()
            with contextlib.suppress(BrokenPipeError):
                self.wfile.write(output)
            return
        else:
            payload = {"id": "target", "object": "chat.completion", "model": body["model"], "choices": [{"index": 0, "message": {"role": "assistant", "content": body["model"]}, "finish_reason": "stop"}]}
        output = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(output)))
        self.end_headers()
        with contextlib.suppress(BrokenPipeError):
            self.wfile.write(output)


def free_port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def api(port, path, data=None, method=None, management=False):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Authorization": "Bearer " + ("smoke-management" if management else "smoke-client"), "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        print(f"HTTP {error.code} {path}: {error.read().decode()}")
        raise


def run():
    global mode
    upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="semantic-router-") as temporary:
            temporary = Path(temporary)
            plugin_dir = temporary / "plugins/linux/amd64"
            plugin_dir.mkdir(parents=True)
            shutil.copy2(LIBRARY, plugin_dir / LIBRARY.name)
            port = free_port()
            config = temporary / "config.yaml"
            config.write_text(f'''host: "127.0.0.1"
port: {port}
auth-dir: "{temporary / 'auth'}"
api-keys: ["smoke-client"]
remote-management:
  secret-key: "smoke-management"
  disable-control-panel: true
request-retry: 0
openai-compatibility:
  - name: local
    base-url: "http://127.0.0.1:{upstream.server_port}/v1"
    api-key-entries:
      - api-key: "smoke-upstream"
    models:
      - {{name: classifier}}
      - {{name: coder}}
      - {{name: writer}}
      - {{name: general}}
plugins:
  enabled: true
  dir: "{temporary / 'plugins'}"
  configs:
    semantic-router:
      enabled: true
      alias: semantic-auto
      timeout_ms: 150
      classifier: {{provider: openai-compatible-local, model: classifier}}
      fallback: {{provider: openai-compatible-local, model: general}}
      candidates:
        - {{provider: openai-compatible-local, model: coder, description: 程序设计和调试}}
        - {{provider: openai-compatible-local, model: writer, description: 诗歌和文学创作}}
''')
            with (temporary / "core.log").open("w+") as log:
                process = subprocess.Popen([CORE, "-config", str(config), "--local-model"], cwd=temporary, stdout=log, stderr=log, env={**os.environ, "HOME": str(temporary), "XDG_CONFIG_HOME": str(temporary / "xdg")})
                try:
                    for _ in range(100):
                        try:
                            listing = json.loads(api(port, "/v8/management/plugins", management=True))
                            if any(entry["id"] == "semantic-router" and entry.get("effective_enabled") for entry in listing.get("plugins", [])):
                                break
                        except (OSError, ValueError):
                            pass
                        if process.poll() is not None:
                            raise AssertionError("core exited")
                        time.sleep(0.1)
                    else:
                        raise AssertionError("native plugin did not become active")

                    def chat(text, model="semantic-auto", stream=False):
                        body = {"model": model, "messages": [{"role": "system", "content": "retain system"}, {"role": "user", "content": "previous task"}, {"role": "assistant", "content": None, "tool_calls": [{"id": "history_call", "type": "function", "function": {"name": "run", "arguments": "{}"}}]}, {"role": "tool", "tool_call_id": "history_call", "content": "private tool result"}, {"role": "user", "content": text}], "stream": stream, "temperature": 0.37,
                                "tools": [{"type": "function", "function": {"name": "run", "parameters": {"type": "object", "properties": {"ok": {"type": "boolean"}}}}}], "tool_choice": "auto"}
                        result = api(port, "/v1/chat/completions", body)
                        target = next(item for item in reversed(received) if item["model"] != "classifier")
                        for field in ["messages", "tools", "tool_choice", "temperature", "stream"]:
                            assert target[field] == body[field], (field, target, body)
                        return result, target

                    assert chat("请调试这个程序")[1]["model"] == "coder"
                    assert chat("请写一首诗")[1]["model"] == "writer"
                    count = len(classifier_calls)
                    assert chat("程序", model="writer")[1]["model"] == "writer"
                    assert len(classifier_calls) == count
                    output, target = chat("请调试这个程序", stream=True)
                    assert target["model"] == "coder" and b"tool_calls" in output and b"[DONE]" in output, (target, output)
                    assert len(classifier_calls) == count + 1, "classification recursed"
                    for call in classifier_calls:
                        assert call["stream"] is False
                        assert "tools" not in call
                        assert "private tool result" not in json.dumps(call)
                    config_path = "/v8/management/config/plugins/configs/semantic-router"
                    persisted = json.loads(api(port, config_path, management=True))
                    assert persisted["alias"] == "semantic-auto" and persisted["candidates"][0]["model"] == "coder"
                    persisted["candidates"][0]["model"] = "not-registered"
                    api(port, config_path, persisted, method="PUT", management=True)
                    time.sleep(0.8)
                    assert chat("程序")[1]["model"] == "writer", "unavailable candidate must be excluded"
                    for failure in ["malformed", "timeout", "error"]:
                        mode = failure
                        count = len(classifier_calls)
                        started = time.monotonic()
                        assert chat("程序")[1]["model"] == "general", failure
                        elapsed = time.monotonic() - started
                        assert len(classifier_calls) == count + 1, f"{failure} did not reach classifier"
                        if failure == "timeout":
                            assert 0.06 <= elapsed < 0.55, elapsed
                            time.sleep(0.8)
                    mode = "normal"
                    api(port, config_path + "/enabled", False, method="PUT", management=True)
                    time.sleep(0.8)
                    count = len(classifier_calls)
                    assert chat("程序", model="coder")[1]["model"] == "coder"
                    try:
                        chat("程序")
                        raise AssertionError("disabled alias unexpectedly routed")
                    except urllib.error.HTTPError:
                        pass
                    assert len(classifier_calls) == count
                    print("PASS: native loading, content selection, explicit bypass, SSE/tool payloads, recursion, malformed/error/timeout fallback, persistence, unavailable candidates, disable")
                except Exception:
                    log.flush()
                    log.seek(0)
                    print(log.read()[-16000:])
                    raise
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    finally:
        upstream.shutdown()
        upstream.server_close()
        thread.join()


if __name__ == "__main__":
    run()
