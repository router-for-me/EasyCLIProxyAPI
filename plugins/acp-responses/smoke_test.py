#!/usr/bin/env python3
"""Exercise a built executor in a pinned real CPA instance with only local fixtures."""
import contextlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import tempfile
import threading
import time

MODEL = "acp/synthetic"
CLIENT_KEY = "synthetic-client"
MANAGEMENT_KEY = "synthetic-management"
BRIDGE_KEY = "a" * 64
PREVIOUS = "resp_acp_" + "b" * 48
TOOL_RESULTS = [{"type": "function_call_output", "call_id": "call_native", "output": "synthetic result"}]


def sse(event_type, sequence, **fields):
    value = {"type": event_type, "sequence_number": sequence, **fields}
    return f"event: {event_type}\ndata: {json.dumps(value)}\n\n".encode()


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def output(self, status, value, content_type="application/json", fragment=False):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if fragment:
            for item in [data[:13], data[13:92], data[92:]]:
                self.wfile.write(item)
                self.wfile.flush()
                time.sleep(0.04)
        else:
            self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.observed.append((self.path, self.headers.get("Authorization"), body))
        if self.path == "/v1/chat/completions":
            self.output(200, {"id": "chat-legacy", "object": "chat.completion", "created": 0,
                              "model": MODEL, "choices": [{"index": 0, "finish_reason": "stop",
                              "message": {"role": "assistant", "content": "legacy"}}]})
            return
        if self.path != "/v1/responses":
            self.output(400, {"error": {"message": "unexpected fixture path"}})
            return
        if body.get("input") == "fail":
            self.output(502, {"error": {"message": "fixture side effect already happened"}})
            return
        response = {"id": "resp_native", "object": "response", "status": "completed", "model": MODEL,
                    "output": [], "previous_response_id": body.get("previous_response_id")}
        if body.get("input") == "hold":
            self.server.hold_started.set()
            self.connection.settimeout(5)
            try:
                if not self.connection.recv(1):
                    self.server.hold_closed.set()
            except OSError:
                pass
            return
        if body.get("stream"):
            created = sse("response.created", 1, response=response)
            if body.get("input") == "truncate":
                self.output(200, created, "text/event-stream", fragment=True)
            else:
                self.output(200, created + sse("response.completed", 2, response=response),
                            "text/event-stream", fragment=True)
        else:
            self.output(200, response)


@contextlib.contextmanager
def fixture():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    server.observed = []
    server.hold_started = threading.Event()
    server.hold_closed = threading.Event()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def run(core_binary, library, with_global_proxy):
    with tempfile.TemporaryDirectory(prefix="ecpa-native-cpa-") as temp, fixture() as bridge, fixture() as proxy:
        directory = Path(temp)
        keyfile = directory / "bridge-key.txt"
        keyfile.write_text(BRIDGE_KEY)
        keyfile.chmod(0o600)
        settings = directory / "bridge.json"
        settings.write_text(json.dumps({"enabled": True, "port": bridge.server_port}))
        settings.chmod(0o600)
        plugins = directory / "plugins"
        goos = {"Linux": "linux", "Darwin": "darwin", "Windows": "windows"}[platform.system()]
        goarch = {"x86_64": "amd64", "AMD64": "amd64", "arm64": "arm64", "aarch64": "arm64"}[platform.machine()]
        plugin_dir = plugins / goos / goarch
        plugin_dir.mkdir(parents=True)
        shutil.copy2(library, plugin_dir / ("ecpa-acp-responses" + library.suffix))
        with socket.socket() as port_check:
            port_check.bind(("127.0.0.1", 0))
            port = port_check.getsockname()[1]
        config = {
            "config-version": 8,
            "server": {"host": "127.0.0.1", "port": port},
            "management": {"secret-key": MANAGEMENT_KEY, "disable-control-panel": True, "disable-auto-update-panel": True},
            "oauth": {"auth-dir": str(directory / "auth")},
            "access": {"api-keys": [CLIENT_KEY]},
            "logging": {"to-file": False},
            "requests": {"retry": 3},
            "streaming": {"bootstrap-retries": 3},
            "api-keys": {"openai-compatibility": [{"name": "ecpa-antigravity-acp",
                "base-url": f"http://127.0.0.1:{bridge.server_port}/v1",
                "keys": [{"api-key": BRIDGE_KEY, "proxy-url": "direct"}], "models": [{"name": MODEL}]}]},
            "plugins": {"enabled": True, "dir": str(plugins), "configs": {
                "ecpa-acp-responses": {"enabled": True, "bridge_profile": str(directory)}}},
        }
        if with_global_proxy:
            config["requests"]["proxy-url"] = f"http://127.0.0.1:{proxy.server_port}"
        config_path = directory / "config.yaml"
        config_path.write_text(json.dumps(config))

        def api(path, body=None, key=CLIENT_KEY):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
            try:
                connection.request("GET" if body is None else "POST", path,
                                   body=None if body is None else json.dumps(body),
                                   headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
                reply = connection.getresponse()
                return reply.status, reply.read()
            finally:
                connection.close()

        with (directory / "core.log").open("w+") as log:
            core = subprocess.Popen([core_binary, "-config", config_path, "--local-model"], cwd=directory,
                                    stdout=log, stderr=log,
                                    env={**os.environ, "HOME": temp, "XDG_CONFIG_HOME": temp})
            try:
                for _ in range(100):
                    try:
                        status, payload = api("/v1/models")
                        if status == 200 and MODEL in {item["id"] for item in json.loads(payload)["data"]}:
                            break
                    except OSError:
                        pass
                    assert core.poll() is None, "isolated CPA exited"
                    time.sleep(0.05)
                else:
                    raise AssertionError("registered model unavailable")
                status, data = api("/v8/management/plugins", key=MANAGEMENT_KEY)
                assert status == 200 and any(item["id"] == "ecpa-acp-responses" and item["effective_enabled"]
                                             for item in json.loads(data)["plugins"]), data
                request = {"model": MODEL, "input": TOOL_RESULTS, "previous_response_id": PREVIOUS}
                assert api("/v1/responses", request, key="wrong")[0] == 401
                assert not bridge.observed
                for stream in (False, True):
                    status, data = api("/v1/responses", {**request, "stream": stream})
                    assert status == 200 and PREVIOUS.encode() in data, (status, data)
                    if stream:
                        assert data.count(b"event: response.completed\ndata:") == 1, data
                    else:
                        assert json.loads(data)["id"] == "resp_native"
                    seen_path, seen_key, seen_body = bridge.observed[-1]
                    assert seen_path == "/v1/responses" and seen_key == f"Bearer {BRIDGE_KEY}"
                    assert seen_body["input"] == TOOL_RESULTS and seen_body["previous_response_id"] == PREVIOUS
                assert len(bridge.observed) == 2
                status, data = api("/v1/chat/completions", {"model": MODEL, "messages": [{"role": "user", "content": "legacy"}]})
                assert status == 200 and b"chat-legacy" in data and bridge.observed[-1][0] == "/v1/chat/completions"
                for stream in (False, True):
                    before = len(bridge.observed)
                    status, data = api("/v1/responses", {"model": MODEL, "input": "fail", "stream": stream})
                    assert status == 502 and b"side effect" in data and len(bridge.observed) == before + 1, (status, data)
                    assert bridge.observed[-1][0] == "/v1/responses"
                before = len(bridge.observed)
                status, data = api("/v1/responses", {"model": MODEL, "input": "truncate", "stream": True})
                assert status == 200 and b"response.created" in data and b"response.completed" not in data and b"terminal event" in data, data
                assert len(bridge.observed) == before + 1
                for stream in (False, True):
                    bridge.hold_started.clear()
                    bridge.hold_closed.clear()
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
                    conn.request("POST", "/v1/responses", json.dumps({"model": MODEL, "input": "hold", "stream": stream}),
                                 {"Authorization": f"Bearer {CLIENT_KEY}", "Content-Type": "application/json"})
                    assert bridge.hold_started.wait(3), "pre-header request did not reach bridge"
                    conn.close()
                    assert bridge.hold_closed.wait(4), f"client disconnect did not cancel bridge request (stream={stream})"
                assert not proxy.observed, "CPA global proxy saw private bridge traffic"
                print(f"PASS (global proxy={with_global_proxy}): CPA auth, listing, native JSON/SSE continuation, Chat, no replay, disconnect")
            except BaseException:
                log.seek(0)
                print(log.read())
                raise
            finally:
                core.terminate()
                core.wait(timeout=5)


if __name__ == "__main__":
    for proxy_enabled in (False, True):
        run(Path(os.environ["CPA_CORE"]).resolve(), Path(os.environ["ACP_RELAY_LIBRARY"]).resolve(), proxy_enabled)
