mod accounts;
mod agent;
mod bridge;
#[cfg(test)]
mod lifecycle_tests;
mod manual_auth;
mod request_pool;
mod rpc;
mod tool_transport;
pub(crate) use bridge::restore;
pub(crate) use tool_transport::run_helper as run_mcp_helper;

#[tauri::command]
pub(crate) async fn set_acp_upstream_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<AcpStatus, String> {
    bridge::set_acp_upstream_enabled(app, enabled).await
}

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AccountAuthState {
    #[default]
    Unknown,
    Ready,
    AuthRequired,
    Error,
}

#[derive(Clone, Default)]
pub(super) struct AccountRuntime {
    pub auth_state: AccountAuthState,
    pub models: Vec<AcpModel>,
    pub last_verified_at: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountRuntimeSnapshot {
    pub auth_state: AccountAuthState,
    pub model_count: usize,
    pub last_verified_at: Option<u64>,
    pub last_error: Option<String>,
    pub active_requests: usize,
    pub live_sessions: usize,
    pub operating: bool,
    pub cooldowns: Vec<request_pool::CooldownSnapshot>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcpStatus {
    executable: Option<String>,
    profile: String,
    authenticated: bool,
    busy: bool,
    operation: String,
    models: Vec<AcpModel>,
    selected_model: String,
    error: Option<String>,
    latest_probe: Option<ProbeResult>,
    upstream_enabled: bool,
    upstream_url: Option<String>,
    accounts: Vec<accounts::Account>,
    active_account: String,
    pool_settings: request_pool::PoolSettings,
    active_requests: usize,
    live_sessions: usize,
    account_runtime: BTreeMap<String, AccountRuntimeSnapshot>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct AcpModel {
    id: String,
    name: String,
    #[serde(default, rename = "reasoningLevels")]
    reasoning_levels: Vec<String>,
    #[serde(skip)]
    reasoning_variants: BTreeMap<String, String>,
}

#[derive(Default)]
pub(crate) struct AcpState {
    status: Mutex<AcpStatus>,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    bridge: Mutex<Option<bridge::Runtime>>,
    bridge_transition: tokio::sync::Mutex<()>,
    agents: agent::Sessions,
    request_pool: request_pool::Pool,
    manual_auth: manual_auth::ManualAuth,
    operating_accounts: Mutex<BTreeSet<String>>,
    account_runtime: Mutex<BTreeMap<String, AccountRuntime>>,
}

impl AcpState {
    pub(crate) fn cancel_interactive(&self) {
        if let Ok(guard) = self.cancel.lock() {
            if let Some(cancel) = guard.as_ref() {
                cancel.store(true, Ordering::Release);
            }
        }
    }

    pub(crate) fn cancel(&self) {
        self.request_pool.cancel();
        self.cancel_interactive();
    }

    pub(crate) fn shutdown(&self) {
        self.cancel();
        self.agents.clear();
        if let Ok(mut runtime) = self.bridge.lock() {
            runtime.take();
        }
    }

    pub(crate) fn suspend_for_remote(&self) {
        self.shutdown();
        if let Ok(mut root) = self.request_pool.root.lock() {
            *root = None;
        }
        if let Ok(mut status) = self.status.lock() {
            status.upstream_url = None;
            status.error = None;
        }
    }

    pub(crate) fn prepare_for_local(&self) {
        self.request_pool.mark_running();
        if let Ok(mut status) = self.status.lock() {
            status.error = None;
        }
    }

    fn snapshot(&self) -> Result<AcpStatus, String> {
        let mut status = self
            .status
            .lock()
            .map_err(|_| "ACP state unavailable")?
            .clone();
        self.populate_telemetry(&mut status);
        Ok(status)
    }

    fn populate_telemetry(&self, status: &mut AcpStatus) {
        status.pool_settings = self.request_pool.settings();
        status.active_requests = self.request_pool.active_count();
        status.live_sessions = self.agents.total_live();
        let active_by_account = self.request_pool.active_counts_by_account();
        let live_by_account = self.agents.live_counts_by_account();
        let cooldowns_by_account = self.request_pool.cooldowns_by_account();
        let operating = self
            .operating_accounts
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let runtime_map = self
            .account_runtime
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let mut ids: BTreeSet<String> = status.accounts.iter().map(|a| a.id.clone()).collect();
        if !status.active_account.is_empty() {
            ids.insert(status.active_account.clone());
        }
        ids.extend(runtime_map.keys().cloned());
        ids.extend(active_by_account.keys().cloned());
        ids.extend(live_by_account.keys().cloned());
        ids.extend(cooldowns_by_account.keys().cloned());

        let mut snapshots = BTreeMap::new();
        for id in ids {
            let rt = runtime_map.get(&id);
            let is_active_auth = id == status.active_account && status.authenticated;
            let auth_state = match rt.map(|r| r.auth_state) {
                Some(AccountAuthState::Unknown) | None if is_active_auth => AccountAuthState::Ready,
                Some(state) => state,
                None => AccountAuthState::Unknown,
            };
            let model_count = rt
                .map(|r| r.models.len())
                .filter(|&count| count > 0)
                .unwrap_or_else(|| if is_active_auth { status.models.len() } else { 0 });
            snapshots.insert(
                id.clone(),
                AccountRuntimeSnapshot {
                    auth_state,
                    model_count,
                    last_verified_at: rt.and_then(|r| r.last_verified_at),
                    last_error: rt.and_then(|r| r.last_error.clone()),
                    active_requests: active_by_account.get(&id).copied().unwrap_or(0),
                    live_sessions: live_by_account.get(&id).copied().unwrap_or(0),
                    operating: operating.contains(&id),
                    cooldowns: cooldowns_by_account.get(&id).cloned().unwrap_or_default(),
                },
            );
        }
        status.account_runtime = snapshots;
    }

    pub(super) fn aggregated_models(&self) -> Vec<AcpModel> {
        let Ok(status) = self.status.lock().map(|g| g.clone()) else {
            return Vec::new();
        };
        let pool_enabled = self
            .request_pool
            .root
            .lock()
            .ok()
            .is_some_and(|root| root.is_some())
            || self.request_pool.settings().account_pool;
        if !pool_enabled {
            return status.models;
        }
        let runtime_map = self
            .account_runtime
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let enabled_ids: BTreeSet<String> = status
            .accounts
            .iter()
            .filter(|a| a.enabled)
            .map(|a| a.id.clone())
            .collect();
        let mut merged: Vec<AcpModel> = Vec::new();
        let mut index_by_id: BTreeMap<String, usize> = BTreeMap::new();
        let mut push_models = |models: &[AcpModel]| {
            for model in models {
                if let Some(&idx) = index_by_id.get(&model.id) {
                    let existing = &mut merged[idx];
                    for (level, variant) in &model.reasoning_variants {
                        existing
                            .reasoning_variants
                            .entry(level.clone())
                            .or_insert_with(|| variant.clone());
                    }
                    existing.reasoning_levels = REASONING_LEVELS
                        .iter()
                        .filter(|level| existing.reasoning_variants.contains_key(**level))
                        .map(|level| (*level).to_string())
                        .collect();
                } else {
                    index_by_id.insert(model.id.clone(), merged.len());
                    merged.push(model.clone());
                }
            }
        };
        let active_enabled = status.accounts.is_empty() || enabled_ids.contains(&status.active_account);
        if status.authenticated && active_enabled {
            push_models(&status.models);
        }
        for account in &status.accounts {
            if !account.enabled {
                continue;
            }
            if let Some(rt) = runtime_map.get(&account.id) {
                if rt.auth_state == AccountAuthState::Ready && !rt.models.is_empty() {
                    push_models(&rt.models);
                }
            }
        }
        if merged.is_empty() && status.authenticated {
            return status.models;
        }
        merged
    }

    pub(super) fn has_ready_pool_account(&self) -> bool {
        let Ok(status) = self.status.lock().map(|g| g.clone()) else {
            return false;
        };
        let enabled_ids: BTreeSet<String> = status
            .accounts
            .iter()
            .filter(|a| a.enabled)
            .map(|a| a.id.clone())
            .collect();
        if status.authenticated
            && (status.accounts.is_empty() || enabled_ids.contains(&status.active_account))
        {
            return true;
        }
        let runtime_map = self
            .account_runtime
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        status.accounts.iter().any(|account| {
            account.enabled
                && runtime_map.get(&account.id).is_some_and(|rt| {
                    rt.auth_state == AccountAuthState::Ready && !rt.models.is_empty()
                })
        })
    }

    pub(super) fn record_account_verified(&self, account_id: &str, models: Vec<AcpModel>) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if let Ok(mut runtime) = self.account_runtime.lock() {
            runtime.insert(
                account_id.to_string(),
                AccountRuntime {
                    auth_state: AccountAuthState::Ready,
                    models,
                    last_verified_at: Some(now),
                    last_error: None,
                },
            );
        }
        self.request_pool.reset_cooldown(Some(account_id));
    }

    pub(super) fn record_account_auth_required(&self, account_id: &str, error: String) {
        if let Ok(mut runtime) = self.account_runtime.lock() {
            let entry = runtime.entry(account_id.to_string()).or_default();
            entry.auth_state = AccountAuthState::AuthRequired;
            entry.last_error = Some(error);
        }
    }

    pub(super) fn record_account_error(&self, account_id: &str, error: String) {
        if let Ok(mut runtime) = self.account_runtime.lock() {
            let entry = runtime.entry(account_id.to_string()).or_default();
            entry.auth_state = AccountAuthState::Error;
            entry.last_error = Some(error);
        }
    }

    pub(super) fn clear_account_runtime(&self, account_id: &str) {
        if let Ok(mut runtime) = self.account_runtime.lock() {
            runtime.remove(account_id);
        }
        self.request_pool.remove_account(account_id);
    }

    pub(super) fn reset_account_health(&self, account_id: Option<&str>) {
        if let Ok(mut runtime) = self.account_runtime.lock() {
            match account_id {
                Some(target) => {
                    if let Some(entry) = runtime.get_mut(target) {
                        if matches!(
                            entry.auth_state,
                            AccountAuthState::AuthRequired | AccountAuthState::Error
                        ) {
                            entry.auth_state = AccountAuthState::Unknown;
                        }
                        entry.last_error = None;
                    }
                }
                None => {
                    for entry in runtime.values_mut() {
                        if matches!(
                            entry.auth_state,
                            AccountAuthState::AuthRequired | AccountAuthState::Error
                        ) {
                            entry.auth_state = AccountAuthState::Unknown;
                        }
                        entry.last_error = None;
                    }
                }
            }
        }
        self.request_pool.reset_cooldown(account_id);
    }
}

struct AccountExclusiveGuard<R: tauri::Runtime = tauri::Wry> {
    app: tauri::AppHandle<R>,
    account_id: String,
}

impl<R: tauri::Runtime> Drop for AccountExclusiveGuard<R> {
    fn drop(&mut self) {
        let state = self.app.state::<AcpState>();
        if let Ok(mut operating) = state.operating_accounts.lock() {
            operating.remove(&self.account_id);
        }
        state.request_pool.wake_waiters();
    }
}

fn lock_account_exclusive<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    account_id: &str,
) -> Result<AccountExclusiveGuard<R>, String> {
    let state = app.state::<AcpState>();
    {
        let mut operating = state
            .operating_accounts
            .lock()
            .map_err(|_| "ACP state unavailable")?;
        if state.request_pool.active_for(account_id) > 0 {
            return Err("This ACP account has active API requests; wait for them to finish".into());
        }
        if !operating.insert(account_id.to_string()) {
            return Err("An ACP operation is already running".into());
        }
        if state.request_pool.active_for(account_id) > 0 {
            operating.remove(account_id);
            return Err("This ACP account has active API requests; wait for them to finish".into());
        }
    }
    Ok(AccountExclusiveGuard {
        app: app.clone(),
        account_id: account_id.to_string(),
    })
}

fn lock_account_state<'a>(
    state: &'a AcpState,
    account_id: &str,
) -> Result<StateAccountGuard<'a>, String> {
    {
        let mut operating = state
            .operating_accounts
            .lock()
            .map_err(|_| "ACP state unavailable")?;
        if state.request_pool.active_for(account_id) > 0 {
            return Err("This ACP account has active API requests; wait for them to finish".into());
        }
        if !operating.insert(account_id.to_string()) {
            return Err("An ACP operation is already running".into());
        }
        if state.request_pool.active_for(account_id) > 0 {
            operating.remove(account_id);
            return Err("This ACP account has active API requests; wait for them to finish".into());
        }
    }
    Ok(StateAccountGuard {
        state,
        account_id: account_id.to_string(),
    })
}

struct StateAccountGuard<'a> {
    state: &'a AcpState,
    account_id: String,
}

impl Drop for StateAccountGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut operating) = self.state.operating_accounts.lock() {
            operating.remove(&self.account_id);
        }
        self.state.request_pool.wake_waiters();
    }
}

fn profile(base: &Path) -> PathBuf {
    base.join("acp/antigravity")
}

fn prepare_profile(profile: &Path) -> Result<(), String> {
    accounts::safe_path(profile)?;
    for name in ["workspace", ".gemini", "selected-model.json"] {
        accounts::safe_path(&profile.join(name))?;
    }
    std::fs::create_dir_all(profile.join("workspace")).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(profile, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn selected_path(profile: &Path) -> PathBuf {
    profile.join("selected-model.json")
}

fn read_selected(profile: &Path) -> Result<String, String> {
    accounts::safe_path(&selected_path(profile))?;
    match std::fs::read(selected_path(profile)) {
        Ok(bytes) => serde_json::from_slice::<String>(&bytes)
            .map_err(|_| "Invalid ACP model settings".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("Failed to read ACP model settings: {error}")),
    }
}

const REASONING_LEVELS: &[&str] = &[
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
];

fn model_variant(id: &str) -> (&str, Option<&str>) {
    match id.rsplit_once('-') {
        Some((base, level)) if !base.is_empty() && REASONING_LEVELS.contains(&level) => {
            (base, Some(level))
        }
        _ => (id, None),
    }
}

fn model_list(session: &Value) -> Vec<AcpModel> {
    let mut models: Vec<_> = session["models"]["availableModels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model["modelId"].as_str()?;
            Some(AcpModel {
                id: id.to_string(),
                name: model["name"].as_str().unwrap_or(id).to_string(),
                reasoning_levels: Vec::new(),
                reasoning_variants: BTreeMap::new(),
            })
        })
        .collect();
    let mut groups: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for model in &models {
        let (base, level) = model_variant(&model.id);
        if let Some(level) = level {
            groups
                .entry(base.to_string())
                .or_default()
                .insert(level.to_string(), model.id.clone());
        }
    }
    for model in &models {
        if let Some(variants) = groups.get_mut(model.id.as_str()) {
            variants.insert("none".into(), model.id.clone());
        }
    }
    for model in &mut models {
        if let Some(variants) = groups.get(model_variant(&model.id).0) {
            model.reasoning_levels = REASONING_LEVELS
                .iter()
                .filter(|level| variants.contains_key(**level))
                .map(|level| level.to_string())
                .collect();
            model.reasoning_variants = variants.clone();
        }
    }
    models
}

fn mark_session(state: &AcpState, session: &Value, profile: &Path) -> Result<(), String> {
    let models = model_list(session);
    if models.is_empty() {
        return Err("Official ACP server did not return available models".into());
    }
    let saved = read_selected(profile)?;
    let selected = if models.iter().any(|model| model.id == saved) {
        saved
    } else {
        session["models"]["currentModelId"]
            .as_str()
            .filter(|id| models.iter().any(|model| model.id == *id))
            .unwrap_or(&models[0].id)
            .to_string()
    };
    let active_id = {
        let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
        status.authenticated = true;
        status.models = models.clone();
        status.selected_model = selected;
        status.profile = profile.to_string_lossy().into_owned();
        status.active_account.clone()
    };
    if !active_id.is_empty() {
        state.record_account_verified(&active_id, models);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_acp_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AcpState>,
) -> Result<AcpStatus, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let root = profile(&crate::core_base_dir()?);
    let upstream_enabled = bridge::upstream_enabled(&root)?;
    let pool_settings = bridge::read_pool_settings(&root)?;
    let accounts = accounts::read(&root)?;
    let profile_dir = accounts::directory(&root, &accounts.active)?;
    let selected_fallback = read_selected(&profile_dir)?;
    state.request_pool.set_settings(pool_settings.clone());
    state.agents.set_max_live(pool_settings.max_live_sessions);
    let mut snapshot = {
        let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
        status.executable =
            crate::find_antigravity_cli(&home).map(|path| path.to_string_lossy().into_owned());
        status.upstream_enabled = upstream_enabled;
        status.active_account = accounts.active;
        status.accounts = accounts.accounts;
        status.profile = profile_dir.to_string_lossy().into_owned();
        if !status.authenticated && !status.busy {
            status.selected_model = selected_fallback;
        }
        status.clone()
    };
    state.populate_telemetry(&mut snapshot);
    Ok(snapshot)
}

struct OperationGuard<R: tauri::Runtime = tauri::Wry> {
    app: tauri::AppHandle<R>,
    cancel: Arc<AtomicBool>,
}
impl<R: tauri::Runtime> Drop for OperationGuard<R> {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        let state = self.app.state::<AcpState>();
        // Keep the same lock order as begin so a new operation cannot lose its
        // cancellation handle while the previous operation finishes.
        if let Ok(mut status) = state.status.lock() {
            if let Ok(mut active) = state.cancel.lock() {
                *active = None;
            }
            status.busy = false;
            status.operation.clear();
        };
    }
}

fn begin<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    operation: &str,
) -> Result<OperationGuard<R>, String> {
    let state = app.state::<AcpState>();
    let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
    if status.busy {
        return Err("An ACP operation is already running".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *state.cancel.lock().map_err(|_| "ACP state unavailable")? = Some(cancel.clone());
    status.busy = true;
    status.operation = operation.into();
    status.error = None;
    if operation != "request" {
        status.latest_probe = None;
    }
    Ok(OperationGuard {
        app: app.clone(),
        cancel,
    })
}

#[tauri::command]
pub(crate) async fn acp_connect(app: tauri::AppHandle, login: bool) -> Result<AcpStatus, String> {
    let guard = begin(&app, if login { "login" } else { "refresh" })?;
    if login && accounts::is_isolated_home(&accounts::active(&profile(&crate::core_base_dir()?))?) {
        return Err("Use the account's isolated sign-in to authorize it again".into());
    }
    connect(app, login, false, None, guard).await
}

#[tauri::command]
pub(crate) async fn switch_acp_account(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<AcpStatus, String> {
    let guard = begin(&app, "refresh")?;
    let root = profile(&crate::core_base_dir()?);
    select_account_local(app.state::<AcpState>().inner(), &root, &account_id)?;
    // Verification proceeds even if provider maintenance later fails. The
    // requested selection remains persisted and old capabilities stay retired.
    connect(app, false, false, None, guard).await
}

#[tauri::command]
pub(crate) async fn add_acp_account(
    app: tauri::AppHandle,
    label: String,
    replace: Option<String>,
    on_link: tauri::ipc::Channel<manual_auth::ManualLink>,
) -> Result<AcpStatus, String> {
    let guard = begin(&app, "login")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let executable = crate::find_antigravity_cli(&home)
        .ok_or("Install official Antigravity CLI before adding an account")?;
    let root = profile(&crate::core_base_dir()?);
    let replacement = if let Some(id) = replace.as_deref() {
        let registry = accounts::read(&root)?;
        let target = registry
            .accounts
            .into_iter()
            .find(|account| account.id == id && account.isolated)
            .ok_or("Only an isolated ACP account can sign in again")?;
        let was_active = registry.active == id;
        Some((target, was_active))
    } else {
        None
    };
    let _exclusive = match replacement.as_ref() {
        Some((target, _)) => Some(lock_account_exclusive(&app, &target.id)?),
        None => None,
    };
    let mut pending = accounts::PendingAccount::new_isolated(
        &root,
        replacement
            .as_ref()
            .map_or(label.as_str(), |(account, _)| account.label.as_str()),
        replacement.is_some(),
    )?;
    let directory = pending.directory()?;
    let global_proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    let proxy = accounts::resolve_proxy(
        replacement
            .as_ref()
            .and_then(|(account, _)| account.proxy_url.as_deref()),
        &global_proxy,
    );
    tauri::async_runtime::spawn_blocking(move || {
        let _exclusive = _exclusive;
        let state = app.state::<AcpState>();
        let result = (|| {
            // Terminal authentication is not an ACP authenticate RPC. Use the
            // fixed official invocation, then reconnect to the same profile.
            let login =
                manual_auth::TerminalLogin::resolve(&executable, &directory, &proxy, &guard.cancel)?;
            let command = login.command(&executable, &directory, &proxy)?;
            let identity = state.manual_auth.run(command, &pending.id, &guard.cancel, |link| {
                on_link.send(link).map_err(|_| String::from(manual_auth::FAILED))
            })?;
            accounts::require_isolated_token(&directory)?;
            let mut client = rpc::Client::spawn(&executable, &directory, &proxy)?;
            let replace_id = replacement.as_ref().map(|(account, _)| account.id.as_str());
            let activate = replacement.as_ref().is_none_or(|(_, was_active)| *was_active);
            finish_manual_add_ex(
                state.inner(),
                &root,
                &directory,
                &guard.cancel,
                &mut client,
                &mut pending,
                identity,
                replace_id,
                activate,
            )
        })();
        let result = if let Err(error) = result {
            let error = match pending.rollback() {
                Ok(()) => error,
                Err(cleanup) => format!("{error}; pending login data could not be isolated: {cleanup}"),
            };
            record_error(state.inner(), &error);
            Err(error)
        } else { Ok(()) };
        drop(guard);
        result?;
        get_acp_status(app.clone(), app.state::<AcpState>())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn submit_acp_account_authorization(
    state: tauri::State<'_, AcpState>, attempt: String, response: String,
) -> Result<(), String> {
    state.manual_auth.submit(&attempt, &response)
}

#[cfg(test)]
fn finish_manual_add(
    state: &AcpState,
    root: &Path,
    profile: &Path,
    cancel: &Arc<AtomicBool>,
    client: &mut rpc::Client,
    pending: &mut accounts::PendingAccount,
    terminal_identity: Option<String>,
    replace: Option<&str>,
) -> Result<(), String> {
    finish_manual_add_ex(
        state,
        root,
        profile,
        cancel,
        client,
        pending,
        terminal_identity,
        replace,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_manual_add_ex(
    state: &AcpState,
    root: &Path,
    profile: &Path,
    cancel: &Arc<AtomicBool>,
    client: &mut rpc::Client,
    pending: &mut accounts::PendingAccount,
    terminal_identity: Option<String>,
    replace: Option<&str>,
    activate: bool,
) -> Result<(), String> {
    // The fresh server loads the terminal-authorized profile. Only its own
    // official identity log is trusted; neither a label nor user input is identity.
    client.initialize(cancel)?;
    let session = client.session(profile, cancel);
    if cancel.load(Ordering::Acquire) {
        return Err("ACP request cancelled".into());
    }
    let session_identity = client.account_email(profile);
    if let (Some(terminal), Some(session)) = (&terminal_identity, &session_identity) {
        if !session.eq_ignore_ascii_case(terminal) {
            return Err(accounts::IDENTITY_UNKNOWN.into());
        }
    }
    let identity = session_identity.or(terminal_identity);
    let session = match session {
        Ok(session) if !model_list(&session).is_empty() => session,
        _ if replace.is_none() && identity.is_some() => {
            pending.commit_replacing(identity, None, false)?;
            return Err(
                "Account saved; connection not verified: Antigravity did not provide usable models"
                    .into(),
            );
        }
        _ => return Err("Antigravity did not verify the isolated ACP connection".into()),
    };
    let models = model_list(&session);
    pending.commit_replacing(identity, replace, activate)?;
    let committed_id = pending.id.clone();
    if let Some(old_id) = replace {
        state.agents.abandon_account(old_id);
        state.clear_account_runtime(old_id);
    }
    state.record_account_verified(&committed_id, models);
    let discovered = if activate {
        (|| {
            if let Some(old_id) = replace {
                reset_account_for(state, old_id)?;
            } else {
                reset_active_status_only(state)?;
            }
            refresh_account_identity(state, root)?;
            mark_session(state, &session, profile)
        })()
    } else {
        refresh_account_identity(state, root)
    };
    if discovered.is_err() && activate {
        let _ = reset_active_status_only(state);
    }
    let result = combine_account_errors(discovered, sync_account_models(state));
    if let Some(id) = replace {
        return combine_account_errors(result, accounts::archive_replaced(root, id));
    }
    result
}

#[tauri::command]
pub(crate) async fn relogin_acp_account(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<AcpStatus, String> {
    let guard = begin(&app, "login")?;
    let root = profile(&crate::core_base_dir()?);
    let registry = accounts::read(&root)?;
    let target_id = account_id.unwrap_or_else(|| registry.active.clone());
    let target_account = registry
        .accounts
        .into_iter()
        .find(|account| account.id == target_id)
        .ok_or("Unknown ACP account")?;
    let target_profile = accounts::directory(&root, &target_id)?;
    if target_account.isolated || accounts::is_isolated_home(&target_profile) {
        return Err("Use the account's isolated sign-in to authorize it again".into());
    }
    let exclusive = lock_account_exclusive(&app, &target_id)?;
    clear_account_for(&app, &target_id)?;
    if target_id == registry.active {
        let result = connect(app, true, true, None, guard).await;
        drop(exclusive);
        return result;
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let executable = match crate::find_antigravity_cli(&home) {
        Some(executable) => executable,
        None => {
            let state = app.state::<AcpState>();
            let result = combine_account_errors(
                Err("Install official Antigravity CLI before connecting".into()),
                sync_account_models(state.inner()),
            );
            if let Err(error) = &result {
                record_error(state.inner(), error);
            }
            drop(exclusive);
            return result;
        }
    };
    let global_proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    let proxy = accounts::resolve_proxy(target_account.proxy_url.as_deref(), &global_proxy);
    tauri::async_runtime::spawn_blocking(move || {
        let _exclusive = exclusive;
        let state = app.state::<AcpState>();
        let result = (|| {
            prepare_profile(&target_profile)?;
            let mut client = rpc::Client::spawn(&executable, &target_profile, &proxy)?;
            relogin_profile_for(
                state.inner(),
                &root,
                &target_id,
                &target_profile,
                &guard.cancel,
                &mut client,
            )
        })();
        if let Err(error) = &result {
            record_error(state.inner(), error);
        }
        drop(guard);
        result?;
        get_acp_status(app.clone(), app.state::<AcpState>())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn relogin_profile_for(
    state: &AcpState,
    root: &Path,
    account_id: &str,
    target_profile: &Path,
    cancel: &Arc<AtomicBool>,
    client: &mut rpc::Client,
) -> Result<(), String> {
    let mut maintenance = sync_account_models(state);
    let action = (|| {
        client.initialize(cancel)?;
        client.logout(cancel)?;
        accounts::set_email(root, account_id, None)?;
        client.call(
            "authenticate",
            json!({"methodId":"oauth-personal"}),
            cancel,
            |_| {},
        )?;
        accounts::mark_saved_by_id(root, account_id)?;
        if let Some(email) = client.account_email(target_profile) {
            accounts::set_email(root, account_id, Some(email))?;
        }
        let session = client.session(target_profile, cancel)?;
        let models = model_list(&session);
        if models.is_empty() {
            return Err("Official ACP server did not return available models".into());
        }
        state.record_account_verified(account_id, models);
        if let Some(email) = client.account_email(target_profile) {
            accounts::set_email(root, account_id, Some(email))?;
        }
        refresh_account_identity(state, root)?;
        maintenance = combine_account_errors(
            std::mem::replace(&mut maintenance, Ok(())),
            sync_account_models(state),
        );
        Ok(())
    })();
    let mut result = combine_account_errors(action, maintenance);
    if result.is_err() {
        result = combine_account_errors(result, reset_account_for(state, account_id));
        result = combine_account_errors(result, sync_account_models(state));
    }
    if let Err(error) = &result {
        record_error(state, error);
    }
    result
}

#[tauri::command]
pub(crate) fn rename_acp_account(
    app: tauri::AppHandle,
    account_id: String,
    label: String,
) -> Result<AcpStatus, String> {
    let guard = begin(&app, "rename")?;
    accounts::rename(&profile(&crate::core_base_dir()?), &account_id, &label)?;
    drop(guard);
    get_acp_status(app.clone(), app.state::<AcpState>())
}

#[tauri::command]
pub(crate) fn update_acp_account_settings(
    app: tauri::AppHandle,
    account_id: String,
    patch: accounts::AccountSettingsPatch,
) -> Result<AcpStatus, String> {
    let root = profile(&crate::core_base_dir()?);
    accounts::update_settings(&root, &account_id, &patch)?;
    let state = app.state::<AcpState>();
    let _ = refresh_account_identity(state.inner(), &root);
    state.request_pool.wake_waiters();
    sync_account_models(state.inner())?;
    get_acp_status(app.clone(), state)
}

#[tauri::command]
pub(crate) fn update_acp_pool_settings(
    app: tauri::AppHandle,
    settings: request_pool::PoolSettings,
) -> Result<AcpStatus, String> {
    settings.validate()?;
    let root = profile(&crate::core_base_dir()?);
    bridge::save_pool_settings(&root, &settings)?;
    let state = app.state::<AcpState>();
    state.request_pool.set_settings(settings.clone());
    state.agents.set_max_live(settings.max_live_sessions);
    let running = state
        .bridge
        .lock()
        .map_err(|_| "ACP bridge state unavailable")?
        .is_some();
    if running {
        *state
            .request_pool
            .root
            .lock()
            .map_err(|_| "ACP pool unavailable")? = settings.account_pool.then(|| root.clone());
        sync_account_models(state.inner())?;
    }
    get_acp_status(app.clone(), state)
}

#[tauri::command]
pub(crate) fn reset_acp_account_cooldown(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<AcpStatus, String> {
    let state = app.state::<AcpState>();
    state.reset_account_health(account_id.as_deref());
    get_acp_status(app.clone(), state)
}

#[tauri::command]
pub(crate) fn remove_acp_account(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<AcpStatus, String> {
    let guard = begin(&app, "remove")?;
    let root = profile(&crate::core_base_dir()?);
    remove_account_local(app.state::<AcpState>().inner(), &root, &account_id)?;
    drop(guard);
    get_acp_status(app.clone(), app.state::<AcpState>())
}

#[tauri::command]
pub(crate) async fn logout_acp_account(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<AcpStatus, String> {
    let guard = begin(&app, "logout")?;
    let root = profile(&crate::core_base_dir()?);
    let registry = accounts::read(&root)?;
    let target_id = account_id.unwrap_or_else(|| registry.active.clone());
    let target_account = registry
        .accounts
        .into_iter()
        .find(|account| account.id == target_id)
        .ok_or("Unknown ACP account")?;
    let exclusive = lock_account_exclusive(&app, &target_id)?;
    clear_account_for(&app, &target_id)?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let executable = match crate::find_antigravity_cli(&home) {
        Some(executable) => executable,
        None => {
            let state = app.state::<AcpState>();
            let result = combine_account_errors(
                Err("Install official Antigravity CLI to sign out. You can still remove the local account record.".into()),
                sync_account_models(state.inner()),
            );
            if let Err(error) = &result {
                record_error(state.inner(), error);
            }
            drop(exclusive);
            return result;
        }
    };
    let target_profile = accounts::directory(&root, &target_id)?;
    let global_proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    let proxy = accounts::resolve_proxy(target_account.proxy_url.as_deref(), &global_proxy);
    tauri::async_runtime::spawn_blocking(move || {
        let _exclusive = exclusive;
        let mut result = (|| {
            prepare_profile(&target_profile)?;
            let mut client = rpc::Client::spawn(&executable, &target_profile, &proxy)?;
            logout_session_for(
                app.state::<AcpState>().inner(),
                &root,
                &target_id,
                &target_profile,
                &guard.cancel,
                &mut client,
            )
        })();
        if result.is_err() {
            let state = app.state::<AcpState>();
            result = combine_account_errors(result, sync_account_models(state.inner()));
            record_error(state.inner(), result.as_ref().unwrap_err());
        }
        drop(guard);
        result?;
        get_acp_status(app.clone(), app.state::<AcpState>())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn verify_account_with_client(
    state: &AcpState,
    root: &Path,
    account_id: &str,
    account_profile: &Path,
    cancel: &Arc<AtomicBool>,
    client: &mut rpc::Client,
) -> Result<Vec<AcpModel>, String> {
    if let Err(error) = client.initialize(cancel) {
        let message = error.to_string();
        state.record_account_error(account_id, message.clone());
        return Err(message);
    }
    match client.session(account_profile, cancel) {
        Ok(session) => {
            let models = model_list(&session);
            if models.is_empty() {
                let message = "Official ACP server did not return available models".to_string();
                state.record_account_error(account_id, message.clone());
                return Err(message);
            }
            state.record_account_verified(account_id, models.clone());
            let _ = accounts::mark_saved_by_id(root, account_id);
            if let Some(email) = client.account_email(account_profile) {
                let _ = accounts::set_email(root, account_id, Some(email));
            }
            let is_active = state
                .status
                .lock()
                .map(|s| s.active_account == account_id)
                .unwrap_or(false);
            if is_active {
                let _ = mark_session(state, &session, account_profile);
            }
            Ok(models)
        }
        Err(error) => {
            let lower = error.to_ascii_lowercase();
            if lower.contains("unauthenticated")
                || lower.contains("authentication")
                || lower.contains("permission")
                || lower.contains("sign in")
                || lower.contains("oauth")
            {
                state.record_account_auth_required(account_id, error.clone());
            } else {
                state.record_account_error(account_id, error.clone());
            }
            let is_active = state
                .status
                .lock()
                .map(|s| s.active_account == account_id)
                .unwrap_or(false);
            if is_active {
                let _ = reset_account_for(state, account_id);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) async fn verify_acp_account(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<AcpStatus, String> {
    let root = profile(&crate::core_base_dir()?);
    let account = accounts::get(&root, &account_id)?;
    let target_profile = accounts::directory(&root, &account_id)?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let executable = crate::find_antigravity_cli(&home)
        .ok_or("Install official Antigravity CLI before connecting")?;
    let global_proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    let proxy = accounts::resolve_proxy(account.proxy_url.as_deref(), &global_proxy);
    let cancel = Arc::new(AtomicBool::new(false));
    let app_for_task = app.clone();
    let id_for_task = account_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        prepare_profile(&target_profile)?;
        let mut client = rpc::Client::spawn(&executable, &target_profile, &proxy)?;
        let state = app_for_task.state::<AcpState>();
        let models = verify_account_with_client(
            state.inner(),
            &root,
            &id_for_task,
            &target_profile,
            &cancel,
            &mut client,
        );
        let sync = sync_account_models(state.inner());
        combine_account_errors(models.map(|_| ()), sync)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(error) = result {
        record_error(app.state::<AcpState>().inner(), &error);
        return Err(error);
    }
    get_acp_status(app.clone(), app.state::<AcpState>())
}

#[tauri::command]
pub(crate) async fn verify_all_acp_accounts(app: tauri::AppHandle) -> Result<AcpStatus, String> {
    let guard = begin(&app, "verify_all")?;
    let root = profile(&crate::core_base_dir()?);
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let executable = crate::find_antigravity_cli(&home)
        .ok_or("Install official Antigravity CLI before connecting")?;
    let registry = accounts::read(&root)?;
    let global_proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    let targets: Vec<accounts::Account> = registry
        .accounts
        .into_iter()
        .filter(|account| account.enabled && (account.saved || account.id == registry.active))
        .collect();
    verify_accounts_batch(
        &app,
        &root,
        &executable,
        &global_proxy,
        targets,
        guard.cancel.clone(),
    )
    .await?;
    let _ = sync_account_models(app.state::<AcpState>().inner());
    drop(guard);
    get_acp_status(app.clone(), app.state::<AcpState>())
}

pub(super) async fn verify_accounts_batch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
    executable: &Path,
    global_proxy: &str,
    targets: Vec<accounts::Account>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
    let mut join_set = tokio::task::JoinSet::new();
    for account in targets {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "ACP verification queue closed".to_string())?;
        if cancel.load(Ordering::Acquire) {
            return Err("ACP request cancelled".into());
        }
        let app = app.clone();
        let root = root.to_path_buf();
        let executable = executable.to_path_buf();
        let proxy = accounts::resolve_proxy(account.proxy_url.as_deref(), global_proxy);
        let cancel = cancel.clone();
        join_set.spawn_blocking(move || {
            let _permit = permit;
            let state = app.state::<AcpState>();
            let Ok(target_profile) = accounts::directory(&root, &account.id) else {
                return;
            };
            if prepare_profile(&target_profile).is_err() {
                return;
            }
            match rpc::Client::spawn(&executable, &target_profile, &proxy) {
                Ok(mut client) => {
                    let _ = verify_account_with_client(
                        state.inner(),
                        &root,
                        &account.id,
                        &target_profile,
                        &cancel,
                        &mut client,
                    );
                }
                Err(error) => {
                    state.record_account_error(&account.id, error);
                }
            }
        });
    }
    while join_set.join_next().await.is_some() {}
    if cancel.load(Ordering::Acquire) {
        return Err("ACP request cancelled".into());
    }
    Ok(())
}

fn reset_active_status_only(state: &AcpState) -> Result<(), String> {
    let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
    status.authenticated = false;
    status.models.clear();
    status.selected_model.clear();
    status.latest_probe = None;
    Ok(())
}

fn reset_account_for(state: &AcpState, account_id: &str) -> Result<(), String> {
    state.agents.abandon_account(account_id);
    let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
    if status.active_account == account_id || status.active_account.is_empty() {
        status.authenticated = false;
        status.models.clear();
        status.selected_model.clear();
        status.latest_probe = None;
    }
    Ok(())
}

fn reset_account(state: &AcpState) -> Result<(), String> {
    state.agents.clear();
    reset_active_status_only(state)
}

fn refresh_account_identity(state: &AcpState, root: &Path) -> Result<(), String> {
    let registry = accounts::read(root)?;
    let directory = accounts::directory(root, &registry.active)?;
    let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
    status.active_account = registry.active;
    status.accounts = registry.accounts;
    status.profile = directory.to_string_lossy().into_owned();
    Ok(())
}

fn clear_account(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AcpState>();
    reset_account(state.inner())?;
    // Clearing local state is independent of CPA provider-file maintenance.
    refresh_account_identity(state.inner(), &profile(&crate::core_base_dir()?))
}

fn clear_account_for(app: &tauri::AppHandle, account_id: &str) -> Result<(), String> {
    let state = app.state::<AcpState>();
    reset_account_for(state.inner(), account_id)?;
    state.clear_account_runtime(account_id);
    refresh_account_identity(state.inner(), &profile(&crate::core_base_dir()?))
}

fn sync_account_models(state: &AcpState) -> Result<(), String> {
    bridge::sync_models(state)
        .map_err(|error| format!("ACP API provider configuration sync failed: {error}"))
}

fn combine_account_errors<T>(
    result: Result<T, String>,
    maintenance: Result<(), String>,
) -> Result<T, String> {
    match (result, maintenance) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(maintenance)) if error.contains(&maintenance) => Err(error),
        (Err(error), Err(maintenance)) => Err(format!("{error}; {maintenance}")),
    }
}

fn select_account_local(state: &AcpState, root: &Path, id: &str) -> Result<(), String> {
    if !accounts::read(root)?
        .accounts
        .iter()
        .any(|account| account.id == id)
    {
        return Err("Unknown ACP account".into());
    }
    let pool_enabled = state
        .request_pool
        .root
        .lock()
        .ok()
        .is_some_and(|root| root.is_some());
    if pool_enabled {
        reset_active_status_only(state)?;
    } else {
        reset_account(state)?;
    }
    let result = accounts::select(root, id).and_then(|_| refresh_account_identity(state, root));
    if result.is_err() {
        let result = combine_account_errors(result, sync_account_models(state));
        if let Err(error) = &result {
            record_error(state, error);
        }
        return result;
    }
    Ok(())
}

fn remove_account_local(state: &AcpState, root: &Path, id: &str) -> Result<(), String> {
    let _exclusive = lock_account_state(state, id)?;
    let current = accounts::read(root)?.active == id;
    reset_account_for(state, id)?;
    state.clear_account_runtime(id);
    // Never let a damaged/unwritable CPA provider config prevent isolating an
    // account. Apply local mutation first, then report both independent errors.
    let mut result = accounts::remove(root, id).map(|_| ());
    result = combine_account_errors(result, refresh_account_identity(state, root));
    if current
        || state
            .request_pool
            .root
            .lock()
            .ok()
            .is_some_and(|r| r.is_some())
    {
        result = combine_account_errors(result, sync_account_models(state));
    }
    if let Err(error) = &result {
        record_error(state, error);
    }
    result
}

fn record_error(state: &AcpState, error: &str) {
    if let Ok(mut status) = state.status.lock() {
        status.error = Some(error.into());
    }
}

async fn connect(
    app: tauri::AppHandle,
    login: bool,
    relogin: bool,
    mut pending: Option<accounts::PendingAccount>,
    guard: OperationGuard,
) -> Result<AcpStatus, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let executable = match crate::find_antigravity_cli(&home) {
        Some(executable) => executable,
        None if pending.is_some() => {
            return Err("Install official Antigravity CLI before adding an account".into());
        }
        None => {
            clear_account(&app)?;
            let state = app.state::<AcpState>();
            let result = combine_account_errors(
                Err("Install official Antigravity CLI before connecting".into()),
                sync_account_models(state.inner()),
            );
            if let Err(error) = &result {
                record_error(state.inner(), error);
            }
            return result;
        }
    };
    let root = profile(&crate::core_base_dir()?);
    let (directory, account_proxy) = match pending.as_ref() {
        Some(pending) => (pending.directory()?, None),
        None => {
            let registry = accounts::read(&root)?;
            let dir = accounts::directory(&root, &registry.active)?;
            let proxy = registry
                .accounts
                .into_iter()
                .find(|a| a.id == registry.active)
                .and_then(|a| a.proxy_url);
            (dir, proxy)
        }
    };
    let global_proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    let proxy = accounts::resolve_proxy(account_proxy.as_deref(), &global_proxy);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AcpState>();
        let mut result: Result<(), String> = (|| {
            prepare_profile(&directory)?;
            let mut client = rpc::Client::spawn(&executable, &directory, &proxy)?;
            connect_profile(
                state.inner(),
                &root,
                &directory,
                login,
                relogin,
                &guard.cancel,
                &mut client,
                pending.as_mut(),
            )
        })();
        if result.is_err() {
            if let Some(pending) = pending.as_mut() {
                if let Err(cleanup) = pending.rollback() {
                    result = Err(format!(
                        "{}; pending login data could not be isolated: {cleanup}",
                        result.unwrap_err()
                    ));
                }
            }
            // A failed provisional login never changed the active account.
            // A committed new login or ordinary refresh must retire stale models.
            if pending.as_ref().is_none_or(|pending| {
                accounts::read(&root).is_ok_and(|registry| registry.active == pending.id)
            }) {
                let active_id = accounts::read(&root)
                    .map(|registry| registry.active)
                    .unwrap_or_default();
                if !active_id.is_empty() {
                    result = combine_account_errors(
                        result,
                        reset_account_for(state.inner(), &active_id),
                    );
                } else {
                    result = combine_account_errors(result, reset_active_status_only(state.inner()));
                }
                result = combine_account_errors(result, sync_account_models(state.inner()));
            }
            record_error(state.inner(), result.as_ref().unwrap_err());
        }
        drop(guard);
        result?;
        get_acp_status(app.clone(), app.state::<AcpState>())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
fn logout_session(
    state: &AcpState,
    root: &Path,
    cancel: &Arc<AtomicBool>,
    client: &mut rpc::Client,
) -> Result<(), String> {
    let active_id = accounts::read(root)?.active;
    let target_profile = accounts::directory(root, &active_id)?;
    logout_session_for(state, root, &active_id, &target_profile, cancel, client)
}

fn logout_session_for(
    state: &AcpState,
    root: &Path,
    account_id: &str,
    target_profile: &Path,
    cancel: &Arc<AtomicBool>,
    client: &mut rpc::Client,
) -> Result<(), String> {
    // Invalidation is local and immediate even when official logout is missing.
    // Never silently substitute deleting credentials for the official method.
    reset_account_for(state, account_id)?;
    state.clear_account_runtime(account_id);
    let maintenance = sync_account_models(state);
    let action = (|| {
        client.initialize(cancel)?;
        client.logout(cancel)?;
        if accounts::is_isolated_home(target_profile) {
            Ok(())
        } else {
            accounts::set_email(root, account_id, None)
        }
    })();
    let result = combine_account_errors(action, maintenance);
    if let Err(error) = &result {
        record_error(state, error);
    }
    result
}

#[cfg(test)]
fn connect_session(
    state: &AcpState,
    root: &Path,
    login: bool,
    relogin: bool,
    cancel: &Arc<AtomicBool>,
    client: &mut rpc::Client,
) -> Result<(), String> {
    connect_profile(
        state,
        root,
        &accounts::active(root)?,
        login,
        relogin,
        cancel,
        client,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn connect_profile(
    state: &AcpState,
    root: &Path,
    profile: &Path,
    login: bool,
    relogin: bool,
    cancel: &Arc<AtomicBool>,
    client: &mut rpc::Client,
    mut pending: Option<&mut accounts::PendingAccount>,
) -> Result<(), String> {
    let mut touches_current = pending.is_none();
    let mut maintenance = Ok(());
    let action = (|| {
        if touches_current {
            reset_account(state)?;
            maintenance = combine_account_errors(
                std::mem::replace(&mut maintenance, Ok(())),
                sync_account_models(state),
            );
        }
        client.initialize(cancel)?;
        if relogin {
            // A provider-file error cannot skip official logout. Conversely, an
            // actual logout failure MUST stop before any authenticate request.
            client.logout(cancel)?;
            accounts::set_active_email(root, None)?;
        }
        let mut discovery = None;
        if login {
            client.call(
                "authenticate",
                json!({"methodId":"oauth-personal"}),
                cancel,
                |_| {},
            )?;
            if let Some(pending) = pending.as_mut() {
                // The ACP result has no standard identity field. If the owned
                // process has not logged identity yet, allow the normal session
                // discovery call to expose it before comparing with saved accounts.
                let mut email = client.account_email(profile);
                if email.is_none()
                    && accounts::read(root)
                        .is_ok_and(|registry| registry.accounts.iter().any(|account| account.saved))
                {
                    let result = client.session(profile, cancel);
                    email = client.account_email(profile);
                    if email.is_none() && cancel.load(Ordering::Acquire) {
                        return result.and(Err("ACP request cancelled".into()));
                    }
                    discovery = Some(result);
                }
                pending.commit(email)?;
                touches_current = true;
                reset_account(state)?;
                maintenance = combine_account_errors(
                    std::mem::replace(&mut maintenance, Ok(())),
                    sync_account_models(state),
                );
            } else {
                accounts::mark_saved(root)?;
                // Keep verified identity when a legacy account reauthorizes,
                // even if models cannot subsequently be discovered.
                if let Some(email) = client.account_email(profile) {
                    accounts::set_active_email(root, Some(email))?;
                }
            }
        }
        let session = discovery
            .unwrap_or_else(|| client.session(profile, cancel))
            .map_err(|error| {
                if pending.is_some() {
                    format!("Account saved; connection not verified: {error}")
                } else {
                    error
                }
            })?;
        refresh_account_identity(state, root)?;
        mark_session(state, &session, profile)?;
        accounts::mark_saved(root)?;
        if let Some(email) = client.account_email(profile) {
            accounts::set_active_email(root, Some(email))?;
        }
        maintenance = combine_account_errors(
            std::mem::replace(&mut maintenance, Ok(())),
            sync_account_models(state),
        );
        Ok(())
    })();
    let mut result = combine_account_errors(action, maintenance);
    if result.is_err() && touches_current {
        // Fail closed locally even when the stale provider file cannot be
        // updated. Bridge HTTP requests consult this in-memory gate first.
        result = combine_account_errors(result, reset_account(state));
        result = combine_account_errors(result, sync_account_models(state));
    }
    if let Err(error) = &result {
        record_error(state, error);
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_acp_operation(state: tauri::State<'_, AcpState>) {
    state.cancel_interactive();
}

#[tauri::command]
pub(crate) fn select_acp_model(
    state: tauri::State<'_, AcpState>,
    model: String,
) -> Result<AcpStatus, String> {
    let available = state.aggregated_models();
    {
        let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
        if status.busy {
            return Err("Wait for the current ACP operation to finish".into());
        }
        if !status.models.iter().any(|item| item.id == model)
            && !available.iter().any(|item| item.id == model)
        {
            return Err("Refresh available ACP models first".into());
        }
        let profile = accounts::active(&profile(&crate::core_base_dir()?))?;
        prepare_profile(&profile)?;
        crate::write_codex_private_file(
            &selected_path(&profile),
            &serde_json::to_vec(&model).map_err(|e| e.to_string())?,
        )?;
        status.selected_model = model;
        status.latest_probe = None;
    }
    state.snapshot()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResult {
    text: String,
    model: String,
    duration_ms: u64,
    first_text_ms: Option<u64>,
    stop_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
}

#[tauri::command]
pub(crate) async fn test_acp_connection(
    app: tauri::AppHandle,
    account_id: Option<String>,
    model: Option<String>,
) -> Result<ProbeResult, String> {
    let guard = begin(&app, "test")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let executable =
        crate::find_antigravity_cli(&home).ok_or("Official Antigravity CLI not found")?;
    let root = profile(&crate::core_base_dir()?);
    let registry = accounts::read(&root)?;
    let target_id = account_id.unwrap_or_else(|| registry.active.clone());
    let target_account = registry
        .accounts
        .into_iter()
        .find(|account| account.id == target_id)
        .ok_or("Unknown ACP account")?;
    let target_profile = accounts::directory(&root, &target_id)?;
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| app.state::<AcpState>().snapshot().map(|s| s.selected_model).unwrap_or_default());
    let global_proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    let proxy = accounts::resolve_proxy(target_account.proxy_url.as_deref(), &global_proxy);
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let result: Result<ProbeResult, String> = (|| {
            prepare_profile(&target_profile)?;
            let mut client = rpc::Client::spawn(&executable, &target_profile, &proxy)?;
            client.initialize(&guard.cancel)?;
            let session = client.session(&target_profile, &guard.cancel)?;
            let discovered = model_list(&session);
            let chosen_model = if !model.is_empty() && discovered.iter().any(|m| m.id == model) {
                model
            } else if !discovered.is_empty() {
                discovered[0].id.clone()
            } else {
                model
            };
            client.model(&session, &chosen_model, &guard.cancel)?;
            let mut text = String::new();
            let mut first_text_ms = None;
            let result = client.call(
                "session/prompt",
                json!({"sessionId":session["sessionId"],"prompt":[{"type":"text","text":"Reply with only ACP_OK. Do not use any tools."}]}),
                &guard.cancel,
                |update| {
                    if update["sessionUpdate"] == "agent_message_chunk" && update["content"]["type"] == "text" {
                        if let Some(part) = update["content"]["text"].as_str() {
                            first_text_ms.get_or_insert(started.elapsed().as_millis() as u64);
                            text.push_str(part);
                        }
                    }
                },
            )?;
            let stop_reason = result["stopReason"].as_str().unwrap_or("unknown").to_string();
            if stop_reason != "end_turn" || text.trim() != "ACP_OK" {
                return Err("ACP test did not return the expected complete response".into());
            }
            if !discovered.is_empty() {
                app.state::<AcpState>()
                    .record_account_verified(&target_id, discovered);
            }
            Ok(ProbeResult {
                text,
                model: chosen_model,
                duration_ms: started.elapsed().as_millis() as u64,
                first_text_ms,
                stop_reason,
                account_id: Some(target_id),
            })
        })();
        if let Ok(mut status) = app.state::<AcpState>().status.lock() {
            match &result {
                Ok(probe) => status.latest_probe = Some(probe.clone()),
                Err(error) => status.error = Some(error.clone()),
            }
        }
        drop(guard);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovers_only_models_with_protocol_ids() {
        let models = model_list(
            &json!({"models":{"availableModels":[{"modelId":"one","name":"One"},{"name":"broken"},{"modelId":"two"}]}}),
        );
        assert_eq!(models.len(), 2);
        assert_eq!(models[1].name, "two");
    }

    #[test]
    fn profile_is_separate_from_managed_client_settings() {
        assert_eq!(
            profile(Path::new("data")),
            Path::new("data").join("acp/antigravity")
        );
        let command = rpc::command(Path::new("agy"), Path::new("profile"), "").unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"acp".to_string()));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("dangerously") || arg.contains("CPA (")));
    }

    #[test]
    fn stale_models_are_not_silently_selected() {
        let directory = crate::unique_test_temp_path("acp-model-selection");
        prepare_profile(&directory).unwrap();
        std::fs::write(selected_path(&directory), br#""removed-model""#).unwrap();
        let state = AcpState::default();
        mark_session(&state, &json!({"models":{"availableModels":[{"modelId":"available","name":"Available"}],"currentModelId":"available"}}), &directory).unwrap();
        assert_eq!(state.snapshot().unwrap().selected_model, "available");
        std::fs::remove_dir_all(directory).unwrap();
    }

    // Opt in with an existing officially authenticated profile. No credential
    // contents are read or printed by the test.
    #[test]
    #[ignore]
    fn official_acp_native_probe() {
        let profile = PathBuf::from(
            std::env::var_os("ECPA_ACP_PROBE_PROFILE").expect("Set ECPA_ACP_PROBE_PROFILE"),
        );
        let executable =
            PathBuf::from(std::env::var_os("ECPA_ACP_PROBE_CLI").expect("Set ECPA_ACP_PROBE_CLI"));
        let cancel = Arc::new(AtomicBool::new(false));
        let mut client = rpc::Client::spawn(&executable, &profile, "").unwrap();
        client.initialize(&cancel).unwrap();
        let session = client.session(&profile, &cancel).unwrap();
        let models = model_list(&session);
        assert!(!models.is_empty());
        let model = models
            .iter()
            .find(|model| Some(model.id.as_str()) != session["models"]["currentModelId"].as_str())
            .unwrap_or(&models[0]);
        client.model(&session, &model.id, &cancel).unwrap();
        let mut text = String::new();
        let result = client.call("session/prompt", json!({"sessionId":session["sessionId"],"prompt":[{"type":"text","text":"Reply with only ACP_OK. Do not use tools."}]}), &cancel, |update| {
            if update["sessionUpdate"] == "agent_message_chunk" {
                text.push_str(update["content"]["text"].as_str().unwrap_or(""));
            }
        }).unwrap();
        assert_eq!(result["stopReason"], "end_turn");
        assert_eq!(text.trim(), "ACP_OK");
        println!(
            "Official ACP native model selection and inference passed: {}",
            model.id
        );
    }
}
