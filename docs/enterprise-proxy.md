# Enterprise proxies and update certificates

Update metadata and archive downloads use the configured HTTP CONNECT proxy and
validate TLS certificates against both public WebPKI roots and native OS trust
roots. Administrators should install their corporate root CA into the OS trust
store used by the application (on Windows, Trusted Root Certification Authorities),
then restart the application. Do not turn off TLS validation. Unknown issuers and
certificates for the wrong hostname are rejected; a proxy alone does not confer
trust. Local management traffic continues to bypass the configured proxy.

Run the isolated regression on Linux with Python 3 and OpenSSL installed:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --bin cpa-gui proxy_ca_native_roots_connect_regression -- --nocapture
```

The fixture generates temporary CAs and serves HTTPS through a local CONNECT
proxy. Only the child test process receives `SSL_CERT_FILE`/`SSL_CERT_DIR`; no
machine certificates or proxy settings are changed. It checks metadata and
archive requests, failure with public roots alone, rejection of unknown issuers
and wrong hostnames, credential-safe errors, proxy failure, explicit direct
access, and loopback proxy bypass. Windows
and macOS use their native trust stores instead of these environment variables;
this fixture does not modify or validate those platform stores.
