use crate::{
    auth::AuthManager,
    config::WebServerConfig,
    proxy::proxy_to_local_core,
    upload::stage_multipart_upload,
};
use axum::{
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path as AxumPath, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{any, get, post},
    Json, Router,
};
use ecpa_core::{
    AppHandle as CoreAppHandle, HostPlatform, OpenUrlOutcome, RuntimeCapabilities,
};
use futures_util::stream::Stream;
use hyper_util::rt::TokioIo;
use rust_embed::RustEmbed;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    fs::{self, File},
    io::BufReader,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

#[derive(RustEmbed)]
#[folder = "$ECPA_WEB_DIST_DIR"]
struct EmbeddedDist;

pub struct WebHostPlatform {
    data_dir: PathBuf,
    data_dir_string: String,
    active_sse_clients: Arc<AtomicUsize>,
    shutdown: CancellationToken,
}

impl WebHostPlatform {
    pub fn new(
        data_dir: PathBuf,
        active_sse_clients: Arc<AtomicUsize>,
        shutdown: CancellationToken,
    ) -> Self {
        let data_dir_string = ecpa_core::path_to_string(&data_dir);
        Self {
            data_dir,
            data_dir_string,
            active_sse_clients,
            shutdown,
        }
    }
}

impl HostPlatform for WebHostPlatform {
    fn capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities::webui(self.data_dir_string.clone())
    }

    fn exit(&self, _code: i32) {
        self.shutdown.cancel();
    }

    fn request_restart(&self) {
        self.shutdown.cancel();
    }

    fn app_data_dir(&self) -> Result<PathBuf, String> {
        let dir = self.data_dir.join("app-data");
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        Ok(dir)
    }

    fn is_ui_active(&self) -> bool {
        self.active_sse_clients.load(Ordering::Acquire) > 0
    }

    fn open_url(&self, _url: &str, _program: Option<&str>) -> Result<OpenUrlOutcome, String> {
        Ok(OpenUrlOutcome::ClientOpenRequired)
    }

    fn open_path(&self, _path: &Path) -> Result<(), String> {
        Err("Opening server folders in a desktop file manager is unavailable in headless WebUI mode".to_string())
    }
}

#[derive(Clone)]
pub struct AppState {
    pub core_app: CoreAppHandle,
    pub auth: Arc<AuthManager>,
    pub data_dir: PathBuf,
    pub static_dir: Option<PathBuf>,
    pub active_sse_clients: Arc<AtomicUsize>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/auth/status", get(handle_auth_status))
        .route("/api/auth/login", post(handle_auth_login))
        .route("/api/auth/logout", post(handle_auth_logout))
        .route("/api/auth/password", post(handle_auth_password))
        .route("/api/rpc/{command}", post(handle_rpc))
        .route("/api/events", get(handle_events))
        .route(
            "/api/upload/temp",
            post(handle_upload_temp)
                .layer(DefaultBodyLimit::max(crate::upload::MAX_UPLOAD_BYTES + 1024 * 1024)),
        )
        .route("/v0/resource/plugins", any(handle_plugin_proxy))
        .route("/v0/resource/plugins/{*rest}", any(handle_plugin_proxy))
        .route("/v0/management/{*rest}", any(handle_management_proxy))
        .route("/v8/management/{*rest}", any(handle_management_proxy))
        .fallback(get(handle_static_asset))
        .with_state(state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusResponse {
    auth_required: bool,
    authenticated: bool,
    mode: &'static str,
    version: &'static str,
}

async fn handle_auth_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Json<AuthStatusResponse> {
    Json(AuthStatusResponse {
        auth_required: state.auth.auth_required(),
        authenticated: state.auth.is_authenticated(&headers),
        mode: "webui",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest {
    password: String,
}

async fn handle_auth_login(
    State(state): State<AppState>,
    extensions: axum::http::Extensions,
    headers: HeaderMap,
    Json(body): Json<LoginRequest>,
) -> Response {
    if let Err(reason) = state.auth.check_csrf(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": reason })),
        )
            .into_response();
    }

    let peer_ip = extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let client_key = state.auth.client_key(peer_ip, &headers);
    if let Err(retry_after) = state.auth.check_rate_limit(&client_key) {
        let mut resp = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "ok": false,
                "error": format!("Too many failed login attempts. Try again in {retry_after} seconds.")
            })),
        )
            .into_response();
        if let Ok(val) = HeaderValue::from_str(&retry_after.to_string()) {
            resp.headers_mut().insert(header::RETRY_AFTER, val);
        }
        return resp;
    }

    match state.auth.verify_login(&body.password) {
        Ok(token) => {
            state.auth.clear_login_failures(&client_key);
            let cookie = state.auth.build_session_cookie(&token, &headers);
            let mut resp = (StatusCode::OK, Json(json!({ "ok": true }))).into_response();
            if let Ok(cookie_val) = HeaderValue::from_str(&cookie) {
                resp.headers_mut().insert(header::SET_COOKIE, cookie_val);
            }
            resp
        }
        Err(reason) => {
            state.auth.record_login_failure(&client_key);
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "ok": false, "error": reason })),
            )
                .into_response()
        }
    }
}

async fn handle_auth_logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(reason) = state.auth.check_csrf(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": reason })),
        )
            .into_response();
    }
    let cookie = state.auth.build_logout_cookie(&headers);
    let mut resp = (StatusCode::OK, Json(json!({ "ok": true }))).into_response();
    if let Ok(cookie_val) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, cookie_val);
    }
    resp
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

async fn handle_auth_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ChangePasswordRequest>,
) -> Response {
    if !state.auth.is_authenticated(&headers) {
        return unauthorized_response();
    }
    if let Err(reason) = state.auth.check_csrf(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": reason })),
        )
            .into_response();
    }

    match state
        .auth
        .change_password(&body.current_password, &body.new_password)
    {
        Ok(new_token) => {
            let cookie = state.auth.build_session_cookie(&new_token, &headers);
            let mut resp = (StatusCode::OK, Json(json!({ "ok": true }))).into_response();
            if let Ok(cookie_val) = HeaderValue::from_str(&cookie) {
                resp.headers_mut().insert(header::SET_COOKIE, cookie_val);
            }
            resp
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

async fn handle_rpc(
    State(state): State<AppState>,
    AxumPath(command): AxumPath<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if !state.auth.is_authenticated(&headers) {
        return unauthorized_response();
    }
    if let Err(reason) = state.auth.check_csrf(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": reason })),
        )
            .into_response();
    }

    let payload: Value = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "ok": false, "error": format!("Invalid JSON payload: {error}") })),
                )
                    .into_response();
            }
        }
    };

    match ecpa_core::rpc::dispatch(state.core_app.clone(), &command, payload).await {
        Ok(data) => (StatusCode::OK, Json(json!({ "ok": true, "data": data }))).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

struct SseClientGuard {
    counter: Arc<AtomicUsize>,
}

impl SseClientGuard {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self { counter }
    }
}

impl Drop for SseClientGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

async fn handle_events(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if !state.auth.is_authenticated(&headers) {
        return unauthorized_response();
    }

    let rx = state.core_app.subscribe_events();
    let guard = SseClientGuard::new(Arc::clone(&state.active_sse_clients));
    let stream = async_stream_events(rx_to_stream(rx), guard);

    let sse = Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(20))
            .text("keepalive"),
    );

    let mut resp = sse.into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    resp.headers_mut().insert(
        header::HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    resp
}

fn rx_to_stream(
    rx: tokio::sync::broadcast::Receiver<ecpa_core::AppEvent>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(app_event) => {
                    let payload = serde_json::to_string(&app_event).unwrap_or_default();
                    let event = Event::default().event("ecpa").data(payload);
                    return Some((Ok(event), rx));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
}

fn async_stream_events<S>(
    inner: S,
    guard: SseClientGuard,
) -> impl Stream<Item = Result<Event, Infallible>>
where
    S: Stream<Item = Result<Event, Infallible>> + Send + 'static,
{
    let initial = futures_util::stream::once(async move {
        Ok(Event::default().comment("connected"))
    });
    futures_util::stream::StreamExt::chain(
        initial,
        futures_util::stream::unfold((Box::pin(inner), guard), |(mut stream, guard)| async move {
            use futures_util::StreamExt as _;
            stream.next().await.map(|item| (item, (stream, guard)))
        }),
    )
}

async fn handle_upload_temp(
    State(state): State<AppState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Response {
    if !state.auth.is_authenticated(&headers) {
        return unauthorized_response();
    }
    if let Err(reason) = state.auth.check_csrf(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": reason })),
        )
            .into_response();
    }

    match stage_multipart_upload(&state.data_dir, multipart).await {
        Ok(staged) => (StatusCode::OK, Json(json!({ "ok": true, "data": staged }))).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

async fn handle_plugin_proxy(
    State(state): State<AppState>,
    req: Request,
) -> Response {
    if !state.auth.is_authenticated(req.headers()) {
        return unauthorized_response();
    }
    proxy_to_local_core(&state.core_app, req, true).await
}

async fn handle_management_proxy(
    State(state): State<AppState>,
    req: Request,
) -> Response {
    if !state.auth.is_authenticated(req.headers()) {
        return unauthorized_response();
    }
    proxy_to_local_core(&state.core_app, req, false).await
}

async fn handle_static_asset(
    State(state): State<AppState>,
    req: Request,
) -> Response {
    let raw_path = req.uri().path();
    if raw_path.starts_with("/api/")
        || raw_path == "/api"
        || raw_path.starts_with("/v0/")
        || raw_path.starts_with("/v8/")
    {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }

    let trimmed = raw_path.trim_start_matches('/');
    let rel_path = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };

    if let Some(static_dir) = state.static_dir.as_deref() {
        return serve_from_disk(static_dir, rel_path);
    }

    if let Some(file) = EmbeddedDist::get(rel_path) {
        return build_asset_response(rel_path, file.data.into_owned());
    }

    // SPA client-side routing fallback (only for paths without a file extension)
    if !rel_path.contains('.') {
        if let Some(index) = EmbeddedDist::get("index.html") {
            return build_asset_response("index.html", index.data.into_owned());
        }
    }

    (
        StatusCode::NOT_FOUND,
        "Frontend assets not found. Build the frontend (`bun run build`) or pass `--static-dir <path>`.",
    )
        .into_response()
}

fn serve_from_disk(root: &Path, rel_path: &str) -> Response {
    let safe_join = |candidate: &str| -> Option<PathBuf> {
        let mut out = root.to_path_buf();
        for component in Path::new(candidate).components() {
            match component {
                std::path::Component::Normal(part) => out.push(part),
                _ => return None,
            }
        }
        Some(out)
    };

    if let Some(path) = safe_join(rel_path) {
        if path.is_file() {
            if let Ok(bytes) = fs::read(&path) {
                return build_asset_response(rel_path, bytes);
            }
        }
    }
    if !rel_path.contains('.') {
        let index = root.join("index.html");
        if index.is_file() {
            if let Ok(bytes) = fs::read(&index) {
                return build_asset_response("index.html", bytes);
            }
        }
    }
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

fn build_asset_response(path: &str, bytes: Vec<u8>) -> Response {
    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let cache_control = if path == "index.html" {
        "no-cache"
    } else if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    };
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache_control)
        .header(header::HeaderName::from_static("x-content-type-options"), "nosniff")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    if path == "index.html" {
        resp.headers_mut().insert(
            header::HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("SAMEORIGIN"),
        );
    }
    resp
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "ok": false, "error": "Authentication required" })),
    )
        .into_response()
}

pub fn load_tls_acceptor(cert_path: &Path, key_path: &Path) -> Result<TlsAcceptor, String> {
    let cert_file = File::open(cert_path).map_err(|error| {
        format!(
            "Failed to open TLS certificate '{}': {error}",
            cert_path.display()
        )
    })?;
    let mut cert_reader = BufReader::new(cert_file);
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Failed to parse TLS certificate PEM '{}': {error}",
                cert_path.display()
            )
        })?;
    if certs.is_empty() {
        return Err(format!(
            "TLS certificate file '{}' contains no certificates",
            cert_path.display()
        ));
    }

    let key_file = File::open(key_path).map_err(|error| {
        format!(
            "Failed to open TLS private key '{}': {error}",
            key_path.display()
        )
    })?;
    let mut key_reader = BufReader::new(key_file);
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)
        .map_err(|error| {
            format!(
                "Failed to parse TLS private key PEM '{}': {error}",
                key_path.display()
            )
        })?
        .ok_or_else(|| {
            format!(
                "TLS private key file '{}' contains no private key",
                key_path.display()
            )
        })?;

    let _ = rustls::crypto::ring::default_provider().install_default();
    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|error| format!("Invalid TLS certificate/key pair: {error}"))?;
    Ok(TlsAcceptor::from(Arc::new(server_config)))
}

pub async fn serve(
    config: &WebServerConfig,
    router: Router,
    shutdown: CancellationToken,
) -> Result<(), String> {
    let addr = config.socket_addr()?;
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|error| format!("Failed to bind {addr}: {error}"))?;

    if let (Some(cert_path), Some(key_path)) =
        (config.tls_cert.as_deref(), config.tls_key.as_deref())
    {
        let acceptor = load_tls_acceptor(cert_path, key_path)?;
        serve_tls(listener, acceptor, router, shutdown).await
    } else {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            shutdown.cancelled().await;
        })
        .await
        .map_err(|error| format!("WebUI HTTP server error: {error}"))
    }
}

async fn serve_tls(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    router: Router,
    shutdown: CancellationToken,
) -> Result<(), String> {
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                break;
            }
            accepted = listener.accept() => {
                let (tcp_stream, peer_addr) = match accepted {
                    Ok(conn) => conn,
                    Err(error) => {
                        eprintln!("TLS accept error: {error}");
                        continue;
                    }
                };
                let acceptor = acceptor.clone();
                let router = router.clone();
                tokio::spawn(async move {
                    let tls_stream = match acceptor.accept(tcp_stream).await {
                        Ok(stream) => stream,
                        Err(_) => return,
                    };
                    let io = TokioIo::new(tls_stream);
                    let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                        let router = router.clone();
                        async move {
                            let mut axum_req = req.map(Body::new);
                            axum_req.extensions_mut().insert(ConnectInfo(peer_addr));
                            router.oneshot(axum_req).await
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, service)
                        .await;
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{WebUiFileConfig, DEFAULT_SESSION_TTL_HOURS, DEFAULT_WEB_HOST, DEFAULT_WEB_PORT};
    use axum::http::Method;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_state(no_auth: bool) -> (AppState, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "ecpa-web-server-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let cfg = WebServerConfig {
            host: DEFAULT_WEB_HOST.to_string(),
            port: DEFAULT_WEB_PORT,
            data_dir: dir.clone(),
            password_override: Some("test-pass-1234".to_string()),
            no_auth,
            trust_proxy: false,
            tls_cert: None,
            tls_key: None,
            static_dir: None,
            session_ttl_hours: DEFAULT_SESSION_TTL_HOURS,
            file_config: WebUiFileConfig::default(),
        };
        let bootstrap = AuthManager::initialize(&cfg).unwrap();
        let sse_counter = Arc::new(AtomicUsize::new(0));
        let host = Arc::new(WebHostPlatform::new(
            dir.clone(),
            Arc::clone(&sse_counter),
            CancellationToken::new(),
        ));
        let core_app = CoreAppHandle::new(host);
        let state = AppState {
            core_app,
            auth: Arc::new(bootstrap.auth),
            data_dir: dir.clone(),
            static_dir: None,
            active_sse_clients: sse_counter,
        };
        (state, dir)
    }

    #[tokio::test]
    async fn auth_login_rpc_and_csrf_flow_end_to_end() {
        let (state, dir) = test_state(false);
        let router = build_router(state);

        // Unauthenticated RPC is rejected with 401
        let unauth = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/rpc/health_check")
                    .header("x-ecpa-client", "webui")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

        // Login succeeds and issues HttpOnly SameSite=Strict cookie
        let login = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/auth/login")
                    .header("x-ecpa-client", "webui")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"password":"test-pass-1234"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        let set_cookie = login
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Strict"));
        let cookie_pair = set_cookie.split(';').next().unwrap().to_string();

        // Missing X-ECPA-Client header is rejected with 403
        let missing_csrf = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/rpc/health_check")
                    .header(header::COOKIE, &cookie_pair)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_csrf.status(), StatusCode::FORBIDDEN);

        // Authenticated RPC with valid CSRF header succeeds
        let ok = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/rpc/get_runtime_capabilities")
                    .header(header::COOKIE, &cookie_pair)
                    .header("x-ecpa-client", "webui")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(ok.into_body(), 1024 * 64).await.unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["data"]["mode"], "webui");
        assert_eq!(json["data"]["supportsNativeDialog"], false);

        let _ = fs::remove_dir_all(&dir);
    }
}
