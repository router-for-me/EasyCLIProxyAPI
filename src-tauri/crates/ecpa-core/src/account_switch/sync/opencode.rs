use super::super::crypto::write_atomic_secure;
use super::super::types::{AccountRecord, SwitchPlatformId, SyncTargetInfo};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn opencode_auth_path(home: &Path) -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(xdg).join("opencode").join("auth.json");
    }
    home.join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json")
}

pub(crate) fn inspect(home: &Path) -> SyncTargetInfo {
    let path = opencode_auth_path(home);
    let installed = path.is_file()
        || path.parent().is_some_and(Path::is_dir)
        || home.join(".config").join("opencode").is_dir();
    SyncTargetInfo {
        id: "opencode".to_string(),
        label: "OpenCode".to_string(),
        installed,
        target_path: Some(path.to_string_lossy().into_owned()),
    }
}

pub(crate) fn sync_account(record: &AccountRecord, home: &Path) -> Result<String, String> {
    let path = opencode_auth_path(home);
    sync_account_to_path(record, &path)
}

pub(crate) fn sync_account_to_path(record: &AccountRecord, path: &Path) -> Result<String, String> {
    let mut root: Map<String, Value> = if path.is_file() {
        let raw = fs::read_to_string(path)
            .map_err(|error| format!("Failed to read OpenCode auth.json: {error}"))?;
        serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    let (key, entry) = match record.platform {
        SwitchPlatformId::Codex => {
            let access = record
                .credentials
                .access_token
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .ok_or("Codex account is missing access_token for OpenCode sync")?;
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
            let mut obj = Map::new();
            obj.insert("type".into(), json!("oauth"));
            obj.insert("access".into(), json!(access));
            obj.insert("refresh".into(), json!(refresh));
            obj.insert("expires".into(), json!(expires_ms));
            if let Some(account_id) = record
                .credentials
                .account_id
                .as_deref()
                .or(record.account_id.as_deref())
            {
                obj.insert("accountId".into(), json!(account_id));
            }
            ("openai", Value::Object(obj))
        }
        SwitchPlatformId::Grok => {
            let token = record
                .credentials
                .access_token
                .as_deref()
                .or(record.credentials.api_key.as_deref())
                .filter(|v| !v.trim().is_empty())
                .ok_or("Grok account is missing token for OpenCode sync")?;
            let mut obj = Map::new();
            obj.insert("type".into(), json!("oauth"));
            obj.insert("access".into(), json!(token));
            if let Some(refresh) = record.credentials.refresh_token.as_deref() {
                obj.insert("refresh".into(), json!(refresh));
            }
            if let Some(exp) = record.credentials.expires_at {
                obj.insert(
                    "expires".into(),
                    json!(if exp > 1_000_000_000_000 { exp } else { exp * 1000 }),
                );
            }
            ("xai", Value::Object(obj))
        }
        SwitchPlatformId::GithubCopilot => {
            let token = record
                .credentials
                .access_token
                .as_deref()
                .or(record.credentials.session_token.as_deref())
                .filter(|v| !v.trim().is_empty())
                .ok_or("GitHub Copilot account is missing OAuth token for OpenCode sync")?;
            let obj = json!({
                "type": "oauth",
                "refresh": token,
                "access": token,
                "expires": 0
            });
            ("github-copilot", obj)
        }
        other => {
            return Err(format!(
                "OpenCode sync is not supported for {}",
                other.display_name()
            ))
        }
    };

    root.insert(key.to_string(), entry);
    let rendered = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|error| format!("Failed to serialize OpenCode auth.json: {error}"))?;
    write_atomic_secure(path, &rendered)?;
    Ok(format!("Synced `{key}` to {}", path.display()))
}
