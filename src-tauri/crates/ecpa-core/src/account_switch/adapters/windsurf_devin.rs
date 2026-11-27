use super::common::build_http_client;
use crate::account_switch::crypto::os_crypt;
use crate::account_switch::types::{
    compute_fingerprint, now_millis, AccountRecord, AccountSource, PlatformCredentials,
    QuotaMetric, QuotaSnapshot, SwitchPlatformId,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const WINDSURF_AUTH_STATUS_KEY: &str = "windsurfAuthStatus";
const WINDSURF_EXTENSION_STATE_KEY: &str = "codeium.windsurf";
const WINDSURF_SESSIONS_SECRET_KEY: &str =
    r#"secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.sessions"}"#;
const WINDSURF_API_SERVER_SECRET_KEY: &str =
    r#"secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.apiServerUrl"}"#;
const WINDSURF_SELECTED_AUTH_KEY: &str = "windsurf_auth.selectedAccount";
const DEFAULT_API_SERVER_URL: &str = "https://server.codeium.com";
const DEVIN_QUOTA_URL: &str =
    "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";

#[cfg(target_os = "macos")]
const MACOS_DEVIN_KEYCHAIN: &[(&str, Option<&str>)] = &[
    ("Devin Safe Storage", Some("Devin")),
    ("Devin Safe Storage", Some("Devin Key")),
    ("Devin Safe Storage", None),
    ("Windsurf Safe Storage", Some("Windsurf Key")),
    ("Windsurf Safe Storage", Some("Windsurf")),
    ("Windsurf Safe Storage", None),
];
#[cfg(not(target_os = "macos"))]
const MACOS_DEVIN_KEYCHAIN: &[(&str, Option<&str>)] = &[];
const LINUX_DEVIN_APPS: &[&str] = &["devin", "Devin", "windsurf", "Windsurf"];

fn state_db_under(dir: &Path) -> PathBuf {
    dir.join("User").join("globalStorage").join("state.vscdb")
}

fn candidate_data_dirs(home: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        vec![base.join("Devin"), base.join("Windsurf")]
    }
    #[cfg(target_os = "macos")]
    {
        let base = home.join("Library").join("Application Support");
        vec![base.join("Devin"), base.join("Windsurf")]
    }
    #[cfg(target_os = "linux")]
    {
        let base = home.join(".config");
        vec![base.join("Devin"), base.join("Windsurf")]
    }
}

fn score_profile_dir(dir: &Path) -> i32 {
    let db = state_db_under(dir);
    if !db.is_file() {
        return if dir.is_dir() { 1 } else { 0 };
    }
    let Ok(conn) = Connection::open(&db) else {
        return 10;
    };
    let mut score = 10;
    if let Ok(Some(raw)) = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [WINDSURF_EXTENSION_STATE_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
    {
        score += 20;
        if let Ok(val) = serde_json::from_str::<Value>(&raw) {
            if val
                .get("codeium.installationId")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty())
            {
                score += 100;
            }
        }
    }
    if conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [WINDSURF_AUTH_STATUS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
    {
        score += 30;
    }
    score
}

pub(crate) fn preferred_data_dir(home: &Path) -> PathBuf {
    let candidates = candidate_data_dirs(home);
    candidates
        .iter()
        .max_by_key(|dir| score_profile_dir(dir))
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

pub(crate) fn is_installed(home: &Path) -> bool {
    candidate_data_dirs(home)
        .iter()
        .any(|dir| state_db_under(dir).is_file() || dir.is_dir())
}

pub(crate) fn read_local_account(home: &Path) -> Result<Option<AccountRecord>, String> {
    let profile_dir = preferred_data_dir(home);
    let db_path = state_db_under(&profile_dir);
    if !db_path.is_file() {
        return Ok(None);
    }
    let conn = Connection::open(&db_path)
        .map_err(|error| format!("Failed to open Devin/Windsurf state.vscdb: {error}"))?;
    let raw_status: Option<String> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [WINDSURF_AUTH_STATUS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read windsurfAuthStatus: {error}"))?;
    let Some(status_str) = raw_status else {
        return Ok(None);
    };
    let status: Value = serde_json::from_str(&status_str)
        .map_err(|error| format!("Invalid windsurfAuthStatus JSON: {error}"))?;
    let api_key = status
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if api_key.is_none() {
        return Ok(None);
    }
    let email = status
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_string);
    let name = status
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let plan_type = status
        .get("planName")
        .and_then(Value::as_str)
        .map(str::to_string);
    let api_server_url = status
        .get("apiServerUrl")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_API_SERVER_URL.to_string());
    let label = email
        .clone()
        .or_else(|| name.clone())
        .unwrap_or_else(|| "Devin / Windsurf".to_string());
    let fingerprint = compute_fingerprint(
        SwitchPlatformId::WindsurfDevin,
        &[
            email.as_deref(),
            name.as_deref(),
            api_key.as_deref().map(|s| &s[..s.len().min(20)]),
        ],
    );
    let now = now_millis();

    Ok(Some(AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform: SwitchPlatformId::WindsurfDevin,
        label,
        email,
        account_id: name,
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
            api_key: api_key.clone(),
            access_token: api_key,
            api_server_url: Some(api_server_url),
            ..Default::default()
        },
    }))
}

pub(crate) fn inject_into_profile(profile_dir: &Path, record: &AccountRecord) -> Result<(), String> {
    let token = record
        .credentials
        .api_key
        .as_deref()
        .or(record.credentials.access_token.as_deref())
        .filter(|s| !s.trim().is_empty())
        .ok_or("Devin / Windsurf account is missing api_key / access_token")?;
    let api_server_url = record
        .credentials
        .api_server_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_API_SERVER_URL);
    let account_label = record
        .email
        .as_deref()
        .unwrap_or(record.label.as_str());

    let db_path = state_db_under(profile_dir);
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create Windsurf/Devin profile dir: {error}"))?;
    }
    let conn = Connection::open(&db_path)
        .map_err(|error| format!("Failed to open Devin/Windsurf state.vscdb: {error}"))?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
        [],
    )
    .map_err(|error| format!("Failed to ensure ItemTable: {error}"))?;

    let auth_status = json!({
        "name": record.account_id.as_deref().unwrap_or(account_label),
        "email": record.email.as_deref().unwrap_or(account_label),
        "apiKey": token,
        "apiServerUrl": api_server_url,
        "planName": record.plan_type.as_deref().unwrap_or("Pro"),
    });
    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
        params![WINDSURF_AUTH_STATUS_KEY, auth_status.to_string()],
    )
    .map_err(|error| format!("Failed to write windsurfAuthStatus: {error}"))?;

    // Write encrypted secret storage keys when OS crypt key is available.
    let sessions_plain = serde_json::to_vec(&json!([{
        "id": uuid::Uuid::new_v4().to_string(),
        "accessToken": token,
        "account": { "label": account_label, "id": account_label },
        "scopes": []
    }]))
    .map_err(|e| e.to_string())?;
    if let Ok(enc_sessions) = os_crypt::encrypt_electron_secret(
        profile_dir,
        &sessions_plain,
        MACOS_DEVIN_KEYCHAIN,
        LINUX_DEVIN_APPS,
        None,
    ) {
        let encoded = os_crypt::encode_buffer_json(&enc_sessions)?;
        conn.execute(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
            params![WINDSURF_SESSIONS_SECRET_KEY, encoded],
        )
        .map_err(|error| format!("Failed to write encrypted windsurf_auth.sessions: {error}"))?;
    }
    if let Ok(enc_server) = os_crypt::encrypt_electron_secret(
        profile_dir,
        api_server_url.as_bytes(),
        MACOS_DEVIN_KEYCHAIN,
        LINUX_DEVIN_APPS,
        None,
    ) {
        let encoded = os_crypt::encode_buffer_json(&enc_server)?;
        conn.execute(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
            params![WINDSURF_API_SERVER_SECRET_KEY, encoded],
        )
        .map_err(|error| format!("Failed to write encrypted apiServerUrl: {error}"))?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
        params![WINDSURF_SELECTED_AUTH_KEY, account_label],
    )
    .map_err(|e| e.to_string())?;

    // CRITICAL: Preserve existing `codeium.installationId` so Windsurf/Devin does not trigger anti-cheat error 12.
    let existing_ext: Option<String> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [WINDSURF_EXTENSION_STATE_KEY],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    let mut ext_state = existing_ext
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    if let Some(obj) = ext_state.as_object_mut() {
        obj.insert("apiServerUrl".into(), json!(api_server_url));
        obj.insert("windsurf.pendingApiKeyMigration".into(), json!(token));
        let has_install_id = obj
            .get("codeium.installationId")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty());
        if !has_install_id {
            obj.insert(
                "codeium.installationId".into(),
                json!(uuid::Uuid::new_v4().to_string()),
            );
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
        params![WINDSURF_EXTENSION_STATE_KEY, ext_state.to_string()],
    )
    .map_err(|e| e.to_string())?;

    let onboarding = json!({
        "completed": true,
        "version": 1,
        "timestamp": now_millis(),
    });
    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
        params!["windsurfOnboarding", onboarding.to_string()],
    )
    .map_err(|e| e.to_string())?;

    let _ = conn.execute("DELETE FROM ItemTable WHERE key LIKE 'windsurf_auth-%'", []);
    let usage = json!([{
        "extensionId": "codeium.windsurf",
        "extensionName": "Devin",
        "scopes": [],
        "lastUsed": now_millis(),
    }]);
    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
        params![format!("windsurf_auth-{account_label}"), "[]"],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
        params![format!("windsurf_auth-{account_label}-usages"), usage.to_string()],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub(crate) fn apply_account(home: &Path, record: &AccountRecord) -> Result<(), String> {
    let profile_dir = preferred_data_dir(home);
    inject_into_profile(&profile_dir, record)
}

pub(crate) async fn fetch_quota(
    record: &AccountRecord,
    proxy_url: Option<&str>,
) -> Result<QuotaSnapshot, String> {
    let token = record
        .credentials
        .api_key
        .as_deref()
        .or(record.credentials.access_token.as_deref())
        .filter(|s| !s.trim().is_empty())
        .ok_or("Missing Devin / Windsurf token")?;
    let client = build_http_client(proxy_url)?;
    let resp = client
        .post(DEVIN_QUOTA_URL)
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .json(&json!({
            "metadata": {
                "ideName": "chisel",
                "ideVersion": "3000.10.21",
                "apiKey": token,
                "locale": "en",
                "os": std::env::consts::OS,
                "extensionVersion": "3000.10.21",
                "clientName": "chisel",
            }
        }))
        .send()
        .await
        .map_err(|error| format!("Devin/Windsurf quota request failed: {error}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Devin/Windsurf quota API error ({status})"));
    }
    let val: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Invalid Devin/Windsurf quota JSON: {error}"))?;
    let plan_status = val
        .get("userStatus")
        .and_then(|u| u.get("planStatus"))
        .unwrap_or(&Value::Null);
    let plan = plan_status
        .get("planInfo")
        .and_then(|p| p.get("planName"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| record.plan_type.clone());

    let mut metrics = Vec::new();
    for (id, label, pct_key, reset_key) in [
        (
            "daily",
            "Daily Quota",
            "dailyQuotaRemainingPercent",
            "dailyQuotaResetAtUnix",
        ),
        (
            "weekly",
            "Weekly Quota",
            "weeklyQuotaRemainingPercent",
            "weeklyQuotaResetAtUnix",
        ),
    ] {
        let pct = plan_status
            .get(pct_key)
            .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()));
        let reset = plan_status
            .get(reset_key)
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()));
        if pct.is_some() || reset.is_some() {
            metrics.push(QuotaMetric {
                id: id.to_string(),
                label: label.to_string(),
                remaining_percent: pct,
                used_percent: pct.map(|p| (100.0 - p).clamp(0.0, 100.0)),
                reset_at: reset,
                detail: None,
            });
        }
    }

    let plan_expires_at = crate::account_switch::cpa_import::parse_expiry_timestamp(
        plan_status
            .get("planEnd")
            .or_else(|| plan_status.get("planEndUnix"))
            .or_else(|| plan_status.get("expiresAt")),
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
