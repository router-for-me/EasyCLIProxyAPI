use super::super::crypto::write_atomic_secure;
use super::super::types::{AccountRecord, SwitchPlatformId, SyncTargetInfo};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn hermes_auth_path(home: &Path) -> PathBuf {
    if let Some(dir) = std::env::var_os("HERMES_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir).join("auth.json");
    }
    home.join(".hermes").join("auth.json")
}

pub(crate) fn inspect(home: &Path) -> SyncTargetInfo {
    let path = hermes_auth_path(home);
    let installed = path.is_file() || path.parent().is_some_and(Path::is_dir);
    SyncTargetInfo {
        id: "hermes".to_string(),
        label: "Hermes Agent".to_string(),
        installed,
        target_path: Some(path.to_string_lossy().into_owned()),
    }
}

pub(crate) fn sync_account(record: &AccountRecord, home: &Path) -> Result<String, String> {
    let path = hermes_auth_path(home);
    sync_account_to_path(record, &path)
}

pub(crate) fn sync_account_to_path(record: &AccountRecord, path: &Path) -> Result<String, String> {
    if record.platform != SwitchPlatformId::Codex {
        return Err("Hermes Agent sync only supports Codex accounts".into());
    }
    let access = record
        .credentials
        .access_token
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Codex account is missing access_token for Hermes sync")?;
    let refresh = record
        .credentials
        .refresh_token
        .as_deref()
        .unwrap_or_default();
    let now_iso = chrono::Utc::now().to_rfc3339();

    let mut root: Map<String, Value> = if path.is_file() {
        let raw = fs::read_to_string(path)
            .map_err(|error| format!("Failed to read Hermes auth.json: {error}"))?;
        serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    root.entry("version".to_string()).or_insert_with(|| json!(1));
    root.insert("active_provider".to_string(), json!("openai-codex"));

    let mut tokens = Map::new();
    tokens.insert("access_token".into(), json!(access));
    tokens.insert("refresh_token".into(), json!(refresh));
    if let Some(id_token) = record.credentials.id_token.as_deref() {
        tokens.insert("id_token".into(), json!(id_token));
    }
    if let Some(account_id) = record
        .credentials
        .account_id
        .as_deref()
        .or(record.account_id.as_deref())
    {
        tokens.insert("account_id".into(), json!(account_id));
    }

    let provider_payload = json!({
        "tokens": Value::Object(tokens.clone()),
        "last_refresh": now_iso,
        "auth_mode": "chatgpt",
        "source": "easycliproxyapi"
    });

    let providers = root
        .entry("providers".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or("Hermes auth.json `providers` must be an object")?;
    providers.insert("openai-codex".to_string(), provider_payload);

    // Update credential_pool.openai-codex if present so Hermes uses the active account immediately.
    if let Some(pool) = root
        .get_mut("credential_pool")
        .and_then(Value::as_object_mut)
    {
        if let Some(codex_pool) = pool.get_mut("openai-codex").and_then(Value::as_object_mut) {
            codex_pool.insert("active_id".into(), json!(record.id));
            codex_pool.insert("updated_at".into(), json!(now_iso));
        }
    }

    let rendered = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|error| format!("Failed to serialize Hermes auth.json: {error}"))?;
    write_atomic_secure(path, &rendered)?;
    Ok(format!("Synced openai-codex to {}", path.display()))
}
