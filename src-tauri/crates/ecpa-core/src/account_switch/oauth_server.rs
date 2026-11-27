use super::crypto::fill_random_bytes;
use super::types::{AccountSummary, OAuthSessionView, SwitchPlatformId};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, LazyLock, Mutex};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub(crate) struct OAuthSessionEntry {
    pub(crate) view: OAuthSessionView,
    pub(crate) cancel: CancellationToken,
}

static OAUTH_SESSIONS: LazyLock<Mutex<HashMap<String, OAuthSessionEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn generate_pkce_pair() -> Result<(String, String, String), String> {
    let mut verifier_bytes = [0u8; 32];
    fill_random_bytes(&mut verifier_bytes)?;
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut state_bytes = [0u8; 16];
    fill_random_bytes(&mut state_bytes)?;
    let state = URL_SAFE_NO_PAD.encode(state_bytes);
    Ok((verifier, challenge, state))
}

pub(crate) fn register_session(view: OAuthSessionView, cancel: CancellationToken) {
    if let Ok(mut map) = OAUTH_SESSIONS.lock() {
        // Keep session map bounded.
        if map.len() > 24 {
            let completed_keys: Vec<String> = map
                .iter()
                .filter(|(_, entry)| entry.view.status != "pending")
                .map(|(key, _)| key.clone())
                .collect();
            for key in completed_keys {
                map.remove(&key);
            }
        }
        map.insert(view.session_id.clone(), OAuthSessionEntry { view, cancel });
    }
}

pub(crate) fn update_session_success(session_id: &str, account: AccountSummary) {
    if let Ok(mut map) = OAUTH_SESSIONS.lock() {
        if let Some(entry) = map.get_mut(session_id) {
            entry.view.status = "completed".to_string();
            entry.view.error = None;
            entry.view.account = Some(account);
        }
    }
}

pub(crate) fn update_session_error(session_id: &str, error: String) {
    if let Ok(mut map) = OAUTH_SESSIONS.lock() {
        if let Some(entry) = map.get_mut(session_id) {
            if entry.view.status == "cancelled" {
                return;
            }
            entry.view.status = "error".to_string();
            entry.view.error = Some(error);
        }
    }
}

pub(crate) fn get_session_view(session_id: &str) -> Result<OAuthSessionView, String> {
    let map = OAUTH_SESSIONS
        .lock()
        .map_err(|_| "OAuth session store lock poisoned".to_string())?;
    map.get(session_id)
        .map(|entry| entry.view.clone())
        .ok_or_else(|| format!("OAuth session not found: {session_id}"))
}

pub(crate) fn cancel_session(session_id: &str) -> Result<OAuthSessionView, String> {
    let mut map = OAUTH_SESSIONS
        .lock()
        .map_err(|_| "OAuth session store lock poisoned".to_string())?;
    let entry = map
        .get_mut(session_id)
        .ok_or_else(|| format!("OAuth session not found: {session_id}"))?;
    entry.cancel.cancel();
    if entry.view.status == "pending" {
        entry.view.status = "cancelled".to_string();
    }
    Ok(entry.view.clone())
}

pub(crate) struct CallbackResult {
    pub(crate) code: String,
    pub(crate) state: Option<String>,
}

/// Starts a single-shot local HTTP/1.1 OAuth callback listener on `127.0.0.1:<preferred_port>`
/// (falling back to port 0 if `preferred_port` is 0 or `allow_fallback` is true).
pub(crate) async fn bind_loopback_callback(
    preferred_port: u16,
    allow_fallback: bool,
    expected_path: &'static str,
    expected_state: String,
    cancel: CancellationToken,
) -> Result<(u16, oneshot::Receiver<Result<CallbackResult, String>>), String> {
    let listener = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], preferred_port))).await
    {
        Ok(l) => l,
        Err(_) if allow_fallback && preferred_port != 0 => {
            TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
                .await
                .map_err(|error| format!("Failed to bind local OAuth callback port: {error}"))?
        }
        Err(error) => {
            return Err(format!(
                "Failed to bind local OAuth callback port {preferred_port}: {error}"
            ));
        }
    };
    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed to inspect callback socket: {error}"))?
        .port();
    let (tx, rx) = oneshot::channel::<Result<CallbackResult, String>>();
    let shared_tx = Arc::new(Mutex::new(Some(tx)));

    tokio::spawn(async move {
        let timeout = tokio::time::sleep(std::time::Duration::from_secs(300));
        tokio::pin!(timeout);

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    if let Some(sender) = shared_tx.lock().ok().and_then(|mut g| g.take()) {
                        let _ = sender.send(Err("OAuth login cancelled".into()));
                    }
                    break;
                }
                _ = &mut timeout => {
                    if let Some(sender) = shared_tx.lock().ok().and_then(|mut g| g.take()) {
                        let _ = sender.send(Err("OAuth login timed out after 5 minutes".into()));
                    }
                    break;
                }
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else {
                        break;
                    };
                    let tx_clone = Arc::clone(&shared_tx);
                    let expected_state_clone = expected_state.clone();
                    let io = TokioIo::new(stream);
                    let service = service_fn(move |req: Request<hyper::body::Incoming>| {
                        let tx_inner = Arc::clone(&tx_clone);
                        let state_expected = expected_state_clone.clone();
                        async move {
                            let uri = req.uri();
                            if uri.path() != expected_path {
                                return Ok::<_, Infallible>(
                                    Response::builder()
                                        .status(StatusCode::NOT_FOUND)
                                        .body(Full::new(Bytes::from("Not found")))
                                        .unwrap(),
                                );
                            }
                            let parsed_url = url::Url::parse(&format!("http://127.0.0.1{uri}")).ok();
                            let mut code = None;
                            let mut state = None;
                            let mut oauth_error = None;
                            if let Some(u) = parsed_url {
                                for (k, v) in u.query_pairs() {
                                    match k.as_ref() {
                                        "code" => code = Some(v.into_owned()),
                                        "state" => state = Some(v.into_owned()),
                                        "error" => oauth_error = Some(v.into_owned()),
                                        _ => {}
                                    }
                                }
                            }
                            let html_ok = "<!doctype html><html><body style='font-family:system-ui;padding:32px;text-align:center'><h2>Authorization Completed</h2><p>You can close this browser tab and return to EasyCLIProxyAPI.</p></body></html>";
                            let html_err = "<!doctype html><html><body style='font-family:system-ui;padding:32px;text-align:center'><h2>Authorization Failed</h2><p>Please return to EasyCLIProxyAPI and try again.</p></body></html>";

                            let response_html = if let Some(err) = oauth_error {
                                if let Some(sender) = tx_inner.lock().ok().and_then(|mut g| g.take()) {
                                    let _ = sender.send(Err(format!("Provider returned OAuth error: {err}")));
                                }
                                html_err
                            } else if let Some(code_val) = code {
                                if !state_expected.is_empty() && state.as_deref() != Some(state_expected.as_str()) {
                                    if let Some(sender) = tx_inner.lock().ok().and_then(|mut g| g.take()) {
                                        let _ = sender.send(Err("OAuth state mismatch (possible CSRF)".into()));
                                    }
                                    html_err
                                } else {
                                    if let Some(sender) = tx_inner.lock().ok().and_then(|mut g| g.take()) {
                                        let _ = sender.send(Ok(CallbackResult { code: code_val, state }));
                                    }
                                    html_ok
                                }
                            } else {
                                html_err
                            };

                            Ok::<_, Infallible>(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header("Content-Type", "text/html; charset=utf-8")
                                    .body(Full::new(Bytes::from(response_html)))
                                    .unwrap(),
                            )
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, service)
                        .await;
                    if shared_tx.lock().ok().is_some_and(|g| g.is_none()) {
                        break;
                    }
                }
            }
        }
    });

    Ok((port, rx))
}

pub(crate) fn new_pending_view(
    platform: SwitchPlatformId,
    flow: &str,
    auth_url: Option<String>,
    user_code: Option<String>,
    verification_uri: Option<String>,
    expires_in_seconds: Option<u64>,
) -> OAuthSessionView {
    OAuthSessionView {
        session_id: uuid::Uuid::new_v4().to_string(),
        platform,
        flow: flow.to_string(),
        status: "pending".to_string(),
        auth_url,
        user_code,
        verification_uri,
        expires_in_seconds,
        error: None,
        account: None,
    }
}
