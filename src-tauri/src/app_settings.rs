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
pub(crate) fn get_core_status(
    process_state: tauri::State<'_, CoreProcessState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreStatus, String> {
    let config = gui_config_state.snapshot()?;
    current_core_status(Some(process_state.inner()), Some(config.port))
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
        .map(|query| {
            validate_api_access_provider_section(&query.provider_section)?;
            Ok(query
                .api_keys
                .iter()
                .filter_map(|key| api_access_key_hash(key))
                .find_map(|hash| {
                    config.api_access_remarks.iter().find(|entry| {
                        entry.provider_section == query.provider_section
                            && entry.api_key_hash == hash
                    })
                })
                .map(|entry| entry.remark.clone())
                .unwrap_or_default())
        })
        .collect()
}

#[tauri::command]
pub(crate) fn save_api_access_remark(
    update: ApiAccessRemarkUpdate,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<(), String> {
    validate_api_access_provider_section(&update.provider_section)?;
    let remark = update.remark.trim().to_string();
    validate_api_key_remark(&remark)?;
    let previous_hashes = update
        .previous_api_keys
        .iter()
        .filter_map(|key| api_access_key_hash(key))
        .collect::<HashSet<_>>();
    let next_hashes = update
        .api_keys
        .iter()
        .filter_map(|key| api_access_key_hash(key))
        .collect::<HashSet<_>>();
    let hashes_to_replace = previous_hashes
        .union(&next_hashes)
        .cloned()
        .collect::<HashSet<_>>();
    let provider_section = update.provider_section;

    gui_config_state.update(|config| {
        config.api_access_remarks.retain(|entry| {
            entry.provider_section != provider_section
                || !hashes_to_replace.contains(&entry.api_key_hash)
        });
        if !remark.is_empty() {
            config
                .api_access_remarks
                .extend(next_hashes.iter().map(|hash| GuiApiAccessRemark {
                    provider_section: provider_section.clone(),
                    api_key_hash: hash.clone(),
                    remark: remark.clone(),
                }));
        }
        Ok(())
    })?;
    Ok(())
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
