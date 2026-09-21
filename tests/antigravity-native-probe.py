import argparse
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description="Probe CPA launch helpers with installed Antigravity binaries and a local mock API.")
    parser.add_argument("--cpa", type=Path, required=True)
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument("--language-server", type=Path, required=True)
    args = parser.parse_args()
    for path in (args.cpa, args.cli, args.language_server):
        if not path.is_file():
            parser.error(f"Binary not found: {path}")
    cpa = str(args.cpa.resolve())
    answer = "CPA integration probe OK"
    seen = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            seen.append((self.path, self.headers.get("x-goog-api-key")))
            selected = "/models/cpa-test-model:" in self.path
            self.send_response(200 if selected else 404)
            self.send_header("Content-Type", "text/event-stream" if selected else "application/json")
            self.end_headers()
            if selected:
                body = {"candidates": [{"content": {"role": "model", "parts": [{"text": answer}]}, "finishReason": "STOP"}],
                        "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 5, "totalTokenCount": 6}}
                self.wfile.write(("data: " + json.dumps(body) + "\n\n").encode())
            else:
                self.wfile.write(b'{"error":{"code":404,"message":"Model unavailable","status":"NOT_FOUND"}}')

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="cpa-antigravity-native-") as directory:
            root = Path(directory)
            gemini = root / ".gemini"
            settings = gemini / "antigravity-cli"
            settings.mkdir(parents=True)
            (settings / "settings.json").write_text(json.dumps({"modelProvider": "gemini", "enableTelemetry": False,
                "customModelsConfig": {"customModels": {"CPA (EasyCLIProxyAPI)": {"modelName": "cpa-test-model"}}}}))
            endpoint = f"http://127.0.0.1:{server.server_port}"
            (settings / "cpa-connection.json").write_text(json.dumps({"provider": "cpa-gui", "baseUrl": endpoint,
                "apiKey": "cpa-probe-key", "model": "cpa-test-model"}))
            env = dict(os.environ, HOME=directory, USERPROFILE=directory, APPDATA=str(root / "roaming"),
                LOCALAPPDATA=str(root / "local"), XDG_CONFIG_HOME=str(root / "config"),
                PATH=str(args.cli.resolve().parent) + os.pathsep + os.environ.get("PATH", ""),
                GOOGLE_API_KEY="must-be-removed", GEMINI_API_KEY="must-be-replaced", GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:1")
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            result = subprocess.run([cpa, "--cpa-antigravity-cli", directory, f"--print=Say exactly {answer}. Do not use tools.",
                "--print-timeout=15s"], env=env, cwd=root, capture_output=True, timeout=30, creationflags=flags)
            assert result.returncode == 0, result.stderr.decode(errors="replace")
            assert answer in result.stdout.decode(errors="replace"), result.stdout
            assert any("/models/cpa-test-model:" in path for path, _ in seen), seen
            assert all(key == "cpa-probe-key" for _, key in seen), seen
            print("PASS CLI: selected model, scoped credentials, response, unavailable auxiliary model")
            seen.clear()

            env.update(CPA_ANTIGRAVITY_LANGUAGE_SERVER=str(args.language_server.resolve()),
                CPA_ANTIGRAVITY_MODEL="cpa-test-model", GEMINI_API_KEY="cpa-probe-key", GOOGLE_GEMINI_BASE_URL=endpoint)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]

            def rpc(method, payload):
                request = urllib.request.Request(f"http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}",
                    data=json.dumps(payload).encode(), headers={"Content-Type": "application/json",
                    "X-Codeium-Csrf-Token": "cpa-probe", "Connect-Protocol-Version": "1"})
                with urllib.request.urlopen(request, timeout=15) as response:
                    return json.load(response)

            with (root / "server.log").open("wb") as log:
                proc = subprocess.Popen([cpa, "--extension_server_port", "0", f"--gemini_dir={gemini}", "--headless",
                    "--disable_telemetry", f"--http_server_port={port}", "--csrf_token=cpa-probe"], env=env, cwd=root,
                    stdin=subprocess.PIPE, stdout=log, stderr=log, creationflags=flags)
                try:
                    proc.stdin.write(b"\x0a\x09cpa-probe")
                    proc.stdin.close()
                    for _ in range(100):
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                                break
                        except OSError:
                            assert proc.poll() is None, (root / "server.log").read_text(errors="replace")
                            time.sleep(0.1)
                    model = "MODEL_GOOGLE_GEMINI_2_5_PRO"
                    cascade = rpc("StartCascade", {"workspaceUris": [root.as_uri()], "source": 1, "requestedModel": model})["cascadeId"]
                    rpc("SendUserCascadeMessage", {"cascadeId": cascade, "items": [{"text": "Say hello. Do not use tools."}],
                        "blocking": True, "cascadeConfig": {"plannerConfig": {"planModel": model}}})
                    steps = rpc("GetCascadeTrajectory", {"cascadeId": cascade})["trajectory"]["steps"]
                    assert any(step.get("plannerResponse", {}).get("response") == answer for step in steps), steps
                    assert seen and all("/models/cpa-test-model:" in path and key == "cpa-probe-key" for path, key in seen), seen
                finally:
                    proc.terminate()
                    proc.wait(timeout=5)
            for _ in range(50):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        time.sleep(0.1)
                except OSError:
                    break
            else:
                raise AssertionError("Native language server survived CPA helper termination")
            print("PASS IDE: stdin forwarding, selected model, scoped credentials, response, child cleanup")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
