use super::*;

fn alias_config_is_unchanged(current: &str, latest: &str) -> Result<bool, String> {
    let changes = management_alias_config_changes(current, latest)?;
    Ok(changes.oauth_model_aliases.is_none() && !changes.update_config_yaml)
}

fn validate_alias_transaction_state(
    current: &str,
    updated: &str,
    latest: &str,
) -> Result<(), String> {
    let parse = |content: &str| {
        serde_norway::from_str::<serde_norway::Value>(content)
            .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?
            .as_mapping()
            .cloned()
            .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())
    };
    let mut current = parse(current)?;
    let mut updated = parse(updated)?;
    let mut latest = parse(latest)?;
    for key in ["oauth-model-alias", "payload"]
        .into_iter()
        .chain(V8_PROVIDER_FAMILIES.iter().map(|(legacy, _)| *legacy))
    {
        let current_value = current.remove(yaml_key(key));
        let updated_value = updated.remove(yaml_key(key));
        let latest_value = latest.remove(yaml_key(key));
        if latest_value != current_value && latest_value != updated_value {
            return Err(
                "Other configuration changes were detected and were not overwritten".to_string(),
            );
        }
    }
    if current != updated || latest != current {
        return Err("Other configuration changes were detected and were not overwritten".to_string());
    }
    Ok(())
}

fn validate_alias_api_access_preserved(current: &str, updated: &str) -> Result<(), String> {
    let parse = |content: &str| {
        serde_norway::from_str::<serde_norway::Value>(content)
            .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))
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
                .ok_or_else(|| format!("{section} must be an array; alias was not saved"))?;
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
                "The alias update unexpectedly changed API access configuration ({section}); write rejected"
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
        return Err("Configuration changed. Close the editor, refresh, and try again".to_string());
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
            Ok(()) => format!("Save failed. Original configuration was restored; you can retry: {error}"),
            Err(restore_error) => format!("Save failed: {error}; automatic restoration failed, and the configuration may be partially written. Close the editor, refresh, and inspect it: {restore_error}"),
        }),
    }
}

async fn restore_management_alias_config(
    config: &GuiConfigFile,
    current: &str,
    updated: &str,
) -> Result<(), String> {
    let latest = fetch_management_config_yaml(config).await?;
    validate_alias_transaction_state(current, updated, &latest)?;
    let from_current = management_alias_config_changes(current, &latest)?;
    let mut errors = Vec::new();
    if from_current.update_config_yaml {
        if let Err(error) = put_management_config_yaml(config, current).await {
            errors.push(error);
        }
    }
    if let Some(aliases) = management_alias_config_changes(&latest, current)?.oauth_model_aliases {
        if let Err(error) = put_management_oauth_model_aliases(config, &aliases).await {
            errors.push(error);
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("；"));
    }
    if !alias_config_is_unchanged(current, &fetch_management_config_yaml(config).await?)? {
        return Err("Restored configuration does not match the original configuration".to_string());
    }
    Ok(())
}
