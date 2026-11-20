//! A dedicated attachment mode. The launch mode determines which native
//! services exist; changing between Local and Remote takes effect on relaunch.
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
    LocalRunning,
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
struct Selection {
    profile: Result<Profile, RemoteError>,
    revision: u32,
    keys_etag: Option<(u32, header::HeaderValue)>,
    next_snapshot: u32,
}

pub(crate) struct RemoteCpaState {
    path: Option<PathBuf>,
    pub(crate) remote_launch: bool,
    selection: Mutex<Selection>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionView {
    remote_active: bool,
    remote_selected: bool,
    endpoint: Option<String>,
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
        let profile = path
            .as_deref()
            .ok_or(RemoteError::ProfileInvalid)
            .and_then(read_profile);
        let remote_launch = !matches!(profile, Ok(Profile::Local));
        Self {
            path,
            remote_launch,
            selection: Mutex::new(Selection {
                profile,
                revision: 0,
                keys_etag: None,
                next_snapshot: 0,
            }),
        }
    }

    fn persist(
        &self,
        selection: &mut Selection,
        profile: Profile,
    ) -> Result<ConnectionView, RemoteError> {
        write_profile(
            self.path.as_deref().ok_or(RemoteError::ProfileWrite)?,
            &profile,
        )?;
        selection.profile = Ok(profile);
        selection.revision = selection.revision.wrapping_add(1);
        selection.keys_etag = None;
        Ok(self.view(selection))
    }

    fn view(&self, selection: &Selection) -> ConnectionView {
        ConnectionView {
            remote_active: self.remote_launch,
            remote_selected: !matches!(selection.profile, Ok(Profile::Local)),
            endpoint: match selection.profile.as_ref() {
                Ok(Profile::Remote { endpoint, .. }) => Some(endpoint.clone()),
                _ => None,
            },
            needs_repair: selection.profile.is_err(),
            revision: selection.revision,
        }
    }
}

fn read_profile(path: &Path) -> Result<Profile, RemoteError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Profile::Local),
        Err(_) => return Err(RemoteError::ProfileInvalid),
    };
    let profile = serde_json::from_slice(&bytes).map_err(|_| RemoteError::ProfileInvalid)?;
    if let Profile::Remote { endpoint, key } = profile {
        let target = Target::new(&endpoint, &key).map_err(|_| RemoteError::ProfileInvalid)?;
        Ok(Profile::Remote {
            endpoint: target.endpoint.to_string(),
            key: key.trim().to_owned(),
        })
    } else {
        Ok(profile)
    }
}

fn write_profile(path: &Path, profile: &Profile) -> Result<(), RemoteError> {
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

struct Target {
    endpoint: Url,
    auth: header::HeaderValue,
}

impl Target {
    fn new(endpoint: &str, key: &str) -> Result<Self, RemoteError> {
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
        let mut request = client
            .request(method, url)
            .header(header::AUTHORIZATION, self.auth.clone());
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
        match &selection.profile {
            Ok(Profile::Remote {
                endpoint: saved,
                key,
            }) if *saved == endpoint => key.clone(),
            _ => return Err(RemoteError::KeyRequired),
        }
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
    state: tauri::State<'_, RemoteCpaState>,
    process: tauri::State<'_, crate::CoreProcessState>,
    revision: u32,
    remote: bool,
    endpoint: String,
    key: String,
) -> Result<ConnectionView, RemoteError> {
    let mut selection = state.selection.try_lock().map_err(|_| RemoteError::Busy)?;
    check_revision(&selection, revision)?;
    let profile = if remote {
        let (target, key) = candidate(&selection, endpoint, key)?;
        probe_target(&target).await?;
        Profile::Remote {
            endpoint: target.endpoint.to_string(),
            key,
        }
    } else {
        Profile::Local
    };
    // Keep the Local session intact. Never stop or disown a GUI-managed process
    // to select an external instance. Normal Local operations keep their lock.
    let _operation = if remote && !state.remote_launch {
        let guard = crate::lock_core_operation(process.inner()).map_err(|_| RemoteError::Busy)?;
        if process.managed_pid().is_some()
            || crate::core_install_dir()
                .ok()
                .and_then(|dir| crate::find_core_binary(&dir))
                .is_some_and(|binary| crate::is_core_running(&binary))
        {
            return Err(RemoteError::LocalRunning);
        }
        Some(guard)
    } else {
        None
    };
    state.persist(&mut selection, profile)
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
    let target = current_target(state.remote_launch, &selection, revision)?;
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
    let target = current_target(state.remote_launch, &selection, revision)?;
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
