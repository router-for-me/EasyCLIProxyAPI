use super::common::{build_http_client, token_needs_refresh};
use crate::account_switch::crypto::write_atomic_secure;
use crate::account_switch::oauth_server::{
    bind_loopback_callback, generate_pkce_pair, new_pending_view, register_session,
    update_session_error, update_session_success,
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

const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTH_URL: &str = "https://claude.com/cai/oauth/authorize";
const CLAUDE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code";

pub(crate) fn claude_dir(home: &Path) -> PathBuf {
    crate::agents::agent_config_paths(crate::AgentClient::ClaudeCode, home)
        .into_iter()
        .next()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| home.join(".claude"))
}

pub(crate) fn credentials_path(home: &Path) -> PathBuf {
    claude_dir(home).join(".credentials.json")
}

pub(crate) fn claude_state_path(home: &Path) -> PathBuf {
    home.join(".claude.json")
}

pub(crate) fn is_installed(home: &Path) -> bool {
    claude_dir(home).is_dir()
        || claude_state_path(home).is_file()
        || crate::agents::find_agent_executable(crate::AgentClient::ClaudeCode, home)
            .is_some()
}

fn read_raw_credentials_json(home: &Path) -> Option<String> {
    let path = credentials_path(home);
    if path.is_file() {
        if let Ok(content) = fs::read_to_string(&path) {
            if !content.trim().is_empty() {
                return Some(content);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-w",
                "-s",
                "Claude Code-credentials",
            ])
            .output()
        {
            if output.status.success() {
                let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }
    None
}

pub(crate) fn read_local_account(home: &Path) -> Result<Option<AccountRecord>, String> {
    let Some(raw) = read_raw_credentials_json(home) else {
        return Ok(None);
    };
    let root: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid Claude Code credentials JSON: {error}"))?;
    let Some(oauth) = root.get("claudeAiOauth").and_then(Value::as_object) else {
        return Ok(None);
    };
    let access_token = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let refresh_token = oauth
        .get("refreshToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    if access_token.is_none() && refresh_token.is_none() {
        return Ok(None);
    }
    let expires_at = oauth
        .get("expiresAt")
        .and_then(Value::as_i64)
        .map(|v| if v > 1_000_000_000_000 { v / 1000 } else { v });
    let plan_type = oauth
        .get("subscriptionType")
        .and_then(Value::as_str)
        .map(str::to_string);
    let scopes = oauth
        .get("scopes")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        });

    // Enrich email / accountUuid from ~/.claude.json if available.
    let mut email = None;
    let mut account_id = None;
    let mut org_id = None;
    if let Ok(state_raw) = fs::read_to_string(claude_state_path(home)) {
        if let Ok(state_json) = serde_json::from_str::<Value>(&state_raw) {
            if let Some(acct) = state_json.get("oauthAccount").and_then(Value::as_object) {
                email = acct
                    .get("emailAddress")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                account_id = acct
                    .get("accountUuid")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                org_id = acct
                    .get("organizationUuid")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
    }

    let label = email
        .clone()
        .or_else(|| account_id.clone())
        .unwrap_or_else(|| "Claude Code Account".to_string());
    let fingerprint = compute_fingerprint(
        SwitchPlatformId::ClaudeCode,
        &[
            email.as_deref(),
            account_id.as_deref(),
            refresh_token.as_deref().map(|s| &s[..s.len().min(24)]),
        ],
    );
    let now = now_millis();

    Ok(Some(AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform: SwitchPlatformId::ClaudeCode,
        label,
        email,
        account_id: account_id.clone(),
        plan_type,
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
            scope: scopes,
            expires_at,
            account_id,
            organization_id: org_id,
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
        .ok_or("Claude Code account is missing access_token")?;
    let refresh_token = record
        .credentials
        .refresh_token
        .as_deref()
        .unwrap_or_default();
    let expires_ms = record
        .credentials
        .expires_at
        .map(|v| if v > 1_000_000_000_000 { v } else { v * 1000 })
        .unwrap_or_else(|| now_millis() + 3_600_000);
    let scopes: Vec<String> = record
        .credentials
        .scope
        .as_deref()
        .unwrap_or(CLAUDE_SCOPES)
        .split_whitespace()
        .map(str::to_string)
        .collect();

    let cred_path = credentials_path(home);
    let mut root: Map<String, Value> = if cred_path.is_file() {
        fs::read_to_string(&cred_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };

    let mut oauth_obj = Map::new();
    oauth_obj.insert("accessToken".into(), json!(access_token));
    oauth_obj.insert("refreshToken".into(), json!(refresh_token));
    oauth_obj.insert("expiresAt".into(), json!(expires_ms));
    oauth_obj.insert("scopes".into(), json!(scopes));
    if let Some(plan) = record.plan_type.as_deref() {
        oauth_obj.insert("subscriptionType".into(), json!(plan));
    }
    root.insert("claudeAiOauth".into(), Value::Object(oauth_obj));

    let payload = serde_json::to_vec_pretty(&Value::Object(root))
        .map_err(|error| format!("Failed to serialize Claude Code credentials: {error}"))?;
    write_atomic_secure(&cred_path, &payload)?;

    #[cfg(target_os = "macos")]
    {
        let user = std::env::var("USER").unwrap_or_else(|_| "claude".to_string());
        let payload_str = String::from_utf8_lossy(&payload);
        let _ = std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-U",
                "-a",
                &user,
                "-s",
                "Claude Code-credentials",
                "-w",
                &payload_str,
            ])
            .output();
    }

    // Sync ~/.claude.json oauthAccount + onboarding marker.
    let state_path = claude_state_path(home);
    let mut state_root: Map<String, Value> = if state_path.is_file() {
        fs::read_to_string(&state_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };
    let mut oauth_account = state_root
        .get("oauthAccount")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(email) = record.email.as_deref() {
        oauth_account.insert("emailAddress".into(), json!(email));
    }
    if let Some(acct_uuid) = record
        .credentials
        .account_id
        .as_deref()
        .or(record.account_id.as_deref())
    {
        oauth_account.insert("accountUuid".into(), json!(acct_uuid));
    }
    if let Some(org_uuid) = record.credentials.organization_id.as_deref() {
        oauth_account.insert("organizationUuid".into(), json!(org_uuid));
    }
    if !oauth_account.is_empty() {
        state_root.insert("oauthAccount".into(), Value::Object(oauth_account));
    }
    state_root.insert("hasCompletedOnboarding".into(), json!(true));
    let state_bytes = serde_json::to_vec_pretty(&Value::Object(state_root))
        .map_err(|error| format!("Failed to serialize ~/.claude.json: {error}"))?;
    write_atomic_secure(&state_path, &state_bytes)?;

    Ok(())
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
        .ok_or("Claude Code account does not have a refresh_token")?
        .to_string();

    let client = build_http_client(proxy_url)?;
    let resp = client
        .post(CLAUDE_TOKEN_URL)
        .json(&json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLAUDE_CLIENT_ID,
            "scope": record.credentials.scope.as_deref().unwrap_or(CLAUDE_SCOPES),
        }))
        .send()
        .await
        .map_err(|error| format!("Claude OAuth refresh failed: {error}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|error| format!("Failed to read Claude refresh response: {error}"))?;
    if !status.is_success() {
        return Err(format!("Claude OAuth refresh failed ({status}): {body}"));
    }
    let json: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid Claude OAuth refresh JSON: {error}"))?;
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
    let access_token = record
        .credentials
        .access_token
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Missing Claude Code access_token")?;
    let client = build_http_client(proxy_url)?;
    let resp = client
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Claude usage request failed: {error}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|error| format!("Failed to read Claude usage response: {error}"))?;
    if !status.is_success() {
        return Err(format!("Claude usage API error ({status})"));
    }
    let json: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid Claude usage JSON: {error}"))?;

    let mut metrics = Vec::new();
    for (field, id, label) in [
        ("five_hour", "5h", "5h Session"),
        ("seven_day", "7d", "7d All Models"),
        ("seven_day_sonnet", "7d_sonnet", "7d Sonnet"),
        ("seven_day_opus", "7d_opus", "7d Opus"),
    ] {
        if let Some(win) = json.get(field).filter(|v| v.is_object()) {
            let used = win.get("utilization").and_then(Value::as_f64);
            let remaining = used.map(|u| (100.0 - u).clamp(0.0, 100.0));
            let reset_at = win
                .get("resets_at")
                .and_then(Value::as_str)
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp());
            metrics.push(QuotaMetric {
                id: id.to_string(),
                label: label.to_string(),
                remaining_percent: remaining,
                used_percent: used,
                reset_at,
                detail: None,
            });
        }
    }

    Ok(QuotaSnapshot {
        fetched_at: now_millis(),
        plan: record.plan_type.clone(),
        plan_expires_at: record.credentials.plan_expires_at,
        metrics,
        error: None,
    })
}

pub(crate) async fn start_oauth_login(
    vault_root: PathBuf,
    proxy_url: Option<String>,
) -> Result<OAuthSessionView, String> {
    let (verifier, challenge, state) = generate_pkce_pair()?;
    let cancel = CancellationToken::new();
    let (port, rx) =
        bind_loopback_callback(0, true, "/callback", state.clone(), cancel.clone()).await?;
    let redirect_uri = format!("http://localhost:{port}/callback");
    let mut auth_url = url::Url::parse(CLAUDE_AUTH_URL).map_err(|e| e.to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", CLAUDE_CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", CLAUDE_SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state);

    let view = new_pending_view(
        SwitchPlatformId::ClaudeCode,
        "pkce_browser",
        Some(auth_url.to_string()),
        None,
        None,
        Some(300),
    );
    let session_id = view.session_id.clone();
    register_session(view.clone(), cancel);

    tokio::spawn(async move {
        let cb = match rx.await {
            Ok(Ok(cb)) => cb,
            Ok(Err(err)) => {
                update_session_error(&session_id, err);
                return;
            }
            Err(_) => {
                update_session_error(&session_id, "OAuth callback channel closed".into());
                return;
            }
        };

        let result: Result<AccountRecord, String> = async {
            let client = build_http_client(proxy_url.as_deref())?;
            let resp = client
                .post(CLAUDE_TOKEN_URL)
                .json(&json!({
                    "grant_type": "authorization_code",
                    "code": cb.code,
                    "state": cb.state.unwrap_or_default(),
                    "client_id": CLAUDE_CLIENT_ID,
                    "redirect_uri": redirect_uri,
                    "code_verifier": verifier,
                }))
                .send()
                .await
                .map_err(|e| format!("Claude token exchange failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("Claude token exchange error ({status}): {body}"));
            }
            let token_json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
            let access_token = token_json
                .get("access_token")
                .and_then(Value::as_str)
                .map(str::to_string);
            let refresh_token = token_json
                .get("refresh_token")
                .and_then(Value::as_str)
                .map(str::to_string);
            let expires_at = token_json
                .get("expires_in")
                .and_then(Value::as_i64)
                .map(|s| now_secs() + s);
            let email = token_json
                .get("account")
                .and_then(|a| a.get("email_address"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let account_id = token_json
                .get("account")
                .and_then(|a| a.get("uuid"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let org_id = token_json
                .get("organization")
                .and_then(|o| o.get("uuid"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let label = email
                .clone()
                .or_else(|| account_id.clone())
                .unwrap_or_else(|| "Claude Code Account".to_string());
            let fingerprint = compute_fingerprint(
                SwitchPlatformId::ClaudeCode,
                &[
                    email.as_deref(),
                    account_id.as_deref(),
                    refresh_token.as_deref().map(|s| &s[..s.len().min(24)]),
                ],
            );
            let now = now_millis();
            Ok(AccountRecord {
                id: uuid::Uuid::new_v4().to_string(),
                platform: SwitchPlatformId::ClaudeCode,
                label,
                email,
                account_id: account_id.clone(),
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
                    scope: Some(CLAUDE_SCOPES.to_string()),
                    expires_at,
                    account_id,
                    organization_id: org_id,
                    ..Default::default()
                },
            })
        }
        .await;

        match result {
            Ok(record) => match AccountVault::for_root(vault_root)
                .and_then(|vault| vault.upsert_record(record).map(|(saved, _)| (vault, saved)))
            {
                Ok((vault, saved)) => {
                    let active = vault
                        .get_active_account_id(SwitchPlatformId::ClaudeCode)
                        .ok()
                        .flatten();
                    update_session_success(&session_id, saved.to_summary(active.as_deref()));
                }
                Err(err) => update_session_error(&session_id, err),
            },
            Err(err) => update_session_error(&session_id, err),
        }
    });

    Ok(view)
}
