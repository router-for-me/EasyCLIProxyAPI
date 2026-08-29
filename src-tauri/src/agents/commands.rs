use super::*;

const AGENT_STATUS_DETECTION_CONCURRENCY: usize = 4;

#[derive(Clone, Copy)]
enum AgentStatusDetectionTarget {
    Client(AgentClient),
    PiProvider,
}

pub(crate) fn inspect_agent_config_statuses(
    app: &tauri::AppHandle,
    config: &GuiConfigFile,
) -> Result<Vec<AgentConfigStatus>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let api_key = effective_agent_api_key(config);
    let targets = [
        AgentStatusDetectionTarget::Client(AgentClient::ClaudeCode),
        AgentStatusDetectionTarget::Client(AgentClient::ClaudeDesktop),
        AgentStatusDetectionTarget::Client(AgentClient::Codex),
        AgentStatusDetectionTarget::Client(AgentClient::OpenCode),
        AgentStatusDetectionTarget::Client(AgentClient::OpenClaw),
        AgentStatusDetectionTarget::Client(AgentClient::Hermes),
        AgentStatusDetectionTarget::Client(AgentClient::DeepSeekHarness),
        AgentStatusDetectionTarget::Client(AgentClient::ZCode),
        AgentStatusDetectionTarget::Client(AgentClient::KimiCode),
        AgentStatusDetectionTarget::Client(AgentClient::GrokBuild),
        AgentStatusDetectionTarget::PiProvider,
    ];
    let queue = Mutex::new(targets.into_iter().enumerate());
    let results = Mutex::new(vec![None; targets.len()]);
    thread::scope(|scope| {
        let mut workers = Vec::with_capacity(AGENT_STATUS_DETECTION_CONCURRENCY);
        for _ in 0..AGENT_STATUS_DETECTION_CONCURRENCY {
            let queue = &queue;
            let results = &results;
            let home = &home;
            workers.push(scope.spawn(move || -> Result<(), String> {
                loop {
                    let next = queue
                        .lock()
                        .map_err(|_| "智能体检测任务队列锁已损坏".to_string())?
                        .next();
                    let Some((index, target)) = next else {
                        return Ok(());
                    };
                    let status = match target {
                        AgentStatusDetectionTarget::Client(client) => {
                            inspect_agent_config(client, home, config.port, api_key)
                        }
                        AgentStatusDetectionTarget::PiProvider => {
                            inspect_pi_provider_status(home, config.port, api_key)
                        }
                    };
                    results
                        .lock()
                        .map_err(|_| "智能体检测结果锁已损坏".to_string())?[index] = Some(status);
                }
            }));
        }
        for worker in workers {
            worker
                .join()
                .map_err(|_| "智能体检测工作线程异常退出".to_string())??;
        }
        Ok::<(), String>(())
    })?;
    results
        .into_inner()
        .map_err(|_| "智能体检测结果锁已损坏".to_string())?
        .into_iter()
        .map(|status| status.ok_or_else(|| "智能体检测结果不完整".to_string()))
        .collect()
}

pub(crate) fn refresh_agent_config_status_cache(
    app: &tauri::AppHandle,
    gui_config_state: &GuiConfigState,
    cache: &AgentConfigStatusCache,
) -> Result<Vec<AgentConfigStatus>, String> {
    let _refresh_guard = cache
        .refresh_lock
        .lock()
        .map_err(|_| "智能体配置状态刷新锁已损坏".to_string())?;
    let config = gui_config_state.snapshot()?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config);
    let statuses = inspect_agent_config_statuses(app, &config)?;
    cache.replace(port, api_key, statuses.clone())?;
    Ok(statuses)
}

#[tauri::command]
pub(crate) async fn get_agent_config_statuses(
    app: tauri::AppHandle,
) -> Result<Vec<AgentConfigStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let gui_config_state = app.state::<GuiConfigState>();
        let cache = app.state::<AgentConfigStatusCache>();
        {
            let _refresh_guard = cache
                .refresh_lock
                .lock()
                .map_err(|_| "智能体配置状态刷新锁已损坏".to_string())?;
            let config = gui_config_state.snapshot()?;
            let port = config.port;
            if let Some(statuses) = cache.get(port, effective_agent_api_key(&config))? {
                return Ok(statuses);
            }
        }
        refresh_agent_config_status_cache(&app, gui_config_state.inner(), cache.inner())
    })
    .await
    .map_err(|error| format!("智能体检测后台任务失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn refresh_agent_config_statuses(
    app: tauri::AppHandle,
) -> Result<Vec<AgentConfigStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let gui_config_state = app.state::<GuiConfigState>();
        let cache = app.state::<AgentConfigStatusCache>();
        refresh_agent_config_status_cache(&app, gui_config_state.inner(), cache.inner())
    })
    .await
    .map_err(|error| format!("智能体检测后台任务失败: {error}"))?
}

#[tauri::command]
pub(crate) async fn get_agent_models(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
) -> Result<Vec<AgentModelOption>, String> {
    if client.trim().eq_ignore_ascii_case(PI_AGENT_ID) {
        let config = gui_config_state.snapshot()?;
        return fetch_agent_models(config.port, effective_agent_api_key(&config)).await;
    }
    let client = AgentClient::parse(&client)?;
    let config = gui_config_state.snapshot()?;
    Ok(fetch_prepared_agent_models(client, &config).await?.models)
}

pub(crate) async fn resolve_pi_default_model(
    config: &GuiConfigFile,
    model: &str,
) -> Result<String, String> {
    let models = fetch_agent_models(config.port, effective_agent_api_key(config)).await?;
    resolve_available_agent_model(&models, &validate_agent_model(model)?)
}

#[tauri::command]
pub(crate) async fn check_pi_provider_update(
    app: tauri::AppHandle,
) -> Result<PiProviderUpdateStatus, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let installed_version = read_pi_provider_version(&home)?;
    let Some(installed_version_value) = installed_version.as_deref() else {
        return Ok(PiProviderUpdateStatus {
            installed_version: None,
            latest_version: None,
            update_available: false,
        });
    };
    let proxy_url = app.state::<GuiConfigState>().snapshot()?.proxy_url;
    let latest_version = fetch_pi_provider_latest_version(&proxy_url).await?;
    let update_available = pi_provider_update_available(installed_version_value, &latest_version)?;
    Ok(PiProviderUpdateStatus {
        installed_version,
        latest_version: Some(latest_version),
        update_available,
    })
}

#[tauri::command]
pub(crate) async fn install_pi_provider(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    model: String,
) -> Result<AgentConfigActionResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let config = gui_config_state.snapshot()?;
    let executable = find_pi_executable(&home)
        .ok_or_else(|| "未检测到 Pi CLI，请先安装 Pi 并确保 pi 命令在 PATH 中".to_string())?;
    let model = resolve_pi_default_model(&config, &model).await?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config).to_string();
    let proxy_url = config.proxy_url.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        install_pi_provider_inner(&home, &executable, port, &api_key, &model, &proxy_url)
    })
    .await
    .map_err(|error| format!("安装 Pi CLIProxyAPI provider 任务失败: {error}"))??;
    cache.clear()?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn update_pi_provider(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    model: String,
) -> Result<AgentConfigActionResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let config = gui_config_state.snapshot()?;
    let executable = find_pi_executable(&home)
        .ok_or_else(|| "未检测到 Pi CLI，请先安装 Pi 并确保 pi 命令在 PATH 中".to_string())?;
    let model = resolve_pi_default_model(&config, &model).await?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config).to_string();
    let proxy_url = config.proxy_url.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        update_pi_provider_inner(&home, &executable, port, &api_key, &model, &proxy_url)
    })
    .await
    .map_err(|error| format!("更新 Pi 插件任务失败: {error}"))??;
    cache.clear()?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn repair_pi_provider(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    model: String,
) -> Result<AgentConfigActionResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let config = gui_config_state.snapshot()?;
    let model = resolve_pi_default_model(&config, &model).await?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config).to_string();
    let result = tauri::async_runtime::spawn_blocking(move || {
        repair_pi_provider_inner(&home, port, &api_key, &model)
    })
    .await
    .map_err(|error| format!("修复 Pi 配置任务失败: {error}"))??;
    cache.clear()?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn uninstall_pi_provider(
    app: tauri::AppHandle,
    cache: tauri::State<'_, AgentConfigStatusCache>,
) -> Result<AgentConfigActionResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("鏃犳硶鑾峰彇鐢ㄦ埛鐩綍: {error}"))?;
    let executable =
        find_pi_executable(&home).ok_or_else(|| "鏈娴嬪埌 Pi CLI锛岃鍏堝畨瑁?Pi".to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        uninstall_pi_provider_inner(&home, &executable)
    })
    .await
    .map_err(|error| format!("鍗歌浇 Pi 鎻掍欢浠诲姟澶辫触: {error}"))??;
    cache.clear()?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn check_codex_oauth_login(app: tauri::AppHandle) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    validate_codex_oauth_login(&home)
}

#[tauri::command]
pub(crate) async fn update_codex_model_catalog(
    app: tauri::AppHandle,
) -> Result<CodexModelCatalogUpdateResult, String> {
    update_codex_model_catalog_inner(&app).await
}

pub(crate) async fn update_codex_model_catalog_inner(
    app: &tauri::AppHandle,
) -> Result<CodexModelCatalogUpdateResult, String> {
    let proxy_url = app.state::<GuiConfigState>().snapshot()?.proxy_url;
    let client = build_http_client_with_proxy(
        reqwest::Client::builder()
            .redirect(github_https_redirect_policy())
            .connect_timeout(Duration::from_secs(8))
            .read_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(25)),
        &proxy_url,
        "创建 Codex 模型目录更新客户端失败",
    )?;
    let response = client
        .get(CODEX_MODEL_CATALOG_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("从 GitHub 读取 Codex 模型目录失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "从 GitHub 读取 Codex 模型目录失败: HTTP {}",
            status.as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_CODEX_MODEL_CATALOG_BYTES as u64)
    {
        return Err(format!(
            "GitHub Codex 模型目录超过 {} MiB 限制",
            MAX_CODEX_MODEL_CATALOG_BYTES / 1024 / 1024
        ));
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取 GitHub Codex 模型目录失败: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_CODEX_MODEL_CATALOG_BYTES {
            return Err(format!(
                "GitHub Codex 模型目录超过 {} MiB 限制",
                MAX_CODEX_MODEL_CATALOG_BYTES / 1024 / 1024
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let catalog_json = String::from_utf8(bytes)
        .map_err(|_| "GitHub Codex 模型目录不是有效的 UTF-8 文件".to_string())?;
    codex_catalog::validate_catalog_json(&catalog_json)
        .map_err(|error| format!("GitHub Codex 模型目录校验失败: {error}"))?;

    if codex_catalog::current_catalog_json()? == catalog_json {
        return Ok(CodexModelCatalogUpdateResult {
            outcome: "unchanged".to_string(),
        });
    }

    let path = codex_model_catalog_override_path(app)?;
    write_bytes_atomically(&path, catalog_json.as_bytes())?;
    let changed = codex_catalog::activate_catalog_json(&catalog_json)?;
    Ok(CodexModelCatalogUpdateResult {
        outcome: if changed { "updated" } else { "unchanged" }.to_string(),
    })
}

pub(crate) fn codex_model_catalog_override_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录: {error}"))?;
    Ok(app_data
        .join(CODEX_MODEL_CATALOG_OVERRIDE_DIR)
        .join(CODEX_MODEL_CATALOG_SOURCE_FILE))
}

pub(crate) fn load_codex_model_catalog_override(app: &tauri::AppHandle) -> Result<(), String> {
    let path = codex_model_catalog_override_path(app)?;
    if !path.is_file() {
        return Ok(());
    }
    let catalog_json = fs::read_to_string(&path)
        .map_err(|error| format!("读取本地 Codex 模型目录更新文件失败: {error}"))?;
    codex_catalog::activate_catalog_json(&catalog_json)
        .map_err(|error| format!("本地 Codex 模型目录更新文件无效: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn get_thinking_aliases(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let content = fetch_management_config_yaml(&config).await?;
    thinking_aliases_from_yaml(&content)
}

#[tauri::command]
pub(crate) async fn get_model_alias_sources(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ThinkingAliasSource>, String> {
    let config = gui_config_state.snapshot()?;
    let content = fetch_management_config_yaml(&config).await?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    Ok(resolved_oauth_alias_sources(
        &content,
        &definitions,
        &available_models,
        AliasSourceCapability::Base,
    )?
    .into_iter()
    .map(|resolved| resolved.source)
    .collect())
}

#[tauri::command]
pub(crate) async fn get_thinking_alias_sources(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ThinkingAliasSource>, String> {
    let config = gui_config_state.snapshot()?;
    let content = fetch_management_config_yaml(&config).await?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    Ok(resolved_oauth_alias_sources(
        &content,
        &definitions,
        &available_models,
        AliasSourceCapability::Reasoning,
    )?
    .into_iter()
    .map(|resolved| resolved.source)
    .collect())
}

#[tauri::command]
pub(crate) async fn create_thinking_alias(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    source_id: String,
    alias: String,
    effort: String,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let source_id = source_id.trim().to_string();
    if source_id.is_empty() {
        return Err("请先选择原模型".to_string());
    }
    let alias = validate_thinking_alias_model_id(&alias, "别名模型")?;
    let effort = if effort.trim().is_empty() {
        String::new()
    } else {
        validate_thinking_alias_effort(&effort)?
    };
    let content = fetch_management_config_yaml(&config).await?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    let capability = if !effort.is_empty() {
        AliasSourceCapability::Reasoning
    } else {
        AliasSourceCapability::Base
    };
    let sources =
        resolved_oauth_alias_sources(&content, &definitions, &available_models, capability)?;
    let source = sources
        .iter()
        .find(|source| source.source.id == source_id)
        .cloned()
        .ok_or_else(|| {
            "原模型已不在内核当前可用模型中，或其配置来源已经变化，请刷新后重新选择".to_string()
        })?;
    if !effort.is_empty()
        && !source
            .source
            .reasoning_levels
            .iter()
            .any(|level| level.eq_ignore_ascii_case(&effort))
    {
        return Err(format!(
            "思考强度 {effort} 不在模型 {} 当前支持的等级中",
            source.source.model
        ));
    }
    if source.source.model.eq_ignore_ascii_case(&alias) {
        return Err("别名模型不能和原模型相同".to_string());
    }

    if available_models
        .iter()
        .any(|model| model.name.eq_ignore_ascii_case(&alias))
    {
        return Err(format!("{alias} 已经是实际模型 ID，不能再作为别名"));
    }
    let document = serde_norway::from_str::<serde_norway::Value>(&content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    if configured_model_alias_exists(root, &alias) {
        return Err(format!("别名模型 {alias} 已存在"));
    }

    let updated = add_model_alias_to_yaml(&content, &source, &alias, &effort)?;
    put_management_alias_config_changes(&config, &content, &updated).await?;
    thinking_aliases_from_yaml(&updated)
}

#[tauri::command]
pub(crate) async fn delete_thinking_alias(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    alias: String,
    oauth_channel: Option<String>,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let alias = validate_thinking_alias_model_id(&alias, "别名模型")?;
    let content = fetch_management_config_yaml(&config).await?;
    let updated =
        remove_thinking_alias_from_yaml_for_channel(&content, &alias, oauth_channel.as_deref())?;
    put_management_alias_config_changes(&config, &content, &updated).await?;
    thinking_aliases_from_yaml(&updated)
}

#[tauri::command]
pub(crate) async fn get_speed_aliases(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<SpeedAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let content = fetch_management_config_yaml(&config).await?;
    speed_aliases_from_yaml(&content)
}

#[tauri::command]
pub(crate) async fn get_speed_alias_sources(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ThinkingAliasSource>, String> {
    let config = gui_config_state.snapshot()?;
    let content = fetch_management_config_yaml(&config).await?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    Ok(resolved_oauth_alias_sources(
        &content,
        &definitions,
        &available_models,
        AliasSourceCapability::Fast,
    )?
    .into_iter()
    .map(|resolved| resolved.source)
    .collect())
}

#[tauri::command]
pub(crate) async fn create_speed_alias(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    source_id: String,
    alias: String,
) -> Result<Vec<SpeedAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let source_id = source_id.trim().to_string();
    if source_id.is_empty() {
        return Err("请先选择原模型".to_string());
    }
    let alias = validate_thinking_alias_model_id(&alias, "别名模型")?;
    let content = fetch_management_config_yaml(&config).await?;
    let available_models =
        fetch_agent_models(config.port, effective_agent_api_key(&config)).await?;
    let definitions = fetch_oauth_model_definitions(&config).await;
    let sources = resolved_oauth_alias_sources(
        &content,
        &definitions,
        &available_models,
        AliasSourceCapability::Fast,
    )?;
    let source = sources
        .iter()
        .find(|source| source.source.id == source_id)
        .cloned()
        .ok_or_else(|| {
            "原模型已不在内核当前可用模型中，或其配置来源已经变化，请刷新后重试".to_string()
        })?;
    if source.source.model.eq_ignore_ascii_case(&alias) {
        return Err("别名模型不能和原模型相同".to_string());
    }
    if available_models
        .iter()
        .any(|model| model.name.eq_ignore_ascii_case(&alias))
    {
        return Err(format!("{alias} 已经是实际模型 ID，不能再作为别名"));
    }
    let document = serde_norway::from_str::<serde_norway::Value>(&content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    if configured_model_alias_exists(root, &alias) {
        return Err(format!("别名模型 {alias} 已存在"));
    }

    let updated = add_speed_alias_to_yaml(&content, &source, &alias)?;
    put_management_alias_config_changes(&config, &content, &updated).await?;
    speed_aliases_from_yaml(&updated)
}

#[tauri::command]
pub(crate) async fn delete_speed_alias(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    alias: String,
    oauth_channel: Option<String>,
) -> Result<Vec<SpeedAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let alias = validate_thinking_alias_model_id(&alias, "别名模型")?;
    let content = fetch_management_config_yaml(&config).await?;
    let updated =
        remove_speed_alias_from_yaml_for_channel(&content, &alias, oauth_channel.as_deref())?;
    put_management_alias_config_changes(&config, &content, &updated).await?;
    speed_aliases_from_yaml(&updated)
}

pub(crate) async fn fetch_agent_models(
    port: u16,
    api_key: &str,
) -> Result<Vec<AgentModelOption>, String> {
    if port == 0 {
        return Err("内核端口无效".to_string());
    }
    let tls_enabled = managed_core_tls_enabled();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(tls_enabled)
        .build()
        .map_err(|error| format!("创建模型列表客户端失败: {error}"))?;
    let base_url = managed_core_loopback_origin(port);
    let endpoints = [
        format!("{base_url}/v1/models"),
        format!("{base_url}/models"),
    ];

    for (index, endpoint) in endpoints.iter().enumerate() {
        let response = client
            .get(endpoint)
            .bearer_auth(api_key)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send()
            .await
            .map_err(|error| format!("请求本机模型列表失败: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("读取本机模型列表失败: {error}"))?;
        if status.is_success() {
            let payload = serde_json::from_str::<serde_json::Value>(&body).map_err(|error| {
                format!(
                    "解析本机模型列表失败: {error}; body={}",
                    truncate_for_error(&body)
                )
            })?;
            return parse_agent_model_options(&payload);
        }

        let can_try_legacy_path = index == 0 && matches!(status.as_u16(), 404 | 405);
        if !can_try_legacy_path {
            return Err(format_agent_models_error(status.as_u16(), &body));
        }
    }

    Err("本机内核不支持模型列表接口".to_string())
}

pub(crate) async fn fetch_codex_runtime_models(
    port: u16,
    api_key: &str,
) -> Result<Vec<codex_catalog::CodexRuntimeModel>, String> {
    if port == 0 {
        return Err("内核端口无效".to_string());
    }
    let tls_enabled = managed_core_tls_enabled();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(tls_enabled)
        .build()
        .map_err(|error| format!("创建 Codex 模型列表客户端失败: {error}"))?;
    let base_url = managed_core_loopback_origin(port);
    let endpoints = [
        format!("{base_url}/v1/models"),
        format!("{base_url}/models"),
    ];

    for (index, endpoint) in endpoints.iter().enumerate() {
        let response = client
            .get(endpoint)
            .query(&[("client_version", env!("CARGO_PKG_VERSION"))])
            .bearer_auth(api_key)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send()
            .await
            .map_err(|error| format!("请求本地 Codex 模型列表失败: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("读取本地 Codex 模型列表失败: {error}"))?;
        if status.is_success() {
            let payload = serde_json::from_str::<serde_json::Value>(&body).map_err(|error| {
                format!(
                    "解析本地 Codex 模型列表失败: {error}; body={}",
                    truncate_for_error(&body)
                )
            })?;
            return codex_catalog::parse_runtime_models(&payload);
        }

        let can_try_legacy_path = index == 0 && matches!(status.as_u16(), 404 | 405);
        if !can_try_legacy_path {
            return Err(format_agent_models_error(status.as_u16(), &body));
        }
    }

    Err("本地内核不支持 Codex 模型列表接口".to_string())
}

pub(crate) async fn fetch_prepared_agent_models(
    client: AgentClient,
    config: &GuiConfigFile,
) -> Result<PreparedAgentModels, String> {
    let api_key = effective_agent_api_key(config);
    if client == AgentClient::Codex {
        let runtime_models = fetch_codex_runtime_models(config.port, api_key).await?;
        prepare_codex_agent_models(&runtime_models)
    } else {
        let mut models = fetch_agent_models(config.port, api_key).await?;
        if agent_uses_cpa_runtime_context_windows(client) {
            let runtime_models = fetch_codex_runtime_models(config.port, api_key).await?;
            codex_catalog::merge_runtime_context_windows(&mut models, &runtime_models);
        }
        if matches!(client, AgentClient::ClaudeCode | AgentClient::ClaudeDesktop) {
            let content = fetch_management_config_yaml(config).await?;
            mark_configured_agent_model_aliases(&mut models, &content)?;
            for model in &mut models {
                model.context_window = Some(claude_catalog::context_window_for(
                    &model.name,
                    model.context_window,
                )?);
                if !model.is_alias {
                    if let Some(display_name) = claude_catalog::display_name_for(&model.name)? {
                        model.alias = Some(display_name);
                    }
                }
            }
        }
        Ok(PreparedAgentModels {
            models,
            codex_catalog: None,
        })
    }
}

pub(crate) fn agent_uses_cpa_runtime_context_windows(client: AgentClient) -> bool {
    matches!(
        client,
        AgentClient::ZCode | AgentClient::KimiCode | AgentClient::GrokBuild
    )
}

pub(crate) fn resolve_claude_desktop_model_mappings(
    client: AgentClient,
    models: &[AgentModelOption],
    selected_model: &str,
    requested: Option<ClaudeDesktopModelMappings>,
) -> Result<Option<ClaudeDesktopModelMappings>, String> {
    if client != AgentClient::ClaudeDesktop {
        return Ok(None);
    }
    let requested = requested.unwrap_or_else(|| ClaudeDesktopModelMappings::all(selected_model));
    let resolve =
        |model: &str| resolve_available_agent_model(models, &validate_agent_model(model)?);
    Ok(Some(ClaudeDesktopModelMappings {
        opus: resolve(&requested.opus)?,
        sonnet: resolve(&requested.sonnet)?,
        haiku: resolve(&requested.haiku)?,
        opus_1m: requested.opus_1m,
        sonnet_1m: requested.sonnet_1m,
        haiku_1m: requested.haiku_1m,
        max_context_tokens: requested.max_context_tokens,
        auto_compact_pct: requested.auto_compact_pct,
        disable_auto_compact: requested.disable_auto_compact,
    }))
}

pub(crate) fn resolve_claude_code_model_mappings(
    client: AgentClient,
    models: &[AgentModelOption],
    selected_model: &str,
    requested: Option<ClaudeDesktopModelMappings>,
) -> Result<Option<ClaudeDesktopModelMappings>, String> {
    if client != AgentClient::ClaudeCode {
        return Ok(None);
    }
    let requested = requested.unwrap_or_else(|| ClaudeDesktopModelMappings::all(selected_model));
    if !(100_000..=1_000_000).contains(&requested.max_context_tokens) {
        return Err("Claude Code 最大窗口必须介于 100000 和 1000000 之间".to_string());
    }
    if !(1..=100).contains(&requested.auto_compact_pct) {
        return Err("Claude Code 触发压缩百分比必须介于 1 和 100 之间".to_string());
    }
    let max_context_tokens = if requested.opus_1m || requested.sonnet_1m || requested.haiku_1m {
        CLAUDE_DESKTOP_EXTENDED_CONTEXT_WINDOW
    } else {
        requested.max_context_tokens
    };
    let resolve =
        |model: &str| resolve_available_agent_model(models, &validate_agent_model(model)?);
    Ok(Some(ClaudeDesktopModelMappings {
        opus: resolve(&requested.opus)?,
        sonnet: resolve(&requested.sonnet)?,
        haiku: resolve(&requested.haiku)?,
        opus_1m: requested.opus_1m,
        sonnet_1m: requested.sonnet_1m,
        haiku_1m: requested.haiku_1m,
        max_context_tokens,
        auto_compact_pct: requested.auto_compact_pct,
        disable_auto_compact: requested.disable_auto_compact,
    }))
}

pub(crate) fn prepare_codex_agent_models(
    runtime_models: &[codex_catalog::CodexRuntimeModel],
) -> Result<PreparedAgentModels, String> {
    match codex_catalog::prepare_catalog(runtime_models) {
        Ok(catalog) => Ok(PreparedAgentModels {
            models: catalog.models,
            codex_catalog: Some(catalog.json),
        }),
        Err(error) if error.contains("CPA 当前没有可写入 Codex 的模型") => {
            Ok(PreparedAgentModels {
                models: Vec::new(),
                codex_catalog: None,
            })
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) async fn apply_agent_config(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
    model: String,
    oauth_configuration: bool,
    remote_compaction: bool,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<AgentConfigActionResult, String> {
    let client = AgentClient::parse(&client)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let config = gui_config_state.snapshot()?;
    let api_key = effective_agent_api_key(&config);
    if client == AgentClient::Codex && oauth_configuration {
        validate_codex_oauth_login(&home)?;
    }
    validate_agent_can_enable(client, &home, config.port, api_key)?;
    let prepared = fetch_prepared_agent_models(client, &config).await?;
    let model = resolve_available_agent_model(&prepared.models, &validate_agent_model(&model)?)?;
    let claude_code_model_mappings = resolve_claude_code_model_mappings(
        client,
        &prepared.models,
        &model,
        claude_code_model_mappings,
    )?;
    let claude_desktop_model_mappings = resolve_claude_desktop_model_mappings(
        client,
        &prepared.models,
        &model,
        claude_desktop_model_mappings,
    )?;
    if let Some(mappings) = claude_desktop_model_mappings.as_ref() {
        ensure_claude_desktop_model_aliases(&config, mappings, &prepared.models).await?;
    }
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "智能体配置文件锁已损坏".to_string())?;
    apply_agent_configuration_with_oauth(
        client,
        &home,
        config.port,
        api_key,
        &model,
        AgentConfigurationOptions {
            models: &prepared.models,
            codex_catalog: prepared.codex_catalog.as_deref(),
            oauth_configuration,
            remote_compaction,
            claude_code_model_mappings: claude_code_model_mappings.as_ref(),
            claude_desktop_model_mappings: claude_desktop_model_mappings.as_ref(),
        },
    )
}

#[tauri::command]
pub(crate) fn close_agent_config_modification(
    app: tauri::AppHandle,
    client: String,
) -> Result<AgentConfigActionResult, String> {
    let client = AgentClient::parse(&client)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "智能体配置文件锁已损坏".to_string())?;
    restore_agent_session_configuration(client, &home)?;
    Ok(action_result("closed", false, None, Vec::new(), Vec::new()))
}

#[tauri::command]
pub(crate) async fn reset_agent_config_to_default(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
    model: String,
    oauth_configuration: bool,
    remote_compaction: bool,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<AgentConfigActionResult, String> {
    let client = AgentClient::parse(&client)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let config = gui_config_state.snapshot()?;
    let api_key = effective_agent_api_key(&config);
    if client == AgentClient::Codex && oauth_configuration {
        validate_codex_oauth_login(&home)?;
    }
    validate_agent_can_enable(client, &home, config.port, api_key)?;
    let prepared = fetch_prepared_agent_models(client, &config).await?;
    let model = resolve_available_agent_model(&prepared.models, &validate_agent_model(&model)?)?;
    let claude_code_model_mappings = resolve_claude_code_model_mappings(
        client,
        &prepared.models,
        &model,
        claude_code_model_mappings,
    )?;
    let claude_desktop_model_mappings = resolve_claude_desktop_model_mappings(
        client,
        &prepared.models,
        &model,
        claude_desktop_model_mappings,
    )?;
    if let Some(mappings) = claude_desktop_model_mappings.as_ref() {
        ensure_claude_desktop_model_aliases(&config, mappings, &prepared.models).await?;
    }
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "智能体配置文件锁已损坏".to_string())?;
    reset_agent_configuration_to_default_with_oauth(AgentDefaultConfiguration {
        client,
        home: &home,
        port: config.port,
        api_key,
        model: &model,
        models: &prepared.models,
        codex_catalog: prepared.codex_catalog.as_deref(),
        oauth_configuration,
        remote_compaction,
        claude_code_model_mappings: claude_code_model_mappings.as_ref(),
        claude_desktop_model_mappings: claude_desktop_model_mappings.as_ref(),
    })
}

#[tauri::command]
pub(crate) fn clear_codex_config(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "智能体配置文件锁已损坏".to_string())?;
    clear_codex_config_files(&home)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn set_agent_config_enabled(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
    model: String,
    enabled: bool,
    force_restore: bool,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<AgentConfigActionResult, String> {
    let client = AgentClient::parse(&client)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let config = gui_config_state.snapshot()?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config);

    if enabled {
        validate_agent_can_enable(client, &home, port, api_key)?;
        let prepared = fetch_prepared_agent_models(client, &config).await?;
        let model =
            resolve_available_agent_model(&prepared.models, &validate_agent_model(&model)?)?;
        let claude_code_model_mappings = resolve_claude_code_model_mappings(
            client,
            &prepared.models,
            &model,
            claude_code_model_mappings,
        )?;
        let claude_desktop_model_mappings = resolve_claude_desktop_model_mappings(
            client,
            &prepared.models,
            &model,
            claude_desktop_model_mappings,
        )?;
        if let Some(mappings) = claude_desktop_model_mappings.as_ref() {
            ensure_claude_desktop_model_aliases(&config, mappings, &prepared.models).await?;
        }
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "智能体配置文件锁已损坏".to_string())?;
        apply_agent_configuration_with_oauth(
            client,
            &home,
            port,
            api_key,
            &model,
            AgentConfigurationOptions {
                models: &prepared.models,
                codex_catalog: prepared.codex_catalog.as_deref(),
                oauth_configuration: false,
                remote_compaction: false,
                claude_code_model_mappings: claude_code_model_mappings.as_ref(),
                claude_desktop_model_mappings: claude_desktop_model_mappings.as_ref(),
            },
        )
    } else {
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "智能体配置文件锁已损坏".to_string())?;
        let _ = force_restore;
        Err("停用智能体配置接口已移除；如需整体重置，请使用“默认配置”".to_string())
    }
}

#[tauri::command]
pub(crate) async fn update_agent_config(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
    model: String,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<AgentConfigActionResult, String> {
    let client = AgentClient::parse(&client)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let config = gui_config_state.snapshot()?;
    let port = config.port;
    let api_key = effective_agent_api_key(&config);
    let prepared = fetch_prepared_agent_models(client, &config).await?;
    let model = resolve_available_agent_model(&prepared.models, &validate_agent_model(&model)?)?;
    let claude_code_model_mappings = resolve_claude_code_model_mappings(
        client,
        &prepared.models,
        &model,
        claude_code_model_mappings,
    )?;
    let claude_desktop_model_mappings = resolve_claude_desktop_model_mappings(
        client,
        &prepared.models,
        &model,
        claude_desktop_model_mappings,
    )?;
    if let Some(mappings) = claude_desktop_model_mappings.as_ref() {
        ensure_claude_desktop_model_aliases(&config, mappings, &prepared.models).await?;
    }
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "智能体配置文件锁已损坏".to_string())?;
    apply_agent_configuration_with_oauth(
        client,
        &home,
        port,
        api_key,
        &model,
        AgentConfigurationOptions {
            models: &prepared.models,
            codex_catalog: prepared.codex_catalog.as_deref(),
            oauth_configuration: false,
            remote_compaction: false,
            claude_code_model_mappings: claude_code_model_mappings.as_ref(),
            claude_desktop_model_mappings: claude_desktop_model_mappings.as_ref(),
        },
    )
}

pub(crate) fn validate_agent_can_enable(
    client: AgentClient,
    home: &Path,
    port: u16,
    api_key: &str,
) -> Result<(), String> {
    if !client.supported_platform() {
        return Err(format!(
            "{} is not supported on the current platform",
            client.name()
        ));
    }
    let detection = inspect_agent_config(client, home, port, api_key);
    if !detection.installed {
        return Err(format!("{} is not installed", client.name()));
    }
    Ok(())
}

pub(crate) fn validate_agent_model(value: &str) -> Result<String, String> {
    let model = value.trim();
    if model.is_empty() {
        return Err("请先选择模型".to_string());
    }
    if model.len() > 240 || model.chars().any(char::is_control) {
        return Err("模型名称格式无效".to_string());
    }
    Ok(model.to_string())
}

pub(crate) fn resolve_available_agent_model(
    models: &[AgentModelOption],
    model: &str,
) -> Result<String, String> {
    if models.is_empty() {
        return Err("当前内核没有可选模型，无法应用配置修改".to_string());
    }
    models
        .iter()
        .find(|available| available.name.eq_ignore_ascii_case(model))
        .map(|available| available.name.clone())
        .ok_or_else(|| format!("模型 {model} 不在当前可用模型列表中，请刷新后重新选择"))
}

pub(crate) fn parse_agent_model_options(
    payload: &serde_json::Value,
) -> Result<Vec<AgentModelOption>, String> {
    let source = payload
        .as_array()
        .or_else(|| payload.get("data").and_then(serde_json::Value::as_array))
        .or_else(|| payload.get("models").and_then(serde_json::Value::as_array))
        .ok_or_else(|| "本机模型列表响应缺少 data 或 models 数组".to_string())?;
    let mut models = Vec::new();
    for item in source {
        let name = if let Some(name) = item.as_str() {
            name.trim().to_string()
        } else {
            ["id", "name", "model", "value"]
                .into_iter()
                .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
                .unwrap_or_default()
                .trim()
                .to_string()
        };
        let display_name = ["display_name", "displayName"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case(&name))
            .map(str::to_string);
        let model_alias = item
            .get("alias")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case(&name))
            .map(str::to_string);
        let keep_original = item
            .get("fork")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let context_window = [
            "context_length",
            "contextLength",
            "ContextLength",
            "context_window",
            "contextWindow",
            "max_input_tokens",
            "maxInputTokens",
            "input_token_limit",
            "inputTokenLimit",
        ]
        .into_iter()
        .find_map(|key| item.get(key).and_then(json_positive_u64));

        if let Some(model_alias) = model_alias {
            if keep_original {
                append_agent_model_option(&mut models, &name, display_name, false, context_window);
            }
            append_agent_model_option(&mut models, &model_alias, Some(name), true, context_window);
        } else {
            append_agent_model_option(&mut models, &name, display_name, false, context_window);
        }
    }
    Ok(models)
}

pub(crate) fn append_agent_model_option(
    models: &mut Vec<AgentModelOption>,
    name: &str,
    alias: Option<String>,
    is_alias: bool,
    context_window: Option<u64>,
) {
    let name = name.trim();
    if name.is_empty()
        || models
            .iter()
            .any(|model| model.name.eq_ignore_ascii_case(name))
    {
        return;
    }
    let alias = alias
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case(name))
        .map(str::to_string);
    models.push(AgentModelOption {
        name: name.to_string(),
        alias,
        is_alias,
        context_window,
    });
}

pub(crate) fn mark_configured_agent_model_aliases(
    models: &mut [AgentModelOption],
    content: &str,
) -> Result<(), String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;

    for section in MODEL_ALIAS_CONFIG_SECTIONS {
        let Some(providers) = yaml_mapping_value(root, section) else {
            continue;
        };
        let providers = providers
            .as_sequence()
            .ok_or_else(|| format!("{section} 必须是数组"))?;
        for provider in providers {
            let Some(provider) = provider.as_mapping() else {
                continue;
            };
            let Some(configured_models) = yaml_mapping_value(provider, "models") else {
                continue;
            };
            let configured_models = configured_models
                .as_sequence()
                .ok_or_else(|| format!("{section}.models 必须是数组"))?;
            mark_agent_model_aliases_from_sequence(models, configured_models);
        }
    }

    if let Some(oauth_aliases) = yaml_mapping_value(root, "oauth-model-alias") {
        let oauth_aliases = oauth_aliases
            .as_mapping()
            .ok_or_else(|| "oauth-model-alias 必须是 YAML 映射".to_string())?;
        for entries in oauth_aliases.values() {
            let Some(entries) = entries.as_sequence() else {
                continue;
            };
            mark_agent_model_aliases_from_sequence(models, entries);
        }
    }
    Ok(())
}

pub(crate) fn mark_agent_model_aliases_from_sequence(
    models: &mut [AgentModelOption],
    configured_models: &[serde_norway::Value],
) {
    for configured in configured_models {
        let Some((source_model, client_model, _)) = configured_model_identity(configured) else {
            continue;
        };
        if source_model.eq_ignore_ascii_case(&client_model) {
            continue;
        }
        let Some(model) = models
            .iter_mut()
            .find(|model| model.name.eq_ignore_ascii_case(&client_model))
        else {
            continue;
        };
        model.is_alias = true;
        model.alias = Some(source_model);
    }
}

pub(crate) fn parse_codex_model_definitions(
    payload: &serde_json::Value,
) -> Result<Vec<CodexModelDefinition>, String> {
    let source = payload
        .as_array()
        .or_else(|| payload.get("models").and_then(serde_json::Value::as_array))
        .or_else(|| payload.get("data").and_then(serde_json::Value::as_array))
        .ok_or_else(|| "Codex 模型定义响应缺少 models 或 data 数组".to_string())?;
    let mut definitions = Vec::new();
    for item in source {
        let id = ["id", "ID", "name"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(id) = id else {
            continue;
        };
        if definitions
            .iter()
            .any(|definition: &CodexModelDefinition| definition.id.eq_ignore_ascii_case(id))
        {
            continue;
        }
        let display_name = ["display_name", "displayName", "DisplayName"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let description = item
            .get("description")
            .or_else(|| item.get("Description"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let context_window = ["context_length", "contextLength", "ContextLength"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(json_positive_u64));
        let reasoning_levels = item
            .get("thinking")
            .or_else(|| item.get("Thinking"))
            .and_then(|thinking| thinking.get("levels").or_else(|| thinking.get("Levels")))
            .and_then(serde_json::Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .map(str::to_ascii_lowercase)
                    .filter(|level| is_codex_reasoning_level(level))
                    .fold(Vec::new(), |mut result, level| {
                        if !result.contains(&level) {
                            result.push(level);
                        }
                        result
                    })
            })
            .unwrap_or_default();
        let supports_tools = item
            .get("supported_parameters")
            .or_else(|| item.get("supportedParameters"))
            .or_else(|| item.get("SupportedParameters"))
            .and_then(serde_json::Value::as_array)
            .map(|parameters| {
                parameters.iter().any(|parameter| {
                    parameter
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case("tools"))
                })
            });
        definitions.push(CodexModelDefinition {
            id: id.to_string(),
            display_name,
            description,
            context_window,
            reasoning_levels,
            supports_tools,
        });
    }
    Ok(definitions)
}

pub(crate) fn json_positive_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

pub(crate) fn is_codex_reasoning_level(value: &str) -> bool {
    matches!(
        value,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
}

pub(crate) fn format_agent_models_error(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        let message = value
            .get("error")
            .and_then(|error| {
                error
                    .as_str()
                    .or_else(|| error.get("message").and_then(serde_json::Value::as_str))
            })
            .or_else(|| value.get("message").and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|message| !message.is_empty());
        if let Some(message) = message {
            return format!("获取本机模型列表失败 ({status}): {message}");
        }
    }
    let body = body.trim();
    if body.is_empty() {
        format!("获取本机模型列表失败 ({status})")
    } else {
        format!(
            "获取本机模型列表失败 ({status}): {}",
            truncate_for_error(body)
        )
    }
}
