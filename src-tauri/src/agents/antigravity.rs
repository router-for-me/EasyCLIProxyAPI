use super::*;
use serde_json::{json, Value};

#[cfg(test)]
mod tests;

pub(crate) const ANTIGRAVITY_CONNECTION_FILE: &str = "cpa-connection.json";
const CLI_MODEL_LABEL: &str = "CPA (EasyCLIProxyAPI)";

pub(crate) fn antigravity_config_paths(_client: AgentClient, home: &Path) -> Vec<PathBuf> {
    let directory = home.join(".gemini/antigravity-cli");
    vec![
        directory.join("settings.json"),
        directory.join(ANTIGRAVITY_CONNECTION_FILE),
    ]
}

pub(crate) fn find_antigravity_cli(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let native = agent_configuration_environment("LOCALAPPDATA")
        .unwrap_or_else(|| home.join("AppData/Local"))
        .join("agy/bin/agy.exe");
    #[cfg(not(target_os = "windows"))]
    let native = home.join(".local/bin/agy");
    if native.is_file() {
        Some(native)
    } else {
        find_named_agent_executable(home, &["agy"])
    }
}

fn object_at<'a>(root: &'a mut Value, keys: &[&str]) -> Result<&'a mut Value, String> {
    let mut value = root;
    for key in keys {
        if !value.is_object() {
            return Err("Antigravity 配置字段必须是对象".into());
        }
        value = value
            .as_object_mut()
            .unwrap()
            .entry((*key).to_string())
            .or_insert_with(|| json!({}));
    }
    if !value.is_object() {
        return Err("Antigravity 配置字段必须是对象".into());
    }
    Ok(value)
}

pub(crate) fn build_antigravity_config(
    _client: AgentClient,
    path: &Path,
    existing: Option<&str>,
    origin: &str,
    api_key: &str,
    model: &str,
) -> Result<String, String> {
    let mut root = parse(path, existing)?;
    if !root.is_object() {
        return Err("Antigravity 配置根节点必须是对象".into());
    }
    if path
        .file_name()
        .is_some_and(|n| n == ANTIGRAVITY_CONNECTION_FILE)
    {
        root["provider"] = json!(MANAGED_AGENT_PROVIDER_ID);
        root["baseUrl"] = json!(origin);
        root["apiKey"] = json!(api_key);
        root["model"] = json!(model);
    } else {
        let entry = object_at(
            &mut root,
            &["customModelsConfig", "customModels", CLI_MODEL_LABEL],
        )?;
        entry["modelName"] = json!(model);
        root["modelProvider"] = json!("gemini");
    }
    render(path, &root)
}

pub(crate) fn build_antigravity_updates(
    client: AgentClient,
    home: &Path,
    origin: &str,
    api_key: &str,
    model: &str,
    template: bool,
) -> Result<Vec<AgentFileUpdate>, String> {
    antigravity_config_paths(client, home)
        .into_iter()
        .map(|path| {
            let before = if template {
                None
            } else {
                read_optional_text(&path)?
            };
            let after = build_antigravity_config(
                client,
                &path,
                before.as_deref(),
                origin,
                api_key,
                model,
            )?;
            Ok(AgentFileUpdate { path, after })
        })
        .collect()
}

fn managed_fields(_client: AgentClient, path: &Path) -> Vec<Vec<&'static str>> {
    if path
        .file_name()
        .is_some_and(|n| n == ANTIGRAVITY_CONNECTION_FILE)
    {
        ["provider", "baseUrl", "apiKey", "model"]
            .into_iter()
            .map(|k| vec![k])
            .collect()
    } else {
        vec![
            vec!["modelProvider"],
            vec![
                "customModelsConfig",
                "customModels",
                CLI_MODEL_LABEL,
                "modelName",
            ],
        ]
    }
}

fn field<'a>(root: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(root, |v, k| v.get(*k))
}

fn replace_field(root: &mut Value, keys: &[&str], value: Option<&Value>) {
    let Some(map) = root.as_object_mut() else {
        return;
    };
    if keys.len() == 1 {
        if let Some(value) = value {
            map.insert(keys[0].into(), value.clone());
        } else {
            map.remove(keys[0]);
        }
    } else {
        if value.is_some() {
            map.entry(keys[0]).or_insert_with(|| json!({}));
        }
        if let Some(child) = map.get_mut(keys[0]) {
            replace_field(child, &keys[1..], value);
            if child.as_object().is_some_and(|m| m.is_empty()) {
                map.remove(keys[0]);
            }
        }
    }
}

pub(crate) fn restore_antigravity_config(
    client: AgentClient,
    path: &Path,
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut root = parse(path, Some(current))?;
    let before = parse(path, original)?;
    for keys in managed_fields(client, path) {
        replace_field(&mut root, &keys, field(&before, &keys));
    }
    if original.is_none() && root.as_object().is_some_and(|m| m.is_empty()) {
        Ok(None)
    } else {
        render(path, &root).map(Some)
    }
}

pub(crate) fn antigravity_has_marker(
    _client: AgentClient,
    paths: &[PathBuf],
) -> Result<bool, String> {
    let path = paths.get(1).ok_or("Antigravity CLI 配置路径缺失")?;
    let root = parse(path, read_optional_text(path)?.as_deref())?;
    Ok(root.get("provider").and_then(Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID))
}

pub(crate) fn inspect_antigravity_config(
    _client: AgentClient,
    paths: &[PathBuf],
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    let settings = parse(&paths[0], read_optional_text(&paths[0])?.as_deref())?;
    let origin = managed_core_loopback_origin(port);
    let path = paths.get(1).ok_or("Antigravity CLI 配置路径缺失")?;
    let connection = parse(path, read_optional_text(path)?.as_deref())?;
    let model = connection
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let configured = model.is_some()
        && settings.get("modelProvider").and_then(Value::as_str) == Some("gemini")
        && field(
            &settings,
            &[
                "customModelsConfig",
                "customModels",
                CLI_MODEL_LABEL,
                "modelName",
            ],
        )
        .and_then(Value::as_str)
            == model.as_deref()
        && connection.get("provider").and_then(Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID)
        && connection.get("baseUrl").and_then(Value::as_str) == Some(&origin)
        && connection.get("apiKey").and_then(Value::as_str) == Some(api_key);
    Ok((configured, model))
}

pub(crate) fn prepare_antigravity_removal(
    client: AgentClient,
    paths: &[PathBuf],
) -> Result<Images, String> {
    if !antigravity_has_marker(client, paths)? {
        return Ok(Vec::new());
    }
    paths
        .iter()
        .map(|path| {
            let value = read_optional_text(path)?
                .map(|current| restore_antigravity_config(client, path, &current, None))
                .transpose()?
                .flatten();
            Ok((path.clone(), value.map(String::into_bytes)))
        })
        .collect()
}

pub(crate) fn antigravity_cli_helper_arguments(home: &Path) -> Vec<String> {
    vec!["--cpa-antigravity-cli".into(), path_to_string(home)]
}

pub(crate) fn antigravity_helper_requested(args: &[std::ffi::OsString]) -> bool {
    args.get(1).is_some_and(|a| a == "--cpa-antigravity-cli")
}

fn antigravity_helper_command(args: &[std::ffi::OsString]) -> Result<Command, String> {
    if !args.get(1).is_some_and(|a| a == "--cpa-antigravity-cli") {
        return Err("未知的 Antigravity 启动参数".into());
    }
    let home = args
        .get(2)
        .map(PathBuf::from)
        .ok_or("Antigravity CLI 启动参数缺少用户目录")?;
    let paths = antigravity_config_paths(AgentClient::AntigravityCli, &home);
    let connection = parse(&paths[1], read_optional_text(&paths[1])?.as_deref())?;
    if connection.get("provider").and_then(Value::as_str) != Some(MANAGED_AGENT_PROVIDER_ID) {
        return Err("Antigravity CLI 的 CPA 配置已关闭，请重新应用配置".into());
    }
    let key = connection
        .get("apiKey")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Antigravity CLI 密钥缺失")?;
    let url = connection
        .get("baseUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("Antigravity CLI 地址缺失")?;
    let model = connection
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("Antigravity CLI 模型缺失")?;
    let settings = parse(&paths[0], read_optional_text(&paths[0])?.as_deref())?;
    if settings.get("modelProvider").and_then(Value::as_str) != Some("gemini")
        || field(
            &settings,
            &[
                "customModelsConfig",
                "customModels",
                CLI_MODEL_LABEL,
                "modelName",
            ],
        )
        .and_then(Value::as_str)
            != Some(model)
    {
        return Err("Antigravity CLI 配置已变化，请重新应用配置".into());
    }
    let executable = find_antigravity_cli(&home).ok_or("未找到 Antigravity CLI")?;
    let mut command = Command::new(executable);
    command
        .arg(format!("--gemini_dir={}", home.join(".gemini").display()))
        .arg(format!("--model={CLI_MODEL_LABEL}"))
        .args(args.iter().skip(3))
        .env("GEMINI_API_KEY", key)
        .env("GOOGLE_GEMINI_BASE_URL", url);
    command.env_remove("GOOGLE_API_KEY");
    Ok(command)
}

pub(crate) fn run_antigravity_helper(args: &[std::ffi::OsString]) -> Result<i32, String> {
    let mut command = antigravity_helper_command(args)?;
    #[cfg(target_os = "windows")]
    {
        unsafe {
            windows_sys::Win32::System::Console::AttachConsole(u32::MAX);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        return Err(format!("启动 Antigravity 失败: {}", command.exec()));
    }
    #[cfg(not(unix))]
    {
        let mut child = command
            .spawn()
            .map_err(|error| format!("启动 Antigravity 失败: {error}"))?;
        #[cfg(target_os = "windows")]
        let job = match attach_child_to_windows_job(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let result = child.wait();
        #[cfg(target_os = "windows")]
        close_windows_handle(job);
        if result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        result
            .map(|s| s.code().unwrap_or(1))
            .map_err(|error| format!("等待 Antigravity 退出失败: {error}"))
    }
}
