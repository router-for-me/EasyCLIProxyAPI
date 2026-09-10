use super::*;

struct CoreRestore {
    before: String,
    after: String,
}

pub(crate) struct RestorePlan {
    paths: Vec<PathBuf>,
    pub(crate) preview: HistoryPreview,
    local_revision: String,
    before: Images,
    after: Images,
    version: HistoryVersion,
    core: Option<CoreRestore>,
}

fn local_restore_plan(client: &str, home: &Path, id: &str) -> Result<RestorePlan, String> {
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "配置文件锁已损坏")?;
    let paths = history_paths(client, home)?;
    let (preview, before, after) = preview(client, &paths, id)?;
    let version = read_version(client, &paths, id)?;
    Ok(RestorePlan {
        paths,
        local_revision: preview.revision.clone(),
        preview,
        before,
        after,
        version,
        core: None,
    })
}

fn desktop_restore_models(plan: &RestorePlan) -> Result<Option<Vec<AgentModelOption>>, String> {
    if plan.version.client != "claude-desktop" {
        return Ok(None);
    }
    let (path, bytes) = &plan.after[2];
    let profile = parse(path, text(bytes.as_deref())?)?;
    let names = profile
        .get("inferenceModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let routes = [
        CLAUDE_DESKTOP_OPUS_MODEL_ID,
        CLAUDE_DESKTOP_SONNET_MODEL_ID,
        CLAUDE_DESKTOP_HAIKU_MODEL_ID,
    ];
    if !names
        .iter()
        .any(|name| routes.iter().any(|route| route.eq_ignore_ascii_case(name)))
    {
        return Ok(None);
    }
    let mappings =
        plan.version.mappings.as_ref().ok_or(
            "此历史版本缺少 Claude Desktop 模型映射，无法安全恢复内核路由，请重新配置模型",
        )?;
    Ok(Some(
        routes
            .into_iter()
            .zip([&mappings.opus, &mappings.sonnet, &mappings.haiku])
            .map(|(route, source)| AgentModelOption {
                name: source.clone(),
                alias: None,
                is_alias: source != route
                    && names.iter().any(|name| name.eq_ignore_ascii_case(source)),
                context_window: None,
            })
            .collect(),
    ))
}

fn attach_core_restore(
    plan: &mut RestorePlan,
    before: String,
    after: String,
) -> Result<(), String> {
    let original =
        serde_norway::from_str::<serde_norway::Value>(&before).map_err(|e| e.to_string())?;
    let target =
        serde_norway::from_str::<serde_norway::Value>(&after).map_err(|e| e.to_string())?;
    for route in [
        CLAUDE_DESKTOP_OPUS_MODEL_ID,
        CLAUDE_DESKTOP_SONNET_MODEL_ID,
        CLAUDE_DESKTOP_HAIKU_MODEL_ID,
    ] {
        let source = |root: &serde_norway::Value| {
            root.as_mapping()
                .and_then(|root| configured_model_client_identity(root, route))
                .map(|(source, _)| source)
        };
        let old = source(&original);
        let new = source(&target);
        if old != new {
            plan.preview.differences.push(HistoryDifference {
                file: "CPA/config.yaml".into(),
                field: format!("modelMappings.{route}"),
                before: old.unwrap_or_else(|| "—".into()),
                after: new.unwrap_or_else(|| "—".into()),
            });
        }
    }
    plan.preview.revision = sha256_bytes(
        format!(
            "{}:{}:{}",
            plan.local_revision,
            model_alias_config_revision(&before)?,
            model_alias_config_revision(&after)?
        )
        .as_bytes(),
    );
    plan.core = Some(CoreRestore { before, after });
    Ok(())
}

pub(crate) async fn prepare_restore_plan(
    config: &GuiConfigFile,
    client: &str,
    home: &Path,
    id: &str,
) -> Result<RestorePlan, String> {
    let mut plan = local_restore_plan(client, home, id)?;
    if let Some(models) = desktop_restore_models(&plan)? {
        let mappings = plan.version.mappings.as_ref().ok_or("缺少历史模型映射")?;
        let before = fetch_management_config_yaml(config).await?;
        let after = match ensure_claude_desktop_model_aliases_in_yaml(&before, mappings, &models) {
            Ok(after) => after,
            Err(_) => {
                let definitions = fetch_oauth_model_definitions(config).await;
                ensure_claude_desktop_model_aliases_with_oauth_definitions_in_yaml(
                    &before,
                    mappings,
                    &models,
                    &definitions,
                )?
            }
        };
        attach_core_restore(&mut plan, before, after)?;
    }
    Ok(plan)
}

pub(crate) async fn execute_restore_plan(
    config: &GuiConfigFile,
    plan: RestorePlan,
    revision: &str,
) -> Result<AgentConfigActionResult, String> {
    if plan.preview.revision != revision {
        return Err("预览后配置发生变化，请重新选择历史版本".into());
    }
    let commit = || {
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "配置文件锁已损坏")?;
        let latest = preview(&plan.version.client, &plan.paths, &plan.version.id)?.0;
        let version = read_version(&plan.version.client, &plan.paths, &plan.version.id)?;
        if latest.revision != plan.local_revision
            || serde_json::to_vec(&version).map_err(|e| e.to_string())?
                != serde_json::to_vec(&plan.version).map_err(|e| e.to_string())?
        {
            return Err("恢复期间配置或历史发生变化，请重新选择历史版本".into());
        }
        commit_history_with_mappings(
            &plan.version.client,
            &plan.paths,
            &plan.before,
            &plan.after,
            "restore",
            plan.version.model.clone(),
            plan.version.mappings.clone(),
        )
    };
    match &plan.core {
        Some(core) => {
            commit_management_alias_config_changes(config, &core.before, &core.after, commit).await
        }
        None => commit(),
    }
}

#[tauri::command]
pub(crate) async fn preview_agent_config_history(
    app: tauri::AppHandle,
    client: String,
    id: String,
) -> Result<HistoryPreview, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let config = app.state::<GuiConfigState>().snapshot()?;
    Ok(prepare_restore_plan(&config, &client, &home, &id)
        .await?
        .preview)
}

#[tauri::command]
pub(crate) async fn restore_agent_config_history(
    app: tauri::AppHandle,
    client: String,
    id: String,
    revision: String,
) -> Result<AgentConfigActionResult, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let config = app.state::<GuiConfigState>().snapshot()?;
    let plan = prepare_restore_plan(&config, &client, &home, &id).await?;
    let result = execute_restore_plan(&config, plan, &revision).await?;
    app.state::<AgentConfigStatusCache>().clear()?;
    Ok(result)
}
