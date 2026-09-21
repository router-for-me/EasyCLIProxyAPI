use super::*;
use serde_json::{json, Value};

#[cfg(test)]
mod tests;

// WorkBuddy AI 5.5 reads models.json as either LanguageModel[] or { models, availableModels }.
// Its chat selection is account/session-local; publishing a model must not rewrite that state.
pub(crate) fn workbuddy_home(home: &Path) -> PathBuf {
    workbuddy_home_from_environment(
        home,
        agent_configuration_environment("WORKBUDDY_CONFIG_DIR").as_deref(),
        agent_configuration_environment("CODEBUDDY_CONFIG_DIR").as_deref(),
        find_workbuddy_desktop_executable(home).as_deref(),
    )
}

pub(crate) fn workbuddy_home_from_environment(
    home: &Path,
    workbuddy_dir: Option<&Path>,
    codebuddy_dir: Option<&Path>,
    executable: Option<&Path>,
) -> PathBuf {
    if let Some(directory) = workbuddy_dir.or(codebuddy_dir) {
        return directory.to_path_buf();
    }
    if let Some(executable) = executable {
        let resources = workbuddy_resources(executable);
        if let Some(folder) = resources
            .and_then(|p| fs::read_to_string(p.join("app.asar.unpacked/cli/product.json")).ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| {
                v.get("dataFolderName")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|s| !s.trim().is_empty())
        {
            return home.join(folder.trim());
        }
    }
    let ai = home.join(".workbuddy-ai");
    let legacy = home.join(".workbuddy");
    if !ai.exists() && legacy.join("settings.json").is_file() {
        legacy
    } else {
        ai
    }
}

fn workbuddy_resources(executable: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(executable.parent()?.parent()?.join("Resources"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(executable.parent()?.join("resources"))
    }
}

pub(crate) fn find_workbuddy_desktop_executable(home: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "windows")]
    {
        let local = agent_configuration_environment("LOCALAPPDATA")
            .unwrap_or_else(|| home.join("AppData/Local"));
        let mut roots = vec![local.join("Programs"), local];
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = agent_configuration_environment(variable) {
                roots.push(root);
            }
        }
        if let Some(root) = agent_configuration_environment("WORKBUDDY_INSTALL_DIR") {
            candidates.extend([root.join("WorkBuddyAI.exe"), root.join("WorkBuddy.exe")]);
        }
        for root in roots {
            for (directory, executable) in [
                ("WorkBuddyAI", "WorkBuddyAI.exe"),
                ("WorkBuddy", "WorkBuddy.exe"),
                ("WorkBuddy AI", "WorkBuddyAI.exe"),
            ] {
                candidates.push(root.join(directory).join(executable));
            }
        }
    }
    #[cfg(target_os = "macos")]
    for root in [PathBuf::from("/Applications"), home.join("Applications")] {
        for (app, executable) in [("WorkBuddy AI", "WorkBuddy AI"), ("WorkBuddy", "WorkBuddy")] {
            candidates.push(root.join(format!("{app}.app/Contents/MacOS/{executable}")));
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        candidates.extend([
            home.join(".local/bin/workbuddy"),
            PathBuf::from("/opt/WorkBuddy/workbuddy"),
            PathBuf::from("/opt/WorkBuddyAI/workbuddy"),
        ]);
    }
    let found = candidates.into_iter().find(|path| path.is_file());
    #[cfg(all(target_os = "windows", not(test)))]
    let found = found.or_else(find_windows_registered_workbuddy_executable);
    found
}

pub(crate) fn read_workbuddy_app_version(executable: &Path) -> Option<String> {
    // Use file metadata, never run an Electron application with --version during detection.
    read_zcode_app_version(executable)
}

pub(crate) fn parse_workbuddy_config(content: Option<&str>) -> Result<Value, String> {
    let value = match content {
        Some(content) => serde_json::from_str(content.strip_prefix('\u{feff}').unwrap_or(content))
            .map_err(|_| "WorkBuddy models.json 格式无效，请使用手动备份恢复或基础配置模板修复")?,
        None => json!({}),
    };
    validate_workbuddy_config(&value)?;
    Ok(value)
}

pub(crate) fn validate_workbuddy_config(value: &Value) -> Result<(), String> {
    let entries = if let Some(array) = value.as_array() {
        Some(array)
    } else if let Some(root) = value.as_object() {
        if root.get("availableModels").is_some_and(|v| {
            v.as_array()
                .is_none_or(|a| a.iter().any(|v| !v.is_string()))
        }) {
            return Err("WorkBuddy availableModels 必须是字符串数组".into());
        }
        match root.get("models") {
            None => None,
            Some(v) => Some(v.as_array().ok_or("WorkBuddy models 必须是数组")?),
        }
    } else {
        return Err("WorkBuddy models.json 根节点必须是对象或数组".into());
    };
    let mut ids = std::collections::HashSet::new();
    for entry in entries.into_iter().flatten() {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or("WorkBuddy 模型缺少有效 id")?;
        if !ids.insert(workbuddy_request_model(id)) {
            return Err("WorkBuddy 存在重复模型 id，请先修复配置".into());
        }
    }
    Ok(())
}

fn workbuddy_request_model(id: &str) -> &str {
    id.strip_prefix("custom-local:").unwrap_or(id)
}

fn workbuddy_models(value: &Value) -> &[Value] {
    value
        .as_array()
        .or_else(|| value.get("models").and_then(Value::as_array))
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn workbuddy_managed_model(value: &Value) -> bool {
    value.get("vendor").and_then(Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID)
}

fn set_workbuddy_models(value: &mut Value, models: Vec<Value>) {
    if value.is_array() {
        *value = Value::Array(models);
    } else if models.is_empty() {
        value.as_object_mut().unwrap().remove("models");
    } else {
        value["models"] = Value::Array(models);
    }
}

pub(crate) fn build_workbuddy_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let mut root = parse_workbuddy_config(existing)?;
    let mut entries = workbuddy_models(&root)
        .iter()
        .filter(|m| !workbuddy_managed_model(m))
        .cloned()
        .collect::<Vec<_>>();
    if entries.iter().any(|m| {
        m.get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| workbuddy_request_model(id) == model)
    }) {
        return Err(
            "WorkBuddy 已有同名自定义模型，请先在 WorkBuddy 中修改该模型 ID，或选择其他 CPA 模型"
                .into(),
        );
    }
    let mut entry = workbuddy_models(&root)
        .iter()
        .find(|m| {
            workbuddy_managed_model(m)
                && m.get("id")
                    .and_then(Value::as_str)
                    .map(workbuddy_request_model)
                    == Some(model)
        })
        .cloned()
        .unwrap_or_else(|| json!({}));
    entry["id"] = json!(model);
    update_workbuddy_model(&mut entry, base_url, api_key, model, available_models);
    entries.push(entry);
    for previous in workbuddy_models(&root)
        .iter()
        .filter(|m| workbuddy_managed_model(m))
    {
        let id = previous["id"].as_str().ok_or("WorkBuddy 模型缺少有效 id")?;
        let previous_model = workbuddy_request_model(id);
        if previous_model == model {
            continue;
        }
        let mut retained = previous.clone();
        update_workbuddy_model(
            &mut retained,
            base_url,
            api_key,
            previous_model,
            available_models,
        );
        entries.push(retained);
    }
    set_workbuddy_models(&mut root, entries);
    if let Some(visible) = root
        .get_mut("availableModels")
        .and_then(Value::as_array_mut)
    {
        if !visible.is_empty()
            && !visible
                .iter()
                .any(|v| v.as_str().map(workbuddy_request_model) == Some(model))
        {
            visible.push(json!(model));
        }
    }
    serde_json::to_string_pretty(&root).map_err(|_| "生成 WorkBuddy 配置失败".into())
}

fn update_workbuddy_model(
    entry: &mut Value,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) {
    entry["name"] = json!("CPA");
    entry["vendor"] = json!(MANAGED_AGENT_PROVIDER_ID);
    entry["url"] = json!(format!(
        "{}/chat/completions",
        base_url.trim_end_matches('/')
    ));
    entry["apiKey"] = json!(api_key);
    entry["supportsToolCall"] = json!(true);
    entry["disabled"] = json!(false);
    // WorkBuddy prefixes local model IDs itself and removes that prefix before sending requests.
    entry["useCustomProtocol"] = json!(false);
    if let Some(metadata) = available_models.iter().find(|m| m.name == model) {
        if let Some(context) = metadata.context_window {
            entry["maxInputTokens"] = json!(context);
        }
        if let Some(input) = &metadata.input_modalities {
            entry["supportsImages"] = json!(input.iter().any(|s| s == "image"));
        }
    }
}

pub(crate) fn workbuddy_has_managed_marker(path: &Path) -> Result<bool, String> {
    let root = parse_workbuddy_config(read_optional_text(path)?.as_deref())?;
    Ok(workbuddy_models(&root).iter().any(workbuddy_managed_model))
}

pub(crate) fn inspect_workbuddy_agent_config(
    path: &Path,
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    let root = parse_workbuddy_config(read_optional_text(path)?.as_deref())?;
    let managed = workbuddy_models(&root)
        .iter()
        .filter(|m| workbuddy_managed_model(m))
        .collect::<Vec<_>>();
    let Some(entry) = managed.first() else {
        return Ok((false, None));
    };
    let model = entry
        .get("id")
        .and_then(Value::as_str)
        .map(workbuddy_request_model);
    let visible = root
        .get("availableModels")
        .and_then(Value::as_array)
        .is_none_or(|a| {
            a.is_empty()
                || a.iter()
                    .any(|v| v.as_str().map(workbuddy_request_model) == model)
        });
    let expected_url = format!("{}/v1/chat/completions", managed_core_loopback_origin(port));
    let configured = visible
        && managed.iter().all(|entry| {
            entry.get("url").and_then(Value::as_str) == Some(&expected_url)
                && entry.get("apiKey").and_then(Value::as_str) == Some(api_key)
                && entry.get("disabled").and_then(Value::as_bool) != Some(true)
                && entry.get("supportsToolCall").and_then(Value::as_bool) == Some(true)
        });
    Ok((configured, model.map(str::to_string)))
}

pub(crate) fn strip_workbuddy_managed(root: &mut Value) {
    let ids = workbuddy_models(root)
        .iter()
        .filter(|m| workbuddy_managed_model(m))
        .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<_>>();
    let entries = workbuddy_models(root)
        .iter()
        .filter(|m| !workbuddy_managed_model(m))
        .cloned()
        .collect();
    set_workbuddy_models(root, entries);
    if let Some(visible) = root
        .get_mut("availableModels")
        .and_then(Value::as_array_mut)
    {
        visible.retain(|v| {
            !v.as_str().is_some_and(|id| {
                ids.iter()
                    .any(|old| workbuddy_request_model(id) == workbuddy_request_model(old))
            })
        });
    }
}

pub(crate) fn merge_workbuddy_visibility(
    baseline: &Value,
    applied: &Value,
    current: &Value,
    merged: &mut Value,
) {
    if !merged.is_object() || current.get("availableModels") == applied.get("availableModels") {
        return;
    }
    let Some(now) = current.get("availableModels").and_then(Value::as_array) else {
        merged.as_object_mut().unwrap().remove("availableModels");
        return;
    };
    let original_ids = baseline
        .get("availableModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(workbuddy_request_model)
        .collect::<Vec<_>>();
    let removed_ids = [applied, current]
        .into_iter()
        .flat_map(workbuddy_models)
        .filter(|m| workbuddy_managed_model(m))
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .map(workbuddy_request_model)
        .collect::<Vec<_>>();
    let surviving_ids = workbuddy_models(current)
        .iter()
        .filter(|m| !workbuddy_managed_model(m))
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .map(workbuddy_request_model)
        .collect::<Vec<_>>();
    let visible = now
        .iter()
        .filter(|value| {
            let Some(id) = value.as_str().map(workbuddy_request_model) else {
                return false;
            };
            !removed_ids.contains(&id) || original_ids.contains(&id) || surviving_ids.contains(&id)
        })
        .cloned()
        .collect::<Vec<_>>();
    merged["availableModels"] = json!(visible);
}

pub(crate) fn validate_workbuddy_unmanaged_preserved(
    before: &Value,
    after: &Value,
) -> Result<(), String> {
    let ids = [before, after]
        .into_iter()
        .flat_map(workbuddy_models)
        .filter(|m| workbuddy_managed_model(m))
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .map(workbuddy_request_model)
        .collect::<Vec<_>>();
    let project = |value: &Value| {
        let mut value = value.clone();
        strip_workbuddy_managed(&mut value);
        if let Some(visible) = value
            .get_mut("availableModels")
            .and_then(Value::as_array_mut)
        {
            visible.retain(|v| {
                !v.as_str()
                    .is_some_and(|id| ids.contains(&workbuddy_request_model(id)))
            });
        }
        value
    };
    if project(before) != project(after) {
        return Err("更新意外改变了 WorkBuddy 自定义配置，已拒绝写入".into());
    }
    Ok(())
}

pub(crate) fn build_restored_workbuddy_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut root = parse_workbuddy_config(Some(current))?;
    strip_workbuddy_managed(&mut root);
    if let Some(original) = original {
        let before = parse_workbuddy_config(Some(original))?;
        // Keep an explicitly empty models list and the original visibility filter when unchanged.
        if root.is_object() && before.get("models").is_some() && root.get("models").is_none() {
            root["models"] = json!([]);
        }
        if root.is_object() {
            if let Some(visible) = before.get("availableModels") {
                root["availableModels"] = visible.clone();
            } else {
                root.as_object_mut().unwrap().remove("availableModels");
            }
        }
    }

    if original.is_none()
        && (root.as_object().is_some_and(|r| r.is_empty())
            || root.as_array().is_some_and(|r| r.is_empty()))
    {
        return Ok(None);
    }
    serde_json::to_string_pretty(&root)
        .map(Some)
        .map_err(|_| "恢复 WorkBuddy 配置失败".into())
}

pub(crate) fn prepare_workbuddy_managed_removal(paths: &[PathBuf]) -> Result<Images, String> {
    let path = paths.first().ok_or("WorkBuddy 配置路径不可用")?;
    let Some(current) = read_optional_text(path)? else {
        return Ok(Vec::new());
    };
    let mut value = parse_workbuddy_config(Some(&current))?;
    if !workbuddy_models(&value).iter().any(workbuddy_managed_model) {
        return Ok(Vec::new());
    }
    strip_workbuddy_managed(&mut value);
    let bytes = if value.as_object().is_some_and(|v| v.is_empty())
        || value.as_array().is_some_and(|v| v.is_empty())
    {
        None
    } else {
        Some(serde_json::to_vec_pretty(&value).map_err(|_| "生成 WorkBuddy 配置失败")?)
    };
    Ok(vec![(path.clone(), bytes)])
}
