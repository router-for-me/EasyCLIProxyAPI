use super::adapters;
use super::adapters::common::preview_from_record;
use super::cpa_import::{
    export_json_payload, import_cpa_selections, import_json_payload, preview_cpa_oauth_dir,
    resolve_local_cpa_oauth_dir,
};
use super::oauth_server::{cancel_session, get_session_view};
use super::process_control::{detect_running_pids, restart_platform_client, stop_client_processes};
use super::proxy_guard::{decouple_platform_proxy, inspect_platform_proxy};
use super::sync::{inspect_sync_targets, run_sync_targets};
use super::types::{
    now_millis, AccountGroup, AccountMetaPatch, AccountSummary, AccountSwitchCatalog,
    CpaImportCandidate, CpaImportSelection, DecoupleProxyResult, GroupAction, ImportBatchResult,
    OAuthSessionView, PlatformAccountsPayload, PlatformRuntimeStatus, ProxyMode,
    RefreshQuotaResult, SwitchAccountOptions, SwitchAccountResult, SwitchPlatformId,
};
use super::vault::AccountVault;
use crate::agents::{
    validate_agent_config_directories, AgentConfigDirectories, AGENT_CONFIG_DIRECTORIES,
};
use crate::core_config::effective_agent_api_key;
use crate::runtime::{AppHandle, State};
use crate::{AgentConfigStatusCache, GuiConfigState};
use std::path::Path;

fn build_platform_status(
    vault: &AccountVault,
    platform: SwitchPlatformId,
    home: &Path,
    cpa_port: u16,
    cpa_api_key: &str,
) -> Result<PlatformRuntimeStatus, String> {
    let records = vault.list_records(platform)?;
    let active_id = vault.get_active_account_id(platform)?;
    let local_record = adapters::read_local_preview(platform, home).ok().flatten();
    let local_preview = preview_from_record(local_record, &records);
    let running_pids = detect_running_pids(platform);
    let proxy = inspect_platform_proxy(platform, home, cpa_port, cpa_api_key);
    let installed = adapters::is_installed(platform, home);
    let sync_targets = inspect_sync_targets(platform, home);

    Ok(PlatformRuntimeStatus {
        platform,
        category: platform.category(),
        display_name: platform.display_name().to_string(),
        installed,
        running: !running_pids.is_empty(),
        running_pids,
        proxy,
        active_account_id: active_id.or_else(|| local_preview.matched_account_id.clone()),
        local_credential: local_preview,
        account_count: records.len(),
        supports_oauth: platform.supports_oauth(),
        supports_cpa_import: platform.supports_cpa_import(),
        supports_client_restart: platform.supports_client_restart(),
        sync_targets,
    })
}

fn resolve_home(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .home_dir()
        .map_err(|error| format!("Failed to resolve user home directory: {error}"))
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_get_catalog(
    app: AppHandle,
    gui_config_state: State<'_, GuiConfigState>,
    config_directories: Option<AgentConfigDirectories>,
) -> Result<AccountSwitchCatalog, String> {
    let directories = validate_agent_config_directories(config_directories)?;
    let home = resolve_home(&app)?;
    let config = gui_config_state.snapshot()?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config).to_string();

    tokio::task::spawn_blocking(move || {
        AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
            let vault = AccountVault::open_default()?;
            let mut platforms = Vec::with_capacity(SwitchPlatformId::ALL.len());
            for platform in SwitchPlatformId::ALL {
                platforms.push(build_platform_status(
                    &vault, platform, &home, port, &api_key,
                )?);
            }
            let groups = vault.list_groups()?;
            Ok(AccountSwitchCatalog {
                vault_dir: vault.root_dir().to_string_lossy().into_owned(),
                platforms,
                groups,
            })
        })
    })
    .await
    .map_err(|error| format!("Catalog load task failed: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_list_accounts(
    app: AppHandle,
    gui_config_state: State<'_, GuiConfigState>,
    platform: String,
    config_directories: Option<AgentConfigDirectories>,
) -> Result<PlatformAccountsPayload, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    let directories = validate_agent_config_directories(config_directories)?;
    let home = resolve_home(&app)?;
    let config = gui_config_state.snapshot()?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config).to_string();

    tokio::task::spawn_blocking(move || {
        AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
            let vault = AccountVault::open_default()?;
            let status = build_platform_status(&vault, platform, &home, port, &api_key)?;
            let records = vault.list_records(platform)?;
            let active_id = status.active_account_id.as_deref();
            let accounts = records.iter().map(|r| r.to_summary(active_id)).collect();
            let groups = vault.list_groups()?;
            Ok(PlatformAccountsPayload {
                platform,
                status,
                accounts,
                groups,
            })
        })
    })
    .await
    .map_err(|error| format!("Account list task failed: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_inspect_platform(
    app: AppHandle,
    gui_config_state: State<'_, GuiConfigState>,
    platform: String,
    config_directories: Option<AgentConfigDirectories>,
) -> Result<PlatformRuntimeStatus, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    let directories = validate_agent_config_directories(config_directories)?;
    let home = resolve_home(&app)?;
    let config = gui_config_state.snapshot()?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config).to_string();

    tokio::task::spawn_blocking(move || {
        AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
            let vault = AccountVault::open_default()?;
            build_platform_status(&vault, platform, &home, port, &api_key)
        })
    })
    .await
    .map_err(|error| format!("Platform inspection failed: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_import_local(
    app: AppHandle,
    platform: String,
    config_directories: Option<AgentConfigDirectories>,
) -> Result<AccountSummary, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    let directories = validate_agent_config_directories(config_directories)?;
    let home = resolve_home(&app)?;

    tokio::task::spawn_blocking(move || {
        AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
            let vault = AccountVault::open_default()?;
            let (saved, _) = adapters::import_local_account(platform, &home, &vault)?;
            let active_id = vault.get_active_account_id(platform)?;
            Ok(saved.to_summary(active_id.as_deref()))
        })
    })
    .await
    .map_err(|error| format!("Local import task failed: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_preview_cpa_oauth(
    platform: Option<String>,
) -> Result<Vec<CpaImportCandidate>, String> {
    let filter = match platform.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(SwitchPlatformId::parse(raw)?),
        None => None,
    };
    tokio::task::spawn_blocking(move || {
        let vault = AccountVault::open_default()?;
        let oauth_dir = resolve_local_cpa_oauth_dir()?;
        preview_cpa_oauth_dir(&vault, &oauth_dir, filter)
    })
    .await
    .map_err(|error| format!("CPA oauth preview failed: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_import_cpa_oauth(
    entries: Vec<CpaImportSelection>,
) -> Result<ImportBatchResult, String> {
    tokio::task::spawn_blocking(move || {
        let vault = AccountVault::open_default()?;
        import_cpa_selections(&vault, entries)
    })
    .await
    .map_err(|error| format!("CPA oauth import failed: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_import_json(
    platform: String,
    payload: String,
) -> Result<ImportBatchResult, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    tokio::task::spawn_blocking(move || {
        let vault = AccountVault::open_default()?;
        import_json_payload(&vault, platform, &payload)
    })
    .await
    .map_err(|error| format!("JSON import failed: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_export_json(
    platform: String,
    account_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    tokio::task::spawn_blocking(move || {
        let vault = AccountVault::open_default()?;
        export_json_payload(&vault, platform, account_ids)
    })
    .await
    .map_err(|error| format!("JSON export failed: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_oauth_start(
    gui_config_state: State<'_, GuiConfigState>,
    platform: String,
) -> Result<OAuthSessionView, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    let vault = AccountVault::open_default()?;
    let proxy_url = gui_config_state
        .snapshot()
        .ok()
        .and_then(|c| (!c.proxy_url.trim().is_empty()).then_some(c.proxy_url));
    adapters::start_oauth_login(platform, vault.root_dir().to_path_buf(), proxy_url).await
}

#[ecpa_macros::ecpa_command]
pub(crate) fn account_switch_oauth_poll(session_id: String) -> Result<OAuthSessionView, String> {
    get_session_view(&session_id)
}

#[ecpa_macros::ecpa_command]
pub(crate) fn account_switch_oauth_cancel(session_id: String) -> Result<OAuthSessionView, String> {
    cancel_session(&session_id)
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_decouple_proxy(
    app: AppHandle,
    gui_config_state: State<'_, GuiConfigState>,
    platform: String,
    config_directories: Option<AgentConfigDirectories>,
) -> Result<DecoupleProxyResult, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    let directories = validate_agent_config_directories(config_directories)?;
    let home = resolve_home(&app)?;
    let config = gui_config_state.snapshot()?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config).to_string();
    let app_handle = app.clone();

    tokio::task::spawn_blocking(move || {
        AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
            let (changed, message) = decouple_platform_proxy(platform, &home, port)?;
            if changed {
                let _ = app_handle.state::<AgentConfigStatusCache>().clear();
            }
            let vault = AccountVault::open_default()?;
            let status = build_platform_status(&vault, platform, &home, port, &api_key)?;
            Ok(DecoupleProxyResult {
                platform,
                changed,
                message,
                status,
            })
        })
    })
    .await
    .map_err(|error| format!("Proxy decouple task failed: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_switch_account(
    app: AppHandle,
    gui_config_state: State<'_, GuiConfigState>,
    platform: String,
    account_id: String,
    options: Option<SwitchAccountOptions>,
) -> Result<SwitchAccountResult, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    let opts = options.unwrap_or_default();
    let directories = validate_agent_config_directories(opts.config_directories.clone())?;
    let home = resolve_home(&app)?;
    let config = gui_config_state.snapshot()?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config).to_string();
    let proxy_url = (!config.proxy_url.trim().is_empty()).then_some(config.proxy_url.clone());

    let vault = AccountVault::open_default()?;
    let mut record = vault
        .load_record(platform, &account_id)?
        .ok_or_else(|| format!("Account not found: {account_id}"))?;

    let mut warnings = Vec::new();
    let mut refreshed_token = false;

    // 1. Pre-switch automatic expired token refresh (async network step).
    if opts.refresh_before_switch {
        match adapters::refresh_if_needed(&mut record, false, proxy_url.as_deref()).await {
            Ok(true) => {
                refreshed_token = true;
                record = vault.save_record(record)?;
            }
            Ok(false) => {}
            Err(err) => {
                warnings.push(format!(
                    "Token auto-refresh skipped due to error (proceeding with stored token): {err}"
                ));
            }
        }
    }

    let app_handle = app.clone();
    let sync_targets = opts.sync_targets.clone();
    let decouple_requested = opts.decouple_cpa_proxy;
    let restart_requested = opts.restart_client;

    tokio::task::spawn_blocking(move || {
        AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
            let vault = AccountVault::open_default()?;
            let mut decoupled_proxy = false;

            // 2. Detect & optionally decouple CPA reverse proxy before injecting official credentials.
            let current_proxy = inspect_platform_proxy(platform, &home, port, &api_key);
            if decouple_requested && current_proxy.mode == ProxyMode::CpaProxy {
                match decouple_platform_proxy(platform, &home, port) {
                    Ok((changed, _)) => {
                        decoupled_proxy = changed;
                        if changed {
                            let _ = app_handle.state::<AgentConfigStatusCache>().clear();
                        }
                    }
                    Err(err) => {
                        warnings.push(format!("Failed to decouple CPA proxy: {err}"));
                    }
                }
            }

            // 3. Claude Desktop requires process closed before replacing SQLite/Cookies snapshot files.
            if platform == SwitchPlatformId::ClaudeDesktop
                && !detect_running_pids(platform).is_empty()
            {
                let _ = stop_client_processes(platform);
            }

            // 4. Atomic native credential injection.
            adapters::apply_account(platform, &home, &vault, &record)?;

            // 5. Mark active & last_used_at in encrypted vault + SQLite state.
            record.last_used_at = Some(now_millis());
            let saved = vault.save_record(record)?;
            vault.set_active_account_id(platform, &saved.id, decoupled_proxy)?;

            // 6. Companion sync targets (OpenCode / OpenClaw / Hermes / WSL).
            let sync_results = if sync_targets.is_empty() {
                Vec::new()
            } else {
                run_sync_targets(&saved, &sync_targets, &home)
            };

            // 7. Optional desktop client restart.
            let mut client_restarted = false;
            if restart_requested && platform.supports_client_restart() {
                match restart_platform_client(&app_handle, platform) {
                    Ok(restarted) => client_restarted = restarted,
                    Err(err) => warnings.push(format!("Client restart warning: {err}")),
                }
            }

            let status = build_platform_status(&vault, platform, &home, port, &api_key)?;
            Ok(SwitchAccountResult {
                platform,
                account_id: saved.id,
                decoupled_proxy,
                refreshed_token,
                client_restarted,
                warnings,
                sync_results,
                status,
            })
        })
    })
    .await
    .map_err(|error| format!("Account switch task failed: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_refresh_quota(
    gui_config_state: State<'_, GuiConfigState>,
    platform: String,
    account_ids: Option<Vec<String>>,
) -> Result<RefreshQuotaResult, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    let vault = AccountVault::open_default()?;
    let proxy_url = gui_config_state
        .snapshot()
        .ok()
        .and_then(|c| (!c.proxy_url.trim().is_empty()).then_some(c.proxy_url));
    let active_id = vault.get_active_account_id(platform)?;
    let mut records = vault.list_records(platform)?;
    if let Some(ids) = account_ids.filter(|list| !list.is_empty()) {
        records.retain(|rec| ids.iter().any(|id| id == &rec.id));
    }

    let mut updated = Vec::new();
    let mut errors = Vec::new();

    for mut record in records {
        // Refresh expired OAuth token silently before querying quota.
        if let Ok(true) = adapters::refresh_if_needed(&mut record, false, proxy_url.as_deref()).await
        {
            if let Ok(saved) = vault.save_record(record.clone()) {
                record = saved;
            }
        }
        match adapters::fetch_quota(&record, proxy_url.as_deref()).await {
            Ok(quota) => match vault.update_quota(platform, &record.id, quota) {
                Ok(saved) => updated.push(saved.to_summary(active_id.as_deref())),
                Err(err) => errors.push(format!("{}: {err}", record.label)),
            },
            Err(err) => {
                errors.push(format!("{}: {err}", record.label));
                let failed_snapshot = super::types::QuotaSnapshot {
                    fetched_at: now_millis(),
                    plan: record.plan_type.clone(),
                    plan_expires_at: record.credentials.plan_expires_at,
                    metrics: record
                        .last_quota
                        .as_ref()
                        .map(|q| q.metrics.clone())
                        .unwrap_or_default(),
                    error: Some(err),
                };
                if let Ok(saved) = vault.update_quota(platform, &record.id, failed_snapshot) {
                    updated.push(saved.to_summary(active_id.as_deref()));
                }
            }
        }
    }

    Ok(RefreshQuotaResult {
        platform,
        updated,
        errors,
    })
}

#[ecpa_macros::ecpa_command]
pub(crate) fn account_switch_update_account_meta(
    platform: String,
    account_id: String,
    patch: AccountMetaPatch,
) -> Result<AccountSummary, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    let vault = AccountVault::open_default()?;
    vault.update_meta(platform, &account_id, patch)
}

#[ecpa_macros::ecpa_command]
pub(crate) fn account_switch_delete_accounts(
    platform: String,
    account_ids: Vec<String>,
) -> Result<usize, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    let vault = AccountVault::open_default()?;
    vault.delete_accounts(platform, &account_ids)
}

#[ecpa_macros::ecpa_command]
pub(crate) fn account_switch_manage_groups(action: GroupAction) -> Result<Vec<AccountGroup>, String> {
    let vault = AccountVault::open_default()?;
    vault.manage_groups(action)
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn account_switch_restart_client(
    app: AppHandle,
    platform: String,
) -> Result<bool, String> {
    let platform = SwitchPlatformId::parse(&platform)?;
    tokio::task::spawn_blocking(move || restart_platform_client(&app, platform))
        .await
        .map_err(|error| format!("Client restart task failed: {error}"))?
}
