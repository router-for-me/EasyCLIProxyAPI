use super::*;
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use tokio_util::sync::CancellationToken;

const PROVIDER: &str = "ecpa-antigravity-acp";
const MAX_BODY: usize = 1024 * 1024;
type Body = http_body_util::combinators::UnsyncBoxBody<Bytes, Infallible>;
type SpawnClient = fn(&Path, &Path, &str) -> Result<rpc::Client, String>;

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    enabled: bool,
    port: u16,
}

pub(super) struct Runtime {
    stop: CancellationToken,
    url: String,
    key: String,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn settings_path(profile: &Path) -> PathBuf {
    profile.join("bridge.json")
}

fn read_settings(profile: &Path) -> Result<Settings, String> {
    match std::fs::read(settings_path(profile)) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("Invalid ACP bridge settings: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(format!("Failed to read ACP bridge settings: {e}")),
    }
}

fn save_settings(profile: &Path, settings: &Settings) -> Result<(), String> {
    prepare_profile(profile)?;
    crate::write_codex_private_file(
        &settings_path(profile),
        &serde_json::to_vec(settings).map_err(|e| e.to_string())?,
    )
}

fn bridge_key(profile: &Path) -> Result<String, String> {
    let path = profile.join("bridge-key.txt");
    match std::fs::read_to_string(&path) {
        Ok(key) if key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()) => Ok(key),
        Ok(_) => Err("Invalid ACP internal bridge key".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut bytes = [0_u8; 32];
            getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
            let key = bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            crate::write_codex_private_file(&path, key.as_bytes())?;
            Ok(key)
        }
        Err(e) => Err(format!("Failed to read ACP internal bridge key: {e}")),
    }
}

fn provider_entry(
    url: &str,
    key: &str,
    models: &[AcpModel],
    v8: bool,
) -> Result<serde_norway::Value, String> {
    let mut provider = json!({
        "name": PROVIDER, "base-url": url, "proxy-url": "direct", "disabled": models.is_empty(),
        "models": models.iter().map(|model| json!({"name":model.id,"alias":format!("acp/{}", model.id)})).collect::<Vec<_>>()
    });
    provider[if v8 { "keys" } else { "api-key-entries" }] = json!([{"api-key":key}]);
    serde_norway::to_value(provider).map_err(|e| e.to_string())
}

fn patch_provider(
    document: &mut serde_norway::Value,
    entry: Option<serde_norway::Value>,
) -> Result<bool, String> {
    let path: &[&str] = if crate::core_config_uses_v8(document) {
        &["api-keys", "openai-compatibility"]
    } else {
        &["openai-compatibility"]
    };
    let mut current = document.clone();
    for key in path {
        current = current
            .get(*key)
            .cloned()
            .unwrap_or(serde_norway::Value::Null);
    }
    let mut providers = match current {
        serde_norway::Value::Null => Vec::new(),
        serde_norway::Value::Sequence(providers) => providers,
        _ => return Err("OpenAI-compatible provider configuration must be a list".into()),
    };
    let previous_len = providers.len();
    providers.retain(|provider| {
        provider.get("name").and_then(serde_norway::Value::as_str) != Some(PROVIDER)
    });
    if let Some(entry) = entry {
        providers.push(entry);
    } else if providers.len() == previous_len {
        return Ok(false);
    }
    crate::set_core_yaml_path_value(document, path, serde_norway::Value::Sequence(providers))
}

fn register(url: Option<&str>, key: &str, models: &[AcpModel]) -> Result<(), String> {
    if !crate::core_install_dir()?
        .join(crate::CORE_CONFIG_FILE)
        .is_file()
    {
        return Err("Start the CPA kernel once to generate its configuration before enabling ACP API access".into());
    }
    crate::patch_existing_core_config(|document| {
        let entry = url
            .map(|url| provider_entry(url, key, models, crate::core_config_uses_v8(document)))
            .transpose()?;
        patch_provider(document, entry)
    })
}

pub(crate) async fn set_acp_upstream_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<AcpStatus, String> {
    let state = app.state::<AcpState>();
    let _transition = state.bridge_transition.lock().await;
    let _guard = begin(&app, "upstream")?;
    let profile = profile(&crate::core_base_dir()?);
    let settings = read_settings(&profile)?;
    if !enabled {
        register(None, "", &[])?;
        // Keep the listener alive if saving fails, so an already enabled runtime
        // cannot become an orphaned provider with a closed upstream.
        save_settings(
            &profile,
            &Settings {
                enabled: false,
                port: settings.port,
            },
        )?;
        state
            .bridge
            .lock()
            .map_err(|_| "ACP bridge state unavailable")?
            .take();
        let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
        status.upstream_enabled = false;
        status.upstream_url = None;
    } else {
        let status = state.snapshot()?;
        if !status.authenticated || status.models.is_empty() {
            return Err("Connect ACP and load available models first".into());
        }
        let existing = state
            .bridge
            .lock()
            .map_err(|_| "ACP bridge state unavailable")?
            .as_ref()
            .map(|runtime| (runtime.url.clone(), runtime.key.clone()));
        if let Some((url, key)) = existing {
            register(Some(&url), &key, &status.models)?;
        } else {
            prepare_profile(&profile)?;
            let listener =
                match tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, settings.port))
                    .await
                {
                    Ok(listener) => listener,
                    Err(_) if settings.port != 0 => tokio::net::TcpListener::bind("127.0.0.1:0")
                        .await
                        .map_err(|e| e.to_string())?,
                    Err(e) => return Err(format!("Failed to start ACP bridge: {e}")),
                };
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let url = format!("http://127.0.0.1:{port}/v1");
            let key = bridge_key(&profile)?;
            let stop = CancellationToken::new();
            let runtime = Runtime {
                stop: stop.clone(),
                url: url.clone(),
                key: key.clone(),
            };
            // Publish only after the socket is bound, and roll back registration
            // if durable enablement cannot be saved.
            register(Some(&url), &key, &status.models)?;
            if let Err(error) = save_settings(
                &profile,
                &Settings {
                    enabled: true,
                    port,
                },
            ) {
                let rollback = register(None, "", &[]).err();
                return Err(format!(
                    "{error}{}",
                    rollback
                        .map(|e| format!("; rollback failed: {e}"))
                        .unwrap_or_default()
                ));
            }
            *state
                .bridge
                .lock()
                .map_err(|_| "ACP bridge state unavailable")? = Some(runtime);
            {
                let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
                status.upstream_enabled = true;
                status.upstream_url = Some(url);
            }
            let app = app.clone();
            tauri::async_runtime::spawn(serve(app, listener, key, stop, rpc::Client::spawn));
        }
    }
    drop(_guard);
    let _ = tauri::Emitter::emit(&app, crate::CONFIG_FILES_CHANGED_EVENT, ());
    get_acp_status(app.clone(), app.state::<AcpState>())
}

pub(crate) async fn restore(app: tauri::AppHandle) {
    let result: Result<(), String> = async {
        let profile = profile(&crate::core_base_dir()?);
        if read_settings(&profile)?.enabled {
            if let Err(error) = super::acp_connect(app.clone(), false).await {
                register(None, "", &[])?;
                return Err(error);
            }
            set_acp_upstream_enabled(app.clone(), true).await?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        if let Ok(mut status) = app.state::<AcpState>().status.lock() {
            status.error = Some(error);
        }
    }
}

pub(super) fn sync_models(state: &AcpState) -> Result<(), String> {
    let status = state.snapshot()?;
    let runtime = state
        .bridge
        .lock()
        .map_err(|_| "ACP bridge state unavailable")?;
    if let Some(runtime) = runtime.as_ref() {
        register(Some(&runtime.url), &runtime.key, &status.models)?;
    }
    Ok(())
}

async fn serve<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    listener: tokio::net::TcpListener,
    key: String,
    stop: CancellationToken,
    spawn: SpawnClient,
) {
    loop {
        let accepted = tokio::select! {
            _ = stop.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((socket, _)) = accepted else { break };
        let app = app.clone();
        let key = key.clone();
        let stop = stop.clone();
        tauri::async_runtime::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                handle(app.clone(), request, key.clone(), spawn)
            });
            tokio::select! {
                _ = stop.cancelled() => {},
                _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(socket), service) => {},
            }
        });
    }
}

fn response(status: StatusCode, value: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(value.to_string())).boxed_unsync())
        .unwrap()
}
fn error(status: StatusCode, message: impl AsRef<str>) -> Response<Body> {
    response(
        status,
        json!({"error":{"message":message.as_ref(),"type":"invalid_request_error"}}),
    )
}

struct Completion {
    model: String,
    text: String,
    stream: bool,
}

fn parse_completion(value: &Value, models: &[AcpModel]) -> Result<Completion, String> {
    let object = value.as_object().ok_or("Request body must be an object")?;
    // Do not silently claim support for API controls the Agent does not expose.
    for key in object.keys() {
        if !["model", "messages", "stream", "stream_options"].contains(&key.as_str()) {
            return Err(format!(
                "ACP text access does not support parameter '{key}'"
            ));
        }
    }
    let requested = value["model"].as_str().ok_or("model is required")?;
    let model = requested.strip_prefix("acp/").unwrap_or(requested);
    if !models.iter().any(|item| item.id == model) {
        return Err("Unknown ACP model; refresh available models".into());
    }
    let messages = value["messages"]
        .as_array()
        .ok_or("messages must be an array")?;
    if messages.len() != 1 || messages[0]["role"] != "user" {
        return Err("ACP currently accepts one user text message per request; history and system/tool messages are not supported".into());
    }
    let message = messages[0].as_object().ok_or("Invalid user message")?;
    if message
        .keys()
        .any(|key| !["role", "content"].contains(&key.as_str()))
    {
        return Err("Unsupported ACP message fields".into());
    }
    let text = match &messages[0]["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => {
            let mut text = String::new();
            for part in parts {
                if part["type"] != "text" {
                    return Err("ACP accepts text content only".into());
                }
                text.push_str(part["text"].as_str().ok_or("Invalid text content")?);
            }
            text
        }
        _ => return Err("ACP accepts text content only".into()),
    };
    if text.trim().is_empty() {
        return Err("A non-empty user message is required".into());
    }
    let stream = match value.get("stream") {
        None => false,
        Some(Value::Bool(stream)) => *stream,
        _ => return Err("stream must be a boolean".into()),
    };
    if let Some(options) = value.get("stream_options") {
        if !options.is_null()
            && (!options.is_object()
                || options
                    .as_object()
                    .unwrap()
                    .keys()
                    .any(|key| key != "include_usage")
                || options
                    .get("include_usage")
                    .is_some_and(|value| !value.is_boolean()))
        {
            return Err("Unsupported stream_options".into());
        }
    }
    Ok(Completion {
        model: model.into(),
        text,
        stream,
    })
}

fn complete<F: FnMut(&str)>(
    client: &mut rpc::Client,
    profile: &Path,
    request: &Completion,
    cancel: &Arc<AtomicBool>,
    mut chunk: F,
) -> Result<String, String> {
    client.initialize(cancel)?;
    let session = client.session(profile, cancel)?;
    client.model(&session, &request.model, cancel)?;
    let mut text = String::new();
    let mut oversized = false;
    let result = client.call(
        "session/prompt",
        json!({"sessionId":session["sessionId"],"prompt":[{"type":"text","text":request.text}]}),
        cancel,
        |update| {
            if update["sessionUpdate"] == "agent_message_chunk"
                && update["content"]["type"] == "text"
            {
                if let Some(part) = update["content"]["text"].as_str() {
                    if text.len().saturating_add(part.len()) > MAX_BODY {
                        oversized = true;
                        cancel.store(true, Ordering::Release);
                        return;
                    }
                    text.push_str(part);
                    chunk(part);
                }
            }
        },
    );
    if oversized {
        return Err("ACP response exceeds 1 MiB".into());
    }
    let result = result?;
    if result["stopReason"] != "end_turn" {
        return Err(format!(
            "ACP turn did not complete: {}",
            result["stopReason"]
        ));
    }
    Ok(text)
}

async fn handle<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: Request<Incoming>,
    key: String,
    spawn: SpawnClient,
) -> Result<Response<Body>, Infallible> {
    Ok(handle_inner(app, request, key, spawn).await)
}

async fn handle_inner<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: Request<Incoming>,
    key: String,
    spawn: SpawnClient,
) -> Response<Body> {
    if request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some(format!("Bearer {key}").as_str())
    {
        return error(StatusCode::UNAUTHORIZED, "Invalid ACP bridge key");
    }
    let state = app.state::<AcpState>();
    let status = match state.snapshot() {
        Ok(status) => status,
        Err(e) => return error(StatusCode::SERVICE_UNAVAILABLE, e),
    };
    match (request.method().as_str(), request.uri().path()) {
        ("GET", "/v1/models") => {
            return response(
                StatusCode::OK,
                json!({"object":"list","data":status.models.iter().map(|model| json!({"id":format!("acp/{}", model.id),"object":"model","created":0,"owned_by":PROVIDER})).collect::<Vec<_>>()}),
            )
        }
        ("POST", "/v1/chat/completions") => {}
        _ => {
            return error(
                StatusCode::NOT_FOUND,
                "ACP supports /v1/models and /v1/chat/completions only",
            )
        }
    }
    if !status.upstream_enabled || !status.authenticated {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ACP API access is not connected",
        );
    }
    let bytes = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Limited::new(request.into_body(), MAX_BODY).collect(),
    )
    .await
    {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(_)) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "ACP request exceeds 1 MiB or could not be read",
            )
        }
        Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "ACP request body timed out"),
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid JSON request"),
    };
    let guard = match begin(&app, "request") {
        Ok(guard) => guard,
        Err(e) => return error(StatusCode::TOO_MANY_REQUESTS, e),
    };
    // Capture the account after reserving the operation slot. A switch could
    // have completed while the request body was being read.
    let status = match state.snapshot() {
        Ok(status) if status.authenticated && status.upstream_enabled => status,
        _ => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "ACP API access is not connected",
            )
        }
    };
    let request = match parse_completion(&value, &status.models) {
        Ok(request) => request,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    let executable = match status.executable {
        Some(path) => PathBuf::from(path),
        None => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Official Antigravity CLI not found",
            )
        }
    };
    let profile = PathBuf::from(&status.profile);
    if !profile.is_absolute() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ACP account profile is unavailable; check the connection",
        );
    }
    let proxy = match app.state::<crate::GuiConfigState>().snapshot() {
        Ok(config) => config.proxy_url,
        Err(e) => return error(StatusCode::SERVICE_UNAVAILABLE, e),
    };
    let cancel = CancelOnDrop(guard.cancel.clone());
    let stream = request.stream;
    let model = format!("acp/{}", request.model);
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let id = format!(
        "chatcmpl-acp-{created}-{}",
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = tokio::sync::mpsc::channel::<String>(64);
    let stream_id = id.clone();
    let stream_model = model.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let result = (|| {
            let mut client = spawn(&executable, &profile, &proxy)?;
            complete(&mut client, &profile, &request, &_guard.cancel, |part| {
                if stream {
                    let value = json!({"id":stream_id,"object":"chat.completion.chunk","created":created,"model":stream_model,"choices":[{"index":0,"delta":{"content":part},"finish_reason":null}]});
                    // Reserve two slots for the terminal error/finish and DONE;
                    // a stalled client must never block cancellation/cleanup.
                    if sender.capacity() <= 2
                        || sender.try_send(format!("data: {value}\n\n")).is_err()
                    {
                        _guard.cancel.store(true, Ordering::Release);
                    }
                }
            })
        })();
        if stream {
            let value = match &result {
                Ok(_) => {
                    json!({"id":stream_id,"object":"chat.completion.chunk","created":created,"model":stream_model,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
                }
                Err(error) => json!({"error":{"message":error,"type":"upstream_error"}}),
            };
            let _ = sender.try_send(format!("data: {value}\n\n"));
            let _ = sender.try_send("data: [DONE]\n\n".into());
        }
        result
    });
    if stream {
        let frames =
            futures_util::stream::unfold((receiver, cancel), |(mut receiver, cancel)| async move {
                receiver.recv().await.map(|data| {
                    (
                        Ok::<_, Infallible>(Frame::data(Bytes::from(data))),
                        (receiver, cancel),
                    )
                })
            });
        Response::builder()
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(StreamBody::new(frames).boxed_unsync())
            .unwrap()
    } else {
        let result = worker.await;
        drop(cancel);
        match result {
            Ok(Ok(text)) => response(
                StatusCode::OK,
                json!({"id":id,"object":"chat.completion","created":created,"model":model,"choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}]}),
            ),
            Ok(Err(e)) => error(
                if e.contains("timed out") {
                    StatusCode::GATEWAY_TIMEOUT
                } else {
                    StatusCode::BAD_GATEWAY
                },
                e,
            ),
            Err(_) => error(StatusCode::BAD_GATEWAY, "ACP worker exited unexpectedly"),
        }
    }
}

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[cfg(test)]
mod tests;
