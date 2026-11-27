use super::common::{build_http_client, token_needs_refresh};
use crate::account_switch::crypto::write_atomic_secure;
use crate::account_switch::oauth_server::{
    new_pending_view, register_session, update_session_error, update_session_success,
};
use crate::account_switch::types::{
    compute_fingerprint, now_millis, now_secs, AccountRecord, AccountSource, OAuthSessionView,
    PlatformCredentials, QuotaMetric, QuotaSnapshot, SwitchPlatformId,
};
use crate::account_switch::vault::AccountVault;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

const XAI_DEVICE_CODE_URL: &str = "https://accounts.x.ai/oauth2/device/code";
const XAI_TOKEN_URL: &str = "https://accounts.x.ai/oauth2/token";
const XAI_CLIENT_ID: &str = "grok-cli";
const XAI_ME_URL: &str = "https://api.x.ai/v1/me";

pub(crate) fn grok_dir(home: &Path) -> PathBuf {
    crate::agents::agent_config_paths(crate::AgentClient::GrokBuild, home)
        .into_iter()
        .next()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| home.join(".grok"))
}

pub(crate) fn auth_path(home: &Path) -> PathBuf {
    grok_dir(home).join("auth.json")
}

pub(crate) fn is_installed(home: &Path) -> bool {
    grok_dir(home).is_dir()
        || crate::agents::find_agent_executable(crate::AgentClient::GrokBuild, home)
            .is_some()
}

pub(crate) fn read_local_account(home: &Path) -> Result<Option<AccountRecord>, String> {
    let path = auth_path(home);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read Grok auth.json: {error}"))?;
    let root: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid Grok auth.json: {error}"))?;

    // Official Grok auth registry stores credentials under `default` or top-level token fields.
    let entry = root
        .get("entries")
        .and_then(|e| e.get("default").or_else(|| e.as_object()?.values().next()))
        .or_else(|| root.get("oauth"))
        .unwrap_or(&root);

    let access_token = entry
        .get("access_token")
        .or_else(|| entry.get("accessToken"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let refresh_token = entry
        .get("refresh_token")
        .or_else(|| entry.get("refreshToken"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let api_key = entry
        .get("api_key")
        .or_else(|| entry.get("apiKey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);

    if access_token.is_none() && refresh_token.is_none() && api_key.is_none() {
        return Ok(None);
    }

    let email = entry
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_string);
    let account_id = entry
        .get("user_id")
        .or_else(|| entry.get("userId"))
        .or_else(|| entry.get("sub"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let expires_at = entry
        .get("expires_at")
        .or_else(|| entry.get("expiresAt"))
        .and_then(Value::as_i64)
        .map(|v| if v > 1_000_000_000_000 { v / 1000 } else { v });
    let label = email
        .clone()
        .or_else(|| account_id.clone())
        .unwrap_or_else(|| "Grok / xAI Account".to_string());
    let fingerprint = compute_fingerprint(
        SwitchPlatformId::Grok,
        &[
            email.as_deref(),
            account_id.as_deref(),
            refresh_token.as_deref().map(|s| &s[..s.len().min(24)]),
            api_key.as_deref().map(|s| &s[..s.len().min(24)]),
        ],
    );
    let now = now_millis();

    Ok(Some(AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform: SwitchPlatformId::Grok,
        label,
        email,
        account_id: account_id.clone(),
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
            api_key,
            expires_at,
            account_id,
            ..Default::default()
        },
    }))
}

pub(crate) fn apply_account(home: &Path, record: &AccountRecord) -> Result<(), String> {
    let path = auth_path(home);
    let mut root: Map<String, Value> = if path.is_file() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    let token = record
        .credentials
        .access_token
        .as_deref()
        .or(record.credentials.api_key.as_deref())
        .filter(|v| !v.trim().is_empty())
        .ok_or("Grok account is missing access_token or api_key")?;

    let mut default_entry = Map::new();
    if let Some(access) = record.credentials.access_token.as_deref() {
        default_entry.insert("access_token".into(), json!(access));
    }
    if let Some(refresh) = record.credentials.refresh_token.as_deref() {
        default_entry.insert("refresh_token".into(), json!(refresh));
    }
    if let Some(api_key) = record.credentials.api_key.as_deref() {
        default_entry.insert("api_key".into(), json!(api_key));
    }
    if let Some(exp) = record.credentials.expires_at {
        default_entry.insert("expires_at".into(), json!(exp));
    }
    if let Some(email) = record.email.as_deref() {
        default_entry.insert("email".into(), json!(email));
    }
    if let Some(uid) = record
        .credentials
        .account_id
        .as_deref()
        .or(record.account_id.as_deref())
    {
        default_entry.insert("user_id".into(), json!(uid));
    }
    default_entry.insert("updated_at".into(), json!(chrono::Utc::now().to_rfc3339()));

    // Preserve any existing scoped entries in `entries` while updating `default` + top-level keys.
    let entries = root
        .entry("entries".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(entries_obj) = entries.as_object_mut() {
        entries_obj.insert("default".into(), Value::Object(default_entry));
    }
    root.insert("access_token".into(), json!(token));
    if let Some(refresh) = record.credentials.refresh_token.as_deref() {
        root.insert("refresh_token".into(), json!(refresh));
    }
    if let Some(email) = record.email.as_deref() {
        root.insert("email".into(), json!(email));
    }

    let bytes = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|error| format!("Failed to serialize Grok auth.json: {error}"))?;
    write_atomic_secure(&path, &bytes)
}

pub(crate) async fn refresh_if_needed(
    record: &mut AccountRecord,
    force: bool,
    proxy_url: Option<&str>,
) -> Result<bool, String> {
    if !force && !token_needs_refresh(record, 300) {
        return Ok(false);
    }
    let refresh_token = record
        .credentials
        .refresh_token
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Grok account does not have a refresh_token")?
        .to_string();

    let client = build_http_client(proxy_url)?;
    let resp = client
        .post(XAI_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", XAI_CLIENT_ID),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Grok token refresh failed: {error}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Grok token refresh error ({status}): {body}"));
    }
    let json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if let Some(access) = json.get("access_token").and_then(Value::as_str) {
        record.credentials.access_token = Some(access.to_string());
    }
    if let Some(refresh) = json.get("refresh_token").and_then(Value::as_str) {
        record.credentials.refresh_token = Some(refresh.to_string());
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
    let token = record
        .credentials
        .access_token
        .as_deref()
        .or(record.credentials.api_key.as_deref())
        .filter(|v| !v.trim().is_empty())
        .ok_or("Missing Grok credential token")?;
    let client = build_http_client(proxy_url)?;
    let resp = client
        .get(XAI_ME_URL)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Grok profile check failed: {error}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Grok API status error ({status})"));
    }
    let val: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({}));
    let plan = val
        .get("tier")
        .or_else(|| val.get("plan"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| Some("Active".to_string()));
    let team_id = val
        .get("team_id")
        .or_else(|| val.get("teamId"))
        .and_then(Value::as_str)
        .map(|id| format!("Team: {id}"));

    Ok(QuotaSnapshot {
        fetched_at: now_millis(),
        plan,
        plan_expires_at: record.credentials.plan_expires_at,
        metrics: vec![QuotaMetric {
            id: "status".to_string(),
            label: "xAI Session".to_string(),
            remaining_percent: Some(100.0),
            used_percent: Some(0.0),
            reset_at: None,
            detail: team_id,
        }],
        error: None,
    })
}

pub(crate) async fn start_oauth_login(
    vault_root: PathBuf,
    proxy_url: Option<String>,
) -> Result<OAuthSessionView, String> {
    let client = build_http_client(proxy_url.as_deref())?;
    let resp = client
        .post(XAI_DEVICE_CODE_URL)
        .form(&[("client_id", XAI_CLIENT_ID), ("scope", "openid profile email offline_access")])
        .send()
        .await
        .map_err(|error| format!("Failed to initiate Grok device login: {error}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Grok device login initiation failed ({status}): {body}"));
    }
    let init: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let device_code = init
        .get("device_code")
        .and_then(Value::as_str)
        .ok_or("Missing device_code in Grok response")?
        .to_string();
    let user_code = init
        .get("user_code")
        .and_then(Value::as_str)
        .map(str::to_string);
    let verification_uri = init
        .get("verification_uri_complete")
        .or_else(|| init.get("verification_uri"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let interval = init.get("interval").and_then(Value::as_u64).unwrap_or(5);
    let expires_in = init.get("expires_in").and_then(Value::as_u64).unwrap_or(300);

    let view = new_pending_view(
        SwitchPlatformId::Grok,
        "device_code",
        verification_uri.clone(),
        user_code,
        verification_uri,
        Some(expires_in),
    );
    let session_id = view.session_id.clone();
    let cancel = CancellationToken::new();
    register_session(view.clone(), cancel.clone());

    tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(expires_in);
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(std::time::Duration::from_secs(interval.max(3))) => {}
            }
            if tokio::time::Instant::now() >= deadline {
                update_session_error(&session_id, "Grok device code expired".into());
                return;
            }
            let Ok(resp) = client
                .post(XAI_TOKEN_URL)
                .form(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ("device_code", device_code.as_str()),
                    ("client_id", XAI_CLIENT_ID),
                ])
                .send()
                .await
            else {
                continue;
            };
            let status = resp.status();
            let Ok(text) = resp.text().await else { continue };
            let Ok(val) = serde_json::from_str::<Value>(&text) else { continue };
            if !status.is_success() {
                match val.get("error").and_then(Value::as_str) {
                    Some("authorization_pending" | "slow_down") => continue,
                    Some(err) => {
                        update_session_error(&session_id, format!("Grok login failed: {err}"));
                        return;
                    }
                    None => continue,
                }
            }
            let access_token = val
                .get("access_token")
                .and_then(Value::as_str)
                .map(str::to_string);
            let refresh_token = val
                .get("refresh_token")
                .and_then(Value::as_str)
                .map(str::to_string);
            let expires_at = val
                .get("expires_in")
                .and_then(Value::as_i64)
                .map(|s| now_secs() + s);
            let now = now_millis();
            let fingerprint = compute_fingerprint(
                SwitchPlatformId::Grok,
                &[refresh_token.as_deref().or(access_token.as_deref()).map(|s| &s[..s.len().min(24)])],
            );
            let record = AccountRecord {
                id: uuid::Uuid::new_v4().to_string(),
                platform: SwitchPlatformId::Grok,
                label: "Grok / xAI Account".to_string(),
                email: None,
                account_id: None,
                plan_type: None,
                fingerprint,
                tags: Vec::new(),
                group_id: None,
                notes: None,
                source: AccountSource::Oauth,
                created_at: now,
                updated_at: now,
                last_used_at: None,
                last_quota: None,
                credentials: PlatformCredentials {
                    access_token,
                    refresh_token,
                    expires_at,
                    ..Default::default()
                },
            };
            match AccountVault::for_root(vault_root)
                .and_then(|vault| vault.upsert_record(record).map(|(saved, _)| (vault, saved)))
            {
                Ok((vault, saved)) => {
                    let active = vault
                        .get_active_account_id(SwitchPlatformId::Grok)
                        .ok()
                        .flatten();
                    update_session_success(&session_id, saved.to_summary(active.as_deref()));
                }
                Err(err) => update_session_error(&session_id, err),
            }
            return;
        }
    });

    Ok(view)
}
