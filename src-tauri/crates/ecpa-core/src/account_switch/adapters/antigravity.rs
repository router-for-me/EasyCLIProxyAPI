use super::common::{build_http_client, proto, token_needs_refresh};
use crate::account_switch::crypto::write_atomic_secure;
use crate::account_switch::types::{
    compute_fingerprint, now_millis, now_secs, AccountRecord, AccountSource, PlatformCredentials,
    QuotaMetric, QuotaSnapshot, SwitchPlatformId,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CLOUDCODE_BASE: &str = "https://cloudcode-pa.googleapis.com";
const KEYRING_SERVICE: &str = "gemini";
const KEYRING_USER: &str = "antigravity";

fn jetski_token_path(home: &Path) -> PathBuf {
    home.join(".gemini").join("jetski-standalone-oauth-token")
}

fn agy_cli_token_path(home: &Path) -> PathBuf {
    home.join(".gemini")
        .join("antigravity-cli")
        .join("antigravity-oauth-token")
}

fn legacy_state_db_path(#[allow(unused_variables)] home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from)?;
        Some(
            appdata
                .join("Antigravity")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        )
    }
    #[cfg(target_os = "macos")]
    {
        Some(
            home.join("Library")
                .join("Application Support")
                .join("Antigravity")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        )
    }
    #[cfg(target_os = "linux")]
    {
        Some(
            home.join(".config")
                .join("Antigravity")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        )
    }
}

pub(crate) fn is_installed(home: &Path) -> bool {
    jetski_token_path(home).is_file()
        || agy_cli_token_path(home).is_file()
        || legacy_state_db_path(home).is_some_and(|p| p.is_file())
        || crate::agents::find_agent_executable(crate::AgentClient::AntigravityCli, home)
            .is_some()
}

fn read_shared_oauth_json(home: &Path) -> Option<Value> {
    // 1. OS keyring (`gemini:antigravity`)
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        if let Ok(secret) = entry.get_password() {
            if let Ok(val) = serde_json::from_str::<Value>(&secret) {
                return Some(val);
            }
        }
    }
    // 2. Standalone & CLI token files
    for path in [jetski_token_path(home), agy_cli_token_path(home)] {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                return Some(val);
            }
        }
    }
    None
}

pub(crate) fn read_local_account(home: &Path) -> Result<Option<AccountRecord>, String> {
    let Some(val) = read_shared_oauth_json(home) else {
        return Ok(None);
    };
    let access_token = val
        .get("access_token")
        .or_else(|| val.get("accessToken"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let refresh_token = val
        .get("refresh_token")
        .or_else(|| val.get("refreshToken"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if access_token.is_none() && refresh_token.is_none() {
        return Ok(None);
    }
    let email = val.get("email").and_then(Value::as_str).map(str::to_string);
    let project_id = val
        .get("project_id")
        .or_else(|| val.get("projectId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let expires_at = val
        .get("expiry_date")
        .or_else(|| val.get("expires_at"))
        .and_then(Value::as_i64)
        .map(|v| if v > 1_000_000_000_000 { v / 1000 } else { v });
    let label = email
        .clone()
        .or_else(|| project_id.clone())
        .unwrap_or_else(|| "Antigravity Account".to_string());
    let fingerprint = compute_fingerprint(
        SwitchPlatformId::Antigravity,
        &[
            email.as_deref(),
            refresh_token.as_deref().map(|s| &s[..s.len().min(24)]),
        ],
    );
    let now = now_millis();

    let mut extra = HashMap::new();
    if let Some(cid) = val
        .get("client_id")
        .or_else(|| val.get("clientId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        extra.insert("client_id".to_string(), Value::String(cid.to_string()));
    }
    if let Some(csec) = val
        .get("client_secret")
        .or_else(|| val.get("clientSecret"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        extra.insert("client_secret".to_string(), Value::String(csec.to_string()));
    }

    Ok(Some(AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform: SwitchPlatformId::Antigravity,
        label,
        email,
        account_id: project_id.clone(),
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
            access_token,
            refresh_token,
            expires_at,
            project_id,
            extra,
            ..Default::default()
        },
    }))
}

pub(crate) fn apply_account(home: &Path, record: &AccountRecord) -> Result<(), String> {
    let access_token = record
        .credentials
        .access_token
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Antigravity account is missing access_token")?;
    let refresh_token = record
        .credentials
        .refresh_token
        .as_deref()
        .unwrap_or_default();
    let expiry_secs = record
        .credentials
        .expires_at
        .map(|v| if v > 1_000_000_000_000 { v / 1000 } else { v })
        .unwrap_or_else(|| now_secs() + 3600);

    let mut shared_payload = json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "Bearer",
        "expiry_date": expiry_secs * 1000,
        "email": record.email,
        "project_id": record.credentials.project_id,
    });
    if let Some(obj) = shared_payload.as_object_mut() {
        if let Some(cid) = record.credentials.extra.get("client_id").and_then(Value::as_str) {
            obj.insert("client_id".to_string(), Value::String(cid.to_string()));
        }
        if let Some(csec) = record.credentials.extra.get("client_secret").and_then(Value::as_str) {
            obj.insert("client_secret".to_string(), Value::String(csec.to_string()));
        }
    }
    let payload_bytes = serde_json::to_vec_pretty(&shared_payload)
        .map_err(|error| format!("Failed to serialize Antigravity token JSON: {error}"))?;
    let payload_str = String::from_utf8_lossy(&payload_bytes);

    // 1. v2.0+ OS credential store (`gemini:antigravity`)
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = entry.set_password(&payload_str);
    }

    // 2. Standalone & CLI fallback files
    write_atomic_secure(&jetski_token_path(home), &payload_bytes)?;
    write_atomic_secure(&agy_cli_token_path(home), &payload_bytes)?;

    // 3. Legacy IDE state.vscdb injection (only if database already exists)
    if let Some(db_path) = legacy_state_db_path(home) {
        if db_path.is_file() {
            inject_legacy_state_db(&db_path, access_token, refresh_token, expiry_secs)?;
        }
    }

    Ok(())
}

pub(crate) fn inject_legacy_state_db(
    db_path: &Path,
    access_token: &str,
    refresh_token: &str,
    expiry_secs: i64,
) -> Result<(), String> {
    let conn = Connection::open(db_path)
        .map_err(|error| format!("Failed to open Antigravity state.vscdb: {error}"))?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
        [],
    )
    .map_err(|error| format!("Failed to verify ItemTable schema: {error}"))?;
    let topic_bytes =
        proto::encode_antigravity_oauth_topic(access_token, refresh_token, expiry_secs);
    let encoded_topic = BASE64.encode(topic_bytes);
    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
        params!["antigravityUnifiedStateSync.oauthToken", encoded_topic],
    )
    .map_err(|error| format!("Failed to write Antigravity oauthToken: {error}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
        params!["antigravityOnboarding", "true"],
    )
    .map_err(|error| format!("Failed to write Antigravity onboarding flag: {error}"))?;
    Ok(())
}

fn resolve_runtime_oauth_client(record: &AccountRecord) -> Option<(String, String)> {
    let cid = record
        .credentials
        .extra
        .get("client_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::env::var("ECPA_ANTIGRAVITY_CLIENT_ID")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })?;
    let csec = record
        .credentials
        .extra
        .get("client_secret")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::env::var("ECPA_ANTIGRAVITY_CLIENT_SECRET")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })?;
    Some((cid, csec))
}

pub(crate) async fn refresh_if_needed(
    record: &mut AccountRecord,
    force: bool,
    proxy_url: Option<&str>,
) -> Result<bool, String> {
    if !force && !token_needs_refresh(record, 300) {
        return Ok(false);
    }
    // Antigravity is a first-party Google desktop client whose official IDE/CLI (`agy`)
    // refreshes its own OAuth session natively. We only refresh directly when the user's
    // imported credential file (or runtime env) supplies `client_id` + `client_secret`.
    let Some((client_id, client_secret)) = resolve_runtime_oauth_client(record) else {
        return Ok(false);
    };
    let refresh_token = record
        .credentials
        .refresh_token
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Antigravity account does not have a refresh_token")?
        .to_string();

    let client = build_http_client(proxy_url)?;
    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|error| format!("Google OAuth refresh failed: {error}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Google OAuth refresh error ({status}): {body}"));
    }
    let json: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid Google OAuth refresh JSON: {error}"))?;
    if let Some(access) = json.get("access_token").and_then(Value::as_str) {
        record.credentials.access_token = Some(access.to_string());
    }
    if let Some(expires_in) = json.get("expires_in").and_then(Value::as_i64) {
        record.credentials.expires_at = Some(now_secs() + expires_in);
    }
    record.updated_at = now_millis();
    Ok(true)
}

pub(crate) async fn fetch_quota(
    record: &AccountRecord,
    proxy_url: Option<&str>,
) -> Result<QuotaSnapshot, String> {
    let access_token = record
        .credentials
        .access_token
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Missing Antigravity access_token")?;
    let client = build_http_client(proxy_url)?;

    let mut project_id = record.credentials.project_id.clone();
    let mut plan = record.plan_type.clone();
    // 1. Discover project & tier via loadCodeAssist
    if let Ok(resp) = client
        .post(format!("{CLOUDCODE_BASE}/v1internal:loadCodeAssist"))
        .bearer_auth(access_token)
        .json(&json!({ "metadata": { "ideType": "ANTIGRAVITY" } }))
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(val) = resp.json::<Value>().await {
                if project_id.is_none() {
                    project_id = val
                        .get("cloudaicompanionProject")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if let Some(tier) = val
                    .get("paidTier")
                    .or_else(|| val.get("currentTier"))
                    .and_then(|t| t.get("name").or_else(|| t.get("id")))
                    .and_then(Value::as_str)
                {
                    plan = Some(tier.to_string());
                }
            }
        }
    }

    // 2. Fetch model quota buckets via fetchAvailableModels
    let body_req = if let Some(ref project) = project_id {
        json!({ "project": project })
    } else {
        json!({})
    };
    let resp = client
        .post(format!("{CLOUDCODE_BASE}/v1internal:fetchAvailableModels"))
        .bearer_auth(access_token)
        .json(&body_req)
        .send()
        .await
        .map_err(|error| format!("Antigravity quota request failed: {error}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Antigravity quota API error ({status})"));
    }
    let val: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Invalid Antigravity quota JSON: {error}"))?;

    let mut metrics = Vec::new();
    if let Some(models) = val.get("models").and_then(Value::as_object) {
        for (model_name, info) in models {
            if let Some(quota_info) = info.get("quotaInfo") {
                let remaining = quota_info
                    .get("remainingFraction")
                    .and_then(Value::as_f64)
                    .map(|f| (f * 100.0).clamp(0.0, 100.0));
                if remaining.is_none() {
                    continue;
                }
                let reset_at = quota_info
                    .get("resetTime")
                    .and_then(Value::as_str)
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.timestamp());
                let label = info
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(model_name)
                    .to_string();
                metrics.push(QuotaMetric {
                    id: model_name.clone(),
                    label,
                    remaining_percent: remaining,
                    used_percent: remaining.map(|r| (100.0 - r).clamp(0.0, 100.0)),
                    reset_at,
                    detail: None,
                });
            }
        }
    }
    metrics.sort_by(|a, b| a.label.cmp(&b.label));
    metrics.truncate(6);

    Ok(QuotaSnapshot {
        fetched_at: now_millis(),
        plan,
        plan_expires_at: record.credentials.plan_expires_at,
        metrics,
        error: None,
    })
}
