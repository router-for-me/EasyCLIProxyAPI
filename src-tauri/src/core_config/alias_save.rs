use super::*;

fn alias_config_is_unchanged(current: &str, latest: &str) -> Result<bool, String> {
    let changes = management_alias_config_changes(current, latest)?;
    Ok(changes.oauth_model_aliases.is_none() && !changes.update_config_yaml)
}

pub(crate) async fn put_management_alias_config_changes(
    config: &GuiConfigFile,
    current: &str,
    updated: &str,
) -> Result<(), String> {
    static SAVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SAVE_LOCK.lock().await;
    let changes = management_alias_config_changes(current, updated)?;
    if changes.oauth_model_aliases.is_none() && !changes.update_config_yaml {
        return Ok(());
    }
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
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = result {
        return Err(match restore_management_alias_config(config, current, updated).await {
            Ok(()) => format!("保存失败，已恢复原配置，可重试：{error}"),
            Err(restore_error) => format!("保存失败：{error}；自动恢复失败，配置可能已部分写入，请关闭编辑器并刷新检查：{restore_error}"),
        });
    }
    Ok(())
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
