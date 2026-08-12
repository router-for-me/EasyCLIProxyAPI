use super::support::*;
use super::*;

#[test]
fn pi_provider_config_preserves_existing_fields_and_syncs_cpa_credentials() {
    let rendered = build_pi_provider_config(
        Some(r#"{"fast":true,"providerId":"custom","nested":{"keep":1}}"#),
        "http://127.0.0.1:9527",
        "agent-key",
    )
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();

    assert_eq!(value["baseUrl"], "http://127.0.0.1:9527");
    assert_eq!(value["apiKey"], "agent-key");
    assert_eq!(value["fast"], true);
    assert_eq!(value["providerId"], "custom");
    assert_eq!(value["nested"]["keep"], 1);
}

#[test]
fn pi_provider_settings_preserve_user_fields_and_set_cpa_defaults() {
    let rendered = build_pi_provider_settings(
            r#"{"theme":"dark","packages":["npm:@router-for-me/pi-cliproxyapi-provider"],"defaultProvider":"other","defaultModel":"old-model"}"#,
            "new-model",
        )
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();

    assert_eq!(value["theme"], "dark");
    assert_eq!(value["packages"][0], PI_CLIPROXYAPI_PACKAGE);
    assert_eq!(value["defaultProvider"], PI_CLIPROXYAPI_PROVIDER_ID);
    assert_eq!(value["defaultModel"], "new-model");
}

#[test]
fn repairing_pi_provider_updates_credentials_defaults_and_model() {
    let home = agent_test_home("repair-pi-provider");
    let settings_path = pi_provider_settings_path(&home);
    fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    fs::write(
            &settings_path,
            format!(
                r#"{{"packages":["{PI_CLIPROXYAPI_PACKAGE}"],"defaultProvider":"other","defaultModel":"old-model"}}"#
            ),
        )
        .unwrap();

    let result = repair_pi_provider_inner(&home, 9527, "agent-key", "new-model").unwrap();
    let provider: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(pi_provider_config_path(&home)).unwrap()).unwrap();
    let settings: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();

    assert_eq!(result.model.as_deref(), Some("new-model"));
    assert_eq!(provider["baseUrl"], "http://127.0.0.1:9527");
    assert_eq!(provider["apiKey"], "agent-key");
    assert_eq!(settings["defaultProvider"], PI_CLIPROXYAPI_PROVIDER_ID);
    assert_eq!(settings["defaultModel"], "new-model");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn pi_provider_version_reads_installed_package_metadata() {
    let home = agent_test_home("pi-provider-version");
    let package_path = pi_provider_package_json_path(&home);
    fs::create_dir_all(package_path.parent().unwrap()).unwrap();
    fs::write(&package_path, r#"{"version":"1.4.10"}"#).unwrap();

    assert_eq!(
        read_pi_provider_version(&home).unwrap().as_deref(),
        Some("1.4.10")
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn pi_provider_latest_version_parses_npm_metadata() {
    assert_eq!(
        parse_pi_provider_latest_version(&serde_json::json!({ "version": "1.5.0" })).unwrap(),
        "1.5.0"
    );
    assert!(parse_pi_provider_latest_version(&serde_json::json!({})).is_err());
}

#[test]
fn pi_provider_update_detection_requires_a_newer_semver() {
    assert!(pi_provider_update_available("1.4.12", "1.5.0").unwrap());
    assert!(!pi_provider_update_available("1.4.12", "1.4.12").unwrap());
    assert!(!pi_provider_update_available("1.4.12", "1.4.11").unwrap());
}

#[test]
fn pi_package_source_match_accepts_unpinned_and_pinned_sources() {
    assert!(pi_package_source_matches(PI_CLIPROXYAPI_PACKAGE));
    assert!(pi_package_source_matches(
        "npm:@router-for-me/pi-cliproxyapi-provider@1.4.10"
    ));
    assert!(!pi_package_source_matches(
        "npm:@router-for-me/other-provider"
    ));
    assert!(pi_settings_contains_provider(&serde_json::json!({
        "packages": [{"source": PI_CLIPROXYAPI_PACKAGE}]
    })));
}

#[test]
fn agent_status_cache_requires_matching_port_and_api_key() {
    let cache = AgentConfigStatusCache::default();
    cache.replace(8317, "agent-key", Vec::new()).unwrap();

    assert!(cache
        .get(8317, "agent-key")
        .unwrap()
        .is_some_and(|statuses| statuses.is_empty()));
    assert!(cache.get(8318, "agent-key").unwrap().is_none());
    assert!(cache.get(8317, "different-key").unwrap().is_none());

    cache.clear().unwrap();
    assert!(cache.get(8317, "agent-key").unwrap().is_none());
}

#[test]
fn agent_api_key_uses_first_configured_key_and_has_no_weak_fallback() {
    let mut config = GuiConfigFile {
        api_keys: vec![GuiApiKeyEntry {
            key: "custom-agent-key".to_string(),
            remark: String::new(),
        }],
        ..GuiConfigFile::default()
    };
    assert_eq!(effective_agent_api_key(&config), "custom-agent-key");

    config.api_keys.clear();
    assert_eq!(effective_agent_api_key(&config), "");
}

#[test]
fn codex_oauth_requires_auth_json_with_tokens() {
    let home = agent_test_home("codex-oauth-login");
    let auth_path = home.join("auth.json");

    assert_eq!(
        validate_codex_oauth_login_at(&auth_path),
        Err(CODEX_OAUTH_LOGIN_REQUIRED_ERROR.to_string())
    );

    fs::write(&auth_path, "{ invalid json").unwrap();
    assert_eq!(
        validate_codex_oauth_login_at(&auth_path),
        Err(CODEX_OAUTH_LOGIN_REQUIRED_ERROR.to_string())
    );

    fs::write(&auth_path, r#"{"OPENAI_API_KEY":"sk-api-key"}"#).unwrap();
    assert_eq!(
        validate_codex_oauth_login_at(&auth_path),
        Err(CODEX_OAUTH_LOGIN_REQUIRED_ERROR.to_string())
    );

    fs::write(
        &auth_path,
        r#"{"tokens":{"access_token":"oauth-access-token"}}"#,
    )
    .unwrap();
    assert!(validate_codex_oauth_login_at(&auth_path).is_ok());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_configuration_is_restored_from_the_dated_session_backup_on_exit() {
    let home = agent_test_home("session-backup");
    let path = home.join(".config/opencode/opencode.json");
    let original = b"{\"provider\":\"original\"}";
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, original).unwrap();

    commit_agent_configuration(
        AgentClient::OpenCode,
        &home,
        "gpt-test",
        &[AgentFileUpdate {
            path: path.clone(),
            after: "{\"provider\":\"managed\"}".to_string(),
        }],
        "applied",
        None,
    )
    .unwrap();

    let backup = dated_agent_backup_path(&path).unwrap();
    assert!(backup.is_file());
    assert_eq!(fs::read(&backup).unwrap(), original);
    assert!(fs::read_to_string(&path).unwrap().contains("managed"));
    let inspection = inspect_agent_application(AgentClient::OpenCode, &home);
    assert_eq!(inspection.state, "applied");
    assert!(inspection.backup_available);

    restore_agent_session_configuration(AgentClient::OpenCode, &home).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(!backup.exists());
    assert!(!agent_state_path(std::slice::from_ref(&path))
        .unwrap()
        .exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn opencode_runtime_edits_survive_close_and_next_apply_owns_conflicts() {
    let home = agent_test_home("opencode-runtime-edit-merge");
    let path = home.join(".config/opencode/opencode.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"provider":{"other":{"keep":"original"}},"keep":"root"}"#,
    )
    .unwrap();
    let models = test_agent_models(&["gpt-one", "gpt-two"]);
    apply_agent_configuration(
        AgentClient::OpenCode,
        &home,
        8317,
        DEFAULT_API_KEY,
        "gpt-one",
        &models,
        None,
    )
    .unwrap();

    let mut runtime: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    runtime["agentAdded"] = serde_json::json!({"enabled": true});
    runtime["provider"]["other"]["runtimeAdded"] = serde_json::json!(42);
    runtime["provider"][MANAGED_AGENT_PROVIDER_ID]["customAfterApply"] =
        serde_json::json!("keep-me");
    runtime["provider"][MANAGED_AGENT_PROVIDER_ID]["options"]["baseURL"] =
        serde_json::json!("https://agent-overwrite.invalid/v1");
    runtime["provider"][MANAGED_AGENT_PROVIDER_ID]["options"]["apiKey"] =
        serde_json::json!("agent-overwrite");
    runtime["model"] = serde_json::json!("cpa-gui/agent-overwrite");
    fs::write(&path, serde_json::to_string_pretty(&runtime).unwrap()).unwrap();

    restore_agent_session_configuration(AgentClient::OpenCode, &home).unwrap();
    let closed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(closed["keep"], "root");
    assert_eq!(closed["agentAdded"]["enabled"], true);
    assert_eq!(closed["provider"]["other"]["keep"], "original");
    assert_eq!(closed["provider"]["other"]["runtimeAdded"], 42);
    assert_eq!(
        closed["provider"][MANAGED_AGENT_PROVIDER_ID]["customAfterApply"],
        "keep-me"
    );
    assert!(closed.get("model").is_none());
    assert!(closed.get("$schema").is_none());
    assert!(closed["provider"][MANAGED_AGENT_PROVIDER_ID]
        .get("options")
        .is_none());

    apply_agent_configuration(
        AgentClient::OpenCode,
        &home,
        8317,
        DEFAULT_API_KEY,
        "gpt-two",
        &models,
        None,
    )
    .unwrap();
    let reapplied: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(reapplied["model"], "cpa-gui/gpt-two");
    assert_eq!(
        reapplied["provider"][MANAGED_AGENT_PROVIDER_ID]["options"]["baseURL"],
        "http://127.0.0.1:8317/v1"
    );
    assert_eq!(
        reapplied["provider"][MANAGED_AGENT_PROVIDER_ID]["options"]["apiKey"],
        DEFAULT_API_KEY
    );
    assert_eq!(
        reapplied["provider"][MANAGED_AGENT_PROVIDER_ID]["customAfterApply"],
        "keep-me"
    );
    assert_eq!(reapplied["agentAdded"]["enabled"], true);
    assert_eq!(reapplied["provider"]["other"]["runtimeAdded"], 42);

    restore_agent_session_configuration(AgentClient::OpenCode, &home).unwrap();
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn session_merge_preserves_runtime_fields_for_other_agent_formats() {
    let claude_original = r#"{"env":{"KEEP_ENV":"original"},"keep":"claude"}"#;
    let claude_managed = build_claude_agent_config(
        Some(claude_original),
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "gpt-test",
        &test_agent_models(&["gpt-test"]),
        None,
    )
    .unwrap();
    let mut claude_current: serde_json::Value = serde_json::from_str(&claude_managed).unwrap();
    claude_current["runtimeAdded"] = serde_json::json!(true);
    claude_current["env"]["RUNTIME_ENV"] = serde_json::json!("keep");
    claude_current["env"]["ANTHROPIC_BASE_URL"] =
        serde_json::json!("https://agent-overwrite.invalid");
    let claude_restored = build_restored_claude_code_config(
        &serde_json::to_string(&claude_current).unwrap(),
        Some(claude_original),
    )
    .unwrap()
    .unwrap();
    let claude: serde_json::Value = serde_json::from_str(&claude_restored).unwrap();
    assert_eq!(claude["runtimeAdded"], true);
    assert_eq!(claude["env"]["RUNTIME_ENV"], "keep");
    assert_eq!(claude["env"]["KEEP_ENV"], "original");
    assert!(claude["env"].get("ANTHROPIC_BASE_URL").is_none());
    assert!(claude.get("model").is_none());

    let desktop_original = r#"{"keep":"desktop-profile"}"#;
    let desktop_managed = build_claude_desktop_profile(
        Some(desktop_original),
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "gpt-test",
        &[],
        None,
    )
    .unwrap();
    let mut desktop_current: serde_json::Value = serde_json::from_str(&desktop_managed).unwrap();
    desktop_current["runtimeAdded"] = serde_json::json!({"keep": true});
    desktop_current["inferenceGatewayBaseUrl"] =
        serde_json::json!("https://agent-overwrite.invalid");
    let desktop_restored = build_restored_claude_desktop_config(
        2,
        &serde_json::to_string(&desktop_current).unwrap(),
        Some(desktop_original),
    )
    .unwrap()
    .unwrap();
    let desktop: serde_json::Value = serde_json::from_str(&desktop_restored).unwrap();
    assert_eq!(desktop["keep"], "desktop-profile");
    assert_eq!(desktop["runtimeAdded"]["keep"], true);
    assert!(desktop.get("inferenceGatewayBaseUrl").is_none());
    assert!(desktop.get("inferenceGatewayApiKey").is_none());

    let models = test_agent_models(&["gpt-test"]);
    let openclaw_original = r#"{
  "models": {"providers": {"other": {"keep": true}}},
  "agents": {"defaults": {
    "model": {"primary": "other/original", "fallback": "other/fallback"},
    "models": {"other/original": {}}
  }},
  "keep": "openclaw"
}"#;
    let openclaw_managed = build_openclaw_agent_config(
        Some(openclaw_original),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "gpt-test",
        &models,
    )
    .unwrap();
    let mut openclaw_current: serde_json::Value = json5::from_str(&openclaw_managed).unwrap();
    openclaw_current["runtimeAdded"] = serde_json::json!(true);
    openclaw_current["models"]["providers"][MANAGED_AGENT_PROVIDER_ID]["customAfterApply"] =
        serde_json::json!("keep");
    openclaw_current["models"]["providers"][MANAGED_AGENT_PROVIDER_ID]["baseUrl"] =
        serde_json::json!("https://agent-overwrite.invalid");
    openclaw_current["agents"]["defaults"]["models"]["other/runtime"] =
        serde_json::json!({"keep": true});
    let openclaw_restored = build_restored_openclaw_config(
        &serde_json::to_string(&openclaw_current).unwrap(),
        Some(openclaw_original),
    )
    .unwrap()
    .unwrap();
    let openclaw: serde_json::Value = json5::from_str(&openclaw_restored).unwrap();
    assert_eq!(openclaw["runtimeAdded"], true);
    assert_eq!(
        openclaw["models"]["providers"][MANAGED_AGENT_PROVIDER_ID]["customAfterApply"],
        "keep"
    );
    assert!(openclaw["models"]["providers"][MANAGED_AGENT_PROVIDER_ID]
        .get("baseUrl")
        .is_none());
    assert_eq!(
        openclaw["agents"]["defaults"]["model"]["primary"],
        "other/original"
    );
    assert!(openclaw["agents"]["defaults"]["models"]
        .get("cpa-gui/gpt-test")
        .is_none());
    assert_eq!(
        openclaw["agents"]["defaults"]["models"]["other/runtime"]["keep"],
        true
    );
    let generated_openclaw = build_openclaw_agent_config(
        None,
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "gpt-test",
        &models,
    )
    .unwrap();
    assert!(build_restored_openclaw_config(&generated_openclaw, None)
        .unwrap()
        .is_none());

    let hermes_original = r#"keep: hermes
custom_providers:
  - name: other
    keep: true
model:
  default: original-model
  provider: other
  keep: model
"#;
    let hermes_managed = build_hermes_agent_config(
        Some(hermes_original),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "gpt-test",
        &models,
    )
    .unwrap();
    let mut hermes_current: serde_norway::Value = serde_norway::from_str(&hermes_managed).unwrap();
    let hermes_root = hermes_current.as_mapping_mut().unwrap();
    hermes_root.insert(yaml_key("runtimeAdded"), serde_norway::Value::Bool(true));
    let managed_provider = hermes_root
        .get_mut(yaml_key("custom_providers"))
        .and_then(serde_norway::Value::as_sequence_mut)
        .unwrap()
        .iter_mut()
        .find(|provider| {
            provider.get("name").and_then(serde_norway::Value::as_str)
                == Some(MANAGED_AGENT_PROVIDER_ID)
        })
        .and_then(serde_norway::Value::as_mapping_mut)
        .unwrap();
    managed_provider.insert(
        yaml_key("custom_after_apply"),
        serde_norway::Value::String("keep".to_string()),
    );
    managed_provider.insert(
        yaml_key("base_url"),
        serde_norway::Value::String("https://agent-overwrite.invalid".to_string()),
    );
    let hermes_restored = build_restored_hermes_config(
        &serde_norway::to_string(&hermes_current).unwrap(),
        Some(hermes_original),
    )
    .unwrap()
    .unwrap();
    let hermes: serde_norway::Value = serde_norway::from_str(&hermes_restored).unwrap();
    assert_eq!(hermes["runtimeAdded"], serde_norway::Value::Bool(true));
    assert_eq!(hermes["model"]["default"].as_str(), Some("original-model"));
    assert_eq!(hermes["model"]["provider"].as_str(), Some("other"));
    let hermes_managed_provider = hermes["custom_providers"]
        .as_sequence()
        .unwrap()
        .iter()
        .find(|provider| {
            provider.get("name").and_then(serde_norway::Value::as_str)
                == Some(MANAGED_AGENT_PROVIDER_ID)
        })
        .unwrap();
    assert_eq!(
        hermes_managed_provider["custom_after_apply"].as_str(),
        Some("keep")
    );
    assert!(hermes_managed_provider.get("base_url").is_none());
}

#[test]
fn legacy_agent_state_migration_preserves_backup_for_restore() {
    let home = agent_test_home("legacy-state-backup-migration");
    let path = home.join(".config/opencode/opencode.json");
    let state_path = agent_state_path(std::slice::from_ref(&path)).unwrap();
    let backup_path = agent_backup_path(&path).unwrap();
    let original = b"{\"provider\":\"original\"}";
    let managed = b"{\"provider\":\"managed\"}";
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, managed).unwrap();
    fs::write(&backup_path, original).unwrap();
    write_agent_state(
        &state_path,
        &AgentModificationRecord {
            version: AGENT_MODIFICATION_STATE_VERSION,
            client: AgentClient::OpenCode.id().to_string(),
            phase: AGENT_PHASE_ACTIVE.to_string(),
            model: "gpt-test".to_string(),
            files: vec![AgentModificationFile {
                path: path.clone(),
                backup_path: backup_path.clone(),
                existed_before: true,
                original_sha256: Some(sha256_bytes(original)),
                managed_sha256: sha256_bytes(managed),
            }],
        },
    )
    .unwrap();

    let migrated = load_agent_applied_state(AgentClient::OpenCode, &home)
        .unwrap()
        .unwrap();
    assert_eq!(migrated.version, AGENT_APPLIED_STATE_VERSION);
    assert_eq!(migrated.backup_files.len(), 1);
    assert_eq!(migrated.backup_files[0].path, path);
    assert_eq!(migrated.backup_files[0].backup_path, backup_path);
    assert!(migrated.backup_files[0].existed_before);
    assert!(backup_path.is_file());

    restore_agent_session_configuration(AgentClient::OpenCode, &home).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(!backup_path.exists());
    assert!(!state_path.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn legacy_codex_single_file_state_remains_restorable() {
    let home = agent_test_home("legacy-codex-single-file-state");
    let path = home.join(".codex/config.toml");
    let paths = vec![path.clone()];
    let state_path = agent_state_path(&paths).unwrap();
    let backup_path = agent_backup_path(&path).unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "model_provider = \"cpa-gui\"\n").unwrap();
    fs::write(&backup_path, "approval_policy = \"never\"\n").unwrap();
    fs::write(&state_path, "state").unwrap();
    let state = AgentAppliedState {
        version: AGENT_APPLIED_STATE_VERSION,
        client: AgentClient::Codex.id().to_string(),
        model: "gpt-test".to_string(),
        claude_desktop_model_mappings: None,
        backup_files: vec![AgentAppliedBackupFile {
            path: path.clone(),
            backup_path: backup_path.clone(),
            existed_before: true,
        }],
        updated_at_unix: 1,
    };

    restore_agent_applied_state_configuration(AgentClient::Codex, &paths, &state_path, &state)
        .unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "approval_policy = \"never\"\n"
    );
    assert!(!backup_path.exists());
    assert!(!state_path.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn claude_desktop_version_three_state_can_be_closed_safely() {
    let home = agent_test_home("claude-desktop-version-three-restore");
    let normal = home.join("Claude");
    let threep = home.join("Claude-3p");
    let paths = claude_desktop_config_paths_from_directories(normal, threep);
    let state_path = agent_state_path(&paths).unwrap();
    for path in &paths {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
    }
    fs::write(&paths[0], r#"{"deploymentMode":"3p","keep":"normal"}"#).unwrap();
    fs::write(&paths[1], r#"{"deploymentMode":"3p","keep":"threep"}"#).unwrap();
    fs::write(
        &paths[2],
        r#"{
  "coworkEgressAllowedHosts": ["127.0.0.1"],
  "disableDeploymentModeChooser": true,
  "inferenceGatewayApiKey": "managed-key",
  "inferenceGatewayAuthScheme": "bearer",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:8317",
  "inferenceProvider": "generic-chat-completion-api",
  "inferenceModels": ["claude-sonnet-4-5"],
  "keep": "profile"
}"#,
    )
    .unwrap();
    fs::write(
        &paths[3],
        format!(
            r#"{{
  "appliedId": "{CLAUDE_DESKTOP_PROFILE_ID}",
  "entries": [
    {{"id": "{CLAUDE_DESKTOP_PROFILE_ID}", "name": "CPA"}},
    {{"id": "other", "name": "Other"}}
  ],
  "keep": "meta"
}}"#
        ),
    )
    .unwrap();
    let state = AgentAppliedState {
        version: 3,
        client: AgentClient::ClaudeDesktop.id().to_string(),
        model: "gpt-test".to_string(),
        claude_desktop_model_mappings: None,
        backup_files: Vec::new(),
        updated_at_unix: 1,
    };
    write_agent_applied_state(&state_path, &state).unwrap();

    restore_agent_applied_state_configuration(
        AgentClient::ClaudeDesktop,
        &paths,
        &state_path,
        &state,
    )
    .unwrap();

    assert!(!state_path.exists());
    let normal: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&paths[0]).unwrap()).unwrap();
    let threep: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&paths[1]).unwrap()).unwrap();
    let profile: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&paths[2]).unwrap()).unwrap();
    let meta: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&paths[3]).unwrap()).unwrap();
    assert!(normal.get("deploymentMode").is_none());
    assert_eq!(normal["keep"], "normal");
    assert!(threep.get("deploymentMode").is_none());
    assert_eq!(threep["keep"], "threep");
    for key in [
        "coworkEgressAllowedHosts",
        "disableDeploymentModeChooser",
        "inferenceGatewayApiKey",
        "inferenceGatewayAuthScheme",
        "inferenceGatewayBaseUrl",
        "inferenceProvider",
        "inferenceModels",
    ] {
        assert!(profile.get(key).is_none(), "managed key remains: {key}");
    }
    assert_eq!(profile["keep"], "profile");
    assert!(meta.get("appliedId").is_none());
    assert_eq!(meta["keep"], "meta");
    assert_eq!(meta["entries"].as_array().unwrap().len(), 1);
    assert_eq!(meta["entries"][0]["id"], "other");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn opencode_version_three_state_uses_managed_marker_and_closes_safely() {
    let home = agent_test_home("opencode-version-three-restore");
    let path = home.join(".config/opencode/opencode.json");
    let state_path = agent_state_path(std::slice::from_ref(&path)).unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{
  "$schema": "https://opencode.ai/config.json",
  "model": "cpa-gui/gpt-test",
  "provider": {
    "cpa-gui": {
      "options": {"baseURL": "http://127.0.0.1:8317/v1", "apiKey": "secret"}
    },
    "other": {"keep": true}
  },
  "keep": "root"
}"#,
    )
    .unwrap();
    fs::write(
        &state_path,
        r#"{"version":3,"client":"opencode","model":"gpt-test","updatedAtUnix":1}"#,
    )
    .unwrap();

    let before = inspect_agent_application(AgentClient::OpenCode, &home);
    assert_eq!(before.state, "applied");
    assert!(!before.backup_available);
    restore_agent_session_configuration(AgentClient::OpenCode, &home).unwrap();

    let restored: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(restored.get("model").is_none());
    assert!(restored["provider"]
        .get(MANAGED_AGENT_PROVIDER_ID)
        .is_none());
    assert_eq!(restored["provider"]["other"]["keep"], true);
    assert_eq!(restored["keep"], "root");
    assert!(!state_path.exists());
    assert_eq!(
        inspect_agent_application(AgentClient::OpenCode, &home).state,
        "unconfigured"
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn stale_version_three_state_without_managed_configuration_is_not_applied() {
    let home = agent_test_home("stale-version-three-state");
    let path = home.join(".config/opencode/opencode.json");
    let state_path = agent_state_path(std::slice::from_ref(&path)).unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = r#"{"provider":{"other":{"keep":true}}}"#;
    fs::write(&path, original).unwrap();
    fs::write(
        &state_path,
        r#"{"version":3,"client":"opencode","model":"gpt-test","updatedAtUnix":1}"#,
    )
    .unwrap();

    assert_eq!(
        inspect_agent_application(AgentClient::OpenCode, &home).state,
        "unconfigured"
    );
    restore_agent_session_configuration(AgentClient::OpenCode, &home).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert!(!state_path.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn applied_state_rejects_backup_paths_outside_the_managed_config_set() {
    let home = agent_test_home("invalid-applied-backup-path");
    let path = home.join(".config/opencode/opencode.json");
    let state_path = agent_state_path(std::slice::from_ref(&path)).unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "{}").unwrap();
    write_agent_applied_state(
        &state_path,
        &AgentAppliedState {
            version: AGENT_APPLIED_STATE_VERSION,
            client: AgentClient::OpenCode.id().to_string(),
            model: "gpt-test".to_string(),
            claude_desktop_model_mappings: None,
            backup_files: vec![AgentAppliedBackupFile {
                path: path.clone(),
                backup_path: home.join("unexpected-location.bak"),
                existed_before: true,
            }],
            updated_at_unix: 1,
        },
    )
    .unwrap();

    let error = load_agent_applied_state(AgentClient::OpenCode, &home)
        .err()
        .unwrap();
    assert!(error.contains("非预期备份路径"));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn missing_session_backup_is_detected_before_any_file_is_restored() {
    let home = agent_test_home("missing-session-backup-preflight");
    let config_path = home.join(".codex/config.toml");
    let catalog_path = config_path.with_file_name(CODEX_MODEL_CATALOG_FILE);
    let paths = vec![config_path.clone()];
    let state_path = agent_state_path(&paths).unwrap();
    let config_backup = dated_agent_backup_path(&config_path).unwrap();
    let catalog_backup = dated_agent_backup_path(&catalog_path).unwrap();
    fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    fs::write(&config_path, "managed-config").unwrap();
    fs::write(&catalog_path, "managed-catalog").unwrap();
    fs::write(&config_backup, "original-config").unwrap();
    fs::write(&state_path, "state").unwrap();
    let state = AgentAppliedState {
        version: AGENT_APPLIED_STATE_VERSION,
        client: AgentClient::Codex.id().to_string(),
        model: "gpt-test".to_string(),
        claude_desktop_model_mappings: None,
        backup_files: vec![
            AgentAppliedBackupFile {
                path: config_path.clone(),
                backup_path: config_backup,
                existed_before: true,
            },
            AgentAppliedBackupFile {
                path: catalog_path.clone(),
                backup_path: catalog_backup,
                existed_before: true,
            },
        ],
        updated_at_unix: 1,
    };

    let error =
        restore_agent_applied_state_configuration(AgentClient::Codex, &paths, &state_path, &state)
            .err()
            .unwrap();
    assert!(error.contains("读取智能体备份失败"));
    assert_eq!(fs::read_to_string(&config_path).unwrap(), "managed-config");
    assert_eq!(
        fs::read_to_string(&catalog_path).unwrap(),
        "managed-catalog"
    );
    assert!(state_path.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn version_three_cleanup_covers_every_non_desktop_agent_format() {
    let home = agent_test_home("all-agent-version-three-cleanup");
    let state = |client: AgentClient| AgentAppliedState {
        version: 3,
        client: client.id().to_string(),
        model: "gpt-test".to_string(),
        claude_desktop_model_mappings: None,
        backup_files: Vec::new(),
        updated_at_unix: 1,
    };

    let claude_path = home.join("claude/settings.json");
    fs::create_dir_all(claude_path.parent().unwrap()).unwrap();
    fs::write(
        &claude_path,
        r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
    "ANTHROPIC_API_KEY": "secret",
    "ANTHROPIC_AUTH_TOKEN": "secret",
    "ANTHROPIC_MODEL": "gpt-test",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-test",
    "KEEP_ENV": "yes"
  },
  "model": "gpt-test",
  "keep": "claude"
}"#,
    )
    .unwrap();
    let claude_state_path = agent_state_path(std::slice::from_ref(&claude_path)).unwrap();
    fs::write(&claude_state_path, "state").unwrap();
    restore_agent_applied_state_configuration(
        AgentClient::ClaudeCode,
        std::slice::from_ref(&claude_path),
        &claude_state_path,
        &state(AgentClient::ClaudeCode),
    )
    .unwrap();
    let claude: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&claude_path).unwrap()).unwrap();
    assert!(claude.get("model").is_none());
    assert!(claude["env"].get("ANTHROPIC_BASE_URL").is_none());
    assert_eq!(claude["env"]["KEEP_ENV"], "yes");
    assert_eq!(claude["keep"], "claude");

    let codex_path = home.join("codex/config.toml");
    let codex_catalog = codex_path.with_file_name(CODEX_MODEL_CATALOG_FILE);
    fs::create_dir_all(codex_path.parent().unwrap()).unwrap();
    fs::write(
        &codex_path,
        r#"approval_policy = "never"
model_provider = "cpa-gui"
model = "gpt-test"
model_catalog_json = "cpa-gui-model-catalog.json"

[model_providers.cpa-gui]
name = "EasyCLIProxyAPI"
base_url = "http://127.0.0.1:8317/v1"

[model_providers.other]
name = "Other"
"#,
    )
    .unwrap();
    fs::write(&codex_catalog, "{}").unwrap();
    let codex_state_path = agent_state_path(std::slice::from_ref(&codex_path)).unwrap();
    fs::write(&codex_state_path, "state").unwrap();
    restore_agent_applied_state_configuration(
        AgentClient::Codex,
        std::slice::from_ref(&codex_path),
        &codex_state_path,
        &state(AgentClient::Codex),
    )
    .unwrap();
    let codex: toml::Value = toml::from_str(&fs::read_to_string(&codex_path).unwrap()).unwrap();
    assert_eq!(codex["approval_policy"].as_str(), Some("never"));
    assert!(codex.get("model_provider").is_none());
    assert!(codex.get("model").is_none());
    assert!(codex["model_providers"]
        .get(MANAGED_AGENT_PROVIDER_ID)
        .is_none());
    assert_eq!(
        codex["model_providers"]["other"]["name"].as_str(),
        Some("Other")
    );
    assert!(!codex_catalog.exists());

    let openclaw_path = home.join("openclaw/openclaw.json");
    fs::create_dir_all(openclaw_path.parent().unwrap()).unwrap();
    fs::write(
        &openclaw_path,
        r#"// keep-comment
{
  models: {
    mode: "merge",
    providers: {
      "cpa-gui": {baseUrl: "http://127.0.0.1:8317/v1"},
      other: {keep: true}
    }
  },
  agents: {defaults: {
    model: {primary: "cpa-gui/gpt-test", fallback: "other/model"},
    models: {"cpa-gui/gpt-test": {}, "other/model": {}}
  }},
  keep: "openclaw"
}"#,
    )
    .unwrap();
    let openclaw_state_path = agent_state_path(std::slice::from_ref(&openclaw_path)).unwrap();
    fs::write(&openclaw_state_path, "state").unwrap();
    restore_agent_applied_state_configuration(
        AgentClient::OpenClaw,
        std::slice::from_ref(&openclaw_path),
        &openclaw_state_path,
        &state(AgentClient::OpenClaw),
    )
    .unwrap();
    let openclaw_content = fs::read_to_string(&openclaw_path).unwrap();
    assert!(openclaw_content.contains("// keep-comment"));
    let openclaw: serde_json::Value = json5::from_str(&openclaw_content).unwrap();
    assert!(openclaw["models"]["providers"]
        .get(MANAGED_AGENT_PROVIDER_ID)
        .is_none());
    assert_eq!(openclaw["models"]["providers"]["other"]["keep"], true);
    assert!(openclaw["agents"]["defaults"]["model"]
        .get("primary")
        .is_none());
    assert_eq!(
        openclaw["agents"]["defaults"]["model"]["fallback"],
        "other/model"
    );
    assert!(openclaw["agents"]["defaults"]["models"]
        .get("cpa-gui/gpt-test")
        .is_none());
    assert!(openclaw["agents"]["defaults"]["models"]
        .get("other/model")
        .is_some());

    let hermes_path = home.join("hermes/config.yaml");
    fs::create_dir_all(hermes_path.parent().unwrap()).unwrap();
    fs::write(
        &hermes_path,
        r#"keep: hermes
custom_providers:
  - name: other
    keep: true
  - name: cpa-gui
    base_url: http://127.0.0.1:8317/v1
model:
  default: gpt-test
  provider: cpa-gui
  keep: model
"#,
    )
    .unwrap();
    let hermes_state_path = agent_state_path(std::slice::from_ref(&hermes_path)).unwrap();
    fs::write(&hermes_state_path, "state").unwrap();
    restore_agent_applied_state_configuration(
        AgentClient::Hermes,
        std::slice::from_ref(&hermes_path),
        &hermes_state_path,
        &state(AgentClient::Hermes),
    )
    .unwrap();
    let hermes: serde_norway::Value =
        serde_norway::from_str(&fs::read_to_string(&hermes_path).unwrap()).unwrap();
    assert_eq!(hermes["keep"].as_str(), Some("hermes"));
    assert_eq!(hermes["custom_providers"].as_sequence().unwrap().len(), 1);
    assert_eq!(
        hermes["custom_providers"][0]["name"].as_str(),
        Some("other")
    );
    assert!(hermes["model"].get("provider").is_none());
    assert!(hermes["model"].get("default").is_none());
    assert_eq!(hermes["model"]["keep"].as_str(), Some("model"));

    for state_path in [
        claude_state_path,
        codex_state_path,
        openclaw_state_path,
        hermes_state_path,
    ] {
        assert!(!state_path.exists());
    }
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn codex_session_restore_does_not_create_a_state_json_file() {
    let home = agent_test_home("codex-session-without-state-file");
    let config_path = home.join(".codex/config.toml");
    let catalog_path = codex_model_catalog_path(&home);
    let state_path = agent_state_path(std::slice::from_ref(&config_path)).unwrap();
    let original = b"approval_policy = \"never\"\n";
    fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    fs::write(&config_path, original).unwrap();

    commit_agent_configuration(
        AgentClient::Codex,
        &home,
        "gpt-test",
        &[
            AgentFileUpdate {
                path: config_path.clone(),
                after: "model = \"gpt-test\"\n".to_string(),
            },
            AgentFileUpdate {
                path: catalog_path.clone(),
                after: "{\"models\":[]}".to_string(),
            },
        ],
        "applied",
        None,
    )
    .unwrap();

    let backup = dated_agent_backup_path(&config_path).unwrap();
    assert!(backup.is_file());
    assert!(!state_path.exists());
    assert_eq!(
        inspect_agent_application(AgentClient::Codex, &home).state,
        "applied"
    );

    restore_agent_session_configuration(AgentClient::Codex, &home).unwrap();
    assert_eq!(fs::read(&config_path).unwrap(), original);
    assert!(!catalog_path.exists());
    assert!(!backup.exists());
    assert!(!state_path.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn codex_session_restore_recovers_from_a_dated_backup_without_state_json() {
    let home = agent_test_home("codex-session-backup-recovery");
    let config_path = home.join(".codex/config.toml");
    let catalog_path = codex_model_catalog_path(&home);
    let state_path = agent_state_path(std::slice::from_ref(&config_path)).unwrap();
    let backup = dated_agent_backup_path(&config_path).unwrap();
    let original = b"approval_policy = \"on-request\"\n";
    fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    fs::write(&backup, original).unwrap();
    fs::write(&config_path, "model = \"gpt-test\"\n").unwrap();
    fs::write(&catalog_path, "{\"models\":[]}").unwrap();

    restore_agent_session_configuration(AgentClient::Codex, &home).unwrap();

    assert_eq!(fs::read(&config_path).unwrap(), original);
    assert!(!catalog_path.exists());
    assert!(!backup.exists());
    assert!(!state_path.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn direct_agent_apply_preserves_unrelated_fields_and_default_reset_removes_them() {
    let home = agent_test_home("direct-apply");
    let path = home.join(".codex/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
            &path,
            "# user comment\nuser_setting = \"keep\"\nmodel = \"external\"\nmodel_provider = \"other\"\n\n[model_providers.other]\nname = \"Other\"\nbase_url = \"https://example.com\"\n",
        )
        .unwrap();
    let models = test_agent_models(&["gpt-test"]);
    let codex_models = test_codex_models(&["gpt-test"]);
    let api_key = "custom-agent-key";

    let result = apply_agent_configuration(
        AgentClient::Codex,
        &home,
        8317,
        api_key,
        "gpt-test",
        &models,
        Some(&codex_models),
    )
    .unwrap();
    assert_eq!(result.outcome, "applied");
    let applied = fs::read_to_string(&path).unwrap();
    assert!(applied.contains("# user comment"));
    assert!(applied.contains("user_setting = \"keep\""));
    assert!(applied.contains("[model_providers.other]"));
    assert!(applied.contains("model = \"gpt-test\""));
    assert!(applied.contains("experimental_bearer_token = \"custom-agent-key\""));
    assert!(!agent_backup_path(&path).unwrap().exists());
    assert!(!agent_backup_path(&codex_model_catalog_path(&home))
        .unwrap()
        .exists());
    assert_eq!(
        inspect_agent_application(AgentClient::Codex, &home).state,
        "applied"
    );

    let mut document = applied.parse::<toml_edit::Document>().unwrap();
    document["user_setting"] = toml_edit::value("changed-externally");
    fs::write(&path, document.to_string()).unwrap();
    assert_eq!(
        inspect_agent_application(AgentClient::Codex, &home).state,
        "applied"
    );

    document["model"] = toml_edit::value("external-model");
    fs::write(&path, document.to_string()).unwrap();
    assert_eq!(
        inspect_agent_application(AgentClient::Codex, &home).state,
        "applied"
    );

    apply_agent_configuration(
        AgentClient::Codex,
        &home,
        8317,
        api_key,
        "gpt-test",
        &models,
        Some(&codex_models),
    )
    .unwrap();
    let reapplied = fs::read_to_string(&path).unwrap();
    assert!(reapplied.contains("user_setting = \"changed-externally\""));
    assert!(reapplied.contains("model = \"gpt-test\""));

    reset_agent_configuration_to_default(
        AgentClient::Codex,
        &home,
        8317,
        api_key,
        "gpt-test",
        Some(&codex_models),
    )
    .unwrap();
    let reset = fs::read_to_string(&path).unwrap();
    assert!(!reset.contains("user_setting"));
    assert!(!reset.contains("model_providers.other"));
    assert!(reset.contains("model = \"gpt-test\""));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn clear_codex_config_removes_only_requested_config_files_and_application_state() {
    let home = agent_test_home("clear-codex-config");
    let codex_dir = home.join(".codex");
    fs::create_dir_all(&codex_dir).unwrap();
    let auth_path = codex_dir.join("auth.json");
    let config_path = codex_dir.join("config.toml");
    let state_path = agent_state_path(std::slice::from_ref(&config_path)).unwrap();
    let preserved_path = codex_dir.join("history.jsonl");
    fs::write(&auth_path, "{}").unwrap();
    fs::write(&config_path, "model = \"gpt-test\"\n").unwrap();
    fs::write(&state_path, "{}").unwrap();
    fs::write(&preserved_path, "keep").unwrap();

    let deleted = clear_codex_config_files(&home).unwrap();

    assert_eq!(deleted.len(), 2);
    assert!(!auth_path.exists());
    assert!(!config_path.exists());
    assert!(!state_path.exists());
    assert_eq!(fs::read_to_string(&preserved_path).unwrap(), "keep");
    assert!(clear_codex_config_files(&home).unwrap().is_empty());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn direct_agent_apply_rebuilds_an_unparseable_file_without_backup() {
    let home = agent_test_home("invalid-apply");
    let path = home.join(".config/opencode/opencode.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "{ invalid json").unwrap();
    let models = test_agent_models(&["model-a"]);

    apply_agent_configuration(
        AgentClient::OpenCode,
        &home,
        8317,
        DEFAULT_API_KEY,
        "model-a",
        &models,
        None,
    )
    .unwrap();

    let root =
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(root["model"], "cpa-gui/model-a");
    assert!(!agent_backup_path(&path).unwrap().exists());
    assert_eq!(
        inspect_agent_application(AgentClient::OpenCode, &home).state,
        "applied"
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_builders_repair_wrong_managed_node_types() {
    let claude = build_claude_agent_config(
        Some(r#"{"keep":true,"env":"broken"}"#),
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "model-a",
        &test_agent_models(&["model-a"]),
        None,
    )
    .unwrap();
    let claude = serde_json::from_str::<serde_json::Value>(&claude).unwrap();
    assert_eq!(claude["keep"], true);
    assert_eq!(claude["env"]["ANTHROPIC_MODEL"], "model-a");

    let codex = build_codex_agent_config(
        Some("custom = true\nmodel_providers = 7\n"),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "model-a",
    )
    .unwrap();
    let codex = toml::from_str::<toml::Value>(&codex).unwrap();
    assert_eq!(codex["custom"].as_bool(), Some(true));
    assert_eq!(
        codex["model_providers"][MANAGED_AGENT_PROVIDER_ID]["base_url"].as_str(),
        Some("http://127.0.0.1:8317/v1")
    );

    let hermes = build_hermes_agent_config(
        Some("theme: dark\ncustom_providers: broken\nmodel: 1\n"),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "model-a",
        &test_agent_models(&["model-a"]),
    )
    .unwrap();
    let hermes = serde_norway::from_str::<serde_norway::Value>(&hermes).unwrap();
    assert_eq!(hermes["theme"], "dark");
    assert_eq!(hermes["model"]["default"], "model-a");
    assert!(hermes["custom_providers"].is_sequence());
}

#[test]
fn build_agent_updates_rebuilds_invalid_json5_toml_and_yaml() {
    let home = agent_test_home("invalid-formats");
    let models = test_agent_models(&["model-a"]);
    let codex_models = test_codex_models(&["model-a"]);
    for (client, path) in [
        (AgentClient::ClaudeCode, home.join(".claude/settings.json")),
        (AgentClient::Codex, home.join(".codex/config.toml")),
        (AgentClient::OpenClaw, home.join(".openclaw/openclaw.json")),
    ] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "not valid {{{").unwrap();
        let updates = build_agent_updates(
            client,
            &home,
            8317,
            DEFAULT_API_KEY,
            "model-a",
            &models,
            (client == AgentClient::Codex).then_some(codex_models.as_str()),
        )
        .unwrap();
        assert!(!updates[0].after.trim().is_empty());
    }
    let hermes = build_hermes_agent_config(
        Some("not valid {{{"),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "model-a",
        &models,
    )
    .or_else(|_| {
        build_hermes_agent_config(
            None,
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "model-a",
            &models,
        )
    })
    .unwrap();
    assert!(!hermes.trim().is_empty());
    fs::remove_dir_all(home).unwrap();
}
