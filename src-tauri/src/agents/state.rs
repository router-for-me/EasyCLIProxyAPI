use super::*;

pub(crate) fn agent_backup_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("智能体配置文件名无效: {}", path_to_string(path)))?;
    Ok(path.with_file_name(format!("{file_name}.cpa-gui.backup")))
}

pub(crate) fn agent_state_path(paths: &[PathBuf]) -> Result<PathBuf, String> {
    let primary = paths
        .first()
        .ok_or_else(|| "当前平台没有可用的智能体配置路径".to_string())?;
    let file_name = primary
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("智能体配置文件名无效: {}", path_to_string(primary)))?;
    Ok(primary.with_file_name(format!("{file_name}.cpa-gui.state.json")))
}

pub(crate) fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn agent_managed_paths(client: AgentClient, home: &Path) -> Vec<PathBuf> {
    let paths = agent_config_paths(client, home);
    expected_agent_record_paths(client, &paths)
}

pub(crate) fn legacy_agent_backup_paths(state_content: &str) -> Vec<PathBuf> {
    serde_json::from_str::<AgentModificationRecord>(state_content)
        .ok()
        .map(|record| {
            record
                .files
                .into_iter()
                .map(|file| file.backup_path)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn write_agent_applied_state(
    path: &Path,
    state: &AgentAppliedState,
) -> Result<(), String> {
    if state.client == AgentClient::Codex.id() {
        CODEX_APPLIED_STATES
            .lock()
            .map_err(|_| "Codex 应用状态内存锁已损坏".to_string())?
            .insert(path.to_path_buf(), state.clone());
        if path.is_file() {
            fs::remove_file(path).map_err(|error| {
                format!(
                    "清理旧版 Codex 应用状态失败 {}: {error}",
                    path_to_string(path)
                )
            })?;
        }
        return Ok(());
    }

    let mut content = serde_json::to_string_pretty(state)
        .map_err(|error| format!("生成智能体应用状态失败: {error}"))?;
    content.push('\n');
    write_bytes_directly(path, content.as_bytes())
}

pub(crate) fn clear_codex_applied_state(path: &Path) -> Result<(), String> {
    CODEX_APPLIED_STATES
        .lock()
        .map_err(|_| "Codex 应用状态内存锁已损坏".to_string())?
        .remove(path);
    Ok(())
}

pub(crate) fn is_dated_agent_backup_name(file_name: &str, original_name: &str) -> bool {
    let Some(date) = file_name
        .strip_prefix(&format!("{original_name}."))
        .and_then(|value| value.strip_suffix(".bak"))
    else {
        return false;
    };
    let bytes = date.as_bytes();
    bytes.len() == 8
        && bytes[0..2].iter().all(u8::is_ascii_digit)
        && bytes[2] == b'-'
        && bytes[3..5].iter().all(u8::is_ascii_digit)
        && bytes[5] == b'-'
        && bytes[6..8].iter().all(u8::is_ascii_digit)
}

pub(crate) fn latest_dated_agent_backup_path(path: &Path) -> Result<Option<PathBuf>, String> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    if !directory.is_dir() {
        return Ok(None);
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("智能体配置文件名无效: {}", path_to_string(path)))?;
    let mut candidates = fs::read_dir(directory)
        .map_err(|error| {
            format!(
                "读取智能体备份目录失败 {}: {error}",
                path_to_string(directory)
            )
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|candidate| {
            candidate
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| is_dated_agent_backup_name(value, file_name))
        })
        .collect::<Vec<_>>();
    candidates.sort();
    Ok(candidates.pop())
}

pub(crate) fn recover_codex_applied_state_from_backups(
    paths: &[PathBuf],
) -> Result<Option<AgentAppliedState>, String> {
    let managed_paths = expected_agent_record_paths(AgentClient::Codex, paths);
    let mut discovered = Vec::with_capacity(managed_paths.len());
    let mut found_backup = false;
    for path in managed_paths {
        let backup = latest_dated_agent_backup_path(&path)?;
        found_backup |= backup.is_some();
        discovered.push((path, backup));
    }
    if !found_backup {
        return Ok(None);
    }

    let model = paths
        .first()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|content| toml::from_str::<toml::Value>(&content).ok())
        .and_then(|root| {
            root.get("model")
                .and_then(toml::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let mut backup_files = Vec::with_capacity(discovered.len());
    for (path, backup) in discovered {
        let existed_before = backup.is_some();
        backup_files.push(AgentAppliedBackupFile {
            backup_path: match backup {
                Some(path) => path,
                None => dated_agent_backup_path(&path)?,
            },
            path,
            existed_before,
        });
    }
    let state = AgentAppliedState {
        version: AGENT_APPLIED_STATE_VERSION,
        client: AgentClient::Codex.id().to_string(),
        model,
        configuration_revision: AGENT_CONFIGURATION_REVISION,
        claude_desktop_model_mappings: None,
        backup_files,
        updated_at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    Ok(Some(state))
}

pub(crate) fn validate_agent_applied_state(
    client: AgentClient,
    paths: &[PathBuf],
    state: &AgentAppliedState,
) -> Result<(), String> {
    if state.client != client.id() {
        return Err("智能体应用状态与客户端不匹配".to_string());
    }
    if state.backup_files.is_empty() {
        return Ok(());
    }
    let expected_paths = expected_agent_record_paths(client, paths);
    let state_paths = state
        .backup_files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let codex_paths_without_auth = (client == AgentClient::Codex
        && expected_paths
            .last()
            .and_then(|path| path.file_name())
            .is_some_and(|name| name == "auth.json"))
    .then(|| &expected_paths[..expected_paths.len().saturating_sub(1)]);
    let valid_paths = state_paths == expected_paths
        || codex_paths_without_auth.is_some_and(|expected| state_paths == expected)
        || (client == AgentClient::Codex && state_paths.as_slice() == paths)
        || (client == AgentClient::ZCode
            && paths
                .first()
                .is_some_and(|path| state_paths == [path.clone()]));
    if !valid_paths {
        return Err("智能体应用状态文件数量或路径不匹配".to_string());
    }
    for file in &state.backup_files {
        let legacy_backup = agent_backup_path(&file.path)?;
        let original_name = file
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| format!("智能体配置文件名无效: {}", path_to_string(&file.path)))?;
        let dated_backup = file.backup_path.parent() == file.path.parent()
            && file
                .backup_path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| is_dated_agent_backup_name(name, original_name));
        if file.backup_path != legacy_backup && !dated_backup {
            return Err("智能体应用状态包含非预期备份路径".to_string());
        }
    }
    Ok(())
}

pub(crate) fn load_agent_applied_state(
    client: AgentClient,
    home: &Path,
) -> Result<Option<AgentAppliedState>, String> {
    let paths = agent_config_paths(client, home);
    let state_path = agent_state_path(&paths)?;
    if client == AgentClient::Codex {
        if let Some(state) = CODEX_APPLIED_STATES
            .lock()
            .map_err(|_| "Codex 应用状态内存锁已损坏".to_string())?
            .get(&state_path)
            .cloned()
        {
            return Ok(Some(state));
        }
    }
    if !state_path.is_file() {
        let recovered = if client == AgentClient::Codex {
            recover_codex_applied_state_from_backups(&paths)?
        } else {
            None
        };
        if let Some(state) = recovered.as_ref() {
            write_agent_applied_state(&state_path, state)?;
        }
        return Ok(recovered);
    }
    let content = fs::read_to_string(&state_path)
        .map_err(|error| format!("读取智能体应用状态失败: {error}"))?;
    let value = serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("解析智能体应用状态失败: {error}"))?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "智能体应用状态缺少版本号".to_string())?;
    let version = u8::try_from(version).map_err(|_| "不支持的智能体应用状态版本".to_string())?;
    if version == AGENT_APPLIED_STATE_VERSION || version == 3 {
        let state = serde_json::from_value::<AgentAppliedState>(value)
            .map_err(|error| format!("解析智能体应用状态失败: {error}"))?;
        validate_agent_applied_state(client, &paths, &state)?;
        if client == AgentClient::Codex {
            write_agent_applied_state(&state_path, &state)?;
        }
        return Ok(Some(state));
    }
    if version != LEGACY_AGENT_MODIFICATION_STATE_VERSION
        && version != AGENT_MODIFICATION_STATE_VERSION
    {
        return Err("不支持的智能体应用状态版本".to_string());
    }

    let record = serde_json::from_value::<AgentModificationRecord>(value)
        .map_err(|error| format!("解析旧版智能体状态失败: {error}"))?;
    validate_agent_record(client, &paths, &record)?;
    let backup_files = record
        .files
        .iter()
        .map(|file| AgentAppliedBackupFile {
            path: file.path.clone(),
            backup_path: file.backup_path.clone(),
            existed_before: file.existed_before,
        })
        .collect();
    let state = AgentAppliedState {
        version: AGENT_APPLIED_STATE_VERSION,
        client: client.id().to_string(),
        model: record.model,
        configuration_revision: 0,
        claude_desktop_model_mappings: None,
        backup_files,
        updated_at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    write_agent_applied_state(&state_path, &state)?;
    Ok(Some(state))
}

pub(crate) fn read_agent_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("读取智能体配置失败 {}: {error}", path_to_string(path)))
}

#[cfg(test)]
pub(crate) fn read_agent_original_bytes(
    file: &AgentModificationFile,
) -> Result<Option<Vec<u8>>, String> {
    if !file.existed_before {
        return Ok(None);
    }
    let original_sha256 = file
        .original_sha256
        .as_deref()
        .ok_or_else(|| format!("原配置备份缺少校验值: {}", path_to_string(&file.path)))?;
    let bytes = fs::read(&file.backup_path).map_err(|error| {
        format!(
            "读取原配置备份失败 {}: {error}",
            path_to_string(&file.backup_path)
        )
    })?;
    if sha256_bytes(&bytes) != original_sha256 {
        return Err(format!(
            "原配置备份校验失败: {}",
            path_to_string(&file.backup_path)
        ));
    }
    Ok(Some(bytes))
}

#[cfg(test)]
pub(crate) fn read_agent_original_text(
    file: &AgentModificationFile,
) -> Result<Option<String>, String> {
    read_agent_original_bytes(file)?
        .map(|bytes| {
            String::from_utf8(bytes).map_err(|_| {
                format!(
                    "原 Codex 配置不是 UTF-8 文本: {}",
                    path_to_string(&file.path)
                )
            })
        })
        .transpose()
}

#[cfg(test)]
pub(crate) fn write_agent_state(
    path: &Path,
    record: &AgentModificationRecord,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("创建智能体状态目录失败 {}: {error}", path_to_string(parent))
        })?;
    }
    let mut content = serde_json::to_string_pretty(record)
        .map_err(|error| format!("生成智能体备份状态失败: {error}"))?;
    content.push('\n');
    write_yaml_if_changed(path, &content).map(|_| ())
}

pub(crate) fn validate_agent_record(
    client: AgentClient,
    paths: &[PathBuf],
    record: &AgentModificationRecord,
) -> Result<(), String> {
    let supported_version = record.version == AGENT_MODIFICATION_STATE_VERSION
        || record.version == LEGACY_AGENT_MODIFICATION_STATE_VERSION;
    if !supported_version || record.client != client.id() {
        return Err("智能体备份状态版本或客户端不匹配".to_string());
    }
    if ![
        AGENT_PHASE_APPLYING,
        AGENT_PHASE_ACTIVE,
        AGENT_PHASE_RESTORING,
        AGENT_PHASE_RECOVERY,
    ]
    .contains(&record.phase.as_str())
    {
        return Err("智能体备份状态阶段无效".to_string());
    }
    let expected_paths = expected_agent_record_paths(client, paths);
    let record_paths = record
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let valid_paths = record_paths.as_slice() == paths
        || (client == AgentClient::Codex && record_paths == expected_paths)
        || (client == AgentClient::ZCode
            && paths
                .first()
                .is_some_and(|path| record_paths == [path.clone()]));
    if !valid_paths {
        return Err("智能体备份状态文件数量或路径不匹配".to_string());
    }
    for file in &record.files {
        if file.backup_path != agent_backup_path(&file.path)? {
            return Err("智能体备份状态包含非预期路径".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn load_agent_record(
    client: AgentClient,
    paths: &[PathBuf],
) -> Result<Option<AgentModificationRecord>, String> {
    let state_path = agent_state_path(paths)?;
    if !state_path.is_file() {
        return Ok(None);
    }
    let mut record: AgentModificationRecord = serde_json::from_str(
        &fs::read_to_string(&state_path)
            .map_err(|error| format!("读取智能体备份状态失败: {error}"))?,
    )
    .map_err(|error| format!("解析智能体备份状态失败: {error}"))?;
    validate_agent_record(client, paths, &record)?;
    if record.version == LEGACY_AGENT_MODIFICATION_STATE_VERSION {
        record.version = AGENT_MODIFICATION_STATE_VERSION;
    }
    Ok(Some(record))
}

#[cfg(test)]
pub(crate) fn record_backup_available(record: &AgentModificationRecord) -> bool {
    record
        .files
        .iter()
        .all(|file| !file.existed_before || file.backup_path.is_file())
}

#[cfg(test)]
pub(crate) fn record_conflict_files(
    record: &AgentModificationRecord,
) -> Result<Vec<String>, String> {
    let mut conflicts = Vec::new();
    for file in &record.files {
        let current = read_agent_bytes(&file.path)?;
        let matches =
            current.as_deref().map(sha256_bytes).as_deref() == Some(file.managed_sha256.as_str());
        if !matches {
            conflicts.push(path_to_string(&file.path));
        }
    }
    Ok(conflicts)
}

#[cfg(test)]
pub(crate) fn record_restore_conflict_files(
    record: &AgentModificationRecord,
) -> Result<Vec<String>, String> {
    let mut conflicts = Vec::new();
    for file in &record.files {
        let current = read_agent_bytes(&file.path)?;
        let matches_managed =
            current.as_deref().map(sha256_bytes).as_deref() == Some(file.managed_sha256.as_str());
        let matches_original = if file.existed_before {
            current.as_deref().map(sha256_bytes) == file.original_sha256
        } else {
            current.is_none()
        };
        if !matches_managed && !matches_original {
            conflicts.push(path_to_string(&file.path));
        }
    }
    Ok(conflicts)
}

#[cfg(test)]
pub(crate) fn record_matches_original(record: &AgentModificationRecord) -> Result<bool, String> {
    for file in &record.files {
        let current = read_agent_bytes(&file.path)?;
        let matches = if file.existed_before {
            current.as_deref().map(sha256_bytes) == file.original_sha256
        } else {
            current.is_none()
        };
        if !matches {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
pub(crate) fn codex_record_needs_resync(
    record: &AgentModificationRecord,
    configured: bool,
    current_model: Option<&str>,
) -> Result<bool, String> {
    if !configured || current_model != Some(record.model.as_str()) {
        return Ok(true);
    }
    for file in record.files.iter().skip(1) {
        let current_sha256 = read_agent_bytes(&file.path)?.as_deref().map(sha256_bytes);
        if current_sha256.as_deref() != Some(file.managed_sha256.as_str()) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
pub(crate) fn inspect_agent_modification(
    client: AgentClient,
    home: &Path,
    port: u16,
    configured: bool,
    current_model: Option<&str>,
) -> AgentModificationInspection {
    let paths = agent_config_paths(client, home);
    let state_path = match agent_state_path(&paths) {
        Ok(path) => path,
        Err(_) => {
            return AgentModificationInspection {
                enabled: false,
                state: "inactive".to_string(),
                backup_available: false,
                applied_model: current_model.map(str::to_string),
                claude_desktop_model_mappings: None,
                warnings: Vec::new(),
            }
        }
    };

    if state_path.is_file() {
        return match load_agent_record(client, &paths) {
            Ok(Some(record)) => {
                let backup_available = record_backup_available(&record);
                let state = if record.phase != AGENT_PHASE_ACTIVE {
                    "recovery"
                } else if client == AgentClient::Codex {
                    "active"
                } else {
                    match record_conflict_files(&record) {
                        Ok(conflicts) if conflicts.is_empty() => "active",
                        Ok(_) => AGENT_MODIFICATION_STATE_CONFLICT,
                        Err(_) => "recovery",
                    }
                };
                let mut warnings = Vec::new();
                if !backup_available {
                    warnings.push("原配置备份不完整，恢复前请勿删除剩余备份文件".to_string());
                }
                if state == AGENT_MODIFICATION_STATE_CONFLICT {
                    warnings.push("配置已被其他程序修改，清除修改时需要确认是否恢复".to_string());
                } else if state == "recovery" {
                    warnings.push("上次配置操作未完整结束，可使用“清除修改”恢复原配置".to_string());
                } else if client == AgentClient::Codex
                    && codex_record_needs_resync(&record, configured, current_model).unwrap_or(true)
                {
                    warnings.push(
                        "Codex 受管配置已发生变化，将在下次更新或启动时自动重新同步".to_string(),
                    );
                }
                AgentModificationInspection {
                    enabled: true,
                    state: state.to_string(),
                    backup_available,
                    applied_model: Some(record.model),
                    claude_desktop_model_mappings: None,
                    warnings,
                }
            }
            Ok(None) => AgentModificationInspection {
                enabled: false,
                state: "inactive".to_string(),
                backup_available: false,
                applied_model: current_model.map(str::to_string),
                claude_desktop_model_mappings: None,
                warnings: Vec::new(),
            },
            Err(error) => AgentModificationInspection {
                enabled: true,
                state: "recovery".to_string(),
                backup_available: expected_agent_record_paths(client, &paths)
                    .iter()
                    .filter_map(|path| agent_backup_path(path).ok())
                    .any(|path| path.is_file()),
                applied_model: current_model.map(str::to_string),
                claude_desktop_model_mappings: None,
                warnings: vec![error],
            },
        };
    }

    if configured {
        if let Some(model) = current_model {
            match build_legacy_agent_record(client, home, port, model) {
                Ok(Some(record)) => {
                    return AgentModificationInspection {
                        enabled: true,
                        state: "active".to_string(),
                        backup_available: true,
                        applied_model: Some(record.model),
                        claude_desktop_model_mappings: None,
                        warnings: vec![
                            "检测到旧版 CPA 配置和备份，可使用“清除修改”恢复原配置".to_string()
                        ],
                    }
                }
                Ok(None) => {
                    return AgentModificationInspection {
                        enabled: false,
                        state: "inactive".to_string(),
                        backup_available: false,
                        applied_model: current_model.map(str::to_string),
                        claude_desktop_model_mappings: None,
                        warnings: vec!["检测到 CPA 配置，但缺少可安全恢复的原始备份".to_string()],
                    }
                }
                Err(error) => {
                    return AgentModificationInspection {
                        enabled: false,
                        state: "inactive".to_string(),
                        backup_available: false,
                        applied_model: current_model.map(str::to_string),
                        claude_desktop_model_mappings: None,
                        warnings: vec![error],
                    }
                }
            }
        }
    }

    AgentModificationInspection {
        enabled: false,
        state: "inactive".to_string(),
        backup_available: false,
        applied_model: current_model.map(str::to_string),
        claude_desktop_model_mappings: None,
        warnings: Vec::new(),
    }
}

#[cfg(test)]
pub(crate) fn fresh_agent_contents(
    client: AgentClient,
    port: u16,
    api_key: &str,
    model: &str,
) -> Result<Vec<String>, String> {
    let models = [AgentModelOption {
        name: model.to_string(),
        alias: None,
        is_alias: false,
        context_window: Some(200_000),
    }];
    fresh_agent_contents_with_oauth(
        client,
        port,
        api_key,
        model,
        AgentConfigurationOptions {
            models: &models,
            codex_catalog: None,
            oauth_configuration: false,
            remote_compaction: false,
            claude_code_model_mappings: None,
            claude_desktop_model_mappings: None,
        },
    )
}

pub(crate) fn fresh_agent_contents_with_oauth(
    client: AgentClient,
    port: u16,
    api_key: &str,
    model: &str,
    options: AgentConfigurationOptions<'_>,
) -> Result<Vec<String>, String> {
    let AgentConfigurationOptions {
        models,
        oauth_configuration,
        remote_compaction,
        claude_code_model_mappings,
        claude_desktop_model_mappings,
        ..
    } = options;
    let root_base = managed_core_loopback_origin(port);
    let openai_base = format!("{root_base}/v1");
    match client {
        AgentClient::ClaudeCode => Ok(vec![build_claude_agent_config(
            None,
            &root_base,
            api_key,
            model,
            models,
            claude_code_model_mappings,
        )?]),
        AgentClient::ClaudeDesktop => Ok(vec![
            build_claude_desktop_deployment_config(None)?,
            build_claude_desktop_deployment_config(None)?,
            build_claude_desktop_profile(
                None,
                &root_base,
                api_key,
                model,
                models,
                claude_desktop_model_mappings,
            )?,
            build_claude_desktop_meta(None)?,
        ]),
        AgentClient::Codex => Ok(vec![build_codex_agent_config_with_oauth(
            None,
            &openai_base,
            api_key,
            model,
            oauth_configuration,
            remote_compaction,
        )?]),
        AgentClient::OpenCode => Ok(vec![build_opencode_agent_config(
            None,
            &openai_base,
            api_key,
            model,
            models,
        )?]),
        AgentClient::OpenClaw => Ok(vec![build_openclaw_agent_config(
            None,
            &openai_base,
            api_key,
            model,
            models,
        )?]),
        AgentClient::Hermes => Ok(vec![build_hermes_agent_config(
            None,
            &openai_base,
            api_key,
            model,
            models,
        )?]),
        AgentClient::DeepSeekHarness => Ok(vec![
            build_deepseek_harness_settings(None, &openai_base, model, models)?,
            build_deepseek_harness_credentials(None, api_key)?,
        ]),
        AgentClient::ZCode => Ok(vec![
            build_zcode_agent_config(None, &root_base, api_key, model, models)?,
            build_zcode_cli_agent_config(None, &root_base, api_key, model, models)?,
        ]),
        AgentClient::KimiCode => Ok(vec![build_kimi_code_agent_config(
            None,
            &openai_base,
            api_key,
            model,
            models,
        )?]),
        AgentClient::GrokBuild => Ok(vec![build_grok_build_agent_config(
            None,
            &openai_base,
            api_key,
            model,
            models,
        )?]),
    }
}

#[cfg(test)]
pub(crate) fn agent_contents_equal(client: AgentClient, actual: &str, expected: &str) -> bool {
    match client {
        AgentClient::Codex => {
            normalize_codex_config_for_legacy_compare(actual)
                == normalize_codex_config_for_legacy_compare(expected)
        }
        AgentClient::KimiCode | AgentClient::GrokBuild => {
            toml::from_str::<toml::Value>(actual).ok()
                == toml::from_str::<toml::Value>(expected).ok()
        }
        AgentClient::OpenClaw => {
            json5::from_str::<serde_json::Value>(actual).ok()
                == json5::from_str::<serde_json::Value>(expected).ok()
        }
        AgentClient::Hermes => {
            serde_yaml::from_str::<serde_yaml::Value>(actual).ok()
                == serde_yaml::from_str::<serde_yaml::Value>(expected).ok()
        }
        AgentClient::DeepSeekHarness => {
            serde_norway::from_str::<serde_norway::Value>(actual).ok()
                == serde_norway::from_str::<serde_norway::Value>(expected).ok()
        }
        _ => {
            serde_json::from_str::<serde_json::Value>(actual).ok()
                == serde_json::from_str::<serde_json::Value>(expected).ok()
        }
    }
}

#[cfg(test)]
pub(crate) fn normalize_codex_config_for_legacy_compare(content: &str) -> Option<toml::Value> {
    let mut value = toml::from_str::<toml::Value>(content).ok()?;
    if value
        .get("model_catalog_json")
        .and_then(toml::Value::as_str)
        == Some(CODEX_MODEL_CATALOG_FILE)
    {
        value.as_table_mut()?.remove("model_catalog_json");
    }
    Some(value)
}

#[cfg(test)]
pub(crate) fn build_legacy_agent_record(
    client: AgentClient,
    home: &Path,
    port: u16,
    model: &str,
) -> Result<Option<AgentModificationRecord>, String> {
    let paths = agent_config_paths(client, home);
    let generated = fresh_agent_contents(client, port, DEFAULT_API_KEY, model)?;
    if generated.len() != paths.len() {
        return Ok(None);
    }
    let mut files = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let current = read_agent_bytes(path)?;
        let Some(current) = current else {
            return Ok(None);
        };
        let backup_path = agent_backup_path(path)?;
        let (existed_before, original_sha256) = if backup_path.is_file() {
            let backup = fs::read(&backup_path).map_err(|error| {
                format!(
                    "读取旧版智能体备份失败 {}: {error}",
                    path_to_string(&backup_path)
                )
            })?;
            (true, Some(sha256_bytes(&backup)))
        } else {
            let actual = String::from_utf8(current.clone())
                .map_err(|_| format!("智能体配置不是 UTF-8 文本: {}", path_to_string(path)))?;
            if !agent_contents_equal(client, &actual, &generated[index]) {
                return Ok(None);
            }
            (false, None)
        };
        files.push(AgentModificationFile {
            path: path.clone(),
            backup_path,
            existed_before,
            original_sha256,
            managed_sha256: sha256_bytes(&current),
        });
    }
    Ok(Some(AgentModificationRecord {
        version: AGENT_MODIFICATION_STATE_VERSION,
        client: client.id().to_string(),
        phase: AGENT_PHASE_ACTIVE.to_string(),
        model: model.to_string(),
        files,
    }))
}

#[cfg(test)]
pub(crate) fn prepare_agent_record(
    client: AgentClient,
    paths: &[PathBuf],
    model: &str,
    updates: &[AgentFileUpdate],
) -> Result<AgentModificationRecord, String> {
    if paths.len() != updates.len() {
        return Err("智能体配置更新文件数量不匹配".to_string());
    }
    let mut prepared = Vec::new();
    for (path, update) in paths.iter().zip(updates) {
        if path != &update.path {
            return Err("智能体配置更新路径不匹配".to_string());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("创建智能体配置目录失败 {}: {error}", path_to_string(parent))
            })?;
        }
        let backup_path = agent_backup_path(path)?;
        let current = read_agent_bytes(path)?;
        let previous_backup = if backup_path.exists() {
            if !backup_path.is_file() {
                return Err(format!(
                    "智能体备份路径不是文件: {}",
                    path_to_string(&backup_path)
                ));
            }
            Some(fs::read(&backup_path).map_err(|error| {
                format!(
                    "读取原有智能体备份失败 {}: {error}",
                    path_to_string(&backup_path)
                )
            })?)
        } else {
            None
        };

        prepared.push((
            path.clone(),
            backup_path,
            current,
            previous_backup,
            sha256_bytes(update.after.as_bytes()),
        ));
    }

    let backup_snapshots = prepared
        .iter()
        .map(|(_, backup_path, _, previous_backup, _)| {
            (backup_path.clone(), previous_backup.clone())
        })
        .collect::<Vec<_>>();
    let mut files = Vec::new();
    for (path, backup_path, current, _, managed_sha256) in prepared {
        let backup_result = if let Some(current) = current.as_deref() {
            write_bytes_atomically(&backup_path, current).and_then(|_| {
                let copied = fs::read(&backup_path).map_err(|error| {
                    format!(
                        "校验智能体备份失败 {}: {error}",
                        path_to_string(&backup_path)
                    )
                })?;
                if sha256_bytes(&copied) != sha256_bytes(current) {
                    return Err(format!("智能体备份校验失败: {}", path_to_string(&path)));
                }
                Ok(())
            })
        } else if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| {
                format!(
                    "清理旧智能体备份失败 {}: {error}",
                    path_to_string(&backup_path)
                )
            })
        } else {
            Ok(())
        };
        if let Err(error) = backup_result {
            let rollback = restore_snapshots(&backup_snapshots);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}；恢复原有备份失败: {rollback_error}"),
            });
        }

        let existed_before = current.is_some();
        let original_sha256 = current.as_deref().map(sha256_bytes);
        files.push(AgentModificationFile {
            path,
            backup_path,
            existed_before,
            original_sha256,
            managed_sha256,
        });
    }
    Ok(AgentModificationRecord {
        version: AGENT_MODIFICATION_STATE_VERSION,
        client: client.id().to_string(),
        phase: AGENT_PHASE_APPLYING.to_string(),
        model: model.to_string(),
        files,
    })
}

#[cfg(test)]
pub(crate) fn extend_agent_record_for_updates(
    record: &AgentModificationRecord,
    updates: &[AgentFileUpdate],
) -> Result<AgentRecordExtension, String> {
    if record.files.len() > updates.len() {
        return Err("智能体配置更新文件数量不匹配".to_string());
    }
    for (file, update) in record.files.iter().zip(updates) {
        if file.path != update.path {
            return Err("智能体配置更新路径不匹配".to_string());
        }
    }
    if record.files.len() == updates.len() {
        return Ok((record.clone(), Vec::new()));
    }

    let mut prepared = Vec::new();
    for update in updates.iter().skip(record.files.len()) {
        if let Some(parent) = update.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("创建智能体配置目录失败 {}: {error}", path_to_string(parent))
            })?;
        }
        let backup_path = agent_backup_path(&update.path)?;
        let previous_backup = if backup_path.exists() {
            if !backup_path.is_file() {
                return Err(format!(
                    "智能体备份路径不是文件: {}",
                    path_to_string(&backup_path)
                ));
            }
            Some(fs::read(&backup_path).map_err(|error| {
                format!(
                    "读取原有智能体备份失败 {}: {error}",
                    path_to_string(&backup_path)
                )
            })?)
        } else {
            None
        };
        let current = read_agent_bytes(&update.path)?;
        prepared.push((update, backup_path, previous_backup, current));
    }

    let backup_snapshots = prepared
        .iter()
        .map(|(_, backup_path, previous_backup, _)| (backup_path.clone(), previous_backup.clone()))
        .collect::<Vec<_>>();
    let mut next = record.clone();
    for (update, backup_path, _, current) in prepared {
        let backup_result = if let Some(current) = current.as_deref() {
            write_bytes_atomically(&backup_path, current).and_then(|_| {
                let copied = fs::read(&backup_path).map_err(|error| {
                    format!(
                        "校验智能体备份失败 {}: {error}",
                        path_to_string(&backup_path)
                    )
                })?;
                if sha256_bytes(&copied) != sha256_bytes(current) {
                    return Err(format!(
                        "智能体备份校验失败: {}",
                        path_to_string(&update.path)
                    ));
                }
                Ok(())
            })
        } else if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| {
                format!(
                    "清理旧智能体备份失败 {}: {error}",
                    path_to_string(&backup_path)
                )
            })
        } else {
            Ok(())
        };
        if let Err(error) = backup_result {
            let rollback = restore_snapshots(&backup_snapshots);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}；恢复原有备份失败: {rollback_error}"),
            });
        }
        next.files.push(AgentModificationFile {
            path: update.path.clone(),
            backup_path,
            existed_before: current.is_some(),
            original_sha256: current.as_deref().map(sha256_bytes),
            managed_sha256: sha256_bytes(update.after.as_bytes()),
        });
    }
    Ok((next, backup_snapshots))
}

#[cfg(test)]
pub(crate) fn restore_snapshots(snapshots: &[FileSnapshot]) -> Result<(), String> {
    restore_snapshots_with_direct_path(snapshots, None)
}

#[cfg(test)]
pub(crate) fn write_agent_bytes(
    path: &Path,
    content: &[u8],
    direct_write_path: Option<&Path>,
) -> Result<(), String> {
    if direct_write_path == Some(path) {
        write_bytes_directly(path, content)
    } else {
        write_bytes_atomically(path, content)
    }
}

#[cfg(test)]
pub(crate) fn restore_snapshots_with_direct_path(
    snapshots: &[FileSnapshot],
    direct_write_path: Option<&Path>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for (path, bytes) in snapshots.iter().rev() {
        let result = match bytes {
            Some(bytes) => write_agent_bytes(path, bytes, direct_write_path),
            None if path.exists() => fs::remove_file(path)
                .map_err(|error| format!("删除配置失败 {}: {error}", path_to_string(path))),
            None => Ok(()),
        };
        if let Err(error) = result {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

#[cfg(test)]
pub(crate) fn apply_agent_file_replacements(
    replacements: &[(PathBuf, Option<Vec<u8>>)],
    direct_write_path: Option<&Path>,
) -> Result<Vec<String>, String> {
    let snapshots = replacements
        .iter()
        .map(|(path, _)| Ok((path.clone(), read_agent_bytes(path)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let mut changed = Vec::new();
    for (path, replacement) in replacements {
        let current = read_agent_bytes(path)?;
        let result = match replacement {
            Some(bytes) if current.as_deref() == Some(bytes.as_slice()) => Ok(()),
            Some(bytes) => {
                changed.push(path_to_string(path));
                write_agent_bytes(path, bytes, direct_write_path)
            }
            None if current.is_some() => {
                changed.push(path_to_string(path));
                fs::remove_file(path)
                    .map_err(|error| format!("删除配置失败 {}: {error}", path_to_string(path)))
            }
            None => Ok(()),
        };
        if let Err(error) = result {
            let rollback = restore_snapshots_with_direct_path(&snapshots, direct_write_path);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}；回滚失败: {rollback_error}"),
            });
        }
    }
    Ok(changed)
}

#[cfg(test)]
pub(crate) fn restore_codex_agent_record_files(
    record: &AgentModificationRecord,
) -> Result<Vec<String>, String> {
    let config_file = record
        .files
        .first()
        .ok_or_else(|| "Codex 配置状态缺少 config.toml".to_string())?;
    let current_config = read_agent_bytes(&config_file.path)?
        .map(|bytes| {
            String::from_utf8(bytes).map_err(|_| {
                format!(
                    "当前 Codex 配置不是 UTF-8 文本: {}",
                    path_to_string(&config_file.path)
                )
            })
        })
        .transpose()?;
    let original_config = read_agent_original_text(config_file)?;
    let restored_config =
        build_restored_codex_agent_config(current_config.as_deref(), original_config.as_deref())?;

    let mut replacements = vec![(
        config_file.path.clone(),
        restored_config.map(String::into_bytes),
    )];
    for file in record.files.iter().skip(1) {
        replacements.push((file.path.clone(), read_agent_original_bytes(file)?));
    }
    apply_agent_file_replacements(&replacements, Some(&config_file.path))
}

#[cfg(test)]
pub(crate) fn apply_agent_updates(
    client: AgentClient,
    updates: &[AgentFileUpdate],
) -> Result<Vec<String>, String> {
    let direct_write_path = if client == AgentClient::Codex {
        updates.first().map(|update| update.path.as_path())
    } else {
        None
    };
    let snapshots = updates
        .iter()
        .map(|update| Ok((update.path.clone(), read_agent_bytes(&update.path)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let mut changed = Vec::new();
    for update in updates {
        let next = update.after.as_bytes();
        if read_agent_bytes(&update.path)?.as_deref() == Some(next) {
            continue;
        }
        if let Err(error) = write_agent_bytes(&update.path, next, direct_write_path) {
            let rollback = restore_snapshots_with_direct_path(&snapshots, direct_write_path);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}；回滚失败: {rollback_error}"),
            });
        }
        changed.push(path_to_string(&update.path));
    }
    Ok(changed)
}

pub(crate) fn restore_agent_snapshots_direct(snapshots: &[FileSnapshot]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (path, content) in snapshots.iter().rev() {
        let result = match content {
            Some(content) => write_bytes_directly(path, content),
            None if path.exists() => fs::remove_file(path)
                .map_err(|error| format!("删除新建配置失败 {}: {error}", path_to_string(path))),
            None => Ok(()),
        };
        if let Err(error) = result {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

pub(crate) fn dated_agent_backup_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("智能体配置文件名无效: {}", path_to_string(path)))?;
    let date = chrono::Local::now().format("%y-%m-%d");
    Ok(path.with_file_name(format!("{file_name}.{date}.bak")))
}

pub(crate) fn prepare_agent_session_backups(
    client: AgentClient,
    updates: &[AgentFileUpdate],
) -> Result<Vec<AgentAppliedBackupFile>, String> {
    let mut backups: Vec<AgentAppliedBackupFile> = Vec::with_capacity(updates.len());
    let mut renamed = Vec::new();
    for update in updates {
        let existed_before = update.path.is_file();
        let backup_path = dated_agent_backup_path(&update.path)?;
        if existed_before {
            if backup_path.exists() {
                if client == AgentClient::DeepSeekHarness {
                    for backup in &backups {
                        if backup.existed_before {
                            let _ = fs::remove_file(&backup.backup_path);
                        }
                    }
                }
                for (path, backup) in renamed.iter().rev() {
                    let _ = fs::rename(backup, path);
                }
                return Err(format!(
                    "智能体备份文件已存在，无法覆盖: {}",
                    path_to_string(&backup_path)
                ));
            }
            if client == AgentClient::DeepSeekHarness {
                if let Err(error) = fs::copy(&update.path, &backup_path) {
                    for backup in &backups {
                        if backup.existed_before {
                            let _ = fs::remove_file(&backup.backup_path);
                        }
                    }
                    return Err(format!(
                        "备份 DeepSeek Harness 配置失败 {}: {error}",
                        path_to_string(&update.path)
                    ));
                }
            } else {
                fs::rename(&update.path, &backup_path).map_err(|error| {
                    format!(
                        "重命名原智能体配置为备份失败 {}: {error}",
                        path_to_string(&update.path)
                    )
                })?;
                renamed.push((update.path.clone(), backup_path.clone()));
            }
        }
        backups.push(AgentAppliedBackupFile {
            path: update.path.clone(),
            backup_path,
            existed_before,
        });
    }
    Ok(backups)
}

pub(crate) fn restore_agent_session_configuration(
    client: AgentClient,
    home: &Path,
) -> Result<(), String> {
    let paths = agent_config_paths(client, home);
    let state_path = agent_state_path(&paths)?;
    let Some(state) = load_agent_applied_state(client, home)? else {
        return Ok(());
    };
    restore_agent_applied_state_configuration(client, &paths, &state_path, &state)
}

pub(crate) fn restore_agent_applied_state_configuration(
    client: AgentClient,
    paths: &[PathBuf],
    state_path: &Path,
    state: &AgentAppliedState,
) -> Result<(), String> {
    validate_agent_applied_state(client, paths, state)?;
    if state.backup_files.is_empty() {
        if agent_has_managed_marker(client, paths)? {
            remove_agent_managed_configuration(client, paths)?;
        }
    } else {
        let originals = state
            .backup_files
            .iter()
            .map(|file| {
                if file.existed_before {
                    fs::read(&file.backup_path).map(Some).map_err(|error| {
                        format!(
                            "读取智能体备份失败 {}: {error}",
                            path_to_string(&file.backup_path)
                        )
                    })
                } else {
                    Ok(None)
                }
            })
            .collect::<Result<Vec<_>, String>>()?;
        let snapshots = state
            .backup_files
            .iter()
            .map(|file| Ok((file.path.clone(), read_agent_bytes(&file.path)?)))
            .collect::<Result<Vec<_>, String>>()?;
        let replacements = state
            .backup_files
            .iter()
            .zip(&originals)
            .zip(&snapshots)
            .map(|((file, original), (_, current))| {
                build_agent_session_restored_bytes(
                    client,
                    paths,
                    &file.path,
                    current.as_deref(),
                    original.as_deref(),
                )
            })
            .collect::<Result<Vec<_>, String>>()?;
        let restore_result = (|| -> Result<(), String> {
            for (file, replacement) in state.backup_files.iter().zip(&replacements).rev() {
                if let Some(replacement) = replacement {
                    write_agent_configuration_file(client, &file.path, replacement)?;
                } else if file.path.exists() {
                    fs::remove_file(&file.path).map_err(|error| {
                        format!(
                            "删除临时智能体配置失败 {}: {error}",
                            path_to_string(&file.path)
                        )
                    })?;
                }
            }
            Ok(())
        })();
        if let Err(error) = restore_result {
            return match restore_agent_snapshots_direct(&snapshots) {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(format!("{error}；回滚恢复操作失败: {rollback_error}")),
            };
        }
        for file in &state.backup_files {
            if file.existed_before && file.backup_path.is_file() {
                fs::remove_file(&file.backup_path).map_err(|error| {
                    format!(
                        "清理智能体备份失败 {}: {error}",
                        path_to_string(&file.backup_path)
                    )
                })?;
            }
        }
    }
    if client == AgentClient::Codex {
        clear_codex_applied_state(state_path)?;
    }
    if state_path.is_file() {
        fs::remove_file(state_path).map_err(|error| {
            format!(
                "清理智能体应用状态失败 {}: {error}",
                path_to_string(state_path)
            )
        })?;
    }
    Ok(())
}

pub(crate) fn commit_agent_configuration(
    client: AgentClient,
    home: &Path,
    model: &str,
    updates: &[AgentFileUpdate],
    outcome: &str,
    claude_desktop_model_mappings: Option<&ClaudeDesktopModelMappings>,
) -> Result<AgentConfigActionResult, String> {
    let base_paths = agent_config_paths(client, home);
    let state_path = agent_state_path(&base_paths)?;
    let existing_state = load_agent_applied_state(client, home)?;
    let previous_state = read_agent_bytes(&state_path)?;
    let mut legacy_backups = previous_state
        .as_deref()
        .and_then(|content| std::str::from_utf8(content).ok())
        .map(legacy_agent_backup_paths)
        .unwrap_or_default();
    legacy_backups.extend(
        expected_agent_record_paths(client, &base_paths)
            .iter()
            .filter_map(|path| agent_backup_path(path).ok()),
    );
    legacy_backups.sort();
    legacy_backups.dedup();

    let mut snapshots = updates
        .iter()
        .map(|update| Ok((update.path.clone(), read_agent_bytes(&update.path)?)))
        .collect::<Result<Vec<_>, String>>()?;
    snapshots.push((state_path.clone(), previous_state));

    let mut created_backup_paths = Vec::new();
    let backup_files =
        if let Some(state) = existing_state.filter(|state| !state.backup_files.is_empty()) {
            let mut backup_files = state.backup_files;
            let missing_updates = updates
                .iter()
                .filter(|update| !backup_files.iter().any(|file| file.path == update.path))
                .map(|update| AgentFileUpdate {
                    path: update.path.clone(),
                    after: update.after.clone(),
                })
                .collect::<Vec<_>>();
            let added_backups = prepare_agent_session_backups(client, &missing_updates)?;
            created_backup_paths.extend(
                added_backups
                    .iter()
                    .filter(|file| file.existed_before)
                    .map(|file| file.backup_path.clone()),
            );
            backup_files.extend(added_backups);
            backup_files
        } else {
            let backup_files = prepare_agent_session_backups(client, updates)?;
            created_backup_paths.extend(
                backup_files
                    .iter()
                    .filter(|file| file.existed_before)
                    .map(|file| file.backup_path.clone()),
            );
            backup_files
        };

    let transaction = (|| -> Result<Vec<String>, String> {
        let mut changed = Vec::new();
        for update in updates {
            let next = update.after.as_bytes();
            if read_agent_bytes(&update.path)?.as_deref() == Some(next) {
                continue;
            }
            write_agent_configuration_file(client, &update.path, next)?;
            changed.push(path_to_string(&update.path));
        }
        let state = AgentAppliedState {
            version: AGENT_APPLIED_STATE_VERSION,
            client: client.id().to_string(),
            model: model.to_string(),
            configuration_revision: AGENT_CONFIGURATION_REVISION,
            claude_desktop_model_mappings: (client == AgentClient::ClaudeDesktop)
                .then(|| claude_desktop_model_mappings.cloned())
                .flatten(),
            backup_files: backup_files.clone(),
            updated_at_unix: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        };
        write_agent_applied_state(&state_path, &state)?;
        Ok(changed)
    })();

    match transaction {
        Ok(changed) => {
            for backup_path in legacy_backups {
                if backup_path.is_file() {
                    let _ = fs::remove_file(backup_path);
                }
            }
            Ok(action_result(
                outcome,
                true,
                Some(model.to_string()),
                changed,
                Vec::new(),
            ))
        }
        Err(error) => {
            let rollback = restore_agent_snapshots_direct(&snapshots);
            for backup_path in created_backup_paths {
                if backup_path.is_file() {
                    let _ = fs::remove_file(backup_path);
                }
            }
            match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(format!("{error}；回滚配置失败: {rollback_error}")),
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn apply_agent_configuration(
    client: AgentClient,
    home: &Path,
    port: u16,
    api_key: &str,
    model: &str,
    models: &[AgentModelOption],
    codex_catalog: Option<&str>,
) -> Result<AgentConfigActionResult, String> {
    apply_agent_configuration_with_oauth(
        client,
        home,
        port,
        api_key,
        model,
        AgentConfigurationOptions {
            models,
            codex_catalog,
            oauth_configuration: false,
            remote_compaction: false,
            claude_code_model_mappings: None,
            claude_desktop_model_mappings: None,
        },
    )
}

pub(crate) fn apply_agent_configuration_with_oauth(
    client: AgentClient,
    home: &Path,
    port: u16,
    api_key: &str,
    model: &str,
    options: AgentConfigurationOptions<'_>,
) -> Result<AgentConfigActionResult, String> {
    let claude_desktop_model_mappings = options.claude_desktop_model_mappings;
    let updates = build_agent_updates_with_oauth(client, home, port, api_key, model, options)?;
    commit_agent_configuration(
        client,
        home,
        model,
        &updates,
        "applied",
        claude_desktop_model_mappings,
    )
}

#[cfg(test)]
pub(crate) fn reset_agent_configuration_to_default(
    client: AgentClient,
    home: &Path,
    port: u16,
    api_key: &str,
    model: &str,
    codex_catalog: Option<&str>,
) -> Result<AgentConfigActionResult, String> {
    reset_agent_configuration_to_default_with_oauth(AgentDefaultConfiguration {
        client,
        home,
        port,
        api_key,
        model,
        models: &[AgentModelOption {
            name: model.to_string(),
            alias: None,
            is_alias: false,
            context_window: Some(200_000),
        }],
        codex_catalog,
        oauth_configuration: false,
        remote_compaction: false,
        claude_code_model_mappings: None,
        claude_desktop_model_mappings: None,
    })
}

pub(crate) struct AgentDefaultConfiguration<'a> {
    pub(crate) client: AgentClient,
    pub(crate) home: &'a Path,
    pub(crate) port: u16,
    pub(crate) api_key: &'a str,
    pub(crate) model: &'a str,
    pub(crate) models: &'a [AgentModelOption],
    pub(crate) codex_catalog: Option<&'a str>,
    pub(crate) oauth_configuration: bool,
    pub(crate) remote_compaction: bool,
    pub(crate) claude_code_model_mappings: Option<&'a ClaudeDesktopModelMappings>,
    pub(crate) claude_desktop_model_mappings: Option<&'a ClaudeDesktopModelMappings>,
}

pub(crate) fn reset_agent_configuration_to_default_with_oauth(
    request: AgentDefaultConfiguration<'_>,
) -> Result<AgentConfigActionResult, String> {
    let AgentDefaultConfiguration {
        client,
        home,
        port,
        api_key,
        model,
        models,
        codex_catalog,
        oauth_configuration,
        remote_compaction,
        claude_code_model_mappings,
        claude_desktop_model_mappings,
    } = request;
    if client == AgentClient::DeepSeekHarness {
        let updates = build_agent_updates_with_oauth(
            client,
            home,
            port,
            api_key,
            model,
            AgentConfigurationOptions {
                models,
                codex_catalog,
                oauth_configuration,
                remote_compaction,
                claude_code_model_mappings,
                claude_desktop_model_mappings,
            },
        )?;
        return commit_agent_configuration(
            client,
            home,
            model,
            &updates,
            "default",
            claude_desktop_model_mappings,
        );
    }
    let paths = agent_config_paths(client, home);
    let contents = fresh_agent_contents_with_oauth(
        client,
        port,
        api_key,
        model,
        AgentConfigurationOptions {
            models,
            codex_catalog,
            oauth_configuration,
            remote_compaction,
            claude_code_model_mappings,
            claude_desktop_model_mappings,
        },
    )?;
    if paths.len() != contents.len() {
        return Err("智能体默认配置文件数量不匹配".to_string());
    }
    let mut updates = paths
        .into_iter()
        .zip(contents)
        .map(|(path, after)| AgentFileUpdate { path, after })
        .collect::<Vec<_>>();
    if client == AgentClient::Codex {
        let catalog = codex_catalog.ok_or_else(|| "无法生成 Codex 模型目录".to_string())?;
        validate_codex_catalog(catalog, model)?;
        updates.push(AgentFileUpdate {
            path: codex_model_catalog_path(home),
            after: catalog.to_string(),
        });
        updates.push(build_codex_auth_update(home, api_key, oauth_configuration)?);
    }
    commit_agent_configuration(
        client,
        home,
        model,
        &updates,
        "default",
        claude_desktop_model_mappings,
    )
}

#[cfg(test)]
pub(crate) fn restore_agent_record_files(
    client: AgentClient,
    record: &AgentModificationRecord,
) -> Result<Vec<String>, String> {
    let direct_write_path = if client == AgentClient::Codex {
        record.files.first().map(|file| file.path.as_path())
    } else {
        None
    };
    let snapshots = record
        .files
        .iter()
        .map(|file| Ok((file.path.clone(), read_agent_bytes(&file.path)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let mut changed = Vec::new();
    for file in &record.files {
        let result = if file.existed_before {
            let backup = fs::read(&file.backup_path).map_err(|error| {
                format!(
                    "读取原配置备份失败 {}: {error}",
                    path_to_string(&file.backup_path)
                )
            })?;
            if Some(sha256_bytes(&backup)) != file.original_sha256 {
                return Err(format!(
                    "原配置备份校验失败: {}",
                    path_to_string(&file.backup_path)
                ));
            }
            if read_agent_bytes(&file.path)?.as_deref() == Some(backup.as_slice()) {
                Ok(())
            } else {
                changed.push(path_to_string(&file.path));
                write_agent_bytes(&file.path, &backup, direct_write_path)
            }
        } else if file.path.exists() {
            changed.push(path_to_string(&file.path));
            fs::remove_file(&file.path).map_err(|error| {
                format!("删除智能体配置失败 {}: {error}", path_to_string(&file.path))
            })
        } else {
            Ok(())
        };
        if let Err(error) = result {
            let rollback = restore_snapshots_with_direct_path(&snapshots, direct_write_path);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}；回滚失败: {rollback_error}"),
            });
        }
    }
    Ok(changed)
}

#[cfg(test)]
pub(crate) fn discard_prepared_agent_backups(
    record: &AgentModificationRecord,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for file in &record.files {
        if file.backup_path.exists() {
            if let Err(error) = fs::remove_file(&file.backup_path) {
                errors.push(format!(
                    "删除未启用的智能体备份失败 {}: {error}",
                    path_to_string(&file.backup_path)
                ));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

#[cfg(test)]
pub(crate) fn cleanup_agent_record(
    state_path: &Path,
    record: &AgentModificationRecord,
) -> Result<(), String> {
    if state_path.exists() {
        fs::remove_file(state_path).map_err(|error| {
            format!(
                "删除智能体备份状态失败 {}: {error}",
                path_to_string(state_path)
            )
        })?;
    }
    for file in &record.files {
        if file.backup_path.exists() {
            if let Err(error) = fs::remove_file(&file.backup_path) {
                eprintln!(
                    "清理智能体备份失败 {}: {error}",
                    path_to_string(&file.backup_path)
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn action_result(
    outcome: &str,
    enabled: bool,
    model: Option<String>,
    changed_files: Vec<String>,
    conflict_files: Vec<String>,
) -> AgentConfigActionResult {
    AgentConfigActionResult {
        outcome: outcome.to_string(),
        enabled,
        model,
        changed_files,
        conflict_files,
    }
}

#[cfg(test)]
pub(crate) fn enable_agent_modification(
    client: AgentClient,
    home: &Path,
    port: u16,
    model: &str,
    models: &[AgentModelOption],
    codex_catalog: Option<&str>,
) -> Result<AgentConfigActionResult, String> {
    let paths = agent_config_paths(client, home);
    let state_path = agent_state_path(&paths)?;
    if let Some(record) = load_agent_record(client, &paths)? {
        write_agent_state(&state_path, &record)?;
        return Ok(action_result(
            "enabled",
            true,
            Some(record.model),
            Vec::new(),
            Vec::new(),
        ));
    }
    let (_, current_model, _, _) =
        inspect_agent_managed_config(client, &paths, port, DEFAULT_API_KEY)?;
    if agent_has_managed_marker(client, &paths)? {
        if let Some(current_model) = current_model.as_deref() {
            if let Some(record) = build_legacy_agent_record(client, home, port, current_model)? {
                write_agent_state(&state_path, &record)?;
                return Ok(action_result(
                    "enabled",
                    true,
                    Some(record.model),
                    Vec::new(),
                    Vec::new(),
                ));
            }
        }
        return Err(
            "检测到 CPA 配置，但缺少可安全恢复的原始备份；请先手动恢复客户端配置".to_string(),
        );
    }

    let updates = build_agent_updates(
        client,
        home,
        port,
        DEFAULT_API_KEY,
        model,
        models,
        codex_catalog,
    )?;
    let update_paths = updates
        .iter()
        .map(|update| update.path.clone())
        .collect::<Vec<_>>();
    let mut record = prepare_agent_record(client, &update_paths, model, &updates)?;
    if let Err(error) = write_agent_state(&state_path, &record) {
        let cleanup = discard_prepared_agent_backups(&record);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup_error) => format!("{error}；{cleanup_error}"),
        });
    }
    match apply_agent_updates(client, &updates) {
        Ok(changed) => {
            record.phase = AGENT_PHASE_ACTIVE.to_string();
            write_agent_state(&state_path, &record)?;
            Ok(action_result(
                "enabled",
                true,
                Some(model.to_string()),
                changed,
                Vec::new(),
            ))
        }
        Err(error) => match restore_agent_record_files(client, &record) {
            Ok(_) => {
                let _ = cleanup_agent_record(&state_path, &record);
                Err(error)
            }
            Err(restore_error) => {
                record.phase = AGENT_PHASE_RECOVERY.to_string();
                let _ = write_agent_state(&state_path, &record);
                Err(format!("{error}；恢复原配置失败: {restore_error}"))
            }
        },
    }
}

#[cfg(test)]
pub(crate) fn disable_agent_modification(
    client: AgentClient,
    home: &Path,
    port: u16,
    force_restore: bool,
) -> Result<AgentConfigActionResult, String> {
    let paths = agent_config_paths(client, home);
    let state_path = agent_state_path(&paths)?;
    let mut record = match load_agent_record(client, &paths)? {
        Some(record) => record,
        None => {
            let (_, model, _, _) =
                inspect_agent_managed_config(client, &paths, port, DEFAULT_API_KEY)?;
            if !agent_has_managed_marker(client, &paths)? {
                return Ok(action_result(
                    "disabled",
                    false,
                    None,
                    Vec::new(),
                    Vec::new(),
                ));
            }
            let model = model.ok_or_else(|| "无法识别当前 CPA 模型".to_string())?;
            let record = build_legacy_agent_record(client, home, port, &model)?
                .ok_or_else(|| "检测到 CPA 配置，但缺少可安全恢复的原始备份".to_string())?;
            write_agent_state(&state_path, &record)?;
            record
        }
    };

    if client == AgentClient::Codex {
        record.phase = AGENT_PHASE_RESTORING.to_string();
        write_agent_state(&state_path, &record)?;
        return match restore_codex_agent_record_files(&record) {
            Ok(changed) => {
                cleanup_agent_record(&state_path, &record)?;
                Ok(action_result("disabled", false, None, changed, Vec::new()))
            }
            Err(error) => {
                record.phase = AGENT_PHASE_RECOVERY.to_string();
                let _ = write_agent_state(&state_path, &record);
                Err(format!("恢复原配置失败: {error}"))
            }
        };
    }

    if record_matches_original(&record)? {
        cleanup_agent_record(&state_path, &record)?;
        return Ok(action_result(
            "disabled",
            false,
            None,
            Vec::new(),
            Vec::new(),
        ));
    }

    let conflicts = record_restore_conflict_files(&record)?;
    if !conflicts.is_empty() && !force_restore {
        return Ok(action_result(
            "restore-conflict",
            true,
            Some(record.model),
            Vec::new(),
            conflicts,
        ));
    }

    record.phase = AGENT_PHASE_RESTORING.to_string();
    write_agent_state(&state_path, &record)?;
    match restore_agent_record_files(client, &record) {
        Ok(changed) => {
            cleanup_agent_record(&state_path, &record)?;
            Ok(action_result("disabled", false, None, changed, Vec::new()))
        }
        Err(error) => {
            record.phase = AGENT_PHASE_RECOVERY.to_string();
            let _ = write_agent_state(&state_path, &record);
            Err(format!("恢复原配置失败: {error}"))
        }
    }
}

#[cfg(test)]
pub(crate) fn update_agent_modification(
    client: AgentClient,
    home: &Path,
    port: u16,
    model: &str,
    models: &[AgentModelOption],
    codex_catalog: Option<&str>,
) -> Result<AgentConfigActionResult, String> {
    let paths = agent_config_paths(client, home);
    let state_path = agent_state_path(&paths)?;
    let record = match load_agent_record(client, &paths)? {
        Some(record) => record,
        None => {
            let (_, current_model, _, _) =
                inspect_agent_managed_config(client, &paths, port, DEFAULT_API_KEY)?;
            if !agent_has_managed_marker(client, &paths)? {
                return Err("请先应用配置修改".to_string());
            }
            let current_model = current_model.ok_or_else(|| "无法识别当前 CPA 模型".to_string())?;
            let record = build_legacy_agent_record(client, home, port, &current_model)?
                .ok_or_else(|| "缺少原配置备份，无法安全更新".to_string())?;
            write_agent_state(&state_path, &record)?;
            record
        }
    };
    if record.phase != AGENT_PHASE_ACTIVE {
        return Err("上次配置操作尚未完整结束，请先使用“清除修改”恢复原配置".to_string());
    }
    if client != AgentClient::Codex {
        let conflicts = record_conflict_files(&record)?;
        if !conflicts.is_empty() {
            return Err(format!(
                "配置已被其他程序修改，无法更新: {}",
                conflicts.join("、")
            ));
        }
    }

    let updates = build_agent_updates(
        client,
        home,
        port,
        DEFAULT_API_KEY,
        model,
        models,
        codex_catalog,
    )?;
    let (mut next, backup_snapshots) = extend_agent_record_for_updates(&record, &updates)?;
    next.phase = AGENT_PHASE_APPLYING.to_string();
    next.model = model.to_string();
    for (file, update) in next.files.iter_mut().zip(&updates) {
        if file.path != update.path {
            return Err("智能体配置更新路径不匹配".to_string());
        }
        file.managed_sha256 = sha256_bytes(update.after.as_bytes());
    }
    if let Err(error) = write_agent_state(&state_path, &next) {
        let rollback = restore_snapshots(&backup_snapshots);
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => format!("{error}；恢复模型目录备份失败: {rollback_error}"),
        });
    }
    match apply_agent_updates(client, &updates) {
        Ok(changed) => {
            next.phase = AGENT_PHASE_ACTIVE.to_string();
            write_agent_state(&state_path, &next)?;
            Ok(action_result(
                "updated",
                true,
                Some(model.to_string()),
                changed,
                Vec::new(),
            ))
        }
        Err(error) => {
            let state_rollback = write_agent_state(&state_path, &record).err();
            let backup_rollback = restore_snapshots(&backup_snapshots).err();
            let mut errors = vec![error];
            if let Some(rollback_error) = state_rollback {
                errors.push(format!("恢复原状态失败: {rollback_error}"));
            }
            if let Some(rollback_error) = backup_rollback {
                errors.push(format!("恢复模型目录备份失败: {rollback_error}"));
            }
            Err(errors.join("；"))
        }
    }
}
