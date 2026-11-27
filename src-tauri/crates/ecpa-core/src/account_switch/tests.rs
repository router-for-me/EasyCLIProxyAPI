use super::adapters;
use super::cpa_import::{
    export_json_payload, import_cpa_selections, import_json_payload, preview_cpa_oauth_dir,
};
use super::crypto::{decrypt_envelope, encrypt_envelope, load_or_create_vault_key};
use super::proxy_guard::{decouple_platform_proxy, inspect_platform_proxy};
use super::sync;
use super::types::{
    compute_fingerprint, now_millis, AccountMetaPatch, AccountRecord, AccountSource,
    CpaImportSelection, GroupAction, PlatformCredentials, ProxyMode, SwitchPlatformId,
};
use super::vault::AccountVault;
use crate::unique_test_temp_path;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs;

fn sample_record(platform: SwitchPlatformId, email: &str, token: &str) -> AccountRecord {
    let now = now_millis();
    AccountRecord {
        id: uuid::Uuid::new_v4().to_string(),
        platform,
        label: email.to_string(),
        email: Some(email.to_string()),
        account_id: Some("acct_12345".to_string()),
        plan_type: Some("pro".to_string()),
        fingerprint: compute_fingerprint(platform, &[Some(email), Some("acct_12345")]),
        tags: vec!["work".to_string()],
        group_id: None,
        notes: None,
        source: AccountSource::Local,
        created_at: now,
        updated_at: now,
        last_used_at: None,
        last_quota: None,
        credentials: PlatformCredentials {
            access_token: Some(token.to_string()),
            refresh_token: Some(format!("rt_{token}")),
            id_token: None,
            api_key: Some(token.to_string()),
            account_id: Some("acct_12345".to_string()),
            domain: Some("com".to_string()),
            provider_region: Some("zai".to_string()),
            ..Default::default()
        },
    }
}

#[test]
fn vault_encryption_roundtrip_and_tamper_detection() {
    let root = unique_test_temp_path("ecpa-as-crypto");
    fs::create_dir_all(&root).unwrap();
    let key = load_or_create_vault_key(&root.join("vault.key")).unwrap();
    let key2 = load_or_create_vault_key(&root.join("vault.key")).unwrap();
    assert_eq!(key, key2);

    let secret = b"{\"access_token\":\"sk-secret-token\"}";
    let aad = b"codex:123";
    let enc = encrypt_envelope(&key, secret, Some(aad)).unwrap();
    assert!(enc.starts_with("ECPA_ENC_V1:"));

    let (dec, was_enc) = decrypt_envelope(&key, &enc, Some(aad)).unwrap();
    assert!(was_enc);
    assert_eq!(dec, secret);

    // Wrong AAD must fail authentication.
    assert!(decrypt_envelope(&key, &enc, Some(b"codex:999")).is_err());

    // Tampered ciphertext must fail authentication.
    let mut tampered = enc.clone();
    tampered.replace_range(16..18, "AA");
    assert!(decrypt_envelope(&key, &tampered, Some(aad)).is_err());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn vault_crud_groups_meta_and_active_state() {
    let root = unique_test_temp_path("ecpa-as-vault");
    let vault = AccountVault::for_root(root.clone()).unwrap();

    let rec = sample_record(SwitchPlatformId::Codex, "alice@example.com", "tok_alice");
    let (saved, is_new) = vault.upsert_record(rec.clone()).unwrap();
    assert!(is_new);

    // Upsert with same fingerprint updates existing record instead of duplicating.
    let mut updated = sample_record(SwitchPlatformId::Codex, "alice@example.com", "tok_alice_2");
    updated.credentials.refresh_token = None; // existing refresh token must be preserved
    let (merged, is_new_2) = vault.upsert_record(updated).unwrap();
    assert!(!is_new_2);
    assert_eq!(merged.id, saved.id);
    assert_eq!(
        merged.credentials.refresh_token.as_deref(),
        Some("rt_tok_alice")
    );
    assert_eq!(
        merged.credentials.access_token.as_deref(),
        Some("tok_alice_2")
    );

    // Group creation & account metadata patch.
    let groups = vault
        .manage_groups(GroupAction {
            action: "create".into(),
            id: None,
            name: Some("Primary".into()),
            color: Some(Some("#3b82f6".into())),
            order: None,
        })
        .unwrap();
    assert_eq!(groups.len(), 1);
    let group_id = groups[0].id.clone();

    let summary = vault
        .update_meta(
            SwitchPlatformId::Codex,
            &saved.id,
            AccountMetaPatch {
                label: Some("Alice Main".into()),
                notes: Some(Some("Daily driver".into())),
                group_id: Some(Some(group_id.clone())),
                tags: Some(vec!["prod".into(), "team".into()]),
            },
        )
        .unwrap();
    assert_eq!(summary.label, "Alice Main");
    assert_eq!(summary.group_id.as_deref(), Some(group_id.as_str()));
    assert_eq!(summary.tags, vec!["prod", "team"]);

    vault
        .set_active_account_id(SwitchPlatformId::Codex, &saved.id, true)
        .unwrap();
    assert_eq!(
        vault
            .get_active_account_id(SwitchPlatformId::Codex)
            .unwrap()
            .as_deref(),
        Some(saved.id.as_str())
    );

    // Export and re-import round-trip.
    let exported = export_json_payload(&vault, SwitchPlatformId::Codex, None).unwrap();
    let reimport = import_json_payload(&vault, SwitchPlatformId::Codex, &exported).unwrap();
    assert_eq!(reimport.updated, 1);

    // Deleting group detaches from account cleanly.
    let groups_after = vault
        .manage_groups(GroupAction {
            action: "delete".into(),
            id: Some(group_id),
            name: None,
            color: None,
            order: None,
        })
        .unwrap();
    assert!(groups_after.is_empty());
    let reloaded = vault
        .load_record(SwitchPlatformId::Codex, &saved.id)
        .unwrap()
        .unwrap();
    assert!(reloaded.group_id.is_none());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn cpa_oauth_directory_preview_and_import_maps_all_supported_providers() {
    let root = unique_test_temp_path("ecpa-as-cpa-import");
    let oauth_dir = root.join("oauth");
    fs::create_dir_all(&oauth_dir).unwrap();

    fs::write(
        oauth_dir.join("codex-alice.json"),
        json!({
            "type": "codex",
            "email": "alice@openai.test",
            "account_id": "org_1",
            "access_token": "at_codex",
            "refresh_token": "rt_codex"
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        oauth_dir.join("claude-bob.json"),
        json!({
            "type": "claude",
            "email": "bob@anthropic.test",
            "access_token": "at_claude",
            "refresh_token": "rt_claude"
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        oauth_dir.join("antigravity-carol.json"),
        json!({
            "type": "antigravity",
            "email": "carol@google.test",
            "project_id": "proj-1",
            "access_token": "at_agy",
            "refresh_token": "rt_agy"
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        oauth_dir.join("xai-dave.json"),
        json!({
            "type": "xai",
            "email": "dave@xai.test",
            "access_token": "at_xai",
            "refresh_token": "rt_xai"
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        oauth_dir.join("kimi-eve.json"),
        json!({
            "type": "kimi-ai",
            "email": "eve@kimi.test",
            "access_token": "at_kimi",
            "refresh_token": "rt_kimi"
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        oauth_dir.join("devin-frank.json"),
        json!({
            "type": "devin",
            "email": "frank@devin.test",
            "api_key": "sk-ws-frank"
        })
        .to_string(),
    )
    .unwrap();
    // Vertex & Meta must be ignored (no direct client switching).
    fs::write(
        oauth_dir.join("vertex-ignored.json"),
        json!({ "type": "vertex", "private_key": "xxx" }).to_string(),
    )
    .unwrap();
    fs::write(
        oauth_dir.join("meta-ignored.json"),
        json!({ "type": "meta", "dca_token": "dca:abc" }).to_string(),
    )
    .unwrap();

    let vault = AccountVault::for_root(root.join("vault")).unwrap();
    let preview = preview_cpa_oauth_dir(&vault, &oauth_dir, None).unwrap();
    assert_eq!(preview.len(), 6);
    assert!(preview.iter().all(|c| c.action == "import"));

    let selections: Vec<CpaImportSelection> = preview
        .iter()
        .map(|c| CpaImportSelection {
            file_path: Some(c.file_path.clone()),
            file_name: Some(c.file_name.clone()),
            raw_json: None,
            platform: Some(c.platform),
        })
        .collect();
    let batch = import_cpa_selections(&vault, selections).unwrap();
    assert_eq!(batch.imported, 6);
    assert_eq!(batch.errors.len(), 0);

    // Kimi domain should have detected `.ai`.
    let kimi_records = vault.list_records(SwitchPlatformId::Kimi).unwrap();
    assert_eq!(kimi_records.len(), 1);
    assert_eq!(kimi_records[0].credentials.domain.as_deref(), Some("ai"));

    // Second preview should classify all 6 as `update`.
    let preview2 = preview_cpa_oauth_dir(&vault, &oauth_dir, None).unwrap();
    assert!(preview2.iter().all(|c| c.action == "update"));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn proxy_guard_detects_and_decouples_cpa_proxy_across_cli_clients() {
    let home = unique_test_temp_path("ecpa-as-proxy");
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::create_dir_all(home.join(".claude")).unwrap();
    fs::create_dir_all(home.join(".grok")).unwrap();
    fs::create_dir_all(home.join(".kimi-code")).unwrap();

    // 1. Codex pointing to CPA proxy
    fs::write(
        home.join(".codex").join("config.toml"),
        "model_provider = \"cpa-gui\"\nopenai_base_url = \"http://127.0.0.1:8317/v1\"\ncustom_flag = true\n\n[model_providers.cpa-gui]\nbase_url = \"http://127.0.0.1:8317/v1\"\n",
    )
    .unwrap();
    let codex_before = inspect_platform_proxy(SwitchPlatformId::Codex, &home, 8317, "123456");
    assert_eq!(codex_before.mode, ProxyMode::CpaProxy);
    let (changed, _) = decouple_platform_proxy(SwitchPlatformId::Codex, &home, 8317).unwrap();
    assert!(changed);
    let codex_after = inspect_platform_proxy(SwitchPlatformId::Codex, &home, 8317, "123456");
    assert_eq!(codex_after.mode, ProxyMode::Direct);
    let codex_toml = fs::read_to_string(home.join(".codex").join("config.toml")).unwrap();
    assert!(codex_toml.contains("custom_flag = true"));

    // 2. Claude Code pointing to CPA proxy
    fs::write(
        home.join(".claude").join("settings.json"),
        json!({
            "theme": "dark",
            "env": {
                "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
                "ANTHROPIC_AUTH_TOKEN": "123456",
                "KEEP_ME": "yes"
            }
        })
        .to_string(),
    )
    .unwrap();
    let claude_before =
        inspect_platform_proxy(SwitchPlatformId::ClaudeCode, &home, 8317, "123456");
    assert_eq!(claude_before.mode, ProxyMode::CpaProxy);
    let (changed, _) = decouple_platform_proxy(SwitchPlatformId::ClaudeCode, &home, 8317).unwrap();
    assert!(changed);
    let claude_after =
        inspect_platform_proxy(SwitchPlatformId::ClaudeCode, &home, 8317, "123456");
    assert_eq!(claude_after.mode, ProxyMode::Direct);
    let claude_json: Value = serde_json::from_str(
        &fs::read_to_string(home.join(".claude").join("settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(claude_json["theme"], "dark");
    assert_eq!(claude_json["env"]["KEEP_ME"], "yes");
    assert!(claude_json["env"].get("ANTHROPIC_BASE_URL").is_none());

    // 3. Grok pointing to CPA proxy
    fs::write(
        home.join(".grok").join("config.toml"),
        "[models]\ndefault = \"cpa-gui/grok-4\"\n",
    )
    .unwrap();
    assert_eq!(
        inspect_platform_proxy(SwitchPlatformId::Grok, &home, 8317, "123456").mode,
        ProxyMode::CpaProxy
    );
    let (changed, _) = decouple_platform_proxy(SwitchPlatformId::Grok, &home, 8317).unwrap();
    assert!(changed);
    assert_eq!(
        inspect_platform_proxy(SwitchPlatformId::Grok, &home, 8317, "123456").mode,
        ProxyMode::Direct
    );

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn native_adapters_inject_and_preserve_critical_fields() {
    let home = unique_test_temp_path("ecpa-as-adapters");
    let vault = AccountVault::for_root(home.join("vault")).unwrap();

    // 1. Codex auth.json injection preserves extra fields and strips OPENAI_API_KEY
    let codex_dir = home.join(".codex");
    fs::create_dir_all(&codex_dir).unwrap();
    fs::write(
        codex_dir.join("auth.json"),
        json!({"OPENAI_API_KEY": "sk-old", "customField": 42}).to_string(),
    )
    .unwrap();
    let codex_rec = sample_record(SwitchPlatformId::Codex, "c@example.com", "codex_at");
    adapters::codex::apply_account_to_dir(&codex_dir, &codex_rec).unwrap();
    let codex_written: Value =
        serde_json::from_str(&fs::read_to_string(codex_dir.join("auth.json")).unwrap()).unwrap();
    assert_eq!(codex_written["auth_mode"], "chatgpt");
    assert!(codex_written.get("OPENAI_API_KEY").is_none());
    assert_eq!(codex_written["customField"], 42);
    assert_eq!(codex_written["tokens"]["access_token"], "codex_at");

    // 2. Claude Code .credentials.json + ~/.claude.json
    let claude_rec = sample_record(SwitchPlatformId::ClaudeCode, "cl@example.com", "claude_at");
    adapters::claude_code::apply_account(&home, &claude_rec).unwrap();
    let claude_read = adapters::claude_code::read_local_account(&home)
        .unwrap()
        .unwrap();
    assert_eq!(claude_read.email.as_deref(), Some("cl@example.com"));
    assert_eq!(
        claude_read.credentials.access_token.as_deref(),
        Some("claude_at")
    );

    // 3. Grok auth.json preserves sibling scopes
    fs::create_dir_all(home.join(".grok")).unwrap();
    fs::write(
        home.join(".grok").join("auth.json"),
        json!({"entries": {"enterprise": {"access_token": "keep_me"}}}).to_string(),
    )
    .unwrap();
    let grok_rec = sample_record(SwitchPlatformId::Grok, "g@x.ai", "grok_at");
    adapters::grok::apply_account(&home, &grok_rec).unwrap();
    let grok_written: Value =
        serde_json::from_str(&fs::read_to_string(home.join(".grok").join("auth.json")).unwrap())
            .unwrap();
    assert_eq!(
        grok_written["entries"]["enterprise"]["access_token"],
        "keep_me"
    );
    assert_eq!(grok_written["entries"]["default"]["access_token"], "grok_at");

    // 4. Windsurf / Devin preserves existing `codeium.installationId`!
    let ws_profile = home.join("DevinProfile");
    let ws_db = ws_profile
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");
    fs::create_dir_all(ws_db.parent().unwrap()).unwrap();
    {
        let conn = Connection::open(&ws_db).unwrap();
        conn.execute(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            [
                "codeium.windsurf",
                r#"{"codeium.installationId":"machine-stable-id-999"}"#,
            ],
        )
        .unwrap();
    }
    let devin_rec = sample_record(SwitchPlatformId::WindsurfDevin, "d@devin.ai", "sk-ws-new");
    adapters::windsurf_devin::inject_into_profile(&ws_profile, &devin_rec).unwrap();
    {
        let conn = Connection::open(&ws_db).unwrap();
        let ext_raw: String = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = 'codeium.windsurf'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let ext_json: Value = serde_json::from_str(&ext_raw).unwrap();
        assert_eq!(ext_json["codeium.installationId"], "machine-stable-id-999");
        let auth_raw: String = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let auth_json: Value = serde_json::from_str(&auth_raw).unwrap();
        assert_eq!(auth_json["apiKey"], "sk-ws-new");
    }

    // 5. Antigravity legacy state.vscdb protobuf injection
    let agy_db = home.join("agy_state.vscdb");
    adapters::antigravity::inject_legacy_state_db(&agy_db, "agy_at", "agy_rt", 1_900_000_000)
        .unwrap();
    {
        let conn = Connection::open(&agy_db).unwrap();
        let encoded: String = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.oauthToken'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!encoded.is_empty());
    }

    // 6. Claude Desktop transactional snapshot restore preserves non-login config keys
    let cd_live = home.join("ClaudeLive");
    fs::create_dir_all(&cd_live).unwrap();
    fs::write(
        cd_live.join("config.json"),
        json!({"userWindowZoom": 1.25, "lastKnownAccountUuid": "old-uuid"}).to_string(),
    )
    .unwrap();
    fs::write(cd_live.join("Cookies"), b"old-cookie-bytes").unwrap();

    let snap_dir = vault.snapshots_dir(SwitchPlatformId::ClaudeDesktop, "snap-1");
    fs::create_dir_all(&snap_dir).unwrap();
    fs::write(snap_dir.join("Cookies"), b"new-cookie-bytes").unwrap();
    fs::write(
        snap_dir.join("login_config.json"),
        json!({"lastKnownAccountUuid": "new-uuid-456"}).to_string(),
    )
    .unwrap();
    adapters::claude_desktop::apply_snapshot_to_dir(&cd_live, &snap_dir).unwrap();
    assert_eq!(fs::read(cd_live.join("Cookies")).unwrap(), b"new-cookie-bytes");
    let cd_cfg: Value =
        serde_json::from_str(&fs::read_to_string(cd_live.join("config.json")).unwrap()).unwrap();
    assert_eq!(cd_cfg["userWindowZoom"], 1.25);
    assert_eq!(cd_cfg["lastKnownAccountUuid"], "new-uuid-456");

    // 7. WorkBuddy AES-256-GCM field crypto roundtrip
    let wb_key = [7u8; 32];
    let wb_enc = adapters::workbuddy::encrypt_wb_field(&wb_key, "wb-secret-token").unwrap();
    let wb_dec = adapters::workbuddy::decrypt_wb_field(&wb_key, &wb_enc).unwrap();
    assert_eq!(wb_dec, "wb-secret-token");

    // 8. ZCode enc:v2 field crypto roundtrip
    let zc_key = [9u8; 32];
    let zc_enc = adapters::zcode::encrypt_zcode_value("zc-token", Some(&zc_key)).unwrap();
    assert!(zc_enc.starts_with("enc:v2:"));
    let zc_dec = adapters::zcode::decrypt_zcode_value(&zc_enc, Some(&zc_key));
    assert_eq!(zc_dec, "zc-token");

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn companion_sync_merges_without_overwriting_other_providers() {
    let dir = unique_test_temp_path("ecpa-as-sync");
    fs::create_dir_all(&dir).unwrap();
    let codex_rec = sample_record(SwitchPlatformId::Codex, "sync@example.com", "sync_codex_at");

    // 1. OpenCode
    let oc_path = dir.join("opencode_auth.json");
    fs::write(
        &oc_path,
        json!({"anthropic": {"type": "api", "key": "sk-ant-keep"}}).to_string(),
    )
    .unwrap();
    sync::opencode::sync_account_to_path(&codex_rec, &oc_path).unwrap();
    let oc_json: Value = serde_json::from_str(&fs::read_to_string(&oc_path).unwrap()).unwrap();
    assert_eq!(oc_json["anthropic"]["key"], "sk-ant-keep");
    assert_eq!(oc_json["openai"]["access"], "sync_codex_at");

    // 2. OpenClaw
    let claw_path = dir.join("openclaw_profiles.json");
    fs::write(
        &claw_path,
        json!({"version": 1, "profiles": {"anthropic:default": {"type": "api"}}}).to_string(),
    )
    .unwrap();
    sync::openclaw::sync_account_to_path(&codex_rec, &claw_path).unwrap();
    let claw_json: Value = serde_json::from_str(&fs::read_to_string(&claw_path).unwrap()).unwrap();
    assert_eq!(claw_json["profiles"]["anthropic:default"]["type"], "api");
    assert_eq!(
        claw_json["profiles"]["openai-codex:default"]["access"],
        "sync_codex_at"
    );

    // 3. Hermes
    let hermes_path = dir.join("hermes_auth.json");
    fs::write(
        &hermes_path,
        json!({"version": 1, "providers": {"google": {"token": "keep"}}}).to_string(),
    )
    .unwrap();
    sync::hermes::sync_account_to_path(&codex_rec, &hermes_path).unwrap();
    let hermes_json: Value =
        serde_json::from_str(&fs::read_to_string(&hermes_path).unwrap()).unwrap();
    assert_eq!(hermes_json["providers"]["google"]["token"], "keep");
    assert_eq!(
        hermes_json["providers"]["openai-codex"]["tokens"]["access_token"],
        "sync_codex_at"
    );

    // 4. WSL Codex sync cleans CPA proxy model_provider
    let wsl_codex = dir.join("wsl_codex");
    fs::create_dir_all(&wsl_codex).unwrap();
    fs::write(
        wsl_codex.join("config.toml"),
        "model_provider = \"cpa-gui\"\nkeep = 1\n",
    )
    .unwrap();
    sync::wsl::sync_codex_to_dir(&codex_rec, &wsl_codex).unwrap();
    let wsl_auth: Value =
        serde_json::from_str(&fs::read_to_string(wsl_codex.join("auth.json")).unwrap()).unwrap();
    assert_eq!(wsl_auth["tokens"]["access_token"], "sync_codex_at");
    let wsl_cfg = fs::read_to_string(wsl_codex.join("config.toml")).unwrap();
    assert!(!wsl_cfg.contains("cpa-gui"));
    assert!(wsl_cfg.contains("keep = 1"));

    let _ = fs::remove_dir_all(&dir);
}
