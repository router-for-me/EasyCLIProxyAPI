mod accounts;
mod agent;
mod bridge;
#[cfg(test)]
mod lifecycle_tests;
mod manual_auth;
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
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Manager;

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
    manual_auth: manual_auth::ManualAuth,
}

impl AcpState {
    pub(crate) fn cancel(&self) {
        if let Ok(guard) = self.cancel.lock() {
            if let Some(cancel) = guard.as_ref() {
                cancel.store(true, Ordering::Release);
            }
        }
    }

    pub(crate) fn shutdown(&self) {
        self.cancel();
        self.agents.clear();
        if let Ok(mut runtime) = self.bridge.lock() {
            runtime.take();
        }
    }

    fn snapshot(&self) -> Result<AcpStatus, String> {
        self.status
            .lock()
            .map(|status| status.clone())
            .map_err(|_| "ACP state unavailable".into())
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
    let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
    status.authenticated = true;
    status.models = models;
    status.selected_model = selected;
    status.profile = profile.to_string_lossy().into_owned();
    Ok(())
}

#[tauri::command]
pub(crate) fn get_acp_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AcpState>,
) -> Result<AcpStatus, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
    status.executable =
        crate::find_antigravity_cli(&home).map(|path| path.to_string_lossy().into_owned());
    let root = profile(&crate::core_base_dir()?);
    status.upstream_enabled = bridge::upstream_enabled(&root)?;
    let accounts = accounts::read(&root)?;
    let profile = accounts::directory(&root, &accounts.active)?;
    status.active_account = accounts.active;
    status.accounts = accounts.accounts;
    status.profile = profile.to_string_lossy().into_owned();
    if !status.authenticated && !status.busy {
        status.selected_model = read_selected(&profile)?;
    }
    Ok(status.clone())
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
        Some(registry.accounts.into_iter().find(|account| account.id == id && account.isolated && registry.active == id)
            .ok_or("Only the active isolated ACP account can sign in again")?)
    } else { None };
    let mut pending = accounts::PendingAccount::new_isolated(&root, replacement.as_ref().map_or(label.as_str(), |account| account.label.as_str()), replacement.is_some())?;
    let directory = pending.directory()?;
    let proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AcpState>();
        let result = (|| {
            // Terminal authentication is not an ACP authenticate RPC. Use the
            // fixed official invocation, then reconnect to the same profile.
            let login = manual_auth::TerminalLogin::resolve(&executable, &directory, &proxy, &guard.cancel)?;
            let command = login.command(&executable, &directory, &proxy)?;
            let identity = state.manual_auth.run(command, &pending.id, &guard.cancel, |link| {
                on_link.send(link).map_err(|_| String::from(manual_auth::FAILED))
            })?;
            accounts::require_isolated_token(&directory)?;
            let mut client = rpc::Client::spawn(&executable, &directory, &proxy)?;
            finish_manual_add(state.inner(), &root, &directory, &guard.cancel, &mut client, &mut pending, identity, replacement.as_ref().map(|account| account.id.as_str()))
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

fn finish_manual_add(
    state: &AcpState, root: &Path, profile: &Path,
    cancel: &Arc<AtomicBool>, client: &mut rpc::Client,
    pending: &mut accounts::PendingAccount,
    terminal_identity: Option<String>,
    replace: Option<&str>,
) -> Result<(), String> {
    // The fresh server loads the terminal-authorized profile. Only its own
    // official identity log is trusted; neither a label nor user input is identity.
    client.initialize(cancel)?;
    let session = client.session(profile, cancel);
    if cancel.load(Ordering::Acquire) { return Err("ACP request cancelled".into()); }
    let session_identity = client.account_email(profile);
    if let (Some(terminal), Some(session)) = (&terminal_identity, &session_identity) {
        if !session.eq_ignore_ascii_case(terminal) { return Err(accounts::IDENTITY_UNKNOWN.into()); }
    }
    let identity = session_identity.or(terminal_identity);
    let session = match session {
        Ok(session) if !model_list(&session).is_empty() => session,
        _ if replace.is_none() && identity.is_some() => {
            pending.commit_replacing(identity, None, false)?;
            return Err("Account saved; connection not verified: Antigravity did not provide usable models".into());
        }
        _ => return Err("Antigravity did not verify the isolated ACP connection".into()),
    };
    pending.commit_replacing(identity, replace, true)?;
    let discovered = (|| {
        reset_account(state)?;
        refresh_account_identity(state, root)?;
        mark_session(state, &session, profile)
    })();
    if discovered.is_err() { let _ = reset_account(state); }
    let result = combine_account_errors(discovered, sync_account_models(state));
    if let Some(id) = replace {
        return combine_account_errors(result, accounts::archive_replaced(root, id));
    }
    result
}

#[tauri::command]
pub(crate) async fn relogin_acp_account(app: tauri::AppHandle) -> Result<AcpStatus, String> {
    let guard = begin(&app, "login")?;
    if accounts::is_isolated_home(&accounts::active(&profile(&crate::core_base_dir()?))?) {
        return Err("Use the account's isolated sign-in to authorize it again".into());
    }
    clear_account(&app)?;
    connect(app, true, true, None, guard).await
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
pub(crate) async fn logout_acp_account(app: tauri::AppHandle) -> Result<AcpStatus, String> {
    let guard = begin(&app, "logout")?;
    clear_account(&app)?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let executable = match crate::find_antigravity_cli(&home) {
        Some(executable) => executable,
        None => {
            let state = app.state::<AcpState>();
            let result = combine_account_errors(Err("Install official Antigravity CLI to sign out. You can still remove the local account record.".into()), sync_account_models(state.inner()));
            if let Err(error) = &result {
                record_error(state.inner(), error);
            }
            return result;
        }
    };
    let root = profile(&crate::core_base_dir()?);
    let profile = accounts::active(&root)?;
    let proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = (|| {
            prepare_profile(&profile)?;
            let mut client = rpc::Client::spawn(&executable, &profile, &proxy)?;
            logout_session(
                app.state::<AcpState>().inner(),
                &root,
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

fn reset_account(state: &AcpState) -> Result<(), String> {
    state.agents.clear();
    let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
    status.authenticated = false;
    status.models.clear();
    status.selected_model.clear();
    status.latest_probe = None;
    Ok(())
}

fn refresh_account_identity(state: &AcpState, root: &Path) -> Result<(), String> {
    let registry = accounts::read(root)?;
    let directory = accounts::directory(root, &registry.active)?;
    let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
    status.active_account = registry.active;
    status.profile = directory.to_string_lossy().into_owned();
    Ok(())
}

fn clear_account(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AcpState>();
    reset_account(state.inner())?;
    // Clearing local state is independent of CPA provider-file maintenance.
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
    reset_account(state)?;
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
    let current = accounts::read(root)?.active == id;
    if current {
        reset_account(state)?;
    }
    // Never let a damaged/unwritable CPA provider config prevent isolating an
    // account. Apply local mutation first, then report both independent errors.
    let mut result = accounts::remove(root, id).map(|_| ());
    if current {
        result = combine_account_errors(result, refresh_account_identity(state, root));
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
    let directory = match pending.as_ref() {
        Some(pending) => pending.directory()?,
        None => accounts::active(&root)?,
    };
    let proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
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
                result = combine_account_errors(result, reset_account(state.inner()));
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

fn logout_session(
    state: &AcpState,
    root: &Path,
    cancel: &Arc<AtomicBool>,
    client: &mut rpc::Client,
) -> Result<(), String> {
    // Invalidation is local and immediate even when official logout is missing.
    // Never silently substitute deleting credentials for the official method.
    reset_account(state)?;
    let maintenance = sync_account_models(state);
    let action = (|| {
        client.initialize(cancel)?;
        client.logout(cancel)?;
        if accounts::is_isolated_home(&accounts::active(root)?) { Ok(()) } else { accounts::set_active_email(root, None) }
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
    state.cancel();
}

#[tauri::command]
pub(crate) fn select_acp_model(
    state: tauri::State<'_, AcpState>,
    model: String,
) -> Result<AcpStatus, String> {
    let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
    if status.busy {
        return Err("Wait for the current ACP operation to finish".into());
    }
    if !status.models.iter().any(|item| item.id == model) {
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
    Ok(status.clone())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResult {
    text: String,
    model: String,
    duration_ms: u64,
    first_text_ms: Option<u64>,
    stop_reason: String,
}

#[tauri::command]
pub(crate) async fn test_acp_connection(app: tauri::AppHandle) -> Result<ProbeResult, String> {
    let guard = begin(&app, "test")?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let executable =
        crate::find_antigravity_cli(&home).ok_or("Official Antigravity CLI not found")?;
    let model = app.state::<AcpState>().snapshot()?.selected_model;
    let profile = accounts::active(&profile(&crate::core_base_dir()?))?;
    let proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let result: Result<ProbeResult, String> = (|| {
            let mut client = rpc::Client::spawn(&executable, &profile, &proxy)?;
            client.initialize(&guard.cancel)?;
            let session = client.session(&profile, &guard.cancel)?;
            client.model(&session, &model, &guard.cancel)?;
            let mut text = String::new();
            let mut first_text_ms = None;
            let result = client.call("session/prompt", json!({"sessionId":session["sessionId"],"prompt":[{"type":"text","text":"Reply with only ACP_OK. Do not use any tools."}]}), &guard.cancel, |update| {
                if update["sessionUpdate"] == "agent_message_chunk" && update["content"]["type"] == "text" {
                    if let Some(part) = update["content"]["text"].as_str() {
                        first_text_ms.get_or_insert(started.elapsed().as_millis() as u64);
                        text.push_str(part);
                    }
                }
            })?;
            let stop_reason = result["stopReason"].as_str().unwrap_or("unknown").to_string();
            if stop_reason != "end_turn" || text.trim() != "ACP_OK" { return Err("ACP test did not return the expected complete response".into()); }
            Ok(ProbeResult { text, model, duration_ms: started.elapsed().as_millis() as u64, first_text_ms, stop_reason })
        })();
        if let Ok(mut status) = app.state::<AcpState>().status.lock() {
            match &result {
                Ok(probe) => status.latest_probe = Some(probe.clone()),
                Err(error) => status.error = Some(error.clone()),
            }
        }
        drop(guard);
        result
    }).await.map_err(|e| e.to_string())?
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
