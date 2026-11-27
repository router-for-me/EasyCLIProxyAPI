use super::common::{build_http_client, token_needs_refresh};
use crate::account_switch::cpa_import::{decode_jwt_payload, parse_expiry_timestamp};
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
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_CALLBACK_PORT: u16 = 1455;

pub(crate) fn codex_dir(home: &Path) -> PathBuf {
    crate::agents::codex_configuration_directory(home)
}

pub(crate) fn is_installed(home: &Path) -> bool {
    codex_dir(home).is_dir()
        || crate::agents::find_agent_executable(crate::AgentClient::Codex, home).is_some()
}

pub(crate) fn read_local_account(home: &Path) -> Result<Option<AccountRecord>, String> {
    let dir = codex_dir(home);
    let auth_path = dir.join("auth.json");
    let raw = if auth_path.is_file() {
        fs::read_to_string(&auth_path)
            .map_err(|error| format!("Failed to read Codex auth.json: {error}"))?
    } else {
        #[cfg(target_os = "windows")]
        {
            if let Some(decrypted) = read_windows_codex_secret_store(&dir) {
                decrypted
            } else {
                return Ok(None);
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            return Ok(None);
        }
    };

    let root: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid Codex auth.json: {error}"))?;
    let Some(tokens) = root.get("tokens").and_then(Value::as_object) else {
        return Ok(None);
    };
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let refresh_token = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let id_token = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);

    if access_token.is_none() && refresh_token.is_none() {
        return Ok(None);
    }

    let claims = id_token
        .as_deref()
        .and_then(decode_jwt_payload)
        .or_else(|| access_token.as_deref().and_then(decode_jwt_payload));

    let email = claims.as_ref().and_then(|c| {
        c.get("email")
            .and_then(Value::as_str)
            .or_else(|| {
                c.get("https://api.openai.com/profile")
                    .and_then(|p| p.get("email"))
                    .and_then(Value::as_str)
            })
            .map(str::to_string)
    });
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            claims.as_ref().and_then(|c| {
                c.get("https://api.openai.com/auth")
                    .and_then(|a| a.get("chatgpt_account_id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        });
    let plan_type = claims.as_ref().and_then(|c| {
        c.get("https://api.openai.com/auth")
            .and_then(|a| a.get("chatgpt_plan_type"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let plan_expires_at = claims.as_ref().and_then(|c| {
        parse_expiry_timestamp(
            c.get("https://api.openai.com/auth").and_then(|a| {
                a.get("chatgpt_subscription_active_until")
                    .or_else(|| a.get("subscription_active_until"))
            }),
        )
    });
    let expires_at = claims
        .as_ref()
        .and_then(|c| c.get("exp").and_then(Value::as_i64));

    let label = email
        .clone()
        .or_else(|| account_id.clone())
        .unwrap_or_else(|| "Codex Local Account".to_string());
    let fingerprint = compute_fingerprint(
        SwitchPlatformId::Codex,
        &[
            email.as_deref(),
            account_id.as_deref(),
            refresh_token.as_deref().map(|s| &s[..s.len().min(24)]),
        ],
    );
    let now = now_millis();

    Ok(Some(AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform: SwitchPlatformId::Codex,
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
            id_token,
            expires_at,
            plan_expires_at,
            account_id,
            ..Default::default()
        },
    }))
}

pub(crate) fn apply_account_to_dir(dir: &Path, record: &AccountRecord) -> Result<(), String> {
    let access_token = record
        .credentials
        .access_token
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or("Codex account is missing access_token")?;
    let auth_path = dir.join("auth.json");
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
    tokens.insert("access_token".into(), json!(access_token));
    if let Some(refresh_token) = record.credentials.refresh_token.as_deref() {
        tokens.insert("refresh_token".into(), json!(refresh_token));
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

    let bytes = serde_json::to_vec_pretty(&Value::Object(root.clone()))
        .map_err(|error| format!("Failed to serialize Codex auth.json: {error}"))?;
    write_atomic_secure(&auth_path, &bytes)?;

    #[cfg(target_os = "windows")]
    {
        let _ = sync_windows_codex_secret_store(dir, &bytes);
    }

    Ok(())
}

pub(crate) fn apply_account(home: &Path, record: &AccountRecord) -> Result<(), String> {
    let dir = codex_dir(home);
    apply_account_to_dir(&dir, record)
}

#[cfg(target_os = "windows")]
fn codex_dir_hash_prefix(dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    let canonical = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..16].to_string()
}

#[cfg(target_os = "windows")]
fn read_windows_codex_secret_store(dir: &Path) -> Option<String> {
    let hash = codex_dir_hash_prefix(dir);
    // 1. Direct Windows Credential Manager entry ("Codex Auth" / "cli|<hash>")
    if let Ok(entry) = keyring::Entry::new("Codex Auth", &format!("cli|{hash}")) {
        if let Ok(secret) = entry.get_password() {
            if secret.trim().starts_with('{') {
                return Some(secret);
            }
        }
    }
    // 2. Age-encrypted ~/.codex/secrets/codex_auth.age with passphrase in keyring ("codex" / "secrets|<hash>")
    let age_path = dir.join("secrets").join("codex_auth.age");
    if age_path.is_file() {
        if let Ok(entry) = keyring::Entry::new("codex", &format!("secrets|{hash}")) {
            if let Ok(key_str) = entry.get_password() {
                if let Ok(identity) = key_str.trim().parse::<age::x25519::Identity>() {
                    if let Ok(ciphertext) = fs::read(&age_path) {
                        if let Ok(decryptor) = age::Decryptor::new(&ciphertext[..]) {
                            let mut reader = decryptor
                                .decrypt(std::iter::once(&identity as &dyn age::Identity))
                                .ok()?;
                            let mut plaintext = String::new();
                            use std::io::Read;
                            if reader.read_to_string(&mut plaintext).is_ok() {
                                return Some(plaintext);
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn sync_windows_codex_secret_store(dir: &Path, auth_json_bytes: &[u8]) -> Result<(), String> {
    let hash = codex_dir_hash_prefix(dir);
    let auth_str = String::from_utf8_lossy(auth_json_bytes);
    // Update direct Codex Auth credential if already present in Windows Credential Manager.
    if let Ok(entry) = keyring::Entry::new("Codex Auth", &format!("cli|{hash}")) {
        if entry.get_password().is_ok() {
            let _ = entry.set_password(&auth_str);
        }
    }
    // Update age-encrypted store if present.
    let age_path = dir.join("secrets").join("codex_auth.age");
    if age_path.is_file() {
        if let Ok(entry) = keyring::Entry::new("codex", &format!("secrets|{hash}")) {
            if let Ok(key_str) = entry.get_password() {
                if let Ok(identity) = key_str.trim().parse::<age::x25519::Identity>() {
                    let recipient = identity.to_public();
                    let recipients: [&dyn age::Recipient; 1] = [&recipient];
                    if let Ok(encryptor) =
                        age::Encryptor::with_recipients(recipients.into_iter())
                    {
                        let mut encrypted = Vec::new();
                        if let Ok(mut writer) = encryptor.wrap_output(&mut encrypted) {
                            use std::io::Write;
                            if writer.write_all(auth_json_bytes).is_ok() && writer.finish().is_ok()
                            {
                                let _ = write_atomic_secure(&age_path, &encrypted);
                            }
                        }
                    }
                }
            }
        }
    }
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
        .ok_or("Codex account does not have a refresh_token")?
        .to_string();

    let client = build_http_client(proxy_url)?;
    let resp = client
        .post(CODEX_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CODEX_CLIENT_ID),
            ("refresh_token", refresh_token.as_str()),
            ("scope", "openid profile email"),
        ])
        .send()
        .await
        .map_err(|error| format!("Codex token refresh request failed: {error}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|error| format!("Failed to read Codex refresh response: {error}"))?;
    if !status.is_success() {
        return Err(format!("Codex token refresh failed ({status}): {body}"));
    }
    let json: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid Codex token refresh JSON: {error}"))?;

    if let Some(access) = json.get("access_token").and_then(Value::as_str) {
        record.credentials.access_token = Some(access.to_string());
    }
    if let Some(refresh) = json.get("refresh_token").and_then(Value::as_str) {
        record.credentials.refresh_token = Some(refresh.to_string());
    }
    if let Some(id_token) = json.get("id_token").and_then(Value::as_str) {
        record.credentials.id_token = Some(id_token.to_string());
    }
    if let Some(expires_in) = json.get("expires_in").and_then(Value::as_i64) {
        record.credentials.expires_at = Some(now_secs() + expires_in);
    } else if let Some(exp) = record
        .credentials
        .access_token
        .as_deref()
        .and_then(decode_jwt_payload)
        .and_then(|c| c.get("exp").and_then(Value::as_i64))
    {
        record.credentials.expires_at = Some(exp);
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
        .ok_or("Missing Codex access_token")?;
    let client = build_http_client(proxy_url)?;
    let mut req = client
        .get(CODEX_USAGE_URL)
        .bearer_auth(access_token)
        .header("Accept", "application/json");
    if let Some(account_id) = record
        .credentials
        .account_id
        .as_deref()
        .or(record.account_id.as_deref())
    {
        req = req.header("ChatGPT-Account-Id", account_id);
    }
    let resp = req
        .send()
        .await
        .map_err(|error| format!("Codex quota request failed: {error}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|error| format!("Failed to read Codex quota response: {error}"))?;
    if !status.is_success() {
        return Err(format!("Codex quota API error ({status})"));
    }
    let json: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid Codex quota JSON: {error}"))?;

    let plan = json
        .get("plan_type")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| record.plan_type.clone());
    let mut metrics = Vec::new();
    if let Some(rate_limit) = json.get("rate_limit") {
        for (key, id, label) in [
            ("primary_window", "5h", "5h Window"),
            ("secondary_window", "weekly", "Weekly Window"),
        ] {
            if let Some(win) = rate_limit.get(key).filter(|v| v.is_object()) {
                let used = win.get("used_percent").and_then(Value::as_f64);
                let remaining = used.map(|u| (100.0 - u).clamp(0.0, 100.0));
                let reset_at = win.get("reset_at").and_then(Value::as_i64);
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
    }
    if let Some(code_review) = json
        .get("code_review_rate_limit")
        .and_then(|v| v.get("primary_window"))
        .filter(|v| v.is_object())
    {
        let used = code_review.get("used_percent").and_then(Value::as_f64);
        metrics.push(QuotaMetric {
            id: "code_review".to_string(),
            label: "Code Review".to_string(),
            remaining_percent: used.map(|u| (100.0 - u).clamp(0.0, 100.0)),
            used_percent: used,
            reset_at: code_review.get("reset_at").and_then(Value::as_i64),
            detail: None,
        });
    }

    let plan_expires_at = parse_expiry_timestamp(
        json.get("subscription_active_until")
            .or_else(|| json.get("plan_expires_at"))
            .or_else(|| json.get("active_until")),
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
    let (verifier, challenge, state) = generate_pkce_pair()?;
    let cancel = CancellationToken::new();
    let (port, rx) =
        bind_loopback_callback(CODEX_CALLBACK_PORT, true, "/auth/callback", state.clone(), cancel.clone())
            .await?;
    let redirect_uri = format!("http://localhost:{port}/auth/callback");
    let mut auth_url = url::Url::parse(CODEX_AUTH_URL).map_err(|e| e.to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CODEX_CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", "openid profile email offline_access")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", &state);

    let view = new_pending_view(
        SwitchPlatformId::Codex,
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
                .post(CODEX_TOKEN_URL)
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("code", cb.code.as_str()),
                    ("redirect_uri", redirect_uri.as_str()),
                    ("client_id", CODEX_CLIENT_ID),
                    ("code_verifier", verifier.as_str()),
                ])
                .send()
                .await
                .map_err(|e| format!("Codex token exchange failed: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("Codex token exchange error ({status}): {body}"));
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
            let id_token = token_json
                .get("id_token")
                .and_then(Value::as_str)
                .map(str::to_string);
            let claims = id_token
                .as_deref()
                .and_then(decode_jwt_payload)
                .or_else(|| access_token.as_deref().and_then(decode_jwt_payload));
            let email = claims.as_ref().and_then(|c| {
                c.get("email")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            let account_id = claims.as_ref().and_then(|c| {
                c.get("https://api.openai.com/auth")
                    .and_then(|a| a.get("chatgpt_account_id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            let plan_type = claims.as_ref().and_then(|c| {
                c.get("https://api.openai.com/auth")
                    .and_then(|a| a.get("chatgpt_plan_type"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            let plan_expires_at = claims.as_ref().and_then(|c| {
                parse_expiry_timestamp(
                    c.get("https://api.openai.com/auth").and_then(|a| {
                        a.get("chatgpt_subscription_active_until")
                            .or_else(|| a.get("subscription_active_until"))
                    }),
                )
            });
            let expires_at = token_json
                .get("expires_in")
                .and_then(Value::as_i64)
                .map(|s| now_secs() + s);
            let label = email
                .clone()
                .or_else(|| account_id.clone())
                .unwrap_or_else(|| "Codex Account".to_string());
            let fingerprint = compute_fingerprint(
                SwitchPlatformId::Codex,
                &[
                    email.as_deref(),
                    account_id.as_deref(),
                    refresh_token.as_deref().map(|s| &s[..s.len().min(24)]),
                ],
            );
            let now = now_millis();
            Ok(AccountRecord {
                id: uuid::Uuid::new_v4().to_string(),
                platform: SwitchPlatformId::Codex,
                label,
                email,
                account_id: account_id.clone(),
                plan_type,
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
                    id_token,
                    expires_at,
                    plan_expires_at,
                    account_id,
                    extra: HashMap::new(),
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
                        .get_active_account_id(SwitchPlatformId::Codex)
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
