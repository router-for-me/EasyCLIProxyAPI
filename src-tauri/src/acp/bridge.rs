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
pub(super) type SpawnClient = fn(&Path, &Path, &str) -> Result<rpc::Client, String>;

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
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

pub(super) fn upstream_enabled(profile: &Path) -> Result<bool, String> {
    Ok(read_settings(profile)?.enabled)
}

fn save_settings(profile: &Path, settings: &Settings) -> Result<(), String> {
    prepare_profile(profile)?;
    save_private_file(
        &settings_path(profile),
        &serde_json::to_vec(settings).map_err(|e| e.to_string())?,
    )
}

fn save_private_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    let result = crate::write_codex_private_file(&temporary, content).and_then(|_| {
        crate::replace_file_atomically(&temporary, path)
            .map_err(|error| format!("Failed to save ACP configuration: {error}"))
    });
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    } else {
        crate::remember_software_write(path, content);
    }
    result
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
        "name": PROVIDER, "base-url": url, "disabled": models.is_empty(),
        "models": models.iter().map(|model| json!({"name":format!("acp/{}", model.id)})).collect::<Vec<_>>()
    });
    provider[if v8 { "keys" } else { "api-key-entries" }] =
        json!([{"api-key":key,"proxy-url":"direct"}]);
    serde_norway::to_value(provider).map_err(|e| e.to_string())
}

fn patch_provider(
    document: &mut serde_norway::Value,
    entry: Option<serde_norway::Value>,
) -> Result<bool, String> {
    if entry.is_none() {
        let mut changed = false;
        for path in [
            &["openai-compatibility"][..],
            &["api-keys", "openai-compatibility"][..],
        ] {
            changed |= patch_provider_at(document, path, None)?;
        }
        return Ok(changed);
    }
    let path: &[&str] = if crate::core_config_uses_v8(document) {
        &["api-keys", "openai-compatibility"]
    } else {
        &["openai-compatibility"]
    };
    patch_provider_at(document, path, entry)
}

fn patch_provider_at(
    document: &mut serde_norway::Value,
    path: &[&str],
    entry: Option<serde_norway::Value>,
) -> Result<bool, String> {
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
    register_at(
        &crate::core_install_dir()?.join(crate::CORE_CONFIG_FILE),
        url,
        key,
        models,
    )
}

fn register_at(
    config: &Path,
    url: Option<&str>,
    key: &str,
    models: &[AcpModel],
) -> Result<(), String> {
    let _guard = crate::lock_core_config_file()?;
    let content = match std::fs::read_to_string(config) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && url.is_none() => {
            return Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("Start the CPA kernel once to generate its configuration before enabling ACP API access".into());
        }
        Err(error) => {
            return Err(format!(
                "Failed to read ACP provider configuration: {error}"
            ))
        }
    };
    let updated = crate::patch_core_yaml_document(&content, |document| {
        let entry = url
            .map(|url| provider_entry(url, key, models, crate::core_config_uses_v8(document)))
            .transpose()?;
        patch_provider(document, entry)
    })?;
    if let Some(updated) = updated {
        save_private_file(config, updated.as_bytes())?;
    }
    Ok(())
}

pub(crate) async fn set_acp_upstream_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<AcpStatus, String> {
    let profile = profile(&crate::core_base_dir()?);
    let config = crate::core_install_dir()?.join(crate::CORE_CONFIG_FILE);
    set_enabled(&app, &profile, &config, enabled, false).await?;
    get_acp_status(app.clone(), app.state::<AcpState>())
}

async fn set_enabled<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    profile: &Path,
    config: &Path,
    enabled: bool,
    restoring: bool,
) -> Result<AcpStatus, String> {
    let state = app.state::<AcpState>();
    let _transition = state.bridge_transition.lock().await;
    let _guard = begin(app, "upstream")?;
    let settings = read_settings(profile)?;
    if restoring && !settings.enabled {
        drop(_guard);
        return state.snapshot();
    }
    if !enabled {
        let mut runtime = state
            .bridge
            .lock()
            .map_err(|_| "ACP bridge state unavailable")?;
        let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
        if settings.enabled || !settings_path(profile).is_file() {
            save_settings(
                profile,
                &Settings {
                    enabled: false,
                    port: settings.port,
                },
            )?;
        }
        status.upstream_enabled = false;
        status.upstream_url = None;
        runtime.take();
        state.agents.clear();
        drop(status);
        drop(runtime);
        register_at(config, None, "", &[]).map_err(|error| {
            format!("ACP API access is off, but provider cleanup failed: {error}")
        })?;
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
            register_at(config, Some(&url), &key, &status.models)?;
        } else {
            prepare_profile(profile)?;
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
            let key = bridge_key(profile)?;
            let stop = CancellationToken::new();
            let runtime = Runtime {
                stop: stop.clone(),
                url: url.clone(),
                key: key.clone(),
            };
            register_at(config, Some(&url), &key, &status.models)?;
            if let Err(error) = save_settings(
                profile,
                &Settings {
                    enabled: true,
                    port,
                },
            ) {
                let rollback = register_at(config, None, "", &[]).err();
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
    let _ = tauri::Emitter::emit(app, crate::CONFIG_FILES_CHANGED_EVENT, ());
    state.snapshot()
}

pub(crate) async fn restore(app: tauri::AppHandle) {
    let result: Result<(), String> = async {
        let profile = profile(&crate::core_base_dir()?);
        restore_if_enabled(&profile, || async {
            if let Err(error) = super::acp_connect(app.clone(), false).await {
                register(None, "", &[])?;
                return Err(error);
            }
            let config = crate::core_install_dir()?.join(crate::CORE_CONFIG_FILE);
            set_enabled(&app, &profile, &config, true, true).await?;
            Ok(())
        })
        .await
    }
    .await;
    if let Err(error) = result {
        if let Ok(mut status) = app.state::<AcpState>().status.lock() {
            status.error = Some(error);
        }
    }
}

async fn restore_if_enabled<F: std::future::Future<Output = Result<(), String>>>(
    profile: &Path,
    restore: impl FnOnce() -> F,
) -> Result<(), String> {
    if read_settings(profile)?.enabled {
        restore().await?;
    }
    Ok(())
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

pub(super) struct Completion {
    pub model: String,
    pub alias: String,
    pub text: String,
    pub system: String,
    pub stream: bool,
    pub ignored_parameters: Vec<&'static str>,
    pub tools: Vec<Value>,
    pub messages: Vec<Value>,
    pub results: Vec<Value>,
}

pub(super) struct Output {
    pub text: String,
    pub calls: Vec<Value>,
}
impl Output {
    pub fn finish(&self) -> &'static str {
        if self.calls.is_empty() {
            "stop"
        } else {
            "tool_calls"
        }
    }
    pub fn message(&self) -> Value {
        let mut message = json!({"role":"assistant","content":if self.text.is_empty() && !self.calls.is_empty() { Value::Null } else { json!(self.text) }});
        if !self.calls.is_empty() {
            message["tool_calls"] = json!(self.calls);
        }
        message
    }
}

// CPA owns the public protocol translators. This upstream must still produce
// valid Chat Completions chunks, including the initial assistant role.
struct CompletionStream {
    sender: tokio::sync::mpsc::Sender<Result<String, String>>,
    cancel: Arc<AtomicBool>,
    id: String,
    model: String,
    created: u64,
    started: bool,
}

impl CompletionStream {
    fn send(&self, mut frame: Result<String, String>) -> Result<(), String> {
        loop {
            if self.cancel.load(Ordering::Acquire) {
                return Err("ACP API client disconnected or request cancelled".into());
            }
            match self.sender.try_send(frame) {
                Ok(()) => return Ok(()),
                Err(tokio::sync::mpsc::error::TrySendError::Full(pending)) => {
                    frame = pending;
                    // Apply backpressure without blocking cancellation or
                    // treating an ordinary burst of tokens as a disconnect.
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    self.cancel.store(true, Ordering::Release);
                    return Err("ACP API client disconnected".into());
                }
            }
        }
    }

    fn chunk(&self, delta: Value, finish: Option<&str>) -> Result<(), String> {
        let value = json!({
            "id":self.id,"object":"chat.completion.chunk","created":self.created,"model":self.model,
            "choices":[{"index":0,"delta":delta,"finish_reason":finish,"logprobs":null}]
        });
        self.send(Ok(format!("data: {value}\n\n")))
    }

    fn delta(&mut self, delta: Value) -> Result<(), String> {
        if !self.started {
            self.chunk(json!({"role":"assistant","content":""}), None)?;
            self.started = true;
        }
        self.chunk(delta, None)
    }

    fn finish(&mut self, output: &Output) -> Result<(), String> {
        if !self.started {
            self.delta(json!({"content":""}))?;
        }
        self.chunk(json!({}), Some(output.finish()))?;
        self.send(Ok("data: [DONE]\n\n".into()))
    }
}

fn upstream_status(message: &str) -> StatusCode {
    if message.contains("timed out") {
        StatusCode::GATEWAY_TIMEOUT
    } else {
        StatusCode::BAD_GATEWAY
    }
}

// ACP exposes no sampling or exact token-budget controls. Chat applications
// commonly send these even when using an agent-backed model. Validate the
// values and report that they are not applied instead of rejecting the chat.
fn compatibility_parameters(value: &Value) -> Result<Vec<&'static str>, String> {
    let mut ignored = Vec::new();
    for key in ["max_tokens", "max_completion_tokens"] {
        if let Some(limit) = value.get(key).filter(|v| !v.is_null()) {
            if !limit.as_u64().is_some_and(|n| n > 0) {
                return Err(format!("{key} must be a positive integer"));
            }
            ignored.push(key);
        }
    }
    for (key, maximum) in [("temperature", 2.0), ("top_p", 1.0)] {
        if let Some(option) = value.get(key).filter(|v| !v.is_null()) {
            if !option
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0 && n <= maximum)
            {
                return Err(format!("{key} must be a number between 0 and {maximum}"));
            }
            ignored.push(key);
        }
    }
    Ok(ignored)
}

fn compatibility_headers(mut response: Response<Body>, ignored: &[&str]) -> Response<Body> {
    if !ignored.is_empty() {
        response.headers_mut().insert(
            "x-ecpa-ignored-parameters",
            ignored
                .join(", ")
                .parse()
                .expect("static parameter names are valid HTTP header values"),
        );
    }
    response
}

pub(super) fn message_text(message: &Value, role: &str) -> Result<String, String> {
    let message = message
        .as_object()
        .ok_or_else(|| format!("Invalid {role} message"))?;
    if message.keys().any(|key| {
        ![
            "role",
            "content",
            "name",
            "tool_calls",
            "tool_call_id",
            "reasoning_content",
        ]
        .contains(&key.as_str())
    }) {
        return Err("Unsupported ACP message fields".into());
    }
    if message
        .get("name")
        .is_some_and(|name| !name.is_null() && !name.is_string())
    {
        return Err("Message name must be a string".into());
    }
    let text = match message.get("content").unwrap_or(&Value::Null) {
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
        Value::Null if role == "assistant" && message.get("tool_calls").is_some() => String::new(),
        _ => return Err("ACP accepts text content only".into()),
    };
    if text.trim().is_empty()
        && role != "tool"
        && !(role == "assistant" && message.get("tool_calls").is_some())
    {
        return Err(format!("A non-empty {role} message is required"));
    }
    Ok(text)
}

// The official CLI is stateless per request, so earlier turns are flattened
// into the single prompt text block instead of a server-side conversation.
fn prompt_text(messages: &[Value]) -> Result<String, String> {
    let mut turns = Vec::new();
    let mut pending = std::collections::BTreeSet::new();
    for message in messages {
        let role = message["role"].as_str().unwrap_or("");
        let label = match role {
            "system" | "developer" | "user" | "assistant" | "tool" => role,
            "" => return Err("Invalid message role".into()),
            role => {
                return Err(format!(
                    "ACP accepts system, developer, user and assistant messages only; role '{role}' is not supported"
                ))
            }
        };
        let mut text = message_text(message, label)?;
        if role == "tool" {
            let id = message["tool_call_id"]
                .as_str()
                .ok_or("role 'tool' requires tool_call_id")?;
            if !pending.remove(id) {
                return Err("role 'tool' references an unknown or duplicate tool_call_id".into());
            }
            text = json!({"tool_call_id":id,"output":text}).to_string();
        } else if !pending.is_empty() {
            return Err("Missing results for preceding tool calls".into());
        }
        if let Some(calls) = message.get("tool_calls") {
            if role != "assistant" {
                return Err("tool_calls requires assistant role".into());
            }
            let calls = calls
                .as_array()
                .filter(|calls| !calls.is_empty())
                .ok_or("tool_calls must be a nonempty array")?;
            for call in calls {
                let id = call["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("Tool call id required")?;
                let arguments = call["function"]["arguments"]
                    .as_str()
                    .ok_or("Tool arguments must be a JSON string")?;
                let arguments: Value =
                    serde_json::from_str(arguments).map_err(|_| "Invalid tool argument JSON")?;
                if call["type"] != "function"
                    || call["function"]["name"].as_str().is_none()
                    || !arguments.is_object()
                    || !pending.insert(id.to_string())
                {
                    return Err("Invalid assistant tool call".into());
                }
            }
            text.push_str(&format!("\nTool calls: {}", json!(calls)));
        }
        if role != "system" && role != "developer" {
            let label = match role {
                "user" => "User",
                "tool" => "Tool result",
                _ => "Assistant",
            };
            turns.push((label, text));
        }
    }
    if messages.is_empty() {
        return Err("A non-empty user message is required".into());
    }
    if !pending.is_empty() {
        return Err("Missing results for assistant tool calls".into());
    }
    if messages[messages.len() - 1]["role"] != "user"
        && messages[messages.len() - 1]["role"] != "tool"
    {
        return Err("the last message must be from the user or a tool result".into());
    }
    if turns.len() == 1 {
        let text = turns.remove(0).1;
        if text.len() > MAX_BODY {
            return Err("ACP prompt exceeds 1 MiB after flattening the conversation".into());
        }
        return Ok(text);
    }
    let turns = turns
        .into_iter()
        .map(|(label, text)| format!("{label}: {text}"));
    let text = turns.collect::<Vec<_>>().join("\n\n");
    if text.len() > MAX_BODY {
        return Err("ACP prompt exceeds 1 MiB after flattening the conversation".into());
    }
    Ok(text)
}

pub(super) fn parse_completion(value: &Value, models: &[AcpModel]) -> Result<Completion, String> {
    let object = value.as_object().ok_or("Request body must be an object")?;
    for key in object.keys() {
        if key == "service_tier" {
            return Err("ACP text access does not support parameter 'service_tier': the model list does not advertise a service tier mapping".into());
        }
        if ![
            "model",
            "messages",
            "stream",
            "stream_options",
            "reasoning_effort",
            "reasoning",
            "thinking",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "n",
            "store",
            "user",
            "metadata",
            "response_format",
            "prompt_cache_key",
            "safety_identifier",
            "max_tokens",
            "max_completion_tokens",
            "temperature",
            "top_p",
        ]
        .contains(&key.as_str())
        {
            return Err(format!(
                "ACP text access does not support parameter '{key}'"
            ));
        }
    }
    let ignored_parameters = compatibility_parameters(value)?;
    let mut tools = match value.get("tools") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(tools)) => tools.as_slice(),
        _ => return Err("tools must be an array".into()),
    };
    let choice = value.get("tool_choice").filter(|choice| !choice.is_null());
    let disabled = choice.is_some_and(|choice| choice == "none");
    if disabled {
        tools = &[];
    }
    let mut names = std::collections::BTreeSet::new();
    for tool in tools {
        let f = &tool["function"];
        let name = f["name"].as_str().ok_or("Tool function name required")?;
        if tool["type"] != "function"
            || name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !names.insert(name)
        {
            return Err("Invalid or duplicate function tool".into());
        }
        if f.get("parameters").is_some_and(|v| !v.is_object()) {
            return Err("Tool parameters must be a schema object".into());
        }
        if f["strict"] == true {
            return Err("ACP does not enforce strict tool schemas".into());
        }
    }
    if choice.is_some_and(|choice| choice != "none" && choice != "auto") {
        return Err("tool_choice requires a supported client tool; ACP currently accepts only 'none' or 'auto' with no tools".into());
    }
    if value
        .get("parallel_tool_calls")
        .is_some_and(|v| !v.is_null() && !v.is_boolean())
    {
        return Err("parallel_tool_calls must be a boolean".into());
    }
    if value
        .get("n")
        .is_some_and(|v| !v.is_null() && v.as_u64() != Some(1))
    {
        return Err("ACP supports n: 1 only".into());
    }
    if value
        .get("store")
        .is_some_and(|v| !v.is_null() && v != false)
    {
        return Err("ACP does not store API completions; use store: false".into());
    }
    if value
        .get("response_format")
        .is_some_and(|v| !v.is_null() && v != &json!({"type":"text"}))
    {
        return Err("ACP does not expose structured output controls".into());
    }
    for key in ["user", "prompt_cache_key", "safety_identifier"] {
        if value
            .get(key)
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err(format!("{key} must be a string"));
        }
    }
    if value
        .get("metadata")
        .is_some_and(|v| !v.is_null() && !v.is_object())
    {
        return Err("metadata must be an object".into());
    }
    let requested = value["model"].as_str().ok_or("model is required")?;
    let model = requested.strip_prefix("acp/").unwrap_or(requested);
    let model = models
        .iter()
        .find(|item| item.id == model)
        .ok_or("Unknown ACP model; refresh available models")?;
    let mut effort = value
        .get("reasoning_effort")
        .map(|value| value.as_str().ok_or("reasoning_effort must be a string"))
        .transpose()?;
    for key in ["reasoning", "thinking"] {
        if let Some(value) = value.get(key) {
            let options = value.as_object().ok_or_else(|| {
                format!("{key} must be an object containing only a string effort")
            })?;
            if options.len() != 1 || !options.contains_key("effort") {
                return Err(format!(
                    "ACP supports only {key}.effort; other {key} controls are not supported"
                ));
            }
            let nested = options["effort"]
                .as_str()
                .ok_or_else(|| format!("{key}.effort must be a string"))?;
            if effort.is_some_and(|effort| effort != nested) {
                return Err("Conflicting ACP reasoning efforts".into());
            }
            effort = Some(nested);
        }
    }
    let selected = match effort {
        Some(effort) if model.reasoning_levels.is_empty() => {
            return Err(format!("ACP model '{}' does not advertise reasoning levels; cannot request effort '{effort}'", model.id));
        }
        Some(effort) => model.reasoning_variants.get(effort).ok_or_else(|| {
            format!(
                "Unsupported reasoning effort '{effort}' for ACP model '{}'; supported levels: {}",
                model.id,
                model.reasoning_levels.join(", ")
            )
        })?,
        None => &model.id,
    };
    let messages = value["messages"]
        .as_array()
        .ok_or("messages must be an array")?;
    let text = prompt_text(messages)?;
    let results: Vec<_> = messages
        .iter()
        .rev()
        .take_while(|message| message["role"] == "tool")
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let system = messages
        .iter()
        .filter(|message| message["role"] == "system" || message["role"] == "developer")
        .map(|message| message_text(message, message["role"].as_str().unwrap()))
        .collect::<Result<Vec<_>, _>>()?
        .join("\n\n");
    if text.len().saturating_add(system.len()) > MAX_BODY {
        return Err("ACP prompt and system instructions exceed 1 MiB".into());
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
        model: selected.into(),
        alias: format!("acp/{}", model.id),
        text,
        system,
        stream,
        ignored_parameters,
        tools: tools.to_vec(),
        messages: messages.clone(),
        results,
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
    let session = client.session_with_system(profile, &request.system, cancel)?;
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
    let ignored_parameters = request.ignored_parameters.clone();
    if !ignored_parameters.is_empty() {
        eprintln!(
            "ACP compatibility: CLI defaults used; parameters not applied: {}",
            ignored_parameters.join(", ")
        );
    }
    let model = request.alias.clone();
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let id = format!(
        "chatcmpl-acp-{created}-{}",
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    );
    let agent_identity = json!({"profile":profile,"model":request.model,"system":request.system,"tools":request.tools});
    let resumed = if !request.results.is_empty() {
        match state.agents.resume(&request, &agent_identity) {
            Ok(session) => session,
            Err(error_message) => return error(StatusCode::BAD_REQUEST, error_message),
        }
    } else {
        None
    };
    let (sender, mut receiver) = tokio::sync::mpsc::channel(64);
    let mut events = CompletionStream {
        sender,
        cancel: guard.cancel.clone(),
        id: id.clone(),
        model: model.clone(),
        created,
        started: false,
    };
    let worker_app = app.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let result: Result<Output, String> = (|| {
            let mut send_text = |part: &str| {
                if stream {
                    if events.delta(json!({"content":part})).is_err() {
                        _guard.cancel.store(true, Ordering::Release);
                    }
                }
            };
            if !request.tools.is_empty() || resumed.is_some() {
                let state = worker_app.state::<AcpState>();
                let session = match resumed {
                    Some(session) => session,
                    None => state.agents.start(
                        &request,
                        agent_identity,
                        &executable,
                        &profile,
                        &proxy,
                        spawn,
                    )?,
                };
                let output =
                    state
                        .agents
                        .collect(&session, &request, &_guard.cancel, &mut send_text)?;
                if stream && !output.calls.is_empty() {
                    let calls: Vec<_> = output
                        .calls
                        .iter()
                        .enumerate()
                        .map(|(index, call)| {
                            let mut call = call.clone();
                            call["index"] = json!(index);
                            call
                        })
                        .collect();
                    events.delta(json!({"tool_calls":calls}))?;
                }
                Ok(output)
            } else {
                let mut client = spawn(&executable, &profile, &proxy)?;
                let text = complete(&mut client, &profile, &request, &_guard.cancel, send_text)?;
                Ok(Output {
                    text,
                    calls: Vec::new(),
                })
            }
        })();
        if stream {
            match &result {
                Ok(output) => {
                    let _ = events.finish(output);
                }
                Err(error) => {
                    let _ = events.send(Err(error.clone()));
                }
            }
        }
        result
    });
    let reply = if stream {
        // Do not commit HTTP 200 until the upstream produces its first event.
        // CPA can then handle startup failures through its existing HTTP error
        // path rather than trying to translate them as completion chunks.
        let first = match receiver.recv().await {
            Some(Ok(frame)) => frame,
            Some(Err(message)) => return error(upstream_status(&message), message),
            None => return error(StatusCode::BAD_GATEWAY, "ACP worker exited unexpectedly"),
        };
        let frames = futures_util::stream::unfold(
            (Some(first), receiver, cancel),
            |(mut first, mut receiver, cancel)| async move {
                let next = match first.take() {
                    Some(frame) => Some(Ok(frame)),
                    None => receiver.recv().await,
                };
                next.map(|data| {
                    let data = match data {
                        Ok(frame) => frame,
                        Err(message) => {
                            // An SSE error terminates the stream; never append
                            // a success finish_reason or [DONE] after it.
                            receiver.close();
                            let value = json!({"error":{"message":message,"type":"upstream_error","code":upstream_status(&message).as_u16()}});
                            format!("event: error\ndata: {value}\n\n")
                        }
                    };
                    (
                        Ok::<_, Infallible>(Frame::data(Bytes::from(data))),
                        (None, receiver, cancel),
                    )
                })
            },
        );
        Response::builder()
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(StreamBody::new(frames).boxed_unsync())
            .unwrap()
    } else {
        let result = worker.await;
        drop(cancel);
        match result {
            Ok(Ok(output)) => response(
                StatusCode::OK,
                json!({"id":id,"object":"chat.completion","created":created,"model":model,"choices":[{"index":0,"message":output.message(),"finish_reason":output.finish(),"logprobs":null}]}),
            ),
            Ok(Err(e)) => error(upstream_status(&e), e),
            Err(_) => error(StatusCode::BAD_GATEWAY, "ACP worker exited unexpectedly"),
        }
    };
    compatibility_headers(reply, &ignored_parameters)
}

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[cfg(test)]
mod tests;
