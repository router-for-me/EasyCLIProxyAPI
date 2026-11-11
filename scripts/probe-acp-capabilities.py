"""Inspect an official ACP server without reading credentials or providing tools.

By default only initialize/session lifecycle methods are called (no inference).
--live additionally makes two short model requests to check system instructions
and conversation recovery in a new process, using the supplied official profile.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time
import uuid


class Client:
    def __init__(self, executable, profile, workspace):
        environment = {
            k: v for k, v in os.environ.items()
            if not k.startswith(("GEMINI_", "GOOGLE_", "GCLOUD_", "VERTEX_", "CLIPROXYAPI_"))
        }
        environment["GEMINI_CLI_HOME"] = str(profile)
        self.process = subprocess.Popen(
            [str(executable), "acp", "--gemini-dir", str(profile / ".gemini"),
             "--app-data-dir", "antigravity-cli", "--disable-telemetry",
             "--include-default-customizations=false"],
            cwd=workspace, env=environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self.messages = queue.Queue(maxsize=128)
        self.next_id = 0
        self.denied_requests = 0
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    self.messages.put(json.loads(line))
                except ValueError:
                    continue
        finally:
            self.messages.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def call(self, method, params, timeout=30):
        self.next_id += 1
        request_id = self.next_id
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        updates = []
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"{method} timed out")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError(f"{method} timed out") from None
            if message is None:
                raise RuntimeError("Official ACP process closed its output")
            if "method" in message:
                if "id" in message:
                    self.denied_requests += 1
                    if message["method"] == "session/request_permission":
                        reply = {"result": {"outcome": {"outcome": "cancelled"}}}
                    else:
                        reply = {"error": {"code": -32601, "message": "Probe client capabilities disabled"}}
                    self.send({"jsonrpc": "2.0", "id": message["id"], **reply})
                elif message["method"] == "session/update":
                    updates.append(message.get("params", {}).get("update", {}))
            elif message.get("id") == request_id:
                if "error" in message:
                    # Error messages may contain private backend details. Record code only.
                    raise RuntimeError(f"{method} failed with RPC code {message['error'].get('code')}")
                return message.get("result", {}), updates

    def initialize(self):
        return self.call("initialize", {
            "protocolVersion": 1, "clientCapabilities": {},
            "clientInfo": {"name": "ecpa-capability-probe", "version": "1"},
        })[0]

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


def reply_text(updates):
    return "".join(
        update.get("content", {}).get("text", "") for update in updates
        if update.get("sessionUpdate") == "agent_message_chunk"
        and update.get("content", {}).get("type") == "text"
    ).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", default=shutil.which("agy"))
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    if not args.cli:
        parser.error("Official agy executable not found; provide --cli")
    profile = args.profile.resolve()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    workspace = output.parent / ("workspace-" + uuid.uuid4().hex[:12])
    workspace.mkdir()
    client = None
    report = {"live_inference": args.live}
    session_id = None
    try:
        client = Client(args.cli, profile, workspace)
        initialization = client.initialize()
        capabilities = initialization.get("agentCapabilities", {})
        report.update({
            "protocol_version": initialization.get("protocolVersion"),
            "agent_info": initialization.get("agentInfo"),
            "agent_capabilities": capabilities,
            "advertises_native_mcp": capabilities.get("mcpCapabilities", {}).get("acp", False),
        })
        params = {"cwd": str(workspace), "mcpServers": []}
        if args.live:
            append = capabilities.get("_meta", {}).get("antigravity", {}).get("systemPrompt", {}).get("append")
            if not append:
                raise RuntimeError("Agent does not advertise the Antigravity system prompt append extension")
            params["_meta"] = {"antigravity": {"systemPrompt": {"append":
                "For every assistant reply, begin with ACP_SYSTEM_OK. Do not use any tools."}}}
        session, _ = client.call("session/new", params)
        session_id = session["sessionId"]
        report["new_session"] = {
            "success": True,
            "model_count": len(session.get("models", {}).get("availableModels", [])),
            "config_options": session.get("configOptions", []),
        }
        if args.live:
            available = session.get("models", {}).get("availableModels", [])
            selected = next((model["modelId"] for model in available if model["modelId"] == "gemini-3.8-flash-low"), session["models"]["currentModelId"])
            client.call("session/set_model", {"sessionId": session_id, "modelId": selected})
            marker = "ACP_MEMORY_" + uuid.uuid4().hex[:12]
            result, updates = client.call("session/prompt", {
                "sessionId": session_id, "prompt": [{"type": "text", "text":
                    f"Remember {marker} for the next turn. Reply briefly that you remember. Do not use tools."}],
            }, timeout=120)
            report["first_turn"] = {
                "stop_reason": result.get("stopReason"),
                "system_append_observed": reply_text(updates).startswith("ACP_SYSTEM_OK"),
                "tool_updates": sum(u.get("sessionUpdate") in ("tool_call", "tool_call_update") for u in updates),
                "update_types": sorted({u.get("sessionUpdate", "unknown") for u in updates}),
            }
            if result.get("stopReason") != "end_turn" or not report["first_turn"]["system_append_observed"]:
                raise RuntimeError("System append inference check failed")
        lifecycle = capabilities.get("sessionCapabilities", {})
        if "close" not in lifecycle or "resume" not in lifecycle:
            raise RuntimeError("Agent does not advertise close and resume")
        client.call("session/close", {"sessionId": session_id})
        report["denied_requests_first_process"] = client.denied_requests
        client.close()
        client = Client(args.cli, profile, workspace)
        client.initialize()
        resumed, _ = client.call("session/resume", {"sessionId": session_id, **params})
        report["resume_new_process"] = {"success": True, "response_keys": sorted(resumed)}
        if args.live:
            result, updates = client.call("session/prompt", {
                "sessionId": session_id, "prompt": [{"type": "text", "text":
                    "What exact ACP_MEMORY_ marker did I ask you to remember? Reply with the marker. Do not use tools."}],
            }, timeout=120)
            report["resumed_turn"] = {
                "stop_reason": result.get("stopReason"),
                "memory_observed": marker in reply_text(updates),
                "system_append_observed": reply_text(updates).startswith("ACP_SYSTEM_OK"),
                "tool_updates": sum(u.get("sessionUpdate") in ("tool_call", "tool_call_update") for u in updates),
                "update_types": sorted({u.get("sessionUpdate", "unknown") for u in updates}),
            }
            if result.get("stopReason") != "end_turn" or not all(
                report["resumed_turn"][key] for key in ("memory_observed", "system_append_observed")
            ):
                raise RuntimeError("Resumed conversation inference check failed")
        client.call("session/close", {"sessionId": session_id})
        report["denied_requests_second_process"] = client.denied_requests
    except (OSError, RuntimeError, TimeoutError, KeyError) as error:
        report["error"] = str(error)
    finally:
        if client is not None:
            client.close()
        output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True))
    return 1 if "error" in report else 0


if __name__ == "__main__":
    raise SystemExit(main())
