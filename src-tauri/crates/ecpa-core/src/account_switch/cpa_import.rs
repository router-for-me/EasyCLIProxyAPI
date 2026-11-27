use super::types::{
    compute_fingerprint, now_millis, AccountRecord, AccountSource, CpaImportCandidate,
    CpaImportSelection, ImportBatchResult, PlatformCredentials, SwitchPlatformId,
};
use super::vault::AccountVault;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Resolve the local CPA `oauth/` directory without requiring the core kernel to be running.
pub(crate) fn resolve_local_cpa_oauth_dir() -> Result<PathBuf, String> {
    let base = crate::core_base_dir()?;
    let core_config_path = base.join("cpa-core").join("config.yaml");
    if let Ok(raw) = fs::read_to_string(&core_config_path) {
        if let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(&raw) {
            if let Some(auth_dir) = yaml
                .get("auth-dir")
                .or_else(|| yaml.get("auth_dir"))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                let path = PathBuf::from(auth_dir);
                let resolved = if path.is_absolute() {
                    path
                } else {
                    core_config_path
                        .parent()
                        .unwrap_or(&base)
                        .join(path)
                };
                if resolved.is_dir() {
                    return Ok(resolved);
                }
            }
        }
    }
    Ok(base.join("oauth"))
}

fn read_str(obj: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = obj
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return Some(value.to_string());
        }
    }
    None
}

fn read_nested_str(obj: &Value, containers: &[&str], keys: &[&str]) -> Option<String> {
    if let Some(v) = read_str(obj, keys) {
        return Some(v);
    }
    for container in containers {
        if let Some(sub) = obj.get(*container) {
            if let Some(v) = read_str(sub, keys) {
                return Some(v);
            }
        }
    }
    None
}

pub(crate) fn parse_expiry_timestamp(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(num) = value.as_i64() {
        if num > 1_000_000_000_000 {
            return Some(num / 1000);
        }
        return (num > 0).then_some(num);
    }
    if let Some(num) = value.as_f64().filter(|n| n.is_finite() && *n > 0.0) {
        let secs = if num > 1e12 { num / 1000.0 } else { num };
        return Some(secs as i64);
    }
    if let Some(text) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(text) {
            return Some(dt.timestamp());
        }
        if let Ok(num) = text.parse::<i64>() {
            return Some(if num > 1_000_000_000_000 {
                num / 1000
            } else {
                num
            });
        }
    }
    None
}

pub(crate) fn decode_jwt_payload(token: &str) -> Option<Value> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(crate) fn detect_cpa_platform(file_name: &str, root: &Value) -> Option<SwitchPlatformId> {
    let declared = read_nested_str(
        root,
        &["metadata", "attributes"],
        &["type", "provider", "platform"],
    )
    .unwrap_or_default()
    .to_ascii_lowercase()
    .replace('_', "-");
    let lower_name = file_name.to_ascii_lowercase();

    match declared.as_str() {
        "codex" | "openai" | "chatgpt" => return Some(SwitchPlatformId::Codex),
        "claude" | "anthropic" | "claude-code" => return Some(SwitchPlatformId::ClaudeCode),
        "antigravity" | "gemini-cli" | "cloudcode" => return Some(SwitchPlatformId::Antigravity),
        "xai" | "grok" | "grok-build" => return Some(SwitchPlatformId::Grok),
        "kimi" | "kimi-ai" | "kimi-code" => return Some(SwitchPlatformId::Kimi),
        "devin" | "windsurf" => return Some(SwitchPlatformId::WindsurfDevin),
        "copilot" | "github-copilot" => return Some(SwitchPlatformId::GithubCopilot),
        "zcode" | "zai" => return Some(SwitchPlatformId::Zcode),
        "workbuddy" => return Some(SwitchPlatformId::Workbuddy),
        "workbuddy-ai" => return Some(SwitchPlatformId::WorkbuddyAi),
        "vertex" | "meta" | "muse" => return None,
        _ => {}
    }

    if lower_name.starts_with("codex-") || lower_name.contains("codex") {
        Some(SwitchPlatformId::Codex)
    } else if lower_name.starts_with("claude-") || lower_name.starts_with("anthropic-") {
        Some(SwitchPlatformId::ClaudeCode)
    } else if lower_name.starts_with("antigravity-") {
        Some(SwitchPlatformId::Antigravity)
    } else if lower_name.starts_with("xai-") || lower_name.starts_with("grok-") {
        Some(SwitchPlatformId::Grok)
    } else if lower_name.starts_with("kimi-") {
        Some(SwitchPlatformId::Kimi)
    } else if lower_name.starts_with("devin-") || lower_name.starts_with("windsurf-") {
        Some(SwitchPlatformId::WindsurfDevin)
    } else {
        None
    }
}

pub(crate) fn parse_cpa_credential_json(
    file_name: &str,
    root: &Value,
    forced_platform: Option<SwitchPlatformId>,
    source: AccountSource,
) -> Result<AccountRecord, String> {
    let platform = forced_platform
        .or_else(|| detect_cpa_platform(file_name, root))
        .ok_or_else(|| format!("Unrecognized or unsupported credential platform in {file_name}"))?;

    let containers = ["token", "tokens", "oauth", "credentials", "metadata", "attributes", "user"];
    let access_token = read_nested_str(
        root,
        &containers,
        &["access_token", "accessToken", "oauth_token", "oauthToken"],
    );
    let refresh_token = read_nested_str(
        root,
        &containers,
        &["refresh_token", "refreshToken"],
    );
    let id_token = read_nested_str(root, &containers, &["id_token", "idToken"]);
    let api_key = read_nested_str(
        root,
        &containers,
        &["api_key", "apiKey", "ide_token", "ideToken", "OPENAI_API_KEY"],
    );

    let jwt_claims = id_token
        .as_deref()
        .and_then(decode_jwt_payload)
        .or_else(|| access_token.as_deref().and_then(decode_jwt_payload));

    let jwt_email = jwt_claims
        .as_ref()
        .and_then(|claims| {
            read_str(claims, &["email"]).or_else(|| {
                claims
                    .get("https://api.openai.com/profile")
                    .and_then(|p| read_str(p, &["email"]))
            })
        });
    let jwt_account_id = jwt_claims.as_ref().and_then(|claims| {
        claims
            .get("https://api.openai.com/auth")
            .and_then(|auth| read_str(auth, &["chatgpt_account_id", "user_id"]))
            .or_else(|| read_str(claims, &["sub", "account_id", "accountId"]))
    });
    let jwt_plan = jwt_claims.as_ref().and_then(|claims| {
        claims
            .get("https://api.openai.com/auth")
            .and_then(|auth| read_str(auth, &["chatgpt_plan_type"]))
    });
    let jwt_plan_exp = jwt_claims.as_ref().and_then(|claims| {
        parse_expiry_timestamp(
            claims
                .get("https://api.openai.com/auth")
                .and_then(|auth| {
                    auth.get("chatgpt_subscription_active_until")
                        .or_else(|| auth.get("subscription_active_until"))
                }),
        )
    });
    let jwt_exp = jwt_claims
        .as_ref()
        .and_then(|claims| claims.get("exp").and_then(Value::as_i64));

    let email = read_nested_str(
        root,
        &containers,
        &["email", "email_address", "emailAddress", "user_email"],
    )
    .or(jwt_email);
    let account_id = read_nested_str(
        root,
        &containers,
        &[
            "account_id",
            "accountId",
            "chatgpt_account_id",
            "user_id",
            "userId",
            "sub",
            "subject",
            "organization_uuid",
        ],
    )
    .or(jwt_account_id);
    let organization_id = read_nested_str(
        root,
        &containers,
        &["organization_id", "organizationId", "org_id", "team_id", "teamId"],
    );
    let project_id = read_nested_str(
        root,
        &containers,
        &["project_id", "projectId", "cloudaicompanionProject"],
    );
    let domain = read_nested_str(root, &containers, &["domain"]).or_else(|| {
        if platform == SwitchPlatformId::Kimi {
            let text = format!(
                "{} {}",
                file_name,
                read_str(root, &["type", "base_url", "base-url"]).unwrap_or_default()
            )
            .to_ascii_lowercase();
            if text.contains("kimi-ai") || text.contains("kimi.ai") {
                Some("ai".to_string())
            } else {
                Some("com".to_string())
            }
        } else {
            None
        }
    });
    let api_server_url = read_nested_str(
        root,
        &containers,
        &["api_server_url", "apiServerUrl", "base_url", "base-url"],
    );
    let scope = read_nested_str(root, &containers, &["scope", "scopes"]);
    let token_type = read_nested_str(root, &containers, &["token_type", "tokenType"]);
    let plan_type = read_nested_str(
        root,
        &containers,
        &["plan_type", "planType", "plan", "subscription_tier"],
    )
    .or(jwt_plan);

    let plan_expires_at = parse_expiry_timestamp(
        root.get("plan_expires_at")
            .or_else(|| root.get("planExpiresAt"))
            .or_else(|| root.get("subscription_active_until"))
            .or_else(|| root.get("subscriptionActiveUntil"))
            .or_else(|| root.get("subscription_expires_at"))
            .or_else(|| root.get("subscriptionExpiresAt"))
            .or_else(|| root.get("account_expires_at"))
            .or_else(|| root.get("accountExpiresAt"))
            .or_else(|| root.get("credentials").and_then(|c| c.get("planExpiresAt").or_else(|| c.get("plan_expires_at")))),
    )
    .or(jwt_plan_exp);

    let expires_at = parse_expiry_timestamp(
        root.get("expires_at")
            .or_else(|| root.get("expiresAt"))
            .or_else(|| root.get("expired"))
            .or_else(|| root.get("expiry"))
            .or_else(|| root.get("token").and_then(|t| t.get("expiry").or_else(|| t.get("expires_at"))))
            .or_else(|| root.get("tokens").and_then(|t| t.get("expires_at"))),
    )
    .or(jwt_exp);

    if access_token.is_none() && refresh_token.is_none() && api_key.is_none() {
        return Err(format!(
            "No usable OAuth token or API key found in {file_name}"
        ));
    }

    let label = read_str(root, &["label", "name", "display_name", "displayName"])
        .or_else(|| email.clone())
        .or_else(|| account_id.clone())
        .unwrap_or_else(|| {
            Path::new(file_name)
                .file_stem()
                .and_then(|v| v.to_str())
                .unwrap_or(platform.display_name())
                .to_string()
        });

    let fingerprint = compute_fingerprint(
        platform,
        &[
            email.as_deref(),
            account_id.as_deref(),
            refresh_token.as_deref().map(|t| &t[..t.len().min(24)]),
            api_key.as_deref().map(|t| &t[..t.len().min(24)]),
            access_token.as_deref().map(|t| &t[..t.len().min(24)]),
        ],
    );

    let mut extra = HashMap::new();
    extra.insert("sourceFile".to_string(), Value::String(file_name.to_string()));
    if let Some(raw_type) = read_str(root, &["type", "provider"]) {
        extra.insert("cpaType".to_string(), Value::String(raw_type));
    }
    if let Some(cid) = read_nested_str(root, &containers, &["client_id", "clientId"]) {
        extra.insert("client_id".to_string(), Value::String(cid));
    }
    if let Some(csec) = read_nested_str(root, &containers, &["client_secret", "clientSecret"]) {
        extra.insert("client_secret".to_string(), Value::String(csec));
    }

    let now = now_millis();
    Ok(AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform,
        label,
        email,
        account_id: account_id.clone(),
        plan_type,
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
            access_token,
            refresh_token,
            id_token,
            api_key,
            session_token: None,
            token_type,
            scope,
            expires_at,
            plan_expires_at,
            account_id,
            organization_id,
            project_id,
            domain,
            api_server_url,
            provider_region: None,
            snapshot_id: None,
            extra,
        },
    })
}

pub(crate) fn preview_cpa_oauth_dir(
    vault: &AccountVault,
    oauth_dir: &Path,
    platform_filter: Option<SwitchPlatformId>,
) -> Result<Vec<CpaImportCandidate>, String> {
    if !oauth_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut existing_by_fp: HashMap<(SwitchPlatformId, String), String> = HashMap::new();
    for platform in SwitchPlatformId::ALL {
        if platform_filter.is_some_and(|filter| filter != platform) {
            continue;
        }
        if let Ok(records) = vault.list_records(platform) {
            for record in records {
                existing_by_fp.insert((platform, record.fingerprint), record.id);
            }
        }
    }

    let mut candidates = Vec::new();
    let entries = fs::read_dir(oauth_dir).map_err(|error| {
        format!(
            "Failed to scan CPA oauth directory {}: {error}",
            oauth_dir.display()
        )
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
            .to_string();
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Ok(parsed) =
            parse_cpa_credential_json(&file_name, &value, None, AccountSource::CpaImport)
        else {
            continue;
        };
        if platform_filter.is_some_and(|filter| filter != parsed.platform) {
            continue;
        }
        let existing = existing_by_fp
            .get(&(parsed.platform, parsed.fingerprint.clone()))
            .cloned();
        candidates.push(CpaImportCandidate {
            file_name,
            file_path: path.to_string_lossy().into_owned(),
            platform: parsed.platform,
            label: parsed.label,
            email: parsed.email,
            account_id: parsed.account_id,
            fingerprint: parsed.fingerprint,
            action: if existing.is_some() {
                "update".to_string()
            } else {
                "import".to_string()
            },
            existing_account_id: existing,
        });
    }
    candidates.sort_by(|a, b| {
        a.platform
            .as_str()
            .cmp(b.platform.as_str())
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
    });
    Ok(candidates)
}

pub(crate) fn import_cpa_selections(
    vault: &AccountVault,
    selections: Vec<CpaImportSelection>,
) -> Result<ImportBatchResult, String> {
    let mut imported = 0usize;
    let mut updated = 0usize;
    let mut skipped = 0usize;
    let mut errors = Vec::new();
    let mut accounts = Vec::new();

    for selection in selections {
        let (file_name, value) = if let Some(raw) = selection.raw_json {
            (
                selection
                    .file_name
                    .unwrap_or_else(|| "cpa-credential.json".to_string()),
                raw,
            )
        } else if let Some(path_str) = selection.file_path {
            let path = PathBuf::from(&path_str);
            let name = selection.file_name.unwrap_or_else(|| {
                path.file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or("credential.json")
                    .to_string()
            });
            match fs::read_to_string(&path).and_then(|raw| {
                serde_json::from_str::<Value>(&raw)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
            }) {
                Ok(parsed) => (name, parsed),
                Err(error) => {
                    skipped += 1;
                    errors.push(format!("{name}: {error}"));
                    continue;
                }
            }
        } else {
            skipped += 1;
            continue;
        };

        match parse_cpa_credential_json(
            &file_name,
            &value,
            selection.platform,
            AccountSource::CpaImport,
        ) {
            Ok(record) => match vault.upsert_record(record) {
                Ok((saved, is_new)) => {
                    if is_new {
                        imported += 1;
                    } else {
                        updated += 1;
                    }
                    let active_id = vault.get_active_account_id(saved.platform).ok().flatten();
                    accounts.push(saved.to_summary(active_id.as_deref()));
                }
                Err(error) => {
                    skipped += 1;
                    errors.push(format!("{file_name}: {error}"));
                }
            },
            Err(error) => {
                skipped += 1;
                errors.push(error);
            }
        }
    }

    Ok(ImportBatchResult {
        imported,
        updated,
        skipped,
        errors,
        accounts,
    })
}

pub(crate) fn import_json_payload(
    vault: &AccountVault,
    platform: SwitchPlatformId,
    payload: &str,
) -> Result<ImportBatchResult, String> {
    let parsed: Value = serde_json::from_str(payload.trim())
        .map_err(|error| format!("Invalid JSON payload: {error}"))?;
    let items: Vec<Value> = if let Some(arr) = parsed.as_array() {
        arr.clone()
    } else if let Some(arr) = parsed.get("accounts").and_then(Value::as_array) {
        arr.clone()
    } else if parsed.is_object() {
        vec![parsed]
    } else {
        return Err("Expected a JSON object or an array of accounts".into());
    };

    let mut imported = 0usize;
    let mut updated = 0usize;
    let mut skipped = 0usize;
    let mut errors = Vec::new();
    let mut accounts = Vec::new();

    for (index, item) in items.into_iter().enumerate() {
        // Support round-trip export format (serialized AccountRecord) as well as raw credential JSON.
        let record = if item.get("credentials").is_some() && item.get("platform").is_some() {
            match serde_json::from_value::<AccountRecord>(item.clone()) {
                Ok(mut rec) => {
                    rec.platform = platform;
                    rec.source = AccountSource::JsonImport;
                    if rec.fingerprint.is_empty() {
                        rec.fingerprint = compute_fingerprint(
                            platform,
                            &[
                                rec.email.as_deref(),
                                rec.account_id.as_deref(),
                                rec.credentials.refresh_token.as_deref(),
                                rec.credentials.access_token.as_deref(),
                            ],
                        );
                    }
                    Ok(rec)
                }
                Err(error) => Err(format!("Entry #{}: {error}", index + 1)),
            }
        } else {
            parse_cpa_credential_json(
                &format!("import-{}.json", index + 1),
                &item,
                Some(platform),
                AccountSource::JsonImport,
            )
        };

        match record {
            Ok(rec) => match vault.upsert_record(rec) {
                Ok((saved, is_new)) => {
                    if is_new {
                        imported += 1;
                    } else {
                        updated += 1;
                    }
                    let active_id = vault.get_active_account_id(saved.platform).ok().flatten();
                    accounts.push(saved.to_summary(active_id.as_deref()));
                }
                Err(error) => {
                    skipped += 1;
                    errors.push(error);
                }
            },
            Err(error) => {
                skipped += 1;
                errors.push(error);
            }
        }
    }

    Ok(ImportBatchResult {
        imported,
        updated,
        skipped,
        errors,
        accounts,
    })
}

pub(crate) fn export_json_payload(
    vault: &AccountVault,
    platform: SwitchPlatformId,
    account_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let mut records = vault.list_records(platform)?;
    if let Some(ids) = account_ids.filter(|list| !list.is_empty()) {
        records.retain(|rec| ids.iter().any(|id| id == &rec.id));
    }
    let payload = serde_json::json!({
        "format": "easycliproxyapi-account-switch-v1",
        "platform": platform.as_str(),
        "exportedAt": now_millis(),
        "accounts": records,
    });
    serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("Failed to serialize exported accounts: {error}"))
}
