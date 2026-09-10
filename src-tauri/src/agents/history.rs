//! Configuration history is independent of the old apply/close session state.
use super::*;
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
type Images = Vec<(PathBuf, Option<Vec<u8>>)>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryFile {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
    hash: String,
    managed_fields: Vec<Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryVersion {
    version: u8,
    id: String,
    client: String,
    created_at: String,
    source: String,
    model: Option<String>,
    files: Vec<HistoryFile>,
    legacy_identity: Option<String>,
    #[serde(default)]
    mappings: Option<ClaudeDesktopModelMappings>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistorySummary {
    id: String,
    created_at: String,
    source: String,
    model: Option<String>,
    file_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryList {
    versions: Vec<HistorySummary>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryDifference {
    file: String,
    field: String,
    before: String,
    after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryPreview {
    revision: String,
    differences: Vec<HistoryDifference>,
}

pub(crate) fn history_paths(client: &str, home: &Path) -> Result<Vec<PathBuf>, String> {
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
    let paths = agent_config_paths(client, home);
    Ok(expected_agent_record_paths(client, &paths))
}

pub(crate) fn history_images(paths: &[PathBuf]) -> Result<Images, String> {
    paths
        .iter()
        .map(|path| Ok((path.clone(), read_agent_bytes(path)?)))
        .collect()
}

fn image_hash(bytes: Option<&[u8]>) -> String {
    bytes.map(sha256_bytes).unwrap_or_else(|| "missing".into())
}

fn image_revision(images: &Images) -> String {
    sha256_bytes(
        images
            .iter()
            .map(|(path, bytes)| {
                format!("{}:{}", path_to_string(path), image_hash(bytes.as_deref()))
            })
            .collect::<Vec<_>>()
            .join("\n")
            .as_bytes(),
    )
}

fn history_directory(client: &str, paths: &[PathBuf]) -> PathBuf {
    let identity = paths
        .iter()
        .map(|p| path_to_string(p))
        .collect::<Vec<_>>()
        .join("\n");
    paths[0]
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".cpa-config-history")
        .join(client)
        .join(sha256_bytes(identity.as_bytes()))
}

fn version_path(client: &str, paths: &[PathBuf], id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|c| c.is_ascii_digit() || c == b'-') {
        return Err("历史版本编号无效".into());
    }
    Ok(history_directory(client, paths).join(format!("{id}.json")))
}

fn text(bytes: Option<&[u8]>) -> Result<Option<&str>, String> {
    bytes
        .map(|bytes| std::str::from_utf8(bytes).map_err(|_| "配置不是 UTF-8 文本".to_string()))
        .transpose()
}

fn parse(path: &Path, content: Option<&str>) -> Result<Value, String> {
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
    let value = result.map_err(|e| format!("{} 配置格式错误: {e}", path_to_string(path)))?;
    if !value.is_object() {
        return Err(format!("{} 配置根节点必须是对象", path_to_string(path)));
    }
    Ok(value)
}

fn render(path: &Path, value: &Value) -> Result<String, String> {
    match path.extension().and_then(|v| v.to_str()) {
        Some("toml") => toml::to_string_pretty(value).map_err(|e| e.to_string()),
        Some("yaml" | "yml") => serde_norway::to_string(value).map_err(|e| e.to_string()),
        _ => serde_json::to_string_pretty(value)
            .map(|v| format!("{v}\n"))
            .map_err(|e| e.to_string()),
    }
}

fn collect_changes(
    before: Option<&Value>,
    after: Option<&Value>,
    prefix: Vec<String>,
    output: &mut BTreeSet<Vec<String>>,
) {
    if before == after {
        return;
    }
    let a = before.and_then(Value::as_object);
    let b = after.and_then(Value::as_object);
    if a.is_some() || b.is_some() {
        let keys = a
            .into_iter()
            .flat_map(|v| v.keys())
            .chain(b.into_iter().flat_map(|v| v.keys()))
            .collect::<BTreeSet<_>>();
        if keys.is_empty() {
            output.insert(prefix);
        } else {
            for key in keys {
                let mut next = prefix.clone();
                next.push(key.clone());
                collect_changes(
                    a.and_then(|v| v.get(key)),
                    b.and_then(|v| v.get(key)),
                    next,
                    output,
                );
            }
        }
    } else {
        output.insert(prefix);
    }
}

fn get<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut value = value;
    for part in path {
        value = value.get(part)?;
    }
    Some(value)
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

fn managed_fields(
    client: &str,
    paths: &[PathBuf],
    path: &Path,
    bytes: Option<&[u8]>,
) -> Result<Vec<Vec<String>>, String> {
    if let Some(keys) = special_keys(client, path) {
        return Ok(keys.iter().map(|key| vec![key.to_string()]).collect());
    }
    let original = text(bytes)?;
    let root = parse(path, original)?;
    let empty = render(path, &serde_json::json!({}))?;
    let stripped = restore_text(client, paths, path, original.unwrap_or(&empty), None)?;
    let stripped_root = parse(path, stripped.as_deref())?;
    let mut fields = BTreeSet::new();
    collect_changes(Some(&root), Some(&stripped_root), Vec::new(), &mut fields);
    if client == "claude-code" {
        for key in ["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_EFFORT_LEVEL"] {
            fields.insert(vec!["env".into(), key.into()]);
        }
        if let Some(env) = root.get("env").and_then(Value::as_object) {
            for key in env.keys().filter(|key| {
                key.starts_with("ANTHROPIC_DEFAULT_")
                    || key.starts_with("ANTHROPIC_MODEL_")
                    || key.starts_with("ANTHROPIC_CUSTOM_MODEL_OPTION")
            }) {
                fields.insert(vec!["env".into(), key.clone()]);
            }
        }
    }
    fields.remove(&Vec::new());
    Ok(fields.into_iter().collect())
}

fn snapshot_model(images: &Images) -> Option<String> {
    for (path, bytes) in images {
        let Ok(root) = parse(path, text(bytes.as_deref()).ok().flatten()) else {
            continue;
        };
        for pointer in [
            "/model",
            "/model/default",
            "/model/main",
            "/defaultModel",
            "/env/ANTHROPIC_MODEL",
            "/agent-default-model/model",
            "/inferenceModels/0/labelOverride",
        ] {
            if let Some(value) = root.pointer(pointer).and_then(Value::as_str) {
                return Some(value.into());
            }
        }
    }
    None
}

// Package commands remain responsible for installation. Only their known config files are snapshotted.
pub(crate) fn history_package_operation(
    home: &Path,
    source: &str,
    operation: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "配置文件锁已损坏")?;
    let paths = history_paths(PI_AGENT_ID, home)?;
    let before = history_images(&paths)?;
    let prior = make_version(
        PI_AGENT_ID,
        &paths,
        &before,
        &format!("before-{source}"),
        None,
    );
    write_version(&paths, &prior)?;
    if history_images(&paths)? != before {
        return Err("备份期间配置发生变化，请刷新后重试".into());
    }
    let result = operation().and_then(|_| {
        let after = history_images(&paths)?;
        write_version(
            &paths,
            &make_version(PI_AGENT_ID, &paths, &after, source, None),
        )
    });
    if let Err(error) = result {
        return match history_write_images(PI_AGENT_ID, &before) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!(
                "{error}；配置回滚失败: {rollback}，原内容仍在配置历史中"
            )),
        };
    }
    Ok(())
}

fn make_version(
    client: &str,
    paths: &[PathBuf],
    images: &Images,
    source: &str,
    model: Option<String>,
) -> HistoryVersion {
    let now = chrono::Utc::now();
    HistoryVersion {
        version: 1,
        id: format!(
            "{}-{}-{}",
            now.format("%Y%m%d%H%M%S%f"),
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ),
        client: client.into(),
        created_at: now.to_rfc3339(),
        source: source.into(),
        model: model.or_else(|| snapshot_model(images)),
        legacy_identity: None,
        mappings: None,
        files: images
            .iter()
            .map(|(path, bytes)| HistoryFile {
                path: path.clone(),
                bytes: bytes.clone(),
                hash: image_hash(bytes.as_deref()),
                managed_fields: managed_fields(client, paths, path, bytes.as_deref())
                    .unwrap_or_default(),
            })
            .collect(),
    }
}

fn write_version(paths: &[PathBuf], version: &HistoryVersion) -> Result<(), String> {
    let path = version_path(&version.client, paths, &version.id)?;
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent).map_err(|e| format!("创建配置历史目录失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("创建配置历史失败: {e}"))?;
    let bytes = serde_json::to_vec(version).map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(format!("保存配置历史失败: {error}"));
    }
    Ok(())
}

fn read_version(client: &str, paths: &[PathBuf], id: &str) -> Result<HistoryVersion, String> {
    let bytes =
        fs::read(version_path(client, paths, id)?).map_err(|e| format!("读取配置历史失败: {e}"))?;
    let version: HistoryVersion =
        serde_json::from_slice(&bytes).map_err(|e| format!("配置历史损坏: {e}"))?;
    if version.version != 1
        || version.client != client
        || version.id != id
        || version.files.len() != paths.len()
        || version.files.iter().zip(paths).any(|(file, path)| {
            file.path != *path || file.hash != image_hash(file.bytes.as_deref())
        })
    {
        return Err("配置历史路径或内容校验失败".into());
    }
    Ok(version)
}

fn versions(client: &str, paths: &[PathBuf]) -> Result<(Vec<HistoryVersion>, Vec<String>), String> {
    let dir = history_directory(client, paths);
    if !dir.exists() {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut result = Vec::new();
    let mut warnings = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|v| v.to_str()) else {
            continue;
        };
        match read_version(client, paths, id) {
            Ok(version) => result.push(version),
            Err(_) => warnings.push(format!("历史版本 {id} 校验失败，已保留但不可恢复")),
        }
    }
    result.sort_by(|a, b| b.id.cmp(&a.id));
    Ok((result, warnings))
}

pub(crate) fn history_write_images(client: &str, images: &Images) -> Result<(), String> {
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
        } else if path.exists() {
            fs::remove_file(path).map_err(|e| format!("删除配置失败: {e}"))?;
        }
    }
    Ok(())
}

pub(crate) fn commit_history(
    client: &str,
    paths: &[PathBuf],
    before: &Images,
    after: &Images,
    source: &str,
    model: Option<String>,
) -> Result<AgentConfigActionResult, String> {
    commit_history_with_mappings(client, paths, before, after, source, model, None)
}

fn commit_history_with_mappings(
    client: &str,
    paths: &[PathBuf],
    before: &Images,
    after: &Images,
    source: &str,
    model: Option<String>,
    mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<AgentConfigActionResult, String> {
    commit_history_with_writer(
        client,
        paths,
        before,
        after,
        source,
        model,
        mappings,
        &mut history_write_images,
    )
}

fn commit_history_with_writer(
    client: &str,
    paths: &[PathBuf],
    before: &Images,
    after: &Images,
    source: &str,
    model: Option<String>,
    mappings: Option<ClaudeDesktopModelMappings>,
    writer: &mut impl FnMut(&str, &Images) -> Result<(), String>,
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
    let changed = before
        .iter()
        .zip(after)
        .filter(|((_, a), (_, b))| a != b)
        .map(|((p, _), _)| path_to_string(p))
        .collect::<Vec<_>>();
    if image_revision(&history_images(paths)?) != image_revision(before) {
        return Err("配置已被其他程序修改，请刷新后重试".into());
    }
    if changed.is_empty() {
        return Ok(action_result(
            "unchanged",
            true,
            model,
            Vec::new(),
            Vec::new(),
        ));
    }
    let mut prior = make_version(client, paths, before, &format!("before-{source}"), None);
    prior.mappings = matching_desktop_mappings(client, paths, before);
    let mut next = make_version(client, paths, after, source, model.clone());
    next.mappings = mappings.or_else(|| matching_desktop_mappings(client, paths, after));
    write_version(paths, &prior)?;
    if image_revision(&history_images(paths)?) != image_revision(before) {
        return Err("备份期间配置发生变化，请刷新后重试".into());
    }
    let transaction = writer(client, after).and_then(|_| write_version(paths, &next));
    if let Err(error) = transaction {
        return match writer(client, before) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!(
                "{error}；回滚失败: {rollback}，原内容仍在配置历史中"
            )),
        };
    }
    let mut result = action_result("updated", true, model, changed, Vec::new());
    result.history_version = Some(next.id);
    Ok(result)
}

pub(crate) fn history_updates(
    client: &str,
    home: &Path,
    before: &Images,
    updates: &[AgentFileUpdate],
    source: &str,
    model: Option<String>,
    mappings: Option<&ClaudeDesktopModelMappings>,
) -> Result<AgentConfigActionResult, String> {
    let paths = history_paths(client, home)?;
    if source != "default" {
        for (path, bytes) in before {
            parse(path, text(bytes.as_deref())?)?;
        }
    }
    let mut after = before.clone();
    for update in updates {
        let entry = after
            .iter_mut()
            .find(|(path, _)| path == &update.path)
            .ok_or("配置更新路径不匹配")?;
        let mut rendered = update.after.clone();
        if client == "codex"
            && source != "default"
            && update.path.file_name().and_then(|v| v.to_str()) == Some(CODEX_MODEL_CATALOG_FILE)
        {
            let mut root = parse(&update.path, text(entry.1.as_deref())?)?;
            let generated = parse(&update.path, Some(&rendered))?;
            set(&mut root, &["models".into()], generated.get("models"));
            if root != generated {
                rendered = render(&update.path, &root)?;
            }
        }
        // Ignore format-only changes; preserve exact existing bytes on a semantic no-op.
        let same = text(entry.1.as_deref())
            .ok()
            .flatten()
            .and_then(|value| parse(&update.path, Some(value)).ok())
            .zip(parse(&update.path, Some(&rendered)).ok())
            .is_some_and(|(a, b)| a == b);
        if !same {
            entry.1 = Some(rendered.into_bytes());
        }
    }
    commit_history_with_mappings(
        client,
        &paths,
        before,
        &after,
        source,
        model,
        mappings.cloned(),
    )
}

fn restored_images(
    client: &str,
    paths: &[PathBuf],
    current: &Images,
    version: &HistoryVersion,
) -> Result<Images, String> {
    current
        .iter()
        .zip(&version.files)
        .map(|((path, bytes), target)| {
            let root = parse(path, text(bytes.as_deref())?)?;
            let target_root = parse(path, text(target.bytes.as_deref())?)?;
            // Derive ownership from trusted restoration rules, not arbitrary paths from a history file.
            let fields = managed_fields(client, paths, path, bytes.as_deref())?
                .into_iter()
                .chain(managed_fields(
                    client,
                    paths,
                    path,
                    target.bytes.as_deref(),
                )?)
                .collect::<BTreeSet<_>>();
            let mut projected = serde_json::json!({});
            for field in &fields {
                set(&mut projected, field, get(&target_root, field));
            }
            // Provider lists mix app-owned and user entries. Project only our provider.
            if client == "hermes" {
                if let Some(providers) = projected
                    .get_mut("custom_providers")
                    .and_then(Value::as_array_mut)
                {
                    providers.retain(|p| {
                        p.get("name").and_then(Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID)
                    });
                    for provider in providers {
                        if let Some(object) = provider.as_object_mut() {
                            object.retain(|key, _| {
                                ["name", "base_url", "api_key", "api_mode", "model", "models"]
                                    .contains(&key.as_str())
                            });
                        }
                    }
                }
            }
            let projected_text = render(path, &projected)?;
            let empty = render(path, &serde_json::json!({}))?;
            let base = text(bytes.as_deref())?.unwrap_or(&empty);
            let restored = restore_text(client, paths, path, base, Some(&projected_text))?;
            let mut restored_root = parse(path, restored.as_deref())?;
            // Include explicitly managed environment fields not covered by legacy restore helpers.
            if client == "claude-code" {
                for field in &fields {
                    set(&mut restored_root, field, get(&target_root, field));
                }
            }
            let rendered = if parse(path, restored.as_deref())? != restored_root {
                Some(render(path, &restored_root)?)
            } else {
                restored
            };
            let result = if root == restored_root {
                bytes.clone()
            } else if restored_root.as_object().is_some_and(|v| v.is_empty())
                && target.bytes.is_none()
            {
                None
            } else {
                rendered.map(String::into_bytes)
            };
            Ok((path.clone(), result))
        })
        .collect()
}

fn hidden(value: Option<&Value>, field: &[String]) -> String {
    let Some(value) = value else {
        return "—".into();
    };
    if field.iter().any(|part| {
        let key = part.to_lowercase();
        ["key", "token", "auth", "secret", "credential", "password"]
            .iter()
            .any(|s| key.contains(s))
    }) {
        return "••••••".into();
    }
    // Arrays/objects may contain credentials; display only their type and size.
    if let Some(array) = value.as_array() {
        return format!("[{} items]", array.len());
    }
    if value.is_object() {
        return "{…}".into();
    }
    let rendered = value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string());
    if rendered.contains("://") && (rendered.contains('@') || rendered.contains('?')) {
        return "••••••".into();
    }
    rendered.chars().take(180).collect()
}

fn preview(
    client: &str,
    paths: &[PathBuf],
    id: &str,
) -> Result<(HistoryPreview, Images, Images), String> {
    let version = read_version(client, paths, id)?;
    let current = history_images(paths)?;
    let after = restored_images(client, paths, &current, &version)?;
    let mut differences = Vec::new();
    for ((path, bytes), (_, next)) in current.iter().zip(&after) {
        let root = parse(path, text(bytes.as_deref())?)?;
        let target = parse(path, text(next.as_deref())?)?;
        let mut fields = BTreeSet::new();
        collect_changes(Some(&root), Some(&target), Vec::new(), &mut fields);
        for field in fields {
            differences.push(HistoryDifference {
                file: path_to_string(path),
                field: field.join("."),
                before: hidden(get(&root, &field), &field),
                after: hidden(get(&target, &field), &field),
            });
        }
    }
    Ok((
        HistoryPreview {
            revision: image_revision(&current),
            differences,
        },
        current,
        after,
    ))
}

#[tauri::command]
pub(crate) fn list_agent_config_history(
    app: tauri::AppHandle,
    client: String,
) -> Result<HistoryList, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "配置文件锁已损坏")?;
    let paths = history_paths(&client, &home)?;
    let mut warnings = import_legacy_history(&client, &home, &paths)?;
    let (entries, errors) = versions(&client, &paths)?;
    warnings.extend(errors);
    Ok(HistoryList {
        versions: entries
            .into_iter()
            .map(|v| HistorySummary {
                id: v.id,
                created_at: v.created_at,
                source: v.source,
                model: v.model,
                file_count: v.files.len(),
            })
            .collect(),
        warnings,
    })
}

#[tauri::command]
pub(crate) fn preview_agent_config_history(
    app: tauri::AppHandle,
    client: String,
    id: String,
) -> Result<HistoryPreview, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "配置文件锁已损坏")?;
    Ok(preview(&client, &history_paths(&client, &home)?, &id)?.0)
}

#[tauri::command]
pub(crate) fn restore_agent_config_history(
    app: tauri::AppHandle,
    client: String,
    id: String,
    revision: String,
) -> Result<AgentConfigActionResult, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "配置文件锁已损坏")?;
    let paths = history_paths(&client, &home)?;
    let (preview, before, after) = preview(&client, &paths, &id)?;
    if preview.revision != revision {
        return Err("预览后配置发生变化，请重新选择历史版本".into());
    }
    let version = read_version(&client, &paths, &id)?;
    let result = commit_history_with_mappings(
        &client,
        &paths,
        &before,
        &after,
        "restore",
        version.model,
        version.mappings,
    )?;
    app.state::<AgentConfigStatusCache>().clear()?;
    Ok(result)
}

pub(crate) fn import_legacy_history(
    client: &str,
    home: &Path,
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    if client == PI_AGENT_ID {
        return Ok(Vec::new());
    }
    let parsed = AgentClient::parse(client)?;
    let state_path = agent_state_path(&agent_config_paths(parsed, home))?;
    let raw = read_agent_bytes(&state_path)?.or_else(|| {
        CODEX_APPLIED_STATES.lock().ok().and_then(|states| {
            states
                .get(&state_path)
                .and_then(|state| serde_json::to_vec(state).ok())
        })
    });
    let Some(raw) = raw else {
        let found = paths.iter().any(|path| {
            latest_dated_agent_backup_path(path)
                .ok()
                .flatten()
                .is_some()
        });
        return Ok(if found {
            vec!["发现没有可验证记录的旧备份，已保留原文件".into()]
        } else {
            Vec::new()
        });
    };
    let identity = sha256_bytes(&raw);
    if versions(client, paths)?
        .0
        .iter()
        .any(|v| v.legacy_identity.as_deref() == Some(&identity))
    {
        return Ok(Vec::new());
    }
    let mut images = Vec::new();
    if let Ok(record) = serde_json::from_slice::<AgentModificationRecord>(&raw) {
        if validate_agent_record(parsed, &agent_config_paths(parsed, home), &record).is_err() {
            return Ok(vec!["旧备份记录无法验证，已保留原文件".into()]);
        }
        for path in paths {
            let Some(file) = record.files.iter().find(|f| &f.path == path) else {
                return Ok(vec!["旧备份文件范围不完整，已保留原文件".into()]);
            };
            let bytes = if file.existed_before {
                read_agent_bytes(&file.backup_path)?
            } else {
                None
            };
            if file.existed_before
                && (bytes.is_none()
                    || file.original_sha256.as_deref() != Some(&image_hash(bytes.as_deref())))
            {
                return Ok(vec!["旧备份内容校验失败，已保留原文件".into()]);
            }
            images.push((path.clone(), bytes));
        }
    } else if let Ok(state) = serde_json::from_slice::<AgentAppliedState>(&raw) {
        if validate_agent_applied_state(parsed, &agent_config_paths(parsed, home), &state).is_err()
        {
            return Ok(vec!["旧应用状态无法验证，已保留原文件".into()]);
        }
        for path in paths {
            let Some(file) = state.backup_files.iter().find(|f| &f.path == path) else {
                return Ok(vec!["旧备份文件范围不完整，已保留原文件".into()]);
            };
            let bytes = if file.existed_before {
                read_agent_bytes(&file.backup_path)?
            } else {
                None
            };
            if file.existed_before && bytes.is_none() {
                return Ok(vec!["旧备份文件缺失，已保留原记录".into()]);
            }
            images.push((path.clone(), bytes));
        }
    } else {
        return Ok(vec!["旧备份记录无法读取，已保留原文件".into()]);
    }
    let mut version = make_version(client, paths, &images, "legacy", None);
    version.legacy_identity = Some(identity);
    write_version(paths, &version)?;
    Ok(Vec::new())
}

fn matching_desktop_mappings(
    client: &str,
    paths: &[PathBuf],
    images: &Images,
) -> Option<ClaudeDesktopModelMappings> {
    if client != "claude-desktop" {
        return None;
    }
    let profile = images.get(2)?;
    let current = parse(&profile.0, text(profile.1.as_deref()).ok()?).ok()?;
    let models = current.get("inferenceModels")?;
    versions(client, paths)
        .ok()?
        .0
        .into_iter()
        .find_map(|version| {
            let mappings = version.mappings?;
            let saved = version.files.get(2)?;
            let root = parse(&saved.path, text(saved.bytes.as_deref()).ok()?).ok()?;
            (root.get("inferenceModels") == Some(models)).then_some(mappings)
        })
}

pub(crate) fn current_desktop_history_mappings(home: &Path) -> Option<ClaudeDesktopModelMappings> {
    let paths = history_paths("claude-desktop", home).ok()?;
    let images = history_images(&paths).ok()?;
    if let Some(mappings) = matching_desktop_mappings("claude-desktop", &paths, &images) {
        return Some(mappings);
    }
    // Compatibility metadata is read without invoking the old state migration/write path.
    let path = agent_state_path(&paths).ok()?;
    let state: AgentAppliedState = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    validate_agent_applied_state(AgentClient::ClaudeDesktop, &paths, &state).ok()?;
    state.claude_desktop_model_mappings
}

#[cfg(test)]
pub(crate) fn test_restore_history(client: AgentClient, home: &Path, source: &str) {
    let paths = history_paths(client.id(), home).unwrap();
    let entries = versions(client.id(), &paths).unwrap().0;
    let version = entries
        .iter()
        .rev()
        .find(|v| v.source == source)
        .expect("history source");
    let (_, before, after) = preview(client.id(), &paths, &version.id).unwrap();
    commit_history(
        client.id(),
        &paths,
        &before,
        &after,
        "restore",
        version.model.clone(),
    )
    .unwrap();
}
#[cfg(test)]
pub(crate) fn test_history_count(client: AgentClient, home: &Path) -> usize {
    versions(client.id(), &history_paths(client.id(), home).unwrap())
        .unwrap()
        .0
        .len()
}

#[cfg(test)]
mod tests;
