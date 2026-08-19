use super::support::*;
use super::*;

#[test]
fn claude_agent_config_preserves_existing_fields() {
    let rendered = build_claude_agent_config(
            Some(
                r#"{"theme":"dark","env":{"KEEP":"yes","ANTHROPIC_API_KEY":"legacy-key","CLAUDE_CODE_EFFORT_LEVEL":"max"}}"#,
            ),
            "http://127.0.0.1:8317",
            DEFAULT_API_KEY,
            "claude-test",
            &test_agent_models(&["claude-test"]),
            None,
        )
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();

    assert_eq!(value["theme"], "dark");
    assert_eq!(value["env"]["KEEP"], "yes");
    assert!(value["env"].get("ANTHROPIC_API_KEY").is_none());
    assert_eq!(value["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:8317");
    assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], DEFAULT_API_KEY);
    assert_eq!(value["env"]["ANTHROPIC_MODEL"], "claude-test");
    assert_eq!(
        value["env"][CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV],
        "1"
    );
    assert_eq!(value["env"][CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV], "200000");
    assert_eq!(value["env"][CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV], "90");
    assert!(value["env"].get(DISABLE_AUTO_COMPACT_ENV).is_none());
    assert!(value["env"].get("CLAUDE_CODE_EFFORT_LEVEL").is_none());
    assert_eq!(value["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "claude-test");
    assert_eq!(
        value["env"]["ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"],
        "claude-test (200K context)"
    );
    assert_eq!(value["model"], "claude-test");
}

#[test]
fn claude_code_inspection_normalizes_legacy_1m_suffix() {
    let directory = agent_test_home("claude-code-1m-inspection");
    let path = directory.join("settings.json");
    fs::write(
        &path,
        r#"{
                "env": {
                    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
                    "ANTHROPIC_AUTH_TOKEN": "test-key",
                    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
                    "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1m]",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash"
                },
                "model": "deepseek-v4-pro[1m]"
            }"#,
    )
    .unwrap();

    let (configured, model) = inspect_claude_agent_config(&path, 8317, "test-key").unwrap();
    let mappings = inspect_claude_code_model_mappings(&path).unwrap().unwrap();

    assert!(configured);
    assert_eq!(model.as_deref(), Some("deepseek-v4-pro"));
    assert_eq!(mappings.opus, "deepseek-v4-pro");
    assert_eq!(mappings.sonnet, "deepseek-v4-pro");
    assert_eq!(mappings.haiku, "deepseek-v4-flash");
    assert!(mappings.opus_1m);
    assert!(mappings.sonnet_1m);
    assert!(!mappings.haiku_1m);
    assert_eq!(mappings.max_context_tokens, 1_000_000);
    assert_eq!(mappings.auto_compact_pct, 90);
    assert!(!mappings.disable_auto_compact);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn claude_code_requires_gateway_model_discovery_to_be_enabled() {
    let directory = agent_test_home("claude-code-gateway-model-discovery");
    let path = directory.join("settings.json");
    fs::write(
        &path,
        r#"{
                "env": {
                    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317",
                    "ANTHROPIC_AUTH_TOKEN": "test-key",
                    "ANTHROPIC_MODEL": "gpt-test",
                    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "0"
                }
            }"#,
    )
    .unwrap();

    let (configured, model) = inspect_claude_agent_config(&path, 8317, "test-key").unwrap();

    assert!(!configured);
    assert_eq!(model.as_deref(), Some("gpt-test"));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn claude_mapping_legacy_json_defaults_1m_preferences_off() {
    let mappings: ClaudeDesktopModelMappings =
        serde_json::from_str(r#"{"opus":"model-a","sonnet":"model-b","haiku":"model-c"}"#).unwrap();

    assert!(!mappings.opus_1m);
    assert!(!mappings.sonnet_1m);
    assert!(!mappings.haiku_1m);
    assert_eq!(mappings.max_context_tokens, 200_000);
    assert_eq!(mappings.auto_compact_pct, 90);
    assert!(!mappings.disable_auto_compact);
}

#[test]
fn claude_code_role_mappings_drive_settings() {
    let mappings = ClaudeDesktopModelMappings {
        opus: "gpt-opus".to_string(),
        sonnet: "gpt-sonnet".to_string(),
        haiku: "gpt-haiku".to_string(),
        opus_1m: false,
        sonnet_1m: false,
        haiku_1m: false,
        max_context_tokens: 272_000,
        auto_compact_pct: 80,
        disable_auto_compact: false,
    };
    let models = vec![
        AgentModelOption {
            name: "gpt-opus-base".to_string(),
            alias: None,
            is_alias: false,
            context_window: Some(1_000_000),
        },
        AgentModelOption {
            name: mappings.opus.clone(),
            alias: Some("gpt-opus-base".to_string()),
            is_alias: true,
            context_window: Some(128_000),
        },
        AgentModelOption {
            name: mappings.sonnet.clone(),
            alias: None,
            is_alias: false,
            context_window: Some(272_000),
        },
        AgentModelOption {
            name: mappings.haiku.clone(),
            alias: None,
            is_alias: false,
            context_window: Some(128_000),
        },
    ];
    let rendered = build_claude_agent_config(
        None,
        "http://127.0.0.1:8317",
        "test-key",
        "gpt-sonnet",
        &models,
        Some(&mappings),
    )
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    assert_eq!(value["env"]["ANTHROPIC_MODEL"], "gpt-sonnet");
    assert_eq!(value["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"], "gpt-opus");
    assert_eq!(value["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"], "gpt-sonnet");
    assert_eq!(value["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "gpt-haiku");
    assert_eq!(value["env"][CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV], "272000");
    assert_eq!(
        value["env"]["ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"],
        "gpt-sonnet (272K context)"
    );
}

#[test]
fn claude_code_runtime_settings_keep_per_role_1m_suffixes() {
    let mappings = ClaudeDesktopModelMappings {
        opus: "custom-pro".to_string(),
        sonnet: "custom-pro".to_string(),
        haiku: "custom-flash".to_string(),
        opus_1m: true,
        sonnet_1m: true,
        haiku_1m: false,
        max_context_tokens: 1_000_000,
        auto_compact_pct: 75,
        disable_auto_compact: true,
    };
    let models = vec![
        AgentModelOption {
            name: "custom-pro".to_string(),
            alias: Some("Custom Pro".to_string()),
            is_alias: false,
            context_window: Some(200_000),
        },
        AgentModelOption {
            name: "custom-flash".to_string(),
            alias: Some("Custom Flash".to_string()),
            is_alias: false,
            context_window: Some(200_000),
        },
    ];
    let rendered = build_claude_agent_config(
        None,
        "http://127.0.0.1:8317",
        "test-key",
        "custom-pro",
        &models,
        Some(&mappings),
    )
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();

    assert_eq!(value["env"][CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV], "1000000");
    assert_eq!(value["env"][CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV], "75");
    assert_eq!(value["env"][DISABLE_AUTO_COMPACT_ENV], "1");
    assert_eq!(value["env"]["ANTHROPIC_MODEL"], "custom-pro[1m]");
    assert_eq!(
        value["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"],
        "custom-pro[1m]"
    );
    assert_eq!(
        value["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
        "custom-pro[1m]"
    );
    assert_eq!(
        value["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
        "custom-flash"
    );
    assert_eq!(
        value["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"],
        "custom-pro[1m]"
    );
    assert_eq!(value["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "custom-flash");
    assert!(value["env"].get("CLAUDE_CODE_EFFORT_LEVEL").is_none());
    assert_eq!(
        value["env"]["ANTHROPIC_CUSTOM_MODEL_OPTION"],
        "custom-pro[1m]"
    );
    assert_eq!(
        value["env"]["ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"],
        "Custom Pro (1M context)"
    );
    assert_eq!(
        value["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL_NAME"],
        "Custom Pro (Fable mapping, 1M context)"
    );
    assert_eq!(value["model"], "custom-pro[1m]");
}

#[test]
fn claude_desktop_keeps_original_context_when_1m_is_off() {
    let models = vec![AgentModelOption {
        name: "runtime-model".to_string(),
        alias: None,
        is_alias: false,
        context_window: Some(1_000_000),
    }];
    let entry = claude_desktop_inference_model(
        CLAUDE_DESKTOP_SONNET_MODEL_ID,
        "runtime-model",
        false,
        &models,
    );

    assert_eq!(entry["contextWindow"], 1_000_000);
    assert!(entry.get("supports1m").is_none());
    assert!(entry.get("prefer1m").is_none());
}

#[test]
fn codex_agent_config_uses_managed_provider_without_losing_comments() {
    let rendered = build_codex_agent_config(
        Some("# keep this comment\napproval_policy = \"on-request\"\n"),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "gpt-test",
    )
    .unwrap();
    let value: toml::Value = toml::from_str(&rendered).unwrap();

    assert!(rendered.contains("# keep this comment"));
    assert_eq!(value["approval_policy"].as_str(), Some("on-request"));
    assert_eq!(
        value["model_provider"].as_str(),
        Some(MANAGED_AGENT_PROVIDER_ID)
    );
    assert_eq!(value["model"].as_str(), Some("gpt-test"));
    assert_eq!(
        value["model_catalog_json"].as_str(),
        Some(CODEX_MODEL_CATALOG_FILE)
    );
    assert_eq!(
        value["model_providers"][MANAGED_AGENT_PROVIDER_ID]["base_url"].as_str(),
        Some("http://127.0.0.1:8317/v1")
    );
    assert_eq!(
        value["model_providers"][MANAGED_AGENT_PROVIDER_ID]["experimental_bearer_token"].as_str(),
        Some(DEFAULT_API_KEY)
    );
}

#[test]
fn codex_oauth_configuration_uses_openai_auth_with_bearer_token() {
    let home = agent_test_home("codex-oauth-configuration");
    let path = home.join(".codex/config.toml");
    let rendered = build_codex_agent_config_with_oauth(
        Some("[model_providers.cpa-gui]\nexperimental_bearer_token = \"old-key\"\n"),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "gpt-test",
        true,
    )
    .unwrap();
    let value = toml::from_str::<toml::Value>(&rendered).unwrap();
    let provider = value["model_providers"][MANAGED_AGENT_PROVIDER_ID]
        .as_table()
        .unwrap();

    assert_eq!(
        provider
            .get("requires_openai_auth")
            .and_then(toml::Value::as_bool),
        Some(true)
    );
    assert_eq!(
        provider
            .get("experimental_bearer_token")
            .and_then(toml::Value::as_str),
        Some(DEFAULT_API_KEY)
    );

    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, rendered).unwrap();
    let (configured, model, oauth_configuration) =
        inspect_codex_agent_config(&path, 8317, DEFAULT_API_KEY).unwrap();
    assert!(configured);
    assert_eq!(model.as_deref(), Some("gpt-test"));
    assert!(oauth_configuration);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn codex_api_and_oauth_modes_write_the_same_catalog() {
    let home = agent_test_home("codex-auth-mode-catalog");
    let models = test_agent_models(&["gpt-5.5", "third-party-model"]);
    let catalog = test_codex_models(&["gpt-5.5", "third-party-model"]);
    let build = |oauth_configuration| {
        build_agent_updates_with_oauth(
            AgentClient::Codex,
            &home,
            8317,
            DEFAULT_API_KEY,
            "gpt-5.5",
            AgentConfigurationOptions {
                models: &models,
                codex_catalog: Some(&catalog),
                oauth_configuration,
                claude_code_model_mappings: None,
                claude_desktop_model_mappings: None,
                claude_desktop_egress_allowed_hosts: None,
            },
        )
        .unwrap()
    };
    let api_updates = build(false);
    let oauth_updates = build(true);

    assert_eq!(api_updates[1].after, oauth_updates[1].after);
    assert!(api_updates[0].after.contains("model_catalog_json"));
    assert!(oauth_updates[0].after.contains("model_catalog_json"));
    assert!(!api_updates[0].after.contains("service_tier"));
    assert!(!oauth_updates[0].after.contains("service_tier"));
    assert!(!api_updates[0].after.contains("requires_openai_auth"));
    assert!(oauth_updates[0]
        .after
        .contains("requires_openai_auth = true"));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn codex_status_requires_a_valid_catalog_containing_the_default_model() {
    let home = agent_test_home("codex-catalog-status");
    let config_path = home.join(".codex/config.toml");
    let catalog_path = codex_model_catalog_path(&home);
    fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    fs::write(
        &config_path,
        build_codex_agent_config(
            None,
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "gpt-test",
        )
        .unwrap(),
    )
    .unwrap();

    let missing = inspect_agent_config(AgentClient::Codex, &home, 8317, DEFAULT_API_KEY);
    assert!(!missing.configured);
    assert!(!missing.config_valid);

    fs::write(&catalog_path, "not json").unwrap();
    let damaged = inspect_agent_config(AgentClient::Codex, &home, 8317, DEFAULT_API_KEY);
    assert!(!damaged.configured);
    assert!(!damaged.config_valid);

    fs::write(&catalog_path, test_codex_models(&["other-model"])).unwrap();
    let wrong_model = inspect_agent_config(AgentClient::Codex, &home, 8317, DEFAULT_API_KEY);
    assert!(!wrong_model.configured);
    assert!(!wrong_model.config_valid);

    fs::write(&catalog_path, test_codex_models(&["gpt-test"])).unwrap();
    let valid = inspect_agent_config(AgentClient::Codex, &home, 8317, DEFAULT_API_KEY);
    assert!(valid.configured);
    assert!(valid.config_valid);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn invalid_codex_catalog_does_not_partially_update_existing_files() {
    let home = agent_test_home("invalid-codex-catalog-transaction");
    let config_path = home.join(".codex/config.toml");
    let catalog_path = codex_model_catalog_path(&home);
    fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    let original_config = "model = \"user-model\"\n";
    let original_catalog = "{\"models\":[{\"slug\":\"user-model\"}]}\n";
    fs::write(&config_path, original_config).unwrap();
    fs::write(&catalog_path, original_catalog).unwrap();

    let result = apply_agent_configuration(
        AgentClient::Codex,
        &home,
        8317,
        DEFAULT_API_KEY,
        "gpt-test",
        &test_agent_models(&["gpt-test"]),
        Some("{invalid"),
    );
    assert!(result.is_err());
    assert_eq!(fs::read_to_string(&config_path).unwrap(), original_config);
    assert_eq!(fs::read_to_string(&catalog_path).unwrap(), original_catalog);
    assert!(!agent_state_path(&[config_path]).unwrap().exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn claude_desktop_config_builds_gateway_profile_and_index() {
    let profile = build_claude_desktop_profile(
        Some(r#"{"keep":true,"coworkEgressAllowedHosts":["*"]}"#),
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "claude-sonnet-test",
        &[],
        None,
        None,
    )
    .unwrap();
    let meta = build_claude_desktop_meta(Some(
            &format!(
                r#"{{"entries":[{{"id":"other","name":"Other"}},{{"id":"{CLAUDE_DESKTOP_PROFILE_ID}","name":"Old","custom":true}},{{"id":"{CLAUDE_DESKTOP_PROFILE_ID}","name":"Duplicate"}},{{"name":"broken"}}]}}"#,
            ),
        ))
        .unwrap();
    let profile: serde_json::Value = serde_json::from_str(&profile).unwrap();
    let meta: serde_json::Value = serde_json::from_str(&meta).unwrap();

    assert_eq!(profile["keep"], true);
    assert_eq!(
        profile[CLAUDE_DESKTOP_EGRESS_ALLOWED_HOSTS_KEY],
        serde_json::json!(["*"])
    );
    assert_eq!(profile["inferenceGatewayApiKey"], DEFAULT_API_KEY);
    assert_eq!(profile["inferenceGatewayBaseUrl"], "http://127.0.0.1:8317");
    assert_eq!(
        profile["inferenceModels"],
        serde_json::json!([
            { "name": CLAUDE_DESKTOP_OPUS_MODEL_ID },
            { "name": CLAUDE_DESKTOP_SONNET_MODEL_ID },
            { "name": CLAUDE_DESKTOP_HAIKU_MODEL_ID }
        ])
    );
    assert_eq!(meta["appliedId"], CLAUDE_DESKTOP_PROFILE_ID);
    assert_eq!(meta["entries"].as_array().unwrap().len(), 2);
    let managed_entry = meta["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == CLAUDE_DESKTOP_PROFILE_ID)
        .unwrap();
    assert_eq!(managed_entry["custom"], true);
}

#[test]
fn claude_desktop_profile_uses_safe_defaults_and_normalizes_explicit_hosts() {
    let profile = build_claude_desktop_profile(
        None,
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "claude-sonnet-test",
        &[],
        None,
        None,
    )
    .unwrap();
    let profile: serde_json::Value = serde_json::from_str(&profile).unwrap();
    assert_eq!(
        profile[CLAUDE_DESKTOP_EGRESS_ALLOWED_HOSTS_KEY],
        serde_json::json!(DEFAULT_CLAUDE_DESKTOP_EGRESS_ALLOWED_HOSTS)
    );
    assert!(!profile[CLAUDE_DESKTOP_EGRESS_ALLOWED_HOSTS_KEY]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("*")));

    let explicit = vec![
        " GitHub.com ".to_string(),
        "*.GitHub.com:443".to_string(),
        "github.com".to_string(),
        "127.0.0.1:8317".to_string(),
    ];
    let profile = build_claude_desktop_profile(
        Some(r#"{"coworkEgressAllowedHosts":["*"]}"#),
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "claude-sonnet-test",
        &[],
        None,
        Some(&explicit),
    )
    .unwrap();
    let profile: serde_json::Value = serde_json::from_str(&profile).unwrap();
    assert_eq!(
        profile[CLAUDE_DESKTOP_EGRESS_ALLOWED_HOSTS_KEY],
        serde_json::json!(["github.com", "*.github.com:443", "127.0.0.1:8317"])
    );
}

#[test]
fn claude_desktop_egress_hosts_reject_invalid_entries() {
    for invalid in [
        "",
        "https://github.com",
        "github.com/path",
        "github.com:0",
        "github.com:65536",
        "github.com:abc",
        "*:443",
        "*.127.0.0.1",
        "*.localhost",
        "2001:db8::1",
        "bad_host.example.com",
    ] {
        let hosts = vec![invalid.to_string()];
        assert!(
            normalize_claude_desktop_egress_allowed_hosts(&hosts).is_err(),
            "accepted invalid egress host: {invalid}"
        );
    }
    for valid in [
        "*",
        "localhost",
        "localhost:8317",
        "api.github.com",
        "*.corp.example.com",
        "*.corp.example.com:8443",
        "127.0.0.1",
    ] {
        let hosts = vec![valid.to_string()];
        assert_eq!(
            normalize_claude_desktop_egress_allowed_hosts(&hosts).unwrap(),
            hosts,
            "rejected valid egress host: {valid}"
        );
    }
}

#[test]
fn claude_desktop_profile_inspection_reads_current_egress_hosts() {
    let home = agent_test_home("claude-desktop-egress-inspection");
    let path = home.join("profile.json");
    fs::write(
        &path,
        r#"{"coworkEgressAllowedHosts":["GitHub.com","*.github.com"]}"#,
    )
    .unwrap();

    assert_eq!(
        inspect_claude_desktop_egress_allowed_hosts(&path).unwrap(),
        Some(vec!["github.com".to_string(), "*.github.com".to_string()])
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn claude_desktop_profile_keeps_non_claude_models_internal() {
    let mappings = ClaudeDesktopModelMappings {
        opus: "gpt-5.6-sol".to_string(),
        sonnet: "gpt-5.6".to_string(),
        haiku: "gpt-5.6-mini".to_string(),
        opus_1m: true,
        sonnet_1m: false,
        haiku_1m: true,
        ..ClaudeDesktopModelMappings::all("")
    };
    let models = vec![
        AgentModelOption {
            name: mappings.opus.clone(),
            alias: None,
            is_alias: false,
            context_window: Some(1_000_000),
        },
        AgentModelOption {
            name: mappings.sonnet.clone(),
            alias: None,
            is_alias: false,
            context_window: Some(272_000),
        },
        AgentModelOption {
            name: mappings.haiku.clone(),
            alias: None,
            is_alias: false,
            context_window: Some(1_000_000),
        },
    ];
    let profile = build_claude_desktop_profile(
        None,
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "gpt-5.6-sol",
        &models,
        Some(&mappings),
        None,
    )
    .unwrap();
    let profile: serde_json::Value = serde_json::from_str(&profile).unwrap();

    assert_eq!(
        profile["inferenceModels"],
        serde_json::json!([
            {
                "name": CLAUDE_DESKTOP_OPUS_MODEL_ID,
                "contextWindow": 1000000,
                "supports1m": true,
                "prefer1m": true
            },
            { "name": CLAUDE_DESKTOP_SONNET_MODEL_ID, "contextWindow": 272000 },
            {
                "name": CLAUDE_DESKTOP_HAIKU_MODEL_ID,
                "contextWindow": 1000000,
                "supports1m": true,
                "prefer1m": true
            }
        ])
    );
    assert!(!profile.to_string().contains("gpt-"));
}

#[cfg(target_os = "windows")]
#[test]
fn claude_desktop_detects_windows_variant_config_directories() {
    let home = agent_test_home("claude-desktop-windows-variant-paths");
    let local_app_data = home.join("AppData/Local");
    let normal = local_app_data.join("Claude-Canary");
    let threep = local_app_data.join("Claude-3p-Canary");
    fs::create_dir_all(&normal).unwrap();
    fs::create_dir_all(&threep).unwrap();

    let paths = claude_desktop_config_paths_from_local_app_data(&local_app_data);

    assert_eq!(paths.len(), 4);
    assert_eq!(paths[0], normal.join("claude_desktop_config.json"));
    assert_eq!(paths[1], threep.join("claude_desktop_config.json"));
    assert_eq!(
        paths[2],
        threep
            .join("configLibrary")
            .join(format!("{CLAUDE_DESKTOP_PROFILE_ID}.json"))
    );
    assert_eq!(paths[3], threep.join("configLibrary/_meta.json"));
    fs::remove_dir_all(home).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn claude_desktop_uses_linux_beta_config_paths() {
    let home = agent_test_home("claude-desktop-linux-paths");
    let config_home = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".config"));
    let paths = claude_desktop_config_paths(&home);

    assert!(AgentClient::ClaudeDesktop.supported_platform());
    assert_eq!(paths.len(), 4);
    assert_eq!(
        paths[0],
        config_home.join("Claude/claude_desktop_config.json")
    );
    assert_eq!(
        paths[1],
        config_home.join("Claude-3p/claude_desktop_config.json")
    );
    assert_eq!(
        paths[2],
        config_home
            .join("Claude-3p/configLibrary")
            .join(format!("{CLAUDE_DESKTOP_PROFILE_ID}.json"))
    );
    assert_eq!(
        paths[3],
        config_home.join("Claude-3p/configLibrary/_meta.json")
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn opencode_agent_config_preserves_other_providers() {
    let models = test_agent_models(&["gpt-test", "deepseek-test"]);
    let rendered = build_opencode_agent_config(
            Some(
                r#"{"theme":"dark","provider":{"other":{"npm":"other"},"cpa-gui":{"custom":"keep","options":{"timeout":30}}}}"#,
            ),
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "gpt-test",
            &models,
        )
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();

    assert_eq!(value["theme"], "dark");
    assert_eq!(value["provider"]["other"]["npm"], "other");
    assert_eq!(
        value["provider"][MANAGED_AGENT_PROVIDER_ID]["custom"],
        "keep"
    );
    assert_eq!(
        value["provider"][MANAGED_AGENT_PROVIDER_ID]["options"]["timeout"],
        30
    );
    assert_eq!(
        value["provider"][MANAGED_AGENT_PROVIDER_ID]["options"]["baseURL"],
        "http://127.0.0.1:8317/v1"
    );
    assert_eq!(value["model"], "cpa-gui/gpt-test");
    assert!(value["provider"][MANAGED_AGENT_PROVIDER_ID]["models"]["gpt-test"].is_object());
    assert!(value["provider"][MANAGED_AGENT_PROVIDER_ID]["models"]["deepseek-test"].is_object());
}

#[test]
fn zcode_agent_config_preserves_other_providers_and_uses_anthropic_messages() {
    let home = agent_test_home("zcode-agent-config");
    let path = home.join(".zcode/v2/config.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut models = test_agent_models(&["gpt-test", "deepseek-test"]);
    models[0].context_window = Some(372_000);
    models[1].context_window = Some(272_000);
    let rendered = build_zcode_agent_config(
        Some(
            r#"{"locale":"zh-CN","provider":{"other":{"kind":"openai"},"cpa-gui":{"custom":"keep","options":{"timeout":30}}}}"#,
        ),
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "gpt-test",
        &models,
    )
    .unwrap();
    fs::write(&path, &rendered).unwrap();
    let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();

    assert_eq!(value["locale"], "zh-CN");
    assert_eq!(value["provider"]["other"]["kind"], "openai");
    assert_eq!(
        value["provider"][MANAGED_AGENT_PROVIDER_ID]["custom"],
        "keep"
    );
    assert_eq!(
        value["provider"][MANAGED_AGENT_PROVIDER_ID]["options"]["timeout"],
        30
    );
    assert_eq!(
        value["provider"][MANAGED_AGENT_PROVIDER_ID]["kind"],
        "anthropic"
    );
    assert_eq!(
        value["provider"][MANAGED_AGENT_PROVIDER_ID]["apiFormat"],
        "anthropic-messages"
    );
    assert_eq!(
        value["provider"][MANAGED_AGENT_PROVIDER_ID]["options"]["baseURL"],
        "http://127.0.0.1:8317"
    );
    assert_eq!(value["model"], "cpa-gui/gpt-test");
    assert_eq!(
        value["provider"][MANAGED_AGENT_PROVIDER_ID]["models"]["gpt-test"]["limit"]["context"],
        372_000
    );
    assert_eq!(
        value["provider"][MANAGED_AGENT_PROVIDER_ID]["models"]["deepseek-test"]["limit"]["context"],
        272_000
    );
    assert_eq!(
        inspect_zcode_agent_config(&path, 8317, DEFAULT_API_KEY).unwrap(),
        (true, Some("gpt-test".to_string()))
    );

    let mut normalized = value;
    let provider = normalized["provider"][MANAGED_AGENT_PROVIDER_ID]
        .as_object_mut()
        .unwrap();
    provider.remove("apiFormat");
    provider.remove("defaultKind");
    provider.remove("npm");
    fs::write(&path, serde_json::to_string_pretty(&normalized).unwrap()).unwrap();
    assert_eq!(
        inspect_zcode_agent_config(&path, 8317, DEFAULT_API_KEY).unwrap(),
        (true, Some("gpt-test".to_string()))
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn zcode_cli_config_sets_main_model_and_both_configs_must_match() {
    let home = agent_test_home("zcode-cli-default-model");
    let paths = agent_config_paths(AgentClient::ZCode, &home);
    fs::create_dir_all(paths[0].parent().unwrap()).unwrap();
    fs::create_dir_all(paths[1].parent().unwrap()).unwrap();
    let models = test_agent_models(&["gpt-test", "deepseek-test"]);
    let app_config = build_zcode_agent_config(
        None,
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "gpt-test",
        &models,
    )
    .unwrap();
    let cli_config = build_zcode_cli_agent_config(
        Some(r#"{"model":{"lite":"other/lite"},"plugins":{"keep":true}}"#),
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "gpt-test",
        &models,
    )
    .unwrap();
    let cli_value: serde_json::Value = serde_json::from_str(&cli_config).unwrap();

    assert_eq!(cli_value["model"]["main"], "cpa-gui/gpt-test");
    assert_eq!(cli_value["model"]["lite"], "other/lite");
    assert_eq!(cli_value["plugins"]["keep"], true);
    fs::write(&paths[0], app_config).unwrap();
    fs::write(&paths[1], &cli_config).unwrap();
    assert_eq!(
        inspect_agent_managed_config(AgentClient::ZCode, &paths, 8317, DEFAULT_API_KEY).unwrap(),
        (true, Some("gpt-test".to_string()), false)
    );

    let mut mismatched = cli_value;
    mismatched["model"]["main"] = serde_json::json!("cpa-gui/deepseek-test");
    fs::write(
        &paths[1],
        serde_json::to_string_pretty(&mismatched).unwrap(),
    )
    .unwrap();
    assert_eq!(
        inspect_agent_managed_config(AgentClient::ZCode, &paths, 8317, DEFAULT_API_KEY).unwrap(),
        (false, Some("deepseek-test".to_string()), false)
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn zcode_inspection_requires_the_default_model_to_belong_to_the_managed_provider() {
    let home = agent_test_home("zcode-default-model-inspection");
    let path = home.join(".zcode/v2/config.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let rendered = build_zcode_agent_config(
        None,
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "gpt-test",
        &test_agent_models(&["gpt-test"]),
    )
    .unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    value["model"] = serde_json::json!("other/gpt-test");
    fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();

    assert_eq!(
        inspect_zcode_agent_config(&path, 8317, DEFAULT_API_KEY).unwrap(),
        (false, None)
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn kimi_code_config_preserves_existing_tables_and_uses_openai_provider() {
    let home = agent_test_home("kimi-code-agent-config");
    let path = home.join(".kimi-code/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut models = test_agent_models(&["gpt-test", "deepseek-test"]);
    models[0].context_window = Some(1_048_576);
    models[1].context_window = Some(131_072);
    let rendered = build_kimi_code_agent_config(
        Some(
            r#"theme = "dark"

[providers.other]
type = "openai"
base_url = "https://example.com/v1"

[models."other/model"]
provider = "other"
model = "model"
"#,
        ),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "gpt-test",
        &models,
    )
    .unwrap();
    fs::write(&path, &rendered).unwrap();
    let value: toml::Value = toml::from_str(&rendered).unwrap();

    assert_eq!(value["theme"].as_str(), Some("dark"));
    assert_eq!(
        value["providers"]["other"]["base_url"].as_str(),
        Some("https://example.com/v1")
    );
    assert_eq!(value["default_model"].as_str(), Some("cpa-gui/gpt-test"));
    assert_eq!(
        value["providers"][MANAGED_AGENT_PROVIDER_ID]["type"].as_str(),
        Some("openai")
    );
    assert_eq!(
        value["providers"][MANAGED_AGENT_PROVIDER_ID]["base_url"].as_str(),
        Some("http://127.0.0.1:8317/v1")
    );
    assert_eq!(
        value["models"]["cpa-gui/gpt-test"]["capabilities"]
            .as_array()
            .unwrap()[0]
            .as_str(),
        Some("tool_use")
    );
    assert_eq!(
        value["models"]["cpa-gui/gpt-test"]["max_context_size"].as_integer(),
        Some(1_048_576)
    );
    assert_eq!(
        value["models"]["cpa-gui/deepseek-test"]["max_context_size"].as_integer(),
        Some(131_072)
    );
    assert_eq!(
        inspect_kimi_code_agent_config(&path, 8317, DEFAULT_API_KEY).unwrap(),
        (true, Some("gpt-test".to_string()))
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn grok_build_config_preserves_existing_models_and_uses_chat_completions() {
    let home = agent_test_home("grok-build-agent-config");
    let path = home.join(".grok/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut models = test_agent_models(&["gpt-test", "deepseek-test"]);
    models[0].context_window = Some(1_048_576);
    models[1].context_window = Some(131_072);
    let rendered = build_grok_build_agent_config(
        Some(
            r#"theme = "dark"

[models]
default = "other"

[model.other]
model = "other-model"
base_url = "https://example.com/v1"
api_key = "other-key"
"#,
        ),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "gpt-test",
        &models,
    )
    .unwrap();
    fs::write(&path, &rendered).unwrap();
    let value: toml::Value = toml::from_str(&rendered).unwrap();

    assert_eq!(value["theme"].as_str(), Some("dark"));
    assert_eq!(
        value["model"]["other"]["model"].as_str(),
        Some("other-model")
    );
    assert_eq!(
        value["models"]["default"].as_str(),
        Some("cpa-gui/gpt-test")
    );
    assert_eq!(
        value["model"]["cpa-gui/gpt-test"]["base_url"].as_str(),
        Some("http://127.0.0.1:8317/v1")
    );
    assert_eq!(
        value["model"]["cpa-gui/gpt-test"]["api_backend"].as_str(),
        Some("chat_completions")
    );
    assert_eq!(
        value["model"]["cpa-gui/gpt-test"]["context_window"].as_integer(),
        Some(1_048_576)
    );
    assert_eq!(
        value["model"]["cpa-gui/deepseek-test"]["context_window"].as_integer(),
        Some(131_072)
    );
    assert_eq!(
        inspect_grok_build_agent_config(&path, 8317, DEFAULT_API_KEY).unwrap(),
        (true, Some("gpt-test".to_string()))
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn kimi_and_grok_toml_restore_preserves_runtime_fields_and_original_selection() {
    use toml_edit::{value, Document};

    let models = test_agent_models(&["gpt-test", "deepseek-test"]);
    let kimi_original = r#"default_model = "cpa-gui/original"

[providers.cpa-gui]
type = "openai_responses"
base_url = "https://original.example/v1"
api_key = "original-key"

[models."cpa-gui/original"]
provider = "cpa-gui"
model = "original"
"#;
    let kimi_managed = build_kimi_code_agent_config(
        Some(kimi_original),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "gpt-test",
        &models,
    )
    .unwrap();
    let mut kimi_runtime = kimi_managed.parse::<Document>().unwrap();
    kimi_runtime
        .as_table_mut()
        .insert("runtime_added", value(true));
    kimi_runtime["providers"][MANAGED_AGENT_PROVIDER_ID]
        .as_table_mut()
        .unwrap()
        .insert("runtime_custom", value("keep"));
    let kimi_restored =
        build_restored_kimi_code_config(&kimi_runtime.to_string(), Some(kimi_original))
            .unwrap()
            .unwrap();
    let kimi: toml::Value = toml::from_str(&kimi_restored).unwrap();
    assert_eq!(kimi["default_model"].as_str(), Some("cpa-gui/original"));
    assert_eq!(kimi["runtime_added"].as_bool(), Some(true));
    assert_eq!(
        kimi["providers"][MANAGED_AGENT_PROVIDER_ID]["type"].as_str(),
        Some("openai_responses")
    );
    assert_eq!(
        kimi["providers"][MANAGED_AGENT_PROVIDER_ID]["runtime_custom"].as_str(),
        Some("keep")
    );
    assert!(kimi["models"].get("cpa-gui/gpt-test").is_none());
    assert_eq!(
        kimi["models"]["cpa-gui/original"]["model"].as_str(),
        Some("original")
    );

    let grok_original = r#"[models]
default = "cpa-gui/original"

[model."cpa-gui/original"]
model = "original"
base_url = "https://original.example/v1"
api_key = "original-key"
"#;
    let grok_managed = build_grok_build_agent_config(
        Some(grok_original),
        "http://127.0.0.1:8317/v1",
        DEFAULT_API_KEY,
        "gpt-test",
        &models,
    )
    .unwrap();
    let mut grok_runtime = grok_managed.parse::<Document>().unwrap();
    grok_runtime
        .as_table_mut()
        .insert("runtime_added", value(true));
    let grok_restored =
        build_restored_grok_build_config(&grok_runtime.to_string(), Some(grok_original))
            .unwrap()
            .unwrap();
    let grok: toml::Value = toml::from_str(&grok_restored).unwrap();
    assert_eq!(grok["models"]["default"].as_str(), Some("cpa-gui/original"));
    assert_eq!(grok["runtime_added"].as_bool(), Some(true));
    assert!(grok["model"].get("cpa-gui/gpt-test").is_none());
    assert_eq!(
        grok["model"]["cpa-gui/original"]["base_url"].as_str(),
        Some("https://original.example/v1")
    );
}

#[test]
fn openclaw_agent_config_accepts_json5_and_preserves_unknown_fields() {
    let models = test_agent_models(&["gpt-test", "deepseek-test"]);
    let rendered = build_openclaw_agent_config(
            Some(
                "// keep this comment\n{ theme: 'dark', models: { mode: 'merge', providers: { 'cpa-gui': { custom: 'keep' } } } }",
            ),
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "gpt-test",
            &models,
        )
        .unwrap();
    let value: serde_json::Value = json5::from_str(&rendered).unwrap();

    assert!(rendered.contains("// keep this comment"));
    assert_eq!(value["theme"], "dark");
    assert_eq!(
        value["models"]["providers"][MANAGED_AGENT_PROVIDER_ID]["custom"],
        "keep"
    );
    assert_eq!(
        value["models"]["providers"][MANAGED_AGENT_PROVIDER_ID]["api"],
        "openai-completions"
    );
    assert_eq!(
        value["agents"]["defaults"]["model"]["primary"],
        "cpa-gui/gpt-test"
    );
    assert_eq!(
        value["models"]["providers"][MANAGED_AGENT_PROVIDER_ID]["models"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(value["agents"]["defaults"]["models"]["cpa-gui/gpt-test"].is_object());
    assert!(value["agents"]["defaults"]["models"]["cpa-gui/deepseek-test"].is_object());
}

#[test]
fn hermes_agent_config_preserves_unknown_fields_and_uses_current_schema() {
    let models = test_agent_models(&["gpt-test", "deepseek-test"]);
    let rendered = build_hermes_agent_config(
            Some("# keep this comment\ntheme: dark\ncustom_providers:\n  - name: other\n    base_url: https://example.com\n  - name: cpa-gui\n    custom: keep\n  - name: cpa-gui\n    duplicate: true\n  - broken: true\n"),
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "gpt-test",
            &models,
        )
        .unwrap();
    let value: serde_yaml::Value = serde_yaml::from_str(&rendered).unwrap();
    let providers = value["custom_providers"].as_sequence().unwrap();
    let managed = providers
        .iter()
        .find(|provider| provider["name"].as_str() == Some(MANAGED_AGENT_PROVIDER_ID))
        .unwrap();

    assert_eq!(value["theme"].as_str(), Some("dark"));
    assert!(rendered.contains("# keep this comment"));
    assert_eq!(providers.len(), 2);
    assert_eq!(managed["custom"].as_str(), Some("keep"));
    assert!(managed.get("duplicate").is_none());
    assert_eq!(managed["api_mode"].as_str(), Some("chat_completions"));
    assert_eq!(managed["model"].as_str(), Some("gpt-test"));
    assert!(managed["models"]["gpt-test"].is_mapping());
    assert!(managed["models"]["deepseek-test"].is_mapping());
    assert_eq!(
        value["model"]["provider"].as_str(),
        Some(MANAGED_AGENT_PROVIDER_ID)
    );
}

#[test]
fn agent_model_list_parser_exposes_aliases_as_selectable_model_ids() {
    let models = parse_agent_model_options(&serde_json::json!({
            "object": "list",
            "data": [
                {"id": "gpt-5", "display_name": "GPT 5", "context_length": 272000},
                {"name": "claude-sonnet", "alias": "claude-sonnet-xhigh", "fork": true, "contextLength": "1000000"},
                {"name": "hidden-original", "alias": "visible-alias", "ContextLength": 128000},
                "deepseek-chat",
                {"id": "GPT-5"},
                {"id": ""}
            ]
        }))
        .unwrap();

    assert_eq!(
        models,
        vec![
            AgentModelOption {
                name: "gpt-5".to_string(),
                alias: Some("GPT 5".to_string()),
                is_alias: false,
                context_window: Some(272_000),
            },
            AgentModelOption {
                name: "claude-sonnet".to_string(),
                alias: None,
                is_alias: false,
                context_window: Some(1_000_000),
            },
            AgentModelOption {
                name: "claude-sonnet-xhigh".to_string(),
                alias: Some("claude-sonnet".to_string()),
                is_alias: true,
                context_window: Some(1_000_000),
            },
            AgentModelOption {
                name: "visible-alias".to_string(),
                alias: Some("hidden-original".to_string()),
                is_alias: true,
                context_window: Some(128_000),
            },
            AgentModelOption {
                name: "deepseek-chat".to_string(),
                alias: None,
                is_alias: false,
                context_window: None,
            },
        ]
    );
}

#[test]
fn kimi_grok_and_zcode_use_cpa_runtime_context_windows() {
    for client in [
        AgentClient::KimiCode,
        AgentClient::GrokBuild,
        AgentClient::ZCode,
    ] {
        assert!(agent_uses_cpa_runtime_context_windows(client));
    }
    for client in [
        AgentClient::ClaudeCode,
        AgentClient::ClaudeDesktop,
        AgentClient::Codex,
        AgentClient::OpenCode,
        AgentClient::OpenClaw,
        AgentClient::Hermes,
        AgentClient::DeepSeekHarness,
    ] {
        assert!(!agent_uses_cpa_runtime_context_windows(client));
    }
}

#[test]
fn claude_model_lists_mark_yaml_aliases_when_api_returns_only_model_ids() {
    let mut models = test_agent_models(&[
        "gpt-original",
        "gpt-high",
        "claude-opus-5",
        "oauth-original",
        "oauth-fast",
    ]);
    let yaml = r#"
codex-api-key:
  - api-key: test
    models:
      - name: gpt-original
      - name: gpt-original
        alias: gpt-high
      - name: gpt-original
        alias: claude-opus-5
oauth-model-alias:
  codex:
    - name: oauth-original
      alias: oauth-fast
      fork: true
"#;

    mark_configured_agent_model_aliases(&mut models, yaml).unwrap();

    let find = |name: &str| models.iter().find(|model| model.name == name).unwrap();
    assert!(!find("gpt-original").is_alias);
    assert_eq!(find("gpt-high").alias.as_deref(), Some("gpt-original"));
    assert!(find("gpt-high").is_alias);
    assert_eq!(find("claude-opus-5").alias.as_deref(), Some("gpt-original"));
    assert!(find("claude-opus-5").is_alias);
    assert_eq!(find("oauth-fast").alias.as_deref(), Some("oauth-original"));
    assert!(find("oauth-fast").is_alias);
}

#[test]
fn exit_preserves_claude_client_configurations() {
    let restored = agent_clients_restored_on_exit();
    assert!(!restored.contains(&AgentClient::ClaudeCode));
    assert!(!restored.contains(&AgentClient::ClaudeDesktop));
    assert!(restored.contains(&AgentClient::Codex));
    assert!(restored.contains(&AgentClient::OpenCode));
    assert!(restored.contains(&AgentClient::DeepSeekHarness));
    assert!(restored.contains(&AgentClient::ZCode));
    assert!(restored.contains(&AgentClient::KimiCode));
    assert!(restored.contains(&AgentClient::GrokBuild));
}

#[test]
fn deepseek_harness_settings_preserve_unrelated_sections_and_publish_models() {
    let existing = r#"# keep this comment
ui-onboarding:
  welcomeNoticeVersion: 3
llm-pi-ai:
  providers:
    existing:
      api: openai-completions
      baseURL: https://example.invalid/v1
agent-default-model:
  provider: existing
  model: old-model
  reasoningEffort: high
"#;
    let models = vec![
        AgentModelOption {
            name: "gpt-selected".to_string(),
            alias: Some("Selected Model".to_string()),
            is_alias: false,
            context_window: Some(272_000),
        },
        AgentModelOption {
            name: "gpt-other".to_string(),
            alias: None,
            is_alias: false,
            context_window: None,
        },
    ];
    let rendered = build_deepseek_harness_settings(
        Some(existing),
        "http://127.0.0.1:8317/v1",
        "gpt-selected",
        &models,
    )
    .unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();

    assert!(rendered.contains("# keep this comment"));
    assert_eq!(
        value["ui-onboarding"]["welcomeNoticeVersion"].as_u64(),
        Some(3)
    );
    assert_eq!(
        value["llm-pi-ai"]["providers"]["existing"]["baseURL"].as_str(),
        Some("https://example.invalid/v1")
    );
    let provider = &value["llm-pi-ai"]["providers"][DEEPSEEK_HARNESS_PROVIDER_ID];
    assert_eq!(
        provider["apiKeyEnv"].as_str(),
        Some(DEEPSEEK_HARNESS_CREDENTIAL)
    );
    assert_eq!(provider["api"].as_str(), Some("openai-completions"));
    assert_eq!(
        provider["baseURL"].as_str(),
        Some("http://127.0.0.1:8317/v1")
    );
    assert_eq!(provider["models"][0]["id"].as_str(), Some("gpt-selected"));
    assert_eq!(
        provider["models"][0]["name"].as_str(),
        Some("Selected Model")
    );
    assert_eq!(
        provider["models"][0]["contextWindow"].as_u64(),
        Some(272_000)
    );
    assert_eq!(provider["models"][1]["id"].as_str(), Some("gpt-other"));
    assert_eq!(
        value["agent-default-model"]["provider"].as_str(),
        Some(DEEPSEEK_HARNESS_PROVIDER_ID)
    );
    assert_eq!(
        value["agent-default-model"]["model"].as_str(),
        Some("gpt-selected")
    );
    assert!(value["agent-default-model"]
        .get("reasoningEffort")
        .is_none());
}

#[test]
fn deepseek_harness_credentials_preserve_other_entries() {
    let rendered = build_deepseek_harness_credentials(
        Some("# existing key\nOTHER_API_KEY: other-secret\n"),
        "cpa-secret",
    )
    .unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();

    assert!(rendered.contains("# existing key"));
    assert_eq!(value["OTHER_API_KEY"].as_str(), Some("other-secret"));
    assert_eq!(
        value[DEEPSEEK_HARNESS_CREDENTIAL].as_str(),
        Some("cpa-secret")
    );
}

#[test]
fn deepseek_harness_inspection_requires_managed_route_selection_and_credential() {
    let home = agent_test_home("deepseek-harness-inspection");
    let paths = vec![home.join("settings.yaml"), home.join(".credentials.yaml")];
    let models = test_agent_models(&["gpt-test"]);
    fs::write(
        &paths[0],
        build_deepseek_harness_settings(None, "http://127.0.0.1:8317/v1", "gpt-test", &models)
            .unwrap(),
    )
    .unwrap();
    fs::write(
        &paths[1],
        build_deepseek_harness_credentials(None, "agent-key").unwrap(),
    )
    .unwrap();

    let (configured, model) = inspect_deepseek_harness_config(&paths, 8317, "agent-key").unwrap();
    assert!(configured);
    assert_eq!(model.as_deref(), Some("gpt-test"));
    assert!(deepseek_harness_has_managed_marker(&paths).unwrap());

    let (wrong_key, _) = inspect_deepseek_harness_config(&paths, 8317, "different-key").unwrap();
    assert!(!wrong_key);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn deepseek_harness_profile_version_comes_from_installed_profile() {
    let home = agent_test_home("deepseek-harness-version");
    let package = home.join(".dsh/profiles/node_modules/@deepseek-ai/dsh/package.json");
    fs::create_dir_all(package.parent().unwrap()).unwrap();
    fs::write(&package, r#"{"version":"0.1.0-rc.5"}"#).unwrap();

    assert_eq!(
        read_deepseek_harness_profile_version(&home).as_deref(),
        Some("0.1.0-rc.5")
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn claude_desktop_aliases_expose_role_routes_only() {
    let input = "openai-compatibility:\n  - name: CPA\n    base-url: https://example.com/v1\n    models:\n      - name: gpt-5.6-sol\n";
    let mappings = ClaudeDesktopModelMappings {
        opus: "gpt-5.6-sol".to_string(),
        sonnet: "gpt-5.6-sol".to_string(),
        haiku: "gpt-5.6-sol".to_string(),
        opus_1m: false,
        sonnet_1m: false,
        haiku_1m: false,
        ..ClaudeDesktopModelMappings::all("")
    };
    let available_models = test_agent_models(&["gpt-5.6-sol"]);
    let rendered =
        ensure_claude_desktop_model_aliases_in_yaml(input, &mappings, &available_models).unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
    let root = value.as_mapping().unwrap();
    let providers = yaml_mapping_value(root, "openai-compatibility")
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    let models = yaml_mapping_value(providers[0].as_mapping().unwrap(), "models")
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();

    assert_eq!(models.len(), 4);
    assert_eq!(
        configured_model_identity(&models[1]).unwrap().1,
        CLAUDE_DESKTOP_OPUS_MODEL_ID
    );
    assert_eq!(
        configured_model_identity(&models[2]).unwrap().1,
        CLAUDE_DESKTOP_SONNET_MODEL_ID
    );
    assert_eq!(
        configured_model_identity(&models[3]).unwrap().1,
        CLAUDE_DESKTOP_HAIKU_MODEL_ID
    );
    assert_eq!(
        configured_model_identity(&models[1]).unwrap().2.as_deref(),
        Some(MANAGED_CLAUDE_OPUS_ALIAS_DISPLAY_NAME)
    );
    assert_eq!(
        configured_model_identity(&models[2]).unwrap().2.as_deref(),
        Some(MANAGED_CLAUDE_SONNET_ALIAS_DISPLAY_NAME)
    );
    assert_eq!(
        configured_model_identity(&models[3]).unwrap().2.as_deref(),
        Some(MANAGED_CLAUDE_HAIKU_ALIAS_DISPLAY_NAME)
    );
    assert!(!rendered.contains("models: [{"));
    assert!(rendered.contains("\n      - name: gpt-5.6-sol\n"));
    assert!(rendered.contains("\n        alias: claude-opus-5\n"));
    assert!(
        rendered.contains("\n        display-name: EasyCLIProxyAPI managed Claude Opus mapping\n")
    );
    assert_eq!(
        ensure_claude_desktop_model_aliases_in_yaml(&rendered, &mappings, &available_models,)
            .unwrap(),
        rendered
    );
}

#[test]
fn claude_desktop_aliases_support_codex_oauth_models() {
    let input = "port: 8317\n";
    let mappings = ClaudeDesktopModelMappings::all("gpt-5.6-sol");
    let available_models = test_agent_models(&["gpt-5.6-sol"]);
    let definitions = vec![CodexModelDefinition {
        id: "gpt-5.6-sol".to_string(),
        display_name: None,
        description: None,
        context_window: Some(372_000),
        reasoning_levels: vec!["high".to_string()],
        supports_tools: Some(true),
    }];

    let rendered = ensure_claude_desktop_model_aliases_with_codex_oauth_in_yaml(
        input,
        &mappings,
        &available_models,
        &definitions,
    )
    .unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
    let root = value.as_mapping().unwrap();
    let aliases = yaml_mapping_value(root, "oauth-model-alias")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|channels| yaml_mapping_value(channels, "codex"))
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();

    assert_eq!(aliases.len(), 3);
    assert!(aliases.iter().all(|entry| {
        configured_model_identity(entry).is_some_and(|(source, _, _)| source == "gpt-5.6-sol")
    }));
    assert!(aliases.iter().all(|entry| {
        entry
            .as_mapping()
            .and_then(|entry| yaml_mapping_value(entry, "fork"))
            == Some(&serde_norway::Value::Bool(true))
    }));
    assert_eq!(
        ensure_claude_desktop_model_aliases_with_codex_oauth_in_yaml(
            &rendered,
            &mappings,
            &available_models,
            &definitions,
        )
        .unwrap(),
        rendered
    );

    let cleaned = remove_managed_claude_model_aliases_in_yaml(&rendered).unwrap();
    let cleaned: serde_norway::Value = serde_norway::from_str(&cleaned).unwrap();
    let cleaned = cleaned.as_mapping().unwrap();
    assert!(yaml_mapping_value(cleaned, "oauth-model-alias").is_none());
    assert_eq!(
        yaml_mapping_value(cleaned, "port").and_then(serde_norway::Value::as_i64),
        Some(8317)
    );
}

#[test]
fn claude_oauth_alias_changes_use_the_runtime_refresh_endpoint() {
    let current = "port: 8317\nopenai-compatibility: []\n";
    let oauth_only = "port: 8317\nopenai-compatibility: []\noauth-model-alias:\n  codex:\n    - name: gpt-5.6-sol\n      alias: claude-opus-5\n      fork: true\n";
    let changes = management_alias_config_changes(current, oauth_only).unwrap();

    assert!(!changes.update_config_yaml);
    assert_eq!(
        changes.oauth_model_aliases,
        Some(serde_json::json!({
            "codex": [{
                "name": "gpt-5.6-sol",
                "alias": "claude-opus-5",
                "fork": true,
            }]
        }))
    );

    let mixed = oauth_only.replace(
        "openai-compatibility: []",
        "openai-compatibility:\n  - name: CPA\n    base-url: https://example.com/v1",
    );
    let changes = management_alias_config_changes(current, &mixed).unwrap();
    assert!(changes.update_config_yaml);
    assert!(changes.oauth_model_aliases.is_some());

    let changes = management_alias_config_changes(oauth_only, current).unwrap();
    assert!(!changes.update_config_yaml);
    assert_eq!(changes.oauth_model_aliases, Some(serde_json::json!({})));
}

#[test]
fn claude_managed_aliases_expand_flow_yaml_and_are_removed_selectively() {
    let compact = "# keep this comment\ncodex-api-key: [{api-key: test, models: [{name: gpt-5.6-sol, alias: ''}]}]\ncredential-concurrency: {max-limit: 1000000, cleanup-interval: 5s}\n";
    let mappings = ClaudeDesktopModelMappings::all("gpt-5.6-sol");
    let available_models = test_agent_models(&["gpt-5.6-sol"]);
    let rendered =
        ensure_claude_desktop_model_aliases_in_yaml(compact, &mappings, &available_models).unwrap();

    assert!(rendered.starts_with("# keep this comment\n"));
    assert!(!rendered.contains("codex-api-key: ["));
    assert!(!rendered.contains("credential-concurrency: {"));
    assert!(rendered.contains("codex-api-key:\n  - api-key: test\n"));
    assert!(rendered.contains("    models:\n      - name: gpt-5.6-sol\n"));

    let cleaned = remove_managed_claude_model_aliases_in_yaml(&rendered).unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&cleaned).unwrap();
    let root = value.as_mapping().unwrap();
    let providers = yaml_mapping_value(root, "codex-api-key")
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    let models = yaml_mapping_value(providers[0].as_mapping().unwrap(), "models")
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(
        configured_model_identity(&models[0]).unwrap().0,
        "gpt-5.6-sol"
    );
}

#[test]
fn claude_alias_cleanup_does_not_delete_user_owned_routes() {
    let input = format!(
            "codex-api-key:\n  - api-key: test\n    models:\n      - name: user-opus\n        alias: {opus}\n        display-name: User managed route\n      - name: app-sonnet\n        alias: {sonnet}\n        display-name: {managed_sonnet}\n",
            opus = CLAUDE_DESKTOP_OPUS_MODEL_ID,
            sonnet = CLAUDE_DESKTOP_SONNET_MODEL_ID,
            managed_sonnet = MANAGED_CLAUDE_SONNET_ALIAS_DISPLAY_NAME,
        );

    let cleaned = remove_managed_claude_model_aliases_in_yaml(&input).unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&cleaned).unwrap();
    let root = value.as_mapping().unwrap();
    assert_eq!(
        configured_model_client_identity(root, CLAUDE_DESKTOP_OPUS_MODEL_ID)
            .unwrap()
            .0,
        "user-opus"
    );
    assert!(configured_model_client_identity(root, CLAUDE_DESKTOP_SONNET_MODEL_ID).is_none());
}

#[test]
fn claude_alias_cleanup_preserves_user_owned_oauth_routes() {
    let input = format!(
        "oauth-model-alias:\n  codex:\n    - name: user-opus\n      alias: {opus}\n      fork: true\n    - name: app-sonnet\n      alias: {sonnet}\n      fork: true\n      display-name: {managed_sonnet}\n",
        opus = CLAUDE_DESKTOP_OPUS_MODEL_ID,
        sonnet = CLAUDE_DESKTOP_SONNET_MODEL_ID,
        managed_sonnet = MANAGED_CLAUDE_SONNET_ALIAS_DISPLAY_NAME,
    );

    let cleaned = remove_managed_claude_model_aliases_in_yaml(&input).unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&cleaned).unwrap();
    let root = value.as_mapping().unwrap();
    assert_eq!(
        configured_model_client_identity(root, CLAUDE_DESKTOP_OPUS_MODEL_ID)
            .unwrap()
            .0,
        "user-opus"
    );
    assert!(configured_model_client_identity(root, CLAUDE_DESKTOP_SONNET_MODEL_ID).is_none());
}

#[test]
fn claude_legacy_aliases_are_adopted_and_moved_to_the_selected_model() {
    let input = format!(
            "codex-api-key:\n  - api-key: test\n    models:\n      - name: old-model\n      - name: new-model\n      - name: old-model\n        alias: {opus}\n",
            opus = CLAUDE_DESKTOP_OPUS_MODEL_ID,
        );
    let mappings = ClaudeDesktopModelMappings::all("new-model");
    let models = test_agent_models(&["old-model", "new-model"]);

    let rendered = ensure_claude_desktop_model_aliases_in_yaml(&input, &mappings, &models).unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
    let root = value.as_mapping().unwrap();
    assert_eq!(
        configured_model_client_identity(root, CLAUDE_DESKTOP_OPUS_MODEL_ID)
            .unwrap()
            .0,
        "new-model"
    );
    assert!(rendered.contains(MANAGED_CLAUDE_OPUS_ALIAS_DISPLAY_NAME));
}

#[test]
fn claude_desktop_uses_selected_alias_directly_with_original_context() {
    let input = "openai-compatibility:\n  - name: CPA\n    base-url: https://example.com/v1\n    models:\n      - name: gpt-original\n      - name: gpt-original\n        alias: gpt-high\n      - name: gpt-original\n        alias: claude-opus-5\n        display-name: EasyCLIProxyAPI managed Claude Opus mapping\n";
    let mappings = ClaudeDesktopModelMappings {
        opus: "gpt-high".to_string(),
        sonnet: "gpt-high".to_string(),
        haiku: "gpt-high".to_string(),
        opus_1m: false,
        sonnet_1m: true,
        haiku_1m: false,
        ..ClaudeDesktopModelMappings::all("")
    };
    let models = vec![
        AgentModelOption {
            name: "gpt-original".to_string(),
            alias: None,
            is_alias: false,
            context_window: Some(1_000_000),
        },
        AgentModelOption {
            name: "gpt-high".to_string(),
            alias: Some("gpt-original".to_string()),
            is_alias: true,
            context_window: Some(128_000),
        },
    ];

    let rendered = ensure_claude_desktop_model_aliases_in_yaml(input, &mappings, &models).unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
    let root = value.as_mapping().unwrap();
    let providers = yaml_mapping_value(root, "openai-compatibility")
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    let configured_models = yaml_mapping_value(providers[0].as_mapping().unwrap(), "models")
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    let client_models = configured_models
        .iter()
        .filter_map(configured_model_identity)
        .map(|(_, client_model, _)| client_model)
        .collect::<Vec<_>>();
    assert_eq!(client_models, vec!["gpt-original", "gpt-high"]);

    let profile = build_claude_desktop_profile(
        None,
        "http://127.0.0.1:8317",
        DEFAULT_API_KEY,
        "gpt-high",
        &models,
        Some(&mappings),
        None,
    )
    .unwrap();
    let profile: serde_json::Value = serde_json::from_str(&profile).unwrap();
    assert_eq!(
        profile["inferenceModels"],
        serde_json::json!([{
            "name": "gpt-high",
            "contextWindow": 1_000_000,
            "supports1m": true,
            "prefer1m": true
        }])
    );
}

#[test]
fn claude_desktop_role_mappings_can_use_different_available_models() {
    let models = test_agent_models(&["gpt-5.6-sol", "deepseek-chat", "gemini-3-pro"]);
    let mappings = resolve_claude_desktop_model_mappings(
        AgentClient::ClaudeDesktop,
        &models,
        "gpt-5.6-sol",
        Some(ClaudeDesktopModelMappings {
            opus: "gpt-5.6-sol".to_string(),
            sonnet: "deepseek-chat".to_string(),
            haiku: "gemini-3-pro".to_string(),
            opus_1m: true,
            sonnet_1m: false,
            haiku_1m: true,
            ..ClaudeDesktopModelMappings::all("")
        }),
    )
    .unwrap()
    .unwrap();

    assert_eq!(mappings.opus, "gpt-5.6-sol");
    assert_eq!(mappings.sonnet, "deepseek-chat");
    assert_eq!(mappings.haiku, "gemini-3-pro");
    assert!(mappings.opus_1m);
    assert!(!mappings.sonnet_1m);
    assert!(mappings.haiku_1m);
    assert!(resolve_claude_desktop_model_mappings(
        AgentClient::ClaudeCode,
        &models,
        "gpt-5.6-sol",
        None,
    )
    .unwrap()
    .is_none());
}

#[test]
fn agent_model_list_parser_rejects_unexpected_response_shape() {
    assert!(parse_agent_model_options(&serde_json::json!({"data": null})).is_err());
}

#[test]
fn detected_agent_version_requires_a_real_version_value() {
    assert_eq!(
        normalize_detected_agent_version("  opencode 1.2.3  ").as_deref(),
        Some("opencode 1.2.3")
    );
    assert_eq!(
        normalize_detected_agent_version("Claude Code v4").as_deref(),
        Some("Claude Code v4")
    );
    assert!(normalize_detected_agent_version("").is_none());
    assert!(normalize_detected_agent_version("version unknown").is_none());
    assert!(normalize_detected_agent_version("1.2.3\0invalid").is_none());
    assert!(normalize_detected_agent_version(&"1".repeat(257)).is_none());
}

#[test]
fn agent_probe_command_captures_output_before_timeout() {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new(windows_command_processor());
        command.args(["/D", "/C", "echo agent 1.2.3"]);
        configure_background_command(&mut command);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let mut command = Command::new("sh");
        command.args(["-c", "printf 'agent 1.2.3\\n'"]);
        command
    };

    let output = command_output_with_timeout(&mut command, Duration::from_secs(2))
        .unwrap()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "agent 1.2.3"
    );
}

#[test]
fn agent_probe_command_stops_at_timeout() {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new(windows_powershell_executable());
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 5",
        ]);
        configure_background_command(&mut command);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5"]);
        command
    };

    let started = Instant::now();
    let output = command_output_with_timeout(&mut command, Duration::from_millis(100)).unwrap();

    assert!(output.is_none());
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn codex_model_list_is_empty_when_cpa_has_no_writable_models() {
    let prepared = prepare_codex_agent_models(&[]).unwrap();

    assert!(prepared.models.is_empty());
    assert!(prepared.codex_catalog.is_none());
}

#[test]
fn agent_model_validation_only_accepts_models_in_current_list() {
    let models = vec![AgentModelOption {
        name: "gpt-5.4".to_string(),
        alias: Some("GPT 5.4".to_string()),
        is_alias: false,
        context_window: None,
    }];

    assert_eq!(
        resolve_available_agent_model(&models, "GPT-5.4").unwrap(),
        "gpt-5.4"
    );
    assert!(resolve_available_agent_model(&models, "removed-model").is_err());
    assert!(resolve_available_agent_model(&[], "gpt-5.4").is_err());
}

#[test]
fn thinking_alias_sources_only_include_current_core_models() {
    let input = "codex-api-key:\n  - name: Codex API\n    api-key: test\n    models:\n      - name: config-only\nopenai-compatibility:\n  - name: DeepSeek\n    base-url: https://api.deepseek.com\n    api-key-entries:\n      - api-key: test\n    models:\n      - name: DeepSeek-Chat\n";
    let definitions = parse_codex_model_definitions(&serde_json::json!({
        "models": [
            {
                "id": "gpt-runtime",
                "thinking": { "levels": ["low", "high"] }
            },
            {
                "id": "gpt-built-in-only",
                "thinking": { "levels": ["low", "high"] }
            }
        ]
    }))
    .unwrap();
    let available_models = test_agent_models(&["GPT-RUNTIME", "deepseek-chat"]);

    let sources = resolved_thinking_alias_sources(input, &definitions, &available_models).unwrap();
    let source_models = sources
        .iter()
        .map(|source| source.source.model.as_str())
        .collect::<Vec<_>>();

    assert_eq!(source_models, vec!["DeepSeek-Chat", "gpt-runtime"]);
    assert!(!source_models.contains(&"gpt-built-in-only"));
    assert!(!source_models.contains(&"config-only"));
}

#[test]
fn thinking_alias_prefers_codex_api_key_model_over_same_named_oauth_definition() {
    let input = "codex-api-key:\n  - name: CPA\n    api-key: test\n    models:\n      - name: gpt-5.6-luna\n";
    let definitions = parse_codex_model_definitions(&serde_json::json!({
        "models": [{
            "id": "gpt-5.6-luna",
            "thinking": { "levels": ["low", "high", "xhigh"] }
        }]
    }))
    .unwrap();
    let available_models = test_agent_models(&["gpt-5.6-luna"]);

    let sources = resolved_thinking_alias_sources(input, &definitions, &available_models).unwrap();

    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source.model, "gpt-5.6-luna");
    assert_eq!(sources[0].source.kind, "codex-api");
    assert!(matches!(
        sources[0].location,
        ThinkingAliasSourceLocation::ConfigModel {
            section: "codex-api-key",
            ..
        }
    ));

    let rendered =
        add_model_alias_to_yaml(input, &sources[0], "gpt-5.6-luna-xhigh", "xhigh", false).unwrap();
    assert!(rendered.contains("alias: gpt-5.6-luna-xhigh"), "{rendered}");
    assert!(!rendered.contains("oauth-model-alias"), "{rendered}");
}

#[cfg(target_os = "windows")]
#[test]
fn windows_batch_agent_commands_use_call_without_embedded_quotes() {
    let executable = Path::new(r"C:\工具 目录\opencode.cmd");
    let command = windows_command_for_executable(executable, true);
    let args = command
        .get_args()
        .take(3)
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    assert_eq!(
        Path::new(command.get_program())
            .file_name()
            .and_then(|name| name.to_str()),
        Some("cmd.exe")
    );
    assert_eq!(
        args,
        vec!["/D".to_string(), "/K".to_string(), "call".to_string(),]
    );
    assert_eq!(
        windows_batch_executable_argument(executable),
        r#""C:\工具 目录\opencode.cmd""#
    );

    let batch = windows_command_for_executable(Path::new(r"C:\tools\agent.bat"), false);
    let batch_args = batch
        .get_args()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(batch_args[1], "/C");
    assert_eq!(batch_args[2], "call");

    let native = windows_command_for_executable(Path::new(r"C:\tools\agent.exe"), true);
    assert_eq!(
        native.get_program().to_string_lossy(),
        r"C:\tools\agent.exe"
    );
    assert_eq!(native.get_args().count(), 0);
}
