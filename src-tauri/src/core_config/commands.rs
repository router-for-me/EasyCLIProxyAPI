use super::*;

#[tauri::command]
pub(crate) fn get_lan_ipv4() -> Option<String> {
    detect_lan_ipv4().map(|address| address.to_string())
}

#[tauri::command]
pub(crate) fn get_core_tls_settings() -> Result<CoreTlsSettings, String> {
    current_core_tls_settings()
}

#[tauri::command]
pub(crate) fn save_core_tls_settings(
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: CoreTlsSettings,
) -> Result<CoreTlsSettings, String> {
    let settings = normalize_core_tls_settings(settings)?;
    patch_core_tls_settings(&settings)?;
    cache.clear()?;
    Ok(settings)
}

pub(crate) fn detect_lan_ipv4() -> Option<Ipv4Addr> {
    for target in ["192.0.2.1:80", "8.8.8.8:80"] {
        let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        let Ok(local_address) = socket.local_addr() else {
            continue;
        };
        let IpAddr::V4(address) = local_address.ip() else {
            continue;
        };
        if !address.is_unspecified() && !address.is_loopback() {
            return Some(address);
        }
    }
    None
}

#[tauri::command]
pub(crate) fn save_gui_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: GuiNetworkSettings,
) -> Result<GuiSettings, String> {
    if settings.port == 0 {
        return Err("端口必须在 1 到 65535 之间".to_string());
    }

    let _refresh_guard = cache
        .refresh_lock
        .lock()
        .map_err(|_| "智能体配置状态刷新锁已损坏".to_string())?;
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.port = settings.port;
    next.allow_lan = settings.allow_lan;
    next.host = if settings.allow_lan {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    }
    .to_string();
    patch_core_network_settings(&next)?;
    let config = match gui_config_state.update_network(settings.port, settings.allow_lan) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_network_settings(&previous).err();
            return Err(match rollback_error {
                Some(rollback_error) => {
                    format!("{error}；回滚内核网络配置也失败: {rollback_error}")
                }
                None => error,
            });
        }
    };

    if config.port != previous.port {
        if let Err(error) = cache.clear() {
            eprintln!("清空智能体配置状态缓存失败: {error}");
        }
    }

    Ok(GuiSettings::from(&config))
}

#[tauri::command]
pub(crate) fn save_network_routing_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: GuiNetworkRoutingSettings,
) -> Result<CoreConfigView, String> {
    if settings.port == 0 {
        return Err("端口必须在 1 到 65535 之间".to_string());
    }
    let proxy_url = normalize_optional_config_string(settings.proxy_url, "代理 URL")?;
    let routing_session_affinity_ttl =
        normalize_optional_config_string(settings.routing_session_affinity_ttl, "会话粘性 TTL")?;

    let _refresh_guard = cache
        .refresh_lock
        .lock()
        .map_err(|_| "智能体配置状态刷新锁已损坏".to_string())?;
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.port = settings.port;
    next.allow_lan = settings.allow_lan;
    next.host = if settings.allow_lan {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    }
    .to_string();
    next.proxy_url = proxy_url.clone();
    next.routing_session_affinity = settings.routing_session_affinity;
    next.routing_session_affinity_ttl = routing_session_affinity_ttl.clone();
    next.disable_cooling = settings.disable_cooling;
    next.request_retry = settings.request_retry;
    next.max_retry_credentials = settings.max_retry_credentials;
    next.max_retry_interval = settings.max_retry_interval;
    next.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
    validate_gui_config(&next)?;

    patch_core_network_routing_settings(&next)?;
    let config = match gui_config_state.update_network_routing(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_network_routing_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };

    if config.port != previous.port {
        if let Err(error) = cache.clear() {
            eprintln!("清空智能体配置状态缓存失败: {error}");
        }
    }

    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn save_network_endpoint_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: GuiNetworkEndpointSettings,
) -> Result<CoreConfigView, String> {
    if settings.port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }
    let host = normalize_optional_config_string(settings.host, "Listen IP")?;
    if host.parse::<IpAddr>().is_err() {
        return Err("Listen IP must be a valid IPv4 or IPv6 address".to_string());
    }
    let proxy_url = normalize_optional_config_string(settings.proxy_url, "Proxy URL")?;
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.host = host;
    next.allow_lan = !is_loopback_host(&next.host);
    next.port = settings.port;
    next.proxy_url = proxy_url;
    validate_gui_config(&next)?;
    patch_core_network_endpoint_settings(&next)?;
    let config = match gui_config_state.update_network_endpoint(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_network_endpoint_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    if config.host != previous.host || config.port != previous.port {
        if let Err(error) = cache.clear() {
            eprintln!("Failed to clear agent configuration status cache: {error}");
        }
    }
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn save_retry_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: GuiRetrySettings,
) -> Result<CoreConfigView, String> {
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.disable_cooling = settings.disable_cooling;
    next.request_retry = settings.request_retry;
    next.max_retry_credentials = settings.max_retry_credentials;
    next.max_retry_interval = settings.max_retry_interval;
    next.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
    patch_core_retry_settings(&next)?;
    let config = match gui_config_state.update_retry_settings(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_retry_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn save_session_routing_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: GuiSessionRoutingSettings,
) -> Result<CoreConfigView, String> {
    let ttl = normalize_optional_config_string(
        settings.routing_session_affinity_ttl,
        "Session affinity TTL",
    )?;
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.routing_session_affinity = settings.routing_session_affinity;
    next.routing_session_affinity_ttl = ttl;
    patch_core_session_routing_settings(&next)?;
    let config = match gui_config_state.update_session_routing(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_session_routing_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn get_core_config_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreConfigView, String> {
    let settings = current_core_config_settings(gui_config_state.inner())?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    let api_keys = gui_api_key_values(&config.api_keys);
    if api_keys != settings.api_keys {
        patch_core_api_keys(&api_keys)?;
    }
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn save_core_logging_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: CoreLoggingSettingsInput,
) -> Result<CoreConfigView, String> {
    if !(1..=3600).contains(&settings.redis_usage_queue_retention_seconds) {
        return Err("Redis 用量队列保留时间必须在 1 到 3600 秒之间".to_string());
    }

    let previous = current_core_config_settings(gui_config_state.inner())?;
    let mut next = previous.clone();
    next.debug = settings.debug;
    next.commercial_mode = settings.commercial_mode;
    next.logging_to_file = settings.logging_to_file;
    next.logs_max_total_size_mb = settings.logs_max_total_size_mb;
    next.error_logs_max_files = settings.error_logs_max_files;
    next.usage_statistics_enabled = settings.usage_statistics_enabled;
    next.redis_usage_queue_retention_seconds = settings.redis_usage_queue_retention_seconds;

    patch_core_logging_settings(&next)?;
    let config = match gui_config_state.sync_core_settings(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_logging_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn add_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    api_key: String,
    remark: String,
) -> Result<CoreConfigView, String> {
    let api_key = api_key.trim().to_string();
    let remark = remark.trim().to_string();
    validate_core_api_key(&api_key)?;
    validate_api_key_remark(&remark)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    if settings
        .api_keys
        .iter()
        .any(|existing| existing == &api_key)
    {
        return Err("该鉴权密钥已经存在".to_string());
    }
    settings.api_keys.push(api_key);
    patch_core_api_keys(&settings.api_keys)?;
    let added_api_key = settings.api_keys.last().map(|key| GuiApiKeyEntry {
        key: key.clone(),
        remark,
    });
    let config = gui_config_state.sync_core_settings_with_api_key(&settings, added_api_key)?;
    Ok(CoreConfigView::from(&config))
}

pub(crate) fn replace_core_api_key_value(
    api_keys: &mut [String],
    original_api_key: &str,
    replacement_api_key: String,
) -> Result<(), String> {
    let index = api_keys
        .iter()
        .position(|existing| existing == original_api_key)
        .ok_or_else(|| "要编辑的鉴权密钥不存在，请刷新后重试".to_string())?;
    if replacement_api_key != original_api_key
        && api_keys
            .iter()
            .any(|existing| existing == &replacement_api_key)
    {
        return Err("该鉴权密钥已经存在".to_string());
    }
    api_keys[index] = replacement_api_key;
    Ok(())
}

pub(crate) fn remove_core_api_key_value(
    api_keys: &mut Vec<String>,
    api_key: &str,
) -> Result<(), String> {
    let index = api_keys
        .iter()
        .position(|existing| existing == api_key)
        .ok_or_else(|| "要删除的鉴权密钥不存在，请刷新后重试".to_string())?;
    api_keys.remove(index);
    Ok(())
}

#[tauri::command]
pub(crate) fn update_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    original_api_key: String,
    api_key: String,
    remark: String,
) -> Result<CoreConfigView, String> {
    let original_api_key = original_api_key.trim();
    let api_key = api_key.trim().to_string();
    let remark = remark.trim().to_string();
    if original_api_key.is_empty() {
        return Err("要编辑的鉴权密钥不能为空".to_string());
    }
    validate_core_api_key(&api_key)?;
    validate_api_key_remark(&remark)?;

    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    replace_core_api_key_value(&mut settings.api_keys, original_api_key, api_key.clone())?;
    patch_core_api_keys(&settings.api_keys)?;
    let config = gui_config_state.sync_core_settings_with_api_key(
        &settings,
        Some(GuiApiKeyEntry {
            key: api_key,
            remark,
        }),
    )?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn delete_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    api_key: String,
) -> Result<CoreConfigView, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("要删除的鉴权密钥不能为空".to_string());
    }
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    remove_core_api_key_value(&mut settings.api_keys, api_key)?;
    patch_core_api_keys(&settings.api_keys)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn set_core_management_secret_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    secret_key: String,
) -> Result<CoreConfigView, String> {
    let secret_key = normalize_management_secret_key(secret_key)?;
    let previous = gui_config_state.snapshot()?;
    patch_core_management_secret_key(&secret_key)?;
    let config = match gui_config_state.set_management_secret_key(secret_key) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error =
                patch_core_management_secret_key(&previous.management_secret_key).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn clear_core_management_secret_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreConfigView, String> {
    let previous = gui_config_state.snapshot()?;
    patch_core_management_secret_key("")?;
    let config = match gui_config_state.set_management_secret_key(String::new()) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error =
                patch_core_management_secret_key(&previous.management_secret_key).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn set_core_plugins_enabled(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    enabled: bool,
) -> Result<CoreConfigView, String> {
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    settings.plugins_enabled = enabled;
    patch_core_plugins_enabled(settings.plugins_enabled)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn set_core_request_log(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    enabled: bool,
) -> Result<CoreConfigView, String> {
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    let previous_enabled = settings.request_log;
    settings.request_log = enabled;
    patch_core_request_log(settings.request_log)?;
    let config = match gui_config_state.sync_core_settings(&settings) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_request_log(previous_enabled).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn set_core_routing_strategy(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    strategy: String,
) -> Result<CoreConfigView, String> {
    validate_routing_strategy(&strategy)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    settings.routing_strategy = strategy;
    patch_core_routing_strategy(&settings.routing_strategy)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn set_core_proxy_url(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    proxy_url: String,
) -> Result<CoreConfigView, String> {
    let proxy_url = normalize_optional_config_string(proxy_url, "代理 URL")?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    let previous_proxy_url = settings.proxy_url.clone();
    settings.proxy_url = proxy_url;
    patch_core_proxy_url(&settings.proxy_url)?;
    let config = match gui_config_state.sync_core_settings(&settings) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_proxy_url(&previous_proxy_url).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn set_core_session_affinity(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    enabled: bool,
) -> Result<CoreConfigView, String> {
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    let previous_enabled = settings.routing_session_affinity;
    settings.routing_session_affinity = enabled;
    patch_core_session_affinity(settings.routing_session_affinity)?;
    let config = match gui_config_state.sync_core_settings(&settings) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_session_affinity(previous_enabled).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn set_core_session_affinity_ttl(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    ttl: String,
) -> Result<CoreConfigView, String> {
    let ttl = normalize_optional_config_string(ttl, "会话粘性 TTL")?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    let previous_ttl = settings.routing_session_affinity_ttl.clone();
    settings.routing_session_affinity_ttl = ttl;
    patch_core_session_affinity_ttl(&settings.routing_session_affinity_ttl)?;
    let config = match gui_config_state.sync_core_settings(&settings) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_session_affinity_ttl(&previous_ttl).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}
