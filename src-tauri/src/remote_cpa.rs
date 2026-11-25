//! Verified CPA target selection and revision-scoped remote requests.
use reqwest::{header, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};
use tokio::sync::Mutex;

#[path = "config_document.rs"]
pub(crate) mod config_document;

const PROFILE_FILE: &str = "remote-cpa.json";
const VERSION_PATH: &str = "config/config-version";
const KEYS_PATH: &str = "config/access/api-keys";
const RESPONSE_LIMIT: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteError {
    InvalidEndpoint,
    InvalidKey,
    KeyRequired,
    ProfileInvalid,
    ProfileWrite,
    Busy,
    NotActive,
    StopFailed,
    StartFailed,
    RollbackFailed,
    ManagedTarget,
    EndpointChanged,
    NotAuthorized,
    Unreachable,
    Transport,
    Redirect,
    Unsupported,
    ServerRejected,
    InvalidResponse,
    Conflict,
    InvalidKeys,
    KeyMatchesManagement,
    SaveUnconfirmed,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
enum Profile {
    Local,
    Remote { endpoint: String, key: String },
}

// Only the native state owns the persisted management key and the config ETag.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstanceBook {
    #[serde(default)]
    start_builtin: bool,
    active: Option<String>,
    instances: std::collections::BTreeMap<String, String>,
}

impl InstanceBook {
    fn select(&mut self, profile: &Profile) {
        self.start_builtin = false;
        self.active = match profile {
            Profile::Local => None,
            Profile::Remote { endpoint, key } => {
                self.instances.insert(endpoint.clone(), key.clone());
                Some(endpoint.clone())
            }
        };
    }
    fn profile(&self) -> Result<Profile, RemoteError> {
        match &self.active {
            None => Ok(Profile::Local),
            Some(endpoint) => Ok(Profile::Remote { endpoint: endpoint.clone(), key: self.instances.get(endpoint).ok_or(RemoteError::ProfileInvalid)?.clone() }),
        }
    }
}

struct Selection {
    book: InstanceBook,
    profile: Result<Profile, RemoteError>,
    revision: u32,
    keys_etag: Option<(u32, header::HeaderValue)>,
    next_snapshot: u32,
    config_verification_revision: Option<u32>,
    config_listener_restart_pid: Option<u32>,
}

pub(crate) struct RemoteCpaState {
    path: Option<PathBuf>,
    pub(crate) remote_launch: bool,
    pub(crate) external_dispatch: std::sync::atomic::AtomicBool,
    selection: Mutex<Selection>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionView {
    remote_active: bool,
    remote_selected: bool,
    endpoint: Option<String>,
    saved_endpoints: Vec<String>,
    needs_repair: bool,
    revision: u32,
}

impl RemoteCpaState {
    pub(crate) fn load() -> Self {
        Self::from_path(
            crate::gui_config_path()
                .ok()
                .map(|path| path.with_file_name(PROFILE_FILE)),
        )
    }

    fn from_path(path: Option<PathBuf>) -> Self {
        let book = path
            .as_deref()
            .ok_or(RemoteError::ProfileInvalid)
            .and_then(read_profile);
        let profile = book.as_ref().map_err(|err| *err).and_then(InstanceBook::profile);
        let remote_launch = !matches!(profile, Ok(Profile::Local));
        Self {
            path,
            remote_launch,
            external_dispatch: std::sync::atomic::AtomicBool::new(remote_launch),
            selection: Mutex::new(Selection {
                book: book.unwrap_or_default(),
                profile,
                revision: 0,
                keys_etag: None,
                next_snapshot: 0,
                config_verification_revision: None,
                config_listener_restart_pid: None,
            }),
        }
    }

    pub(crate) fn uses_external_dispatch(&self) -> bool {
        self.remote_launch
            || self
                .external_dispatch
                .load(std::sync::atomic::Ordering::Acquire)
    }

    pub(crate) fn take_builtin_start(&mut self) -> Result<bool, RemoteError> {
        let selection = self.selection.get_mut();
        if !matches!(selection.profile, Ok(Profile::Local)) || !selection.book.start_builtin { return Ok(false); }
        let mut book = selection.book.clone();
        book.start_builtin = false;
        write_profile(self.path.as_deref().ok_or(RemoteError::ProfileWrite)?, &book)?;
        selection.book = book;
        Ok(true)
    }

    fn persist(
        &self,
        selection: &mut Selection,
        profile: Profile,
    ) -> Result<ConnectionView, RemoteError> {
        let mut book = selection.book.clone();
        book.select(&profile);
        book.start_builtin = self.remote_launch && matches!(profile, Profile::Local);
        write_profile(
            self.path.as_deref().ok_or(RemoteError::ProfileWrite)?,
            &book,
        )?;
        selection.book = book;
        self.external_dispatch.store(!matches!(profile, Profile::Local), std::sync::atomic::Ordering::Release);
        selection.profile = Ok(profile);
        selection.revision = selection.revision.wrapping_add(1);
        selection.keys_etag = None;
        Ok(self.view(selection))
    }

    fn view(&self, selection: &Selection) -> ConnectionView {
        ConnectionView {
            remote_active: !matches!(selection.profile, Ok(Profile::Local)),
            remote_selected: !matches!(selection.profile, Ok(Profile::Local)),
            endpoint: match selection.profile.as_ref() {
                Ok(Profile::Remote { endpoint, .. }) => Some(endpoint.clone()),
                _ => None,
            },
            saved_endpoints: selection.book.instances.keys().cloned().collect(),
            needs_repair: selection.profile.is_err(),
            revision: selection.revision,
        }
    }
}

fn read_profile(path: &Path) -> Result<InstanceBook, RemoteError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(InstanceBook::default()),
        Err(_) => return Err(RemoteError::ProfileInvalid),
    };
    let book = match serde_json::from_slice::<InstanceBook>(&bytes) {
        Ok(book) => book,
        Err(_) => {
            let profile: Profile = serde_json::from_slice(&bytes).map_err(|_| RemoteError::ProfileInvalid)?;
            let mut book = InstanceBook::default();
            book.select(&profile);
            book
        }
    };
    let mut normalized = InstanceBook::default();
    for (endpoint, key) in &book.instances {
        let target = Target::new(endpoint, key).map_err(|_| RemoteError::ProfileInvalid)?;
        if normalized.instances.insert(target.endpoint.to_string(), key.trim().to_owned()).is_some() { return Err(RemoteError::ProfileInvalid); }
    }
    normalized.start_builtin = book.start_builtin;
    normalized.active = book.active.as_deref().map(parse_endpoint).transpose()?.map(|url| url.to_string());
    normalized.profile()?;
    Ok(normalized)
}

fn write_profile(path: &Path, profile: &InstanceBook) -> Result<(), RemoteError> {
    let bytes = serde_json::to_vec(profile).map_err(|_| RemoteError::ProfileWrite)?;
    let nonce = getrandom::u64().map_err(|_| RemoteError::ProfileWrite)?;
    let temporary = path.with_file_name(format!(".{PROFILE_FILE}.{nonce:016x}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| RemoteError::ProfileWrite)?;
    let written = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    let result =
        written.and_then(|_| crate::core_config::replace_file_atomically(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| RemoteError::ProfileWrite)
}

fn parse_endpoint(raw: &str) -> Result<Url, RemoteError> {
    let raw = raw.trim();
    let (scheme, rest) = raw.split_once("://").ok_or(RemoteError::InvalidEndpoint)?;
    let authority = rest.split('/').next().unwrap_or_default();
    if raw.len() > 2048
        || !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
        || authority.is_empty()
        || raw.contains(['\\', '?', '#', '@', '%'])
        || raw.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(RemoteError::InvalidEndpoint);
    }
    // Permit ordinary reverse-proxy subpaths, but never accept a complete API
    // route or paths URL parsing could normalize to a different destination.
    if let Some((_, path)) = rest.split_once('/') {
        if path.starts_with('/') {
            return Err(RemoteError::InvalidEndpoint);
        }
        let path = path.strip_suffix('/').unwrap_or(path);
        if !path.is_empty()
            && (path.ends_with("v8/management")
                || path.ends_with("v0/management")
                || path.split('/').any(|segment| {
                    segment.is_empty()
                        || matches!(segment, "." | "..")
                        || !segment
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
                }))
        {
            return Err(RemoteError::InvalidEndpoint);
        }
    }
    let mut url = Url::parse(raw).map_err(|_| RemoteError::InvalidEndpoint)?;
    let host = url.host_str().ok_or(RemoteError::InvalidEndpoint)?;
    let v4 = host.parse::<Ipv4Addr>().ok();
    let v6 = host.trim_matches(['[', ']']).parse::<Ipv6Addr>().ok();
    if url.port() == Some(0)
        || v4.is_some_and(|ip| ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast())
        || v6.is_some_and(|ip| ip.is_unspecified() || ip.is_multicast())
    {
        return Err(RemoteError::InvalidEndpoint);
    }
    let base = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&base);
    Ok(url)
}

#[derive(Clone)]
pub(crate) struct Target {
    endpoint: Url,
    auth: header::HeaderValue,
}

impl Target {
    pub(crate) fn usage_id(&self) -> String { crate::sha256_bytes(self.endpoint.as_str().as_bytes()) }

    pub(crate) fn new(endpoint: &str, key: &str) -> Result<Self, RemoteError> {
        let endpoint = parse_endpoint(endpoint)?;
        let key = key.trim();
        if key.is_empty() {
            return Err(RemoteError::KeyRequired);
        }
        if key.len() > 1024
            || crate::is_hashed_management_secret_key(key)
            || !key.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(RemoteError::InvalidKey);
        }
        let mut auth = header::HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| RemoteError::InvalidKey)?;
        auth.set_sensitive(true);
        Ok(Self { endpoint, auth })
    }

    async fn send(
        &self,
        method: reqwest::Method,
        route: &'static str,
        replacement: Option<(&[String], header::HeaderValue)>,
    ) -> Result<reqwest::Response, RemoteError> {
        let mut request = self.request(method, route)?;
        if let Some((keys, etag)) = replacement {
            request = request.header(header::IF_MATCH, etag).json(keys);
        }
        request.send().await.map_err(|error| {
            if error.is_timeout() || error.is_connect() && self.endpoint.scheme() == "http" {
                RemoteError::Unreachable
            } else {
                RemoteError::Transport
            }
        })
    }

    pub(crate) fn request(
        &self,
        method: reqwest::Method,
        route: &str,
    ) -> Result<reqwest::RequestBuilder, RemoteError> {
        static CLIENT: LazyLock<Result<Client, reqwest::Error>> = LazyLock::new(|| {
            Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .resolve_to_addrs(
                    "localhost",
                    &[
                        SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                        SocketAddr::from((Ipv6Addr::LOCALHOST, 0)),
                    ],
                )
                .connect_timeout(Duration::from_secs(4))
                .timeout(Duration::from_secs(10))
                .build()
        });
        let url = self
            .endpoint
            .join(&format!("v8/management/{route}"))
            .map_err(|_| RemoteError::InvalidEndpoint)?;
        let client = CLIENT.as_ref().map_err(|_| RemoteError::Transport)?;
        Ok(client
            .request(method, url)
            .header(header::AUTHORIZATION, self.auth.clone()))
    }
}

impl RemoteCpaState {
    pub(crate) async fn usage_target(&self, revision: Option<u32>) -> Result<Option<Target>, String> {
        let selection = self.selection.lock().await;
        if revision.is_some_and(|revision| revision != selection.revision) { return Err("CPA target changed".into()); }
        match &selection.profile {
            Ok(Profile::Local) => Ok(None),
            Ok(Profile::Remote { endpoint, key }) => Target::new(endpoint, key).map(Some).map_err(|_| "Invalid CPA instance".into()),
            Err(_) => Err("Invalid CPA instance".into()),
        }
    }

    pub(crate) async fn is_remote(&self) -> bool {
        !matches!(self.selection.lock().await.profile, Ok(Profile::Local))
    }

    pub(crate) async fn workspace_request(
        &self,
        method: reqwest::Method,
        path: &str,
        revision: u32,
    ) -> Result<reqwest::RequestBuilder, String> {
        let route = path.trim_start_matches('/');
        let valid_segments = route.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        });
        if !valid_segments {
            return Err("Unsupported remote management route".into());
        }
        let selected = self.selection.lock().await;
        current_target(true, &selected, revision).map_err(|_| "Remote connection changed")?
            .request(method, route).map_err(|_| "Invalid remote request".into())
    }
}

#[derive(Default, Serialize, Deserialize)]
struct TargetRemarks {
    client_keys: std::collections::BTreeMap<String, String>,
    providers: Vec<crate::GuiApiAccessRemark>,
}

impl TargetRemarks {
    fn load(path: &Path) -> Result<Self, String> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Invalid target remarks file".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error.to_string()),
        }
    }
    fn save(&self, path: &Path) -> Result<(), String> {
        crate::write_bytes_atomically(path, &serde_json::to_vec(self).map_err(|error| error.to_string())?)
    }
}

fn remote_settings_view(document: &serde_norway::Value) -> Result<crate::CoreConfigView, String> {
    let settings = crate::core_config_settings_from_value(document)?;
    let mut gui = crate::GuiConfigFile::default();
    crate::apply_core_settings_to_gui_config(&mut gui, &settings);
    gui.proxy_url = settings.proxy_url.clone();
    gui.proxy_override = !gui.proxy_url.is_empty();
    gui.api_keys = settings.api_keys.iter().map(|key| crate::GuiApiKeyEntry { key: key.clone(), remark: String::new() }).collect();
    let mut view = crate::CoreConfigView::from(&gui);
    view.management_secret_configured = settings.management_secret_configured;
    Ok(view)
}

#[tauri::command]
pub(crate) async fn remote_core_settings(app: tauri::AppHandle, state: tauri::State<'_, RemoteCpaState>, revision: u32, operation: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let result = remote_settings_operation(&state, revision, &operation, args).await;
    if operation == "set_core_management_secret_key" { crate::usage::switch_collector(&app); }
    result
}

type FieldEdit = (String, Option<serde_json::Value>);
fn setting_fields(operation: &str) -> Option<&'static [(&'static str, &'static str)]> {
    Some(match operation {
        "set_core_routing_strategy" => &[("routingStrategy", "routing/strategy")],
        "save_core_logging_settings" => &[("commercialMode","server/commercial-mode"),("debug","observability/logs/debug"),("loggingToFile","observability/logs/logging-to-file"),("logsMaxTotalSizeMb","observability/logs/logs-max-total-size-mb"),("errorLogsMaxFiles","observability/logs/error-logs-max-files"),("usageStatisticsEnabled","observability/usage/usage-statistics-enabled"),("redisUsageQueueRetentionSeconds","observability/usage/redis-usage-queue-retention-seconds")],
        "save_retry_settings" => &[("disableCooling","routing/cooldown/disable-cooling"),("requestRetry","routing/retry/request-retry"),("maxRetryCredentials","routing/retry/max-retry-credentials"),("maxRetryInterval","routing/retry/max-retry-interval"),("streamingBootstrapRetries","requests/streaming/bootstrap-retries")],
        "save_session_routing_settings" => &[("routingSessionAffinity","routing/session-affinity"),("routingSessionAffinityTtl","routing/session-affinity-ttl")],
        "save_network_endpoint_settings" => &[("host","server/host"),("port","server/port"),("proxyUrl","requests/proxy-url")],
        "save_core_tls_settings" => &[("enabled","server/tls/enable"),("cert","server/tls/cert"),("key","server/tls/key")],
        "save_core_sensitive_words_settings" => &[("antigravitySensitiveWords","oauth/providers/antigravity/sensitive-words"),("devinSensitiveWords","oauth/providers/devin/sensitive-words"),("antigravitySensitiveWordsReplace","oauth/providers/antigravity/sensitive-words-replace"),("devinSensitiveWordsReplace","oauth/providers/devin/sensitive-words-replace")],
        _ => return None,
    })
}

async fn config_resource(target: &Target, route: &str) -> Result<reqwest::Response, String> {
    target.request(reqwest::Method::GET, route).map_err(|_| "Invalid configuration route")?.send().await.map_err(|_| "Cannot reach selected CPA".into())
}

async fn settings_snapshot(target: &Target) -> Result<(String, header::HeaderValue), String> {
    let mut response = config_resource(target, "config").await?;
    if matches!(response.status(), StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED) { response = config_resource(target, "config.yaml").await?; }
    if !response.status().is_success() { return Err(format!("Cannot read settings: HTTP {}", response.status())); }
    let etag = config_etag(&response).map_err(|_| "Missing configuration version")?;
    Ok((crate::read_management_text(response).await?, etag))
}

fn config_changes(path: &str, before: Option<&serde_json::Value>, after: Option<&serde_json::Value>, edits: &mut Vec<FieldEdit>) {
    if before == after { return; }
    if let (Some(serde_json::Value::Object(old)), Some(serde_json::Value::Object(new))) = (before, after) {
        for key in old.keys().chain(new.keys().filter(|key| !old.contains_key(*key))) {
            let escaped = key.replace('~', "~0").replace('/', "~1");
            let child = if path.is_empty() { escaped } else { format!("{path}/{escaped}") };
            config_changes(&child, old.get(key), new.get(key), edits);
        }
    } else { edits.push((path.to_owned(), after.cloned())); }
}

fn assign_field(root: &mut serde_json::Value, path: &str, value: Option<&serde_json::Value>) -> Result<(), String> {
    let mut parent = root;
    let mut parts = path.split('/').peekable();
    while let Some(part) = parts.next() {
        let key = part.replace("~1", "/").replace("~0", "~");
        let map = parent.as_object_mut().ok_or("Invalid configuration path")?;
        if parts.peek().is_none() {
            if let Some(value) = value { map.insert(key, value.clone()); } else { map.remove(&key); }
            break;
        }
        parent = map.entry(key).or_insert_with(|| serde_json::json!({}));
    }
    Ok(())
}

async fn write_setting_changes(target: &Target, etag: &header::HeaderValue, edits: &[FieldEdit]) -> Result<(), String> {
    use reqwest::Method;
    let safe_path = |path: &str| path.split('/').all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')));
    let mut request = None;
    if let [(path, value)] = edits {
        if safe_path(path) {
            let builder = target.request(if value.is_some() { Method::PUT } else { Method::DELETE }, &format!("config/{path}")).map_err(|_| "Invalid setting route")?;
            request = Some(if let Some(value) = value { builder.json(value) } else { builder });
        }
    } else if edits.iter().all(|(_, value)| value.as_ref().is_some_and(|value| !value.is_object())) {
        let mut patch = serde_json::json!({});
        for (path, value) in edits { assign_field(&mut patch, path, value.as_ref())?; }
        request = Some(target.request(Method::PATCH, "config").map_err(|_| "Invalid configuration route")?.json(&patch));
    }
    if request.is_none() && edits.len() > 1 && edits.iter().all(|(path, _)| safe_path(path)) {
        let mut version = etag.clone();
        let mut saved: Vec<&str> = Vec::new();
        for (index, (path, value)) in edits.iter().enumerate() {
            let pending = edits[index..].iter().map(|(path,_)| path.as_str()).collect::<Vec<_>>();
            let builder = target.request(if value.is_some() { Method::PUT } else { Method::DELETE }, &format!("config/{path}")).map_err(|_| "Invalid field route")?;
            let builder = if let Some(value) = value { builder.json(value) } else { builder };
            let response = builder.header(header::IF_MATCH,&version).send().await.map_err(|_| format!("Saved: {saved:?}; unconfirmed: {path}; not attempted: {:?}. Reconnect and refresh", &pending[1..]))?;
            if !response.status().is_success() {
                if saved.is_empty() && matches!(response.status(), StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED) { break; }
                return Err(format!("Saved: {saved:?}; rejected: {path} (HTTP {}); not attempted: {:?}. Refresh before retrying", response.status(), &pending[1..]));
            }
            saved.push(path);
            if index + 1 == edits.len() { return Ok(()); }
            version = config_etag(&response).map_err(|_| format!("Saved: {saved:?}; did not attempt {:?} without the new version", &pending[1..]))?;
        }
    }
    if let Some(request) = request {
        let response = request.header(header::IF_MATCH, etag).send().await.map_err(|_| "Connection interrupted; save outcome unknown. Check the instance address and refresh")?;
        if response.status().is_success() {
            if let [(path, Some(value))] = edits {
                let response = config_resource(target, &format!("config/{path}")).await.map_err(|_| "Update accepted but field readback unavailable")?;
                if !response.status().is_success() || response.json::<serde_json::Value>().await.ok().as_ref() != Some(value) { return Err("Update accepted but field readback could not be confirmed".into()); }
            }
            return Ok(());
        }
        if !matches!(response.status(), StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED) { return Err(format!("CPA rejected update: HTTP {}. Refresh settings before retrying", response.status())); }
    }
    let response = config_resource(target, "config.yaml").await?;
    if !response.status().is_success() || config_etag(&response).as_ref() != Ok(etag) { return Err("Cannot confirm original configuration; refresh before saving".into()); }
    let mut raw: serde_json::Value = serde_norway::from_str(&crate::read_management_text(response).await?).map_err(|_| "Invalid CPA YAML")?;
    for (path, value) in edits { assign_field(&mut raw, path, value.as_ref())?; }
    let response = target.request(Method::PUT, "config.yaml").map_err(|_| "Invalid endpoint")?.header(header::IF_MATCH, etag).header(header::CONTENT_TYPE,"application/yaml").body(serde_norway::to_string(&raw).map_err(|_| "Invalid CPA document")?).send().await.map_err(|_| "Configuration save unconfirmed; check the instance address before retrying")?;
    if response.status().is_success() { Ok(()) } else { Err(format!("CPA rejected conditional document update: HTTP {}", response.status())) }
}

async fn remote_settings_operation(state: &RemoteCpaState, revision: u32, operation: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    use crate::*;
    let mut selection = state.selection.lock().await;
    let target = current_target(true, &selection, revision).map_err(|_| "CPA target changed")?;
    let remarks_path = state.path.as_ref().ok_or("Missing target profile path")?.with_file_name(format!("remote-remarks-{}.json", sha256_bytes(target.endpoint.as_str().as_bytes())));
    let mut remarks = TargetRemarks::load(&remarks_path)?;
    if operation == "resolve_api_access_remarks" || operation == "save_api_access_remark" {
        let mut config = GuiConfigFile { api_access_remarks: remarks.providers, ..GuiConfigFile::default() };
        if operation == "resolve_api_access_remarks" {
            let queries: Vec<ApiAccessRemarkQuery> = serde_json::from_value(args["queries"].clone()).map_err(|_| "Invalid remark query")?;
            let result = queries.iter().map(|query| resolve_api_access_remark(&config, query)).collect::<Result<Vec<_>, _>>()?;
            return Ok(serde_json::json!(result));
        }
        app_settings::apply_api_access_remark_update(&mut config, serde_json::from_value(args["update"].clone()).map_err(|_| "Invalid remark update")?)?;
        remarks.providers = config.api_access_remarks;
        remarks.save(&remarks_path)?;
        return Ok(serde_json::Value::Null);
    }
    if operation == "set_core_management_secret_key" || operation == "clear_core_management_secret_key" {
        let clear = operation == "clear_core_management_secret_key";
        let key = if clear { "" } else { args["secretKey"].as_str().ok_or("Missing new management key")?.trim() };
        let (keys, etag) = load_keys(&target).await.map_err(|_| "Cannot verify current management access")?;
        if keys.iter().any(|client_key| client_key == key) { return Err("A client key cannot be the management key".into()); }
        let cleared_view = if clear {
            let (content, version) = settings_snapshot(&target).await?;
            if version != etag { return Err("Configuration changed; refresh before disabling management".into()); }
            let mut view = remote_settings_view(&serde_norway::from_str(&content).map_err(|_| "Invalid CPA settings")?)?;
            view.management_secret_configured = false;
            Some(serde_json::to_value(view).map_err(|e| e.to_string())?)
        } else { None };
        let replacement = if clear { None } else { Some(Target::new(target.endpoint.as_str(), key).map_err(|_| "Invalid new management key")?) };
        let response = target.request(reqwest::Method::PUT, "config/management/secret-key").map_err(|_| "Invalid endpoint")?.header(header::IF_MATCH, etag).json(key).send().await.map_err(|_| "Connection interrupted during credential change; verify the new key before retrying")?;
        if !response.status().is_success() { return Err(format!("CPA rejected management credential change: HTTP {}", response.status())); }
        let Some(replacement) = replacement else { return cleared_view.ok_or("Could not confirm management disable request".into()); };
        let mut verified = false;
        for _ in 0..5 { if check_target(&replacement).await.is_ok() { verified = true; break; } tokio::time::sleep(Duration::from_millis(250)).await; }
        if !verified { return Err("CPA accepted the new key but reconnection is unconfirmed. Verify access using the new key".into()); }
        let profile = Profile::Remote { endpoint: replacement.endpoint.to_string(), key: key.to_owned() };
        let mut book = selection.book.clone(); book.select(&profile);
        write_profile(state.path.as_deref().ok_or("Missing instance profile")?, &book).map_err(|_| "New key verified, but could not save it on this computer")?;
        selection.book = book; selection.profile = Ok(profile); selection.keys_etag = None;
        drop(selection);
        let (content, _) = settings_snapshot(&replacement).await.map_err(|_| "New key verified and saved; refresh settings")?;
        let doc = serde_norway::from_str(&content).map_err(|_| "Invalid CPA settings")?;
        let mut view = remote_settings_view(&doc)?;
        for entry in &mut view.api_keys { entry.remark = remarks.client_keys.get(&sha256_bytes(entry.api_key.as_bytes())).cloned().unwrap_or_default(); }
        return serde_json::to_value(view).map_err(|e| e.to_string());
    }
    if matches!(operation, "get_core_tls_settings" | "get_core_sensitive_words_settings") {
        let paths: &[&str] = if operation == "get_core_tls_settings" { &["server/tls"] } else { &["oauth/providers/antigravity/sensitive-words", "oauth/providers/antigravity/sensitive-words-replace", "oauth/providers/devin/sensitive-words", "oauth/providers/devin/sensitive-words-replace"] };
        let mut doc = serde_json::json!({"config-version":8});
        let mut version = None;
        let mut complete = true;
        for path in paths {
            let response = config_resource(&target,&format!("config/{path}")).await?;
            if response.status() == StatusCode::NOT_FOUND {
                if response.json::<serde_json::Value>().await.ok().is_some_and(|body| body["error"] == "not_found") { continue; }
                complete = false; break;
            }
            if response.status() == StatusCode::METHOD_NOT_ALLOWED { complete = false; break; }
            if !response.status().is_success() { return Err(format!("Cannot read setting: HTTP {}",response.status())); }
            let tag = config_etag(&response).map_err(|_| "Missing configuration version")?;
            if version.as_ref().is_some_and(|previous| previous != &tag) { return Err("Settings changed while reading; refresh".into()); }
            version = Some(tag);
            let value = response.json().await.map_err(|_| "Invalid settings response")?;
            assign_field(&mut doc,path,Some(&value))?;
        }
        if complete {
            let document = serde_norway::to_value(doc).map_err(|_| "Invalid settings response")?;
            return (if operation == "get_core_tls_settings" { serde_json::to_value(core_tls_settings_from_value(&document)?) } else { serde_json::to_value(core_sensitive_words_settings_from_value(&document)?) }).map_err(|e| e.to_string());
        }
    }
    let read = || settings_snapshot(&target);
    let (content, etag) = read().await?;
    let parse = |content: &str| serde_norway::from_str::<serde_norway::Value>(content).map_err(|_| "Invalid CPA YAML".to_string());
    let mut document = parse(&content)?;
    let settings = core_config_settings_from_value(&document)?;
    if contains_management_key(&selection, &settings.api_keys) { return Err("Management credential cannot be a client key".into()); }
    let mut gui = GuiConfigFile::default();
    apply_core_settings_to_gui_config(&mut gui, &settings);
    gui.proxy_url = settings.proxy_url.clone();
    let live = match operation {
        "save_core_tls_settings" => serde_json::to_value(core_tls_settings_from_value(&document)?),
        "save_core_sensitive_words_settings" => serde_json::to_value(core_sensitive_words_settings_from_value(&document)?),
        _ => serde_json::to_value(remote_settings_view(&document)?),
    }.map_err(|e| e.to_string())?;
    let mut input = args["settings"].clone();
    if let Some(values) = input.as_object_mut() { for (key, value) in values {
        if let Some(original) = args["expected"].get(key) {
            if value == original { *value = live[key].clone(); }
            else if original != &live[key] && value != &live[key] { return Err(format!("Setting {key} changed; refresh before saving")); }
        }
    } }
    let invalid = |_| "Invalid CPA settings".to_string();
    let mut extended_result = None;
    let updated = match operation {
        "get_core_config_settings" | "get_core_tls_settings" | "get_core_sensitive_words_settings" => None,
        "get_extended_core_config" => return extended_config_view(&document),
        "save_extended_core_config" => {
            let changes: Vec<ExtendedConfigChange> = serde_json::from_value(args["changes"].clone()).map_err(invalid)?;
            let (updated, result) = prepare_extended_patch(&content, &changes)?;
            extended_result = Some(serde_json::to_value(result).map_err(invalid)?);
            (updated != content).then_some(updated)
        }
        "save_core_tls_settings" => patch_core_tls_settings_yaml(&content, &serde_json::from_value(input.clone()).map_err(invalid)?)?,
        "save_core_sensitive_words_settings" => patch_core_sensitive_words_yaml(&content, &serde_json::from_value(input.clone()).map_err(invalid)?)?,
        "save_core_logging_settings" => {
            let value: CoreLoggingSettingsInput = serde_json::from_value(input.clone()).map_err(invalid)?;
            let mut next = settings;
            next.debug = value.debug; next.commercial_mode = value.commercial_mode; next.logging_to_file = value.logging_to_file;
            next.logs_max_total_size_mb = value.logs_max_total_size_mb; next.error_logs_max_files = value.error_logs_max_files;
            next.usage_statistics_enabled = value.usage_statistics_enabled; next.redis_usage_queue_retention_seconds = value.redis_usage_queue_retention_seconds;
            patch_core_yaml_document(&content, |doc| apply_core_logging_settings(doc, &next))?
        }
        "save_network_endpoint_settings" => {
            let value: GuiNetworkEndpointSettings = serde_json::from_value(input.clone()).map_err(invalid)?;
            gui.host = value.host; gui.port = value.port; gui.allow_lan = !is_loopback_host(&gui.host);
            if let Some(proxy) = value.proxy_url { gui.proxy_url = proxy; }
            patch_core_network_endpoint_yaml(&content, &gui)?
        }
        "save_retry_settings" => {
            let value: GuiRetrySettings = serde_json::from_value(input.clone()).map_err(invalid)?;
            gui.disable_cooling = value.disable_cooling; gui.request_retry = value.request_retry; gui.max_retry_credentials = value.max_retry_credentials;
            gui.max_retry_interval = value.max_retry_interval; gui.streaming_bootstrap_retries = value.streaming_bootstrap_retries;
            patch_core_retry_yaml(&content, &gui)?
        }
        "save_session_routing_settings" => {
            let value: GuiSessionRoutingSettings = serde_json::from_value(input.clone()).map_err(invalid)?;
            gui.routing_session_affinity = value.routing_session_affinity; gui.routing_session_affinity_ttl = normalize_session_affinity_ttl(value.routing_session_affinity_ttl)?;
            patch_core_session_routing_yaml(&content, &gui)?
        }
        "set_core_routing_strategy" => {
            let strategy = args["strategy"].as_str().ok_or("Missing strategy")?;
            patch_core_yaml_document(&content, |doc| set_core_yaml_nested_value(doc, "routing", "strategy", serde_norway::Value::String(strategy.into())))?
        }
        "add_core_api_key" | "update_core_api_key" | "delete_core_api_key" => {
            let remark = args["remark"].as_str().unwrap_or("").trim();
            if remark.chars().count() > 80 { return Err("Client key remark is too long".into()); }
            let key = args["apiKey"].as_str().ok_or("Missing client key")?.trim();
            let (mut keys, key_etag) = load_keys(&target).await.map_err(|_| "Cannot read client keys")?;
            if key_etag != etag { return Err("Client keys changed; reload before saving".into()); }
            if operation == "add_core_api_key" { keys.push(key.to_owned()); } else {
                let old = if operation == "update_core_api_key" { args["originalApiKey"].as_str().ok_or("Missing original key")? } else { key };
                let index = keys.iter().position(|item| item == old).ok_or("Client key changed")?;
                if operation == "delete_core_api_key" { keys.remove(index); } else { keys[index] = key.to_owned(); }
            }
            let keys = normalize_keys(keys).map_err(|_| "Invalid client keys")?;
            if contains_management_key(&selection, &keys) { return Err("Management credential cannot be a client key".into()); }
            save_keys(&target, key_etag, &keys).await.map_err(|_| "Client key save failed; reload the configuration")?;
            if load_keys(&target).await.map_err(|_| "Client keys saved; readback unavailable")?.0 != keys { return Err("Client keys changed during verification".into()); }
            remarks.client_keys.retain(|hash, _| keys.iter().any(|value| sha256_bytes(value.as_bytes()) == *hash));
            if operation != "delete_core_api_key" { remarks.client_keys.insert(sha256_bytes(key.as_bytes()), remark.to_owned()); }
            remarks.save(&remarks_path).map_err(|_| "Remote client keys saved, but the desktop remark could not be saved")?;
            document = parse(&read().await?.0)?;
            None
        }
        _ => return Err("This operation requires access to the CPA host".into()),
    };
    if let Some(updated) = updated {
        let before = serde_json::to_value(&document).map_err(|e| e.to_string())?;
        let after = serde_json::to_value(parse(&updated)?).map_err(|e| e.to_string())?;
        let mut edits = Vec::new();
        if let Some(fields) = setting_fields(operation) {
            for &(name, path) in fields {
                let desired = if name == "routingStrategy" { &args["strategy"] } else { &input[name] };
                if desired.is_null() || desired == &live[name] { continue; }
                if let Some(original) = args["expected"].get(name) { if original != &live[name] { return Err(format!("Setting {name} changed; refresh before saving")); } }
                edits.push((path.to_string(), after.pointer(&format!("/{path}")).cloned()));
            }
        } else { config_changes("", Some(&before), Some(&after), &mut edits); }
        if !edits.is_empty() {
            write_setting_changes(&target, &etag, &edits).await?;
            document = parse(&read().await.map_err(|_| "Configuration accepted; could not reach the selected CPA for verification")?.0)?;
            let verified = serde_json::to_value(&document).map_err(|e| e.to_string())?;
            for (path, value) in &edits { if verified.pointer(&format!("/{path}")) != value.as_ref() { return Err(format!("CPA accepted update but could not confirm {path}; refresh settings")); } }
        }
    }
    if let Some(result) = extended_result { return Ok(result); }
    match operation {
        "get_core_tls_settings" | "save_core_tls_settings" => serde_json::to_value(core_tls_settings_from_value(&document)?),
        "get_core_sensitive_words_settings" | "save_core_sensitive_words_settings" => serde_json::to_value(core_sensitive_words_settings_from_value(&document)?),
        _ => {
            let mut view = remote_settings_view(&document)?;
            for entry in &mut view.api_keys { entry.remark = remarks.client_keys.get(&sha256_bytes(entry.api_key.as_bytes())).cloned().unwrap_or_default(); }
            serde_json::to_value(view)
        }
    }.map_err(|error| error.to_string())
}

tokio::task_local! { pub(crate) static AGENT_ORIGIN: String; }

tokio::task_local! { pub(crate) static AGENT_CONFIG: crate::GuiConfigFile; }

impl RemoteCpaState {
    pub(crate) async fn management_operation<T>(&self, revision: Option<u32>, work: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
        let selection = self.selection.lock().await;
        match &selection.profile {
            Ok(Profile::Local) if revision.is_none() => work.await,
            Ok(Profile::Remote { endpoint, key }) if revision == Some(selection.revision) => {
                let target = Target::new(endpoint, key).map_err(|_| "Invalid CPA endpoint")?;
                let config = crate::GuiConfigFile { port: target.endpoint.port_or_known_default().ok_or("Invalid CPA port")?, management_secret_key: key.clone(), ..Default::default() };
                AGENT_CONFIG.scope(config, AGENT_ORIGIN.scope(endpoint.trim_end_matches('/').to_owned(), work)).await
            }
            _ => Err("CPA target changed; reopen the operation".into()),
        }
    }

    pub(crate) async fn agent_operation<T>(&self, revision: Option<u32>, requested_key: Option<String>, operation: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
        let selection = self.selection.lock().await;
        if matches!(selection.profile, Ok(Profile::Local)) && revision.is_none() && !self.remote_launch {
            drop(selection);
            return operation.await;
        }
        let target = current_target(true, &selection, revision.ok_or("CPA target changed")?).map_err(|_| "CPA target changed")?;
        let (mut keys, _) = load_keys(&target).await.map_err(|_| "Unable to read remote client keys")?;
        if contains_management_key(&selection, &keys) { return Err("Management key cannot be a client key".into()); }
        if let Some(key) = requested_key.filter(|value| !value.is_empty()) {
            let position = keys.iter().position(|value| value == &key).ok_or("Select a current remote client key")?;
            keys.swap(0, position);
        }
        if keys.is_empty() { return Err("Configure a remote client key first".into()); }
        let mut config = crate::GuiConfigFile::default();
        config.api_keys = keys.into_iter().map(|key| crate::GuiApiKeyEntry { key, remark: String::new() }).collect();
        config.port = target.endpoint.port_or_known_default().ok_or("Invalid remote port")?;
        config.management_secret_key = match &selection.profile { Ok(Profile::Remote {key, ..}) => key.clone(), _ => return Err("CPA target changed".into()) };
        let origin = target.endpoint.as_str().trim_end_matches('/').to_owned();
        crate::usage::USAGE_TARGET.scope(Some(target), AGENT_CONFIG.scope(config, AGENT_ORIGIN.scope(origin, operation))).await
    }
}

fn check_status(status: StatusCode) -> Result<(), RemoteError> {
    match status {
        StatusCode::OK => Ok(()),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
            Err(RemoteError::NotAuthorized)
        }
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => Err(RemoteError::Unsupported),
        StatusCode::PRECONDITION_FAILED => Err(RemoteError::Conflict),
        status if status.is_redirection() => Err(RemoteError::Redirect),
        _ => Err(RemoteError::ServerRejected),
    }
}

async fn read_json<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T, RemoteError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RemoteError::InvalidResponse)?
    {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(RemoteError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| RemoteError::InvalidResponse)
}

fn config_etag(response: &reqwest::Response) -> Result<header::HeaderValue, RemoteError> {
    let value = response
        .headers()
        .get(header::ETAG)
        .ok_or(RemoteError::Unsupported)?;
    let text = value.to_str().map_err(|_| RemoteError::Unsupported)?;
    if text.len() != 66
        || !text.starts_with('"')
        || !text.ends_with('"')
        || !text.as_bytes()[1..65].iter().all(|b| b.is_ascii_hexdigit())
    {
        return Err(RemoteError::Unsupported);
    }
    Ok(value.clone())
}

async fn check_target(target: &Target) -> Result<header::HeaderValue, RemoteError> {
    let response = target
        .send(reqwest::Method::GET, VERSION_PATH, None)
        .await?;
    check_status(response.status())?;
    let etag = config_etag(&response)?;
    if read_json::<u8>(response).await? != 8 {
        return Err(RemoteError::Unsupported);
    }
    Ok(etag)
}

async fn load_keys(target: &Target) -> Result<(Vec<String>, header::HeaderValue), RemoteError> {
    let version_etag = check_target(target).await?;
    let response = target.send(reqwest::Method::GET, KEYS_PATH, None).await?;
    // An unset field is legitimately absent in CPA. ETag from the preceding
    // version read still prevents overwriting a concurrent configuration edit.
    if response.status() == StatusCode::NOT_FOUND {
        #[derive(Deserialize)]
        struct Missing {
            error: String,
        }
        if read_json::<Missing>(response).await?.error == "not_found" {
            return Ok((vec![], version_etag));
        }
        return Err(RemoteError::Unsupported);
    }
    check_status(response.status())?;
    let etag = config_etag(&response)?;
    let keys = read_json::<Option<Vec<String>>>(response)
        .await?
        .unwrap_or_default();
    Ok((keys, etag))
}

async fn save_keys(
    target: &Target,
    etag: header::HeaderValue,
    keys: &[String],
) -> Result<(), RemoteError> {
    let response = target
        .send(reqwest::Method::PUT, KEYS_PATH, Some((keys, etag)))
        .await
        .map_err(|_| RemoteError::SaveUnconfirmed)?;
    check_status(response.status())?;
    #[derive(Deserialize)]
    struct Saved {
        status: String,
        #[serde(rename = "config-version")]
        version: u8,
    }
    let saved = read_json::<Saved>(response)
        .await
        .map_err(|_| RemoteError::SaveUnconfirmed)?;
    if saved.status != "ok" || saved.version != 8 {
        return Err(RemoteError::SaveUnconfirmed);
    }
    Ok(())
}

async fn probe_target(target: &Target) -> Result<(), RemoteError> {
    let (keys, _) = load_keys(target).await?;
    if keys
        .iter()
        .any(|key| target.auth.as_bytes().strip_prefix(b"Bearer ") == Some(key.as_bytes()))
    {
        return Err(RemoteError::KeyMatchesManagement);
    }
    Ok(())
}

fn candidate(
    selection: &Selection,
    endpoint: String,
    key: String,
) -> Result<(Target, String), RemoteError> {
    let endpoint = parse_endpoint(&endpoint)?.to_string();
    let key = if key.is_empty() {
        selection.book.instances.get(&endpoint).cloned().ok_or(RemoteError::KeyRequired)?
    } else {
        key.trim().to_owned()
    };
    Ok((Target::new(&endpoint, &key)?, key))
}

fn current_target(
    active: bool,
    selection: &Selection,
    revision: u32,
) -> Result<Target, RemoteError> {
    if selection.revision != revision {
        return Err(RemoteError::EndpointChanged);
    }
    if !active {
        return Err(RemoteError::NotActive);
    }
    match &selection.profile {
        Ok(Profile::Remote { endpoint, key }) => Target::new(endpoint, key),
        Ok(Profile::Local) => Err(RemoteError::NotActive),
        Err(error) => Err(*error),
    }
}

fn check_revision(selection: &Selection, revision: u32) -> Result<(), RemoteError> {
    if selection.revision != revision {
        Err(RemoteError::EndpointChanged)
    } else {
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn get_cpa_connection(
    state: tauri::State<'_, RemoteCpaState>,
) -> Result<ConnectionView, RemoteError> {
    let selection = state.selection.lock().await;
    Ok(state.view(&selection))
}

#[tauri::command]
pub(crate) async fn test_remote_cpa(
    state: tauri::State<'_, RemoteCpaState>,
    revision: u32,
    endpoint: String,
    key: String,
) -> Result<(), RemoteError> {
    let selection = state.selection.try_lock().map_err(|_| RemoteError::Busy)?;
    check_revision(&selection, revision)?;
    let (target, _) = candidate(&selection, endpoint, key)?;
    probe_target(&target).await
}

#[tauri::command]
pub(crate) async fn select_cpa_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteCpaState>,
    process: tauri::State<'_, crate::CoreProcessState>,
    revision: u32,
    remote: bool,
    endpoint: String,
    key: String,
) -> Result<ConnectionView, RemoteError> {
    let mut selection = state.selection.lock().await;
    check_revision(&selection, revision)?;
    if !remote && matches!(selection.profile, Ok(Profile::Local)) { return Ok(state.view(&selection)); }
    let profile = if remote {
        let (target, key) = candidate(&selection, endpoint, key)?;
        probe_target(&target).await?;
        if matches!(selection.profile, Ok(Profile::Local)) && process.managed_pid().is_some() {
            use tauri::Manager;
            let host = target.endpoint.host_str().unwrap_or("").trim_matches(['[', ']']);
            let loopback = host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
            if loopback && app.state::<crate::GuiConfigState>().snapshot().ok().is_some_and(|config| Some(config.port) == target.endpoint.port_or_known_default()) {
                return Err(RemoteError::ManagedTarget);
            }
        }
        Profile::Remote {
            endpoint: target.endpoint.to_string(),
            key,
        }
    } else {
        Profile::Local
    };
    let view = {
        let mut was_running = false;
        let _operation = if remote && matches!(selection.profile, Ok(Profile::Local)) {
            let guard = crate::lock_core_operation(process.inner()).map_err(|_| RemoteError::Busy)?;
            was_running = process.managed_pid().is_some();
            crate::stop_core_processes(process.inner(), false).map_err(|_| RemoteError::StopFailed)?;
            Some(guard)
        } else { None };
        if !remote && !state.remote_launch {
            use tauri::Manager;
            use std::sync::atomic::Ordering;
            let _guard = crate::CORE_OPERATION_LOCK.try_lock().map_err(|_| RemoteError::Busy)?;
            process.remote_selected.store(false, Ordering::Release);
            let gui = app.state::<crate::GuiConfigState>();
            let status = match crate::start_core_process_with_state(process.inner(), gui.inner()) {
                Ok(status) => status,
                Err(error) => {
                    process.remote_selected.store(true, Ordering::Release);
                    eprintln!("Could not start built-in CPA on switch: {error}");
                    return Err(RemoteError::StartFailed);
                }
            };
            let result = state.persist(&mut selection, profile);
            if result.is_err() {
                let stopped = crate::stop_core_processes(process.inner(), false);
                process.remote_selected.store(true, Ordering::Release);
                stopped.map_err(|_| RemoteError::StopFailed)?;
            } else {
                crate::usage::switch_collector(&app);
                crate::emit_core_status(&app, &status);
                app.state::<crate::acp::AcpState>().prepare_for_local();
                tauri::async_runtime::spawn(crate::acp::restore(app.clone()));
            }
            return result;
        }
        let view = state.persist(&mut selection, profile).map_err(|error| {
            if _operation.is_some() && was_running {
                use tauri::Manager;
                match crate::start_core_process_with_state(process.inner(), app.state::<crate::GuiConfigState>().inner()) {
                    Ok(status) => crate::emit_core_status(&app, &status),
                    Err(_) => return RemoteError::RollbackFailed,
                }
            }
            error
        })?;
        process.remote_selected.store(remote, std::sync::atomic::Ordering::Release);
        view
    };
    if !remote && state.remote_launch {
        use tauri::Manager;
        crate::usage::stop_usage_collector(&app);
        if let Some(guard) = app.try_state::<crate::AppInstanceGuardState>() {
            guard.release();
        }
        drop(selection);
        app.request_restart();
        // Give the main event loop a moment to exit and launch the fresh Built-in
        // CPA process without returning a view that fires Built-in IPC against this
        // dying remote-launch process.
        tokio::time::sleep(Duration::from_secs(3)).await;
    } else {
        if remote {
            use tauri::Manager;
            app.state::<crate::acp::AcpState>().suspend_for_remote();
        }
        crate::usage::switch_collector(&app);
    }
    Ok(view)
}

#[tauri::command]
pub(crate) async fn forget_cpa_instance(state: tauri::State<'_, RemoteCpaState>, revision: u32, endpoint: String) -> Result<ConnectionView, RemoteError> {
    let mut selection = state.selection.lock().await;
    check_revision(&selection, revision)?;
    let endpoint = parse_endpoint(&endpoint)?.to_string();
    let mut book = selection.book.clone();
    if book.active.as_ref() == Some(&endpoint) || book.instances.remove(&endpoint).is_none() { return Err(RemoteError::EndpointChanged); }
    write_profile(state.path.as_deref().ok_or(RemoteError::ProfileWrite)?, &book)?;
    selection.book = book;
    selection.revision = selection.revision.wrapping_add(1);
    selection.keys_etag = None;
    Ok(state.view(&selection))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeysView {
    keys: Vec<String>,
    snapshot: u32,
}

#[tauri::command]
pub(crate) async fn get_remote_cpa_keys(
    state: tauri::State<'_, RemoteCpaState>,
    revision: u32,
) -> Result<KeysView, RemoteError> {
    let mut selection = state.selection.try_lock().map_err(|_| RemoteError::Busy)?;
    let target = current_target(true, &selection, revision)?;
    selection.keys_etag = None;
    let (keys, etag) = load_keys(&target).await?;
    if contains_management_key(&selection, &keys) {
        return Err(RemoteError::KeyMatchesManagement);
    }
    selection.next_snapshot = selection.next_snapshot.wrapping_add(1);
    let snapshot = selection.next_snapshot;
    selection.keys_etag = Some((snapshot, etag));
    Ok(KeysView { keys, snapshot })
}

fn contains_management_key(selection: &Selection, keys: &[String]) -> bool {
    matches!(&selection.profile, Ok(Profile::Remote { key, .. }) if keys.iter().any(|client| client == key))
}

#[tauri::command]
pub(crate) async fn save_remote_cpa_keys(
    state: tauri::State<'_, RemoteCpaState>,
    revision: u32,
    snapshot: u32,
    keys: Vec<String>,
) -> Result<(), RemoteError> {
    let mut selection = state.selection.try_lock().map_err(|_| RemoteError::Busy)?;
    let target = current_target(true, &selection, revision)?;
    let keys = normalize_keys(keys)?;
    if contains_management_key(&selection, &keys) {
        return Err(RemoteError::KeyMatchesManagement);
    }
    let Some((_, etag)) = selection
        .keys_etag
        .as_ref()
        .filter(|(id, _)| *id == snapshot)
    else {
        return Err(RemoteError::Conflict);
    };
    let etag = etag.clone();
    selection.keys_etag = None;
    save_keys(&target, etag, &keys).await
}

fn normalize_keys(keys: Vec<String>) -> Result<Vec<String>, RemoteError> {
    let mut unique = std::collections::HashSet::new();
    let mut result = Vec::new();
    if keys.is_empty() || keys.len() > 512 {
        return Err(RemoteError::InvalidKeys);
    }
    for key in keys {
        let key = key.trim().to_string();
        if key.is_empty()
            || key.len() > 1024
            || !key.bytes().all(|byte| byte.is_ascii_graphic())
            || !unique.insert(key.clone())
        {
            return Err(RemoteError::InvalidKeys);
        }
        result.push(key);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "remote_cpa_tests.rs"]
mod tests;
