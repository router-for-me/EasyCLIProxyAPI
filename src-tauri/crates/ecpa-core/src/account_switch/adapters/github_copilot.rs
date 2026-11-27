use super::common::build_http_client;
use crate::account_switch::crypto::{os_crypt, write_atomic_secure};
use crate::account_switch::oauth_server::{
    new_pending_view, register_session, update_session_error, update_session_success,
};
use crate::account_switch::types::{
    compute_fingerprint, now_millis, AccountRecord, AccountSource, OAuthSessionView,
    PlatformCredentials, QuotaMetric, QuotaSnapshot, SwitchPlatformId,
};
use crate::account_switch::vault::AccountVault;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

const GITHUB_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL: &str = "https://api.github.com/user";
const COPILOT_USER_URL: &str = "https://api.github.com/copilot_internal/user";
const VSCODE_GITHUB_AUTH_KEY: &str =
    r#"secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}"#;

#[cfg(target_os = "macos")]
const MACOS_VSCODE_KEYCHAIN: &[(&str, Option<&str>)] = &[
    ("Code Safe Storage", Some("Code")),
    ("Code Safe Storage", Some("Code Key")),
    ("Code Safe Storage", None),
];
#[cfg(not(target_os = "macos"))]
const MACOS_VSCODE_KEYCHAIN: &[(&str, Option<&str>)] = &[];
const LINUX_VSCODE_APPS: &[&str] = &["code", "Code", "vscode"];

pub(crate) fn vscode_data_root(home: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Code")
    }
    #[cfg(target_os = "macos")]
    {
        home.join("Library").join("Application Support").join("Code")
    }
    #[cfg(target_os = "linux")]
    {
        home.join(".config").join("Code")
    }
}

pub(crate) fn vscode_state_db(data_root: &Path) -> PathBuf {
    data_root
        .join("User")
        .join("globalStorage")
        .join("state.vscdb")
}

fn copilot_hosts_path(home: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
            .join("github-copilot")
            .join("hosts.json")
    }
    #[cfg(not(target_os = "windows"))]
    {
        home.join(".config")
            .join("github-copilot")
            .join("hosts.json")
    }
}

pub(crate) fn is_installed(home: &Path) -> bool {
    vscode_state_db(&vscode_data_root(home)).is_file()
        || copilot_hosts_path(home).is_file()
        || crate::agents::find_agent_executable(crate::AgentClient::VscodeCopilot, home)
            .is_some()
        || crate::agents::find_agent_executable(crate::AgentClient::CopilotCli, home)
            .is_some()
}

pub(crate) fn read_local_account(home: &Path) -> Result<Option<AccountRecord>, String> {
    // 1. Try VS Code state.vscdb encrypted GitHub Auth session.
    let data_root = vscode_data_root(home);
    let db_path = vscode_state_db(&data_root);
    if db_path.is_file() {
        if let Ok(conn) = Connection::open(&db_path) {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT value FROM ItemTable WHERE key = ?1",
                    [VSCODE_GITHUB_AUTH_KEY],
                    |row| row.get(0),
                )
                .optional()
                .ok()
                .flatten();
            if let Some(raw_val) = raw {
                if let Some(enc_bytes) = os_crypt::decode_buffer_json(&raw_val) {
                    if let Ok(plain) = os_crypt::decrypt_electron_secret(
                        &data_root,
                        &enc_bytes,
                        MACOS_VSCODE_KEYCHAIN,
                        LINUX_VSCODE_APPS,
                    ) {
                        if let Ok(sessions) = serde_json::from_slice::<Value>(&plain) {
                            if let Some(first) = sessions.as_array().and_then(|arr| arr.first()) {
                                let token = first
                                    .get("accessToken")
                                    .and_then(Value::as_str)
                                    .map(str::to_string);
                                let login = first
                                    .get("account")
                                    .and_then(|a| a.get("label"))
                                    .and_then(Value::as_str)
                                    .map(str::to_string);
                                let account_id = first
                                    .get("account")
                                    .and_then(|a| a.get("id"))
                                    .and_then(Value::as_str)
                                    .map(str::to_string);
                                if token.is_some() {
                                    return Ok(Some(build_copilot_record(
                                        token.unwrap_or_default(),
                                        login,
                                        account_id,
                                        None,
                                        AccountSource::Local,
                                    )));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Fallback to github-copilot/hosts.json.
    let hosts_path = copilot_hosts_path(home);
    if hosts_path.is_file() {
        if let Ok(raw) = fs::read_to_string(&hosts_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if let Some(entry) = val
                    .as_object()
                    .and_then(|obj| obj.get("github.com").or_else(|| obj.values().next()))
                {
                    if let Some(token) = entry
                        .get("oauth_token")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        let user = entry
                            .get("user")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        return Ok(Some(build_copilot_record(
                            token.to_string(),
                            user,
                            None,
                            None,
                            AccountSource::Local,
                        )));
                    }
                }
            }
        }
    }
    Ok(None)
}

fn build_copilot_record(
    token: String,
    login: Option<String>,
    account_id: Option<String>,
    email: Option<String>,
    source: AccountSource,
) -> AccountRecord {
    let label = login
        .clone()
        .or_else(|| email.clone())
        .or_else(|| account_id.clone())
        .unwrap_or_else(|| "GitHub Copilot".to_string());
    let fingerprint = compute_fingerprint(
        SwitchPlatformId::GithubCopilot,
        &[
            login.as_deref(),
            account_id.as_deref(),
            email.as_deref(),
            Some(&token[..token.len().min(20)]),
        ],
    );
    let now = now_millis();
    AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform: SwitchPlatformId::GithubCopilot,
        label,
        email,
        account_id: account_id.or(login),
        plan_type: None,
        fingerprint,
        tags: Vec::new(),
        group_id: None,
        notes: None,
        source,
        created_at: now,
        updated_at: now,
        last_used_at: None,
        last_quota: None,
        credentials: PlatformCredentials {
            access_token: Some(token),
            ..Default::default()
        },
    }
}

pub(crate) fn apply_account(home: &Path, record: &AccountRecord) -> Result<(), String> {
    let token = record
        .credentials
        .access_token
        .as_deref()
        .or(record.credentials.session_token.as_deref())
        .filter(|v| !v.trim().is_empty())
        .ok_or("GitHub Copilot account is missing OAuth access token")?;
    let account_label = record
        .account_id
        .as_deref()
        .unwrap_or(record.label.as_str());

    // 1. Write github-copilot/hosts.json (used by Copilot CLI / Neovim / JetBrains / fallback).
    let hosts_path = copilot_hosts_path(home);
    let mut hosts_root: Map<String, Value> = if hosts_path.is_file() {
        fs::read_to_string(&hosts_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };
    hosts_root.insert(
        "github.com".to_string(),
        json!({
            "user": account_label,
            "oauth_token": token,
            "githubAppId": GITHUB_CLIENT_ID
        }),
    );
    let hosts_bytes = serde_json::to_vec_pretty(&Value::Object(hosts_root))
        .map_err(|e| format!("Failed to serialize hosts.json: {e}"))?;
    write_atomic_secure(&hosts_path, &hosts_bytes)?;

    // 2. Inject into VS Code state.vscdb if VS Code profile exists.
    let data_root = vscode_data_root(home);
    let db_path = vscode_state_db(&data_root);
    if db_path.is_file() {
        let sessions = json!([{
            "id": uuid::Uuid::new_v4().to_string(),
            "accessToken": token,
            "account": {
                "label": account_label,
                "id": record.account_id.as_deref().unwrap_or(account_label),
            },
            "scopes": ["read:user", "user:email"]
        }]);
        let plain = serde_json::to_vec(&sessions).map_err(|e| e.to_string())?;
        if let Ok(encrypted) = os_crypt::encrypt_electron_secret(
            &data_root,
            &plain,
            MACOS_VSCODE_KEYCHAIN,
            LINUX_VSCODE_APPS,
            None,
        ) {
            let encoded = os_crypt::encode_buffer_json(&encrypted)?;
            let conn = Connection::open(&db_path)
                .map_err(|error| format!("Failed to open VS Code state.vscdb: {error}"))?;
            conn.execute(
                "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
                params![VSCODE_GITHUB_AUTH_KEY, encoded],
            )
            .map_err(|error| format!("Failed to write VS Code github.auth: {error}"))?;
        }
    }

    Ok(())
}

pub(crate) async fn fetch_quota(
    record: &AccountRecord,
    proxy_url: Option<&str>,
) -> Result<QuotaSnapshot, String> {
    let token = record
        .credentials
        .access_token
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Missing GitHub Copilot token")?;
    let client = build_http_client(proxy_url)?;
    let resp = client
        .get(COPILOT_USER_URL)
        .header("Authorization", format!("token {token}"))
        .header("Accept", "application/json")
        .header("Editor-Version", "vscode/1.99.0")
        .send()
        .await
        .map_err(|error| format!("GitHub Copilot quota request failed: {error}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("GitHub Copilot API error ({status})"));
    }
    let val: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid GitHub Copilot quota JSON: {error}"))?;

    let plan = val
        .get("copilot_plan")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| record.plan_type.clone());

    let mut metrics = Vec::new();
    let reset_at = val
        .get("quota_reset_date")
        .and_then(Value::as_str)
        .and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.timestamp())
                .or_else(|| {
                    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                        .ok()
                        .and_then(|d| d.and_hms_opt(0, 0, 0))
                        .map(|dt| dt.and_utc().timestamp())
                })
        });

    if let Some(snapshots) = val.get("quota_snapshots").and_then(Value::as_object) {
        for (key, label) in [
            ("premium_interactions", "Premium Requests"),
            ("chat", "Chat"),
            ("completions", "Completions"),
        ] {
            if let Some(item) = snapshots.get(key).filter(|v| v.is_object()) {
                let unlimited = item
                    .get("unlimited")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let pct = if unlimited {
                    Some(100.0)
                } else {
                    item.get("percent_remaining").and_then(Value::as_f64)
                };
                let detail = if unlimited {
                    Some("Unlimited".to_string())
                } else if let (Some(rem), Some(ent)) = (
                    item.get("remaining").and_then(Value::as_i64),
                    item.get("entitlement").and_then(Value::as_i64),
                ) {
                    Some(format!("{rem} / {ent}"))
                } else {
                    None
                };
                metrics.push(QuotaMetric {
                    id: key.to_string(),
                    label: label.to_string(),
                    remaining_percent: pct,
                    used_percent: pct.map(|p| (100.0 - p).clamp(0.0, 100.0)),
                    reset_at,
                    detail,
                });
            }
        }
    }

    let plan_expires_at = crate::account_switch::cpa_import::parse_expiry_timestamp(
        val.get("limited_user_reset_date")
            .or_else(|| val.get("plan_expires_at"))
            .or_else(|| val.get("subscription_expires_at")),
    )
    .or(record.credentials.plan_expires_at);

    Ok(QuotaSnapshot {
        fetched_at: now_millis(),
        plan,
        plan_expires_at,
        metrics,
        error: None,
    })
}

pub(crate) async fn start_oauth_login(
    vault_root: PathBuf,
    proxy_url: Option<String>,
) -> Result<OAuthSessionView, String> {
    let client = build_http_client(proxy_url.as_deref())?;
    let resp = client
        .post(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", GITHUB_CLIENT_ID), ("scope", "read:user user:email")])
        .send()
        .await
        .map_err(|error| format!("GitHub device flow start failed: {error}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("GitHub device flow failed ({status}): {body}"));
    }
    let init: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let device_code = init
        .get("device_code")
        .and_then(Value::as_str)
        .ok_or("Missing device_code in GitHub response")?
        .to_string();
    let user_code = init
        .get("user_code")
        .and_then(Value::as_str)
        .map(str::to_string);
    let verification_uri = init
        .get("verification_uri")
        .and_then(Value::as_str)
        .map(str::to_string);
    let interval = init.get("interval").and_then(Value::as_u64).unwrap_or(5);
    let expires_in = init.get("expires_in").and_then(Value::as_u64).unwrap_or(900);

    let view = new_pending_view(
        SwitchPlatformId::GithubCopilot,
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
                _ = tokio::time::sleep(std::time::Duration::from_secs(interval.max(5))) => {}
            }
            if tokio::time::Instant::now() >= deadline {
                update_session_error(&session_id, "GitHub device code expired".into());
                return;
            }
            let Ok(resp) = client
                .post(GITHUB_TOKEN_URL)
                .header("Accept", "application/json")
                .form(&[
                    ("client_id", GITHUB_CLIENT_ID),
                    ("device_code", device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .send()
                .await
            else {
                continue;
            };
            let Ok(text) = resp.text().await else { continue };
            let Ok(val) = serde_json::from_str::<Value>(&text) else { continue };
            if let Some(err) = val.get("error").and_then(Value::as_str) {
                if matches!(err, "authorization_pending" | "slow_down") {
                    continue;
                }
                update_session_error(&session_id, format!("GitHub login error: {err}"));
                return;
            }
            let Some(access_token) = val
                .get("access_token")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };

            let (login, account_id, email) = match client
                .get(GITHUB_USER_URL)
                .header("Authorization", format!("token {access_token}"))
                .header("Accept", "application/json")
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => r
                    .json::<Value>()
                    .await
                    .ok()
                    .map(|u| {
                        (
                            u.get("login").and_then(Value::as_str).map(str::to_string),
                            u.get("id").and_then(Value::as_i64).map(|id| id.to_string()),
                            u.get("email").and_then(Value::as_str).map(str::to_string),
                        )
                    })
                    .unwrap_or((None, None, None)),
                _ => (None, None, None),
            };

            let record = build_copilot_record(
                access_token,
                login,
                account_id,
                email,
                AccountSource::Oauth,
            );
            match AccountVault::for_root(vault_root)
                .and_then(|vault| vault.upsert_record(record).map(|(saved, _)| (vault, saved)))
            {
                Ok((vault, saved)) => {
                    let active = vault
                        .get_active_account_id(SwitchPlatformId::GithubCopilot)
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
