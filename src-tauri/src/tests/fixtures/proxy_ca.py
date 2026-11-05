import base64
import contextlib
import http.server
import os
from pathlib import Path
import select
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading


def openssl(*args):
    subprocess.run(["openssl", *args], check=True, capture_output=True, timeout=15)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class IPv6Server(Server):
    address_family = socket.AF_INET6


class Origin(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        payload = (os.environ["CPA_TLS_MANIFEST"].encode()
                   if self.path.startswith("/manifest.json") else b"fixture archive")
        self.send_response(200)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class Proxy(http.server.BaseHTTPRequestHandler):
    def do_CONNECT(self):
        expected = "Basic " + base64.b64encode(b"proxy-user:proxy-password").decode()
        if self.headers.get("Proxy-Authorization") != expected:
            self.send_error(407)
            return
        self.server.connects.append(self.path)
        if self.server.reject:
            self.send_error(502)
            return
        with socket.create_connection(self.server.origin, timeout=5) as upstream:
            self.send_response(200)
            self.end_headers()
            while True:
                readable, _, _ = select.select([self.connection, upstream], [], [], 5)
                if not readable:
                    return
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is self.connection else self.connection).sendall(data)

    def do_GET(self):
        self.server.connects.append("unexpected plaintext proxy request")
        self.send_error(502)

    def log_message(self, *args):
        pass


def serve(stack, handler, server_type=Server, address=("127.0.0.1", 0)):
    server = server_type(address, handler)
    stack.callback(server.server_close)
    stack.callback(server.shutdown)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    with tempfile.TemporaryDirectory(prefix="cpa-proxy-ca-") as directory, contextlib.ExitStack() as stack:
        root = Path(directory)
        contexts = {}
        for name in ["trusted", "untrusted"]:
            ca, key = str(root / f"{name}-ca.pem"), str(root / f"{name}-ca.key")
            openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
                    "-subj", f"/CN=Fixture {name} CA", "-addext", "basicConstraints=critical,CA:TRUE",
                    "-keyout", key, "-out", ca)
            leaf_key, csr, cert = [str(root / f"{name}.{ext}") for ext in ["key", "csr", "pem"]]
            openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=update.test",
                    "-keyout", leaf_key, "-out", csr)
            extensions = root / f"{name}.ext"
            extensions.write_text("subjectAltName=DNS:update.test,DNS:untrusted.test\n"
                                  "basicConstraints=critical,CA:FALSE\n"
                                  "keyUsage=critical,digitalSignature,keyEncipherment\n"
                                  "extendedKeyUsage=serverAuth\n")
            openssl("x509", "-req", "-in", csr, "-CA", ca, "-CAkey", key, "-CAcreateserial",
                    "-days", "2", "-sha256", "-extfile", str(extensions), "-out", cert)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, leaf_key)
            contexts[name] = context
        contexts["trusted"].set_servername_callback(
            lambda connection, name, _: setattr(connection, "context", contexts[
                "untrusted" if name == "untrusted.test" else "trusted"]))
        tls = serve(stack, Origin)
        tls.socket = contexts["trusted"].wrap_socket(tls.socket, server_side=True)
        plain = serve(stack, Origin)
        ipv6 = serve(stack, Origin, IPv6Server, ("::1", 0))
        proxy = serve(stack, Proxy)
        proxy.origin, proxy.reject, proxy.connects = tls.server_address, False, []
        failed = serve(stack, Proxy)
        failed.origin, failed.reject, failed.connects = tls.server_address, True, []
        empty = root / "empty"
        empty.mkdir()
        environment = dict(os.environ)
        environment.update({
            "SSL_CERT_FILE": str(root / "trusted-ca.pem"), "SSL_CERT_DIR": str(empty),
            "CPA_TLS_FIXTURE_PROXY": f"http://proxy-user:proxy-password@127.0.0.1:{proxy.server_port}",
            "CPA_TLS_FIXTURE_FAILED_PROXY": f"http://proxy-user:proxy-password@127.0.0.1:{failed.server_port}",
            "CPA_TLS_FIXTURE_PLAIN": str(plain.server_port),
            "CPA_TLS_FIXTURE_IPV6": str(ipv6.server_port),
            "CPA_TLS_FIXTURE_TLS": f"127.0.0.1:{tls.server_port}",
            "HTTPS_PROXY": f"http://127.0.0.1:{failed.server_port}",
            "HTTP_PROXY": f"http://127.0.0.1:{failed.server_port}",
            "ALL_PROXY": f"http://127.0.0.1:{failed.server_port}", "NO_PROXY": "",
        })
        for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]:
            environment[name.lower()] = environment[name]
        subprocess.run([sys.argv[1], "--exact", "tests::app_update::proxy_ca_native_roots_connect_regression",
                        "--nocapture"], env=environment, check=True, timeout=60)
        assert set(proxy.connects) == {"update.test:443", "untrusted.test:443", "mismatch.test:443"}, proxy.connects
        assert failed.connects == ["update.test:443"], failed.connects


if __name__ == "__main__":
    main()
