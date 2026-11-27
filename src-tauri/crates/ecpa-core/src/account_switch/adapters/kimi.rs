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
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

const KIMI_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";

pub(crate) fn kimi_home(home: &Path) -> PathBuf {
    if let Some(dir) = std::env::var_os("KIMI_CODE_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    let modern = home.join(".kimi-code");
    if modern.is_dir() {
        return modern;
    }
    let share = std::env::var_os("KIMI_SHARE_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".kimi"));
    if share.is_dir() {
        return share;
    }
    modern
}

pub(crate) fn credentials_file(home: &Path) -> PathBuf {
    let dir = kimi_home(home).join("credentials");
    let preferred = dir.join("kimi-code.json");
    if preferred.is_file() {
        return preferred;
    }
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|v| v.to_str()) == Some("json") {
                return path;
            }
        }
    }
    preferred
}

pub(crate) fn is_installed(home: &Path) -> bool {
    kimi_home(home).is_dir()
        || crate::agents::find_agent_executable(crate::AgentClient::KimiCode, home)
            .is_some()
}

fn kimi_oauth_host(domain: Option<&str>) -> String {
    if let Some(custom) = std::env::var("KIMI_CODE_OAUTH_HOST")
        .ok()
        .or_else(|| std::env::var("KIMI_OAUTH_HOST").ok())
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
    {
        return custom;
    }
    if domain == Some("ai") {
        "https://auth.kimi.ai".to_string()
    } else {
        "https://auth.kimi.com".to_string()
    }
}

fn kimi_api_host(domain: Option<&str>) -> &'static str {
    if domain == Some("ai") {
        "https://api.kimi.ai"
    } else {
        "https://api.kimi.com"
    }
}

pub(crate) fn read_local_account(home: &Path) -> Result<Option<AccountRecord>, String> {
    let path = credentials_file(home);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read Kimi credentials {}: {error}", path.display()))?;
    let val: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid Kimi credentials JSON: {error}"))?;
    let access_token = val
        .get("access_token")
        .or_else(|| val.get("accessToken"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let refresh_token = val
        .get("refresh_token")
        .or_else(|| val.get("refreshToken"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    if access_token.is_none() && refresh_token.is_none() {
        return Ok(None);
    }
    let expires_at = val
        .get("expires_at")
        .or_else(|| val.get("expiresAt"))
        .and_then(Value::as_i64)
        .map(|v| if v > 1_000_000_000_000 { v / 1000 } else { v });
    let domain = val
        .get("domain")
        .and_then(Value::as_str)
        .map(|s| if s.contains("ai") { "ai" } else { "com" }.to_string())
        .or_else(|| Some("com".to_string()));
    let account_id = val
        .get("user_id")
        .or_else(|| val.get("userId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let email = val.get("email").and_then(Value::as_str).map(str::to_string);
    let label = email
        .clone()
        .or_else(|| account_id.clone())
        .unwrap_or_else(|| format!("Kimi Code (.{})", domain.as_deref().unwrap_or("com")));
    let fingerprint = compute_fingerprint(
        SwitchPlatformId::Kimi,
        &[
            email.as_deref(),
            account_id.as_deref(),
            domain.as_deref(),
            refresh_token.as_deref().map(|s| &s[..s.len().min(24)]),
        ],
    );
    let now = now_millis();

    Ok(Some(AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform: SwitchPlatformId::Kimi,
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
            expires_at,
            account_id,
            domain,
            token_type: val
                .get("token_type")
                .and_then(Value::as_str)
                .map(str::to_string),
            scope: val
                .get("scope")
                .and_then(Value::as_str)
                .map(str::to_string),
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
        .ok_or("Kimi account is missing access_token")?;
    let path = credentials_file(home);
    let domain = record.credentials.domain.as_deref().unwrap_or("com");
    let payload = json!({
        "access_token": access_token,
        "refresh_token": record.credentials.refresh_token.as_deref().unwrap_or_default(),
        "expires_at": record.credentials.expires_at.unwrap_or_else(|| now_secs() + 3600),
        "token_type": record.credentials.token_type.as_deref().unwrap_or("Bearer"),
        "scope": record.credentials.scope.as_deref().unwrap_or("kimi-code"),
        "domain": domain,
        "user_id": record.account_id,
        "email": record.email,
    });
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|error| format!("Failed to serialize Kimi credentials: {error}"))?;
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
        .ok_or("Kimi account does not have a refresh_token")?
        .to_string();
    let host = kimi_oauth_host(record.credentials.domain.as_deref());
    let client = build_http_client(proxy_url)?;
    let resp = client
        .post(format!("{host}/api/oauth/token"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", KIMI_CLIENT_ID),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Kimi token refresh failed: {error}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Kimi token refresh error ({status}): {body}"));
    }
    let val: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if let Some(access) = val.get("access_token").and_then(Value::as_str) {
        record.credentials.access_token = Some(access.to_string());
    }
    if let Some(refresh) = val.get("refresh_token").and_then(Value::as_str) {
        record.credentials.refresh_token = Some(refresh.to_string());
    }
    if let Some(expires_in) = val.get("expires_in").and_then(Value::as_i64) {
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
        .ok_or("Missing Kimi access_token")?;
    let api_host = kimi_api_host(record.credentials.domain.as_deref());
    let client = build_http_client(proxy_url)?;

    let usage_resp = client
        .get(format!("{api_host}/coding/v1/usages"))
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Kimi usage request failed: {error}"))?;
    let status = usage_resp.status();
    let usage_body = usage_resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Kimi usage API error ({status})"));
    }
    let val: Value = serde_json::from_str(&usage_body)
        .map_err(|error| format!("Invalid Kimi usage JSON: {error}"))?;

    let mut plan = record.plan_type.clone();
    if let Ok(me_resp) = client
        .get(format!("{api_host}/coding/v1/me"))
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .send()
        .await
    {
        if me_resp.status().is_success() {
            if let Ok(me_json) = me_resp.json::<Value>().await {
                if let Some(level) = me_json
                    .get("user_level_name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    plan = Some(level.to_string());
                }
            }
        }
    }

    let mut metrics = Vec::new();
    let parse_bucket = |obj: &Value, id: &str, label: &str| -> Option<QuotaMetric> {
        let limit = obj
            .get("limit")
            .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))?;
        let remaining_num = obj
            .get("remaining")
            .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))
            .or_else(|| {
                let used = obj
                    .get("used")
                    .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))?;
                Some((limit - used).max(0.0))
            })?;
        let remaining_pct = if limit > 0.0 {
            (remaining_num / limit * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };
        let reset_at = obj
            .get("resetTime")
            .or_else(|| obj.get("reset_time"))
            .and_then(Value::as_str)
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp());
        Some(QuotaMetric {
            id: id.to_string(),
            label: label.to_string(),
            remaining_percent: Some(remaining_pct),
            used_percent: Some((100.0 - remaining_pct).clamp(0.0, 100.0)),
            reset_at,
            detail: Some(format!("{:.0} / {:.0}", remaining_num, limit)),
        })
    };

    if let Some(usage) = val.get("usage") {
        if let Some(metric) = parse_bucket(usage, "weekly", "Weekly Quota") {
            metrics.push(metric);
        }
    }
    if let Some(limits) = val.get("limits").and_then(Value::as_array) {
        for (idx, item) in limits.iter().enumerate() {
            let detail_obj = item.get("detail").unwrap_or(item);
            let label = item
                .get("window")
                .and_then(|w| w.get("duration"))
                .and_then(Value::as_i64)
                .map(|d| format!("{d}m Window"))
                .unwrap_or_else(|| format!("Window #{}", idx + 1));
            if let Some(metric) = parse_bucket(detail_obj, &format!("limit_{idx}"), &label) {
                metrics.push(metric);
            }
        }
    }

    Ok(QuotaSnapshot {
        fetched_at: now_millis(),
        plan,
        plan_expires_at: record.credentials.plan_expires_at,
        metrics,
        error: None,
    })
}

pub(crate) async fn start_oauth_login(
    vault_root: PathBuf,
    proxy_url: Option<String>,
) -> Result<OAuthSessionView, String> {
    let host = kimi_oauth_host(Some("com"));
    let client = build_http_client(proxy_url.as_deref())?;
    let resp = client
        .post(format!("{host}/api/oauth/device_authorization"))
        .form(&[("client_id", KIMI_CLIENT_ID)])
        .send()
        .await
        .map_err(|error| format!("Failed to start Kimi device authorization: {error}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Kimi device authorization failed ({status}): {body}"));
    }
    let init: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let device_code = init
        .get("device_code")
        .and_then(Value::as_str)
        .ok_or("Missing device_code in Kimi response")?
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
        SwitchPlatformId::Kimi,
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
                update_session_error(&session_id, "Kimi device authorization expired".into());
                return;
            }
            let Ok(resp) = client
                .post(format!("{host}/api/oauth/token"))
                .form(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ("device_code", device_code.as_str()),
                    ("client_id", KIMI_CLIENT_ID),
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
                        update_session_error(&session_id, format!("Kimi login failed: {err}"));
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
                SwitchPlatformId::Kimi,
                &[
                    Some("com"),
                    refresh_token.as_deref().or(access_token.as_deref()).map(|s| &s[..s.len().min(24)]),
                ],
            );
            let record = AccountRecord {
                id: uuid::Uuid::new_v4().to_string(),
                platform: SwitchPlatformId::Kimi,
                label: "Kimi Code Account".to_string(),
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
                    domain: Some("com".to_string()),
                    ..Default::default()
                },
            };
            match AccountVault::for_root(vault_root)
                .and_then(|vault| vault.upsert_record(record).map(|(saved, _)| (vault, saved)))
            {
                Ok((vault, saved)) => {
                    let active = vault
                        .get_active_account_id(SwitchPlatformId::Kimi)
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
