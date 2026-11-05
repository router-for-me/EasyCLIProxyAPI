use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::core_config::{
    core_config_uses_v8, lock_core_config_file, nested_yaml_value,
    patch_existing_core_config, read_core_config_document, set_core_yaml_path_value,
};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde::{Deserialize, Serialize};
use tokio_rustls::TlsAcceptor;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReverseProxyConfig {
    pub enabled: bool,
    pub listen_host: String, // "0.0.0.0"
    pub listen_port: u16,    // 443
    pub target_port: u16,    // core port, e.g. 8317
    pub cert_path: String,
    pub key_path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReverseProxyHardening {
    pub loopback_bind: bool,
    pub trusted_proxies: bool,
    pub restart_required: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReverseProxyState {
    pub running: bool,
    pub listening: Option<String>, // "0.0.0.0:443"
    pub target: Option<String>,    // "127.0.0.1:8317"
    pub requests_total: u64,
    pub error: Option<String>, // last failure, user-facing and specific
    pub hardening: ReverseProxyHardening,
}

pub fn harden_core_config_document(document: &mut serde_norway::Value) -> Result<bool, String> {
    let v8 = core_config_uses_v8(document);
    let (host_path, proxies_path): (&[&str], &[&str]) = if v8 {
        (&["server", "host"], &["server", "trusted-proxies"])
    } else {
        (&["host"], &["trusted-proxies"])
    };

    let mut changed = set_core_yaml_path_value(
        document,
        host_path,
        serde_norway::Value::String("127.0.0.1".to_string()),
    )?;

    let (already_contains, existing_items) = {
        let root = document
            .as_mapping()
            .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
        match nested_yaml_value(root, proxies_path).and_then(|v| v.as_sequence()) {
            Some(seq) => {
                let contains = seq.iter().any(|item| item.as_str() == Some("127.0.0.1"));
                (contains, seq.clone())
            }
            None => (false, Vec::new()),
        }
    };

    if !already_contains {
        let mut new_seq = existing_items;
        new_seq.push(serde_norway::Value::String("127.0.0.1".to_string()));
        let proxies_changed = set_core_yaml_path_value(
            document,
            proxies_path,
            serde_norway::Value::Sequence(new_seq),
        )?;
        changed |= proxies_changed;
    }

    Ok(changed)
}

pub fn read_core_hardening(document: &serde_norway::Value) -> ReverseProxyHardening {
    let (host_val, proxies_val) = if let Some(root) = document.as_mapping() {
        if core_config_uses_v8(document) {
            (
                nested_yaml_value(root, &["server", "host"]),
                nested_yaml_value(root, &["server", "trusted-proxies"]),
            )
        } else {
            (
                nested_yaml_value(root, &["host"]),
                nested_yaml_value(root, &["trusted-proxies"]),
            )
        }
    } else {
        (None, None)
    };

    let loopback_bind = host_val.and_then(|v| v.as_str()) == Some("127.0.0.1");
    let trusted_proxies = proxies_val
        .and_then(|v| v.as_sequence())
        .map(|seq| seq.iter().any(|item| item.as_str() == Some("127.0.0.1")))
        .unwrap_or(false);

    ReverseProxyHardening {
        loopback_bind,
        trusted_proxies,
        restart_required: false,
    }
}

pub fn apply_core_hardening() -> Result<ReverseProxyHardening, String> {
    let install_dir = crate::core_runtime::core_install_dir()?;
    let config_path = install_dir.join(crate::CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Err("Kernel configuration has not been generated. Start the CPA kernel first".to_string());
    }

    let mut changed = false;
    patch_existing_core_config(|document| {
        changed = harden_core_config_document(document)?;
        Ok(changed)
    })?;

    let _config_guard = lock_core_config_file()?;
    let (_, document) = read_core_config_document()?;
    let mut hardening = read_core_hardening(document.get());
    hardening.restart_required = changed;
    Ok(hardening)
}

pub fn read_installed_core_hardening() -> ReverseProxyHardening {
    let Ok(_config_guard) = lock_core_config_file() else {
        return ReverseProxyHardening::default();
    };
    match read_core_config_document() {
        Ok((_, document)) => {
            let mut hardening = read_core_hardening(document.get());
            hardening.restart_required = false;
            hardening
        }
        Err(_) => ReverseProxyHardening::default(),
    }
}

pub fn is_hop_by_hop(name: &hyper::header::HeaderName) -> bool {
    let s = name.as_str();
    s.eq_ignore_ascii_case("connection")
        || s.eq_ignore_ascii_case("keep-alive")
        || s.eq_ignore_ascii_case("transfer-encoding")
        || s.eq_ignore_ascii_case("upgrade")
        || s.to_ascii_lowercase().starts_with("proxy-")
}

pub fn prepare_forwarded_headers(
    headers: &hyper::HeaderMap,
    peer_ip: &str,
) -> hyper::HeaderMap {
    let mut forwarded = hyper::HeaderMap::new();

    let mut connection_tokens = Vec::new();
    for val in headers.get_all(hyper::header::CONNECTION) {
        if let Ok(s) = val.to_str() {
            for part in s.split(',') {
                let trimmed = part.trim();
                if !trimmed.is_empty() {
                    connection_tokens.push(trimmed.to_ascii_lowercase());
                }
            }
        }
    }

    for (name, value) in headers.iter() {
        let name_str = name.as_str();

        if is_hop_by_hop(name) {
            continue;
        }

        if connection_tokens
            .iter()
            .any(|token| token.eq_ignore_ascii_case(name_str))
        {
            continue;
        }

        if name_str.eq_ignore_ascii_case("x-forwarded-for")
            || name_str.eq_ignore_ascii_case("x-forwarded-proto")
        {
            continue;
        }

        forwarded.append(name.clone(), value.clone());
    }

    if let Ok(val) = hyper::header::HeaderValue::from_str(peer_ip) {
        forwarded.insert(
            hyper::header::HeaderName::from_static("x-forwarded-for"),
            val,
        );
    }
    forwarded.insert(
        hyper::header::HeaderName::from_static("x-forwarded-proto"),
        hyper::header::HeaderValue::from_static("https"),
    );

    forwarded
}

pub fn prepare_response_headers(headers: &hyper::HeaderMap) -> hyper::HeaderMap {
    let mut response_headers = hyper::HeaderMap::new();

    let mut connection_tokens = Vec::new();
    for val in headers.get_all(hyper::header::CONNECTION) {
        if let Ok(s) = val.to_str() {
            for part in s.split(',') {
                let trimmed = part.trim();
                if !trimmed.is_empty() {
                    connection_tokens.push(trimmed.to_ascii_lowercase());
                }
            }
        }
    }

    for (name, value) in headers.iter() {
        let name_str = name.as_str();
        if is_hop_by_hop(name) {
            continue;
        }
        if connection_tokens
            .iter()
            .any(|token| token.eq_ignore_ascii_case(name_str))
        {
            continue;
        }
        response_headers.append(name.clone(), value.clone());
    }

    response_headers
}

pub fn build_target_uri(target_port: u16, original_uri: &hyper::Uri) -> Result<hyper::Uri, String> {
    let path_and_query = match original_uri.path_and_query() {
        Some(pq) => {
            let s = pq.as_str();
            if s.starts_with('/') {
                s.to_string()
            } else {
                format!("/{s}")
            }
        }
        None => {
            let path = original_uri.path();
            if path.is_empty() {
                "/".to_string()
            } else if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            }
        }
    };
    let url_str = format!("http://127.0.0.1:{}{}", target_port, path_and_query);
    url_str
        .parse::<hyper::Uri>()
        .map_err(|e| format!("Failed to build target URI from '{}': {e}", original_uri))
}

#[allow(dead_code)]
pub fn build_target_url(target_port: u16, original_uri: &hyper::Uri) -> Result<String, String> {
    let uri = build_target_uri(target_port, original_uri)?;
    Ok(uri.to_string())
}

pub fn validate_config(config: &ReverseProxyConfig) -> Result<(), String> {
    if config.listen_host.trim().is_empty() {
        return Err("Listen host cannot be empty".to_string());
    }
    if config.listen_port == 0 {
        return Err("Listen port cannot be 0".to_string());
    }
    if config.target_port == 0 {
        return Err("Target port cannot be 0".to_string());
    }
    if config.cert_path.trim().is_empty() {
        return Err("Certificate path cannot be empty".to_string());
    }
    if config.key_path.trim().is_empty() {
        return Err("Private key path cannot be empty".to_string());
    }
    Ok(())
}

pub fn load_tls_config(config: &ReverseProxyConfig) -> Result<Arc<rustls::ServerConfig>, String> {
    let cert_path = Path::new(&config.cert_path);
    if !cert_path.exists() {
        return Err(format!("Certificate file does not exist: {}", config.cert_path));
    }
    let cert_file = File::open(cert_path)
        .map_err(|e| format!("Failed to read certificate file '{}': {e}", config.cert_path))?;
    let mut cert_reader = BufReader::new(cert_file);
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to parse certificate PEM in '{}': {e}", config.cert_path))?;
    if certs.is_empty() {
        return Err(format!("No certificates found in '{}'", config.cert_path));
    }

    let key_path = Path::new(&config.key_path);
    if !key_path.exists() {
        return Err(format!("Private key file does not exist: {}", config.key_path));
    }
    let key_file = File::open(key_path)
        .map_err(|e| format!("Failed to read private key file '{}': {e}", config.key_path))?;
    let mut key_reader = BufReader::new(key_file);
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)
        .map_err(|e| format!("Failed to parse private key PEM in '{}': {e}", config.key_path))?
        .ok_or_else(|| format!("No private key found in '{}'", config.key_path))?;

    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("Invalid TLS certificate/key configuration: {e}"))?;

    server_config.alpn_protocols = vec![b"http/1.1".to_vec()];

    Ok(Arc::new(server_config))
}

async fn handle_forward(
    req: hyper::Request<hyper::body::Incoming>,
    client: Client<HttpConnector, hyper::body::Incoming>,
    target_port: u16,
    peer_ip: String,
    requests_total: Arc<AtomicU64>,
) -> Result<hyper::Response<BoxBody<Bytes, hyper::Error>>, std::convert::Infallible> {
    requests_total.fetch_add(1, Ordering::Relaxed);

    let (parts, body) = req.into_parts();
    let target_uri = match build_target_uri(target_port, &parts.uri) {
        Ok(uri) => uri,
        Err(err) => {
            let resp = hyper::Response::builder()
                .status(hyper::StatusCode::BAD_REQUEST)
                .header(hyper::header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(
                    Full::new(Bytes::from(format!("Bad Request: {err}")))
                        .map_err(|e| match e {})
                        .boxed(),
                )
                .unwrap();
            return Ok(resp);
        }
    };

    let forwarded_headers = prepare_forwarded_headers(&parts.headers, &peer_ip);

    let mut forwarded_req_builder = hyper::Request::builder()
        .method(parts.method)
        .uri(target_uri);

    if let Some(headers_mut) = forwarded_req_builder.headers_mut() {
        *headers_mut = forwarded_headers;
    }

    let forwarded_req = match forwarded_req_builder.body(body) {
        Ok(req) => req,
        Err(err) => {
            let resp = hyper::Response::builder()
                .status(hyper::StatusCode::INTERNAL_SERVER_ERROR)
                .header(hyper::header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(
                    Full::new(Bytes::from(format!("Internal Server Error: {err}")))
                        .map_err(|e| match e {})
                        .boxed(),
                )
                .unwrap();
            return Ok(resp);
        }
    };

    match client.request(forwarded_req).await {
        Ok(backend_resp) => {
            let (resp_parts, resp_body) = backend_resp.into_parts();
            let mut resp_builder = hyper::Response::builder().status(resp_parts.status);
            if let Some(headers_mut) = resp_builder.headers_mut() {
                *headers_mut = prepare_response_headers(&resp_parts.headers);
            }
            let resp = resp_builder.body(resp_body.boxed()).unwrap();
            Ok(resp)
        }
        Err(err) => {
            let resp = hyper::Response::builder()
                .status(hyper::StatusCode::BAD_GATEWAY)
                .header(hyper::header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(
                    Full::new(Bytes::from(format!(
                        "Bad Gateway: upstream target connection failed: {err}"
                    )))
                    .map_err(|e| match e {})
                    .boxed(),
                )
                .unwrap();
            Ok(resp)
        }
    }
}

#[derive(Default)]
struct ReverseProxyInner {
    running: bool,
    listening: Option<String>,
    target: Option<String>,
    error: Option<String>,
    stored_config: ReverseProxyConfig,
    hardening: ReverseProxyHardening,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    server_task: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Clone, Default)]
pub struct ReverseProxyManagerState {
    inner: Arc<std::sync::Mutex<ReverseProxyInner>>,
    requests_total: Arc<AtomicU64>,
}

impl ReverseProxyManagerState {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_state(&self) -> Result<ReverseProxyState, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
        Ok(ReverseProxyState {
            running: guard.running,
            listening: guard.listening.clone(),
            target: guard.target.clone(),
            requests_total: self.requests_total.load(Ordering::Relaxed),
            error: guard.error.clone(),
            hardening: guard.hardening.clone(),
        })
    }

    pub async fn stop(&self) -> Result<ReverseProxyState, String> {
        let (shutdown_tx, server_task) = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
            guard.running = false;
            guard.listening = None;
            guard.target = None;
            (guard.shutdown_tx.take(), guard.server_task.take())
        };

        if let Some(tx) = shutdown_tx {
            let _ = tx.send(());
        }
        if let Some(task) = server_task {
            let _ = task.await;
        }

        self.get_state()
    }

    pub async fn start<A: Into<Option<tauri::AppHandle>>>(
        &self,
        config: ReverseProxyConfig,
        app: A,
    ) -> Result<ReverseProxyState, String> {
        let app = app.into();
        self.stop().await?;

        if let Err(err) = validate_config(&config) {
            let mut guard = self
                .inner
                .lock()
                .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
            guard.error = Some(err.clone());
            guard.running = false;
            guard.listening = None;
            guard.target = None;
            return Err(err);
        }

        let tls_config = match load_tls_config(&config) {
            Ok(c) => c,
            Err(err) => {
                let mut guard = self
                    .inner
                    .lock()
                    .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
                guard.error = Some(err.clone());
                guard.running = false;
                guard.listening = None;
                guard.target = None;
                return Err(err);
            }
        };

        let bind_addr = format!("{}:{}", config.listen_host, config.listen_port);
        let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
            Ok(l) => l,
            Err(err) => {
                let err_msg = format!("Failed to bind listener on {bind_addr}: {err}");
                let mut guard = self
                    .inner
                    .lock()
                    .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
                guard.error = Some(err_msg.clone());
                guard.running = false;
                guard.listening = None;
                guard.target = None;
                return Err(err_msg);
            }
        };

        let listening_addr = format!("{}:{}", config.listen_host, config.listen_port);
        let target_addr = format!("127.0.0.1:{}", config.target_port);

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let acceptor = TlsAcceptor::from(tls_config);
        let client: Client<HttpConnector, hyper::body::Incoming> =
            Client::builder(TokioExecutor::new()).build_http();
        let requests_total = self.requests_total.clone();
        let target_port = config.target_port;

        let server_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => {
                        break;
                    }
                    accept_res = listener.accept() => {
                        match accept_res {
                            Ok((tcp_stream, peer_addr)) => {
                                let acceptor = acceptor.clone();
                                let client = client.clone();
                                let requests_total = requests_total.clone();
                                let peer_ip = peer_addr.ip().to_string();

                                tokio::spawn(async move {
                                    let tls_stream = match acceptor.accept(tcp_stream).await {
                                        Ok(s) => s,
                                        Err(_) => return,
                                    };

                                    let io = TokioIo::new(tls_stream);
                                    let service = hyper::service::service_fn(move |req| {
                                        let client = client.clone();
                                        let peer_ip = peer_ip.clone();
                                        let requests_total = requests_total.clone();
                                        async move {
                                            handle_forward(req, client, target_port, peer_ip, requests_total).await
                                        }
                                    });

                                    let _ = hyper::server::conn::http1::Builder::new()
                                        .serve_connection(io, service)
                                        .await;
                                });
                            }
                            Err(_) => {
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            }
                        }
                    }
                }
            }
        });

        let (mut hardening, mut restart_error) = match apply_core_hardening() {
            Ok(h) => (h, None),
            Err(err) => (ReverseProxyHardening::default(), Some(err)),
        };

        if hardening.restart_required {
            if let Some(app_handle) = app {
                if let Err(err) = crate::core_runtime::restart_core_process(app_handle).await {
                    restart_error = Some(format!("Failed to restart CPA kernel: {err}"));
                    hardening.restart_required = true;
                } else {
                    hardening.restart_required = false;
                }
            }
        }

        {
            let mut guard = self
                .inner
                .lock()
                .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
            guard.running = true;
            guard.listening = Some(listening_addr);
            guard.target = Some(target_addr);
            guard.error = restart_error;
            guard.stored_config = config;
            guard.hardening = hardening;
            guard.shutdown_tx = Some(shutdown_tx);
            guard.server_task = Some(server_task);
        }

        self.get_state()
    }

    pub async fn apply<A: Into<Option<tauri::AppHandle>>>(
        &self,
        config: ReverseProxyConfig,
        app: A,
    ) -> Result<ReverseProxyState, String> {
        let app = app.into();
        {
            let mut guard = self
                .inner
                .lock()
                .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
            guard.stored_config = config.clone();
        }

        if config.enabled {
            self.start(config, app).await
        } else {
            self.stop().await
        }
    }
}

#[tauri::command]
pub async fn reverse_proxy_get_state(
    state: tauri::State<'_, ReverseProxyManagerState>,
) -> Result<ReverseProxyState, String> {
    let mut current = state.get_state()?;
    let previous_restart_required = current.hardening.restart_required;
    let mut hardening = read_installed_core_hardening();
    hardening.restart_required = previous_restart_required;
    current.hardening = hardening;
    if let Ok(mut guard) = state.inner.lock() {
        guard.hardening = current.hardening.clone();
    }
    Ok(current)
}

#[tauri::command]
pub async fn reverse_proxy_apply(
    app: tauri::AppHandle,
    config: ReverseProxyConfig,
    state: tauri::State<'_, ReverseProxyManagerState>,
) -> Result<ReverseProxyState, String> {
    state.apply(config, app).await
}

#[tauri::command]
pub async fn reverse_proxy_start(
    app: tauri::AppHandle,
    config: ReverseProxyConfig,
    state: tauri::State<'_, ReverseProxyManagerState>,
) -> Result<ReverseProxyState, String> {
    state.start(config, app).await
}

#[tauri::command]
pub async fn reverse_proxy_stop(
    state: tauri::State<'_, ReverseProxyManagerState>,
) -> Result<ReverseProxyState, String> {
    state.stop().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::{HeaderMap, HeaderName, HeaderValue, CONNECTION};

    #[test]
    fn test_target_url_construction() {
        let uri: hyper::Uri = "/".parse().unwrap();
        assert_eq!(build_target_url(8317, &uri).unwrap(), "http://127.0.0.1:8317/");

        let uri: hyper::Uri = "/v1/chat/completions".parse().unwrap();
        assert_eq!(
            build_target_url(8317, &uri).unwrap(),
            "http://127.0.0.1:8317/v1/chat/completions"
        );

        let uri: hyper::Uri = "/v1/models?stream=true&limit=10".parse().unwrap();
        assert_eq!(
            build_target_url(8317, &uri).unwrap(),
            "http://127.0.0.1:8317/v1/models?stream=true&limit=10"
        );

        let uri: hyper::Uri = "https://custom.domain.org:8443/api/v1/resource?a=1".parse().unwrap();
        assert_eq!(
            build_target_url(9000, &uri).unwrap(),
            "http://127.0.0.1:9000/api/v1/resource?a=1"
        );

        let uri: hyper::Uri = "http://localhost:443/health".parse().unwrap();
        assert_eq!(
            build_target_url(8317, &uri).unwrap(),
            "http://127.0.0.1:8317/health"
        );
    }

    #[test]
    fn test_hop_by_hop_stripping() {
        let mut headers = HeaderMap::new();
        headers.insert(CONNECTION, HeaderValue::from_static("keep-alive, X-Hop-Custom"));
        headers.insert(
            HeaderName::from_static("keep-alive"),
            HeaderValue::from_static("timeout=5"),
        );
        headers.insert(
            HeaderName::from_static("transfer-encoding"),
            HeaderValue::from_static("chunked"),
        );
        headers.insert(
            HeaderName::from_static("upgrade"),
            HeaderValue::from_static("websocket"),
        );
        headers.insert(
            HeaderName::from_static("proxy-connection"),
            HeaderValue::from_static("keep-alive"),
        );
        headers.insert(
            HeaderName::from_static("proxy-authenticate"),
            HeaderValue::from_static("Basic"),
        );
        headers.insert(
            HeaderName::from_static("proxy-authorization"),
            HeaderValue::from_static("Bearer token"),
        );
        headers.insert(
            HeaderName::from_static("x-hop-custom"),
            HeaderValue::from_static("drop-me"),
        );
        headers.insert(
            HeaderName::from_static("content-type"),
            HeaderValue::from_static("application/json"),
        );

        let forwarded = prepare_forwarded_headers(&headers, "192.168.1.100");
        assert!(!forwarded.contains_key("connection"));
        assert!(!forwarded.contains_key("keep-alive"));
        assert!(!forwarded.contains_key("transfer-encoding"));
        assert!(!forwarded.contains_key("upgrade"));
        assert!(!forwarded.contains_key("proxy-connection"));
        assert!(!forwarded.contains_key("proxy-authenticate"));
        assert!(!forwarded.contains_key("proxy-authorization"));
        assert!(!forwarded.contains_key("x-hop-custom"));
        assert_eq!(forwarded.get("content-type").unwrap(), "application/json");

        let response = prepare_response_headers(&headers);
        assert!(!response.contains_key("connection"));
        assert!(!response.contains_key("keep-alive"));
        assert!(!response.contains_key("transfer-encoding"));
        assert!(!response.contains_key("upgrade"));
        assert!(!response.contains_key("proxy-connection"));
        assert!(!response.contains_key("proxy-authenticate"));
        assert!(!response.contains_key("proxy-authorization"));
        assert!(!response.contains_key("x-hop-custom"));
        assert_eq!(response.get("content-type").unwrap(), "application/json");
    }

    #[test]
    fn test_header_override_and_drop_logic() {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("x-forwarded-for"),
            HeaderValue::from_static("10.0.0.1, 10.0.0.2"),
        );
        headers.insert(
            HeaderName::from_static("x-forwarded-proto"),
            HeaderValue::from_static("http"),
        );
        headers.insert(
            HeaderName::from_static("authorization"),
            HeaderValue::from_static("Bearer token-abc"),
        );
        headers.insert(
            HeaderName::from_static("user-agent"),
            HeaderValue::from_static("cpa-client/1.0"),
        );

        let peer_ip = "203.0.113.195";
        let forwarded = prepare_forwarded_headers(&headers, peer_ip);

        // Client-supplied values must be dropped and replaced
        assert_eq!(
            forwarded.get("x-forwarded-for").unwrap(),
            "203.0.113.195"
        );
        assert_eq!(
            forwarded.get("x-forwarded-proto").unwrap(),
            "https"
        );

        // Original application headers must be preserved
        assert_eq!(
            forwarded.get("authorization").unwrap(),
            "Bearer token-abc"
        );
        assert_eq!(
            forwarded.get("user-agent").unwrap(),
            "cpa-client/1.0"
        );
    }

    #[test]
    fn test_config_validation_rejecting_empty_or_zero() {
        let valid_config = ReverseProxyConfig {
            enabled: true,
            listen_host: "0.0.0.0".to_string(),
            listen_port: 443,
            target_port: 8317,
            cert_path: "/path/to/cert.pem".to_string(),
            key_path: "/path/to/key.pem".to_string(),
        };

        assert!(validate_config(&valid_config).is_ok());

        // Empty listen host
        let mut cfg = valid_config.clone();
        cfg.listen_host = "".to_string();
        assert!(validate_config(&cfg).is_err());
        cfg.listen_host = "   ".to_string();
        assert!(validate_config(&cfg).is_err());

        // Port 0 listen
        let mut cfg = valid_config.clone();
        cfg.listen_port = 0;
        assert!(validate_config(&cfg).is_err());

        // Port 0 target
        let mut cfg = valid_config.clone();
        cfg.target_port = 0;
        assert!(validate_config(&cfg).is_err());

        // Empty cert path
        let mut cfg = valid_config.clone();
        cfg.cert_path = "".to_string();
        assert!(validate_config(&cfg).is_err());
        cfg.cert_path = "  ".to_string();
        assert!(validate_config(&cfg).is_err());

        // Empty key path
        let mut cfg = valid_config.clone();
        cfg.key_path = "".to_string();
        assert!(validate_config(&cfg).is_err());
        cfg.key_path = "  ".to_string();
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn test_config_validation_missing_or_invalid_files() {
        let cfg = ReverseProxyConfig {
            enabled: true,
            listen_host: "0.0.0.0".to_string(),
            listen_port: 443,
            target_port: 8317,
            cert_path: "/nonexistent/path/to/cert.pem".to_string(),
            key_path: "/nonexistent/path/to/key.pem".to_string(),
        };

        let res = load_tls_config(&cfg);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Certificate file does not exist"));
    }

    #[tokio::test]
    async fn test_full_reverse_proxy_flow() {
        let temp_dir = std::env::temp_dir().join(format!("cpa_test_proxy_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let cert_file = temp_dir.join("test_cert.pem");
        let key_file = temp_dir.join("test_key.pem");

        let cert_pem = concat!(
            "-----BEGIN CERTIFICATE-----\n",
            "MIIBfjCCASOgAwIBAgIUeH2i9sol4tHt/nKfVZWquQTtj7IwCgYIKoZIzj0EAwIw\n",
            "FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTEwNDA2MzAwNFoXDTM2MTEwMTA2\n",
            "MzAwNFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D\n",
            "AQcDQgAEppwE/9ezPY/zBzKXW5eXhCnwUraONa2YKaOYxojm+DWWRLmamnafDWba\n",
            "anN76LGQ96ClJe31yZg5SMAVxJGbRaNTMFEwHQYDVR0OBBYEFMFDe2nWoqboK0It\n",
            "0DjJ1DfYqYNIMB8GA1UdIwQYMBaAFMFDe2nWoqboK0It0DjJ1DfYqYNIMA8GA1Ud\n",
            "EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAPv6KkgHo+YplWawXtbpAwde\n",
            "7raXVCxwd4it/8Vh818hAiEAk9SeJ/Ozz8DunoT6hyO4X1XCARYRVwoJZTCWYkwI\n",
            "wJ4=\n",
            "-----END CERTIFICATE-----\n"
        );
        let key_pem = concat!(
            "-----BEGIN PRIVATE KEY-----\n",
            "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg9g2Sc0UuBLZYQ7pQ\n",
            "nXgPnQEdnTr6ot4tkIYGgP5YjAKhRANCAASmnAT/17M9j/MHMpdbl5eEKfBSto41\n",
            "rZgpo5jGiOb4NZZEuZqadp8NZtpqc3vosZD3oKUl7fXJmDlIwBXEkZtF\n",
            "-----END PRIVATE KEY-----\n"
        );

        std::fs::write(&cert_file, cert_pem).unwrap();
        std::fs::write(&key_file, key_pem).unwrap();

        // 1. Start mock HTTP backend
        let mock_backend = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = mock_backend.local_addr().unwrap().port();

        let backend_task = tokio::spawn(async move {
            let (stream, _) = mock_backend.accept().await.unwrap();
            let io = TokioIo::new(stream);
            let service = hyper::service::service_fn(|req: hyper::Request<hyper::body::Incoming>| async move {
                assert_eq!(req.headers().get("x-forwarded-proto").unwrap(), "https");
                assert_eq!(req.headers().get("x-forwarded-for").unwrap(), "127.0.0.1");
                assert!(!req.headers().contains_key("connection"));
                assert!(!req.headers().contains_key("proxy-authorization"));
                assert_eq!(req.headers().get("authorization").unwrap(), "Bearer secret-token");

                let body_bytes = req.into_body().collect().await.unwrap().to_bytes();
                assert_eq!(body_bytes, Bytes::from("ping from client"));

                let resp = hyper::Response::builder()
                    .status(hyper::StatusCode::OK)
                    .header("x-backend-handled", "true")
                    .header(hyper::header::CONNECTION, "close")
                    .body(Full::new(Bytes::from("pong from backend")).boxed())
                    .unwrap();
                Ok::<_, std::convert::Infallible>(resp)
            });

            hyper::server::conn::http1::Builder::new()
                .serve_connection(io, service)
                .await
                .unwrap();
        });

        // 2. Find an available port for proxy
        let proxy_port = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };

        // 3. Start reverse proxy
        let manager = ReverseProxyManagerState::new();
        let config = ReverseProxyConfig {
            enabled: true,
            listen_host: "127.0.0.1".to_string(),
            listen_port: proxy_port,
            target_port,
            cert_path: cert_file.to_str().unwrap().to_string(),
            key_path: key_file.to_str().unwrap().to_string(),
        };

        let state = manager.start(config.clone(), None).await.unwrap();
        assert!(state.running);
        assert_eq!(state.listening, Some(format!("127.0.0.1:{proxy_port}")));
        assert_eq!(state.target, Some(format!("127.0.0.1:{target_port}")));

        // 4. Client sends request to proxy over HTTPS
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .unwrap();

        let resp = client
            .post(format!("https://127.0.0.1:{proxy_port}/api/test"))
            .header("X-Forwarded-For", "spoofed.ip")
            .header("X-Forwarded-Proto", "http")
            .header("Proxy-Authorization", "Basic 123")
            .header("Authorization", "Bearer secret-token")
            .body("ping from client")
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        assert_eq!(resp.headers().get("x-backend-handled").unwrap(), "true");
        let body = resp.text().await.unwrap();
        assert_eq!(body, "pong from backend");

        // 6. Stop proxy gracefully
        let state = manager.stop().await.unwrap();
        assert!(!state.running);
        assert_eq!(state.listening, None);
        assert_eq!(state.target, None);
        assert_eq!(state.requests_total, 1);

        let _ = backend_task.await;

        // Cleanup
        let _ = std::fs::remove_file(cert_file);
        let _ = std::fs::remove_file(key_file);
        let _ = std::fs::remove_dir(temp_dir);
    }

    #[tokio::test]
    async fn test_manager_lifecycle() {
        let manager = ReverseProxyManagerState::new();

        // Initially not running
        let state = manager.get_state().unwrap();
        assert!(!state.running);
        assert_eq!(state.listening, None);
        assert_eq!(state.target, None);
        assert_eq!(state.requests_total, 0);
        assert_eq!(state.error, None);

        // Stop is idempotent
        let state = manager.stop().await.unwrap();
        assert!(!state.running);

        // Apply disabled config stores config and stays stopped
        let cfg = ReverseProxyConfig {
            enabled: false,
            listen_host: "0.0.0.0".to_string(),
            listen_port: 443,
            target_port: 8317,
            cert_path: "/tmp/cert.pem".to_string(),
            key_path: "/tmp/key.pem".to_string(),
        };
        let state = manager.apply(cfg, None).await.unwrap();
        assert!(!state.running);

        // Apply enabled config with invalid/missing cert fails closed
        let cfg_enabled = ReverseProxyConfig {
            enabled: true,
            listen_host: "0.0.0.0".to_string(),
            listen_port: 443,
            target_port: 8317,
            cert_path: "/tmp/nonexistent_cert.pem".to_string(),
            key_path: "/tmp/nonexistent_key.pem".to_string(),
        };
        let res = manager.apply(cfg_enabled, None).await;
        assert!(res.is_err());

        // State remains running = false and records specific error
        let state = manager.get_state().unwrap();
        assert!(!state.running);
        assert!(state.error.is_some());
        assert!(state.error.unwrap().contains("Certificate file does not exist"));
    }

    #[test]
    fn test_hardening_already_correct_document_is_idempotent() {
        // Legacy document
        let mut legacy: serde_norway::Value = serde_norway::from_str(
            r#"
host: "127.0.0.1"
trusted-proxies:
  - "127.0.0.1"
port: 8317
"#,
        )
        .unwrap();
        let changed = harden_core_config_document(&mut legacy).unwrap();
        assert!(!changed);
        assert_eq!(legacy["host"].as_str().unwrap(), "127.0.0.1");
        let proxies = legacy["trusted-proxies"].as_sequence().unwrap();
        assert_eq!(proxies.len(), 1);
        assert_eq!(proxies[0].as_str().unwrap(), "127.0.0.1");

        // v8 document
        let mut v8: serde_norway::Value = serde_norway::from_str(
            r#"
config-version: 8
server:
  host: "127.0.0.1"
  trusted-proxies:
    - "127.0.0.1"
  port: 8317
"#,
        )
        .unwrap();
        let changed = harden_core_config_document(&mut v8).unwrap();
        assert!(!changed);
        assert_eq!(v8["server"]["host"].as_str().unwrap(), "127.0.0.1");
        let proxies = v8["server"]["trusted-proxies"].as_sequence().unwrap();
        assert_eq!(proxies.len(), 1);
        assert_eq!(proxies[0].as_str().unwrap(), "127.0.0.1");
    }

    #[test]
    fn test_hardening_legacy_vs_v8_document_layout() {
        // Legacy document gets top-level host and trusted-proxies
        let mut legacy: serde_norway::Value = serde_norway::from_str(
            r#"
host: "0.0.0.0"
port: 8317
"#,
        )
        .unwrap();
        let changed = harden_core_config_document(&mut legacy).unwrap();
        assert!(changed);
        assert_eq!(legacy["host"].as_str().unwrap(), "127.0.0.1");
        let proxies = legacy["trusted-proxies"].as_sequence().unwrap();
        assert_eq!(proxies.len(), 1);
        assert_eq!(proxies[0].as_str().unwrap(), "127.0.0.1");
        assert!(legacy.get("server").is_none());

        // v8 document gets server.host and server.trusted-proxies
        let mut v8: serde_norway::Value = serde_norway::from_str(
            r#"
config-version: 8
server:
  host: "0.0.0.0"
  port: 8317
"#,
        )
        .unwrap();
        let changed = harden_core_config_document(&mut v8).unwrap();
        assert!(changed);
        assert_eq!(v8["server"]["host"].as_str().unwrap(), "127.0.0.1");
        let proxies = v8["server"]["trusted-proxies"].as_sequence().unwrap();
        assert_eq!(proxies.len(), 1);
        assert_eq!(proxies[0].as_str().unwrap(), "127.0.0.1");
        assert!(v8.get("host").is_none());
    }

    #[test]
    fn test_hardening_preserves_existing_trusted_proxies_no_duplicate() {
        // v8 document with existing proxies
        let mut v8: serde_norway::Value = serde_norway::from_str(
            r#"
config-version: 8
server:
  host: "0.0.0.0"
  trusted-proxies:
    - "10.0.0.1"
    - "192.168.1.50"
"#,
        )
        .unwrap();
        let changed = harden_core_config_document(&mut v8).unwrap();
        assert!(changed);
        assert_eq!(v8["server"]["host"].as_str().unwrap(), "127.0.0.1");
        let proxies = v8["server"]["trusted-proxies"].as_sequence().unwrap();
        assert_eq!(proxies.len(), 3);
        assert_eq!(proxies[0].as_str().unwrap(), "10.0.0.1");
        assert_eq!(proxies[1].as_str().unwrap(), "192.168.1.50");
        assert_eq!(proxies[2].as_str().unwrap(), "127.0.0.1");

        // Second run should be idempotent and not duplicate 127.0.0.1
        let changed_again = harden_core_config_document(&mut v8).unwrap();
        assert!(!changed_again);
        let proxies_again = v8["server"]["trusted-proxies"].as_sequence().unwrap();
        assert_eq!(proxies_again.len(), 3);
        assert_eq!(proxies_again[0].as_str().unwrap(), "10.0.0.1");
        assert_eq!(proxies_again[1].as_str().unwrap(), "192.168.1.50");
        assert_eq!(proxies_again[2].as_str().unwrap(), "127.0.0.1");

        // Legacy document with existing proxies
        let mut legacy: serde_norway::Value = serde_norway::from_str(
            r#"
host: "127.0.0.1"
trusted-proxies:
  - "172.16.0.1"
"#,
        )
        .unwrap();
        let changed = harden_core_config_document(&mut legacy).unwrap();
        assert!(changed);
        let proxies = legacy["trusted-proxies"].as_sequence().unwrap();
        assert_eq!(proxies.len(), 2);
        assert_eq!(proxies[0].as_str().unwrap(), "172.16.0.1");
        assert_eq!(proxies[1].as_str().unwrap(), "127.0.0.1");

        // Second run
        let changed_again = harden_core_config_document(&mut legacy).unwrap();
        assert!(!changed_again);
        let proxies_again = legacy["trusted-proxies"].as_sequence().unwrap();
        assert_eq!(proxies_again.len(), 2);
    }

    #[test]
    fn test_read_core_hardening_truth_table() {
        // 1. Both correct (v8)
        let doc_both_ok: serde_norway::Value = serde_norway::from_str(
            r#"
config-version: 8
server:
  host: "127.0.0.1"
  trusted-proxies:
    - "10.0.0.1"
    - "127.0.0.1"
"#,
        )
        .unwrap();
        let h = read_core_hardening(&doc_both_ok);
        assert!(h.loopback_bind);
        assert!(h.trusted_proxies);
        assert!(!h.restart_required);

        // 2. Both correct (legacy)
        let doc_legacy_ok: serde_norway::Value = serde_norway::from_str(
            r#"
host: "127.0.0.1"
trusted-proxies:
  - "127.0.0.1"
"#,
        )
        .unwrap();
        let h = read_core_hardening(&doc_legacy_ok);
        assert!(h.loopback_bind);
        assert!(h.trusted_proxies);
        assert!(!h.restart_required);

        // 3. Host wrong (0.0.0.0), trusted-proxies correct
        let doc_host_wrong: serde_norway::Value = serde_norway::from_str(
            r#"
config-version: 8
server:
  host: "0.0.0.0"
  trusted-proxies:
    - "127.0.0.1"
"#,
        )
        .unwrap();
        let h = read_core_hardening(&doc_host_wrong);
        assert!(!h.loopback_bind);
        assert!(h.trusted_proxies);

        // 4. Host correct (127.0.0.1), trusted-proxies missing
        let doc_proxies_missing: serde_norway::Value = serde_norway::from_str(
            r#"
config-version: 8
server:
  host: "127.0.0.1"
"#,
        )
        .unwrap();
        let h = read_core_hardening(&doc_proxies_missing);
        assert!(h.loopback_bind);
        assert!(!h.trusted_proxies);

        // 5. Host correct, trusted-proxies does not contain 127.0.0.1
        let doc_proxies_wrong: serde_norway::Value = serde_norway::from_str(
            r#"
config-version: 8
server:
  host: "127.0.0.1"
  trusted-proxies:
    - "10.0.0.1"
"#,
        )
        .unwrap();
        let h = read_core_hardening(&doc_proxies_wrong);
        assert!(h.loopback_bind);
        assert!(!h.trusted_proxies);

        // 6. Both wrong
        let doc_both_wrong: serde_norway::Value = serde_norway::from_str(
            r#"
config-version: 8
server:
  host: "0.0.0.0"
  trusted-proxies:
    - "10.0.0.1"
"#,
        )
        .unwrap();
        let h = read_core_hardening(&doc_both_wrong);
        assert!(!h.loopback_bind);
        assert!(!h.trusted_proxies);

        // 7. Non-mapping / empty value
        let doc_empty = serde_norway::Value::Null;
        let h = read_core_hardening(&doc_empty);
        assert!(!h.loopback_bind);
        assert!(!h.trusted_proxies);
        assert!(!h.restart_required);
    }

    #[tokio::test]
    async fn test_reverse_proxy_get_state_preserves_restart_required() {
        use tauri::Manager;
        let app = tauri::test::mock_app();
        let manager = ReverseProxyManagerState::new();
        {
            let mut guard = manager.inner.lock().unwrap();
            guard.hardening.restart_required = true;
        }
        app.manage(manager);
        let state = app.state::<ReverseProxyManagerState>();
        let res = reverse_proxy_get_state(state).await.unwrap();
        assert!(res.hardening.restart_required);

        // When not required, it remains false
        let app2 = tauri::test::mock_app();
        let manager2 = ReverseProxyManagerState::new();
        app2.manage(manager2);
        let state2 = app2.state::<ReverseProxyManagerState>();
        let res2 = reverse_proxy_get_state(state2).await.unwrap();
        assert!(!res2.hardening.restart_required);
    }
}
