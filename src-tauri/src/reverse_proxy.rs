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

type ProxyClient = Client<hyper_rustls::HttpsConnector<HttpConnector>, hyper::body::Incoming>;

#[cfg(test)]
mod real_kernel_tests;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReverseProxyConfig {
    pub enabled: bool,
    #[serde(rename = "listenHost", alias = "listen-host")]
    pub listen_host: String, // "0.0.0.0"
    #[serde(rename = "listenPort", alias = "listen-port")]
    pub listen_port: u16, // 443
    // 0 means "follow the kernel port"; a nonzero value is an explicit target
    // that is never rewritten to the kernel port.
    #[serde(default, alias = "target-port")]
    pub target_port: u16, // e.g. 8317
    #[serde(rename = "certPath", alias = "cert-path")]
    pub cert_path: String,
    #[serde(rename = "keyPath", alias = "key-path")]
    pub key_path: String,
}

fn read_proxy_config_document(
    document: &serde_norway::Value,
) -> Result<Option<ReverseProxyConfig>, String> {
    document
        .get("reverse-proxy")
        .map(|value| {
            serde_norway::from_value(value.clone())
                .map_err(|error| format!("Failed to read reverse proxy configuration: {error}"))
        })
        .transpose()
}

/// Prepares the kernel configuration written at start-up. The reverse proxy
/// settings live in the GUI configuration only, so their presence in the kernel
/// document is limited to this decision of whether to harden the kernel.
///
/// The persisted target port is the configured contract, not a cache of the
/// kernel port: an explicit nonzero target is preserved and a 0 target keeps
/// following the kernel port at forwarding time, so neither is rewritten here.
pub(crate) fn prepare_core_start(
    document: &mut serde_norway::Value,
    proxy: Option<&ReverseProxyConfig>,
) -> Result<bool, String> {
    if !proxy.is_some_and(|config| config.enabled) {
        return Ok(false);
    }
    harden_core_config_document(document)
}

fn configured_core_port(document: &serde_norway::Value) -> Result<Option<u16>, String> {
    let port = if core_config_uses_v8(document) {
        document.get("server").and_then(|server| server.get("port"))
    } else {
        document.get("port")
    };
    port.map(|port| {
        port.as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| "Kernel port must be between 1 and 65535".to_string())
    }).transpose()
}

fn core_forward_client(config: &ReverseProxyConfig) -> Result<(ProxyClient, bool, u16), String> {
    let mut roots = rustls::RootCertStore::empty();
    let mut tls_enabled = false;
    let mut core_port = None;
    {
        let _config_guard = lock_core_config_file()?;
        let install_dir = crate::core_runtime::core_install_dir()?;
        if install_dir.join(crate::CORE_CONFIG_FILE).is_file() {
            let (_, document) = read_core_config_document()?;
            core_port = configured_core_port(document.get())?;
            let tls = crate::core_config::core_tls_settings_from_value(document.get())?;
            tls_enabled = tls.enabled;
            if tls_enabled {
                let cert_path = install_dir.join(&tls.cert);
                let file = File::open(&cert_path).map_err(|error| {
                    format!("Failed to read kernel TLS certificate '{}': {error}", cert_path.display())
                })?;
                for certificate in rustls_pemfile::certs(&mut BufReader::new(file)) {
                    roots.add(certificate.map_err(|error| format!("Invalid kernel TLS certificate: {error}"))?)
                        .map_err(|error| format!("Invalid kernel TLS certificate: {error}"))?;
                }
                if roots.is_empty() {
                    return Err("Kernel TLS certificate file contains no certificates".to_string());
                }
            }
        }
    }
    let target_port = match config.target_port {
        0 => core_port.ok_or_else(|| {
            "Reverse proxy target port follows the kernel port, but no kernel port is configured"
                .to_string()
        })?,
        port => port,
    };
    let tls = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    let connector = hyper_rustls::HttpsConnectorBuilder::new().with_tls_config(tls)
        .https_or_http().enable_http1().build();
    Ok((Client::builder(TokioExecutor::new()).build(connector), tls_enabled, target_port))
}

/// Reads the saved settings from the GUI configuration, which is where they are
/// stored; used by tests that check what a save left behind.
#[cfg(test)]
fn read_saved_proxy_config_for_test() -> Result<Option<ReverseProxyConfig>, String> {
    read_gui_proxy_config_at(&crate::core_runtime::core_base_dir()?)
}

#[cfg(test)]
fn read_installed_proxy_config() -> Result<Option<ReverseProxyConfig>, String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = crate::core_runtime::core_install_dir()?.join(crate::CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(None);
    }
    let (_, document) = read_core_config_document()?;
    read_proxy_config_document(document.get())
}

/// The GUI's own durable configuration (config.toml). Its copy of the settings
/// survives kernel configuration regeneration, which is why it is read first
/// when the listener is restored and written first when settings are saved.
fn read_gui_proxy_config_at(base_dir: &Path) -> Result<Option<ReverseProxyConfig>, String> {
    let config_path = base_dir.join(crate::GUI_CONFIG_FILE);
    let content = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to read GUI configuration {}: {error}",
                config_path.display()
            ))
        }
    };
    let config = toml::from_str::<crate::GuiConfigFile>(&content)
        .map_err(|error| format!("Failed to parse GUI configuration: {error}"))?;
    Ok(config.reverse_proxy)
}

fn read_saved_proxy_config(
    gui_state: Option<&crate::GuiConfigState>,
) -> Result<Option<ReverseProxyConfig>, String> {
    let base_dir = crate::core_runtime::core_base_dir()?;
    migrate_proxy_config_from_kernel(&base_dir, gui_state)?;
    read_gui_proxy_config_at(&base_dir)
}

/// Moves settings written by older versions out of the kernel configuration.
/// The kernel copy is removed only after the GUI configuration file holds the
/// same values and, when the in-memory GUI settings are available, after they
/// hold them too, so a failure at either step keeps the settings readable and
/// the next attempt migrates them again.
fn migrate_proxy_config_from_kernel(
    base_dir: &Path,
    gui_state: Option<&crate::GuiConfigState>,
) -> Result<(), String> {
    migrate_proxy_config_from_kernel_at(
        base_dir,
        &crate::core_runtime::core_install_dir()?,
        gui_state,
    )
}

fn migrate_proxy_config_from_kernel_at(
    base_dir: &Path,
    kernel_dir: &Path,
    gui_state: Option<&crate::GuiConfigState>,
) -> Result<(), String> {
    if read_gui_proxy_config_at(base_dir)?.is_some() {
        return Ok(());
    }
    if gui_state
        .and_then(|state| state.snapshot().ok())
        .and_then(|config| config.reverse_proxy)
        .is_some()
    {
        return Ok(());
    }
    let config_path = kernel_dir.join(crate::CORE_CONFIG_FILE);
    let Some(kernel_config) = read_kernel_proxy_config_at(&config_path)? else {
        return Ok(());
    };
    // The file and the in-memory settings are written together; the kernel copy
    // stays in place unless both succeeded, because the in-memory settings are
    // serialized as a whole on the next unrelated GUI save.
    let stored = persist_proxy_config_in_gui_state(kernel_config, base_dir, gui_state)?;
    if stored.is_some() {
        if let Err(error) = remove_kernel_proxy_config_at(&config_path) {
            eprintln!(
                "Failed to remove reverse proxy settings from the kernel configuration: {error}"
            );
        }
    }
    Ok(())
}

fn read_kernel_proxy_config_at(config_path: &Path) -> Result<Option<ReverseProxyConfig>, String> {
    if !config_path.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(config_path).map_err(|error| {
        format!(
            "Failed to read kernel configuration {}: {error}",
            config_path.display()
        )
    })?;
    let document = serde_norway::from_str::<serde_norway::Value>(&content)
        .map_err(|error| format!("Failed to parse kernel configuration: {error}"))?;
    read_proxy_config_document(&document)
}

fn remove_kernel_proxy_config() -> Result<(), String> {
    remove_kernel_proxy_config_at(&crate::core_runtime::core_install_dir()?.join(crate::CORE_CONFIG_FILE))
}

fn remove_kernel_proxy_config_at(config_path: &Path) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let content = match std::fs::read_to_string(config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to read kernel configuration {}: {error}",
                config_path.display()
            ))
        }
    };
    if let Some(updated) = crate::core_config::remove_core_yaml_section(&content, "reverse-proxy")? {
        crate::core_config::write_bytes_atomically(config_path, updated.as_bytes())?;
    }
    Ok(())
}

/// Stores the settings in the GUI configuration file at `base_dir`, keeping
/// every other field of the currently saved GUI settings.
fn attach_saved_proxy_config(
    config: ReverseProxyConfig,
    base_dir: &Path,
) -> Result<crate::GuiConfigFile, String> {
    let config_path = base_dir.join(crate::GUI_CONFIG_FILE);
    let mut gui_config = match std::fs::read_to_string(&config_path) {
        Ok(content) => toml::from_str::<crate::GuiConfigFile>(&content).unwrap_or_default(),
        Err(_) => crate::GuiConfigFile::default(),
    };
    gui_config.reverse_proxy = Some(config);
    crate::core_config::write_gui_config_to_path(&gui_config, &config_path)?;
    Ok(gui_config)
}

fn persist_proxy_config_in_gui(
    config: &ReverseProxyConfig,
    app: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    let base_dir = crate::core_runtime::core_base_dir()?;
    match app {
        Some(app) => {
            persist_proxy_config_in_gui_state(
                config.clone(),
                &base_dir,
                Some(gui_state_of(app)),
            )?
            .ok_or_else(|| {
                "Failed to store reverse proxy settings in the GUI configuration".to_string()
            })?;
        }
        None => {
            attach_saved_proxy_config(config.clone(), &base_dir)?;
        }
    }
    if let Err(error) = remove_kernel_proxy_config() {
        eprintln!("Failed to remove reverse proxy settings from the kernel configuration: {error}");
    }
    Ok(())
}

/// The in-memory GUI settings of the running application.
fn gui_state_of<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> &crate::GuiConfigState {
    use tauri::Manager;

    app.state::<crate::GuiConfigState>().inner()
}

/// Writes the block into the GUI configuration file and, when the in-memory GUI
/// settings are available, mirrors it there in the same step. The next unrelated
/// GUI save serializes the whole file from those in-memory settings, so a file
/// write that is not mirrored there would be undone by that save. A state that
/// could not be updated is reported through the `Option`, which keeps the kernel
/// copy so the migration can be retried.
fn persist_proxy_config_in_gui_state(
    config: ReverseProxyConfig,
    base_dir: &Path,
    gui_state: Option<&crate::GuiConfigState>,
) -> Result<Option<crate::GuiConfigFile>, String> {
    let saved = attach_saved_proxy_config(config.clone(), base_dir)?;
    let Some(gui_state) = gui_state else {
        return Ok(Some(saved));
    };
    remember_proxy_config_in_gui_state(gui_state, &config)?;
    match gui_state.snapshot() {
        Ok(snapshot) if snapshot.reverse_proxy.as_ref() == Some(&config) => Ok(Some(snapshot)),
        _ => Ok(None),
    }
}

fn remember_proxy_config_in_gui_state(
    gui_state: &crate::GuiConfigState,
    config: &ReverseProxyConfig,
) -> Result<(), String> {
    let updated = gui_state.update(|gui_config| {
        gui_config.reverse_proxy = Some(config.clone());
        Ok(())
    });
    match updated {
        Ok(_) => Ok(()),
        Err(error) => {
            eprintln!("Failed to keep reverse proxy settings in the in-memory GUI settings: {error}");
            Err(error)
        }
    }
}

fn persist_proxy_config(
    config: &ReverseProxyConfig,
    app: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    persist_proxy_config_in_gui(config, app)
}

/// Explains an OS access-denied bind failure, which on Windows (os error 10013)
/// is usually a reserved or excluded port range rather than a listener conflict.
fn describe_bind_error(bind_addr: &str, error: &std::io::Error) -> String {
    #[cfg(windows)]
    let access_denied = error.kind() == std::io::ErrorKind::PermissionDenied
        || error.raw_os_error() == Some(10013);
    #[cfg(not(windows))]
    let access_denied = error.raw_os_error() == Some(libc::EACCES);
    let base = format!("Failed to bind listener on {bind_addr}: {error}");
    if !access_denied {
        return base;
    }
    let port = bind_addr.rsplit(':').next().unwrap_or(bind_addr);
    format!(
        "{base}. Listening on port {port} is not allowed by the operating system; \
         the port may be reserved or inside an excluded port range \
         (Windows: `netsh interface ipv4 show excludedportrange protocol=tcp`). \
         Choose a different listen port or reserve port {port} for this application."
    )
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
    pub config: Option<ReverseProxyConfig>,
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
    build_target_uri_with_scheme(target_port, original_uri, "http")
}

fn build_target_uri_with_scheme(target_port: u16, original_uri: &hyper::Uri, scheme: &str) -> Result<hyper::Uri, String> {
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
    let url_str = format!("{scheme}://127.0.0.1:{}{}", target_port, path_and_query);
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
    // target_port 0 is the "follow the kernel port" sentinel; it is resolved to
    // the effective kernel port when the forwarding client is built.
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
    client: ProxyClient,
    target_port: u16,
    target_tls: bool,
    peer_ip: String,
    requests_total: Arc<AtomicU64>,
) -> Result<hyper::Response<BoxBody<Bytes, hyper::Error>>, std::convert::Infallible> {
    requests_total.fetch_add(1, Ordering::Relaxed);

    let (parts, body) = req.into_parts();
    let target_uri = match build_target_uri_with_scheme(target_port, &parts.uri, if target_tls { "https" } else { "http" }) {
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
    stored_config: Option<ReverseProxyConfig>,
    hardening: ReverseProxyHardening,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    server_task: Option<tokio::task::JoinHandle<()>>,
    listener: Option<Arc<tokio::net::TcpListener>>,
}

fn accept_retry_delay(error: &std::io::Error, consecutive_errors: u32) -> Option<std::time::Duration> {
    let transient = matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::ConnectionAborted
    );
    #[cfg(unix)]
    let transient = transient
        || matches!(
            error.raw_os_error(),
            Some(libc::EMFILE) | Some(libc::ENFILE)
        );
    #[cfg(windows)]
    let transient = transient || error.raw_os_error() == Some(10024);
    if !transient || consecutive_errors >= 10 {
        return None;
    }
    Some(std::time::Duration::from_millis(
        (50_u64 << consecutive_errors.saturating_sub(1).min(2)).min(200),
    ))
}

#[derive(Clone, Default)]
pub struct ReverseProxyManagerState {
    inner: Arc<std::sync::Mutex<ReverseProxyInner>>,
    requests_total: Arc<AtomicU64>,
    operation: Arc<tokio::sync::Mutex<()>>,
}

impl ReverseProxyManagerState {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_state(&self) -> Result<ReverseProxyState, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
        if guard.running
            && guard
                .server_task
                .as_ref()
                .is_some_and(|task| task.is_finished())
        {
            guard.running = false;
            guard.listening = None;
            guard.target = None;
            guard.listener = None;
            guard.error = Some("Reverse proxy listener task stopped unexpectedly".to_string());
            eprintln!("Reverse proxy listener task stopped unexpectedly");
        }
        Ok(ReverseProxyState {
            running: guard.running,
            listening: guard.listening.clone(),
            target: guard.target.clone(),
            requests_total: self.requests_total.load(Ordering::Relaxed),
            error: guard.error.clone(),
            hardening: guard.hardening.clone(),
            config: guard.stored_config.clone(),
        })
    }

    #[cfg(test)]
    pub async fn stop(&self) -> Result<ReverseProxyState, String> {
        let _operation = self.operation.lock().await;
        self.stop_inner().await
    }

    async fn stop_inner(&self) -> Result<ReverseProxyState, String> {
        let (shutdown_tx, server_task) = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
            guard.running = false;
            guard.listening = None;
            guard.target = None;
            guard.listener = None;
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

    #[cfg(test)]
    pub async fn start<A: Into<Option<tauri::AppHandle>>>(
        &self,
        config: ReverseProxyConfig,
        app: A,
    ) -> Result<ReverseProxyState, String> {
        let _operation = self.operation.lock().await;
        self.start_inner(config, app.into()).await
    }

    fn fail_start(&self, error: String) -> Result<ReverseProxyState, String> {
        eprintln!("Reverse proxy failed: {error}");
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
        // A failed attempt must not keep looking like a running listener next
        // to the new error.
        guard.running = false;
        guard.listening = None;
        guard.target = None;
        guard.listener = None;
        guard.error = Some(error.clone());
        Err(error)
    }

    async fn start_inner(
        &self,
        config: ReverseProxyConfig,
        app: Option<tauri::AppHandle>,
    ) -> Result<ReverseProxyState, String> {
        self.start_candidate(config, app, false).await
    }

    async fn start_candidate(
        &self,
        config: ReverseProxyConfig,
        app: Option<tauri::AppHandle>,
        persist: bool,
    ) -> Result<ReverseProxyState, String> {
        let previous = self.get_state()?;
        let result = self.start_candidate_inner(config, app, persist).await;
        if let Err(error) = result {
            if previous.running && !self.get_state()?.running {
                if let Some(config) = previous.config {
                    if let Err(rollback) = Box::pin(self.start_inner(config, None)).await {
                        return self.fail_start(format!("{error}; failed to restore previous listener: {rollback}"));
                    }
                }
            }
            return self.fail_start(error);
        }
        result
    }

    async fn start_candidate_inner(
        &self,
        config: ReverseProxyConfig,
        app: Option<tauri::AppHandle>,
        persist: bool,
    ) -> Result<ReverseProxyState, String> {
        if let Err(err) = validate_config(&config) {
            return self.fail_start(err);
        }

        let tls_config = match load_tls_config(&config) {
            Ok(c) => c,
            Err(err) => {
                return self.fail_start(err);
            }
        };

        let bind_addr = format!("{}:{}", config.listen_host, config.listen_port);
        let retained_listener = {
            let guard = self
                .inner
                .lock()
                .map_err(|error| format!("Failed to acquire state lock: {error}"))?;
            guard
                .stored_config
                .as_ref()
                .filter(|previous| {
                    previous.listen_host == config.listen_host
                        && previous.listen_port == config.listen_port
                        && guard.running
                        && guard.server_task.as_ref().is_some_and(|task| !task.is_finished())
                })
                .and(guard.listener.clone())
        };
        let listener = if let Some(listener) = retained_listener {
            listener
        } else {
            match tokio::net::TcpListener::bind((config.listen_host.as_str(), config.listen_port))
                .await
            {
                Ok(listener) => Arc::new(listener),
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    let previous = self.get_state()?;
                    if !previous.running || !previous.config.as_ref().is_some_and(|previous| {
                        previous.listen_port == config.listen_port
                            && previous.listen_host != config.listen_host
                    }) {
                        return self.fail_start(describe_bind_error(&bind_addr, &error));
                    }
                    self.stop_inner().await?;
                    match tokio::net::TcpListener::bind((config.listen_host.as_str(), config.listen_port)).await {
                        Ok(listener) => Arc::new(listener),
                        Err(error) => return self.fail_start(describe_bind_error(&bind_addr, &error)),
                    }
                }
                Err(err) => {
                    return self.fail_start(describe_bind_error(&bind_addr, &err));
                }
            }
        };

        let listening_addr = listener
            .local_addr()
            .map_err(|error| format!("Failed to read listener address: {error}"))?
            .to_string();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let acceptor = TlsAcceptor::from(tls_config);
        let requests_total = self.requests_total.clone();

        let mut hardening = match apply_core_hardening() {
            Ok(h) => h,
            Err(err) => {
                eprintln!("Reverse proxy hardening failed: {err}");
                ReverseProxyHardening::default()
            }
        };

        if hardening.restart_required {
            if let Some(app_handle) = app.as_ref() {
                if let Err(err) = crate::core_runtime::restart_core_for_proxy(app_handle.clone()).await {
                    eprintln!("Reverse proxy hardening failed: Failed to restart CPA kernel: {err}");
                } else {
                    hardening.restart_required = false;
                }
            }
        }

        let (client, target_tls, target_port) = match core_forward_client(&config) {
            Ok(target) => target,
            Err(error) => return self.fail_start(error),
        };
        if persist {
            if let Err(error) = persist_proxy_config(&config, app.as_ref()) {
                return self.fail_start(error);
            }
        }
        let target_addr = format!("127.0.0.1:{target_port}");

        self.stop_inner().await?;
        let inner = Arc::downgrade(&self.inner);
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to acquire state lock: {e}"))?;

        guard.listener = Some(listener.clone());
        let server_task = tokio::spawn(async move {
            let mut consecutive_errors = 0;
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => {
                        break;
                    }
                    accept_res = listener.accept() => {
                        match accept_res {
                            Ok((tcp_stream, peer_addr)) => {
                                consecutive_errors = 0;
                                let acceptor = acceptor.clone();
                                let client = client.clone();
                                let requests_total = requests_total.clone();
                                let peer_ip = peer_addr.ip().to_string();

                                tokio::spawn(async move {
                                    let tls_stream = match acceptor.accept(tcp_stream).await {
                                        Ok(s) => s,
                                        Err(error) => {
                                            eprintln!("Reverse proxy TLS handshake failed for {peer_addr}: {error}");
                                            return;
                                        }
                                    };

                                    let io = TokioIo::new(tls_stream);
                                    let service = hyper::service::service_fn(move |req| {
                                        let client = client.clone();
                                        let peer_ip = peer_ip.clone();
                                        let requests_total = requests_total.clone();
                                        async move {
                                            handle_forward(req, client, target_port, target_tls, peer_ip, requests_total).await
                                        }
                                    });

                                    let _ = hyper::server::conn::http1::Builder::new()
                                        .serve_connection(io, service)
                                        .await;
                                });
                            }
                            Err(error) => {
                                consecutive_errors += 1;
                                if let Some(delay) = accept_retry_delay(&error, consecutive_errors) {
                                    eprintln!("Reverse proxy listener accept retry {consecutive_errors}: {error}");
                                    tokio::select! {
                                        _ = &mut shutdown_rx => break,
                                        _ = tokio::time::sleep(delay) => {}
                                    }
                                    continue;
                                }
                                let message = format!("Reverse proxy listener accept failed: {error}");
                                eprintln!("{message}");
                                if let Some(inner) = inner.upgrade() {
                                    if let Ok(mut guard) = inner.lock() {
                                        guard.error = Some(message);
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
            }
            if let Some(inner) = inner.upgrade() {
                if let Ok(mut guard) = inner.lock() {
                    guard.running = false;
                    guard.listening = None;
                    guard.target = None;
                    guard.listener = None;
                }
            }
        });

        guard.running = true;
        guard.listening = Some(listening_addr.clone());
        guard.target = Some(target_addr);
        // A successful start replaces any bind or restore error from an earlier
        // attempt, so a running listener never shows an unrelated stale error.
        // Hardening problems keep their own notice instead.
        guard.error = None;
        guard.stored_config = Some(config);
        guard.hardening = hardening;
        guard.shutdown_tx = Some(shutdown_tx);
        guard.server_task = Some(server_task);
        drop(guard);
        eprintln!("Reverse proxy listening on {listening_addr}");

        self.get_state()
    }

    #[cfg(test)]
    pub async fn apply<A: Into<Option<tauri::AppHandle>>>(
        &self,
        config: ReverseProxyConfig,
        app: A,
    ) -> Result<ReverseProxyState, String> {
        let _operation = self.operation.lock().await;
        self.apply_inner(config, app.into()).await
    }

    async fn apply_inner(
        &self,
        config: ReverseProxyConfig,
        app: Option<tauri::AppHandle>,
    ) -> Result<ReverseProxyState, String> {
        if config.enabled {
            self.start_inner(config, app).await
        } else {
            self.stop_inner().await?;
            let mut guard = self
                .inner
                .lock()
                .map_err(|e| format!("Failed to acquire state lock: {e}"))?;
            guard.stored_config = Some(config);
            guard.error = None;
            drop(guard);
            self.get_state()
        }
    }

    async fn save_and_apply(
        &self,
        config: ReverseProxyConfig,
        app: Option<tauri::AppHandle>,
    ) -> Result<ReverseProxyState, String> {
        let _operation = self.operation.lock().await;
        if config.enabled {
            self.start_candidate(config, app, true).await
        } else {
            let persisted = persist_proxy_config(&config, app.as_ref());
            let stopped = self.apply_inner(config, app).await?;
            match persisted {
                Ok(()) => Ok(stopped),
                Err(error) => self.config_warning(error),
            }
        }
    }

    fn config_warning(&self, error: String) -> Result<ReverseProxyState, String> {
        let warning = format!("Reverse proxy stopped, but failed to save configuration: {error}");
        eprintln!("{warning}");
        self.inner
            .lock()
            .map_err(|error| format!("Failed to acquire state lock: {error}"))?
            .error = Some(warning);
        self.get_state()
    }

    async fn stop_and_save(
        &self,
        app: Option<tauri::AppHandle>,
    ) -> Result<ReverseProxyState, String> {
        let _operation = self.operation.lock().await;
        self.stop_inner().await?;
        let saved = (|| {
            let config = match self.get_state()?.config {
                Some(config) => Some(config),
                None => read_saved_proxy_config(app.as_ref().map(gui_state_of))?,
            };
            if let Some(mut config) = config {
                config.enabled = false;
                self.inner
                    .lock()
                    .map_err(|error| format!("Failed to acquire state lock: {error}"))?
                    .stored_config = Some(config.clone());
                persist_proxy_config(&config, app.as_ref())?;
            }
            Ok::<_, String>(())
        })();
        match saved {
            Ok(()) => {
                self.inner
                    .lock()
                    .map_err(|error| format!("Failed to acquire state lock: {error}"))?
                    .error = None;
                self.get_state()
            }
            Err(error) => self.config_warning(error),
        }
    }

    pub async fn restore(&self, app: tauri::AppHandle) -> Result<ReverseProxyState, String> {
        let _operation = self.operation.lock().await;
        match read_saved_proxy_config(Some(gui_state_of(&app))) {
            Ok(Some(config)) => self.apply_inner(config, Some(app)).await,
            Ok(None) => self.get_state(),
            Err(error) => {
                self.stop_inner().await?;
                self.fail_start(error)
            }
        }
    }

    pub(crate) async fn restore_after_core_start<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        process_state: &crate::CoreProcessState,
    ) -> Result<ReverseProxyState, String> {
        let _operation = self.operation.lock().await;
        if process_state.is_shutting_down() || process_state.managed_pid().is_none() {
            return self.stop_inner().await;
        }
        // Restoring only starts the listener; it never rewrites the saved
        // settings, so the next start can retry with the same configuration.
        let result = match read_saved_proxy_config(Some(gui_state_of(app))) {
            Ok(Some(config)) => self.apply_inner(config, None).await,
            Ok(None) => self.get_state(),
            Err(error) => {
                self.stop_inner().await?;
                self.fail_start(error)
            }
        };
        if process_state.is_shutting_down() || process_state.managed_pid().is_none() {
            return self.stop_inner().await;
        }
        result
    }
}

#[tauri::command]
pub async fn reverse_proxy_get_state(
    state: tauri::State<'_, ReverseProxyManagerState>,
    gui_config_state: tauri::State<'_, crate::GuiConfigState>,
) -> Result<ReverseProxyState, String> {
    let mut current = state.get_state()?;
    if current.config.is_none() {
        current.config = read_saved_proxy_config(Some(gui_config_state.inner()))?;
    }
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
    state.save_and_apply(config, Some(app)).await
}

#[tauri::command]
pub async fn reverse_proxy_start(
    app: tauri::AppHandle,
    mut config: ReverseProxyConfig,
    state: tauri::State<'_, ReverseProxyManagerState>,
) -> Result<ReverseProxyState, String> {
    config.enabled = true;
    state.save_and_apply(config, Some(app)).await
}

#[tauri::command]
pub async fn reverse_proxy_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReverseProxyManagerState>,
) -> Result<ReverseProxyState, String> {
    state.stop_and_save(Some(app)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::{HeaderMap, HeaderName, HeaderValue, CONNECTION};

    // Serializes tests that read, write, or remove the installed core config
    // file so the real-TLS fixtures cannot race each other or leak state into
    // tests that inspect the installed config while running in parallel.
    static INSTALLED_CONFIG_TEST_LOCK: tokio::sync::Mutex<()> =
        tokio::sync::Mutex::const_new(());

    #[test]
    fn test_accept_errors_have_bounded_backoff() {
        use std::io::{Error, ErrorKind};
        use std::time::Duration;

        for kind in [
            ErrorKind::WouldBlock,
            ErrorKind::Interrupted,
            ErrorKind::ConnectionAborted,
        ] {
            let error = Error::from(kind);
            assert_eq!(
                accept_retry_delay(&error, 1),
                Some(Duration::from_millis(50))
            );
            assert_eq!(
                accept_retry_delay(&error, 2),
                Some(Duration::from_millis(100))
            );
            assert_eq!(
                accept_retry_delay(&error, 3),
                Some(Duration::from_millis(200))
            );
            assert_eq!(
                accept_retry_delay(&error, 9),
                Some(Duration::from_millis(200))
            );
            assert_eq!(accept_retry_delay(&error, 10), None);
        }
        assert_eq!(
            accept_retry_delay(&Error::from(ErrorKind::InvalidInput), 1),
            None
        );
        #[cfg(unix)]
        for code in [libc::EMFILE, libc::ENFILE] {
            assert!(accept_retry_delay(&Error::from_raw_os_error(code), 1).is_some());
            assert!(accept_retry_delay(&Error::from_raw_os_error(code), 10).is_none());
        }
        #[cfg(windows)]
        assert!(accept_retry_delay(&Error::from_raw_os_error(10024), 1).is_some());
    }

    #[tokio::test]
    #[ignore = "requires openssl and curl; run explicitly on loopback"]
    async fn test_tls_forwarding_and_shutdown_with_config_errors() {
        use std::process::Command;
        use std::time::Duration;
        use tauri::Manager;

        struct ConfigFixture(std::path::PathBuf);
        impl Drop for ConfigFixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
                let _ = std::fs::remove_dir(self.0.parent().unwrap());
            }
        }

        let _test_guard = INSTALLED_CONFIG_TEST_LOCK.lock().await;
        let gui_config_path = crate::core_config::gui_config_path().unwrap();
        assert!(
            !gui_config_path.exists(),
            "run with an isolated Cargo target directory"
        );
        let config_path = crate::core_runtime::core_install_dir()
            .unwrap()
            .join(crate::CORE_CONFIG_FILE);
        assert!(
            !config_path.exists(),
            "run with an isolated Cargo target directory"
        );
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        let _fixture = ConfigFixture(config_path.clone());
        let core_config = "host: 127.0.0.1\ntrusted-proxies: [127.0.0.1]\n";
        std::fs::write(&config_path, core_config).unwrap();

        let cert_dir = std::env::temp_dir()
            .join("rp-test")
            .join(std::process::id().to_string());
        std::fs::create_dir_all(&cert_dir).unwrap();
        let cert_path = cert_dir.join("cert.pem");
        let key_path = cert_dir.join("key.pem");
        let generated = Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-keyout",
            ])
            .arg(&key_path)
            .arg("-out")
            .arg(&cert_path)
            .output()
            .unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );

        let backend = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = backend.local_addr().unwrap().port();
        let backend_task = tokio::spawn(async move {
            for _ in 0..4 {
                let (stream, _) = backend.accept().await.unwrap();
                let service = hyper::service::service_fn(
                    |request: hyper::Request<hyper::body::Incoming>| async move {
                        assert_eq!(
                            request.uri().path_and_query().unwrap().as_str(),
                            "/rp-check?forwarded=yes"
                        );
                        assert_eq!(request.headers()["x-forwarded-proto"], "https");
                        assert_eq!(request.headers()["x-forwarded-for"], "127.0.0.1");
                        let body = request.into_body().collect().await.unwrap().to_bytes();
                        assert_eq!(body, "ping through TLS");
                        Ok::<_, std::convert::Infallible>(
                            hyper::Response::builder()
                                .header(hyper::header::CONNECTION, "close")
                                .body(Full::new(Bytes::from_static(b"pong from loopback target")))
                                .unwrap(),
                        )
                    },
                );
                hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await
                    .unwrap();
            }
        });

        let app = tauri::test::mock_app();
        app.manage(ReverseProxyManagerState::new());
        let manager = app.state::<ReverseProxyManagerState>();
        let config = ReverseProxyConfig {
            enabled: true,
            listen_host: "127.0.0.1".into(),
            listen_port: 0,
            target_port,
            cert_path: cert_path.to_str().unwrap().into(),
            key_path: key_path.to_str().unwrap().into(),
        };

        for scenario in [
            "normal stop",
            "stop patch failure",
            "disabled apply patch failure",
            "stop read failure",
        ] {
            // Each scenario starts from a writable GUI configuration.
            let _ = std::fs::remove_dir(&gui_config_path);
            let _ = std::fs::remove_file(&gui_config_path);
            std::fs::write(&config_path, core_config).unwrap();
            let state = manager.save_and_apply(config.clone(), None).await.unwrap();
            assert!(state.running);
            let listen_addr: std::net::SocketAddr = state.listening.unwrap().parse().unwrap();
            let listen_port = listen_addr.port();
            assert_ne!(listen_port, 0);
            let url = format!("https://localhost:{listen_port}/rp-check?forwarded=yes");
            let response = tokio::task::spawn_blocking(move || {
                Command::new("curl")
                    .args([
                        "--silent",
                        "--show-error",
                        "--fail",
                        "--insecure",
                        "--noproxy",
                        "*",
                        "--max-time",
                        "5",
                        "--data-binary",
                        "ping through TLS",
                        &url,
                    ])
                    .output()
                    .unwrap()
            })
            .await
            .unwrap();
            assert!(
                response.status.success(),
                "{}",
                String::from_utf8_lossy(&response.stderr)
            );
            assert_eq!(response.stdout, b"pong from loopback target");
            println!("{scenario}: listen={listen_addr} target=127.0.0.1:{target_port} sent=\"ping through TLS\" response=\"{}\" ({} bytes)", String::from_utf8_lossy(&response.stdout), response.stdout.len());

            // The settings live in the GUI configuration only, so an
            // unwritable GUI configuration is what surfaces a save warning.
            let _ = std::fs::remove_file(&gui_config_path);
            let _ = std::fs::remove_dir(&gui_config_path);
            if scenario != "normal stop" {
                std::fs::create_dir_all(&gui_config_path).unwrap();
            }
            if scenario == "stop read failure" {
                manager.inner.lock().unwrap().stored_config = None;
            }
            // Disabling goes through the save path, which reports the failed
            // write as a warning while the listener still stops.
            let stopped = if scenario == "disabled apply patch failure" {
                let mut disabled = config.clone();
                disabled.enabled = false;
                manager.save_and_apply(disabled, None).await.unwrap()
            } else {
                manager.stop_and_save(None).await.unwrap()
            };
            assert!(!stopped.running);
            assert_eq!(stopped.listening, None);
            if scenario == "normal stop" {
                assert!(stopped.error.is_none());
                assert!(!read_saved_proxy_config_for_test().unwrap().unwrap().enabled);
            } else {
                assert!(stopped
                    .error
                    .as_ref()
                    .unwrap()
                    .contains("failed to save configuration"));
                println!("warning: {}", stopped.error.unwrap());
            }
            if scenario != "stop read failure" {
                assert!(!stopped.config.unwrap().enabled);
            }
            assert!(tokio::time::timeout(
                Duration::from_secs(2),
                tokio::net::TcpStream::connect(listen_addr)
            )
            .await
            .unwrap()
            .is_err());
            let rebound = tokio::net::TcpListener::bind(listen_addr).await.unwrap();
            println!(
                "{scenario}: connection refused after stop; rebound {}",
                rebound.local_addr().unwrap()
            );
        }
        let _ = std::fs::remove_dir(&gui_config_path);
        let _ = std::fs::remove_file(&gui_config_path);
        tokio::time::timeout(Duration::from_secs(5), backend_task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(manager.get_state().unwrap().requests_total, 4);
    }

    #[tokio::test]
    #[ignore = "requires openssl and curl; run explicitly on loopback"]
    async fn test_loopback_proxy_real_tls_requests_and_sse_streaming() {
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        struct TestCleanup {
            config_path: std::path::PathBuf,
            cert_dir: std::path::PathBuf,
        }
        impl Drop for TestCleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.config_path);
                if let Some(parent) = self.config_path.parent() {
                    let _ = std::fs::remove_dir(parent);
                }
                let _ = std::fs::remove_dir_all(&self.cert_dir);
            }
        }

        const MESSAGE_JSON: &str =
            r#"{"model":"claude-test","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}"#;
        const AUTH_ERROR_JSON: &str =
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}"#;
        const RATE_LIMIT_JSON: &str =
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#;

        let _test_guard = INSTALLED_CONFIG_TEST_LOCK.lock().await;
        let config_path = crate::core_runtime::core_install_dir()
            .unwrap()
            .join(crate::CORE_CONFIG_FILE);
        assert!(
            !config_path.exists(),
            "run with an isolated Cargo target directory"
        );
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        let cert_dir = std::env::temp_dir()
            .join("rp-loopback-test")
            .join(std::process::id().to_string());
        let _ = std::fs::remove_dir_all(&cert_dir);
        std::fs::create_dir_all(&cert_dir).unwrap();
        let _cleanup = TestCleanup {
            config_path: config_path.clone(),
            cert_dir: cert_dir.clone(),
        };
        std::fs::write(&config_path, "host: 127.0.0.1\ntrusted-proxies: [127.0.0.1]\n").unwrap();

        let cert_path = cert_dir.join("cert.pem");
        let key_path = cert_dir.join("key.pem");
        let generated = Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost",
                "-keyout",
            ])
            .arg(&key_path)
            .arg("-out")
            .arg(&cert_path)
            .output()
            .unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let cacert = cert_path.to_str().unwrap().to_string();

        // Local HTTP upstream pretending to be the API. Requests are verified
        // here so header and JSON body preservation is checked end to end.
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = upstream.local_addr().unwrap().port();
        let release_second_event = Arc::new(tokio::sync::Barrier::new(2));
        let upstream_gate = release_second_event.clone();
        let upstream_task = tokio::spawn(async move {
            loop {
                let (stream, _) = upstream.accept().await.unwrap();
                let gate = upstream_gate.clone();
                let service = hyper::service::service_fn(
                    move |request: hyper::Request<hyper::body::Incoming>| {
                        let gate = gate.clone();
                        async move {
                            let path = request
                                .uri()
                                .path_and_query()
                                .map(|pq| pq.as_str().to_string())
                                .unwrap_or_default();
                            assert_eq!(request.method(), hyper::Method::POST);
                            assert_eq!(
                                request.headers()["authorization"],
                                "Bearer sk-test-token"
                            );
                            assert_eq!(request.headers()["content-type"], "application/json");
                            assert_eq!(request.headers()["x-forwarded-proto"], "https");
                            assert_eq!(request.headers()["x-forwarded-for"], "127.0.0.1");
                            let api_key = request.headers()["x-api-key"]
                                .to_str()
                                .unwrap()
                                .to_string();
                            let accepts_sse = request.headers()["accept"] == "text/event-stream";
                            let body = request.into_body().collect().await.unwrap().to_bytes();
                            assert_eq!(
                                body,
                                Bytes::from_static(MESSAGE_JSON.as_bytes()),
                                "request JSON body was not preserved"
                            );
                            match path.as_str() {
                                "/v1/messages?x=1" => {
                                    let (status, retry_after, payload) = match api_key.as_str() {
                                        "key-401" => (
                                            hyper::StatusCode::UNAUTHORIZED,
                                            None,
                                            AUTH_ERROR_JSON,
                                        ),
                                        "key-429" => (
                                            hyper::StatusCode::TOO_MANY_REQUESTS,
                                            Some("30"),
                                            RATE_LIMIT_JSON,
                                        ),
                                        other => panic!("unexpected x-api-key: {other}"),
                                    };
                                    let mut builder = hyper::Response::builder()
                                        .status(status)
                                        .header("content-type", "application/json")
                                        .header("connection", "close");
                                    if let Some(retry_after) = retry_after {
                                        builder = builder.header("retry-after", retry_after);
                                    }
                                    Ok::<_, std::convert::Infallible>(
                                        builder
                                            .body(Full::new(Bytes::from(payload)).boxed())
                                            .unwrap(),
                                    )
                                }
                                "/v1/messages?stream=true" => {
                                    assert_eq!(api_key, "key-stream");
                                    assert!(accepts_sse, "accept header was not preserved");
                                    // Second event is gated: it is only produced after
                                    // the test has observed the first event at the
                                    // client, proving the proxy does not buffer.
                                    let frames = futures_util::stream::unfold(
                                        (gate, 0u8),
                                        |(gate, step)| async move {
                                            match step {
                                                0 => Some((
                                                    Ok::<_, std::convert::Infallible>(
                                                        hyper::body::Frame::data(
                                                            Bytes::from_static(
                                                                b"event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
                                                            ),
                                                        ),
                                                    ),
                                                    (gate, 1),
                                                )),
                                                1 => {
                                                    gate.wait().await;
                                                    Some((
                                                        Ok(hyper::body::Frame::data(
                                                            Bytes::from_static(
                                                                b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
                                                            ),
                                                        )),
                                                        (gate, 2),
                                                    ))
                                                }
                                                _ => None,
                                            }
                                        },
                                    );
                                    Ok(hyper::Response::builder()
                                        .status(hyper::StatusCode::OK)
                                        .header("content-type", "text/event-stream")
                                        .header("cache-control", "no-cache")
                                        .header("connection", "close")
                                        .body(http_body_util::StreamBody::new(frames).boxed())
                                        .unwrap())
                                }
                                other => panic!("unexpected upstream path: {other}"),
                            }
                        }
                    },
                );
                tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });

        // Same manager/start code the Tauri commands use.
        let manager = ReverseProxyManagerState::new();
        let config = ReverseProxyConfig {
            enabled: true,
            listen_host: "127.0.0.1".into(),
            listen_port: 0,
            target_port,
            cert_path: cert_path.to_str().unwrap().into(),
            key_path: key_path.to_str().unwrap().into(),
        };
        let state = manager.save_and_apply(config.clone(), None).await.unwrap();
        assert!(state.running);
        let listen_addr: std::net::SocketAddr = state.listening.unwrap().parse().unwrap();
        let base = format!("https://localhost:{}", listen_addr.port());
        println!("proxy listening on {listen_addr}, upstream 127.0.0.1:{target_port}");

        fn curl(args: Vec<String>) -> std::process::Output {
            Command::new("curl").args(&args).output().unwrap()
        }
        fn split_response(output: &[u8]) -> (String, Vec<u8>) {
            let split = output
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .expect("missing header/body separator");
            (
                String::from_utf8_lossy(&output[..split]).to_string(),
                output[split + 4..].to_vec(),
            )
        }

        // TLS is real: the same request fails certificate verification without
        // the CA bundle.
        let denied = tokio::task::spawn_blocking({
            let base = base.clone();
            move || {
                curl(vec![
                    "--noproxy".into(),
                    "*".into(),
                    "--silent".into(),
                    "--show-error".into(),
                    "--max-time".into(),
                    "5".into(),
                    format!("{base}/v1/messages?x=1"),
                ])
            }
        })
        .await
        .unwrap();
        assert!(
            !denied.status.success(),
            "request without --cacert unexpectedly succeeded"
        );
        println!(
            "no --cacert: curl failed as expected: {}",
            String::from_utf8_lossy(&denied.stderr).trim()
        );

        for (api_key, expected_status, expected_body, expect_retry_after) in [
            ("key-401", "401", AUTH_ERROR_JSON, false),
            ("key-429", "429", RATE_LIMIT_JSON, true),
        ] {
            let cacert = cacert.clone();
            let base = base.clone();
            let out = tokio::task::spawn_blocking(move || {
                curl(vec![
                    "--noproxy".into(),
                    "*".into(),
                    "--cacert".into(),
                    cacert,
                    "--silent".into(),
                    "--show-error".into(),
                    "--include".into(),
                    "--max-time".into(),
                    "10".into(),
                    "-H".into(),
                    "authorization: Bearer sk-test-token".into(),
                    "-H".into(),
                    format!("x-api-key: {api_key}"),
                    "-H".into(),
                    "content-type: application/json".into(),
                    "--data-binary".into(),
                    MESSAGE_JSON.into(),
                    format!("{base}/v1/messages?x=1"),
                ])
            })
            .await
            .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let (head, body) = split_response(&out.stdout);
            assert!(
                head.starts_with(&format!("HTTP/1.1 {expected_status}")),
                "status line was not preserved: {head}"
            );
            assert!(
                head.to_ascii_lowercase()
                    .contains("content-type: application/json"),
                "response content-type was not preserved: {head}"
            );
            if expect_retry_after {
                assert!(
                    head.to_ascii_lowercase().contains("retry-after: 30"),
                    "retry-after header was not preserved: {head}"
                );
            }
            assert_eq!(
                body,
                expected_body.as_bytes(),
                "response body was not preserved"
            );
            println!(
                "POST /v1/messages?x=1 (x-api-key={api_key}): status={expected_status}, body={}",
                String::from_utf8_lossy(&body)
            );
        }

        // SSE: the upstream holds the second event behind a barrier; the first
        // event must still reach the curl client, proving incremental delivery.
        let mut child = Command::new("curl")
            .args([
                "--noproxy",
                "*",
                "--cacert",
                &cacert,
                "--silent",
                "--show-error",
                "--no-buffer",
                "--max-time",
                "15",
                "-H",
                "authorization: Bearer sk-test-token",
                "-H",
                "x-api-key: key-stream",
                "-H",
                "accept: text/event-stream",
                "-H",
                "content-type: application/json",
                "--data-binary",
                MESSAGE_JSON,
                "-w",
                "\n__STATUS__:%{http_code} __CTYPE__:%{content_type}\n",
            ])
            .arg(format!("{base}/v1/messages?stream=true"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let stream_started = Instant::now();
        let reader = tokio::task::spawn_blocking(move || {
            let mut collected = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        collected.extend_from_slice(&buf[..n]);
                        let _ = chunk_tx.send(buf[..n].to_vec());
                    }
                }
            }
            let status = child.wait().unwrap();
            (collected, status)
        });

        let mut received: Vec<u8> = Vec::new();
        let mut chunk_count = 0usize;
        let first_arrival = tokio::time::timeout(Duration::from_secs(10), async {
            while !received
                .windows(b"message_start".len())
                .any(|w| w == b"message_start")
            {
                match chunk_rx.recv().await {
                    Some(chunk) => {
                        chunk_count += 1;
                        println!(
                            "stream chunk #{chunk_count}: {} bytes at {:?}",
                            chunk.len(),
                            stream_started.elapsed()
                        );
                        received.extend_from_slice(&chunk);
                    }
                    None => break,
                }
            }
        })
        .await;
        assert!(
            first_arrival.is_ok(),
            "first SSE event did not reach the client while the upstream held the second event"
        );
        let early = String::from_utf8_lossy(&received).to_string();
        assert!(early.contains("message_start"));
        assert!(
            !early.contains("message_stop"),
            "second event arrived before the barrier was released"
        );
        println!(
            "first SSE event reached curl at {:?} while upstream still holds event two",
            stream_started.elapsed()
        );

        release_second_event.wait().await;
        let (collected, status) = tokio::time::timeout(Duration::from_secs(10), reader)
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
        let streamed = String::from_utf8_lossy(&collected).to_string();
        let first_pos = streamed.find("message_start").unwrap();
        let second_pos = streamed.find("message_stop").unwrap();
        assert!(first_pos < second_pos, "SSE events out of order: {streamed}");
        assert!(
            streamed.contains("__STATUS__:200"),
            "unexpected status write-out: {streamed}"
        );
        assert!(
            streamed.contains("__CTYPE__:text/event-stream"),
            "unexpected content-type write-out: {streamed}"
        );
        println!("SSE stream completed: {streamed:?}");

        // Upstream unreachable: the listener must keep answering with 502.
        upstream_task.abort();
        let _ = upstream_task.await;
        for attempt in 1..=2 {
            let cacert = cacert.clone();
            let base = base.clone();
            let out = tokio::task::spawn_blocking(move || {
                curl(vec![
                    "--noproxy".into(),
                    "*".into(),
                    "--cacert".into(),
                    cacert,
                    "--silent".into(),
                    "--show-error".into(),
                    "--include".into(),
                    "--max-time".into(),
                    "10".into(),
                    "-H".into(),
                    "authorization: Bearer sk-test-token".into(),
                    "-H".into(),
                    "x-api-key: key-401".into(),
                    "-H".into(),
                    "content-type: application/json".into(),
                    "--data-binary".into(),
                    MESSAGE_JSON.into(),
                    format!("{base}/v1/messages?x=1"),
                ])
            })
            .await
            .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let (head, body) = split_response(&out.stdout);
            assert!(
                head.starts_with("HTTP/1.1 502"),
                "expected 502 for dead upstream, got: {head}"
            );
            assert!(
                String::from_utf8_lossy(&body).contains("Bad Gateway"),
                "unexpected 502 body: {}",
                String::from_utf8_lossy(&body)
            );
            println!(
                "upstream down attempt {attempt}: status=502 body={}",
                String::from_utf8_lossy(&body)
            );
        }
        assert!(manager.get_state().unwrap().running);
        tokio::net::TcpStream::connect(listen_addr)
            .await
            .expect("listener died after upstream failure");

        let stopped = manager.stop_and_save(None).await.unwrap();
        assert!(!stopped.running);
        assert!(tokio::time::timeout(
            Duration::from_secs(2),
            tokio::net::TcpStream::connect(listen_addr)
        )
        .await
        .unwrap()
        .is_err());
        assert_eq!(manager.get_state().unwrap().requests_total, 5);
        println!("stopped cleanly; total forwarded requests: 5");
    }

    #[test]
    fn test_bind_errors_name_the_port_and_explain_access_denied() {
        let generic = std::io::Error::from(std::io::ErrorKind::AddrInUse);
        let message = describe_bind_error("0.0.0.0:443", &generic);
        assert!(message.contains("0.0.0.0:443"), "{message}");
        assert!(!message.contains("excluded port range"), "{message}");

        let denied = std::io::Error::from_raw_os_error(bind_access_denied_code());
        let message = describe_bind_error("0.0.0.0:8444", &denied);
        assert!(message.contains("0.0.0.0:8444"), "{message}");
        assert!(message.contains("port 8444"), "{message}");
        assert!(message.contains("reserved"), "{message}");
        assert!(message.contains("excluded port range"), "{message}");
    }

    #[cfg(windows)]
    fn bind_access_denied_code() -> i32 {
        10013
    }

    #[cfg(not(windows))]
    fn bind_access_denied_code() -> i32 {
        libc::EACCES
    }

    fn test_saved_proxy_config() -> ReverseProxyConfig {
        ReverseProxyConfig {
            enabled: true,
            listen_host: "0.0.0.0".to_string(),
            listen_port: 443,
            target_port: 8258,
            cert_path: "/tls/cert.pem".to_string(),
            key_path: "/tls/key.pem".to_string(),
        }
    }

    #[test]
    fn test_saved_proxy_config_survives_gui_store_rewrite_and_kernel_regeneration() {
        let config = test_saved_proxy_config();
        let home = crate::unique_test_temp_path("cpa-gui-reverse-proxy-persist");
        std::fs::create_dir_all(&home).unwrap();
        let gui_config_path = home.join("config.toml");

        // Save writes the settings into the GUI's own durable configuration.
        let saved = crate::reverse_proxy::attach_saved_proxy_config(config.clone(), &home).unwrap();
        assert_eq!(saved.reverse_proxy.as_ref(), Some(&config));
        let stored = std::fs::read_to_string(&gui_config_path).unwrap();
        let loaded: crate::GuiConfigFile = toml::from_str(&stored).unwrap();
        assert_eq!(loaded.reverse_proxy.as_ref(), Some(&config));

        // A later GUI save for unrelated settings keeps the block, and the
        // block is dropped only when the settings are cleared on purpose.
        let mut unrelated = loaded.clone();
        unrelated.port = 9123;
        crate::core_config::write_gui_config_to_path(&unrelated, &gui_config_path).unwrap();
        let after_unrelated = std::fs::read_to_string(&gui_config_path).unwrap();
        assert!(after_unrelated.contains("[reverse-proxy]"), "{after_unrelated}");
        let reloaded: crate::GuiConfigFile = toml::from_str(&after_unrelated).unwrap();
        assert_eq!(reloaded.port, 9123);
        assert_eq!(reloaded.reverse_proxy.as_ref(), Some(&config));

        // Kernel configuration regeneration never carries the block: the
        // reverse proxy settings belong to the GUI configuration only.
        let template = "config-version: 8\nserver: {host: 0.0.0.0, port: 8317}\n";
        let current = format!(
            "{template}reverse-proxy:\n  enabled: true\n  listen-host: 0.0.0.0\n  listen-port: 443\n  target-port: 8258\n  cert-path: /tls/cert.pem\n  key-path: /tls/key.pem\n"
        );
        let regenerated =
            crate::core_config::merge_core_config_yaml(template, Some(&current), &loaded).unwrap();
        let mut document: serde_norway::Value = serde_norway::from_str(&regenerated).unwrap();
        // The section is dropped when it is still present, and never written.
        let stripped = match crate::core_config::remove_core_yaml_section(&regenerated, "reverse-proxy") {
            Ok(Some(stripped)) => stripped,
            other => panic!("{other:?}\n{regenerated}"),
        };
        assert!(!stripped.contains("reverse-proxy"), "{stripped}");
        document = serde_norway::from_str(&stripped).unwrap();
        assert!(read_proxy_config_document(&document).unwrap().is_none(), "{stripped}");
        // The start-up preparation still hardens the kernel while the proxy runs.
        let mut hardened = document;
        assert!(prepare_core_start(&mut hardened, loaded.reverse_proxy.as_ref()).unwrap());
        assert_eq!(hardened["server"]["host"].as_str(), Some("127.0.0.1"));
        assert!(hardened.get("reverse-proxy").is_none());

        // Reload reads the durable GUI copy alone.
        assert_eq!(
            crate::reverse_proxy::read_gui_proxy_config_at(&home).unwrap(),
            Some(config.clone())
        );
        let mut cleared = reloaded.clone();
        cleared.reverse_proxy = None;
        crate::core_config::write_gui_config_to_path(&cleared, &gui_config_path).unwrap();
        assert!(!std::fs::read_to_string(&gui_config_path)
            .unwrap()
            .contains("reverse-proxy"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn test_saved_proxy_config_survives_whole_file_gui_settings_update() {
        let config = test_saved_proxy_config();
        let home = crate::unique_test_temp_path("cpa-gui-reverse-proxy-gui-state");
        std::fs::create_dir_all(&home).unwrap();
        let gui_config_path = home.join("config.toml");

        // Saving writes the block into the GUI's durable configuration and,
        // with a handle available, mirrors it into the in-memory settings.
        let saved = crate::reverse_proxy::attach_saved_proxy_config(config.clone(), &home).unwrap();
        assert_eq!(saved.reverse_proxy.as_ref(), Some(&config));
        let in_memory = crate::GuiConfigState::new(saved);

        // An unrelated GUI settings save serializes the whole file from the
        // in-memory settings, which is what previously dropped the block.
        in_memory
            .update(|gui_config| {
                gui_config.port = 9123;
                Ok(())
            })
            .unwrap();
        let rewritten = in_memory.snapshot().unwrap();
        crate::core_config::write_gui_config_to_path(&rewritten, &gui_config_path).unwrap();

        let stored = std::fs::read_to_string(&gui_config_path).unwrap();
        assert!(stored.contains("[reverse-proxy]"), "{stored}");
        let reloaded: crate::GuiConfigFile = toml::from_str(&stored).unwrap();
        assert_eq!(reloaded.port, 9123);
        assert_eq!(reloaded.reverse_proxy.as_ref(), Some(&config), "{stored}");
        assert_eq!(
            crate::reverse_proxy::read_gui_proxy_config_at(&home).unwrap(),
            Some(config.clone())
        );
        for field in [
            "enabled = true",
            "listen-host = \"0.0.0.0\"",
            "listen-port = 443",
            "target-port = 8258",
            "cert-path = \"/tls/cert.pem\"",
            "key-path = \"/tls/key.pem\"",
        ] {
            assert!(stored.contains(field), "missing {field} in {stored}");
        }

        std::fs::remove_dir_all(home).unwrap();
    }

    fn test_proxy_config_legacy_section_reads_paths_and_removal_keeps_other_fields() {
        let config = ReverseProxyConfig {
            enabled: true,
            listen_host: "0.0.0.0".to_string(),
            listen_port: 8443,
            target_port: 8317,
            cert_path: r"C:\TLS files\cert.pem".to_string(),
            key_path: r"C:\TLS files\key.pem".to_string(),
        };
        let value = serde_norway::to_value(&config).unwrap();
        for source in [
            "# keep\nport: 12345\n",
            "# keep\nconfig-version: 8\nserver:\n  port: 12345\n",
        ] {
            let saved = crate::core_config::patch_core_yaml_document(source, |document| {
                set_core_yaml_path_value(document, &["reverse-proxy"], value.clone())
            })
            .unwrap()
            .unwrap();
            assert!(saved.contains("# keep"));
            let document: serde_norway::Value = serde_norway::from_str(&saved).unwrap();
            assert_eq!(configured_core_port(&document).unwrap(), Some(12345));
            assert_eq!(
                read_proxy_config_document(&document).unwrap(),
                Some(config.clone())
            );

            // Removing the legacy section keeps every other kernel field as-is.
            let removed = crate::core_config::remove_core_yaml_section(&saved, "reverse-proxy")
                .unwrap()
                .unwrap();
            assert!(removed.contains("# keep"));
            let document: serde_norway::Value = serde_norway::from_str(&removed).unwrap();
            assert!(read_proxy_config_document(&document).unwrap().is_none());
            assert_eq!(configured_core_port(&document).unwrap(), Some(12345));
            assert!(
                crate::core_config::remove_core_yaml_section(&removed, "reverse-proxy")
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn test_legacy_kernel_proxy_config_migrates_into_gui_config() {
        let config = test_saved_proxy_config();
        let home = crate::unique_test_temp_path("cpa-gui-reverse-proxy-migrate");
        std::fs::create_dir_all(&home).unwrap();
        let gui_config_path = home.join("config.toml");
        let kernel_dir = home.join("cpa-core");
        std::fs::create_dir_all(&kernel_dir).unwrap();
        let kernel_path = kernel_dir.join(crate::CORE_CONFIG_FILE);
        let kernel = "# keep\nconfig-version: 8\nserver:\n  port: 8317\nreverse-proxy:\n  enabled: true\n  listen-host: 0.0.0.0\n  listen-port: 443\n  target-port: 8258\n  cert-path: /tls/cert.pem\n  key-path: /tls/key.pem\n";
        std::fs::write(&kernel_path, kernel).unwrap();

        // The kernel copy is imported into the GUI configuration, then removed.
        assert_eq!(
            crate::reverse_proxy::read_kernel_proxy_config_at(&kernel_path).unwrap(),
            Some(config.clone())
        );
        crate::reverse_proxy::migrate_proxy_config_from_kernel_at(&home, &kernel_dir, None).unwrap();
        let stored = std::fs::read_to_string(&gui_config_path).unwrap();
        let migrated: crate::GuiConfigFile = toml::from_str(&stored).unwrap();
        assert_eq!(migrated.reverse_proxy.as_ref(), Some(&config), "{stored}");
        assert_eq!(
            crate::reverse_proxy::read_gui_proxy_config_at(&home).unwrap(),
            Some(config.clone())
        );
        let kernel = std::fs::read_to_string(&kernel_path).unwrap();
        assert!(!kernel.contains("reverse-proxy"), "{kernel}");
        assert!(kernel.contains("config-version: 8"), "{kernel}");
        assert!(kernel.contains("port: 8317"), "{kernel}");

        // Running it again changes nothing.
        crate::reverse_proxy::migrate_proxy_config_from_kernel_at(&home, &kernel_dir, None).unwrap();
        assert_eq!(std::fs::read_to_string(&kernel_path).unwrap(), kernel);
        assert_eq!(std::fs::read_to_string(&gui_config_path).unwrap(), stored);

        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn test_legacy_kernel_proxy_config_survives_a_failed_migration() {
        let config = test_saved_proxy_config();
        let home = crate::unique_test_temp_path("cpa-gui-reverse-proxy-migrate-fail");
        std::fs::create_dir_all(&home).unwrap();
        let gui_config_path = home.join("config.toml");
        let kernel_dir = home.join("cpa-core");
        std::fs::create_dir_all(&kernel_dir).unwrap();
        let kernel_path = kernel_dir.join(crate::CORE_CONFIG_FILE);
        let kernel = "config-version: 8\nserver:\n  port: 8317\nreverse-proxy:\n  enabled: true\n  listen-host: 0.0.0.0\n  listen-port: 443\n  target-port: 8258\n  cert-path: /tls/cert.pem\n  key-path: /tls/key.pem\n";
        std::fs::write(&kernel_path, &kernel).unwrap();

        // A GUI configuration that cannot be written leaves the kernel copy as
        // the only place holding the values, so it must survive.
        std::fs::write(&gui_config_path, "port = 0\n").unwrap();
        crate::reverse_proxy::migrate_proxy_config_from_kernel_at(&home, &kernel_dir, None)
            .unwrap_err();
        assert_eq!(std::fs::read_to_string(&kernel_path).unwrap(), kernel);
        assert_eq!(
            crate::reverse_proxy::read_kernel_proxy_config_at(&kernel_path).unwrap(),
            Some(config.clone())
        );

        // Once the GUI configuration can be written the values move over and
        // the kernel copy is gone.
        std::fs::write(&gui_config_path, "").unwrap();
        crate::reverse_proxy::migrate_proxy_config_from_kernel_at(&home, &kernel_dir, None).unwrap();
        assert_eq!(
            crate::reverse_proxy::read_gui_proxy_config_at(&home).unwrap(),
            Some(config)
        );
        let kernel = std::fs::read_to_string(&kernel_path).unwrap();
        assert!(!kernel.contains("reverse-proxy"), "{kernel}");
        assert!(kernel.contains("port: 8317"), "{kernel}");

        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn test_legacy_kernel_proxy_config_survives_the_startup_settings_save() {
        let mut config = test_saved_proxy_config();
        config.listen_port = 18443;
        let home = crate::unique_test_temp_path("cpa-gui-reverse-proxy-migrate-startup");
        std::fs::create_dir_all(&home).unwrap();
        let gui_config_path = home.join("config.toml");
        let kernel_dir = home.join("cpa-core");
        std::fs::create_dir_all(&kernel_dir).unwrap();
        let kernel_path = kernel_dir.join(crate::CORE_CONFIG_FILE);
        let kernel = "config-version: 8\nserver:\n  port: 8317\nreverse-proxy:\n  enabled: true\n  listen-host: 0.0.0.0\n  listen-port: 18443\n  target-port: 8258\n  cert-path: /tls/cert.pem\n  key-path: /tls/key.pem\n";
        std::fs::write(&kernel_path, kernel).unwrap();
        std::fs::write(&gui_config_path, "run-on-startup = false\nport = 9123\n").unwrap();

        // The settings as the application loaded them before the migration: the
        // file itself holds no block, so the in-memory copy has none either.
        let loaded: crate::GuiConfigFile =
            toml::from_str(&std::fs::read_to_string(&gui_config_path).unwrap()).unwrap();
        let in_memory = crate::GuiConfigState::new(loaded);
        assert!(in_memory.snapshot().unwrap().reverse_proxy.is_none());

        crate::reverse_proxy::migrate_proxy_config_from_kernel_at(
            &home,
            &kernel_dir,
            Some(&in_memory),
        )
        .unwrap();

        // The startup path then saves an unrelated setting, which serializes the
        // whole file from the in-memory settings.
        let snapshot = in_memory.set_run_on_startup(true).unwrap();
        crate::core_config::write_gui_config_to_path(&snapshot, &gui_config_path).unwrap();

        let stored = std::fs::read_to_string(&gui_config_path).unwrap();
        assert!(stored.contains("[reverse-proxy]"), "{stored}");
        for field in [
            "enabled = true",
            "listen-host = \"0.0.0.0\"",
            "listen-port = 18443",
            "target-port = 8258",
            "cert-path = \"/tls/cert.pem\"",
            "key-path = \"/tls/key.pem\"",
        ] {
            assert!(stored.contains(field), "missing {field} in {stored}");
        }
        let reloaded: crate::GuiConfigFile = toml::from_str(&stored).unwrap();
        assert_eq!(reloaded.reverse_proxy.as_ref(), Some(&config), "{stored}");
        assert_eq!(
            in_memory.snapshot().unwrap().reverse_proxy.as_ref(),
            Some(&config)
        );
        assert_eq!(reloaded.port, 9123, "{stored}");
        assert!(reloaded.run_on_startup, "{stored}");

        // The kernel copy is gone because both writes succeeded.
        let kernel = std::fs::read_to_string(&kernel_path).unwrap();
        assert!(!kernel.contains("reverse-proxy"), "{kernel}");

        std::fs::remove_dir_all(home).unwrap();
    }

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
    fn test_config_validation_allows_ephemeral_listen_port_and_auto_target() {
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
        assert!(validate_config(&cfg).is_ok());

        // Port 0 target means "follow the kernel port" and is resolved when
        // the forwarding client is built, so it stays a valid draft value.
        let mut cfg = valid_config.clone();
        cfg.target_port = 0;
        assert!(validate_config(&cfg).is_ok());

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

        let mut disabled = config.clone();
        disabled.enabled = false;
        let state = manager.apply(disabled.clone(), None).await.unwrap();
        assert!(!state.running);
        assert_eq!(state.config, Some(disabled));
        let state = manager.apply(config.clone(), None).await.unwrap();
        assert!(state.running);
        assert_eq!(state.listening, Some(format!("127.0.0.1:{proxy_port}")));
        assert_eq!(state.target, Some(format!("127.0.0.1:{target_port}")));

        let conflict_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let occupied_port = conflict_listener.local_addr().unwrap().port();
        let conflicting = ReverseProxyManagerState::new();
        let error = conflicting.start(
            ReverseProxyConfig {
                listen_port: occupied_port,
                ..config.clone()
            },
            None,
        )
        .await
        .unwrap_err();
        assert!(error.contains("Failed to bind listener"));
        let failed_state = conflicting.get_state().unwrap();
        assert!(!failed_state.running);
        assert_eq!(failed_state.listening, None);
        assert_eq!(failed_state.target, None);
        assert_eq!(failed_state.error, Some(error));
        assert!(conflicting.inner.lock().unwrap().server_task.is_none());
        assert!(!manager
            .inner
            .lock()
            .unwrap()
            .server_task
            .as_ref()
            .unwrap()
            .is_finished());

        // A successful start clears a bind failure from an earlier attempt so a
        // running listener is never shown together with a stale bind error.
        {
            let mut guard = manager.inner.lock().unwrap();
            guard.error = Some(format!(
                "Failed to bind listener on 127.0.0.1:{proxy_port}: address in use"
            ));
        }
        let state = manager.apply(config.clone(), None).await.unwrap();
        assert!(state.running);
        assert_eq!(state.error, None, "{state:?}");

        // A second proxy instance that cannot bind reports the same specific
        // error and stays stopped instead of looking like a running listener.
        let error = conflicting
            .apply(config.clone(), None)
            .await
            .unwrap_err();
        assert!(error.contains("Failed to bind listener"), "{error}");
        let failed_state = conflicting.get_state().unwrap();
        assert!(!failed_state.running, "{failed_state:?}");
        assert_eq!(failed_state.listening, None);
        assert_eq!(failed_state.error, Some(error));

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
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", proxy_port))
            .await
            .is_err());

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
        assert!(state
            .error
            .unwrap()
            .contains("Certificate file does not exist"));
        assert_eq!(state.listening, None);
        assert_eq!(state.target, None);
        assert!(manager.inner.lock().unwrap().server_task.is_none());
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
        // Reads the installed core config through the get_state command, so it
        // must not overlap the real-TLS fixtures that swap that file out.
        let _test_guard = INSTALLED_CONFIG_TEST_LOCK.lock().await;
        let app = tauri::test::mock_app();
        let manager = ReverseProxyManagerState::new();
        {
            let mut guard = manager.inner.lock().unwrap();
            guard.hardening.restart_required = true;
        }
        app.manage(manager);
        app.manage(crate::GuiConfigState::new(crate::GuiConfigFile::default()));
        let state = app.state::<ReverseProxyManagerState>();
        let res = reverse_proxy_get_state(state, app.state::<crate::GuiConfigState>())
            .await
            .unwrap();
        assert!(res.hardening.restart_required);

        // When not required, it remains false
        let app2 = tauri::test::mock_app();
        let manager2 = ReverseProxyManagerState::new();
        app2.manage(manager2);
        app2.manage(crate::GuiConfigState::new(crate::GuiConfigFile::default()));
        let state2 = app2.state::<ReverseProxyManagerState>();
        let res2 = reverse_proxy_get_state(state2, app2.state::<crate::GuiConfigState>())
            .await
            .unwrap();
        assert!(!res2.hardening.restart_required);
    }
}
