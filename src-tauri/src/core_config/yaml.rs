use super::*;

pub(crate) fn merge_core_config_for_start(
    install_dir: &Path,
    gui_config: &GuiConfigFile,
) -> Result<PathBuf, String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = install_dir.join(CORE_CONFIG_FILE);
    let example_config_path = install_dir.join(CORE_EXAMPLE_CONFIG_FILE);
    if !example_config_path.is_file() {
        return Err(format!(
            "Kernel configuration template not found: {}",
            path_to_string(&example_config_path)
        ));
    }

    let template = fs::read_to_string(&example_config_path).map_err(|err| {
        format!(
            "Failed to read kernel configuration template {}: {err}",
            path_to_string(&example_config_path)
        )
    })?;
    let current = if config_path.is_file() {
        Some(fs::read_to_string(&config_path).map_err(|err| {
            format!(
                "Failed to read existing kernel configuration {}: {err}",
                path_to_string(&config_path)
            )
        })?)
    } else {
        None
    };
    let merged = merge_core_config_yaml(&template, current.as_deref(), gui_config)?;
    write_core_config_if_changed(&config_path, &merged)?;

    Ok(config_path)
}

pub(crate) fn patch_core_network_settings(config: &GuiConfigFile) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let install_dir = core_install_dir()?;
    let config_path = install_dir.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("Failed to read kernel configuration {}: {err}", path_to_string(&config_path)))?;
    let Some(updated) = patch_core_network_yaml(&content, config)? else {
        return Ok(());
    };
    write_core_config_if_changed(&config_path, &updated).map(|_| ())
}

pub(crate) fn patch_core_network_routing_settings(config: &GuiConfigFile) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("Failed to read kernel configuration {}: {err}", path_to_string(&config_path)))?;
    let Some(updated) = patch_core_network_routing_yaml(&content, config)? else {
        return Ok(());
    };
    write_core_config_if_changed(&config_path, &updated).map(|_| ())
}

fn patch_installed_core_config_with(
    patch: impl FnOnce(&str) -> Result<Option<String>, String>,
) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&config_path).map_err(|err| {
        format!(
            "Failed to read core configuration {}: {err}",
            path_to_string(&config_path)
        )
    })?;
    let Some(updated) = patch(&content)? else {
        return Ok(());
    };
    write_core_config_if_changed(&config_path, &updated).map(|_| ())
}

pub(crate) fn patch_core_network_endpoint_settings(config: &GuiConfigFile) -> Result<(), String> {
    patch_installed_core_config_with(|content| patch_core_network_endpoint_yaml(content, config))
}

pub(crate) fn patch_core_retry_settings(config: &GuiConfigFile) -> Result<(), String> {
    patch_installed_core_config_with(|content| patch_core_retry_yaml(content, config))
}

pub(crate) fn patch_core_session_routing_settings(config: &GuiConfigFile) -> Result<(), String> {
    patch_installed_core_config_with(|content| patch_core_session_routing_yaml(content, config))
}

pub(crate) fn lock_core_config_file() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    CORE_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "Kernel configuration file lock is poisoned".to_string())
}

pub(crate) fn read_installed_core_config_settings() -> Result<CoreConfigSettings, String> {
    let _config_guard = lock_core_config_file()?;
    let (_, document) = read_core_config_document()?;
    core_config_settings_from_value(document.get())
}

pub(crate) fn current_core_config_settings(
    gui_config_state: &GuiConfigState,
) -> Result<CoreConfigSettings, String> {
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if config_path.is_file() {
        read_installed_core_config_settings()
    } else {
        let config = gui_config_state.snapshot()?;
        Ok(CoreConfigSettings::from(&config))
    }
}

pub(crate) fn current_core_tls_settings() -> Result<CoreTlsSettings, String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(CoreTlsSettings {
            enabled: false,
            cert: String::new(),
            key: String::new(),
        });
    }
    let content = fs::read_to_string(&config_path).map_err(|err| {
        format!(
            "Failed to read core configuration {}: {err}",
            path_to_string(&config_path)
        )
    })?;
    let document = serde_norway::from_str::<serde_norway::Value>(&content)
        .map_err(|err| format!("Failed to parse core configuration: {err}"))?;
    core_tls_settings_from_value(&document)
}

pub(crate) fn core_tls_settings_from_value(
    document: &serde_norway::Value,
) -> Result<CoreTlsSettings, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Core configuration must be a YAML mapping".to_string())?;
    let field = |key: &str| nested_yaml_value(root, &["server", "tls", key])
        .or_else(|| nested_yaml_value(root, &["tls", key]));
    let enabled = field("enable")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "tls.enable must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let string_value = |key: &str| -> Result<String, String> {
        field(key)
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("tls.{key} must be a string"))
            })
            .transpose()
            .map(Option::unwrap_or_default)
    };
    Ok(CoreTlsSettings {
        enabled,
        cert: string_value("cert")?,
        key: string_value("key")?,
    })
}

pub(crate) fn patch_core_tls_settings_yaml(
    content: &str,
    settings: &CoreTlsSettings,
) -> Result<Option<String>, String> {
    patch_core_yaml_document(content, |document| {
        let root = document.as_mapping()
            .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
        let v8 = core_config_uses_v8(document)
            || nested_yaml_value(root, &["server", "tls"]).is_some();
        let has_legacy_mapping = yaml_mapping_value(root, "tls")
            .is_some_and(serde_norway::Value::is_mapping);
        let mut changed = false;
        for (key, value) in [
            ("enable", serde_norway::Value::Bool(settings.enabled)),
            ("cert", serde_norway::Value::String(settings.cert.clone())),
            ("key", serde_norway::Value::String(settings.key.clone())),
        ] {
            let legacy_path = ["tls", key];
            let v8_path = ["server", "tls", key];
            changed |= set_core_yaml_path_value(
                document,
                if v8 { &v8_path } else { &legacy_path },
                value.clone(),
            )?;
            if v8 && has_legacy_mapping {
                changed |= set_core_yaml_path_value(document, &["tls", key], value)?;
            }
        }
        Ok(changed)
    })
}

pub(crate) fn patch_core_tls_settings(settings: &CoreTlsSettings) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Err("Core configuration has not been generated yet".to_string());
    }
    let content = fs::read_to_string(&config_path).map_err(|err| {
        format!(
            "Failed to read core configuration {}: {err}",
            path_to_string(&config_path)
        )
    })?;
    let Some(updated) = patch_core_tls_settings_yaml(&content, settings)? else {
        return Ok(());
    };
    write_core_config_if_changed(&config_path, &updated).map(|_| ())
}

pub(crate) fn normalize_core_sensitive_words_settings(
    settings: CoreSensitiveWordsSettings,
) -> CoreSensitiveWordsSettings {
    let normalize = |words: Vec<String>| {
        words
            .into_iter()
            .map(|word| word.trim().to_string())
            .filter(|word| !word.is_empty())
            .collect()
    };
    CoreSensitiveWordsSettings {
        antigravity_sensitive_words: normalize(settings.antigravity_sensitive_words),
        devin_sensitive_words: normalize(settings.devin_sensitive_words),
    }
}

pub(crate) fn core_sensitive_words_settings_from_value(
    document: &serde_norway::Value,
) -> Result<CoreSensitiveWordsSettings, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let read_words = |provider: &str| -> Result<Vec<String>, String> {
        let current = nested_yaml_value(root, &["oauth", "providers", provider]);
        let legacy = yaml_mapping_value(root, provider);
        for section in [current, legacy].into_iter().flatten() {
            if !section.is_null() && !section.is_mapping() {
                return Err(format!("{provider} must be a YAML mapping"));
            }
        }
        let Some(value) = nested_yaml_value(root, &["oauth", "providers", provider, "sensitive-words"])
            .or_else(|| nested_yaml_value(root, &[provider, "sensitive-words"])) else {
            return Ok(Vec::new());
        };
        if value.is_null() {
            return Ok(Vec::new());
        }
        value
            .as_sequence()
            .ok_or_else(|| format!("{provider}.sensitive-words must be a list of strings"))?
            .iter()
            .map(|entry| {
                entry
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("{provider}.sensitive-words must be a list of strings"))
            })
            .collect()
    };
    Ok(CoreSensitiveWordsSettings {
        antigravity_sensitive_words: read_words("antigravity")?,
        devin_sensitive_words: read_words("devin")?,
    })
}

pub(crate) fn read_core_sensitive_words_settings() -> Result<CoreSensitiveWordsSettings, String> {
    let _config_guard = lock_core_config_file()?;
    let (_, document) = read_core_config_document()?;
    core_sensitive_words_settings_from_value(document.get())
}

pub(crate) fn patch_core_sensitive_words_yaml(
    content: &str,
    settings: &CoreSensitiveWordsSettings,
) -> Result<Option<String>, String> {
    let original = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse kernel configuration: {error}"))?;
    let root = original
        .as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let mut prepared = content.to_string();
    for (provider, words) in [
        ("antigravity", &settings.antigravity_sensitive_words),
        ("devin", &settings.devin_sensitive_words),
    ] {
        if words.is_empty() {
            continue;
        }
        let Some(section) = yaml_mapping_value(root, provider) else {
            continue;
        };
        let needs_normalization = section.is_null()
            || section
                .as_mapping()
                .and_then(|mapping| yaml_mapping_value(mapping, "sensitive-words"))
                .is_some_and(serde_norway::Value::is_null);
        if !needs_normalization {
            continue;
        }
        let mut section = if section.is_null() {
            serde_norway::Mapping::new()
        } else {
            section
                .as_mapping()
                .ok_or_else(|| format!("{provider} must be a YAML mapping"))?
                .clone()
        };
        section.insert(
            yaml_key("sensitive-words"),
            serde_norway::to_value(words).map_err(|error| format!("Failed to serialize sensitive words: {error}"))?,
        );
        let mut replacement = serde_norway::Mapping::new();
        replacement.insert(yaml_key(provider), serde_norway::Value::Mapping(section));
        let block = serde_norway::to_string(&replacement)
            .map_err(|error| format!("Failed to serialize kernel configuration section: {error}"))?;
        prepared = replace_top_level_yaml_block(&prepared, provider, &block);
    }
    let updated = patch_core_yaml_document(&prepared, |document| {
        let mut changed = false;
        for (provider, words) in [
            ("antigravity", &settings.antigravity_sensitive_words),
            ("devin", &settings.devin_sensitive_words),
        ] {
            let root = document
                .as_mapping()
                .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
            let current_words = nested_yaml_value(root, &["oauth", "providers", provider, "sensitive-words"])
                .or_else(|| nested_yaml_value(root, &[provider, "sensitive-words"]));
            if words.is_empty() && current_words.is_none_or(serde_norway::Value::is_null) {
                continue;
            }
            changed |= set_core_yaml_schema_value(
                document,
                &[provider, "sensitive-words"],
                &["oauth", "providers", provider, "sensitive-words"],
                serde_norway::Value::Sequence(
                    words
                        .iter()
                        .cloned()
                        .map(serde_norway::Value::String)
                        .collect(),
                ),
            )?;
        }
        Ok(changed)
    })?
    .unwrap_or(prepared);
    Ok((updated != content).then_some(updated))
}

pub(crate) fn patch_core_sensitive_words_settings(
    settings: &CoreSensitiveWordsSettings,
) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Err("Kernel configuration has not been generated. Start the CPA kernel first".to_string());
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|error| format!("Failed to read kernel configuration {}: {error}", path_to_string(&config_path)))?;
    if let Some(updated) = patch_core_sensitive_words_yaml(&content, settings)? {
        write_core_config_if_changed(&config_path, &updated)?;
    }
    Ok(())
}

pub(crate) fn patch_core_api_keys(api_keys: &[String]) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("Failed to read kernel configuration {}: {err}", path_to_string(&config_path)))?;
    let updated = patch_core_api_keys_yaml(&content, api_keys)?;
    write_core_config_if_changed(&config_path, &updated)?;
    Ok(())
}

pub(crate) fn patch_core_management_secret_key(secret_key: &str) -> Result<(), String> {
    let secret_key = secret_key.to_string();
    patch_existing_core_config(move |document| {
        let v8 = core_config_uses_v8(document);
        set_core_yaml_path_value(
            document,
            if v8 { &["management", "secret-key"] } else { &["remote-management", "secret-key"] },
            serde_norway::Value::String(secret_key),
        )
    })
}

pub(crate) fn patch_core_auth_dir_at(config_path: &Path, auth_dir: &str) -> Result<(), String> {
    patch_existing_core_config_at(config_path, |document| {
        set_core_yaml_auth_dir(document, auth_dir)
    })
}

pub(crate) fn set_core_yaml_auth_dir(
    document: &mut serde_norway::Value,
    auth_dir: &str,
) -> Result<bool, String> {
    set_core_yaml_schema_value(
        document,
        &["auth-dir"],
        &["oauth", "auth-dir"],
        serde_norway::Value::String(auth_dir.to_string()),
    )
}

pub(crate) fn patch_core_plugins_enabled(enabled: bool) -> Result<(), String> {
    patch_existing_core_config(|document| {
        set_core_yaml_nested_value(
            document,
            "plugins",
            "enabled",
            serde_norway::Value::Bool(enabled),
        )
    })
}

pub(crate) fn patch_core_request_log(enabled: bool) -> Result<(), String> {
    patch_existing_core_config(|document| {
        set_core_yaml_schema_value(
            document,
            &["request-log"],
            &["observability", "logs", "request-log"],
            serde_norway::Value::Bool(enabled),
        )
    })
}

pub(crate) fn patch_core_logging_settings(settings: &CoreConfigSettings) -> Result<(), String> {
    patch_existing_core_config(|document| apply_core_logging_settings(document, settings))
}

pub(crate) fn apply_core_logging_settings(
    document: &mut serde_norway::Value,
    settings: &CoreConfigSettings,
) -> Result<bool, String> {
    let mut changed = false;
    for (key, value) in [
        ("debug", serde_norway::Value::Bool(settings.debug)),
        (
            "commercial-mode",
            serde_norway::Value::Bool(settings.commercial_mode),
        ),
        (
            "logging-to-file",
            serde_norway::Value::Bool(settings.logging_to_file),
        ),
        (
            "logs-max-total-size-mb",
            serde_norway::to_value(settings.logs_max_total_size_mb)
                .map_err(|err| format!("Failed to serialize log size limit: {err}"))?,
        ),
        (
            "error-logs-max-files",
            serde_norway::to_value(settings.error_logs_max_files)
                .map_err(|err| format!("Failed to serialize error log retention count: {err}"))?,
        ),
        (
            "usage-statistics-enabled",
            serde_norway::Value::Bool(settings.usage_statistics_enabled),
        ),
        (
            "redis-usage-queue-retention-seconds",
            serde_norway::to_value(settings.redis_usage_queue_retention_seconds)
                .map_err(|err| format!("Failed to serialize Redis usage queue retention: {err}"))?,
        ),
    ] {
        let path: &[&str] = match key {
            "commercial-mode" => &["server", "commercial-mode"],
            "usage-statistics-enabled" | "redis-usage-queue-retention-seconds" => {
                &["observability", "usage", key]
            }
            _ => &["observability", "logs", key],
        };
        changed |= set_core_yaml_schema_value(document, &[key], path, value)?;
    }
    Ok(changed)
}

pub(crate) fn patch_core_routing_strategy(strategy: &str) -> Result<(), String> {
    let strategy = strategy.to_string();
    patch_existing_core_config(move |document| {
        set_core_yaml_nested_value(
            document,
            "routing",
            "strategy",
            serde_norway::Value::String(strategy),
        )
    })
}

pub(crate) fn patch_core_proxy_url(proxy_url: &str) -> Result<(), String> {
    let proxy_url = proxy_url.to_string();
    patch_existing_core_config(move |document| {
        let v8 = core_config_uses_v8(document);
        set_core_yaml_path_value(
            document,
            if v8 { &["requests", "proxy-url"] } else { &["proxy-url"] },
            serde_norway::Value::String(proxy_url),
        )
    })
}

pub(crate) fn patch_core_session_affinity(enabled: bool) -> Result<(), String> {
    patch_existing_core_config(move |document| {
        set_core_yaml_nested_value(
            document,
            "routing",
            "session-affinity",
            serde_norway::Value::Bool(enabled),
        )
    })
}

pub(crate) fn patch_core_session_affinity_ttl(ttl: &str) -> Result<(), String> {
    let ttl = ttl.to_string();
    patch_existing_core_config(move |document| {
        set_core_yaml_nested_value(
            document,
            "routing",
            "session-affinity-ttl",
            serde_norway::Value::String(ttl),
        )
    })
}

pub(crate) fn patch_existing_core_config<F>(update: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_norway::Value) -> Result<bool, String>,
{
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    patch_existing_core_config_at(&config_path, update)
}

fn patch_existing_core_config_at<F>(config_path: &Path, update: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_norway::Value) -> Result<bool, String>,
{
    let _config_guard = lock_core_config_file()?;
    let content = match fs::read_to_string(config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to read kernel configuration {}: {error}",
                path_to_string(config_path)
            ));
        }
    };
    let Some(updated) = patch_core_yaml_document(&content, update)? else {
        return Ok(());
    };

    write_core_config_if_changed(config_path, &updated)?;

    Ok(())
}

pub(crate) fn patch_core_yaml_document<F>(
    content: &str,
    update: F,
) -> Result<Option<String>, String>
where
    F: FnOnce(&mut serde_norway::Value) -> Result<bool, String>,
{
    let original = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|err| format!("Failed to parse kernel configuration: {err}"))?;
    let mut updated = original.clone();
    if !update(&mut updated)? {
        return Ok(None);
    }
    render_yaml_value_changes(content, &original, &updated).map(Some)
}

pub(crate) struct YamlValueChange {
    path: Vec<String>,
    value: serde_norway::Value,
}

type MissingNestedYamlGroup = (Vec<String>, Vec<(String, serde_norway::Value)>);

pub(crate) fn render_yaml_value_changes(
    content: &str,
    original: &serde_norway::Value,
    updated: &serde_norway::Value,
) -> Result<String, String> {
    if original == updated {
        return Ok(content.to_string());
    }
    let mut editable_content = normalize_nested_yaml_comment_indentation(content);
    let mut changes = Vec::new();
    collect_yaml_value_changes(original, updated, &mut Vec::new(), &mut changes)?;
    let mut remaining_changes = Vec::new();
    for change in changes {
        let sequence_length_changed = matches!(
            (yaml_value_at_path(original, &change.path), &change.value),
            (
                Some(serde_norway::Value::Sequence(original_values)),
                serde_norway::Value::Sequence(updated_values)
            ) if original_values.len() != updated_values.len()
        );
        if sequence_length_changed {
            editable_content =
                replace_yaml_sequence_value(&editable_content, &change.path, &change.value)?;
        } else {
            remaining_changes.push(change);
        }
    }
    let mut missing_nested_groups: Vec<MissingNestedYamlGroup> = Vec::new();
    let mut yaml_edit_changes = Vec::new();
    for change in remaining_changes {
        if change.path.len() < 2
            || yaml_value_at_path(original, &change.path).is_some()
            || yaml_value_at_path(original, &change.path[..change.path.len() - 1])
                .and_then(serde_norway::Value::as_mapping)
                .is_none()
        {
            yaml_edit_changes.push(change);
            continue;
        }
        let parent_path = change.path[..change.path.len() - 1].to_vec();
        let entry = (
            change.path.last().cloned().unwrap_or_default(),
            change.value,
        );
        if let Some((_, entries)) = missing_nested_groups
            .iter_mut()
            .find(|(existing, _)| existing == &parent_path)
        {
            entries.push(entry);
        } else {
            missing_nested_groups.push((parent_path, vec![entry]));
        }
    }
    for (parent_path, entries) in missing_nested_groups {
        if let Some(updated_content) =
            insert_yaml_mapping_values_at_path(&editable_content, &parent_path, &entries)?
        {
            editable_content = updated_content;
        } else {
            for (key, value) in entries {
                let mut path = parent_path.clone();
                path.push(key);
                yaml_edit_changes.push(YamlValueChange { path, value });
            }
        }
    }
    remaining_changes = yaml_edit_changes;
    let file = editable_content
        .parse::<yaml_edit::YamlFile>()
        .map_err(|err| format!("Failed to parse editable kernel configuration: {err}"))?;
    let document = file
        .document()
        .ok_or_else(|| "Kernel configuration has no YAML document".to_string())?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    for change in remaining_changes {
        set_yaml_edit_mapping_path(&root, &change.path, &change.value)?;
    }
    let rendered = file.to_string();
    let validated = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .map_err(|err| format!("Failed to validate updated kernel configuration: {err}"))?;
    if validated != *updated {
        let path = first_yaml_mismatch_path(updated, &validated, &mut Vec::new())
            .unwrap_or_else(|| "<unknown>".to_string());
        return Err(format!(
            "Updated kernel configuration does not match the expected value (path: {path}); write rejected"
        ));
    }
    Ok(rendered)
}

pub(crate) fn first_yaml_mismatch_path(
    expected: &serde_norway::Value,
    actual: &serde_norway::Value,
    path: &mut Vec<String>,
) -> Option<String> {
    if expected == actual {
        return None;
    }
    match (expected, actual) {
        (
            serde_norway::Value::Mapping(expected_mapping),
            serde_norway::Value::Mapping(actual_mapping),
        ) => {
            for (key, expected_value) in expected_mapping {
                let key_name = key
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| "<non-string-key>".to_string());
                path.push(key_name);
                let mismatch = actual_mapping
                    .get(key)
                    .and_then(|actual_value| {
                        first_yaml_mismatch_path(expected_value, actual_value, path)
                    })
                    .or_else(|| (!actual_mapping.contains_key(key)).then(|| path.join(".")));
                path.pop();
                if mismatch.is_some() {
                    return mismatch;
                }
            }
            for key in actual_mapping.keys() {
                if !expected_mapping.contains_key(key) {
                    let key = key.as_str().unwrap_or("<non-string-key>");
                    return Some(if path.is_empty() {
                        key.to_string()
                    } else {
                        format!("{}.{}", path.join("."), key)
                    });
                }
            }
            Some(path.join("."))
        }
        (
            serde_norway::Value::Sequence(expected_values),
            serde_norway::Value::Sequence(actual_values),
        ) => {
            for (index, (expected_value, actual_value)) in
                expected_values.iter().zip(actual_values).enumerate()
            {
                path.push(format!("[{index}]"));
                let mismatch = first_yaml_mismatch_path(expected_value, actual_value, path);
                path.pop();
                if mismatch.is_some() {
                    return mismatch;
                }
            }
            Some(format!("{}[length]", path.join(".")))
        }
        _ => Some(path.join(".")),
    }
}

pub(crate) fn normalize_nested_yaml_comment_indentation(content: &str) -> String {
    let lines = content.split_inclusive('\n').collect::<Vec<_>>();
    let mut normalized = String::with_capacity(content.len());
    for (index, line) in lines.iter().enumerate() {
        let body = line.trim_end_matches(['\r', '\n']);
        let ending = &line[body.len()..];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let current_indent = body.len().saturating_sub(trimmed.len());
        if !trimmed.starts_with('#') {
            normalized.push_str(line);
            continue;
        }
        let next = lines.iter().skip(index + 1).find_map(|candidate| {
            let candidate = candidate.trim_end_matches(['\r', '\n']);
            let trimmed = candidate.trim_start_matches([' ', '\t']);
            if trimmed.is_empty() || trimmed.starts_with('#') {
                None
            } else {
                Some((candidate.len().saturating_sub(trimmed.len()), trimmed))
            }
        });
        let Some((next_indent, _)) = next else {
            normalized.push_str(line);
            continue;
        };
        let belongs_to_nested_mapping = current_indent < next_indent
            && lines[..index].iter().rev().any(|candidate| {
                let candidate = candidate.trim_end_matches(['\r', '\n']);
                let trimmed = candidate.trim_start_matches([' ', '\t']);
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    return false;
                }
                let indent = candidate.len().saturating_sub(trimmed.len());
                indent < next_indent && trimmed.ends_with(':')
            });
        if belongs_to_nested_mapping {
            normalized.push_str(&" ".repeat(next_indent));
            normalized.push_str(trimmed);
            normalized.push_str(ending);
        } else {
            normalized.push_str(line);
        }
    }
    normalized
}

pub(crate) fn collect_yaml_value_changes(
    original: &serde_norway::Value,
    updated: &serde_norway::Value,
    path: &mut Vec<String>,
    changes: &mut Vec<YamlValueChange>,
) -> Result<(), String> {
    if original == updated {
        return Ok(());
    }
    match (original, updated) {
        (
            serde_norway::Value::Mapping(original_mapping),
            serde_norway::Value::Mapping(updated_mapping),
        ) => {
            for key in original_mapping.keys() {
                if !updated_mapping.contains_key(key) {
                    return Err("The current kernel configuration update does not support deleting arbitrary YAML fields".to_string());
                }
            }
            for (key, updated_value) in updated_mapping {
                let key = key
                    .as_str()
                    .ok_or_else(|| "Kernel configuration mapping keys must be strings".to_string())?;
                path.push(key.to_string());
                if let Some(original_value) = original_mapping.get(yaml_key(key)) {
                    collect_yaml_value_changes(original_value, updated_value, path, changes)?;
                } else {
                    changes.push(YamlValueChange {
                        path: path.clone(),
                        value: updated_value.clone(),
                    });
                }
                path.pop();
            }
            Ok(())
        }
        _ if path.is_empty() => Err("Kernel configuration root must remain a YAML mapping".to_string()),
        _ => {
            changes.push(YamlValueChange {
                path: path.clone(),
                value: updated.clone(),
            });
            Ok(())
        }
    }
}

pub(crate) fn yaml_value_at_path<'a>(
    root: &'a serde_norway::Value,
    path: &[String],
) -> Option<&'a serde_norway::Value> {
    path.iter().try_fold(root, |current, key| {
        current.as_mapping()?.get(yaml_key(key))
    })
}

pub(crate) fn insert_yaml_mapping_values_at_path(
    content: &str,
    parent_path: &[String],
    entries: &[(String, serde_norway::Value)],
) -> Result<Option<String>, String> {
    let file = content.parse::<yaml_edit::YamlFile>()
        .map_err(|error| format!("Failed to parse editable kernel configuration: {error}"))?;
    let document = file.document()
        .ok_or_else(|| "Kernel configuration has no YAML document".to_string())?;
    let root = document.as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let node = yaml_edit_node_at_path(&root, parent_path);
    if let Some(mapping) = node.as_ref().and_then(|node| node.as_mapping())
        .filter(|mapping| mapping.is_flow_style())
    {
        let range = mapping.byte_range();
        let start = range.start as usize;
        let opening = content[start..range.end as usize].find('{')
            .ok_or_else(|| "Flow mapping has no opening brace".to_string())?;
        let insertion_point = start + opening + 1;
        let fields = entries.iter().map(|(key, value)| {
            serde_json::to_string(value)
                .map(|value| format!("{}: {value}", render_yaml_mapping_key(key)))
                .map_err(|error| format!("Failed to serialize kernel configuration value: {error}"))
        }).collect::<Result<Vec<_>, _>>()?.join(", ");
        let separator = if mapping.is_empty() { " " } else { ", " };
        return Ok(Some(format!(
            "{} {fields}{separator}{}",
            &content[..insertion_point],
            &content[insertion_point..]
        )));
    }
    let mut offset = 0;
    let mut parent_end = None;
    let mut parent_indent = 0;
    let mut child_indent = None;
    let mut mapping_stack: Vec<(usize, String)> = Vec::new();
    for line in content.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        let trimmed = body.trim_start_matches([' ', '\t']);
        let indent = body.len().saturating_sub(trimmed.len());
        if parent_end.is_none() {
            if let Some(key) = yaml_block_mapping_key(trimmed) {
                while mapping_stack
                    .last()
                    .is_some_and(|(ancestor_indent, _)| *ancestor_indent >= indent)
                {
                    mapping_stack.pop();
                }
                mapping_stack.push((indent, key));
                if mapping_stack.len() == parent_path.len()
                    && mapping_stack
                        .iter()
                        .zip(parent_path)
                        .all(|((_, actual), expected)| actual == expected)
                {
                    parent_end = Some(offset + line.len());
                    parent_indent = indent;
                }
            }
        } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
            if indent <= parent_indent {
                break;
            }
            child_indent.get_or_insert(indent);
        }
        offset += line.len();
    }
    let Some(parent_end) = parent_end else {
        return Ok(None);
    };
    let newline = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let indent = " ".repeat(child_indent.unwrap_or(parent_indent + 2));
    let mut insertion = String::new();
    for (key, value) in entries {
        let value = serde_json::to_string(value)
            .map_err(|error| format!("Failed to serialize kernel configuration value: {error}"))?;
        insertion.push_str(&indent);
        insertion.push_str(&render_yaml_mapping_key(key));
        insertion.push_str(": ");
        insertion.push_str(&value);
        insertion.push_str(newline);
    }
    let mut updated = String::with_capacity(content.len() + insertion.len());
    updated.push_str(&content[..parent_end]);
    updated.push_str(&insertion);
    updated.push_str(&content[parent_end..]);
    Ok(Some(updated))
}

pub(crate) fn yaml_block_mapping_key(line: &str) -> Option<String> {
    let header = line
        .split_once('#')
        .map(|(value, _)| value)
        .unwrap_or(line)
        .trim_end();
    let key = header.strip_suffix(':')?.trim_end();
    if key.is_empty() {
        return None;
    }
    if key.starts_with('"') && key.ends_with('"') {
        return serde_json::from_str(key).ok();
    }
    if key.starts_with('\'') && key.ends_with('\'') {
        return Some(key[1..key.len() - 1].replace("''", "'"));
    }
    Some(key.to_string())
}

pub(crate) fn render_yaml_mapping_key(key: &str) -> String {
    if !key.is_empty()
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        key.to_string()
    } else {
        serde_json::to_string(key).unwrap_or_else(|_| key.to_string())
    }
}

pub(crate) fn replace_yaml_sequence_value(
    content: &str,
    path: &[String],
    value: &serde_norway::Value,
) -> Result<String, String> {
    let file = content
        .parse::<yaml_edit::YamlFile>()
        .map_err(|err| format!("Failed to parse editable kernel configuration: {err}"))?;
    let document = file
        .document()
        .ok_or_else(|| "Kernel configuration has no YAML document".to_string())?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let node = yaml_edit_node_at_path(&root, path)
        .ok_or_else(|| format!("Kernel configuration sequence {} not found", path.join(".")))?;
    let sequence = node
        .as_sequence()
        .ok_or_else(|| format!("Kernel configuration field {} must be a YAML sequence", path.join(".")))?;
    let range = sequence.byte_range();
    let start = range.start as usize;
    let end = range.end as usize;
    let line_start = content[..start]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let prefix = &content[line_start..start];
    let original = &content[start..end];
    let trimmed_end = original.trim_end_matches(char::is_whitespace).len();
    let trailing = &original[trimmed_end..];

    let serialized = if prefix.trim().is_empty() {
        let serialized = serde_norway::to_string(value)
            .map_err(|err| format!("Failed to serialize kernel configuration sequence: {err}"))?;
        let serialized = serialized.trim_end_matches(['\r', '\n']);
        let mut indented = String::with_capacity(serialized.len() + prefix.len() * 2);
        for (index, line) in serialized.split('\n').enumerate() {
            if index > 0 {
                indented.push('\n');
                indented.push_str(prefix);
            }
            indented.push_str(line);
        }
        indented
    } else {
        serde_json::to_string(value).map_err(|err| format!("Failed to serialize kernel configuration sequence: {err}"))?
    };

    Ok(format!(
        "{}{}{}{}",
        &content[..start],
        serialized,
        trailing,
        &content[end..]
    ))
}

pub(crate) fn yaml_edit_node_at_path(
    mapping: &yaml_edit::Mapping,
    path: &[String],
) -> Option<yaml_edit::YamlNode> {
    let (key, remaining) = path.split_first()?;
    let node = mapping.get(key.as_str())?;
    if remaining.is_empty() {
        return Some(node);
    }
    let child = node.as_mapping()?;
    yaml_edit_node_at_path(child, remaining)
}

pub(crate) fn set_yaml_edit_mapping_path(
    mapping: &yaml_edit::Mapping,
    path: &[String],
    value: &serde_norway::Value,
) -> Result<(), String> {
    let Some((key, remaining)) = path.split_first() else {
        return Err("Kernel configuration update path cannot be empty".to_string());
    };
    if remaining.is_empty() {
        return set_yaml_edit_mapping_value(mapping, key, value);
    }
    if let Some(child) = mapping.get(key.as_str()) {
        let child = child
            .as_mapping()
            .ok_or_else(|| format!("Kernel configuration section {key} must be a YAML mapping"))?;
        return set_yaml_edit_mapping_path(child, remaining, value);
    }
    let nested_value = nested_yaml_value_for_path(remaining, value.clone());
    set_yaml_edit_mapping_value(mapping, key, &nested_value)
}

pub(crate) fn set_yaml_edit_mapping_value(
    mapping: &yaml_edit::Mapping,
    key: &str,
    value: &serde_norway::Value,
) -> Result<(), String> {
    match value {
        serde_norway::Value::String(value) => {
            mapping.set(key, value.as_str());
            return Ok(());
        }
        serde_norway::Value::Bool(value) => {
            mapping.set(key, *value);
            return Ok(());
        }
        serde_norway::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                mapping.set(key, value);
                return Ok(());
            }
            if let Some(value) = value.as_u64() {
                mapping.set(key, value);
                return Ok(());
            }
            if let Some(value) = value.as_f64() {
                mapping.set(key, value);
                return Ok(());
            }
        }
        _ => {}
    }
    if let serde_norway::Value::Sequence(values) = value {
        if let Some(node) = mapping.get(key) {
            if let Some(sequence) = node.as_sequence() {
                if sequence.len() != values.len() {
                    return Err(format!("Length change in kernel configuration sequence {key} was not preprocessed"));
                }
                for (index, value) in values.iter().enumerate() {
                    let value = yaml_edit_node_from_value(value)?;
                    if !sequence.set(index, value) {
                        return Err(format!("Failed to update kernel configuration sequence {key}[{index}]"));
                    }
                }
                return Ok(());
            }
        }
    }
    match yaml_edit_node_from_value(value)? {
        yaml_edit::YamlNode::Scalar(node) => mapping.set(key, node),
        yaml_edit::YamlNode::Sequence(node) => mapping.set(key, node),
        yaml_edit::YamlNode::Mapping(node) => mapping.set(key, node),
        yaml_edit::YamlNode::Alias(node) => mapping.set(key, node),
        yaml_edit::YamlNode::TaggedNode(node) => mapping.set(key, node),
    }
    Ok(())
}

pub(crate) fn nested_yaml_value_for_path(
    path: &[String],
    value: serde_norway::Value,
) -> serde_norway::Value {
    path.iter().rev().fold(value, |nested, key| {
        let mut mapping = serde_norway::Mapping::new();
        mapping.insert(yaml_key(key), nested);
        serde_norway::Value::Mapping(mapping)
    })
}

pub(crate) fn yaml_edit_node_from_value(
    value: &serde_norway::Value,
) -> Result<yaml_edit::YamlNode, String> {
    const WRAPPER_KEY: &str = "__cpa_gui_value__";
    let value =
        serde_json::to_string(value).map_err(|err| format!("Failed to serialize kernel configuration value: {err}"))?;
    let serialized = format!("{WRAPPER_KEY}: {value}\n");
    let file = serialized
        .parse::<yaml_edit::YamlFile>()
        .map_err(|err| format!("Failed to parse kernel configuration value: {err}"))?;
    file.document()
        .and_then(|document| document.get(WRAPPER_KEY))
        .ok_or_else(|| "Unable to construct kernel configuration value".to_string())
}

pub(crate) fn set_core_yaml_nested_value(
    document: &mut serde_norway::Value,
    section: &str,
    key: &str,
    value: serde_norway::Value,
) -> Result<bool, String> {
    set_core_yaml_path_value(document, &[section, key], value)
}

pub(crate) fn core_config_uses_v8(document: &serde_norway::Value) -> bool {
    let Some(root) = document.as_mapping() else {
        return false;
    };
    if yaml_mapping_value(root, "config-version")
        .and_then(serde_norway::Value::as_u64)
        .is_some_and(|version| version >= 8)
    {
        return true;
    }
    [
        "server", "management", "access", "credentials", "requests", "oauth",
        "multimedia", "observability",
    ]
    .iter()
    .any(|section| yaml_mapping_value(root, section).is_some_and(serde_norway::Value::is_mapping))
        || ["retry", "cooldown"].iter().any(|section| {
            nested_yaml_value(root, &["routing", section])
                .is_some_and(serde_norway::Value::is_mapping)
        })
        || yaml_mapping_value(root, "api-keys").is_some_and(serde_norway::Value::is_mapping)
}

pub(crate) fn core_config_declares_v8(document: &serde_norway::Value) -> bool {
    document
        .as_mapping()
        .and_then(|root| yaml_mapping_value(root, "config-version"))
        .and_then(serde_norway::Value::as_u64)
        .is_some_and(|version| version >= 8)
}

pub(crate) fn set_core_yaml_path_value(
    document: &mut serde_norway::Value,
    path: &[&str],
    value: serde_norway::Value,
) -> Result<bool, String> {
    let Some((key, parents)) = path.split_last() else {
        return Err("Kernel configuration path cannot be empty".to_string());
    };
    let mut mapping = document
        .as_mapping_mut()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    for section in parents {
        let parent = mapping
            .entry(yaml_key(section))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()));
        if parent.is_null() {
            *parent = serde_norway::Value::Mapping(serde_norway::Mapping::new());
        }
        mapping = parent
            .as_mapping_mut()
            .ok_or_else(|| format!("Kernel configuration section {section} must be a YAML mapping"))?;
    }
    let key = yaml_key(key);
    if mapping.get(&key) == Some(&value) {
        return Ok(false);
    }
    mapping.insert(key, value);
    Ok(true)
}

pub(crate) fn migrate_legacy_core_config_to_v8(
    template: &str,
    legacy: &str,
) -> Result<String, String> {
    let template_document = serde_norway::from_str::<serde_norway::Value>(template)
        .map_err(|error| format!("Failed to parse new kernel configuration template: {error}"))?;
    if !core_config_uses_v8(&template_document) {
        return Err("New kernel configuration template is not v8".to_string());
    }
    let legacy_document = serde_norway::from_str::<serde_norway::Value>(legacy)
        .map_err(|error| format!("Failed to parse existing kernel configuration: {error}"))?;
    if core_config_declares_v8(&legacy_document) {
        return Ok(legacy.to_string());
    }
    let legacy_root = legacy_document
        .as_mapping()
        .ok_or_else(|| "Existing kernel configuration root must be a YAML mapping".to_string())?;
    let mut migrated = template_document.clone();
    // Start from the new template so newly introduced defaults remain available,
    // then overlay the complete legacy document. The explicit lifts below only
    // move fields whose spelling changed between schemas; all other user-owned
    // sections must survive the upgrade as-is.
    merge_yaml_values(&mut migrated, legacy_document.clone());
    if let Some(version) = yaml_mapping_value(
        template_document
            .as_mapping()
            .ok_or_else(|| "New kernel configuration template root must be a YAML mapping".to_string())?,
        "config-version",
    ).cloned() {
        set_core_yaml_path_value(&mut migrated, &["config-version"], version)?;
    } else {
        set_core_yaml_path_value(&mut migrated, &["config-version"], serde_norway::Value::Number(8.into()))?;
    }
    lift_legacy_core_config_fields(
        &mut migrated,
        legacy_root,
        template_document
            .as_mapping()
            .ok_or_else(|| "New kernel configuration template root must be a YAML mapping".to_string())?,
    )?;
    render_yaml_value_changes(template, &template_document, &migrated)
}

fn lift_legacy_core_config_fields(
    document: &mut serde_norway::Value,
    legacy: &serde_norway::Mapping,
    template: &serde_norway::Mapping,
) -> Result<(), String> {
    let copy = |document: &mut serde_norway::Value, legacy_path: &[&str], v8_path: &[&str]| -> Result<(), String> {
        let Some(value) = nested_yaml_value(legacy, legacy_path).cloned() else {
            return Ok(());
        };
        // A partially migrated file can contain both spellings. Prefer the
        // canonical v8 value in that case; otherwise move the legacy value.
        if nested_yaml_value(legacy, v8_path).is_none() {
            set_core_yaml_path_value(document, v8_path, value)?;
        }
        if nested_yaml_value(template, legacy_path).is_none() {
            remove_core_yaml_path_value(document, legacy_path);
        }
        Ok(())
    };
    for (legacy_path, v8_path) in [
        (&["host"][..], &["server", "host"][..]),
        (&["port"], &["server", "port"]),
        (&["commercial-mode"], &["server", "commercial-mode"]),
        (&["auth-dir"], &["oauth", "auth-dir"]),
        (&["debug"], &["observability", "logs", "debug"]),
        (&["logging-to-file"], &["observability", "logs", "logging-to-file"]),
        (&["logs-max-total-size-mb"], &["observability", "logs", "logs-max-total-size-mb"]),
        (&["error-logs-max-files"], &["observability", "logs", "error-logs-max-files"]),
        (&["request-log"], &["observability", "logs", "request-log"]),
        (&["usage-statistics-enabled"], &["observability", "usage", "usage-statistics-enabled"]),
        (&["redis-usage-queue-retention-seconds"], &["observability", "usage", "redis-usage-queue-retention-seconds"]),
        (&["proxy-url"], &["requests", "proxy-url"]),
        (&["disable-cooling"], &["routing", "cooldown", "disable-cooling"]),
        (&["request-retry"], &["routing", "retry", "request-retry"]),
        (&["max-retry-credentials"], &["routing", "retry", "max-retry-credentials"]),
        (&["max-retry-interval"], &["routing", "retry", "max-retry-interval"]),
        (&["streaming", "bootstrap-retries"], &["requests", "streaming", "bootstrap-retries"]),
        (&["remote-management", "secret-key"], &["management", "secret-key"]),
        (&["oauth-model-alias"], &["oauth", "model-alias"]),
        (&["payload"], &["requests", "payload"]),
    ] {
        copy(document, legacy_path, v8_path)?;
    }
    if let Some(tls) = yaml_mapping_value(legacy, "tls").filter(|value| value.is_mapping()).cloned() {
        if nested_yaml_value(legacy, &["server", "tls"]).is_none() {
            set_core_yaml_path_value(document, &["server", "tls"], tls)?;
        }
        if yaml_mapping_value(template, "tls").is_none() {
            remove_core_yaml_path_value(document, &["tls"]);
        }
    }
    if let Some(keys) = yaml_mapping_value(legacy, "api-keys").filter(|value| value.is_sequence()).cloned() {
        if nested_yaml_value(legacy, &["access", "api-keys"]).is_none() {
            set_core_yaml_path_value(document, &["access", "api-keys"], keys)?;
        }
        if let Some(template_upstreams) = yaml_mapping_value(template, "api-keys")
            .filter(|value| value.is_mapping())
            .cloned()
        {
            // A v8 template may already contain the upstream credential map at
            // the root. The legacy client-key sequence must not replace it.
            set_core_yaml_path_value(document, &["api-keys"], template_upstreams)?;
        } else {
            remove_core_yaml_path_value(document, &["api-keys"]);
        }
    }
    let has_canonical_upstream_mapping = yaml_mapping_value(legacy, "api-keys")
        .is_some_and(serde_norway::Value::is_mapping);
    for (legacy_name, provider) in V8_PROVIDER_FAMILIES {
        let Some(records) = yaml_mapping_value(legacy, legacy_name) else {
            continue;
        };
        if !has_canonical_upstream_mapping
            && nested_yaml_value(legacy, &["api-keys", provider]).is_none()
        {
            let grouped = group_legacy_provider_records(provider, records)?;
            set_core_yaml_path_value(document, &["api-keys", provider], grouped)?;
        }
        if yaml_mapping_value(template, legacy_name).is_none() {
            remove_core_yaml_path_value(document, &[legacy_name]);
        }
    }
    for (legacy_path, v8_path) in legacy_extended_config_paths() {
        copy(document, &legacy_path, &v8_path)?;
    }
    Ok(())
}

fn remove_core_yaml_path_value(document: &mut serde_norway::Value, path: &[&str]) -> bool {
    let Some((key, parents)) = path.split_last() else {
        return false;
    };
    let Some(mut mapping) = document.as_mapping_mut() else {
        return false;
    };
    for section in parents {
        let Some(parent) = mapping.get_mut(yaml_key(section)) else {
            return false;
        };
        let Some(parent) = parent.as_mapping_mut() else {
            return false;
        };
        mapping = parent;
    }
    mapping.remove(yaml_key(key)).is_some()
}

pub(crate) fn set_core_yaml_schema_value(
    document: &mut serde_norway::Value,
    legacy_path: &[&str],
    v8_path: &[&str],
    value: serde_norway::Value,
) -> Result<bool, String> {
    let root = document.as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let v8 = core_config_uses_v8(document) || nested_yaml_value(root, v8_path).is_some();
    let has_legacy = nested_yaml_value(root, legacy_path).is_some();
    let mut changed = set_core_yaml_path_value(
        document,
        if v8 { v8_path } else { legacy_path },
        value.clone(),
    )?;
    if v8 && has_legacy {
        changed |= set_core_yaml_path_value(document, legacy_path, value)?;
    }
    Ok(changed)
}

pub(crate) fn patch_core_api_keys_yaml(
    content: &str,
    api_keys: &[String],
) -> Result<String, String> {
    let parsed = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|err| format!("Failed to parse kernel configuration: {err}"))?;
    let root = parsed
        .as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    if core_config_uses_v8(&parsed) {
        return patch_core_yaml_document(content, |document| {
            set_core_yaml_path_value(
                document,
                &["access", "api-keys"],
                serde_norway::Value::Sequence(
                    api_keys.iter().cloned().map(serde_norway::Value::String).collect(),
                ),
            )
        })
        .map(|updated| updated.unwrap_or_else(|| content.to_string()));
    }
    let has_legacy_api_keys = nested_yaml_value(
        root,
        &["auth", "providers", "config-api-key", "api-key-entries"],
    )
    .is_some()
        || nested_yaml_value(root, &["auth", "providers", "config-api-key", "api-keys"]).is_some();
    let content = if has_legacy_api_keys {
        let file = content
            .parse::<yaml_edit::YamlFile>()
            .map_err(|err| format!("Failed to parse kernel configuration: {err}"))?;
        let document = file
            .document()
            .ok_or_else(|| "Kernel configuration has no YAML document".to_string())?;
        clear_legacy_api_key_paths(&document);
        file.to_string()
    } else {
        content.to_string()
    };
    let block = render_core_api_keys_yaml(api_keys)?;
    let updated = replace_top_level_yaml_block(&content, "api-keys", &block);
    serde_norway::from_str::<serde_norway::Value>(&updated)
        .map_err(|err| format!("Failed to validate updated kernel configuration: {err}"))?;
    Ok(updated)
}

pub(crate) fn render_core_api_keys_yaml(api_keys: &[String]) -> Result<String, String> {
    if api_keys.is_empty() {
        return Ok(String::new());
    }

    let sequence = serde_norway::Value::Sequence(
        api_keys
            .iter()
            .cloned()
            .map(serde_norway::Value::String)
            .collect(),
    );
    let serialized = serde_norway::to_string(&sequence)
        .map_err(|err| format!("Failed to generate kernel authentication key configuration: {err}"))?;
    let mut block = String::from("api-keys:\n");
    for line in serialized.lines() {
        block.push_str("  ");
        block.push_str(line);
        block.push('\n');
    }
    Ok(block)
}

pub(crate) fn replace_top_level_yaml_block(content: &str, key: &str, block: &str) -> String {
    let lines = yaml_line_ranges(content);
    let key_prefix = format!("{key}:");

    if let Some((line_index, (start, end))) =
        lines.iter().copied().enumerate().find(|(_, range)| {
            let line = yaml_line_content(content, *range);
            !line.chars().next().is_some_and(char::is_whitespace) && line.starts_with(&key_prefix)
        })
    {
        let line = yaml_line_content(content, (start, end));
        let value = line[key_prefix.len()..].trim();
        let mut replace_end = end;
        if value.is_empty() || value.starts_with('#') {
            for (next_start, next_end) in lines.iter().copied().skip(line_index + 1) {
                let next = yaml_line_content(content, (next_start, next_end));
                if next.chars().next().is_some_and(char::is_whitespace)
                    || is_indentationless_yaml_sequence_item(next)
                {
                    replace_end = next_end;
                } else {
                    break;
                }
            }
        }
        return replace_yaml_range(content, start, replace_end, block);
    }

    let insertion = lines
        .iter()
        .copied()
        .find(|range| yaml_line_content(content, *range).trim() == "# API keys for authentication")
        .map(|(_, end)| end)
        .or_else(|| {
            lines
                .iter()
                .copied()
                .find(|range| {
                    let line = yaml_line_content(content, *range);
                    !line.chars().next().is_some_and(char::is_whitespace)
                        && line.starts_with("auth-dir:")
                })
                .map(|(_, end)| end)
        })
        .unwrap_or(0);
    replace_yaml_range(content, insertion, insertion, block)
}

pub(crate) fn is_indentationless_yaml_sequence_item(line: &str) -> bool {
    let Some(rest) = line.strip_prefix('-') else {
        return false;
    };
    rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
}

pub(crate) fn yaml_line_ranges(content: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;
    for (index, character) in content.char_indices() {
        if character == '\n' {
            ranges.push((start, index + 1));
            start = index + 1;
        }
    }
    if start < content.len() {
        ranges.push((start, content.len()));
    }
    ranges
}

pub(crate) fn yaml_line_content(content: &str, (start, end): (usize, usize)) -> &str {
    content[start..end].trim_end_matches(['\r', '\n'])
}

pub(crate) fn replace_yaml_range(content: &str, start: usize, end: usize, block: &str) -> String {
    let mut result = String::with_capacity(content.len() + block.len());
    result.push_str(&content[..start]);
    if !block.is_empty() {
        result.push_str(block);
        if !block.ends_with('\n') && (end < content.len() || content.ends_with('\n')) {
            result.push('\n');
        }
    }
    result.push_str(&content[end..]);
    result
}

pub(crate) fn clear_legacy_api_key_paths(document: &yaml_edit::Document) {
    use yaml_edit::path::YamlPath;

    document.remove_path("auth.providers.config-api-key.api-key-entries");
    document.remove_path("auth.providers.config-api-key.api-keys");
}

#[cfg(test)]
pub(crate) fn set_yaml_edit_nested_value(
    document: &yaml_edit::Document,
    section: &str,
    key: &str,
    value: impl yaml_edit::AsYaml,
) -> bool {
    if let Some(node) = document.get(section) {
        if let Some(mapping) = node.as_mapping() {
            mapping.set(key, value);
            return true;
        }
    }
    false
}

pub(crate) fn read_core_config_document() -> Result<(PathBuf, yaml_serde_edit::YamlValue), String> {
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Err("Kernel configuration has not been generated. Start the CPA kernel first".to_string());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("Failed to read kernel configuration {}: {err}", path_to_string(&config_path)))?;
    let document = yaml_serde_edit::YamlValue::parse(&content)
        .map_err(|err| format!("Failed to parse kernel configuration: {err}"))?;
    Ok((config_path, document))
}

pub(crate) fn core_config_settings_from_value(
    document: &serde_norway::Value,
) -> Result<CoreConfigSettings, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let v8_or_legacy = |v8: &[&str], legacy: &[&str]| {
        nested_yaml_value(root, v8).or_else(|| nested_yaml_value(root, legacy))
    };
    let host = v8_or_legacy(&["server", "host"], &["host"])
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "host must be a string".to_string())
        })
        .transpose()?
        .unwrap_or_default();
    let port = v8_or_legacy(&["server", "port"], &["port"])
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u16::try_from(value).ok())
                .filter(|value| *value != 0)
                .ok_or_else(|| "port must be an integer between 1 and 65535".to_string())
        })
        .transpose()?
        .unwrap_or(8317);
    let auth_dir = v8_or_legacy(&["oauth", "auth-dir"], &["auth-dir"])
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "auth-dir must be a string".to_string())
        })
        .transpose()?
        .unwrap_or_else(|| "~/.cli-proxy-api".to_string());
    let debug = v8_or_legacy(&["observability", "logs", "debug"], &["debug"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "debug must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let commercial_mode = v8_or_legacy(&["server", "commercial-mode"], &["commercial-mode"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "commercial-mode must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let logging_to_file = v8_or_legacy(&["observability", "logs", "logging-to-file"], &["logging-to-file"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "logging-to-file must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let logs_max_total_size_mb = v8_or_legacy(&["observability", "logs", "logs-max-total-size-mb"], &["logs-max-total-size-mb"])
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "logs-max-total-size-mb must be a non-negative integer".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_LOGS_MAX_TOTAL_SIZE_MB);
    let error_logs_max_files = v8_or_legacy(&["observability", "logs", "error-logs-max-files"], &["error-logs-max-files"])
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "error-logs-max-files must be a non-negative integer".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_ERROR_LOGS_MAX_FILES);
    let usage_statistics_enabled = v8_or_legacy(&["observability", "usage", "usage-statistics-enabled"], &["usage-statistics-enabled"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "usage-statistics-enabled must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let redis_usage_queue_retention_seconds =
        v8_or_legacy(&["observability", "usage", "redis-usage-queue-retention-seconds"], &["redis-usage-queue-retention-seconds"])
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or_else(|| "redis-usage-queue-retention-seconds must be a non-negative integer".to_string())
            })
            .transpose()?
            .unwrap_or(DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS);
    let redis_usage_queue_retention_seconds = if redis_usage_queue_retention_seconds == 0 {
        DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS
    } else {
        redis_usage_queue_retention_seconds.min(3600)
    };
    let request_log = v8_or_legacy(&["observability", "logs", "request-log"], &["request-log"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "request-log must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let api_keys = extract_core_api_keys(root)?
        .into_iter()
        .filter(|api_key| !is_example_core_api_key(api_key))
        .collect();
    let management_secret_key = extract_core_management_secret_key(root)?;
    let plugins_enabled = nested_yaml_value(root, &["plugins", "enabled"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "plugins.enabled must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let routing_strategy = nested_yaml_value(root, &["routing", "strategy"])
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "routing.strategy must be a string".to_string())
        })
        .transpose()?
        .unwrap_or_else(|| "round-robin".to_string());
    let proxy_url = v8_or_legacy(&["requests", "proxy-url"], &["proxy-url"])
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "proxy-url must be a string".to_string())
        })
        .transpose()?
        .unwrap_or_default();
    let routing_session_affinity = nested_yaml_value(root, &["routing", "session-affinity"])
        .or_else(|| nested_yaml_value(root, &["routing", "sessionAffinity"]))
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "routing.session-affinity must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let routing_session_affinity_ttl =
        nested_yaml_value(root, &["routing", "session-affinity-ttl"])
            .or_else(|| nested_yaml_value(root, &["routing", "sessionAffinityTTL"]))
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "routing.session-affinity-ttl must be a string".to_string())
            })
            .transpose()?
            .unwrap_or_default();
    let disable_cooling = v8_or_legacy(&["routing", "cooldown", "disable-cooling"], &["disable-cooling"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "disable-cooling must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_DISABLE_COOLING);
    let request_retry = v8_or_legacy(&["routing", "retry", "request-retry"], &["request-retry"])
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "request-retry must be a non-negative integer".to_string())
        })
        .transpose()?
        .unwrap_or(0);
    let max_retry_credentials = v8_or_legacy(&["routing", "retry", "max-retry-credentials"], &["max-retry-credentials"])
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "max-retry-credentials must be a non-negative integer".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_MAX_RETRY_CREDENTIALS);
    let max_retry_interval = v8_or_legacy(&["routing", "retry", "max-retry-interval"], &["max-retry-interval"])
        .map(|value| {
            value
                .as_i64()
                .ok_or_else(|| "max-retry-interval must be an integer".to_string())
        })
        .transpose()?
        .unwrap_or(0);
    let streaming_bootstrap_retries = v8_or_legacy(&["requests", "streaming", "bootstrap-retries"], &["streaming", "bootstrap-retries"])
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "streaming.bootstrap-retries must be a non-negative integer".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_STREAMING_BOOTSTRAP_RETRIES);

    Ok(CoreConfigSettings {
        host,
        port,
        auth_dir,
        api_keys,
        management_secret_configured: management_secret_key
            .as_deref()
            .is_some_and(|value| !value.is_empty()),
        debug,
        commercial_mode,
        logging_to_file,
        logs_max_total_size_mb,
        error_logs_max_files,
        usage_statistics_enabled,
        redis_usage_queue_retention_seconds,
        request_log,
        plugins_enabled,
        routing_strategy,
        proxy_url,
        routing_session_affinity,
        routing_session_affinity_ttl,
        disable_cooling,
        request_retry,
        max_retry_credentials,
        max_retry_interval,
        streaming_bootstrap_retries,
        management_secret_key,
    })
}

pub(crate) fn extract_core_api_keys(root: &serde_norway::Mapping) -> Result<Vec<String>, String> {
    if let Some(value) = nested_yaml_value(root, &["access", "api-keys"]) {
        return extract_api_key_sequence(value, "access.api-keys");
    }
    if let Some(value) = yaml_mapping_value(root, "api-keys") {
        if value.is_mapping() {
            return Ok(Vec::new());
        }
        return extract_api_key_sequence(value, "api-keys");
    }

    let legacy = nested_yaml_value(root, &["auth", "providers", "config-api-key"])
        .and_then(serde_norway::Value::as_mapping);
    let Some(legacy) = legacy else {
        return Ok(Vec::new());
    };
    let value = yaml_mapping_value(legacy, "api-key-entries")
        .or_else(|| yaml_mapping_value(legacy, "api-keys"));
    value
        .map(|value| extract_api_key_sequence(value, "auth.providers.config-api-key"))
        .transpose()
        .map(Option::unwrap_or_default)
}

pub(crate) fn extract_api_key_sequence(
    value: &serde_norway::Value,
    field_name: &str,
) -> Result<Vec<String>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }

    let sequence = value
        .as_sequence()
        .ok_or_else(|| format!("{field_name} must be an array"))?;
    sequence
        .iter()
        .filter_map(extract_api_key_value)
        .collect::<Result<Vec<_>, _>>()
}

pub(crate) fn extract_api_key_value(value: &serde_norway::Value) -> Option<Result<String, String>> {
    if let Some(value) = value.as_str() {
        let value = value.trim();
        return (!value.is_empty()).then(|| Ok(value.to_string()));
    }

    let mapping = value.as_mapping()?;
    for key in ["api-key", "apiKey", "key", "Key"] {
        if let Some(value) = yaml_mapping_value(mapping, key).and_then(serde_norway::Value::as_str)
        {
            let value = value.trim();
            if !value.is_empty() {
                return Some(Ok(value.to_string()));
            }
        }
    }

    Some(Err(
        "Authentication key entry must be a string or a mapping containing a key field".to_string()
    ))
}

pub(crate) fn extract_core_management_secret_key(
    root: &serde_norway::Mapping,
) -> Result<Option<String>, String> {
    let Some(value) = nested_yaml_value(root, &["management", "secret-key"])
        .or_else(|| nested_yaml_value(root, &["remote-management", "secret-key"])) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| "remote-management.secret-key must be a string".to_string())?
        .trim()
        .to_string();
    Ok(Some(value))
}

#[cfg(test)]
pub(crate) fn set_core_api_keys(
    document: &mut serde_norway::Value,
    api_keys: Vec<String>,
) -> Result<(), String> {
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    root.insert(
        yaml_key("api-keys"),
        serde_norway::Value::Sequence(
            api_keys
                .into_iter()
                .map(serde_norway::Value::String)
                .collect(),
        ),
    );
    remove_legacy_api_keys(root);
    Ok(())
}

#[cfg(test)]
pub(crate) fn remove_legacy_api_keys(root: &mut serde_norway::Mapping) {
    let Some(auth) =
        yaml_mapping_value_mut(root, "auth").and_then(serde_norway::Value::as_mapping_mut)
    else {
        return;
    };
    let Some(providers) =
        yaml_mapping_value_mut(auth, "providers").and_then(serde_norway::Value::as_mapping_mut)
    else {
        return;
    };
    let Some(provider) = yaml_mapping_value_mut(providers, "config-api-key")
        .and_then(serde_norway::Value::as_mapping_mut)
    else {
        return;
    };
    provider.remove(yaml_key("api-key-entries"));
    provider.remove(yaml_key("api-keys"));
}

#[cfg(test)]
pub(crate) fn set_nested_yaml_value<T>(
    document: &mut serde_norway::Value,
    path: &[&str],
    value: T,
) -> Result<(), String>
where
    T: Into<serde_norway::Value>,
{
    if path.len() != 2 {
        return Err("Invalid kernel configuration path".to_string());
    }

    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let section = root
        .entry(yaml_key(path[0]))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()));
    let section = section
        .as_mapping_mut()
        .ok_or_else(|| format!("{} must be a YAML mapping", path[0]))?;
    section.insert(yaml_key(path[1]), value.into());
    Ok(())
}

pub(crate) fn nested_yaml_value<'a>(
    root: &'a serde_norway::Mapping,
    path: &[&str],
) -> Option<&'a serde_norway::Value> {
    let (first, rest) = path.split_first()?;
    let mut value = yaml_mapping_value(root, first)?;
    for key in rest {
        value = yaml_mapping_value(value.as_mapping()?, key)?;
    }
    Some(value)
}

pub(crate) fn yaml_mapping_value<'a>(
    mapping: &'a serde_norway::Mapping,
    key: &str,
) -> Option<&'a serde_norway::Value> {
    mapping.get(yaml_key(key))
}

pub(crate) fn yaml_mapping_value_mut<'a>(
    mapping: &'a mut serde_norway::Mapping,
    key: &str,
) -> Option<&'a mut serde_norway::Value> {
    mapping.get_mut(yaml_key(key))
}

pub(crate) fn yaml_key(key: &str) -> serde_norway::Value {
    serde_norway::Value::String(key.to_string())
}
