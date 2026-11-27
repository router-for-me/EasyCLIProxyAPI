use super::super::crypto::write_atomic_secure;
use super::super::types::{AccountRecord, SwitchPlatformId, SyncTargetInfo};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn openclaw_profiles_path(home: &Path) -> PathBuf {
    home.join(".openclaw")
        .join("agents")
        .join("main")
        .join("agent")
        .join("auth-profiles.json")
}

pub(crate) fn inspect(home: &Path) -> SyncTargetInfo {
    let path = openclaw_profiles_path(home);
    let installed = path.is_file() || home.join(".openclaw").is_dir();
    SyncTargetInfo {
        id: "openclaw".to_string(),
        label: "OpenClaw".to_string(),
        installed,
        target_path: Some(path.to_string_lossy().into_owned()),
    }
}

pub(crate) fn sync_account(record: &AccountRecord, home: &Path) -> Result<String, String> {
    let path = openclaw_profiles_path(home);
    sync_account_to_path(record, &path)
}

pub(crate) fn sync_account_to_path(record: &AccountRecord, path: &Path) -> Result<String, String> {
    if record.platform != SwitchPlatformId::Codex {
        return Err("OpenClaw sync only supports Codex accounts".into());
    }
    let access = record
        .credentials
        .access_token
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Codex account is missing access_token for OpenClaw sync")?;
    let refresh = record
        .credentials
        .refresh_token
        .as_deref()
        .unwrap_or_default();
    let expires_ms = record
        .credentials
        .expires_at
        .map(|s| if s > 1_000_000_000_000 { s } else { s * 1000 })
        .unwrap_or(0);

    let mut root: Map<String, Value> = if path.is_file() {
        let raw = fs::read_to_string(path)
            .map_err(|error| format!("Failed to read OpenClaw auth-profiles.json: {error}"))?;
        serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    root.entry("version".to_string()).or_insert_with(|| json!(1));
    let profiles = root
        .entry("profiles".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or("OpenClaw auth-profiles.json `profiles` must be an object")?;

    let mut profile_entry = Map::new();
    profile_entry.insert("type".into(), json!("oauth"));
    profile_entry.insert("provider".into(), json!("openai-codex"));
    profile_entry.insert("access".into(), json!(access));
    profile_entry.insert("refresh".into(), json!(refresh));
    profile_entry.insert("expires".into(), json!(expires_ms));
    if let Some(account_id) = record
        .credentials
        .account_id
        .as_deref()
        .or(record.account_id.as_deref())
    {
        profile_entry.insert("accountId".into(), json!(account_id));
    }
    profiles.insert(
        "openai-codex:default".to_string(),
        Value::Object(profile_entry),
    );

    let last_good = root
        .entry("lastGood".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(obj) = last_good.as_object_mut() {
        obj.insert("openai-codex".into(), json!("openai-codex:default"));
    }

    let rendered = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|error| format!("Failed to serialize OpenClaw auth-profiles.json: {error}"))?;
    write_atomic_secure(path, &rendered)?;
    Ok(format!("Synced openai-codex:default to {}", path.display()))
}
