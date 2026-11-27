use crate::account_switch::crypto::write_atomic_secure;
use crate::account_switch::types::{
    compute_fingerprint, now_millis, AccountRecord, AccountSource, PlatformCredentials,
    QuotaSnapshot, SwitchPlatformId,
};
use crate::account_switch::vault::AccountVault;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const SNAPSHOT_ITEMS: &[&str] = &[
    "Cookies",
    "Cookies-journal",
    "Local Storage",
    "IndexedDB",
    "Session Storage",
    "Network",
];

const CONFIG_AUTH_KEYS: &[&str] = &[
    "oauth:tokenCache",
    "oauth:tokenCacheV2",
    "lastKnownAccountUuid",
];

pub(crate) fn claude_desktop_dir(home: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Claude")
    }
    #[cfg(target_os = "macos")]
    {
        home.join("Library")
            .join("Application Support")
            .join("Claude")
    }
    #[cfg(target_os = "linux")]
    {
        home.join(".config").join("Claude")
    }
}

pub(crate) fn is_installed(home: &Path) -> bool {
    claude_desktop_dir(home).is_dir()
}

fn is_login_config_key(key: &str) -> bool {
    CONFIG_AUTH_KEYS.contains(&key) || key.starts_with("coworkTrustedDeviceToken")
}

fn copy_entry_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_file() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(src, dst)
            .map_err(|e| format!("Failed to copy {} -> {}: {e}", src.display(), dst.display()))?;
    } else if src.is_dir() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_entry_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn remove_entry(path: &Path) -> Result<(), String> {
    if path.is_file() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    } else if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract_login_config(config_path: &Path) -> Map<String, Value> {
    let mut extracted = Map::new();
    if let Ok(raw) = fs::read_to_string(config_path) {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw) {
            for (k, v) in map {
                if is_login_config_key(&k) {
                    extracted.insert(k, v);
                }
            }
        }
    }
    extracted
}

pub(crate) fn read_local_preview(home: &Path) -> Result<Option<AccountRecord>, String> {
    let dir = claude_desktop_dir(home);
    if !dir.is_dir() {
        return Ok(None);
    }
    let config_auth = extract_login_config(&dir.join("config.json"));
    let has_session_files = SNAPSHOT_ITEMS.iter().any(|name| dir.join(name).exists());
    if config_auth.is_empty() && !has_session_files {
        return Ok(None);
    }
    let account_uuid = config_auth
        .get("lastKnownAccountUuid")
        .and_then(Value::as_str)
        .map(str::to_string);
    let label = account_uuid
        .as_deref()
        .map(|id| format!("Claude Desktop ({})", &id[..id.len().min(8)]))
        .unwrap_or_else(|| "Claude Desktop Local Session".to_string());
    let fingerprint = compute_fingerprint(
        SwitchPlatformId::ClaudeDesktop,
        &[account_uuid.as_deref(), Some("local-snapshot")],
    );
    let now = now_millis();

    Ok(Some(AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform: SwitchPlatformId::ClaudeDesktop,
        label,
        email: None,
        account_id: account_uuid.clone(),
        plan_type: Some("Desktop Snapshot".to_string()),
        fingerprint,
        tags: Vec::new(),
        group_id: None,
        notes: None,
        source: AccountSource::Local,
        created_at: now,
        updated_at: now,
        last_used_at: None,
        last_quota: None,
        credentials: PlatformCredentials {
            account_id: account_uuid,
            ..Default::default()
        },
    }))
}

/// Captures the current Claude Desktop profile session into a dedicated snapshot folder inside the vault.
pub(crate) fn capture_local_snapshot(
    home: &Path,
    vault: &AccountVault,
) -> Result<AccountRecord, String> {
    let source_dir = claude_desktop_dir(home);
    if !source_dir.is_dir() {
        return Err(format!(
            "Claude Desktop profile directory not found: {}",
            source_dir.display()
        ));
    }
    let mut record = read_local_preview(home)?
        .ok_or("No active Claude Desktop login session found to capture")?;
    let snapshot_id = record.id.clone();
    let snap_dir = vault.snapshots_dir(SwitchPlatformId::ClaudeDesktop, &snapshot_id);
    if snap_dir.exists() {
        let _ = fs::remove_dir_all(&snap_dir);
    }
    fs::create_dir_all(&snap_dir)
        .map_err(|e| format!("Failed to create snapshot directory: {e}"))?;

    for item in SNAPSHOT_ITEMS {
        let src = source_dir.join(item);
        if src.exists() {
            copy_entry_recursive(&src, &snap_dir.join(item))?;
        }
    }
    let login_keys = extract_login_config(&source_dir.join("config.json"));
    let keys_bytes = serde_json::to_vec_pretty(&Value::Object(login_keys))
        .map_err(|e| format!("Failed to serialize Claude Desktop login keys: {e}"))?;
    write_atomic_secure(&snap_dir.join("login_config.json"), &keys_bytes)?;

    record.credentials.snapshot_id = Some(snapshot_id);
    Ok(record)
}

/// Transactionally restores a stored Claude Desktop snapshot into `target_dir` with automatic rollback on failure.
pub(crate) fn apply_snapshot_to_dir(
    target_dir: &Path,
    snap_dir: &Path,
) -> Result<(), String> {
    if !snap_dir.is_dir() {
        return Err(format!(
            "Claude Desktop snapshot directory is missing: {}",
            snap_dir.display()
        ));
    }
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to ensure Claude Desktop profile dir: {e}"))?;

    let backup_dir = target_dir.join(format!(".ecpa-rollback-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Failed to create rollback backup dir: {e}"))?;

    // 1. Back up current live session items + config.json.
    for item in SNAPSHOT_ITEMS {
        let live = target_dir.join(item);
        if live.exists() {
            copy_entry_recursive(&live, &backup_dir.join(item))?;
        }
    }
    let live_config = target_dir.join("config.json");
    if live_config.is_file() {
        copy_entry_recursive(&live_config, &backup_dir.join("config.json"))?;
    }

    // 2. Apply snapshot items; rollback automatically if anything fails.
    let apply_result: Result<(), String> = (|| {
        for item in SNAPSHOT_ITEMS {
            let live = target_dir.join(item);
            if live.exists() {
                remove_entry(&live)?;
            }
            let src = snap_dir.join(item);
            if src.exists() {
                copy_entry_recursive(&src, &live)?;
            }
        }

        // Merge login-owned keys into target config.json without wiping unrelated user preferences.
        let snap_keys_path = snap_dir.join("login_config.json");
        let snap_keys: Map<String, Value> = if snap_keys_path.is_file() {
            fs::read_to_string(&snap_keys_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default()
        } else {
            Map::new()
        };
        let mut live_root: Map<String, Value> = if live_config.is_file() {
            fs::read_to_string(&live_config)
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default()
        } else {
            Map::new()
        };
        live_root.retain(|k, _| !is_login_config_key(k));
        for (k, v) in snap_keys {
            live_root.insert(k, v);
        }
        let rendered = serde_json::to_vec_pretty(&Value::Object(live_root))
            .map_err(|e| format!("Failed to serialize Claude Desktop config.json: {e}"))?;
        write_atomic_secure(&live_config, &rendered)?;
        Ok(())
    })();

    if let Err(err) = apply_result {
        // Automatic rollback from backup_dir.
        for item in SNAPSHOT_ITEMS {
            let live = target_dir.join(item);
            let _ = remove_entry(&live);
            let bkp = backup_dir.join(item);
            if bkp.exists() {
                let _ = copy_entry_recursive(&bkp, &live);
            }
        }
        let bkp_cfg = backup_dir.join("config.json");
        if bkp_cfg.is_file() {
            let _ = copy_entry_recursive(&bkp_cfg, &live_config);
        }
        let _ = fs::remove_dir_all(&backup_dir);
        return Err(format!("Claude Desktop switch failed and was rolled back: {err}"));
    }

    let _ = fs::remove_dir_all(&backup_dir);
    Ok(())
}

pub(crate) fn apply_account(
    home: &Path,
    vault: &AccountVault,
    record: &AccountRecord,
) -> Result<(), String> {
    let snap_id = record
        .credentials
        .snapshot_id
        .as_deref()
        .unwrap_or(record.id.as_str());
    let snap_dir = vault.snapshots_dir(SwitchPlatformId::ClaudeDesktop, snap_id);
    apply_snapshot_to_dir(&claude_desktop_dir(home), &snap_dir)
}

pub(crate) async fn fetch_quota(record: &AccountRecord) -> Result<QuotaSnapshot, String> {
    Ok(QuotaSnapshot {
        fetched_at: now_millis(),
        plan: record
            .plan_type
            .clone()
            .or_else(|| Some("Desktop Snapshot".to_string())),
        plan_expires_at: record.credentials.plan_expires_at,
        metrics: Vec::new(),
        error: None,
    })
}
