use crate::account_switch::crypto::{fill_random_bytes, write_atomic_secure};
use crate::account_switch::types::{
    compute_fingerprint, now_millis, AccountRecord, AccountSource, PlatformCredentials,
    QuotaSnapshot, SwitchPlatformId,
};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[allow(dead_code)]
const WB_AAD: &[u8] = b"WB-AAD";

pub(crate) fn info_file_path(platform: SwitchPlatformId, home: &Path) -> PathBuf {
    let file_name = if platform == SwitchPlatformId::WorkbuddyAi {
        "workbuddy-desktop-ai.info"
    } else {
        "workbuddy-desktop.info"
    };
    let folder = if platform == SwitchPlatformId::WorkbuddyAi {
        "WorkBuddy AI"
    } else {
        "WorkBuddy"
    };

    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        let candidate = base.join(folder).join(file_name);
        if candidate.is_file() {
            return candidate;
        }
        home.join(".workbuddy-ai").join(file_name)
    }
    #[cfg(target_os = "macos")]
    {
        let candidate = home
            .join("Library")
            .join("Application Support")
            .join(folder)
            .join(file_name);
        if candidate.is_file() {
            return candidate;
        }
        home.join(".workbuddy-ai").join(file_name)
    }
    #[cfg(target_os = "linux")]
    {
        let candidate = home.join(".config").join(folder).join(file_name);
        if candidate.is_file() {
            return candidate;
        }
        home.join(".workbuddy-ai").join(file_name)
    }
}

pub(crate) fn is_installed(platform: SwitchPlatformId, home: &Path) -> bool {
    info_file_path(platform, home).is_file()
        || crate::agents::find_workbuddy_desktop_executable(home).is_some()
}

#[allow(dead_code)]
pub(crate) fn decrypt_wb_field(key: &[u8; 32], encoded: &str) -> Result<String, String> {
    let raw = BASE64
        .decode(encoded.trim())
        .map_err(|e| format!("Invalid WorkBuddy field base64: {e}"))?;
    if raw.len() <= 12 + 16 {
        return Err("Truncated WorkBuddy encrypted field".into());
    }
    let (nonce, ciphertext) = raw.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: WB_AAD,
            },
        )
        .map_err(|_| "WorkBuddy AES-256-GCM decryption failed".to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

#[allow(dead_code)]
pub(crate) fn encrypt_wb_field(key: &[u8; 32], plaintext: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 12];
    fill_random_bytes(&mut nonce)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: WB_AAD,
            },
        )
        .map_err(|e| format!("WorkBuddy AES-256-GCM encryption failed: {e}"))?;
    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(out))
}

pub(crate) fn read_local_account(
    platform: SwitchPlatformId,
    home: &Path,
) -> Result<Option<AccountRecord>, String> {
    let path = info_file_path(platform, home);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let root: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid WorkBuddy info JSON: {error}"))?;

    let token = root
        .get("accessToken")
        .or_else(|| root.get("token"))
        .or_else(|| root.get("auth").and_then(|a| a.get("accessToken")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let refresh_token = root
        .get("refreshToken")
        .or_else(|| root.get("auth").and_then(|a| a.get("refreshToken")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if token.is_none() && refresh_token.is_none() {
        return Ok(None);
    }
    let email = root
        .get("email")
        .or_else(|| root.get("user").and_then(|u| u.get("email")))
        .and_then(Value::as_str)
        .map(str::to_string);
    let uid = root
        .get("uid")
        .or_else(|| root.get("userId"))
        .or_else(|| root.get("user").and_then(|u| u.get("uid")))
        .and_then(Value::as_str)
        .map(str::to_string);
    let nickname = root
        .get("nickname")
        .or_else(|| root.get("user").and_then(|u| u.get("nickname")))
        .and_then(Value::as_str)
        .map(str::to_string);
    let label = nickname
        .or_else(|| email.clone())
        .or_else(|| uid.clone())
        .unwrap_or_else(|| platform.display_name().to_string());
    let fingerprint = compute_fingerprint(
        platform,
        &[
            email.as_deref(),
            uid.as_deref(),
            refresh_token
                .as_deref()
                .or(token.as_deref())
                .map(|s| &s[..s.len().min(20)]),
        ],
    );
    let now = now_millis();
    let mut extra = std::collections::HashMap::new();
    extra.insert("rawInfo".to_string(), root);

    Ok(Some(AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform,
        label,
        email,
        account_id: uid.clone(),
        plan_type: None,
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
            access_token: token,
            refresh_token,
            account_id: uid,
            extra,
            ..Default::default()
        },
    }))
}

pub(crate) fn apply_account(
    platform: SwitchPlatformId,
    home: &Path,
    record: &AccountRecord,
) -> Result<(), String> {
    let path = info_file_path(platform, home);
    let mut root: Map<String, Value> = if let Some(saved) = record
        .credentials
        .extra
        .get("rawInfo")
        .and_then(Value::as_object)
    {
        saved.clone()
    } else if path.is_file() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    if let Some(access) = record.credentials.access_token.as_deref() {
        root.insert("accessToken".into(), json!(access));
    }
    if let Some(refresh) = record.credentials.refresh_token.as_deref() {
        root.insert("refreshToken".into(), json!(refresh));
    }
    if let Some(uid) = record
        .credentials
        .account_id
        .as_deref()
        .or(record.account_id.as_deref())
    {
        root.insert("uid".into(), json!(uid));
    }
    if let Some(email) = record.email.as_deref() {
        root.insert("email".into(), json!(email));
    }
    // Clear any stale logout markers so the desktop app accepts the injected session.
    root.remove("loggedOut");
    root.remove("logoutAt");

    let bytes = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|error| format!("Failed to serialize WorkBuddy info file: {error}"))?;
    write_atomic_secure(&path, &bytes)
}

pub(crate) async fn fetch_quota(record: &AccountRecord) -> Result<QuotaSnapshot, String> {
    Ok(QuotaSnapshot {
        fetched_at: now_millis(),
        plan: record.plan_type.clone().or_else(|| Some("Active".to_string())),
        plan_expires_at: record.credentials.plan_expires_at,
        metrics: Vec::new(),
        error: None,
    })
}
