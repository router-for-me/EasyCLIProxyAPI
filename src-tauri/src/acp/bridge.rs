pub(super) mod responses;

use super::agent::{Identity, Protocol};
use super::request_pool::{acquire_request, AdmissionError, PoolSettings, RoutingStrategy};
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::collections::BTreeSet;
use std::convert::Infallible;
use tokio_util::sync::CancellationToken;

const PROVIDER: &str = "ecpa-antigravity-acp";
pub(super) const MAX_BODY: usize = 1024 * 1024;
pub(super) const IMAGE_UNSUPPORTED: &str = "The connected ACP CLI does not advertise image input; remove the image or use an image-capable CLI";
pub(super) fn has_images(prompt: &[PromptBlock]) -> bool {
    prompt
        .iter()
        .any(|block| matches!(block, PromptBlock::Image { .. }))
}
type Body = http_body_util::combinators::UnsyncBoxBody<Bytes, Infallible>;
pub(super) type SpawnClient = fn(&Path, &Path, &str) -> Result<rpc::Client, String>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PromptProfile {
    #[default]
    Append,
    FirstTurnContext,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
    enabled: bool,
    port: u16,
    account_pool: bool,
    prompt_profile: PromptProfile,
    routing_strategy: RoutingStrategy,
    max_global_concurrency: usize,
    max_live_sessions: usize,
    queue_wait_ms: u64,
    max_failover_attempts: usize,
    cooldown_base_secs: u64,
    cooldown_max_secs: u64,
}

impl Default for Settings {
    fn default() -> Self {
        let pool = PoolSettings::default();
        Self {
            enabled: false,
            port: 0,
            account_pool: pool.account_pool,
            prompt_profile: pool.prompt_profile,
            routing_strategy: pool.routing_strategy,
            max_global_concurrency: pool.max_global_concurrency,
            max_live_sessions: pool.max_live_sessions,
            queue_wait_ms: pool.queue_wait_ms,
            max_failover_attempts: pool.max_failover_attempts,
            cooldown_base_secs: pool.cooldown_base_secs,
            cooldown_max_secs: pool.cooldown_max_secs,
        }
    }
}

impl Settings {
    fn pool_settings(&self) -> PoolSettings {
        PoolSettings {
            account_pool: self.account_pool,
            routing_strategy: self.routing_strategy,
            max_global_concurrency: self.max_global_concurrency,
            max_live_sessions: self.max_live_sessions,
            queue_wait_ms: self.queue_wait_ms,
            max_failover_attempts: self.max_failover_attempts,
            cooldown_base_secs: self.cooldown_base_secs,
            cooldown_max_secs: self.cooldown_max_secs,
            prompt_profile: self.prompt_profile,
        }
    }

    fn apply_pool_settings(&mut self, pool: &PoolSettings) {
        self.account_pool = pool.account_pool;
        self.routing_strategy = pool.routing_strategy;
        self.max_global_concurrency = pool.max_global_concurrency;
        self.max_live_sessions = pool.max_live_sessions;
        self.queue_wait_ms = pool.queue_wait_ms;
        self.max_failover_attempts = pool.max_failover_attempts;
        self.cooldown_base_secs = pool.cooldown_base_secs;
        self.cooldown_max_secs = pool.cooldown_max_secs;
        self.prompt_profile = pool.prompt_profile;
    }
}

pub(super) struct Runtime {
    stop: CancellationToken,
    url: String,
    key: String,
    // Retain the configuration this runtime was registered against. Account
    // maintenance must report failures at that exact path, not a global guess.
    config: PathBuf,
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

pub(super) fn read_pool_settings(profile: &Path) -> Result<PoolSettings, String> {
    let settings = read_settings(profile)?;
    let pool = settings.pool_settings();
    if pool.validate().is_err() {
        return Ok(PoolSettings::default());
    }
    Ok(pool)
}

pub(super) fn save_pool_settings(profile: &Path, pool: &PoolSettings) -> Result<(), String> {
    pool.validate()?;
    let mut settings = read_settings(profile)?;
    settings.apply_pool_settings(pool);
    save_settings(profile, &settings)
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
            let mut updated = settings.clone();
            updated.enabled = false;
            save_settings(profile, &updated)?;
        }
        status.upstream_enabled = false;
        status.upstream_url = None;
        runtime.take();
        *state
            .request_pool
            .root
            .lock()
            .map_err(|_| "ACP pool unavailable")? = None;
        state.request_pool.cancel();
        state.agents.clear();
        drop(status);
        drop(runtime);
        register_at(config, None, "", &[]).map_err(|error| {
            format!("ACP API access is off, but provider cleanup failed: {error}")
        })?;
    } else {
        let pool_settings = settings.pool_settings();
        state.request_pool.set_settings(pool_settings.clone());
        state.agents.set_max_live(pool_settings.max_live_sessions);
        state.request_pool.mark_running();
        *state
            .request_pool
            .root
            .lock()
            .map_err(|_| "ACP pool unavailable")? =
            settings.account_pool.then(|| profile.to_path_buf());
        let status = state.snapshot()?;
        let models = state.aggregated_models();
        let ready = if settings.account_pool {
            state.has_ready_pool_account() && !models.is_empty()
        } else {
            status.authenticated && !models.is_empty()
        };
        if !ready {
            *state
                .request_pool
                .root
                .lock()
                .map_err(|_| "ACP pool unavailable")? = None;
            return Err("Connect ACP and load available models first".into());
        }
        let existing = state
            .bridge
            .lock()
            .map_err(|_| "ACP bridge state unavailable")?
            .as_ref()
            .map(|runtime| (runtime.url.clone(), runtime.key.clone()));
        if let Some((url, key)) = existing {
            register_at(config, Some(&url), &key, &models)?;
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
                config: config.into(),
            };
            register_at(config, Some(&url), &key, &models)?;
            let mut updated = settings.clone();
            updated.enabled = true;
            updated.port = port;
            if let Err(error) = save_settings(profile, &updated) {
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
            tauri::async_runtime::spawn(serve(
                app,
                listener,
                key,
                stop,
                settings.prompt_profile,
                rpc::Client::spawn,
            ));
        }
    }
    drop(_guard);
    let _ = tauri::Emitter::emit(app, crate::CONFIG_FILES_CHANGED_EVENT, ());
    state.snapshot()
}

fn is_external_dispatch<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.try_state::<crate::remote_cpa::RemoteCpaState>()
        .is_some_and(|remote| remote.uses_external_dispatch())
}

pub(crate) async fn restore(app: tauri::AppHandle) {
    if is_external_dispatch(&app) {
        return;
    }
    let result: Result<(), String> = async {
        let profile = profile(&crate::core_base_dir()?);
        let settings = read_settings(&profile)?;
        let pool_settings = settings.pool_settings();
        {
            let state = app.state::<AcpState>();
            state.request_pool.set_settings(pool_settings.clone());
            state.agents.set_max_live(pool_settings.max_live_sessions);
        }
        restore_if_enabled(&profile, || async {
            if is_external_dispatch(&app) {
                return Ok(());
            }
            if let Err(error) = super::acp_connect(app.clone(), false).await {
                if is_external_dispatch(&app) {
                    return Ok(());
                }
                if settings.account_pool {
                    let _ = super::verify_all_acp_accounts(app.clone()).await;
                    if is_external_dispatch(&app) {
                        return Ok(());
                    }
                    if !app.state::<AcpState>().has_ready_pool_account() {
                        register(None, "", &[])?;
                        return Err(error);
                    }
                } else {
                    register(None, "", &[])?;
                    return Err(error);
                }
            }
            if is_external_dispatch(&app) {
                return Ok(());
            }
            let config = crate::core_install_dir()?.join(crate::CORE_CONFIG_FILE);
            set_enabled(&app, &profile, &config, true, true).await?;
            if settings.account_pool {
                // Warm up secondary pool accounts asynchronously without blocking startup.
                let bg_app = app.clone();
                let bg_root = profile.clone();
                tauri::async_runtime::spawn(async move {
                    if is_external_dispatch(&bg_app) {
                        return;
                    }
                    let Ok(home) = bg_app.path().home_dir() else {
                        return;
                    };
                    let Some(executable) = crate::find_antigravity_cli(&home) else {
                        return;
                    };
                    let Ok(registry) = accounts::read(&bg_root) else {
                        return;
                    };
                    let Ok(global_proxy) = bg_app
                        .state::<crate::GuiConfigState>()
                        .snapshot()
                        .map(|c| c.proxy_url)
                    else {
                        return;
                    };
                    let active = registry.active.clone();
                    let targets: Vec<accounts::Account> = registry
                        .accounts
                        .into_iter()
                        .filter(|a| a.enabled && a.saved && a.id != active)
                        .collect();
                    if targets.is_empty() {
                        return;
                    }
                    let cancel = Arc::new(AtomicBool::new(false));
                    if super::verify_accounts_batch(
                        &bg_app,
                        &bg_root,
                        &executable,
                        &global_proxy,
                        targets,
                        cancel,
                    )
                    .await
                    .is_ok()
                        && !is_external_dispatch(&bg_app)
                    {
                        let _ = sync_models(bg_app.state::<AcpState>().inner());
                    }
                });
            }
            Ok(())
        })
        .await
    }
    .await;
    if let Err(error) = result {
        if !is_external_dispatch(&app) {
            if let Ok(mut status) = app.state::<AcpState>().status.lock() {
                status.error = Some(error);
            }
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
    let models = state.aggregated_models();
    let runtime = state
        .bridge
        .lock()
        .map_err(|_| "ACP bridge state unavailable")?;
    if let Some(runtime) = runtime.as_ref() {
        register_at(
            &runtime.config,
            Some(&runtime.url),
            &runtime.key,
            &models,
        )?;
    }
    Ok(())
}

async fn serve<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    listener: tokio::net::TcpListener,
    key: String,
    stop: CancellationToken,
    policy: PromptProfile,
    spawn: SpawnClient,
) {
    {
        let state = app.state::<AcpState>();
        state.request_pool.mark_running();
        if policy != PromptProfile::Append {
            let mut settings = state.request_pool.settings();
            settings.prompt_profile = policy;
            state.request_pool.set_settings(settings);
        }
    }
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

#[derive(Clone)]
pub(super) struct Completion {
    pub policy: PromptProfile,
    pub model: String,
    pub alias: String,
    pub prompt: Vec<PromptBlock>,
    pub system: String,
    pub instructions_bytes: usize,
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
    sender: tokio::sync::mpsc::Sender<Result<String, RunError>>,
    cancel: Arc<AtomicBool>,
    id: String,
    model: String,
    created: u64,
    started: bool,
    native: bool,
    previous: Option<String>,
    sequence: u64,
    text_started: bool,
}

impl CompletionStream {
    fn send(&self, frame: Result<String, RunError>) -> Result<(), String> {
        self.send_with_stall_limit(frame, std::time::Duration::from_secs(30))
    }

    fn send_with_stall_limit(
        &self,
        mut frame: Result<String, RunError>,
        limit: std::time::Duration,
    ) -> Result<(), String> {
        let started = std::time::Instant::now();
        loop {
            if self.cancel.load(Ordering::Acquire) {
                return Err("ACP API client disconnected or request cancelled".into());
            }
            match self.sender.try_send(frame) {
                Ok(()) => return Ok(()),
                Err(tokio::sync::mpsc::error::TrySendError::Full(pending)) => {
                    if started.elapsed() >= limit {
                        self.cancel.store(true, Ordering::Release);
                        return Err("ACP client stopped reading the response stream".into());
                    }
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

    fn event(&mut self, kind: &str, mut data: Value) -> Result<(), String> {
        self.sequence += 1;
        data["type"] = json!(kind);
        data["sequence_number"] = json!(self.sequence);
        self.send(Ok(format!("event: {kind}\ndata: {data}\n\n")))
    }

    fn response_start(&mut self) -> Result<(), String> {
        if !self.started {
            let value = responses::envelope(
                &self.id,
                &self.model,
                self.created,
                self.previous.as_deref(),
                None,
            );
            self.event("response.created", json!({"response":value}))?;
            self.event("response.in_progress", json!({"response":value}))?;
            self.started = true;
        }
        Ok(())
    }

    fn text(&mut self, part: &str) -> Result<(), String> {
        // Empty ACP deltas are not visible output. In particular, do not
        // commit HTTP 200 before a subsequent upstream failure is known.
        if part.is_empty() {
            return Ok(());
        }
        if !self.native {
            return self.delta(json!({"content":part}));
        }
        self.response_start()?;
        let item = responses::text_item(&self.id, None);
        if !self.text_started {
            self.event(
                "response.output_item.added",
                json!({"output_index":0,"item":item}),
            )?;
            self.event("response.content_part.added", json!({"item_id":item["id"],"output_index":0,"content_index":0,"part":responses::text_part("")}))?;
            self.text_started = true;
        }
        self.event("response.output_text.delta", json!({"item_id":item["id"],"output_index":0,"content_index":0,"delta":part,"logprobs":[]}))
    }

    fn delta(&mut self, delta: Value) -> Result<(), String> {
        if !self.started {
            self.chunk(json!({"role":"assistant","content":""}), None)?;
            self.started = true;
        }
        self.chunk(delta, None)
    }

    fn finish(&mut self, output: &Output) -> Result<(), String> {
        if self.native {
            self.response_start()?;
            let response = responses::envelope(
                &self.id,
                &self.model,
                self.created,
                self.previous.as_deref(),
                Some(output),
            );
            for (index, item) in response["output"].as_array().unwrap().iter().enumerate() {
                if item["type"] == "message" {
                    self.event("response.output_text.done", json!({"item_id":item["id"],"output_index":index,"content_index":0,"text":output.text,"logprobs":[]}))?;
                    self.event("response.content_part.done", json!({"item_id":item["id"],"output_index":index,"content_index":0,"part":item["content"][0]}))?;
                } else {
                    let mut added = item.clone();
                    added["status"] = json!("in_progress");
                    added["arguments"] = json!("");
                    self.event(
                        "response.output_item.added",
                        json!({"output_index":index,"item":added}),
                    )?;
                    self.event("response.function_call_arguments.delta", json!({"item_id":item["id"],"output_index":index,"delta":item["arguments"]}))?;
                    self.event("response.function_call_arguments.done", json!({"item_id":item["id"],"output_index":index,"arguments":item["arguments"],"name":item["name"]}))?;
                }
                self.event(
                    "response.output_item.done",
                    json!({"output_index":index,"item":item}),
                )?;
            }
            return self.event("response.completed", json!({"response":response}));
        }
        if !self.started {
            self.delta(json!({"content":""}))?;
        }
        self.chunk(json!({}), Some(output.finish()))?;
        self.send(Ok("data: [DONE]\n\n".into()))
    }
}

#[derive(Debug)]
pub(super) enum RunError {
    InvalidRequest(String),
    Upstream(String),
    Rejected(rpc::Rejection),
}

impl From<String> for RunError {
    fn from(error: String) -> Self {
        Self::Upstream(error)
    }
}

impl From<rpc::RpcFailure> for RunError {
    fn from(error: rpc::RpcFailure) -> Self {
        match error {
            rpc::RpcFailure::Local(message) => Self::Upstream(message),
            rpc::RpcFailure::Remote { kind, .. } => Self::Rejected(kind),
        }
    }
}

impl RunError {
    fn parts(self) -> (StatusCode, &'static str, String) {
        use rpc::Rejection::*;
        match self {
            Self::InvalidRequest(message) => {
                (StatusCode::BAD_REQUEST, "invalid_request_error", message)
            }
            Self::Upstream(message) => (upstream_status(&message), "upstream_error", message),
            Self::Rejected(kind) => {
                let (status, code, message) = match kind {
                    InvalidRequest => (
                        StatusCode::BAD_REQUEST,
                        "invalid_request_error",
                        "ACP rejected the prompt parameters",
                    ),
                    Authentication => (
                        StatusCode::UNAUTHORIZED,
                        "authentication_error",
                        "The upstream ACP account needs authentication",
                    ),
                    Permission => (
                        StatusCode::FORBIDDEN,
                        "permission_denied",
                        "The upstream ACP service denied permission",
                    ),
                    Quota => (
                        StatusCode::TOO_MANY_REQUESTS,
                        "rate_limit_error",
                        "The upstream ACP service reported a resource or rate limit",
                    ),
                    Overloaded => (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "overloaded_error",
                        "The upstream ACP service is unavailable",
                    ),
                    Timeout => (
                        StatusCode::GATEWAY_TIMEOUT,
                        "upstream_timeout",
                        "The upstream ACP service reported a deadline exceeded",
                    ),
                    Unknown => (
                        StatusCode::BAD_GATEWAY,
                        "upstream_error",
                        "The upstream ACP agent returned an error",
                    ),
                };
                (status, code, message.into())
            }
        }
    }

    fn into_response(self) -> Response<Body> {
        let (status, code, message) = self.parts();
        response(
            status,
            json!({"error":{"message":message,"type":code,"code":code}}),
        )
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

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum PromptBlock {
    Text {
        text: String,
    },
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        data: String,
    },
}

impl PromptBlock {
    fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
            Self::Image { .. } => None,
        }
    }

    fn body_len(&self) -> usize {
        match self {
            Self::Text { text } => text.len(),
            Self::Image { data, .. } => data.len(),
        }
    }
}

fn push_text(blocks: &mut Vec<PromptBlock>, text: &str) {
    if let Some(PromptBlock::Text { text: existing }) = blocks.last_mut() {
        existing.push_str(text);
    } else {
        blocks.push(PromptBlock::Text { text: text.into() });
    }
}

fn image_block(part: &Value) -> Result<(PromptBlock, bool), String> {
    let image = part["image_url"]
        .as_object()
        .ok_or("image_url must be an object")?;
    if image.keys().any(|key| key != "url" && key != "detail") {
        return Err("image_url supports only 'url' and 'detail'".into());
    }
    let detail_ignored = match image.get("detail").filter(|v| !v.is_null()) {
        None => false,
        Some(value) if value == "auto" => false,
        Some(value) if value == "low" || value == "high" => true,
        _ => return Err("image_url.detail must be 'auto', 'low' or 'high'".into()),
    };
    let url = image
        .get("url")
        .and_then(Value::as_str)
        .ok_or("image_url.url must be a string")?;
    let (mime, data) = url
        .strip_prefix("data:")
        .and_then(|url| url.split_once(";base64,"))
        .ok_or("image_url.url must be an inline base64 image data URL; ACP does not fetch URLs or read files")?;
    if !matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err("image_url must be PNG, JPEG, GIF or WebP".into());
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "image_url contains invalid base64")?;
    let matches_mime = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !matches_mime {
        return Err("image_url data does not match the declared image format".into());
    }
    Ok((
        PromptBlock::Image {
            mime_type: mime.into(),
            data: data.into(),
        },
        detail_ignored,
    ))
}

fn message_content(
    message: &Value,
    role: &str,
    ignored: &mut Vec<&'static str>,
) -> Result<Vec<PromptBlock>, String> {
    let message = message
        .as_object()
        .ok_or_else(|| format!("Invalid {role} message"))?;
    if let Some(key) = message.keys().find(|key| {
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
        return Err(format!("ACP does not support {role} message field '{key}'"));
    }
    if message
        .get("name")
        .is_some_and(|name| !name.is_null() && !name.is_string())
    {
        return Err("Message name must be a string".into());
    }
    let has_tools = role == "assistant" && message.get("tool_calls").is_some();
    // An assistant history entry may contain only reasoning metadata. Do not
    // replay that metadata as a visible assistant reply or add an empty turn.
    let reasoning_only = role == "assistant"
        && message
            .get("reasoning_content")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty());
    let mut blocks = Vec::new();
    match message.get("content").unwrap_or(&Value::Null) {
        Value::String(text) => push_text(&mut blocks, text),
        Value::Array(parts) => {
            for (index, part) in parts.iter().enumerate() {
                let block = match part["type"].as_str() {
                    Some("text") => part["text"].as_str().ok_or_else(|| {
                        format!("{role} content part {index}: text must be a string")
                    })?,
                    Some("image_url") if role == "user" => {
                        let (image, detail_ignored) = image_block(part)
                            .map_err(|error| format!("{role} content part {index}: {error}"))?;
                        blocks.push(image);
                        if detail_ignored && !ignored.contains(&"image_url.detail") {
                            ignored.push("image_url.detail");
                        }
                        continue;
                    }
                    Some("image_url") => return Err(format!("{role} content part {index}: send image_url in a user message; ACP only accepts text in {role} messages")),
                    Some(kind) => return Err(format!("{role} content part {index}: ACP does not support '{kind}'; use text or an inline image in a user message")),
                    None => return Err(format!("{role} content part {index}: expected an object with a string 'type'")),
                };
                push_text(&mut blocks, block);
            }
        }
        Value::Null if has_tools || reasoning_only => {}
        Value::Null => {
            return Err(format!(
                "{role} message content is missing or null; provide {}",
                if role == "user" {
                    "text or an inline image"
                } else {
                    "text"
                }
            ))
        }
        _ => {
            return Err(format!(
                "{role} message content must be a string or an array of content parts"
            ))
        }
    }
    if blocks
        .iter()
        .all(|block| block.as_text().is_some_and(|text| text.trim().is_empty()))
    {
        if !has_tools && !reasoning_only && role != "tool" {
            return Err(format!("A non-empty {role} message is required"));
        }
        if reasoning_only && !has_tools {
            blocks.clear();
        }
    }
    Ok(blocks)
}

pub(super) fn tool_text(message: &Value) -> Result<String, String> {
    let blocks = message_content(message, "tool", &mut Vec::new())?;
    Ok(blocks
        .first()
        .and_then(PromptBlock::as_text)
        .unwrap_or_default()
        .into())
}

// ACP starts a fresh session for a new turn. Encode prior roles as text while
// keeping image blocks in their original positions, including images in history.
fn plan_prompt(
    messages: &[Value],
    ignored: &mut Vec<&'static str>,
    policy: PromptProfile,
) -> Result<(Vec<PromptBlock>, String), String> {
    let mut turns = Vec::new();
    let mut system = Vec::new();
    let mut pending = std::collections::BTreeSet::new();
    for (index, message) in messages.iter().enumerate() {
        let role = message["role"].as_str().unwrap_or("");
        match role {
            "system" | "developer" | "user" | "assistant" | "tool" => {}
            "" => return Err(format!("Invalid role in messages[{index}]")),
            role => {
                return Err(format!(
                    "ACP does not support role '{role}' in messages[{index}]"
                ))
            }
        }
        let mut blocks = message_content(message, role, ignored)
            .map_err(|error| format!("messages[{index}]: {error}"))?;
        if role == "tool" {
            let id = message["tool_call_id"]
                .as_str()
                .ok_or("role 'tool' requires tool_call_id")?;
            if !pending.remove(id) {
                return Err("role 'tool' references an unknown or duplicate tool_call_id".into());
            }
            let text = blocks
                .first()
                .and_then(PromptBlock::as_text)
                .unwrap_or_default();
            blocks = vec![PromptBlock::Text {
                text: json!({"tool_call_id":id,"output":text}).to_string(),
            }];
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
            push_text(&mut blocks, &format!("\nTool calls: {}", json!(calls)));
        }
        match role {
            "system" | "developer" => system.push(blocks[0].as_text().unwrap().to_string()),
            "user" => turns.push(("User", blocks)),
            "tool" => turns.push(("Tool result", blocks)),
            "assistant" if !blocks.is_empty() => turns.push(("Assistant", blocks)),
            _ => {}
        }
    }
    let last = messages
        .last()
        .ok_or("A non-empty user message is required")?;
    if !pending.is_empty() {
        return Err("Missing results for assistant tool calls".into());
    }
    if last["role"] != "user" && last["role"] != "tool" {
        return Err("the last message must be from the user or a tool result".into());
    }
    let prompt = if turns.len() == 1 {
        turns.pop().unwrap().1
    } else {
        let mut prompt = Vec::new();
        for (index, (label, blocks)) in turns.into_iter().enumerate() {
            // Normalize only our own inter-turn blank line; never scan message text.
            let separator = match (index, policy) {
                (0, _) => "",
                (_, PromptProfile::FirstTurnContext) => "\n",
                (_, PromptProfile::Append) => "\n\n",
            };
            push_text(&mut prompt, &format!("{separator}{label}: "));
            for block in blocks {
                if let Some(text) = block.as_text() {
                    push_text(&mut prompt, text);
                } else {
                    prompt.push(block);
                }
            }
        }
        prompt
    };
    let system = system.join("\n\n");
    let size = prompt.iter().fold(system.len(), |size, block| {
        size.saturating_add(block.body_len())
    });
    if size > MAX_BODY {
        return Err("ACP prompt and system instructions exceed 1 MiB".into());
    }
    Ok((prompt, system))
}

#[cfg(test)]
pub(super) fn parse_completion(value: &Value, models: &[AcpModel]) -> Result<Completion, String> {
    parse_with_profile(value, models, PromptProfile::Append)
}

fn parse_with_profile(
    value: &Value,
    models: &[AcpModel],
    policy: PromptProfile,
) -> Result<Completion, String> {
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
    let mut ignored_parameters = compatibility_parameters(value)?;
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
    let (prompt, system) = plan_prompt(messages, &mut ignored_parameters, policy)?;
    let results: Vec<_> = messages
        .iter()
        .rev()
        .take_while(|message| message["role"] == "tool")
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
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
        policy,
        model: selected.into(),
        alias: format!("acp/{}", model.id),
        prompt,
        system,
        instructions_bytes: 0,
        stream,
        ignored_parameters,
        tools: tools.to_vec(),
        messages: messages.clone(),
        results,
    })
}

// ECPA's optional, human-readable Markdown export. Recognize only the complete
// shipped document, never a heading found inside arbitrary client instructions.
const ACP_TEMPLATE: &str = include_str!("../../../plugins/acp-responses/codex-acp-instructions.md");
const ACP_TEMPLATE_TITLE: &str = "# ECPA ACP instructions\n\n";

fn context_text(system: &str) -> &str {
    for prefix in ["\u{feff}", ACP_TEMPLATE_TITLE] {
        if system.len() == prefix.len() + ACP_TEMPLATE.len()
            && system.strip_prefix(prefix) == Some(ACP_TEMPLATE)
        {
            return ACP_TEMPLATE;
        }
    }
    system
}

impl Completion {
    // Called only for a new ACP session. Stored identity and continuation deltas
    // always retain the canonical, unframed request.
    fn frame_opening(&mut self) -> Result<(), String> {
        if self.policy == PromptProfile::Append || self.system.is_empty() {
            return Ok(());
        }
        let context = format!("Client context:\n{}", context_text(&self.system));
        if self
            .prompt
            .iter()
            .fold(context.len(), |n, b| n.saturating_add(b.body_len()))
            > MAX_BODY
        {
            return Err("ACP framed prompt exceeds 1 MiB".into());
        }
        self.prompt.insert(0, PromptBlock::Text { text: context });
        self.system.clear();
        Ok(())
    }
}

fn complete<F: FnMut(&str)>(
    client: &mut rpc::Client,
    profile: &Path,
    request: &Completion,
    cancel: &Arc<AtomicBool>,
    mut chunk: F,
) -> Result<String, RunError> {
    let session = client.session_with_system(profile, &request.system, cancel)?;
    client.model(&session, &request.model, cancel)?;
    let mut text = String::new();
    let mut oversized = false;
    let result = client.agent_prompt(
        json!({"sessionId":session["sessionId"],"prompt":request.prompt}),
        cancel,
        false,
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
        return Err("ACP response exceeds 1 MiB".to_owned().into());
    }
    let result = result?;
    if result["stopReason"] != "end_turn" {
        return Err(format!("ACP turn did not complete: {}", result["stopReason"]).into());
    }
    Ok(text)
}

fn is_non_retryable_upstream(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("client disconnected")
        || lower.contains("request cancelled")
        || lower.contains("stopped reading")
        || lower.contains("exceeds 1 mib")
}

fn record_attempt_failure(
    state: &AcpState,
    account_id: &str,
    model: &str,
    error: &RunError,
) -> bool {
    match error {
        RunError::InvalidRequest(_) => false,
        RunError::Rejected(kind) => match kind {
            rpc::Rejection::InvalidRequest => false,
            rpc::Rejection::Authentication | rpc::Rejection::Permission => {
                let message = match kind {
                    rpc::Rejection::Authentication => "The upstream ACP account needs authentication",
                    _ => "The upstream ACP service denied permission",
                };
                state.record_account_auth_required(account_id, message.to_string());
                state
                    .request_pool
                    .record_failure(account_id, Some(model), *kind);
                true
            }
            rpc::Rejection::Quota
            | rpc::Rejection::Overloaded
            | rpc::Rejection::Timeout
            | rpc::Rejection::Unknown => {
                state
                    .request_pool
                    .record_failure(account_id, Some(model), *kind);
                true
            }
        },
        RunError::Upstream(message) => {
            if is_non_retryable_upstream(message) {
                false
            } else {
                state.request_pool.record_spawn_failure(account_id);
                true
            }
        }
    }
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
    let catalog = state.aggregated_models();
    let native = request.uri().path() == "/v1/responses";
    match (request.method().as_str(), request.uri().path()) {
        ("GET", "/v1/models") => {
            return response(
                StatusCode::OK,
                json!({"object":"list","data":catalog.iter().map(|model| json!({"id":format!("acp/{}", model.id),"object":"model","created":0,"owned_by":PROVIDER})).collect::<Vec<_>>()}),
            )
        }
        ("POST", "/v1/chat/completions" | "/v1/responses") => {}
        _ => {
            return error(
                StatusCode::NOT_FOUND,
                "ACP supports /v1/models, /v1/chat/completions and /v1/responses only",
            )
        }
    }
    let pool_active = state
        .request_pool
        .root
        .lock()
        .ok()
        .is_some_and(|root| root.is_some());
    if !status.upstream_enabled
        || (!pool_active && !status.authenticated)
        || (pool_active && catalog.is_empty() && !status.authenticated)
    {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ACP API access is not connected",
        );
    }
    let pool_settings = state.request_pool.settings();
    let policy = pool_settings.prompt_profile;
    // Only the private authenticated bridge may carry the executor's derived
    // caller scope. The public executor constructs the request from scratch.
    let caller = if native {
        request
            .headers()
            .get("x-ecpa-acp-caller-scope")
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(str::to_owned)
    } else {
        None
    };
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
    let previous = if native {
        match responses::previous(&value) {
            Ok(previous) => previous.map(str::to_owned),
            Err(e) => return error(StatusCode::BAD_REQUEST, e),
        }
    } else {
        None
    };
    let context = match previous
        .as_deref()
        .map(|id| state.agents.context(id, caller.as_deref()))
        .transpose()
    {
        Ok(context) => context,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    let full = if native && previous.is_none() {
        match responses::parse_with_profile(&value, &catalog, None, policy) {
            Ok(request) => Some(request),
            Err(e) => return error(StatusCode::BAD_REQUEST, e),
        }
    } else {
        None
    };
    let history_match = match (full.as_ref(), caller.as_deref()) {
        (Some(request), Some(caller)) => match state.agents.history_match(request, caller) {
            Ok(found) => found,
            Err(e) => return error(StatusCode::SERVICE_UNAVAILABLE, e),
        },
        _ => None,
    };
    // Chat tool calls are also sticky; ordinary Chat has no continuation scope.
    let chat_pin = if !native {
        value["messages"]
            .as_array()
            .and_then(|messages| {
                messages
                    .iter()
                    .rev()
                    .take_while(|message| message["role"] == "tool")
                    .last()
            })
            .and_then(|tool| tool["tool_call_id"].as_str())
    } else {
        None
    };
    let chat_identity = match chat_pin
        .map(|id| state.agents.chat_identity(id))
        .transpose()
    {
        Ok(identity) => identity,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    let pinned = context
        .as_ref()
        .map(|context| &context.identity.account)
        .or(chat_identity.as_ref())
        .or(history_match.as_ref().map(|(_, account, _)| account));
    let mut parsed_request = match if native {
        responses::parse_with_profile(&value, &catalog, context.as_ref(), policy)
    } else {
        parse_with_profile(&value, &catalog, policy)
    } {
        Ok(request) => request,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    if native && previous.is_none() && history_match.is_none() && !parsed_request.results.is_empty()
    {
        return error(
            StatusCode::BAD_REQUEST,
            "A live ACP function output requires previous_response_id",
        );
    }
    if let Some((_, _, count)) = &history_match {
        if parsed_request.results.is_empty() {
            let suffix = parsed_request
                .messages
                .iter()
                .filter(|m| m["role"] != "system" && m["role"] != "developer")
                .skip(*count)
                .cloned()
                .collect::<Vec<_>>();
            parsed_request.prompt =
                match plan_prompt(&suffix, &mut parsed_request.ignored_parameters, policy) {
                    Ok((prompt, _)) => prompt,
                    Err(e) => return error(StatusCode::BAD_REQUEST, e),
                };
        }
    }
    let continuation = previous
        .as_deref()
        .or(history_match.as_ref().map(|(id, _, _)| id.as_str()));
    let preserve_transcript = native && previous.is_none();
    let executable = match status.executable {
        Some(path) => PathBuf::from(path),
        None => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Official Antigravity CLI not found",
            )
        }
    };
    let global_proxy = match app.state::<crate::GuiConfigState>().snapshot() {
        Ok(config) => config.proxy_url,
        Err(e) => return error(StatusCode::SERVICE_UNAVAILABLE, e),
    };
    let stream = parsed_request.stream;
    let ignored_parameters = parsed_request.ignored_parameters.clone();
    if !ignored_parameters.is_empty() {
        eprintln!(
            "ACP compatibility: CLI defaults used; parameters not applied: {}",
            ignored_parameters.join(", ")
        );
    }
    let model = parsed_request.alias.clone();
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let id = if native {
        match tool_transport::secret() {
            Ok(secret) => format!("resp_acp_{secret}"),
            Err(_) => {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "ACP continuation IDs unavailable",
                )
            }
        }
    } else {
        format!(
            "chatcmpl-acp-{created}-{}",
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        )
    };

    // Failover is strictly restricted to fresh (unpinned) turns before any
    // response frame or tool call has been emitted to the client.
    let can_failover =
        pinned.is_none() && pool_active && pool_settings.max_failover_attempts > 0;
    let max_attempts = if can_failover {
        1 + pool_settings.max_failover_attempts
    } else {
        1
    };
    let mut tried_accounts = BTreeSet::new();
    let mut last_error: Option<RunError> = None;

    for attempt in 0..max_attempts {
        let (guard, _status) = match acquire_request(
            &app,
            pinned,
            Some(&parsed_request.model),
            &tried_accounts,
        )
        .await
        {
            Ok(admitted) => admitted,
            Err(AdmissionError::Busy) => {
                if let Some(previous_error) = last_error {
                    return previous_error.into_response();
                }
                return error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "An ACP operation is already running or the account pool is busy",
                );
            }
            Err(AdmissionError::NoHealthyAccount(message)) => {
                if let Some(previous_error) = last_error {
                    return previous_error.into_response();
                }
                let code = if message.contains("cooling down") {
                    StatusCode::TOO_MANY_REQUESTS
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                };
                return error(code, message);
            }
            Err(AdmissionError::Disconnected | AdmissionError::Cancelled) => {
                if let Some(previous_error) = last_error {
                    return previous_error.into_response();
                }
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "ACP API access is not connected",
                );
            }
            Err(AdmissionError::Stale) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "The ACP continuation account is no longer available",
                );
            }
        };

        let account_id = guard.account.id.clone();
        tried_accounts.insert(account_id.clone());
        let profile = guard.account.profile.clone();
        let proxy = accounts::resolve_proxy(guard.proxy_url.as_deref(), &global_proxy);
        let cancel = CancelOnDrop(guard.cancel.clone());
        let mut request = parsed_request.clone();
        let agent_identity = Identity {
            account: guard.account.clone(),
            model: request.model.clone(),
            system: request.system.clone(),
            instructions_bytes: request.instructions_bytes,
            tools: request.tools.clone(),
            caller: caller.clone(),
            protocol: if native {
                Protocol::Responses
            } else {
                Protocol::Chat
            },
        };
        let resumed = match state.agents.resume(&request, &agent_identity, continuation) {
            Ok(session) => session,
            Err(error_message) => return error(StatusCode::BAD_REQUEST, error_message),
        };
        let (sender, mut receiver) = tokio::sync::mpsc::channel(64);
        let mut events = CompletionStream {
            sender,
            cancel: guard.cancel.clone(),
            id: id.clone(),
            model: model.clone(),
            created,
            started: false,
            native,
            previous: previous.clone(),
            sequence: 0,
            text_started: false,
        };
        let worker_app = app.clone();
        let worker_executable = executable.clone();
        let worker_account_id = account_id.clone();
        let worker_model = request.model.clone();
        let worker = tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            let result: Result<Output, RunError> = (|| {
                let mut send_text = |part: &str| {
                    if stream {
                        if events.text(part).is_err() {
                            _guard.cancel.store(true, Ordering::Release);
                        }
                    }
                };
                let state = worker_app.state::<AcpState>();
                let session = match resumed {
                    // The original request already negotiated image capability;
                    // history matching rejects changed attachments on continuation.
                    Some(session) => session,
                    None => {
                        request.frame_opening().map_err(RunError::InvalidRequest)?;
                        let mut client = spawn(&worker_executable, &profile, &proxy)?;
                        client.initialize(&_guard.cancel)?;
                        if !client.supports_prompt_images() && has_images(&request.prompt) {
                            return Err(RunError::InvalidRequest(IMAGE_UNSUPPORTED.into()));
                        }
                        if !native && request.tools.is_empty() {
                            let text = complete(
                                &mut client,
                                &profile,
                                &request,
                                &_guard.cancel,
                                send_text,
                            )?;
                            return Ok(Output {
                                text,
                                calls: Vec::new(),
                            });
                        }
                        state.agents.start(&request, agent_identity, client)?
                    }
                };
                let output = state.agents.collect(
                    &session,
                    &request,
                    &_guard.cancel,
                    preserve_transcript,
                    &mut send_text,
                )?;
                if stream && !native && !output.calls.is_empty() {
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
                if _guard.cancel.load(Ordering::Acquire) {
                    return Err("ACP API client disconnected or request cancelled"
                        .to_owned()
                        .into());
                }
                state.agents.publish(
                    &session,
                    native.then_some(events.id.as_str()),
                    &output,
                    &_guard.cancel,
                )?;
                Ok(output)
            })();
            if stream {
                match result {
                    Ok(output) => {
                        worker_app
                            .state::<AcpState>()
                            .request_pool
                            .record_success(&worker_account_id, Some(&worker_model));
                        if events.finish(&output).is_err() {
                            let state = worker_app.state::<AcpState>();
                            if native {
                                state.agents.abandon(&events.id);
                            }
                            for call in &output.calls {
                                if let Some(id) = call["id"].as_str() {
                                    state.agents.abandon(id);
                                }
                            }
                        }
                    }
                    Err(error) if events.started => {
                        if pool_active {
                            record_attempt_failure(
                                worker_app.state::<AcpState>().inner(),
                                &worker_account_id,
                                &worker_model,
                                &error,
                            );
                        }
                        if native {
                            let (status, code, message) = error.parts();
                            let _ = events.event(
                                "error",
                                json!({"code":code,"message":message,"param":null,"status":status.as_u16()}),
                            );
                        } else {
                            let _ = events.send(Err(error));
                        }
                    }
                    Err(error) => {
                        let _ = events.send(Err(error));
                    }
                }
                None
            } else {
                Some(result)
            }
        });

        if stream {
            // Do not commit HTTP 200 until the upstream produces its first event.
            // Pre-output failures can safely fail over to another healthy account.
            let first = match receiver.recv().await {
                Some(Ok(frame)) => frame,
                Some(Err(run_error)) => {
                    drop(cancel);
                    let _ = worker.await;
                    let retryable = if pool_active {
                        record_attempt_failure(
                            state.inner(),
                            &account_id,
                            &parsed_request.model,
                            &run_error,
                        )
                    } else {
                        false
                    };
                    if can_failover && retryable && attempt + 1 < max_attempts {
                        last_error = Some(run_error);
                        continue;
                    }
                    return run_error.into_response();
                }
                None => {
                    drop(cancel);
                    let _ = worker.await;
                    let run_error = RunError::Upstream("ACP worker exited unexpectedly".into());
                    let retryable = if pool_active {
                        record_attempt_failure(
                            state.inner(),
                            &account_id,
                            &parsed_request.model,
                            &run_error,
                        )
                    } else {
                        false
                    };
                    if can_failover && retryable && attempt + 1 < max_attempts {
                        last_error = Some(run_error);
                        continue;
                    }
                    return run_error.into_response();
                }
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
                            Err(error) => {
                                // An SSE error terminates the stream; never append
                                // a success finish_reason or [DONE] after it.
                                receiver.close();
                                let (status, code, message) = error.parts();
                                let value = json!({"error":{"message":message,"type":code,"code":status.as_u16()}});
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
            let reply = Response::builder()
                .header("content-type", "text/event-stream")
                .header("cache-control", "no-cache")
                .body(StreamBody::new(frames).boxed_unsync())
                .unwrap();
            return compatibility_headers(reply, &ignored_parameters);
        } else {
            let result = worker.await;
            drop(cancel);
            match result {
                Ok(Some(Ok(output))) => {
                    state
                        .request_pool
                        .record_success(&account_id, Some(&parsed_request.model));
                    let reply = if native {
                        response(
                            StatusCode::OK,
                            responses::envelope(
                                &id,
                                &model,
                                created,
                                previous.as_deref(),
                                Some(&output),
                            ),
                        )
                    } else {
                        response(
                            StatusCode::OK,
                            json!({"id":id,"object":"chat.completion","created":created,"model":model,"choices":[{"index":0,"message":output.message(),"finish_reason":output.finish(),"logprobs":null}]}),
                        )
                    };
                    return compatibility_headers(reply, &ignored_parameters);
                }
                Ok(Some(Err(run_error))) => {
                    let retryable = if pool_active {
                        record_attempt_failure(
                            state.inner(),
                            &account_id,
                            &parsed_request.model,
                            &run_error,
                        )
                    } else {
                        false
                    };
                    if can_failover && retryable && attempt + 1 < max_attempts {
                        last_error = Some(run_error);
                        continue;
                    }
                    return run_error.into_response();
                }
                _ => {
                    let run_error = RunError::Upstream("ACP worker exited unexpectedly".into());
                    let retryable = if pool_active {
                        record_attempt_failure(
                            state.inner(),
                            &account_id,
                            &parsed_request.model,
                            &run_error,
                        )
                    } else {
                        false
                    };
                    if can_failover && retryable && attempt + 1 < max_attempts {
                        last_error = Some(run_error);
                        continue;
                    }
                    return run_error.into_response();
                }
            }
        }
    }

    last_error
        .map(RunError::into_response)
        .unwrap_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "ACP request failed"))
}

static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[cfg(test)]
mod tests;
