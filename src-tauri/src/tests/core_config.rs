use super::support::*;
use super::*;

#[test]
fn legacy_string_api_keys_keep_custom_keys_without_special_protection() {
    let legacy = "port = 8317\nallow-lan = false\nrun-on-startup = false\nauth-dir = \"/tmp/oauth\"\napi-keys = [\"123456\", \"custom-key\"]\nmanagement-secret-key = \"123456\"\nplugins-enabled = false\nrouting-strategy = \"round-robin\"\n";
    let mut config = toml::from_str::<GuiConfigFile>(legacy).unwrap();

    assert!(!sanitize_gui_config(&mut config).unwrap());
    assert_eq!(
        gui_api_key_values(&config.api_keys),
        vec!["123456", "custom-key"]
    );
    assert!(config.api_keys[0].remark.is_empty());
    assert!(config.api_keys[1].remark.is_empty());

    let serialized = toml::to_string_pretty(&config).unwrap();
    assert!(serialized.contains("[[api-keys]]"));
    let reparsed = toml::from_str::<GuiConfigFile>(&serialized).unwrap();
    assert_eq!(reparsed.api_keys, config.api_keys);
}

#[test]
fn api_key_remarks_follow_matching_core_keys() {
    let existing = vec![
        default_api_key_entry(),
        GuiApiKeyEntry {
            key: "custom-key".to_string(),
            remark: "开发环境".to_string(),
        },
    ];
    let core_keys = vec!["custom-key".to_string(), "new-key".to_string()];

    let merged = merge_core_api_keys_with_gui_metadata(&existing, &core_keys, None);

    assert_eq!(gui_api_key_values(&merged), vec!["custom-key", "new-key"]);
    assert_eq!(merged[0].remark, "开发环境");
    assert!(merged[1].remark.is_empty());
}

#[test]
fn explicit_empty_api_key_list_stays_empty() {
    let existing = vec![default_api_key_entry()];
    assert!(merge_core_api_keys_with_gui_metadata(&existing, &[], None).is_empty());

    let mut config = GuiConfigFile {
        api_keys: Vec::new(),
        ..GuiConfigFile::default()
    };
    sanitize_gui_config(&mut config).unwrap();
    assert!(config.api_keys.is_empty());

    let content = toml::to_string_pretty(&config).unwrap();
    let restored = toml::from_str::<GuiConfigFile>(&content).unwrap();
    assert!(restored.api_keys.is_empty());
}

#[test]
fn fresh_config_keeps_initial_default_unless_core_has_real_keys() {
    assert!(!should_import_core_api_keys(false, &[]));
    assert!(should_import_core_api_keys(
        false,
        &["existing-key".to_string()]
    ));
    assert!(should_import_core_api_keys(true, &[]));
}

#[test]
fn api_keys_can_be_edited_but_the_last_key_is_retained() {
    let mut api_keys = vec![DEFAULT_API_KEY.to_string()];

    replace_core_api_key_value(&mut api_keys, DEFAULT_API_KEY, "custom-key".to_string()).unwrap();
    assert_eq!(api_keys, vec!["custom-key"]);

    assert!(remove_core_api_key_value(&mut api_keys, "custom-key").is_err());
    api_keys.push("backup-key".to_string());
    remove_core_api_key_value(&mut api_keys, "custom-key").unwrap();
    assert_eq!(api_keys, vec!["backup-key"]);
}

#[test]
fn core_config_view_exposes_api_key_metadata_for_the_webview() {
    let mut config = GuiConfigFile::default();
    ensure_strong_api_keys(&mut config).unwrap();
    ensure_strong_management_secret(&mut config).unwrap();
    let view = serde_json::to_value(CoreConfigView::from(&config)).unwrap();

    assert!(view["apiKeys"][0]["apiKey"]
        .as_str()
        .unwrap()
        .starts_with("cpa_"));
    assert_eq!(
        view["apiKeys"][0]["remark"],
        GENERATED_API_KEY_INITIAL_REMARK
    );
    assert!(view["apiKeys"][0].get("builtIn").is_none());
    assert_eq!(view["managementSecretConfigured"], true);
    assert!(view.get("managementSecretKey").is_none());
}

#[test]
fn api_key_initialization_generates_and_rotates_weak_credentials() {
    let mut fresh = GuiConfigFile::default();
    assert!(ensure_strong_api_keys(&mut fresh).unwrap());
    assert_eq!(fresh.api_keys.len(), 1);
    assert!(fresh.api_keys[0].key.starts_with("cpa_"));
    assert!(fresh.api_keys[0].key.len() >= 47);
    assert_ne!(fresh.api_keys[0].key, LEGACY_DEFAULT_API_KEY);
    assert!(!ensure_strong_api_keys(&mut fresh).unwrap());

    let mut legacy = GuiConfigFile {
        api_keys: vec![GuiApiKeyEntry {
            key: LEGACY_DEFAULT_API_KEY.to_string(),
            remark: String::new(),
        }],
        ..GuiConfigFile::default()
    };
    assert!(ensure_strong_api_keys(&mut legacy).unwrap());
    assert!(legacy.api_keys[0].key.starts_with("cpa_"));
    assert_eq!(legacy.api_keys[0].remark, GENERATED_API_KEY_INITIAL_REMARK);
    assert!(validate_core_api_key(LEGACY_DEFAULT_API_KEY).is_err());
}

#[test]
fn webui_management_secret_requires_a_non_empty_plaintext_value() {
    assert_eq!(
        normalize_management_secret_key("  new-webui-secret  ".to_string()).unwrap(),
        "new-webui-secret"
    );
    assert!(normalize_management_secret_key("   ".to_string()).is_err());
    assert!(normalize_management_secret_key(
        "$2a$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu".to_string()
    )
    .is_err());
    assert!(normalize_management_secret_key("bad\nsecret".to_string()).is_err());
    assert!(normalize_management_secret_key("123456".to_string()).is_err());
}

#[test]
fn management_secret_rotation_replaces_legacy_values_and_preserves_custom_values() {
    let mut fresh = GuiConfigFile::default();
    assert!(ensure_strong_management_secret(&mut fresh).unwrap());
    assert!(fresh.management_secret_key.starts_with("wui-Aa9_"));
    assert!(fresh.management_secret_key.len() >= 50);
    assert!(!management_secret_requires_rotation(
        &fresh.management_secret_key
    ));

    let first_generated = fresh.management_secret_key.clone();
    let mut legacy = GuiConfigFile {
        management_secret_key: LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY.to_string(),
        ..GuiConfigFile::default()
    };
    assert!(ensure_strong_management_secret(&mut legacy).unwrap());
    assert_ne!(
        legacy.management_secret_key,
        LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY
    );
    assert_ne!(legacy.management_secret_key, first_generated);

    let mut hashed = GuiConfigFile {
        management_secret_key: "$2a$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu"
            .to_string(),
        ..GuiConfigFile::default()
    };
    assert!(ensure_strong_management_secret(&mut hashed).unwrap());
    assert!(hashed.management_secret_key.starts_with("wui-Aa9_"));

    let mut custom = GuiConfigFile {
        management_secret_key: "user-selected-secret".to_string(),
        ..GuiConfigFile::default()
    };
    assert!(!ensure_strong_management_secret(&mut custom).unwrap());
    assert_eq!(custom.management_secret_key, "user-selected-secret");
}

#[test]
fn management_secret_key_is_preserved_and_written_to_core() {
    let mut config = GuiConfigFile {
        management_secret_key: "old-management-secret".to_string(),
        ..GuiConfigFile::default()
    };

    assert!(!sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.management_secret_key, "old-management-secret");

    let template = "remote-management:\n  secret-key: stale-secret\n";
    let merged = merge_core_config_yaml(template, None, &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
    assert_eq!(
        document["remote-management"]["secret-key"],
        "old-management-secret"
    );
}

#[test]
fn custom_auth_directory_is_preserved_and_written_to_core_config() {
    let mut config = GuiConfigFile {
        auth_dir: "/tmp/user-selected-auth".to_string(),
        ..GuiConfigFile::default()
    };
    ensure_strong_api_keys(&mut config).unwrap();
    ensure_strong_management_secret(&mut config).unwrap();

    assert!(validate_gui_config(&config).is_ok());
    assert!(!sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.auth_dir, "/tmp/user-selected-auth");

    let merged = merge_core_config_yaml("auth-dir: ~/.cli-proxy-api\n", None, &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
    assert_eq!(document["auth-dir"], config.auth_dir);
}

#[test]
fn default_auth_directory_is_relative_and_legacy_absolute_value_is_migrated() {
    let base_dir = agent_test_home("relative-default-auth-dir");
    let install_dir = base_dir.join("cpa-core");
    assert_eq!(
        auth_dir_path_for_core(DEFAULT_AUTH_DIR, &install_dir),
        base_dir.join(OAUTH_DIR_NAME)
    );

    let mut config = GuiConfigFile {
        auth_dir: path_to_string(&fixed_oauth_dir().unwrap()),
        ..GuiConfigFile::default()
    };
    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.auth_dir, DEFAULT_AUTH_DIR);
    fs::remove_dir_all(base_dir).unwrap();
}

#[test]
fn legacy_gui_config_can_seed_managed_core_settings() {
    let legacy = "port: 8317\nallow-lan: false\nrun-on-startup: true\n";
    let mut config = serde_yaml::from_str::<GuiConfigFile>(legacy).unwrap();
    let presence = serde_yaml::from_str::<GuiConfigPresence>(legacy).unwrap();
    let core_settings = CoreConfigSettings {
        host: "0.0.0.0".to_string(),
        port: 9000,
        auth_dir: "/tmp/external-auth".to_string(),
        api_keys: vec!["existing-key".to_string()],
        management_secret_configured: true,
        usage_statistics_enabled: false,
        plugins_enabled: true,
        routing_strategy: "fill-first".to_string(),
        proxy_url: "http://127.0.0.1:8080".to_string(),
        routing_session_affinity: true,
        routing_session_affinity_ttl: "45m".to_string(),
        management_secret_key: Some("management-secret".to_string()),
    };

    assert!(presence.api_keys.is_none());
    assert!(presence.management_secret_key.is_none());
    assert!(presence.plugins_enabled.is_none());
    assert!(presence.routing_strategy.is_none());
    apply_core_settings_to_gui_config(&mut config, &core_settings);

    assert_eq!(gui_api_key_values(&config.api_keys), vec!["existing-key"]);
    assert_eq!(config.management_secret_key, "management-secret");
    assert_eq!(config.host, "0.0.0.0");
    assert_eq!(config.port, 9000);
    assert_eq!(config.auth_dir, "/tmp/external-auth");
    assert!(!config.usage_statistics_enabled);
    assert!(config.plugins_enabled);
    assert_eq!(config.routing_strategy, "fill-first");
    assert_eq!(config.proxy_url, "http://127.0.0.1:8080");
    assert!(config.routing_session_affinity);
    assert_eq!(config.routing_session_affinity_ttl, "45m");
    assert!(config.run_on_startup);
}

#[test]
fn example_api_keys_are_not_persisted_as_gui_settings() {
    let input = "api-keys:\n  - your-api-key-1\n  - real-key\nremote-management:\n  secret-key: plain-management-secret\nplugins:\n  enabled: true\nrouting:\n  strategy: fill-first\n";
    let document = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
    let core_settings = core_config_settings_from_value(&document).unwrap();
    let mut config = GuiConfigFile::default();

    apply_core_settings_to_gui_config(&mut config, &core_settings);

    assert_eq!(core_settings.api_keys, vec!["real-key"]);
    assert_eq!(gui_api_key_values(&config.api_keys), vec!["real-key"]);
    assert_eq!(
        core_settings.management_secret_key.as_deref(),
        Some("plain-management-secret")
    );
    assert_eq!(config.management_secret_key, "plain-management-secret");
    assert!(validate_core_api_key("your-api-key-3").is_err());
}

#[test]
fn hashed_management_secret_is_detected_without_replacing_known_plaintext() {
    let input = "remote-management:\n  secret-key: $2a$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu\n";
    let document = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
    let core_settings = core_config_settings_from_value(&document).unwrap();

    assert!(core_settings
        .management_secret_key
        .as_deref()
        .is_some_and(is_hashed_management_secret_key));
    assert!(core_settings.management_secret_configured);
    let mut config = GuiConfigFile {
        management_secret_key: "known-plaintext".to_string(),
        ..GuiConfigFile::default()
    };
    apply_core_settings_to_gui_config(&mut config, &core_settings);
    assert_eq!(config.management_secret_key, "known-plaintext");
}

#[test]
fn management_api_requires_an_available_plaintext_secret() {
    let mut config = GuiConfigFile {
        management_secret_key: String::new(),
        ..GuiConfigFile::default()
    };
    assert!(management_authorization(&config).is_err());

    config.management_secret_key =
        "$2a$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu".to_string();
    assert!(management_authorization(&config).is_err());

    config.management_secret_key = "known-plaintext".to_string();
    assert_eq!(
        management_authorization(&config).unwrap(),
        "Bearer known-plaintext"
    );
}

#[test]
fn runtime_network_patch_preserves_comments_and_other_settings() {
    let config = GuiConfigFile {
        locale: "zh-CN".to_string(),
        port: 9527,
        allow_lan: true,
        host: "0.0.0.0".to_string(),
        run_on_startup: false,
        ..GuiConfigFile::default()
    };
    let input = "# Bind address\nhost: 127.0.0.1 # local only\n\n# Service port\nport: 8317 # default\ndebug: true\n";
    let updated = patch_core_network_yaml(input, &config)
        .unwrap()
        .expect("network settings should change");

    assert_eq!(
            updated,
            "# Bind address\nhost: 0.0.0.0 # local only\n\n# Service port\nport: 9527 # default\ndebug: true\n"
        );
    assert!(updated.contains("# Bind address"));
    assert!(updated.contains("# local only"));
    assert!(updated.contains("# Service port"));
    assert!(updated.contains("# default"));
    assert!(updated.contains("debug: true"));

    let document = serde_norway::from_str::<serde_norway::Value>(&updated).unwrap();
    assert_eq!(
        document["host"],
        serde_norway::Value::String("0.0.0.0".to_string())
    );
    assert_eq!(document["port"], serde_norway::to_value(9527_u16).unwrap());
}

#[test]
fn runtime_network_patch_skips_unchanged_yaml() {
    let config = GuiConfigFile::default();
    let input = "host: 127.0.0.1\nport: 8317\n";

    assert!(patch_core_network_yaml(input, &config).unwrap().is_none());
}

#[test]
fn confirmed_network_routing_patch_updates_all_fields_together() {
    let config = GuiConfigFile {
        port: 9527,
        allow_lan: true,
        host: "0.0.0.0".to_string(),
        proxy_url: "socks5://127.0.0.1:7890".to_string(),
        routing_session_affinity: true,
        routing_session_affinity_ttl: "2h".to_string(),
        ..GuiConfigFile::default()
    };
    let input = "# network\nhost: 127.0.0.1\nport: 8317\nproxy-url: \"\"\n# routing\nrouting:\n  strategy: round-robin\n# unrelated\ndebug: true\n";
    let updated = patch_core_network_routing_yaml(input, &config)
        .unwrap()
        .expect("confirmed settings should change");
    let document = serde_norway::from_str::<serde_norway::Value>(&updated).unwrap();

    assert_eq!(document["host"], "0.0.0.0");
    assert_eq!(document["port"], 9527);
    assert_eq!(document["proxy-url"], "socks5://127.0.0.1:7890");
    assert_eq!(document["routing"]["session-affinity"], true);
    assert_eq!(document["routing"]["session-affinity-ttl"], "2h");
    assert_eq!(document["routing"]["strategy"], "round-robin");
    assert_eq!(document["debug"], true);
    assert!(updated.contains("# network"));
    assert!(updated.contains("# routing"));
    assert!(updated.contains("# unrelated"));
}

#[test]
fn core_config_controls_preserve_comments_and_unrelated_values() {
    let input = "# Client authentication\napi-keys:\n  - old-key\n\n# Plugin runtime\nplugins:\n  enabled: false # global switch\n  dir: plugins\n\n# Credential routing\nrouting:\n  strategy: round-robin # current strategy\n  session-affinity: true\n\ndebug: true # untouched\n";
    let mut document = yaml_serde_edit::YamlValue::parse(input).unwrap();
    let mut updated = document.get().clone();

    set_core_api_keys(
        &mut updated,
        vec!["old-key".to_string(), "new-key".to_string()],
    )
    .unwrap();
    set_nested_yaml_value(&mut updated, &["plugins", "enabled"], true).unwrap();
    set_nested_yaml_value(
        &mut updated,
        &["routing", "strategy"],
        "fill-first".to_string(),
    )
    .unwrap();
    document.set(updated);

    let rendered = document.get_string();
    assert!(rendered.contains("# Client authentication"));
    assert!(rendered.contains("# Plugin runtime"));
    assert!(rendered.contains("# global switch"));
    assert!(rendered.contains("# Credential routing"));
    assert!(rendered.contains("# current strategy"));
    assert!(rendered.contains("debug: true # untouched"));

    let settings = core_config_settings_from_value(document.get()).unwrap();
    assert_eq!(settings.api_keys, vec!["old-key", "new-key"]);
    assert!(settings.plugins_enabled);
    assert_eq!(settings.routing_strategy, "fill-first");
    assert_eq!(document.get()["plugins"]["dir"], "plugins");
    assert_eq!(document.get()["routing"]["session-affinity"], true);
}

#[test]
fn yaml_edit_runtime_patches_supported_fields_without_reflowing_yaml() {
    let input = "# Client authentication\napi-keys:\n  - old-key\n\n# Plugin runtime\nplugins:\n  enabled: false # global switch\n  dir: plugins\n\n# Credential routing\nrouting:\n  strategy: round-robin # current strategy\n  session-affinity: true\n\ndebug: true # untouched\n";
    let file = input.parse::<yaml_edit::YamlFile>().unwrap();
    let document = file.document().unwrap();

    assert!(set_yaml_edit_nested_value(
        &document, "plugins", "enabled", true
    ));
    assert!(set_yaml_edit_nested_value(
        &document,
        "routing",
        "strategy",
        "fill-first".to_string()
    ));

    let rendered = patch_core_api_keys_yaml(
        &file.to_string(),
        &["new-key".to_string(), "backup-key".to_string()],
    )
    .unwrap();
    assert!(rendered.contains("# Client authentication"));
    assert!(rendered.contains("# Plugin runtime"));
    assert!(rendered.contains("# global switch"));
    assert!(rendered.contains("# Credential routing"));
    assert!(rendered.contains("# current strategy"));
    assert!(rendered.contains("debug: true # untouched"));
    assert!(rendered.contains("dir: plugins"));
    assert!(rendered.contains("session-affinity: true"));

    let settings =
        core_config_settings_from_value(&serde_norway::from_str(&rendered).unwrap()).unwrap();
    assert_eq!(settings.api_keys, vec!["new-key", "backup-key"]);
    assert!(settings.plugins_enabled);
    assert_eq!(settings.routing_strategy, "fill-first");
}

#[test]
fn yaml_edit_sequence_shrink_keeps_following_top_level_key_valid() {
    let input = "# API keys for authentication\napi-keys:\n  - first-key\n  - second-key\n  - third-key\n\n# Enable debug logging\ndebug: false\n";
    let original = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
    let mut updated = original.clone();
    set_core_api_keys(&mut updated, vec!["first-key".to_string()]).unwrap();

    let rendered = render_yaml_value_changes(input, &original, &updated)
        .unwrap_or_else(|error| panic!("sequence shrink failed: {error}"));
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));

    assert_eq!(parsed["api-keys"][0], "first-key");
    assert_eq!(parsed["api-keys"].as_sequence().unwrap().len(), 1);
    assert_eq!(parsed["debug"], false);
    assert!(rendered.find("api-keys:").unwrap() < rendered.find("debug:").unwrap());
}

#[test]
fn runtime_yaml_ast_patch_handles_core_comments_around_nested_mapping() {
    let input = "host: 127.0.0.1\nremote-management:\n# Whether to allow remote access.\n  allow-remote: false\n# Management key.\n# All requests require this key.\n  secret-key: old\n# Disable panel.\n  disable-control-panel: false\nauth-dir: /tmp/old\napi-keys:\n  - old-key\n";
    let rendered = patch_core_yaml_document(input, |document| {
        let auth_changed = set_core_yaml_top_level_value(
            document,
            "auth-dir",
            serde_norway::Value::String("/tmp/new".to_string()),
        )?;
        let secret_changed = set_core_yaml_nested_value(
            document,
            "remote-management",
            "secret-key",
            serde_norway::Value::String("123456".to_string()),
        )?;
        Ok(auth_changed || secret_changed)
    })
    .unwrap()
    .unwrap();
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));

    assert_eq!(parsed["auth-dir"], "/tmp/new");
    assert_eq!(parsed["remote-management"]["secret-key"], "123456");
    assert!(rendered.contains("# All requests require this key."));
    assert!(rendered.contains("disable-control-panel: false"));
}

#[test]
fn yaml_edit_runtime_patch_removes_empty_keys_and_skips_unsupported_sections() {
    let input = "# Client authentication\napi-keys:\n  - old-key\nplugins:\n  enabled: true\nrouting:\n  strategy: fill-first\n";
    let rendered = patch_core_api_keys_yaml(input, &[]).unwrap();
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered).unwrap();
    let root = parsed.as_mapping().unwrap();
    assert!(yaml_mapping_value(root, "api-keys").is_none(), "{rendered}");
    assert_eq!(
        core_config_settings_from_value(&parsed).unwrap().api_keys,
        Vec::<String>::new()
    );

    let missing_api_keys = "host: 127.0.0.1\nport: 8317\n";
    let rendered = patch_core_api_keys_yaml(
        missing_api_keys,
        &["new-key".to_string(), "backup-key".to_string()],
    )
    .unwrap();
    let settings =
        core_config_settings_from_value(&serde_norway::from_str(&rendered).unwrap()).unwrap();
    assert_eq!(settings.api_keys, vec!["new-key", "backup-key"]);
    assert!(rendered.contains("host: 127.0.0.1"));
    assert!(rendered.contains("port: 8317"));

    // Nested plugin/routing sections are still optional for comment-preserving
    // runtime patches; missing maps remain unsupported and stay untouched.
    let unsupported = "host: 127.0.0.1\nport: 8317\n";
    let file = unsupported.parse::<yaml_edit::YamlFile>().unwrap();
    let document = file.document().unwrap();
    assert!(!set_yaml_edit_nested_value(
        &document, "plugins", "enabled", true
    ));
    assert!(!set_yaml_edit_nested_value(
        &document,
        "routing",
        "strategy",
        "fill-first".to_string()
    ));
    assert_eq!(file.to_string(), unsupported);
}

#[test]
fn yaml_edit_runtime_patch_recreates_api_keys_after_delete_all() {
    let input = "# Client authentication\napi-keys:\n  - old-key\nplugins:\n  enabled: true\n";
    let cleared = patch_core_api_keys_yaml(input, &[]).unwrap();
    let rendered = patch_core_api_keys_yaml(&cleared, &["restored-key".to_string()]).unwrap();
    assert!(rendered.contains("# Client authentication"), "{rendered}");
    let settings =
        core_config_settings_from_value(&serde_norway::from_str(&rendered).unwrap()).unwrap();
    assert_eq!(settings.api_keys, vec!["restored-key"]);
}

#[test]
fn yaml_edit_runtime_patch_adds_api_keys_to_core_style_config() {
    let input = "host: 127.0.0.1\nremote-management:\n# nested setting comment\n  allow-remote: false\nauth-dir: /tmp/oauth\n# API keys for authentication\n# Enable debug logging\ndebug: false\n\n# Optional payload configuration\n# payload:\n#   filter:\n#     - models:\n#         - name: \"gemini-2.5-pro\"\n#       params:\n#         - \"generationConfig.responseJsonSchema\"\n";
    let rendered =
        patch_core_api_keys_yaml(input, &["new-key".to_string(), "backup-key".to_string()])
            .unwrap();
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));
    let settings = core_config_settings_from_value(&parsed).unwrap();
    assert_eq!(settings.api_keys, vec!["new-key", "backup-key"]);
    assert!(rendered.contains("# Optional payload configuration"));
    assert!(rendered.contains("generationConfig.responseJsonSchema"));
    assert!(rendered.find("auth-dir: /tmp/oauth").unwrap() < rendered.find("api-keys:").unwrap());
    assert!(rendered.find("api-keys:").unwrap() < rendered.find("debug: false").unwrap());
}

#[test]
fn yaml_edit_runtime_patch_updates_existing_real_core_config() {
    let input = "host: 0.0.0.0\nremote-management:\n# nested comment\n  allow-remote: false\nauth-dir: /tmp/oauth\n# API keys for authentication\napi-keys:\n  - '123456'\n# Enable debug logging\ndebug: false\n\n# payload:\n#   filter:\n#     - models:\n#         - name: gemini\n";
    let rendered =
        patch_core_api_keys_yaml(input, &[DEFAULT_API_KEY.to_string(), "new-key".to_string()])
            .unwrap();
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));
    assert_eq!(
        core_config_settings_from_value(&parsed).unwrap().api_keys,
        vec![DEFAULT_API_KEY, "new-key"]
    );
}

#[test]
fn runtime_api_key_patch_replaces_indentationless_core_sequence() {
    let input =
        "host: 0.0.0.0\nport: 8317\nauth-dir: /tmp/oauth\napi-keys:\n- '123456'\ndebug: false\n";
    let rendered = patch_core_api_keys_yaml(input, &[DEFAULT_API_KEY.to_string()])
        .unwrap_or_else(|error| panic!("patch failed: {error}"));
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));

    assert_eq!(
        core_config_settings_from_value(&parsed).unwrap().api_keys,
        vec![DEFAULT_API_KEY]
    );
    assert_eq!(
        rendered.matches(&format!("- {DEFAULT_API_KEY}")).count(),
        1,
        "{rendered}"
    );
    assert!(rendered.contains("debug: false"), "{rendered}");
}

#[test]
fn yaml_edit_runtime_patch_migrates_legacy_api_key_entries() {
    let input = "auth:\n  providers:\n    config-api-key:\n      api-key-entries:\n        - api-key: first-key\n        - key: second-key\nplugins:\n  enabled: false\n";
    let rendered = patch_core_api_keys_yaml(input, &["migrated-key".to_string()]).unwrap();
    let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered).unwrap();
    let settings = core_config_settings_from_value(&parsed).unwrap();
    assert_eq!(settings.api_keys, vec!["migrated-key"]);
    assert!(
        nested_yaml_value(
            parsed.as_mapping().unwrap(),
            &["auth", "providers", "config-api-key", "api-key-entries"]
        )
        .is_none(),
        "{rendered}"
    );
}

#[test]
fn core_config_reads_legacy_api_key_entries() {
    let input = "auth:\n  providers:\n    config-api-key:\n      api-key-entries:\n        - api-key: first-key\n        - key: second-key\nplugins:\n  enabled: false\nrouting:\n  strategy: round-robin\n";
    let document = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
    let settings = core_config_settings_from_value(&document).unwrap();

    assert_eq!(settings.api_keys, vec!["first-key", "second-key"]);
    assert!(!settings.plugins_enabled);
    assert_eq!(settings.routing_strategy, "round-robin");
}

#[test]
fn core_config_reads_proxy_and_session_affinity_fields() {
    let canonical = serde_norway::from_str::<serde_norway::Value>(
            "proxy-url: socks5://127.0.0.1:7890\nrouting:\n  session-affinity: true\n  session-affinity-ttl: 2h\n",
        )
        .unwrap();
    let settings = core_config_settings_from_value(&canonical).unwrap();
    assert_eq!(settings.proxy_url, "socks5://127.0.0.1:7890");
    assert!(settings.routing_session_affinity);
    assert_eq!(settings.routing_session_affinity_ttl, "2h");

    let aliases = serde_norway::from_str::<serde_norway::Value>(
        "routing:\n  sessionAffinity: true\n  sessionAffinityTTL: 30m\n",
    )
    .unwrap();
    let settings = core_config_settings_from_value(&aliases).unwrap();
    assert!(settings.routing_session_affinity);
    assert_eq!(settings.routing_session_affinity_ttl, "30m");

    let defaults = core_config_settings_from_value(&serde_norway::from_str("{}").unwrap()).unwrap();
    assert_eq!(defaults.proxy_url, "");
    assert!(!defaults.routing_session_affinity);
    assert_eq!(defaults.routing_session_affinity_ttl, "");
}

#[test]
fn managed_session_settings_use_canonical_yaml_and_preserve_unrelated_content() {
    let input = "# global proxy\nproxy-url: old\n# routing options\nrouting:\n  strategy: round-robin\n  sessionAffinity: false\n  sessionAffinityTTL: 10m\n# unrelated option\ndebug: true\n";
    let config = GuiConfigFile {
        proxy_url: "http://127.0.0.1:8080".to_string(),
        routing_session_affinity: true,
        routing_session_affinity_ttl: "1h".to_string(),
        ..GuiConfigFile::default()
    };
    let rendered = apply_gui_managed_settings(input, &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&rendered).unwrap();

    assert_eq!(document["proxy-url"], "http://127.0.0.1:8080");
    assert_eq!(document["routing"]["session-affinity"], true);
    assert_eq!(document["routing"]["session-affinity-ttl"], "1h");
    assert_eq!(document["remote-management"]["disable-control-panel"], true);
    assert_eq!(
        document["remote-management"]["disable-auto-update-panel"],
        true
    );
    assert!(rendered.contains("# global proxy"));
    assert!(rendered.contains("# unrelated option"));
    assert_eq!(document["debug"], true);
}

#[test]
fn optional_core_strings_are_trimmed_and_reject_control_characters() {
    assert_eq!(
        normalize_optional_config_string("  socks5://proxy:7890  ".to_string(), "代理 URL")
            .unwrap(),
        "socks5://proxy:7890"
    );
    assert_eq!(
        normalize_optional_config_string(" 1h ".to_string(), "TTL").unwrap(),
        "1h"
    );
    assert!(normalize_optional_config_string("bad\nvalue".to_string(), "代理 URL").is_err());
}

#[test]
fn configured_proxy_supports_http_and_socks5_urls() {
    for proxy_url in ["http://127.0.0.1:8080", "socks5://127.0.0.1:7890"] {
        apply_configured_proxy(reqwest::Client::builder(), proxy_url)
            .unwrap()
            .build()
            .unwrap();
    }
}

#[test]
fn core_config_validates_keys_and_routing_strategy() {
    assert!(validate_core_api_key("sk-valid_123").is_ok());
    assert!(validate_core_api_key("").is_err());
    assert!(validate_core_api_key("contains space").is_err());
    assert!(validate_routing_strategy("round-robin").is_ok());
    assert!(validate_routing_strategy("fill-first").is_ok());
    assert!(validate_routing_strategy("random").is_err());
}

#[test]
fn unchanged_yaml_is_not_written_again() {
    let path = std::env::temp_dir().join(format!(
        "cpa-gui-unchanged-yaml-{}-{}.yaml",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let content = "host: 127.0.0.1\nport: 8317\n";
    fs::write(&path, content).unwrap();

    assert!(!write_yaml_if_changed(&path, content).unwrap());
    assert_eq!(fs::read_to_string(&path).unwrap(), content);

    fs::remove_file(path).unwrap();
}

#[test]
fn startup_preserves_all_user_owned_yaml_and_only_applies_gui_managed_values() {
    let template = "# Current release template\nhost: \"\" # template bind address\nport: 8317\n\n# Client authentication\napi-keys:\n  - template-key\n\n# Plugin runtime\nplugins:\n  enabled: false # plugin switch\n\n# Credential routing\nrouting:\n  strategy: round-robin # routing switch\n\n# New release option\nnew-option: true\nnested:\n  # Nested template comment\n  keep: template\n  added: from-template\nlist:\n  - template-item\n";
    let current = "# User-edited configuration\nhost: 127.0.0.1\nport: 9000\n# User-owned nested values\nnested:\n  keep: current\n  current-only: retained\nlist:\n  - current-a\n  - current-b\nextra: true\ncustom-provider:\n  base-url: https://example.com/v1\n  headers:\n    X-Custom-Header: custom-value\n  models:\n    - name: custom-model\n      aliases: [custom-a, custom-b]\nplugins:\n  custom-runtime-options:\n    sandbox: strict\n    environment:\n      CUSTOM_FLAG: enabled\nrouting:\n  custom-rules:\n    - match: custom-*\n      target: custom-provider\nremote-management:\n  custom-dashboard-option: retained\n";
    let config = GuiConfigFile {
        locale: "zh-CN".to_string(),
        port: 9527,
        allow_lan: true,
        host: "0.0.0.0".to_string(),
        run_on_startup: false,
        silent_start: false,
        close_behavior: WindowsCloseBehavior::Ask,
        window_width: None,
        window_height: None,
        auth_dir: path_to_string(&fixed_oauth_dir().unwrap()),
        api_keys: vec![
            default_api_key_entry(),
            GuiApiKeyEntry {
                key: "gui-key".to_string(),
                remark: "测试密钥".to_string(),
            },
        ],
        api_access_remarks: Vec::new(),
        management_secret_key: String::new(),
        usage_statistics_enabled: false,
        plugins_enabled: true,
        routing_strategy: "fill-first".to_string(),
        proxy_url: "socks5://127.0.0.1:7890".to_string(),
        routing_session_affinity: true,
        routing_session_affinity_ttl: "1h".to_string(),
    };
    let merged = merge_core_config_yaml(template, Some(current), &config).unwrap();
    let current_document = serde_norway::from_str::<serde_norway::Value>(current).unwrap();

    assert!(merged.contains("# User-edited configuration"));
    assert!(merged.contains("# User-owned nested values"));
    assert!(!merged.contains("# Current release template"));
    assert!(!merged.contains("# New release option"));

    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
    assert_eq!(
        document["host"],
        serde_norway::Value::String("0.0.0.0".to_string())
    );
    assert_eq!(document["port"], serde_norway::to_value(9527_u16).unwrap());
    assert_eq!(document["api-keys"][0], DEFAULT_API_KEY);
    assert_eq!(document["api-keys"][1], "gui-key");
    assert_eq!(document["plugins"]["enabled"], true, "{merged}");
    assert_eq!(document["routing"]["strategy"], "fill-first");
    assert_eq!(document["proxy-url"], "socks5://127.0.0.1:7890");
    assert_eq!(document["routing"]["session-affinity"], true);
    assert_eq!(document["routing"]["session-affinity-ttl"], "1h");
    assert_eq!(document["usage-statistics-enabled"], false);
    assert!(document.get("new-option").is_none());
    assert_eq!(document["nested"], current_document["nested"]);
    assert!(document["nested"].get("added").is_none());
    for key in ["list", "extra", "custom-provider"] {
        assert_eq!(document[key], current_document[key], "user field {key}");
    }
    assert_eq!(
        document["plugins"]["custom-runtime-options"],
        current_document["plugins"]["custom-runtime-options"]
    );
    assert_eq!(
        document["routing"]["custom-rules"],
        current_document["routing"]["custom-rules"]
    );
    assert_eq!(
        document["remote-management"]["custom-dashboard-option"],
        current_document["remote-management"]["custom-dashboard-option"]
    );
}

#[test]
fn startup_merge_preserves_plugin_store_config_written_by_core() {
    let template = "host: \"\"\nport: 8317\nauth-dir: ~/.cli-proxy-api\napi-keys:\n  - template-key\nremote-management:\n  secret-key: \"\"\nusage-statistics-enabled: true\nplugins:\n  enabled: false\n  dir: plugins\n  configs:\n    example:\n      enabled: true\n      priority: 1\nrouting:\n  strategy: round-robin\n  session-affinity: false\n  session-affinity-ttl: \"\"\nproxy-url: \"\"\ncommercial-mode: false\n";
    let current = "host: 127.0.0.1\nport: 8317\nauth-dir: ~/.cli-proxy-api\napi-keys:\n  - '123456'\nremote-management:\n  secret-key: \"\"\nusage-statistics-enabled: true\nplugins:\n  enabled: true\n  dir: plugins\n  configs:\n    model-fallback-router:\n      enabled: true\n      store:\n        id: model-fallback-router\n        name: Model Fallback Router\n        description: Retries matching model requests through configured fallback model names when the primary model fails with quota, rate-limit, transport, or configured HTTP status errors.\n        author: thebtf\n        version: 0.2.0\n        release-tag: v0.2.0\n        repository: https://github.com/thebtf/cpa-model-fallback-router\n        tags:\n          - Router\n          - Model Router\n          - Fallback\n        install:\n          type: github-release\nrouting:\n  strategy: round-robin\n  session-affinity: false\n  session-affinity-ttl: \"\"\nproxy-url: \"\"\n";
    let config = GuiConfigFile {
        host: "0.0.0.0".to_string(),
        allow_lan: true,
        plugins_enabled: true,
        ..GuiConfigFile::default()
    };

    let merged = merge_core_config_yaml(template, Some(current), &config)
        .unwrap_or_else(|error| panic!("plugin config merge failed: {error}"));
    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
    let current_document = serde_norway::from_str::<serde_norway::Value>(current).unwrap();

    assert_eq!(document["host"], "0.0.0.0");
    assert_eq!(
        document["plugins"]["configs"]["model-fallback-router"],
        current_document["plugins"]["configs"]["model-fallback-router"]
    );
    assert_eq!(
        document["plugins"]["configs"]["model-fallback-router"]["store"]["version"],
        "0.2.0"
    );
    assert_eq!(
        document["plugins"]["configs"]["model-fallback-router"]["store"]["install"]["type"],
        "github-release"
    );
    assert!(document.get("commercial-mode").is_none());
    assert!(document["plugins"]["configs"].get("example").is_none());
}

#[test]
fn startup_merge_without_current_config_uses_gui_defaults() {
    let template = "# Template\nhost: \"\"\nport: 9000\napi-keys:\n  - template-key\nplugins:\n  enabled: true\nrouting:\n  strategy: fill-first\ndebug: false\n";
    let mut config = GuiConfigFile::default();
    ensure_strong_api_keys(&mut config).unwrap();
    ensure_strong_management_secret(&mut config).unwrap();
    let merged = merge_core_config_yaml(template, None, &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();

    assert!(merged.contains("# Template"));
    assert_eq!(
        document["host"],
        serde_norway::Value::String("127.0.0.1".to_string())
    );
    assert_eq!(document["port"], serde_norway::to_value(8317_u16).unwrap());
    assert_eq!(document["debug"], serde_norway::Value::Bool(false));
    assert_eq!(document["api-keys"][0], config.api_keys[0].key, "{merged}");
    assert_eq!(document["plugins"]["enabled"], false);
    assert_eq!(document["routing"]["strategy"], "round-robin");
    assert_eq!(document["usage-statistics-enabled"], true);
    assert_eq!(
        document["remote-management"]["secret-key"],
        config.management_secret_key
    );
    assert_eq!(document["remote-management"]["disable-control-panel"], true);
    assert_eq!(
        document["remote-management"]["disable-auto-update-panel"],
        true
    );
}

#[test]
fn startup_merge_can_shrink_template_api_key_sequence() {
    let template = "host: \"\"\nport: 8317\nremote-management:\n  secret-key: \"\"\nauth-dir: ~/.cli-proxy-api\napi-keys:\n  - template-one\n  - template-two\n  - template-three\ndebug: false\nplugins:\n  enabled: false\nrouting:\n  strategy: round-robin\n";
    let current = "host: 127.0.0.1\nport: 8317\nremote-management:\n  secret-key: hashed\nauth-dir: C:/oauth\napi-keys:\n  - '123456'\ndebug: false\nplugins:\n  enabled: false\nrouting:\n  strategy: round-robin\n";

    let mut config = GuiConfigFile::default();
    ensure_strong_api_keys(&mut config).unwrap();
    ensure_strong_management_secret(&mut config).unwrap();
    let merged = merge_core_config_yaml(template, Some(current), &config).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&merged)
        .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{merged}"));

    assert_eq!(document["api-keys"][0], config.api_keys[0].key);
    assert_eq!(document["api-keys"].as_sequence().unwrap().len(), 1);
    assert_eq!(document["debug"], false);
    assert_eq!(
        document["remote-management"]["secret-key"],
        config.management_secret_key
    );
}
