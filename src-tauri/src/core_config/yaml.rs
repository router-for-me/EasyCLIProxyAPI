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
            "未找到内核配置模板: {}",
            path_to_string(&example_config_path)
        ));
    }

    let template = fs::read_to_string(&example_config_path).map_err(|err| {
        format!(
            "读取内核配置模板失败 {}: {err}",
            path_to_string(&example_config_path)
        )
    })?;
    let current = if config_path.is_file() {
        Some(fs::read_to_string(&config_path).map_err(|err| {
            format!(
                "读取现有内核配置失败 {}: {err}",
                path_to_string(&config_path)
            )
        })?)
    } else {
        None
    };
    let merged = merge_core_config_yaml(&template, current.as_deref(), gui_config)?;
    write_yaml_if_changed(&config_path, &merged)?;

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
        .map_err(|err| format!("读取内核配置失败 {}: {err}", path_to_string(&config_path)))?;
    let Some(updated) = patch_core_network_yaml(&content, config)? else {
        return Ok(());
    };
    write_yaml_if_changed(&config_path, &updated).map(|_| ())
}

pub(crate) fn patch_core_network_routing_settings(config: &GuiConfigFile) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("读取内核配置失败 {}: {err}", path_to_string(&config_path)))?;
    let Some(updated) = patch_core_network_routing_yaml(&content, config)? else {
        return Ok(());
    };
    write_yaml_if_changed(&config_path, &updated).map(|_| ())
}

pub(crate) fn lock_core_config_file() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    CORE_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "内核配置文件锁已损坏".to_string())
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

pub(crate) fn patch_core_api_keys(api_keys: &[String]) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("读取内核配置失败 {}: {err}", path_to_string(&config_path)))?;
    let updated = patch_core_api_keys_yaml(&content, api_keys)?;
    write_yaml_if_changed(&config_path, &updated)?;
    Ok(())
}

pub(crate) fn patch_core_management_secret_key(secret_key: &str) -> Result<(), String> {
    let secret_key = secret_key.to_string();
    patch_existing_core_config(move |document| {
        set_core_yaml_nested_value(
            document,
            "remote-management",
            "secret-key",
            serde_norway::Value::String(secret_key),
        )
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn patch_core_auth_dir(auth_dir: &str) -> Result<(), String> {
    let auth_dir = auth_dir.to_string();
    patch_existing_core_config(move |document| {
        set_core_yaml_top_level_value(document, "auth-dir", serde_norway::Value::String(auth_dir))
    })
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
        set_core_yaml_top_level_value(
            document,
            "proxy-url",
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
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("读取内核配置失败 {}: {err}", path_to_string(&config_path)))?;
    let Some(updated) = patch_core_yaml_document(&content, update)? else {
        return Ok(());
    };

    write_yaml_if_changed(&config_path, &updated)?;

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
        .map_err(|err| format!("解析内核配置失败: {err}"))?;
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
            insert_yaml_block_mapping_values_at_path(&editable_content, &parent_path, &entries)?
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
        .map_err(|err| format!("解析可编辑内核配置失败: {err}"))?;
    let document = file
        .document()
        .ok_or_else(|| "内核配置没有 YAML 文档".to_string())?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    for change in remaining_changes {
        set_yaml_edit_mapping_path(&root, &change.path, &change.value)?;
    }
    let rendered = file.to_string();
    let validated = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .map_err(|err| format!("验证更新后的内核配置失败: {err}"))?;
    if validated != *updated {
        let path = first_yaml_mismatch_path(updated, &validated, &mut Vec::new())
            .unwrap_or_else(|| "<unknown>".to_string());
        return Err(format!(
            "更新后的内核配置与预期值不一致（路径: {path}），已拒绝写入"
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
                    return Err("当前内核配置更新不支持删除任意 YAML 字段".to_string());
                }
            }
            for (key, updated_value) in updated_mapping {
                let key = key
                    .as_str()
                    .ok_or_else(|| "内核配置映射键必须是字符串".to_string())?;
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
        _ if path.is_empty() => Err("内核配置顶层必须保持为 YAML 映射".to_string()),
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

pub(crate) fn insert_yaml_block_mapping_values_at_path(
    content: &str,
    parent_path: &[String],
    entries: &[(String, serde_norway::Value)],
) -> Result<Option<String>, String> {
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
            .map_err(|error| format!("序列化内核配置值失败: {error}"))?;
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
        .map_err(|err| format!("解析可编辑内核配置失败: {err}"))?;
    let document = file
        .document()
        .ok_or_else(|| "内核配置没有 YAML 文档".to_string())?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let node = yaml_edit_node_at_path(&root, path)
        .ok_or_else(|| format!("未找到内核配置序列 {}", path.join(".")))?;
    let sequence = node
        .as_sequence()
        .ok_or_else(|| format!("内核配置字段 {} 必须是 YAML 序列", path.join(".")))?;
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
            .map_err(|err| format!("序列化内核配置序列失败: {err}"))?;
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
        serde_json::to_string(value).map_err(|err| format!("序列化内核配置序列失败: {err}"))?
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
        return Err("内核配置更新路径不能为空".to_string());
    };
    if remaining.is_empty() {
        return set_yaml_edit_mapping_value(mapping, key, value);
    }
    if let Some(child) = mapping.get(key.as_str()) {
        let child = child
            .as_mapping()
            .ok_or_else(|| format!("内核配置区段 {key} 必须是 YAML 映射"))?;
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
                    return Err(format!("内核配置序列 {key} 长度变化未被预处理"));
                }
                for (index, value) in values.iter().enumerate() {
                    let value = yaml_edit_node_from_value(value)?;
                    if !sequence.set(index, value) {
                        return Err(format!("更新内核配置序列 {key}[{index}] 失败"));
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
        serde_json::to_string(value).map_err(|err| format!("序列化内核配置值失败: {err}"))?;
    let serialized = format!("{WRAPPER_KEY}: {value}\n");
    let file = serialized
        .parse::<yaml_edit::YamlFile>()
        .map_err(|err| format!("解析内核配置值失败: {err}"))?;
    file.document()
        .and_then(|document| document.get(WRAPPER_KEY))
        .ok_or_else(|| "无法构造内核配置值".to_string())
}

pub(crate) fn set_core_yaml_top_level_value(
    document: &mut serde_norway::Value,
    key: &str,
    value: serde_norway::Value,
) -> Result<bool, String> {
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let key = yaml_key(key);
    if root.get(&key) == Some(&value) {
        return Ok(false);
    }
    root.insert(key, value);
    Ok(true)
}

pub(crate) fn set_core_yaml_nested_value(
    document: &mut serde_norway::Value,
    section: &str,
    key: &str,
    value: serde_norway::Value,
) -> Result<bool, String> {
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let section = root
        .entry(yaml_key(section))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "内核配置区段必须是 YAML 映射".to_string())?;
    let key = yaml_key(key);
    if section.get(&key) == Some(&value) {
        return Ok(false);
    }
    section.insert(key, value);
    Ok(true)
}

pub(crate) fn patch_core_api_keys_yaml(
    content: &str,
    api_keys: &[String],
) -> Result<String, String> {
    let parsed = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|err| format!("解析内核配置失败: {err}"))?;
    let root = parsed
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let has_legacy_api_keys = nested_yaml_value(
        root,
        &["auth", "providers", "config-api-key", "api-key-entries"],
    )
    .is_some()
        || nested_yaml_value(root, &["auth", "providers", "config-api-key", "api-keys"]).is_some();
    let content = if has_legacy_api_keys {
        let file = content
            .parse::<yaml_edit::YamlFile>()
            .map_err(|err| format!("解析内核配置失败: {err}"))?;
        let document = file
            .document()
            .ok_or_else(|| "内核配置没有 YAML 文档".to_string())?;
        clear_legacy_api_key_paths(&document);
        file.to_string()
    } else {
        content.to_string()
    };
    let block = render_core_api_keys_yaml(api_keys)?;
    let updated = replace_top_level_yaml_block(&content, "api-keys", &block);
    serde_norway::from_str::<serde_norway::Value>(&updated)
        .map_err(|err| format!("验证更新后的内核配置失败: {err}"))?;
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
        .map_err(|err| format!("生成内核鉴权密钥配置失败: {err}"))?;
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
        return Err("内核配置尚未生成，请先启动 CPA 内核".to_string());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("读取内核配置失败 {}: {err}", path_to_string(&config_path)))?;
    let document = yaml_serde_edit::YamlValue::parse(&content)
        .map_err(|err| format!("解析内核配置失败: {err}"))?;
    Ok((config_path, document))
}

pub(crate) fn core_config_settings_from_value(
    document: &serde_norway::Value,
) -> Result<CoreConfigSettings, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let host = yaml_mapping_value(root, "host")
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "host 必须是字符串".to_string())
        })
        .transpose()?
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = yaml_mapping_value(root, "port")
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u16::try_from(value).ok())
                .filter(|value| *value != 0)
                .ok_or_else(|| "port 必须是 1 到 65535 之间的整数".to_string())
        })
        .transpose()?
        .unwrap_or(8317);
    let auth_dir = yaml_mapping_value(root, "auth-dir")
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "auth-dir 必须是字符串".to_string())
        })
        .transpose()?
        .unwrap_or_else(|| OAUTH_DIR_NAME.to_string());
    let usage_statistics_enabled = yaml_mapping_value(root, "usage-statistics-enabled")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "usage-statistics-enabled 必须是布尔值".to_string())
        })
        .transpose()?
        .unwrap_or(true);
    let api_keys = extract_core_api_keys(root)?
        .into_iter()
        .filter(|api_key| !is_example_core_api_key(api_key))
        .collect();
    let management_secret_key = extract_core_management_secret_key(root)?;
    let plugins_enabled = nested_yaml_value(root, &["plugins", "enabled"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "plugins.enabled 必须是布尔值".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let routing_strategy = nested_yaml_value(root, &["routing", "strategy"])
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "routing.strategy 必须是字符串".to_string())
        })
        .transpose()?
        .unwrap_or_else(|| "round-robin".to_string());
    let proxy_url = yaml_mapping_value(root, "proxy-url")
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "proxy-url 必须是字符串".to_string())
        })
        .transpose()?
        .unwrap_or_default();
    let routing_session_affinity = nested_yaml_value(root, &["routing", "session-affinity"])
        .or_else(|| nested_yaml_value(root, &["routing", "sessionAffinity"]))
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "routing.session-affinity 必须是布尔值".to_string())
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
                    .ok_or_else(|| "routing.session-affinity-ttl 必须是字符串".to_string())
            })
            .transpose()?
            .unwrap_or_default();
    let request_retry = yaml_mapping_value(root, "request-retry")
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "request-retry 必须是非负整数".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_REQUEST_RETRY);
    let max_retry_credentials = yaml_mapping_value(root, "max-retry-credentials")
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "max-retry-credentials 必须是非负整数".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_MAX_RETRY_CREDENTIALS);
    let max_retry_interval = yaml_mapping_value(root, "max-retry-interval")
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "max-retry-interval 必须是非负整数".to_string())
        })
        .transpose()?
        .unwrap_or(DEFAULT_MAX_RETRY_INTERVAL);
    let streaming_bootstrap_retries = nested_yaml_value(root, &["streaming", "bootstrap-retries"])
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| "streaming.bootstrap-retries 必须是非负整数".to_string())
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
        usage_statistics_enabled,
        plugins_enabled,
        routing_strategy,
        proxy_url,
        routing_session_affinity,
        routing_session_affinity_ttl,
        request_retry,
        max_retry_credentials,
        max_retry_interval,
        streaming_bootstrap_retries,
        management_secret_key,
    })
}

pub(crate) fn extract_core_api_keys(root: &serde_norway::Mapping) -> Result<Vec<String>, String> {
    if let Some(value) = yaml_mapping_value(root, "api-keys") {
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
        .ok_or_else(|| format!("{field_name} 必须是数组"))?;
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
        "鉴权密钥条目必须是字符串或包含 key 字段的映射".to_string()
    ))
}

pub(crate) fn extract_core_management_secret_key(
    root: &serde_norway::Mapping,
) -> Result<Option<String>, String> {
    let Some(value) = nested_yaml_value(root, &["remote-management", "secret-key"]) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| "remote-management.secret-key 必须是字符串".to_string())?
        .trim()
        .to_string();
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(value))
}

#[cfg(test)]
pub(crate) fn set_core_api_keys(
    document: &mut serde_norway::Value,
    api_keys: Vec<String>,
) -> Result<(), String> {
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
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
        return Err("内核配置路径无效".to_string());
    }

    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let section = root
        .entry(yaml_key(path[0]))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()));
    let section = section
        .as_mapping_mut()
        .ok_or_else(|| format!("{} 必须是 YAML 映射", path[0]))?;
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
