use super::*;

#[tauri::command]
pub(crate) fn health_check() -> &'static str {
    "EasyCLIProxyAPI Rust backend is ready"
}

#[tauri::command]
pub(crate) fn detect_core_platform() -> Result<CorePlatform, String> {
    current_core_platform()
}

#[tauri::command]
pub(crate) async fn get_core_status(app: tauri::AppHandle) -> Result<CoreStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = app.state::<GuiConfigState>().snapshot()?;
        current_core_status(
            Some(app.state::<CoreProcessState>().inner()),
            Some(config.port),
        )
    })
    .await
    .map_err(|error| format!("内核状态后台任务失败: {error}"))?
}

pub(crate) fn emit_core_status(app: &tauri::AppHandle, status: &CoreStatus) {
    #[cfg(target_os = "windows")]
    update_windows_tray_status(app, status);
    let _ = app.emit(CORE_STATUS_EVENT, status);
}

#[tauri::command]
pub(crate) fn get_gui_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<GuiSettings, String> {
    let config = gui_config_state.snapshot()?;
    Ok(GuiSettings::from(&config))
}

#[tauri::command]
pub(crate) fn resolve_api_access_remarks(
    queries: Vec<ApiAccessRemarkQuery>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<String>, String> {
    let config = gui_config_state.snapshot()?;
    queries
        .into_iter()
        .map(|query| resolve_api_access_remark(&config, &query))
        .collect()
}

#[tauri::command]
pub(crate) fn save_api_access_remark(
    update: ApiAccessRemarkUpdate,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<(), String> {
    gui_config_state.update(|config| apply_api_access_remark_update(config, update))?;
    Ok(())
}

fn api_access_locator_identity(
    provider_section: &str,
    locator: &ApiAccessRemarkLocator,
) -> Option<(String, Vec<String>)> {
    let mut api_key_hashes = locator
        .api_keys
        .iter()
        .filter_map(|key| api_access_key_hash(key))
        .collect::<Vec<_>>();
    api_key_hashes.sort();
    api_key_hashes.dedup();
    if api_key_hashes.is_empty() {
        return None;
    }

    let mut identity = Vec::new();
    for component in [
        provider_section.trim(),
        locator.provider_name.trim(),
        locator.base_url.trim(),
    ] {
        identity.extend_from_slice(&(component.len() as u64).to_be_bytes());
        identity.extend_from_slice(component.as_bytes());
    }
    identity.extend_from_slice(&(api_key_hashes.len() as u64).to_be_bytes());
    for hash in &api_key_hashes {
        identity.extend_from_slice(&(hash.len() as u64).to_be_bytes());
        identity.extend_from_slice(hash.as_bytes());
    }
    Some((sha256_bytes(&identity), api_key_hashes))
}

fn resolve_api_access_remark(
    config: &GuiConfigFile,
    query: &ApiAccessRemarkQuery,
) -> Result<String, String> {
    validate_api_access_provider_section(&query.provider_section)?;
    let Some((record_hash, api_key_hashes)) =
        api_access_locator_identity(&query.provider_section, &query.locator)
    else {
        return Ok(String::new());
    };

    let exact_entries = config.api_access_remarks.iter().filter(|entry| {
        entry.provider_section == query.provider_section
            && entry.record_hash == record_hash
            && api_key_hashes.contains(&entry.api_key_hash)
    });
    let mut exact_found = false;
    let mut exact_remark = String::new();
    for entry in exact_entries {
        exact_found = true;
        if !entry.remark.is_empty() {
            exact_remark = entry.remark.clone();
            break;
        }
    }
    if exact_found {
        return Ok(exact_remark);
    }

    Ok(api_key_hashes
        .iter()
        .find_map(|hash| {
            config.api_access_remarks.iter().find(|entry| {
                entry.provider_section == query.provider_section
                    && entry.record_hash.is_empty()
                    && entry.api_key_hash == *hash
            })
        })
        .map(|entry| entry.remark.clone())
        .unwrap_or_default())
}

fn apply_api_access_remark_update(
    config: &mut GuiConfigFile,
    update: ApiAccessRemarkUpdate,
) -> Result<(), String> {
    validate_api_access_provider_section(&update.provider_section)?;
    let remark = update.remark.trim().to_string();
    validate_api_key_remark(&remark)?;
    let previous_records = update
        .previous_records
        .iter()
        .filter_map(|locator| api_access_locator_identity(&update.provider_section, locator))
        .collect::<Vec<_>>();
    let next_records = update
        .records
        .iter()
        .filter_map(|locator| api_access_locator_identity(&update.provider_section, locator))
        .collect::<Vec<_>>();
    let all_records = update
        .all_records
        .iter()
        .filter_map(|locator| api_access_locator_identity(&update.provider_section, locator))
        .collect::<Vec<_>>();
    let record_hashes_to_replace = previous_records
        .iter()
        .chain(next_records.iter())
        .map(|(record_hash, _)| record_hash.clone())
        .collect::<HashSet<_>>();
    let provider_section = update.provider_section;
    let legacy_entries = config
        .api_access_remarks
        .iter()
        .filter(|entry| entry.provider_section == provider_section && entry.record_hash.is_empty())
        .cloned()
        .collect::<Vec<_>>();
    let legacy_migrations = all_records
        .iter()
        .filter_map(|(record_hash, api_key_hashes)| {
            let remark = api_key_hashes.iter().find_map(|api_key_hash| {
                legacy_entries
                    .iter()
                    .find(|entry| entry.api_key_hash == *api_key_hash)
                    .map(|entry| entry.remark.clone())
            })?;
            Some((record_hash.clone(), api_key_hashes.clone(), remark))
        })
        .collect::<Vec<_>>();

    config.api_access_remarks.retain(|entry| {
        entry.provider_section != provider_section
            || (!entry.record_hash.is_empty()
                && !record_hashes_to_replace.contains(&entry.record_hash))
    });
    let mut inserted_record_hashes = config
        .api_access_remarks
        .iter()
        .filter(|entry| entry.provider_section == provider_section && !entry.record_hash.is_empty())
        .map(|entry| entry.record_hash.clone())
        .collect::<HashSet<_>>();
    for (record_hash, api_key_hashes) in next_records {
        if !inserted_record_hashes.insert(record_hash.clone()) {
            continue;
        }
        config
            .api_access_remarks
            .extend(
                api_key_hashes
                    .into_iter()
                    .map(|api_key_hash| GuiApiAccessRemark {
                        provider_section: provider_section.clone(),
                        api_key_hash,
                        record_hash: record_hash.clone(),
                        remark: remark.clone(),
                    }),
            );
    }
    for (record_hash, api_key_hashes, legacy_remark) in legacy_migrations {
        if !inserted_record_hashes.insert(record_hash.clone()) {
            continue;
        }
        config
            .api_access_remarks
            .extend(
                api_key_hashes
                    .into_iter()
                    .map(|api_key_hash| GuiApiAccessRemark {
                        provider_section: provider_section.clone(),
                        api_key_hash,
                        record_hash: record_hash.clone(),
                        remark: legacy_remark.clone(),
                    }),
            );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locator(base_url: &str, api_keys: &[&str]) -> ApiAccessRemarkLocator {
        ApiAccessRemarkLocator {
            provider_name: String::new(),
            base_url: base_url.to_string(),
            api_keys: api_keys.iter().map(|key| (*key).to_string()).collect(),
        }
    }

    fn query(locator: ApiAccessRemarkLocator) -> ApiAccessRemarkQuery {
        ApiAccessRemarkQuery {
            provider_section: "codex-api-key".to_string(),
            locator,
        }
    }

    fn update(
        previous_records: Vec<ApiAccessRemarkLocator>,
        records: Vec<ApiAccessRemarkLocator>,
        all_records: Vec<ApiAccessRemarkLocator>,
        remark: &str,
    ) -> ApiAccessRemarkUpdate {
        ApiAccessRemarkUpdate {
            provider_section: "codex-api-key".to_string(),
            previous_records,
            records,
            all_records,
            remark: remark.to_string(),
        }
    }

    #[test]
    fn remarks_are_scoped_to_provider_records_that_share_an_api_key() {
        let mut config = GuiConfigFile::default();
        let first = locator("https://first.example/v1", &["shared-key"]);
        let second = locator("https://second.example/v1", &["shared-key"]);

        apply_api_access_remark_update(
            &mut config,
            update(
                Vec::new(),
                vec![first.clone()],
                vec![first.clone()],
                "first",
            ),
        )
        .unwrap();
        apply_api_access_remark_update(
            &mut config,
            update(
                Vec::new(),
                vec![second.clone()],
                vec![first.clone(), second.clone()],
                "second",
            ),
        )
        .unwrap();

        assert_eq!(
            resolve_api_access_remark(&config, &query(first.clone())).unwrap(),
            "first"
        );
        assert_eq!(
            resolve_api_access_remark(&config, &query(second.clone())).unwrap(),
            "second"
        );

        apply_api_access_remark_update(
            &mut config,
            update(vec![first.clone()], Vec::new(), vec![second.clone()], ""),
        )
        .unwrap();
        assert_eq!(
            resolve_api_access_remark(&config, &query(second)).unwrap(),
            "second"
        );
    }

    #[test]
    fn record_scoped_remarks_override_legacy_key_scoped_remarks() {
        let mut config = GuiConfigFile::default();
        let first = locator("https://first.example/v1", &["shared-key"]);
        let second = locator("https://second.example/v1", &["shared-key"]);
        config.api_access_remarks.push(GuiApiAccessRemark {
            provider_section: "codex-api-key".to_string(),
            api_key_hash: api_access_key_hash("shared-key").unwrap(),
            record_hash: String::new(),
            remark: "legacy".to_string(),
        });

        apply_api_access_remark_update(
            &mut config,
            update(
                vec![first.clone()],
                vec![first.clone()],
                vec![first.clone(), second.clone()],
                "updated",
            ),
        )
        .unwrap();
        assert_eq!(
            resolve_api_access_remark(&config, &query(first.clone())).unwrap(),
            "updated"
        );
        assert_eq!(
            resolve_api_access_remark(&config, &query(second.clone())).unwrap(),
            "legacy"
        );

        apply_api_access_remark_update(
            &mut config,
            update(
                vec![first.clone()],
                vec![first.clone()],
                vec![first.clone(), second.clone()],
                "",
            ),
        )
        .unwrap();
        assert_eq!(
            resolve_api_access_remark(&config, &query(first)).unwrap(),
            ""
        );
        assert_eq!(
            resolve_api_access_remark(&config, &query(second)).unwrap(),
            "legacy"
        );
        assert!(config
            .api_access_remarks
            .iter()
            .all(|entry| !entry.record_hash.is_empty()));
    }

    #[test]
    fn updating_a_single_legacy_record_removes_the_stale_key_mapping() {
        let mut config = GuiConfigFile::default();
        let record = locator("https://api.example/v1", &["shared-key"]);
        config.api_access_remarks.push(GuiApiAccessRemark {
            provider_section: "codex-api-key".to_string(),
            api_key_hash: api_access_key_hash("shared-key").unwrap(),
            record_hash: String::new(),
            remark: "legacy".to_string(),
        });

        apply_api_access_remark_update(
            &mut config,
            update(
                vec![record.clone()],
                vec![record.clone()],
                vec![record.clone()],
                "updated",
            ),
        )
        .unwrap();

        assert_eq!(
            resolve_api_access_remark(&config, &query(record)).unwrap(),
            "updated"
        );
        assert_eq!(
            config.api_access_remark_for_source("codex", "shared-key"),
            Some("updated")
        );
        assert!(config
            .api_access_remarks
            .iter()
            .all(|entry| !entry.record_hash.is_empty()));
    }

    #[test]
    fn legacy_remark_entries_deserialize_without_a_record_hash() {
        let entry = toml::from_str::<GuiApiAccessRemark>(
            r#"provider-section = "codex-api-key"
api-key-hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
remark = "legacy"
"#,
        )
        .unwrap();

        assert!(entry.record_hash.is_empty());
        assert_eq!(entry.remark, "legacy");
    }

    #[test]
    fn remark_command_payloads_accept_record_locators() {
        let query = serde_json::from_value::<ApiAccessRemarkQuery>(serde_json::json!({
            "providerSection": "openai-compatibility",
            "providerName": "first",
            "baseUrl": "https://api.example/v1",
            "apiKeys": ["shared-key"]
        }))
        .unwrap();
        let update = serde_json::from_value::<ApiAccessRemarkUpdate>(serde_json::json!({
            "providerSection": "openai-compatibility",
            "previousRecords": [{
                "providerName": "first",
                "baseUrl": "https://api.example/v1",
                "apiKeys": ["shared-key"]
            }],
            "records": [{
                "providerName": "second",
                "baseUrl": "https://api.example/v1",
                "apiKeys": ["shared-key"]
            }],
            "allRecords": [{
                "providerName": "second",
                "baseUrl": "https://api.example/v1",
                "apiKeys": ["shared-key"]
            }],
            "remark": "second"
        }))
        .unwrap();

        assert_eq!(query.locator.provider_name, "first");
        assert_eq!(update.previous_records[0].provider_name, "first");
        assert_eq!(update.records[0].provider_name, "second");
        assert_eq!(update.all_records[0].provider_name, "second");
    }
}

#[tauri::command]
pub(crate) fn set_app_locale(
    app: tauri::AppHandle,
    process_state: tauri::State<'_, CoreProcessState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    locale: String,
) -> Result<String, String> {
    let config = gui_config_state.set_locale(locale)?;
    #[cfg(target_os = "windows")]
    if let Ok(status) = current_core_status(Some(process_state.inner()), Some(config.port)) {
        update_windows_tray_locale(&app, &config.locale, &status);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (app, process_state);
    Ok(config.locale)
}

#[tauri::command]
pub(crate) fn resolve_windows_close_request(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    action: WindowsCloseAction,
    remember: Option<bool>,
) -> Result<(), String> {
    if remember.unwrap_or(false) {
        let close_behavior = match action {
            WindowsCloseAction::Exit => WindowsCloseBehavior::Exit,
            WindowsCloseAction::MinimizeToTray => WindowsCloseBehavior::MinimizeToTray,
        };
        gui_config_state.set_close_behavior(close_behavior)?;
    }

    match action {
        WindowsCloseAction::Exit => app.exit(0),
        WindowsCloseAction::MinimizeToTray => {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "主窗口不存在".to_string())?;
            window
                .hide()
                .map_err(|error| format!("隐藏主窗口失败: {error}"))?;
        }
    }

    Ok(())
}

pub(crate) fn app_autostart_enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("读取系统开机自启状态失败: {error}"))
}

pub(crate) fn set_app_autostart_enabled(
    app: &tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|error| format!("启用开机自启失败: {error}"))
    } else {
        manager
            .disable()
            .map_err(|error| format!("关闭开机自启失败: {error}"))
    }
}

pub(crate) fn software_settings(
    app: &tauri::AppHandle,
    config: &GuiConfigFile,
) -> Result<SoftwareSettings, String> {
    Ok(SoftwareSettings {
        close_behavior: config.close_behavior,
        autostart_enabled: app_autostart_enabled(app)?,
        start_core_on_launch: config.start_core_on_launch,
        silent_start_enabled: config.silent_start,
        default_terminal: normalize_agent_terminal(&config.default_terminal),
        available_terminals: available_agent_terminals(),
    })
}

#[tauri::command]
pub(crate) fn get_software_settings(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<SoftwareSettings, String> {
    let config = gui_config_state.snapshot()?;
    software_settings(&app, &config)
}

#[tauri::command]
pub(crate) fn save_software_settings(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: SoftwareSettingsInput,
) -> Result<SoftwareSettings, String> {
    let previous_config = gui_config_state.snapshot()?;
    let previous_autostart_enabled = app_autostart_enabled(&app)?;
    let autostart_changed = previous_autostart_enabled != settings.autostart_enabled;
    let default_terminal = normalize_agent_terminal(&settings.default_terminal);

    if autostart_changed {
        set_app_autostart_enabled(&app, settings.autostart_enabled)?;
    }

    let config = if previous_config.close_behavior == settings.close_behavior
        && previous_config.start_core_on_launch == settings.start_core_on_launch
        && previous_config.silent_start == settings.silent_start_enabled
        && previous_config.default_terminal == default_terminal
    {
        previous_config
    } else {
        match gui_config_state.set_software_preferences(
            settings.close_behavior,
            settings.start_core_on_launch,
            settings.silent_start_enabled,
            default_terminal.clone(),
        ) {
            Ok(config) => config,
            Err(error) => {
                let rollback_error = autostart_changed
                    .then(|| set_app_autostart_enabled(&app, previous_autostart_enabled).err())
                    .flatten();
                return Err(match rollback_error {
                    Some(rollback_error) => {
                        format!("{error}; 回滚开机自启设置也失败: {rollback_error}")
                    }
                    None => error,
                });
            }
        }
    };

    software_settings(&app, &config)
}
