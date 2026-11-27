use crate::account_switch::crypto::{fill_random_bytes, write_atomic_secure};
use crate::account_switch::types::{
    compute_fingerprint, now_millis, AccountRecord, AccountSource, PlatformCredentials,
    QuotaSnapshot, SwitchPlatformId,
};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const ZCODE_KEYRING_SERVICE: &str = "ZCode Credential Encryption";
const ZCODE_KEYRING_USER: &str = "zcode-master-key";
const ENC_V2_PREFIX: &str = "enc:v2:";
const ENC_V1_PREFIX: &str = "enc:v1:";

pub(crate) fn zcode_dir(home: &Path) -> PathBuf {
    crate::agents::agent_config_paths(crate::AgentClient::ZCode, home)
        .into_iter()
        .next()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| home.join(".zcode").join("v2"))
}

pub(crate) fn credentials_path(home: &Path) -> PathBuf {
    zcode_dir(home).join("credentials.json")
}

pub(crate) fn is_installed(home: &Path) -> bool {
    zcode_dir(home).is_dir() || crate::agents::find_zcode_desktop_executable(home).is_some()
}

fn load_zcode_keyring_key() -> Option<[u8; 32]> {
    let entry = keyring::Entry::new(ZCODE_KEYRING_SERVICE, ZCODE_KEYRING_USER).ok()?;
    let secret = entry.get_password().ok()?;
    let decoded = BASE64
        .decode(secret.trim())
        .ok()
        .or_else(|| hex_decode(secret.trim()))?;
    if decoded.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&decoded);
    Some(key)
}

fn hex_decode(input: &str) -> Option<Vec<u8>> {
    if input.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(input.len() / 2);
    for chunk in input.as_bytes().chunks_exact(2) {
        let s = std::str::from_utf8(chunk).ok()?;
        out.push(u8::from_str_radix(s, 16).ok()?);
    }
    Some(out)
}

pub(crate) fn decrypt_zcode_value(value: &str, key: Option<&[u8; 32]>) -> String {
    let encoded = value
        .strip_prefix(ENC_V2_PREFIX)
        .or_else(|| value.strip_prefix(ENC_V1_PREFIX));
    let Some(b64) = encoded else {
        return value.to_string();
    };
    let Some(key) = key else {
        return value.to_string();
    };
    let Ok(raw) = BASE64.decode(b64.trim()) else {
        return value.to_string();
    };
    if raw.len() <= 12 + 16 {
        return value.to_string();
    }
    let (nonce, ciphertext) = raw.split_at(12);
    let Ok(cipher) = Aes256Gcm::new_from_slice(key) else {
        return value.to_string();
    };
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| value.to_string())
}

pub(crate) fn encrypt_zcode_value(plaintext: &str, key: Option<&[u8; 32]>) -> Result<String, String> {
    let Some(key) = key else {
        return Ok(plaintext.to_string());
    };
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 12];
    fill_random_bytes(&mut nonce)?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|e| format!("ZCode AES-256-GCM encryption failed: {e}"))?;
    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(format!("{ENC_V2_PREFIX}{}", BASE64.encode(out)))
}

pub(crate) fn read_local_account(home: &Path) -> Result<Option<AccountRecord>, String> {
    let path = credentials_path(home);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read ZCode credentials.json: {error}"))?;
    let root: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid ZCode credentials.json: {error}"))?;
    let Some(obj) = root.as_object() else {
        return Ok(None);
    };
    let key = load_zcode_keyring_key();
    let active_provider = obj
        .get("oauth:active_provider")
        .and_then(Value::as_str)
        .map(|v| decrypt_zcode_value(v, key.as_ref()))
        .unwrap_or_else(|| "zai".to_string());

    let access_key = format!("oauth:{active_provider}:access_token");
    let refresh_key = format!("oauth:{active_provider}:refresh_token");
    let user_key = format!("oauth:{active_provider}:user_info");

    let access_token = obj
        .get(&access_key)
        .or_else(|| obj.get("zcodejwttoken"))
        .and_then(Value::as_str)
        .map(|v| decrypt_zcode_value(v, key.as_ref()))
        .filter(|s| !s.trim().is_empty());
    let refresh_token = obj
        .get(&refresh_key)
        .and_then(Value::as_str)
        .map(|v| decrypt_zcode_value(v, key.as_ref()))
        .filter(|s| !s.trim().is_empty());
    if access_token.is_none() && refresh_token.is_none() {
        return Ok(None);
    }

    let user_info_json = obj
        .get(&user_key)
        .and_then(Value::as_str)
        .map(|v| decrypt_zcode_value(v, key.as_ref()))
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let email = user_info_json
        .as_ref()
        .and_then(|u| u.get("email").and_then(Value::as_str).map(str::to_string));
    let account_id = user_info_json.as_ref().and_then(|u| {
        u.get("id")
            .or_else(|| u.get("userId"))
            .and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string())))
    });
    let label = email
        .clone()
        .or_else(|| account_id.clone())
        .unwrap_or_else(|| format!("ZCode ({active_provider})"));
    let fingerprint = compute_fingerprint(
        SwitchPlatformId::Zcode,
        &[
            Some(active_provider.as_str()),
            email.as_deref(),
            account_id.as_deref(),
            refresh_token
                .as_deref()
                .or(access_token.as_deref())
                .map(|s| &s[..s.len().min(20)]),
        ],
    );
    let now = now_millis();

    Ok(Some(AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform: SwitchPlatformId::Zcode,
        label,
        email,
        account_id: account_id.clone(),
        plan_type: Some(active_provider.clone()),
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
            access_token,
            refresh_token,
            account_id,
            provider_region: Some(active_provider),
            ..Default::default()
        },
    }))
}

pub(crate) fn apply_account(home: &Path, record: &AccountRecord) -> Result<(), String> {
    let access_token = record
        .credentials
        .access_token
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or("ZCode account is missing access_token")?;
    let provider = record
        .credentials
        .provider_region
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("zai");

    let path = credentials_path(home);
    let mut root: Map<String, Value> = if path.is_file() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    let key = load_zcode_keyring_key();
    let use_encryption = root
        .values()
        .filter_map(Value::as_str)
        .any(|v| v.starts_with(ENC_V2_PREFIX) || v.starts_with(ENC_V1_PREFIX))
        && key.is_some();
    let enc_key = if use_encryption { key.as_ref() } else { None };

    root.insert("oauth:active_provider".into(), json!(provider));
    root.insert(
        format!("oauth:{provider}:access_token"),
        json!(encrypt_zcode_value(access_token, enc_key)?),
    );
    if let Some(refresh) = record.credentials.refresh_token.as_deref() {
        root.insert(
            format!("oauth:{provider}:refresh_token"),
            json!(encrypt_zcode_value(refresh, enc_key)?),
        );
    }
    let user_info = json!({
        "email": record.email,
        "id": record.account_id,
    })
    .to_string();
    root.insert(
        format!("oauth:{provider}:user_info"),
        json!(encrypt_zcode_value(&user_info, enc_key)?),
    );
    root.insert(
        "zcodejwttoken".into(),
        json!(encrypt_zcode_value(access_token, enc_key)?),
    );

    let bytes = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|error| format!("Failed to serialize ZCode credentials.json: {error}"))?;
    write_atomic_secure(&path, &bytes)?;

    // Reconcile setting.json auth mode if file exists.
    let setting_path = zcode_dir(home).join("setting.json");
    if let Ok(raw) = fs::read_to_string(&setting_path) {
        if let Ok(mut setting) = serde_json::from_str::<Value>(&raw) {
            if let Some(obj) = setting.as_object_mut() {
                obj.insert("authMode".into(), json!("oauth"));
                obj.insert("oauthProvider".into(), json!(provider));
                if let Ok(rendered) = serde_json::to_vec_pretty(&setting) {
                    let _ = write_atomic_secure(&setting_path, &rendered);
                }
            }
        }
    }

    Ok(())
}

pub(crate) async fn fetch_quota(record: &AccountRecord) -> Result<QuotaSnapshot, String> {
    Ok(QuotaSnapshot {
        fetched_at: now_millis(),
        plan: record
            .credentials
            .provider_region
            .clone()
            .or_else(|| record.plan_type.clone()),
        plan_expires_at: record.credentials.plan_expires_at,
        metrics: Vec::new(),
        error: None,
    })
}
