//! Explicit, immutable backups. Legacy history and dated backups are never read or migrated.
use super::*;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

mod restore;
pub(crate) use restore::*;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
    hash: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupVersion {
    version: u8,
    id: String,
    client: String,
    created_at: String,
    files: Vec<BackupFile>,
    mappings: Option<ClaudeDesktopModelMappings>,
}

#[derive(Serialize, Deserialize)]
struct BackupPackage {
    payload: BackupVersion,
    checksum: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupFileSummary {
    path: String,
    exists: Option<bool>,
    size: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupSummary {
    pub(crate) id: String,
    created_at: Option<String>,
    file_count: usize,
    location: String,
    files: Vec<BackupFileSummary>,
    restorable: bool,
    error: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct BackupList {
    versions: Vec<BackupSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupDifference {
    pub(crate) file: String,
    pub(crate) field: String,
    pub(crate) before: String,
    pub(crate) after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupPreview {
    pub(crate) revision: String,
    pub(crate) files: Vec<BackupFileSummary>,
    pub(crate) differences: Vec<BackupDifference>,
}

pub(crate) fn agent_data_directory(paths: &[PathBuf]) -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        // Tests cannot reach the running application's data or real client configuration.
        let temp = std::env::temp_dir();
        let relative = paths
            .first()
            .ok_or("没有配置路径")?
            .strip_prefix(&temp)
            .map_err(|_| "测试配置必须位于临时目录")?;
        let directory = temp.join(
            relative
                .components()
                .next()
                .ok_or("缺少测试目录")?
                .as_os_str(),
        );
        assert!(paths.iter().all(|p| p.starts_with(&directory)));
        return Ok(directory.join("cpa-data"));
    }
    #[cfg(not(test))]
    {
        let _ = paths;
        core_base_dir()
    }
}

fn path_identity(paths: &[PathBuf]) -> String {
    sha256_bytes(&serde_json::to_vec(paths).expect("paths serialize"))
}

fn backup_directory(client: &str, paths: &[PathBuf]) -> Result<PathBuf, String> {
    // Only client IDs returned by config_paths reach here; validate again for internal callers.
    if client != PI_AGENT_ID {
        AgentClient::parse(client)?;
    }
    Ok(agent_data_directory(paths)?
        .join("backups/agents")
        .join(client)
        .join(path_identity(paths)))
}

fn valid_version_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(|c| c.is_ascii_digit() || c == b'-')
}

fn version_path(client: &str, paths: &[PathBuf], id: &str) -> Result<PathBuf, String> {
    if !valid_version_id(id) {
        return Err("备份版本编号无效".into());
    }
    Ok(backup_directory(client, paths)?.join(format!("{id}.json")))
}

fn make_version(client: &str, paths: &[PathBuf], images: &Images) -> BackupVersion {
    let now = chrono::Utc::now();
    BackupVersion {
        version: 1,
        id: format!(
            "{}-{}-{}",
            now.format("%Y%m%d%H%M%S%f"),
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ),
        client: client.into(),
        created_at: now.to_rfc3339(),
        files: images
            .iter()
            .map(|(path, bytes)| BackupFile {
                path: path.clone(),
                bytes: bytes.clone(),
                hash: image_hash(bytes.as_deref()),
            })
            .collect(),
        mappings: if client == "claude-desktop" {
            matching_desktop_mappings(paths, images)
        } else {
            None
        },
    }
}

fn write_version(paths: &[PathBuf], version: &BackupVersion) -> Result<(), String> {
    let path = version_path(&version.client, paths, &version.id)?;
    validate_config_path(&path)?;
    let parent = path.parent().ok_or("备份目录无效")?;
    fs::create_dir_all(parent).map_err(|_| "创建手动备份目录失败")?;
    validate_config_path(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| "设置备份目录权限失败")?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let payload = serde_json::to_vec(version).map_err(|_| "生成备份失败")?;
    let package = BackupPackage {
        payload: version.clone(),
        checksum: sha256_bytes(&payload),
    };
    let bytes = serde_json::to_vec(&package).map_err(|_| "生成备份失败")?;
    let mut file = options
        .open(&path)
        .map_err(|_| "创建手动备份失败，请检查备份目录权限")?;
    if file
        .write_all(&bytes)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err("保存手动备份失败".into());
    }
    drop(file);
    if fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
        let _ = fs::remove_file(&path);
        return Err("手动备份写后校验失败".into());
    }
    Ok(())
}

fn read_version(client: &str, paths: &[PathBuf], id: &str) -> Result<BackupVersion, String> {
    let path = version_path(client, paths, id)?;
    let bytes = read_agent_bytes(&path)?.ok_or("备份文件缺失")?;
    let package: BackupPackage =
        serde_json::from_slice(&bytes).map_err(|_| "备份包损坏，无法恢复，可删除此版本")?;
    let version = package.payload;
    if package.checksum != sha256_bytes(&serde_json::to_vec(&version).map_err(|_| "备份校验失败")?)
        || version.version != 1
        || version.client != client
        || version.id != id
        || version.files.len() != paths.len()
        || version.files.iter().zip(paths).any(|(file, path)| {
            file.path != *path || file.hash != image_hash(file.bytes.as_deref())
        })
    {
        return Err("备份包路径或内容校验失败，无法恢复，可删除此版本".into());
    }
    Ok(version)
}

fn backup_images(version: &BackupVersion) -> Images {
    version
        .files
        .iter()
        .map(|f| (f.path.clone(), f.bytes.clone()))
        .collect()
}

fn validate_restorable(version: &BackupVersion) -> Result<(), String> {
    let images = backup_images(version);
    validate_client_config_images(&version.client, &images)
        .map_err(|_| "备份含有无法解析的配置，已保留原文但不可恢复".to_string())?;
    if version.client == "claude-desktop"
        && desktop_profile_needs_mapping(&images)?
        && version.mappings.is_none()
    {
        return Err("备份缺少可靠的 Claude Desktop 模型映射，请重新选择模型后创建备份".into());
    }
    Ok(())
}

fn file_summaries(images: &Images) -> Vec<BackupFileSummary> {
    images
        .iter()
        .map(|(path, bytes)| BackupFileSummary {
            path: path_to_string(path),
            exists: Some(bytes.is_some()),
            size: bytes.as_ref().map(Vec::len),
        })
        .collect()
}

fn backup_summary(client: &str, paths: &[PathBuf], id: &str) -> Result<BackupSummary, String> {
    let location = path_to_string(&version_path(client, paths, id)?);
    let (created_at, files, error) = match read_version(client, paths, id) {
        Ok(version) => (
            Some(version.created_at.clone()),
            file_summaries(&backup_images(&version)),
            validate_restorable(&version).err(),
        ),
        Err(error) => (
            None,
            paths
                .iter()
                .map(|p| BackupFileSummary {
                    path: path_to_string(p),
                    exists: None,
                    size: None,
                })
                .collect(),
            Some(error),
        ),
    };
    Ok(BackupSummary {
        id: id.into(),
        created_at,
        file_count: paths.len(),
        location,
        files,
        restorable: error.is_none(),
        error,
    })
}

pub(crate) fn create_backup(client: &str, home: &Path) -> Result<BackupSummary, String> {
    let paths = config_paths(client, home)?;
    let images = config_images(&paths)?;
    let state_revision = mapping_revision(client, &paths)?;
    let version = make_version(client, &paths, &images);
    if config_images(&paths)? != images || mapping_revision(client, &paths)? != state_revision {
        return Err("备份期间配置发生变化，请重试".into());
    }
    // Raw bytes are deliberately saved even if parsing fails.
    write_version(&paths, &version)?;
    backup_summary(client, &paths, &version.id)
}

pub(crate) fn list_backups(client: &str, home: &Path) -> Result<BackupList, String> {
    let paths = config_paths(client, home)?;
    let directory = backup_directory(client, &paths)?;
    validate_config_path(&directory.join(".path-check"))?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(BackupList {
                versions: Vec::new(),
            })
        }
        Err(_) => return Err("读取手动备份目录失败".into()),
    };
    let mut versions = Vec::new();
    for entry in entries {
        let path = entry.map_err(|_| "读取手动备份目录失败")?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(id) = path
            .file_stem()
            .and_then(|v| v.to_str())
            .filter(|id| valid_version_id(id))
        {
            versions.push(backup_summary(client, &paths, id)?);
        }
    }
    versions.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(BackupList { versions })
}

pub(crate) fn delete_backup(client: &str, home: &Path, id: &str) -> Result<(), String> {
    let paths = config_paths(client, home)?;
    let path = version_path(client, &paths, id)?;
    // Check parents, then unlink only this entry. A damaged or symlinked package can be deleted safely.
    validate_config_path(&path.parent().ok_or("备份目录无效")?.join(".path-check"))?;
    fs::remove_file(&path).map_err(|_| "删除手动备份失败，请刷新列表后重试".to_string())
}

fn preview(
    client: &str,
    paths: &[PathBuf],
    id: &str,
) -> Result<(BackupPreview, Images, Images), String> {
    let package = read_agent_bytes(&version_path(client, paths, id)?)?.ok_or("备份文件缺失")?;
    let version = read_version(client, paths, id)?;
    validate_restorable(&version)?;
    let current = config_images(paths)?;
    let after = backup_images(&version);
    // Entire package hash binds preview to bytes, existence, paths and Desktop mappings.
    if read_agent_bytes(&version_path(client, paths, id)?)?.as_deref() != Some(&package) {
        return Err("备份在预览期间发生变化，请重新预览".into());
    }
    let revision = sha256_bytes(
        format!(
            "{}:{}:{}",
            image_revision(&current),
            sha256_bytes(&package),
            mapping_revision(client, paths)?
        )
        .as_bytes(),
    );
    let mut differences = current
        .iter()
        .zip(&after)
        .filter(|((_, a), (_, b))| a != b)
        .map(|((path, bytes), (_, next))| BackupDifference {
            file: path_to_string(path),
            field: "file".into(),
            before: if bytes.is_some() {
                "present"
            } else {
                "missing"
            }
            .into(),
            after: if next.is_some() { "replace" } else { "remove" }.into(),
        })
        .collect::<Vec<_>>();
    if client == "claude-desktop" && matching_desktop_mappings(paths, &current) != version.mappings
    {
        differences.push(BackupDifference {
            file: path_to_string(&desktop_mapping_path(paths)?),
            field: "modelMappings".into(),
            before: "current".into(),
            after: "backup".into(),
        });
    }
    Ok((
        BackupPreview {
            revision,
            files: file_summaries(&after),
            differences,
        },
        current,
        after,
    ))
}

#[derive(Serialize, Deserialize)]
struct DesktopMappingState {
    version: u8,
    profile_models_hash: String,
    mappings: ClaudeDesktopModelMappings,
}

pub(crate) fn desktop_mapping_path(paths: &[PathBuf]) -> Result<PathBuf, String> {
    Ok(agent_data_directory(paths)?
        .join("agents/claude-desktop")
        .join(path_identity(paths))
        .join("current-mapping.json"))
}

fn profile_models_hash(images: &Images) -> Option<String> {
    let (path, bytes) = images.get(2)?;
    let profile = parse(path, text(bytes.as_deref()).ok()?).ok()?;
    Some(sha256_bytes(
        &serde_json::to_vec(profile.get("inferenceModels")?).ok()?,
    ))
}

pub(crate) fn desktop_mapping_bytes(
    images: &Images,
    mappings: Option<&ClaudeDesktopModelMappings>,
) -> Result<Option<Vec<u8>>, String> {
    mappings
        .map(|mappings| {
            let profile_models_hash =
                profile_models_hash(images).ok_or("Claude Desktop 模型配置无效")?;
            serde_json::to_vec(&DesktopMappingState {
                version: 1,
                profile_models_hash,
                mappings: mappings.clone(),
            })
            .map_err(|_| "生成当前模型映射失败".into())
        })
        .transpose()
}

pub(crate) fn matching_desktop_mappings(
    paths: &[PathBuf],
    images: &Images,
) -> Option<ClaudeDesktopModelMappings> {
    let raw = read_agent_bytes(&desktop_mapping_path(paths).ok()?).ok()??;
    let state: DesktopMappingState = serde_json::from_slice(&raw).ok()?;
    (state.version == 1 && Some(state.profile_models_hash) == profile_models_hash(images))
        .then_some(state.mappings)
}

pub(crate) fn current_desktop_mappings(home: &Path) -> Option<ClaudeDesktopModelMappings> {
    let paths = config_paths("claude-desktop", home).ok()?;
    matching_desktop_mappings(&paths, &config_images(&paths).ok()?)
}

pub(crate) fn mapping_revision(client: &str, paths: &[PathBuf]) -> Result<String, String> {
    if client != "claude-desktop" {
        return Ok(String::new());
    }
    Ok(image_hash(
        read_agent_bytes(&desktop_mapping_path(paths)?)?.as_deref(),
    ))
}

#[tauri::command]
pub(crate) fn create_agent_config_backup(
    app: tauri::AppHandle,
    client: String,
) -> Result<BackupSummary, String> {
    let home = app.path().home_dir().map_err(|_| "无法获取用户目录")?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "配置文件锁已损坏")?;
    create_backup(&client, &home)
}

#[tauri::command]
pub(crate) fn list_agent_config_backups(
    app: tauri::AppHandle,
    client: String,
) -> Result<BackupList, String> {
    let home = app.path().home_dir().map_err(|_| "无法获取用户目录")?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "配置文件锁已损坏")?;
    list_backups(&client, &home)
}

#[tauri::command]
pub(crate) fn delete_agent_config_backup(
    app: tauri::AppHandle,
    client: String,
    id: String,
) -> Result<(), String> {
    let home = app.path().home_dir().map_err(|_| "无法获取用户目录")?;
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "配置文件锁已损坏")?;
    delete_backup(&client, &home, &id)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) fn test_backup_count(client: AgentClient, home: &Path) -> usize {
    list_backups(client.id(), home).unwrap().versions.len()
}

#[cfg(test)]
pub(crate) fn test_restore_backup(client: AgentClient, home: &Path, id: &str) {
    let paths = config_paths(client.id(), home).unwrap();
    let version = read_version(client.id(), &paths, id).unwrap();
    let (_, before, after) = preview(client.id(), &paths, id).unwrap();
    commit_config_with_mappings(
        client.id(),
        &paths,
        &before,
        &after,
        "restore",
        None,
        version.mappings,
    )
    .unwrap();
}
