use super::*;

fn alias_config_is_unchanged(current: &str, latest: &str) -> Result<bool, String> {
    let changes = management_alias_config_changes(current, latest)?;
    Ok(changes.oauth_model_aliases.is_none() && !changes.update_config_yaml)
}

fn validate_alias_api_access_preserved(current: &str, updated: &str) -> Result<(), String> {
    let parse = |content: &str| {
        serde_norway::from_str::<serde_norway::Value>(content)
            .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))
    };
    let current = parse(current)?;
    let updated = parse(updated)?;
    for section in MODEL_ALIAS_CONFIG_SECTIONS
        .iter()
        .copied()
        .chain(["vertex-api-key", "xai-api-key", "interactions-api-key"])
    {
        let without_models = |root: &serde_norway::Value| -> Result<_, String> {
            let mut value = root
                .get(section)
                .cloned()
                .unwrap_or(serde_norway::Value::Null);
            if value.is_null() {
                return Ok(serde_norway::Value::Sequence(Vec::new()));
            }
            let providers = value
                .as_sequence_mut()
                .ok_or_else(|| format!("{section} 必须是数组，已拒绝保存别名"))?;
            if MODEL_ALIAS_CONFIG_SECTIONS.contains(&section) {
                for provider in providers {
                    if let Some(provider) = provider.as_mapping_mut() {
                        provider.remove(yaml_key("models"));
                    }
                }
            }
            Ok(value)
        };
        if without_models(&current)? != without_models(&updated)? {
            return Err(format!(
                "别名更新意外改变了 API 接入配置（{section}），已拒绝写入"
            ));
        }
    }
    Ok(())
}

pub(crate) async fn put_management_alias_config_changes(
    config: &GuiConfigFile,
    current: &str,
    updated: &str,
) -> Result<(), String> {
    let changes = management_alias_config_changes(current, updated)?;
    if changes.oauth_model_aliases.is_none() && !changes.update_config_yaml {
        return Ok(());
    }
    commit_management_alias_config_changes(config, current, updated, || Ok(())).await
}

pub(crate) async fn commit_management_alias_config_changes<T>(
    config: &GuiConfigFile,
    current: &str,
    updated: &str,
    commit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    static SAVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SAVE_LOCK.lock().await;
    validate_alias_api_access_preserved(current, updated)?;
    let changes = management_alias_config_changes(current, updated)?;
    let latest = fetch_management_config_yaml(config).await?;
    if !alias_config_is_unchanged(current, &latest)? {
        return Err("配置已变化，请关闭编辑器并刷新后重试".to_string());
    }
    let result = async {
        if let Some(aliases) = changes.oauth_model_aliases.as_ref() {
            put_management_oauth_model_aliases(config, aliases).await?;
        }
        if changes.update_config_yaml {
            put_management_config_yaml(config, updated).await?;
        }
        commit()
    }
    .await;
    match result {
        Ok(value) => Ok(value),
        Err(error) => Err(match restore_management_alias_config(config, current, updated).await {
            Ok(()) => format!("保存失败，已恢复原配置，可重试：{error}"),
            Err(restore_error) => format!("保存失败：{error}；自动恢复失败，配置可能已部分写入，请关闭编辑器并刷新检查：{restore_error}"),
        }),
    }
}

async fn restore_management_alias_config(
    config: &GuiConfigFile,
    current: &str,
    updated: &str,
) -> Result<(), String> {
    let latest = fetch_management_config_yaml(config).await?;
    let from_current = management_alias_config_changes(current, &latest)?;
    let from_updated = management_alias_config_changes(updated, &latest)?;
    if (from_current.update_config_yaml && from_updated.update_config_yaml)
        || (from_current.oauth_model_aliases.is_some()
            && from_updated.oauth_model_aliases.is_some())
    {
        return Err("检测到其他配置修改，未覆盖这些修改".to_string());
    }
    let mut errors = Vec::new();
    if from_current.update_config_yaml {
        if let Err(error) = put_management_config_yaml(config, current).await {
            errors.push(error);
        }
    }
    if let Some(aliases) = management_alias_config_changes(updated, current)?.oauth_model_aliases {
        if let Err(error) = put_management_oauth_model_aliases(config, &aliases).await {
            errors.push(error);
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("；"));
    }
    if !alias_config_is_unchanged(current, &fetch_management_config_yaml(config).await?)? {
        return Err("恢复后配置与原配置不一致".to_string());
    }
    Ok(())
}
