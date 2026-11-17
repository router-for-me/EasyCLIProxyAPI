mod accounts;
mod bridge;
mod rpc;
mod agent;
mod tool_transport;
pub(crate) use tool_transport::run_helper as run_mcp_helper;
pub(crate) use bridge::restore;

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
    if status.selected_model.is_empty() {
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
    connect(app, login, false, guard).await
}

#[tauri::command]
pub(crate) async fn switch_acp_account(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<AcpStatus, String> {
    let guard = begin(&app, "refresh")?;
    let root = profile(&crate::core_base_dir()?);
    accounts::select(&root, &account_id)?;
    clear_account(&app)?;
    connect(app, false, false, guard).await
}

#[tauri::command]
pub(crate) async fn add_acp_account(
    app: tauri::AppHandle,
    label: String,
) -> Result<AcpStatus, String> {
    let guard = begin(&app, "login")?;
    let root = profile(&crate::core_base_dir()?);
    accounts::add(&root, &label)?;
    clear_account(&app)?;
    connect(app, true, false, guard).await
}

#[tauri::command]
pub(crate) async fn relogin_acp_account(app: tauri::AppHandle) -> Result<AcpStatus, String> {
    let guard = begin(&app, "login")?;
    connect(app, true, true, guard).await
}

fn clear_account(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AcpState>();
    state.agents.clear();
    {
        let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
        status.authenticated = false;
        status.models.clear();
        status.selected_model.clear();
        status.latest_probe = None;
        status.profile = accounts::active(&profile(&crate::core_base_dir()?))?
            .to_string_lossy()
            .into_owned();
    }
    bridge::sync_models(state.inner())
}

async fn connect(
    app: tauri::AppHandle,
    login: bool,
    switch_account: bool,
    guard: OperationGuard,
) -> Result<AcpStatus, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let executable = crate::find_antigravity_cli(&home)
        .ok_or("Install official Antigravity CLI before connecting")?;
    let accounts_root = profile(&crate::core_base_dir()?);
    let profile = accounts::active(&accounts_root)?;
    let proxy = app.state::<crate::GuiConfigState>().snapshot()?.proxy_url;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AcpState>();
        let result: Result<(), String> = (|| {
            prepare_profile(&profile)?;
            let mut client = rpc::Client::spawn(&executable, &profile, &proxy)?;
            connect_session(
                state.inner(),
                &accounts_root,
                login,
                switch_account,
                &guard.cancel,
                &mut client,
            )
        })();
        if let Err(error) = &result {
            if let Ok(mut status) = state.status.lock() {
                status.error = Some(error.clone());
                // Do not retain stale account capabilities after any failed refresh.
                status.authenticated = false;
                status.models.clear();
            }
            let _ = bridge::sync_models(state.inner());
        }
        drop(guard);
        result?;
        get_acp_status(app.clone(), app.state::<AcpState>())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn connect_session(
    state: &AcpState,
    root: &Path,
    login: bool,
    switch_account: bool,
    cancel: &Arc<AtomicBool>,
    client: &mut rpc::Client,
) -> Result<(), String> {
    let profile = accounts::active(root)?;
    if login {
        accounts::set_active_email(root, None)?;
    }
    client.initialize(cancel)?;
    if switch_account {
        client.logout(cancel)?;
        {
            let mut status = state.status.lock().map_err(|_| "ACP state unavailable")?;
            status.authenticated = false;
            status.models.clear();
            status.selected_model.clear();
        }
        bridge::sync_models(state)?;
    }
    if login {
        client.call(
            "authenticate",
            json!({"methodId":"oauth-personal"}),
            cancel,
            |_| {},
        )?;
    }
    let session = client.session(&profile, cancel)?;
    mark_session(state, &session, &profile)?;
    let _ = accounts::set_active_email(root, client.account_email(&profile));
    bridge::sync_models(state)
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
        let command = rpc::command(Path::new("agy"), Path::new("profile"), "");
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
