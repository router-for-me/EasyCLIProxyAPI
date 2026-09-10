//! Configuration transactions use only in-memory rollback images. No backup I/O.
use super::*;
use serde_json::Value;

#[cfg(test)]
mod tests;

pub(crate) type Images = Vec<(PathBuf, Option<Vec<u8>>)>;

pub(crate) fn config_paths(client: &str, home: &Path) -> Result<Vec<PathBuf>, String> {
    if client == PI_AGENT_ID {
        return Ok(vec![
            pi_provider_config_path(home),
            pi_provider_settings_path(home),
        ]);
    }
    let client = AgentClient::parse(client)?;
    if !client.supported_platform() {
        return Err("当前平台不支持此智能体配置".into());
    }
    Ok(expected_agent_record_paths(
        client,
        &agent_config_paths(client, home),
    ))
}

// Reject links (including Windows junctions) in every existing path component.
pub(crate) fn validate_config_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("配置路径必须是绝对路径且不能越界".into());
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                let linked = meta.file_type().is_symlink();
                #[cfg(windows)]
                let linked = {
                    use std::os::windows::fs::MetadataExt;
                    linked || meta.file_attributes() & 0x400 != 0
                };
                if linked {
                    return Err(format!(
                        "配置路径不能包含符号链接: {}",
                        path_to_string(ancestor)
                    ));
                }
                if ancestor == path && !meta.is_file() {
                    return Err("配置路径不是普通文件".into());
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法检查配置路径".into()),
        }
    }
    Ok(())
}

pub(crate) fn config_images(paths: &[PathBuf]) -> Result<Images, String> {
    paths
        .iter()
        .map(|path| Ok((path.clone(), read_agent_bytes(path)?)))
        .collect()
}

pub(crate) fn image_hash(bytes: Option<&[u8]>) -> String {
    bytes.map(sha256_bytes).unwrap_or_else(|| "missing".into())
}

pub(crate) fn image_revision(images: &Images) -> String {
    sha256_bytes(
        &serde_json::to_vec(
            &images
                .iter()
                .map(|(path, bytes)| (path, image_hash(bytes.as_deref())))
                .collect::<Vec<_>>(),
        )
        .expect("image hashes serialize"),
    )
}

pub(crate) fn write_config_images(client: &str, images: &Images) -> Result<(), String> {
    for (path, bytes) in images {
        if read_agent_bytes(path)? == *bytes {
            continue;
        }
        if let Some(bytes) = bytes {
            if client == PI_AGENT_ID {
                write_bytes_directly(path, bytes)?;
            } else {
                write_agent_configuration_file(AgentClient::parse(client)?, path, bytes)?;
            }
        } else {
            fs::remove_file(path).map_err(|_| "删除配置文件失败".to_string())?;
        }
        if read_agent_bytes(path)? != *bytes {
            return Err("配置写后校验失败".into());
        }
    }
    Ok(())
}

pub(crate) fn commit_config(
    client: &str,
    paths: &[PathBuf],
    before: &Images,
    after: &Images,
    _source: &str,
    model: Option<String>,
) -> Result<AgentConfigActionResult, String> {
    commit_config_with_mappings(client, paths, before, after, _source, model, None)
}

pub(crate) fn commit_config_with_mappings(
    client: &str,
    paths: &[PathBuf],
    before: &Images,
    after: &Images,
    source: &str,
    model: Option<String>,
    mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<AgentConfigActionResult, String> {
    commit_config_transaction(
        client,
        paths,
        before,
        after,
        source,
        model,
        mappings,
        &mut write_config_images,
        true,
    )
}

#[cfg(test)]
pub(crate) fn commit_config_with_writer(
    client: &str,
    paths: &[PathBuf],
    before: &Images,
    after: &Images,
    source: &str,
    model: Option<String>,
    mappings: Option<ClaudeDesktopModelMappings>,
    writer: &mut impl FnMut(&str, &Images) -> Result<(), String>,
) -> Result<AgentConfigActionResult, String> {
    commit_config_transaction(
        client, paths, before, after, source, model, mappings, writer, false,
    )
}

fn commit_config_transaction(
    client: &str,
    paths: &[PathBuf],
    before: &Images,
    after: &Images,
    source: &str,
    model: Option<String>,
    mappings: Option<ClaudeDesktopModelMappings>,
    writer: &mut impl FnMut(&str, &Images) -> Result<(), String>,
    checked: bool,
) -> Result<AgentConfigActionResult, String> {
    if before.len() != paths.len()
        || after.len() != paths.len()
        || before
            .iter()
            .zip(paths)
            .any(|((p, _), expected)| p != expected)
        || after
            .iter()
            .zip(paths)
            .any(|((p, _), expected)| p != expected)
    {
        return Err("配置更新路径不匹配".into());
    }
    if config_images(paths)? != *before {
        return Err("配置已被其他程序修改，请刷新后重试".into());
    }
    let mut previous = before.clone();
    let mut target = after.clone();
    if client == "claude-desktop" {
        let state_path = desktop_mapping_path(paths)?;
        let state_before = read_agent_bytes(&state_path)?;
        let next = if source == "restore" {
            mappings
        } else {
            mappings.or_else(|| matching_desktop_mappings(paths, after))
        };
        let state_after = desktop_mapping_bytes(after, next.as_ref())?;
        previous.push((state_path.clone(), state_before));
        target.push((state_path, state_after));
    }
    let changed = previous
        .iter()
        .zip(&target)
        .filter(|((_, a), (_, b))| a != b)
        .map(|((p, _), _)| path_to_string(p))
        .collect::<Vec<_>>();
    if changed.is_empty() {
        return Ok(action_result(
            "unchanged",
            true,
            model,
            Vec::new(),
            Vec::new(),
        ));
    }
    let all_paths = previous.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>();
    if config_images(&all_paths)? != previous {
        return Err("配置已被其他程序修改，请刷新后重试".into());
    }
    // Check each file again immediately before writing. Track only files this operation touched
    // so a conflict on a later file cannot roll back someone else's edit to that file.
    let mut attempted = Vec::new();
    let result = (if checked {
        (|| {
            for (index, ((path, old), (_, next))) in previous.iter().zip(&target).enumerate() {
                if read_agent_bytes(path)? != *old {
                    return Err("配置已被其他程序修改".into());
                }
                if old == next {
                    continue;
                }
                let written = writer(client, &vec![target[index].clone()]);
                attempted.push((index, read_agent_bytes(path)));
                written?;
            }
            Ok(())
        })()
    } else {
        writer(client, &target)
    })
    .and_then(|_| {
        if config_images(&all_paths)? == target {
            Ok(())
        } else {
            Err("配置写后校验失败".into())
        }
    });
    if result.is_err() {
        // Do not expose arbitrary writer errors: parsers and external tools may include credentials.
        let rollback = (if checked {
            let mut failed = false;
            for (index, observed) in attempted.into_iter().rev() {
                let (path, _) = &previous[index];
                // A file changed after our write: leave that external edit intact.
                if observed.is_err() || read_agent_bytes(path) != observed {
                    failed = true;
                    continue;
                }
                failed |= writer(client, &vec![previous[index].clone()]).is_err();
            }
            if failed {
                Err("回滚失败".into())
            } else {
                Ok(())
            }
        } else {
            writer(client, &previous)
        })
        .and_then(|_| {
            if config_images(&all_paths)? == previous {
                Ok(())
            } else {
                Err("回滚校验失败".into())
            }
        });
        return Err(if rollback.is_ok() {
            "配置写入失败，已回滚本次修改"
        } else {
            "配置写入失败且回滚失败，请检查配置并使用手动备份恢复或基础配置模板修复"
        }
        .into());
    }
    Ok(action_result("updated", true, model, changed, Vec::new()))
}

pub(crate) fn validate_config_images(images: &Images) -> Result<(), String> {
    for (path, bytes) in images {
        parse(path, text(bytes.as_deref())?)?;
    }
    Ok(())
}

pub(crate) fn validate_client_config_images(client: &str, images: &Images) -> Result<(), String> {
    validate_config_images(images)?;
    if matches!(client, "opencode" | "openclaw") {
        return Ok(());
    }
    for (path, bytes) in images {
        if matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("toml" | "yaml" | "yml")
        ) {
            continue;
        }
        if let Some(content) = text(bytes.as_deref())? {
            serde_json::from_str::<Value>(content.strip_prefix('\u{feff}').unwrap_or(content))
                .map_err(|_| {
                    "配置 JSON 格式错误，请使用手动备份恢复或基础配置模板修复".to_string()
                })?;
        }
    }
    Ok(())
}

pub(crate) fn prepare_config_updates(
    client: &str,
    paths: &[PathBuf],
    before: &Images,
    updates: &[AgentFileUpdate],
    template: bool,
) -> Result<Images, String> {
    if !template {
        validate_client_config_images(client, before)?;
    }
    let mut after = before.clone();
    for update in updates {
        let entry = after
            .iter_mut()
            .find(|(path, _)| path == &update.path)
            .ok_or("配置更新路径不匹配")?;
        let mut rendered = update.after.clone();
        let mut generated = parse(&update.path, Some(&rendered))?;
        if !template {
            let original = parse(&update.path, text(entry.1.as_deref())?)?;
            if client == "codex"
                && update.path.file_name().and_then(|v| v.to_str())
                    == Some(CODEX_MODEL_CATALOG_FILE)
            {
                let mut merged = original.clone();
                set(&mut merged, &["models".into()], generated.get("models"));
                if merged != generated {
                    generated = merged;
                    rendered = render(&update.path, &generated)?;
                }
            }
            let built = generated.clone();
            preserve_model_extensions(client, &update.path, &original, &mut generated);
            if generated != built {
                rendered = render(&update.path, &generated)?;
            }
            validate_unmanaged_preserved(client, paths, &update.path, &original, &generated)?;
            if entry.1.is_some() && original == generated {
                continue;
            }
        }
        entry.1 = Some(rendered.into_bytes());
    }
    if template
        && (updates.len() != paths.len()
            || paths
                .iter()
                .any(|p| updates.iter().filter(|u| &u.path == p).count() != 1))
    {
        return Err("基础配置模板必须覆盖整组文件".into());
    }
    validate_client_config_images(client, &after)?;
    Ok(after)
}

// Model inventories are refreshed from CPA, but matching model entries may have client-specific
// nested options. Keep those options while allowing unavailable managed models to disappear.
fn preserve_model_extensions(client: &str, path: &Path, before: &Value, after: &mut Value) {
    fn fill_missing(before: &Value, after: &mut Value) {
        if let (Some(old), Some(new)) = (before.as_object(), after.as_object_mut()) {
            for (key, value) in old {
                if let Some(next) = new.get_mut(key) {
                    fill_missing(value, next);
                } else {
                    new.insert(key.clone(), value.clone());
                }
            }
        }
    }
    fn merge_entry(client: &str, before: &Value, after: &mut Value) {
        let mut extensions = before.clone();
        let owned: &[&str] = match client {
            "claude-desktop" => &["name", "contextWindow", "supports1m", "prefer1m"],
            "opencode" | "zcode" => &["name"],
            "openclaw" => &["id", "name", "alias"],
            "deepseek-harness" => &["id", "name", "contextWindow"],
            "kimi-code" => &[
                "provider",
                "model",
                "display_name",
                "max_context_size",
                "capabilities",
            ],
            "grok-build" => &[
                "model",
                "base_url",
                "name",
                "api_key",
                "api_backend",
                "context_window",
            ],
            _ => &[],
        };
        if let Some(object) = extensions.as_object_mut() {
            if client == "codex" {
                object.retain(|key, _| !codex_catalog::is_managed_model_field(key));
            }
            for key in owned {
                object.remove(*key);
            }
        }
        if client == "zcode" {
            set(&mut extensions, &["limit".into(), "context".into()], None);
        }
        fill_missing(&extensions, after);
    }
    fn inventory(client: &str, before: &Value, after: &mut Value) {
        if let (Some(old), Some(new)) = (before.as_array(), after.as_array_mut()) {
            let identity = |v: &Value| {
                ["id", "slug", "name"]
                    .into_iter()
                    .find_map(|key| v.get(key).and_then(Value::as_str).map(str::to_string))
            };
            for entry in new {
                if let Some(id) = identity(entry) {
                    if let Some(old) = old.iter().find(|v| identity(v).as_deref() == Some(&id)) {
                        merge_entry(client, old, entry);
                    }
                }
            }
        } else if let (Some(old), Some(new)) = (before.as_object(), after.as_object_mut()) {
            for (key, entry) in new {
                if let Some(old) = old.get(key) {
                    merge_entry(client, old, entry);
                }
            }
        }
    }
    let pointers: &[&str] = match client {
        "codex" if path.file_name().and_then(|v| v.to_str()) == Some(CODEX_MODEL_CATALOG_FILE) => {
            &["/models"]
        }
        "claude-desktop" => &["/inferenceModels"],
        "opencode" | "zcode" => &["/provider/cpa-gui/models"],
        "openclaw" => &[
            "/models/providers/cpa-gui/models",
            "/agents/defaults/models",
        ],
        "kimi-code" => &["/models"],
        "grok-build" => &["/model"],
        _ => &[],
    };
    for pointer in pointers {
        if let (Some(old), Some(new)) = (before.pointer(pointer), after.pointer_mut(pointer)) {
            inventory(client, old, new);
        }
    }
    if client == "deepseek-harness" {
        let pointer = format!("/llm-pi-ai/providers/{DEEPSEEK_HARNESS_PROVIDER_ID}/models");
        if let (Some(old), Some(new)) = (before.pointer(&pointer), after.pointer_mut(&pointer)) {
            inventory(client, old, new);
        }
    }
    if client == "hermes" {
        let old = before
            .get("custom_providers")
            .and_then(Value::as_array)
            .and_then(|providers| {
                providers.iter().find(|p| {
                    p.get("name").and_then(Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID)
                })
            })
            .and_then(|p| p.get("models"));
        let new = after
            .get_mut("custom_providers")
            .and_then(Value::as_array_mut)
            .and_then(|providers| {
                providers.iter_mut().find(|p| {
                    p.get("name").and_then(Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID)
                })
            })
            .and_then(|p| p.get_mut("models"));
        if let (Some(old), Some(new)) = (old, new) {
            inventory(client, old, new);
        }
    }
}

pub(crate) fn config_updates(
    client: &str,
    home: &Path,
    before: &Images,
    updates: &[AgentFileUpdate],
    source: &str,
    model: Option<String>,
    mappings: Option<&ClaudeDesktopModelMappings>,
) -> Result<AgentConfigActionResult, String> {
    let paths = config_paths(client, home)?;
    let after = prepare_config_updates(client, &paths, before, updates, source == "template")?;
    commit_config_with_mappings(
        client,
        &paths,
        before,
        &after,
        source,
        model,
        mappings.cloned(),
    )
}

pub(crate) fn config_package_operation(
    home: &Path,
    _source: &str,
    operation: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "配置文件锁已损坏")?;
    let paths = config_paths(PI_AGENT_ID, home)?;
    let before = config_images(&paths)?;
    validate_config_images(&before)?;
    if operation()
        .and_then(|_| validate_config_images(&config_images(&paths)?))
        .is_err()
    {
        return match write_config_images(PI_AGENT_ID, &before) {
            Ok(()) => Err("插件操作失败，已回滚本次配置修改".into()),
            Err(_) => Err("插件操作失败且配置回滚失败，请检查配置".into()),
        };
    }
    Ok(())
}

fn validate_unmanaged_preserved(
    client: &str,
    paths: &[PathBuf],
    path: &Path,
    before: &Value,
    after: &Value,
) -> Result<(), String> {
    let project = |value: &Value| -> Result<Value, String> {
        let mut value = value.clone();
        if client == "claude-code" {
            if let Some(env) = value.get_mut("env").and_then(Value::as_object_mut) {
                env.retain(|key, _| {
                    !matches!(
                        key.as_str(),
                        "CLAUDE_CODE_SUBAGENT_MODEL" | "CLAUDE_CODE_EFFORT_LEVEL"
                    ) && !key.starts_with("ANTHROPIC_DEFAULT_")
                        && !key.starts_with("ANTHROPIC_MODEL_")
                        && !key.starts_with("ANTHROPIC_CUSTOM_MODEL_OPTION")
                });
            }
        }
        if client == "deepseek-harness" {
            if path == &paths[0] {
                for key in ["displayName", "apiKeyEnv", "api", "baseURL", "models"] {
                    set(
                        &mut value,
                        &[
                            "llm-pi-ai".into(),
                            "providers".into(),
                            DEEPSEEK_HARNESS_PROVIDER_ID.into(),
                            key.into(),
                        ],
                        None,
                    );
                }
                for key in ["provider", "model", "reasoningEffort"] {
                    set(
                        &mut value,
                        &["agent-default-model".into(), key.into()],
                        None,
                    );
                }
            } else {
                set(
                    &mut value,
                    &["refs".into(), DEEPSEEK_HARNESS_CREDENTIAL.into()],
                    None,
                );
                set(&mut value, &[DEEPSEEK_HARNESS_CREDENTIAL.into()], None);
                // The credentials format requires version 1 when initially created.
                if value.get("version") == Some(&serde_json::json!(1)) {
                    set(&mut value, &["version".into()], None);
                }
            }
            return Ok(value);
        }
        let rendered = render(path, &value)?;
        let stripped = restore_text(client, paths, path, &rendered, None)?;
        parse(path, stripped.as_deref())
    };
    if project(before)? != project(after)? {
        return Err(format!(
            "更新意外改变了自定义配置，已拒绝写入: {}",
            path_to_string(path)
        ));
    }
    Ok(())
}

pub(crate) fn text(bytes: Option<&[u8]>) -> Result<Option<&str>, String> {
    bytes
        .map(|bytes| std::str::from_utf8(bytes).map_err(|_| "配置不是 UTF-8 文本".to_string()))
        .transpose()
}

pub(crate) fn parse(path: &Path, content: Option<&str>) -> Result<Value, String> {
    let Some(content) = content else {
        return Ok(serde_json::json!({}));
    };
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let result = match path.extension().and_then(|v| v.to_str()) {
        Some("toml") => toml::from_str::<toml::Value>(content)
            .map_err(|e| e.to_string())
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        Some("yaml" | "yml") => serde_norway::from_str::<Value>(content).map_err(|e| e.to_string()),
        _ => json5::from_str::<Value>(content).map_err(|e| e.to_string()),
    };
    let value = result.map_err(|_| {
        format!(
            "{} 配置格式错误，请使用手动备份恢复或基础配置模板修复",
            path_to_string(path)
        )
    })?;
    if !value.is_object() {
        return Err(format!("{} 配置根节点必须是对象", path_to_string(path)));
    }
    Ok(value)
}

pub(crate) fn render(path: &Path, value: &Value) -> Result<String, String> {
    match path.extension().and_then(|v| v.to_str()) {
        Some("toml") => toml::to_string_pretty(value).map_err(|e| e.to_string()),
        Some("yaml" | "yml") => serde_norway::to_string(value).map_err(|e| e.to_string()),
        _ => serde_json::to_string_pretty(value)
            .map(|v| format!("{v}\n"))
            .map_err(|e| e.to_string()),
    }
}

fn set(value: &mut Value, path: &[String], item: Option<&Value>) {
    if path.is_empty() {
        return;
    }
    if !value.is_object() {
        *value = serde_json::json!({});
    }
    let object = value.as_object_mut().unwrap();
    if path.len() == 1 {
        if let Some(item) = item {
            object.insert(path[0].clone(), item.clone());
        } else {
            object.remove(&path[0]);
        }
    } else if item.is_some() || object.contains_key(&path[0]) {
        let child = object
            .entry(path[0].clone())
            .or_insert_with(|| serde_json::json!({}));
        set(child, &path[1..], item);
        if child.as_object().is_some_and(|v| v.is_empty()) {
            object.remove(&path[0]);
        }
    }
}

fn special_keys(client: &str, path: &Path) -> Option<&'static [&'static str]> {
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    match (client, name) {
        ("codex", "auth.json") => Some(&["auth_mode", "OPENAI_API_KEY", "tokens", "last_refresh"]),
        ("codex", CODEX_MODEL_CATALOG_FILE) => Some(&["models"]),
        ("pi", PI_AGENT_CONFIG_FILE) => Some(&["baseUrl", "apiKey"]),
        ("pi", PI_AGENT_SETTINGS_FILE) => Some(&["defaultProvider", "defaultModel"]),
        _ => None,
    }
}

fn restore_text(
    client: &str,
    paths: &[PathBuf],
    path: &Path,
    current: &str,
    target: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(keys) = special_keys(client, path) {
        let mut root = parse(path, Some(current))?;
        let target_value = parse(path, target)?;
        for key in keys {
            set(&mut root, &[key.to_string()], target_value.get(key));
        }
        return if root.as_object().unwrap().is_empty() && target.is_none() {
            Ok(None)
        } else {
            render(path, &root).map(Some)
        };
    }
    if client == "claude-desktop" && paths.get(3).is_some_and(|p| p == path) {
        let mut root = parse(path, Some(current))?;
        let target = parse(path, target)?;
        set(&mut root, &["appliedId".into()], target.get("appliedId"));
        let mut entries = root
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let original = target
            .get("entries")
            .and_then(Value::as_array)
            .and_then(|entries| {
                entries.iter().find(|e| {
                    e.get("id").and_then(Value::as_str) == Some(CLAUDE_DESKTOP_PROFILE_ID)
                })
            });
        let mut managed = entries
            .iter()
            .find(|e| e.get("id").and_then(Value::as_str) == Some(CLAUDE_DESKTOP_PROFILE_ID))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        entries.retain(|e| e.get("id").and_then(Value::as_str) != Some(CLAUDE_DESKTOP_PROFILE_ID));
        for key in ["id", "name"] {
            set(
                &mut managed,
                &[key.into()],
                original.and_then(|v| v.get(key)),
            );
        }
        if managed.as_object().is_some_and(|o| !o.is_empty()) {
            managed["id"] = serde_json::json!(CLAUDE_DESKTOP_PROFILE_ID);
            entries.push(managed);
        }
        if entries.is_empty() {
            root.as_object_mut().unwrap().remove("entries");
        } else {
            root["entries"] = Value::Array(entries);
        }
        return render(path, &root).map(Some);
    }
    let parsed = AgentClient::parse(client)?;
    let base_paths = if parsed == AgentClient::Codex {
        &paths[..1]
    } else {
        paths
    };
    build_agent_session_restored_bytes(
        parsed,
        base_paths,
        path,
        Some(current.as_bytes()),
        target.map(str::as_bytes),
    )?
    .map(|v| String::from_utf8(v).map_err(|e| e.to_string()))
    .transpose()
}
