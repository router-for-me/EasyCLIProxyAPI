use super::super::crypto::write_atomic_secure;
use super::super::types::{AccountRecord, SwitchPlatformId, SyncTargetInfo};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
fn discover_wsl_codex_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for share in [r"\\wsl.localhost", r"\\wsl$"] {
        let Ok(distros) = fs::read_dir(share) else {
            continue;
        };
        for distro in distros.flatten() {
            let root = distro.path();
            if let Ok(users) = fs::read_dir(root.join("home")) {
                for user in users.flatten() {
                    let codex_dir = user.path().join(".codex");
                    if codex_dir.is_dir() && !dirs.contains(&codex_dir) {
                        dirs.push(codex_dir);
                    }
                }
            }
            let root_codex = root.join("root").join(".codex");
            if root_codex.is_dir() && !dirs.contains(&root_codex) {
                dirs.push(root_codex);
            }
        }
    }
    dirs
}

#[cfg(not(target_os = "windows"))]
fn discover_wsl_codex_dirs() -> Vec<PathBuf> {
    Vec::new()
}

pub(crate) fn inspect() -> SyncTargetInfo {
    let dirs = discover_wsl_codex_dirs();
    SyncTargetInfo {
        id: "wsl".to_string(),
        label: "WSL Codex".to_string(),
        installed: !dirs.is_empty(),
        target_path: dirs.first().map(|p| p.to_string_lossy().into_owned()),
    }
}

pub(crate) fn sync_codex_account(record: &AccountRecord) -> Result<String, String> {
    if record.platform != SwitchPlatformId::Codex {
        return Err("WSL sync only supports Codex accounts".into());
    }
    let dirs = discover_wsl_codex_dirs();
    if dirs.is_empty() {
        return Err("No WSL ~/.codex directory detected".into());
    }
    let mut synced = Vec::new();
    for dir in &dirs {
        sync_codex_to_dir(record, dir)?;
        synced.push(dir.to_string_lossy().into_owned());
    }
    Ok(format!("Synced to WSL: {}", synced.join(", ")))
}

pub(crate) fn sync_codex_to_dir(record: &AccountRecord, codex_dir: &Path) -> Result<(), String> {
    let auth_path = codex_dir.join("auth.json");
    let mut root: Map<String, Value> = if auth_path.is_file() {
        fs::read_to_string(&auth_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    let mut tokens = Map::new();
    if let Some(id_token) = record.credentials.id_token.as_deref() {
        tokens.insert("id_token".into(), json!(id_token));
    }
    if let Some(access) = record.credentials.access_token.as_deref() {
        tokens.insert("access_token".into(), json!(access));
    }
    if let Some(refresh) = record.credentials.refresh_token.as_deref() {
        tokens.insert("refresh_token".into(), json!(refresh));
    }
    if let Some(account_id) = record
        .credentials
        .account_id
        .as_deref()
        .or(record.account_id.as_deref())
    {
        tokens.insert("account_id".into(), json!(account_id));
    }

    root.remove("OPENAI_API_KEY");
    root.insert("auth_mode".into(), json!("chatgpt"));
    root.insert("tokens".into(), Value::Object(tokens));
    root.insert("last_refresh".into(), json!(chrono::Utc::now().to_rfc3339()));

    let bytes = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|error| format!("Failed to serialize WSL auth.json: {error}"))?;
    write_atomic_secure(&auth_path, &bytes)?;

    // Also remove CPA reverse-proxy override in WSL config.toml if present.
    let config_path = codex_dir.join("config.toml");
    if let Ok(raw) = fs::read_to_string(&config_path) {
        if let Ok(mut doc) = raw.parse::<toml_edit::Document>() {
            let mut dirty = false;
            if doc
                .get("model_provider")
                .and_then(toml_edit::Item::as_str)
                == Some(crate::MANAGED_AGENT_PROVIDER_ID)
            {
                doc.remove("model_provider");
                dirty = true;
            }
            if dirty {
                write_atomic_secure(&config_path, doc.to_string().as_bytes())?;
            }
        }
    }
    Ok(())
}
