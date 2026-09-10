//! Generate and validate the entire template before presenting any destructive confirmation.
use super::*;

#[cfg(test)]
mod tests;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemplatePreview {
    revision: String,
    files: Vec<String>,
}

struct TemplatePlan {
    client: String,
    paths: Vec<PathBuf>,
    before: Images,
    after: Images,
    mappings: Option<ClaudeDesktopModelMappings>,
    mapping_revision: String,
    model: String,
    core: Option<(String, String)>,
    preview: TemplatePreview,
}

pub(crate) fn build_codex_template_auth(home: &Path) -> Result<AgentFileUpdate, String> {
    let path = codex_configuration_directory(home).join("auth.json");
    validate_codex_oauth_login_at(&path)?;
    let current = read_agent_bytes(&path)?.ok_or(CODEX_OAUTH_LOGIN_REQUIRED_ERROR)?;
    let value = parse(&path, text(Some(&current))?)?;
    let mut target = serde_json::Map::new();
    for key in ["auth_mode", "tokens", "last_refresh"] {
        if let Some(value) = value.get(key) {
            target.insert(key.into(), value.clone());
        }
    }
    Ok(AgentFileUpdate {
        path,
        after: serde_json::to_string_pretty(&target).map_err(|_| "生成认证模板失败")?,
    })
}

pub(crate) fn build_pi_template_updates(
    home: &Path,
    port: u16,
    api_key: &str,
    model: &str,
) -> Result<Vec<AgentFileUpdate>, String> {
    if port == 0 || api_key.trim().is_empty() {
        return Err("CPA 地址或密钥无效".into());
    }
    let settings = serde_json::json!({"packages": [PI_CLIPROXYAPI_PACKAGE]}).to_string();
    Ok(vec![
        AgentFileUpdate {
            path: pi_provider_config_path(home),
            after: build_pi_provider_config(None, &managed_core_loopback_origin(port), api_key)?,
        },
        AgentFileUpdate {
            path: pi_provider_settings_path(home),
            after: build_pi_provider_settings(&settings, model)?,
        },
    ])
}

pub(crate) async fn prepare_desktop_core_update(
    config: &GuiConfigFile,
    mappings: &ClaudeDesktopModelMappings,
    models: &[AgentModelOption],
) -> Result<(String, String), String> {
    let before = fetch_management_config_yaml(config)
        .await
        .map_err(agent_core_error)?;
    let after = match ensure_claude_desktop_model_aliases_in_yaml(&before, mappings, models) {
        Ok(after) => after,
        Err(_) => {
            let definitions = fetch_oauth_model_definitions(config).await;
            ensure_claude_desktop_model_aliases_with_oauth_definitions_in_yaml(
                &before,
                mappings,
                models,
                &definitions,
            )
            .map_err(agent_core_error)?
        }
    };
    Ok((before, after))
}

// Management API/parser errors may quote configuration contents. Keep actionable transaction
// outcomes without forwarding response bodies, YAML source lines or credentials to the UI.
pub(crate) fn agent_core_error(error: String) -> String {
    if error.contains("自动恢复失败") || error.contains("回滚失败") {
        "内核别名或智能体配置写入失败且回滚失败，请检查当前配置".into()
    } else if error.contains("已恢复原配置") {
        "内核别名或智能体配置写入失败，已恢复原配置，请检查连接和模型映射后重试".into()
    } else if error.contains("配置已变化") {
        "内核配置已变化，请重新预览后重试".into()
    } else {
        "内核模型别名同步失败，请检查内核连接和模型映射".into()
    }
}

pub(crate) async fn commit_agent_with_core<T>(
    config: &GuiConfigFile,
    mappings: Option<&ClaudeDesktopModelMappings>,
    models: &[AgentModelOption],
    commit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if let Some(mappings) = mappings {
        let (before, after) = prepare_desktop_core_update(config, mappings, models).await?;
        commit_management_alias_config_changes(config, &before, &after, commit)
            .await
            .map_err(agent_core_error)
    } else {
        commit()
    }
}

async fn prepare_template_plan(
    config: &GuiConfigFile,
    home: &Path,
    client: &str,
    model: &str,
    oauth_configuration: bool,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<TemplatePlan, String> {
    let paths = config_paths(client, home)?;
    let api_key = effective_agent_api_key(config);
    let (model, mappings, before, after) = if client == PI_AGENT_ID {
        let model = resolve_pi_default_model(config, model).await?;
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "配置文件锁已损坏")?;
        let before = config_images(&paths)?;
        let updates = build_pi_template_updates(home, config.port, api_key, &model)?;
        let after = prepare_config_updates(client, &paths, &before, &updates, true)?;
        (model, None, before, after)
    } else {
        let parsed = AgentClient::parse(client)?;
        let prepared = fetch_prepared_agent_models(parsed, config).await?;
        let model = resolve_available_agent_model(&prepared.models, &validate_agent_model(model)?)?;
        let code_mappings = resolve_claude_code_model_mappings(
            parsed,
            &prepared.models,
            &model,
            claude_code_model_mappings,
        )?;
        let mappings = resolve_claude_desktop_model_mappings(
            parsed,
            &prepared.models,
            &model,
            claude_desktop_model_mappings,
        )?;
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "配置文件锁已损坏")?;
        let before = config_images(&paths)?;
        let updates = build_agent_template_updates(AgentDefaultConfiguration {
            client: parsed,
            home,
            port: config.port,
            api_key,
            model: &model,
            models: &prepared.models,
            codex_catalog: prepared.codex_catalog.as_deref(),
            oauth_configuration,
            claude_code_model_mappings: code_mappings.as_ref(),
            claude_desktop_model_mappings: mappings.as_ref(),
        })?;
        let after = prepare_config_updates(client, &paths, &before, &updates, true)?;
        (model, mappings, before, after)
    };
    let mapping_revision = mapping_revision(client, &paths)?;
    let core = if let Some(mappings) = mappings.as_ref() {
        let prepared = fetch_prepared_agent_models(AgentClient::ClaudeDesktop, config).await?;
        Some(prepare_desktop_core_update(config, mappings, &prepared.models).await?)
    } else {
        None
    };
    let core_revision = core
        .as_ref()
        .map(|(a, b)| {
            Ok::<_, String>((
                model_alias_config_revision(a)?,
                model_alias_config_revision(b)?,
            ))
        })
        .transpose()?;
    let revision = sha256_bytes(
        &serde_json::to_vec(&(
            image_revision(&before),
            image_revision(&after),
            &mapping_revision,
            &mappings,
            core_revision,
        ))
        .map_err(|_| "生成模板预览失败")?,
    );
    let preview = TemplatePreview {
        revision,
        files: paths.iter().map(|p| path_to_string(p)).collect(),
    };
    Ok(TemplatePlan {
        client: client.into(),
        paths,
        before,
        after,
        model,
        mappings,
        mapping_revision,
        core,
        preview,
    })
}

async fn execute_template_plan(
    config: &GuiConfigFile,
    plan: TemplatePlan,
    revision: &str,
) -> Result<AgentConfigActionResult, String> {
    if revision != plan.preview.revision {
        return Err("预览后配置或模板发生变化，请重新预览基础配置模板".into());
    }
    let commit = || {
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "配置文件锁已损坏")?;
        if mapping_revision(&plan.client, &plan.paths)? != plan.mapping_revision {
            return Err("模型映射已变化，请重新预览".into());
        }
        commit_config_with_mappings(
            &plan.client,
            &plan.paths,
            &plan.before,
            &plan.after,
            "template",
            Some(plan.model.clone()),
            plan.mappings.clone(),
        )
    };
    match &plan.core {
        Some((before, after)) => {
            commit_management_alias_config_changes(config, before, after, commit)
                .await
                .map_err(agent_core_error)
        }
        None => commit(),
    }
}

#[tauri::command]
pub(crate) async fn preview_agent_config_template(
    app: tauri::AppHandle,
    client: String,
    model: String,
    oauth_configuration: bool,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<TemplatePreview, String> {
    let home = app.path().home_dir().map_err(|_| "无法获取用户目录")?;
    let config = app.state::<GuiConfigState>().snapshot()?;
    Ok(prepare_template_plan(
        &config,
        &home,
        &client,
        &model,
        oauth_configuration,
        claude_code_model_mappings,
        claude_desktop_model_mappings,
    )
    .await?
    .preview)
}

#[tauri::command]
pub(crate) async fn apply_agent_config_template(
    app: tauri::AppHandle,
    client: String,
    model: String,
    oauth_configuration: bool,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
    revision: String,
) -> Result<AgentConfigActionResult, String> {
    let home = app.path().home_dir().map_err(|_| "无法获取用户目录")?;
    let config = app.state::<GuiConfigState>().snapshot()?;
    let plan = prepare_template_plan(
        &config,
        &home,
        &client,
        &model,
        oauth_configuration,
        claude_code_model_mappings,
        claude_desktop_model_mappings,
    )
    .await?;
    let result = execute_template_plan(&config, plan, &revision).await?;
    app.state::<AgentConfigStatusCache>().clear()?;
    Ok(result)
}
