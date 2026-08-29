use super::support::*;
use super::*;

#[test]
fn codex_agent_modification_merges_external_edits_and_restores_managed_fields() {
    let home = agent_test_home("codex-organic-merge");
    let path = home.join(".codex/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = br#"# original comment
model_provider = "user-provider"
model = "user-model"
model_catalog_json = "user-catalog.json"
approval_policy = "on-request"

[model_providers.user-provider]
name = "User Provider"
base_url = "https://example.com/v1"

[model_providers.cpa-gui]
name = "Existing CPA"
base_url = "https://existing.invalid/v1"
wire_api = "chat"
        experimental_bearer_token = "existing-token"
custom_option = "keep-original"
"#;
    fs::write(&path, original).unwrap();
    let hard_link = path.with_file_name("config-hard-link.toml");
    fs::hard_link(&path, &hard_link).unwrap();

    let available_models = test_agent_models(&["gpt-one", "gpt-two", "gpt-three"]);
    let codex_models = test_codex_models(&["gpt-one", "gpt-two", "gpt-three"]);
    let enabled = enable_agent_modification(
        AgentClient::Codex,
        &home,
        8317,
        "gpt-one",
        &available_models,
        Some(&codex_models),
    )
    .unwrap();
    assert_eq!(enabled.outcome, "enabled");
    let backup = agent_backup_path(&path).unwrap();
    let state = agent_state_path(std::slice::from_ref(&path)).unwrap();
    let catalog_path = codex_model_catalog_path(&home);
    assert_eq!(fs::read(&backup).unwrap(), original);
    assert!(state.is_file());
    assert!(catalog_path.is_file());
    assert_eq!(fs::read(&hard_link).unwrap(), fs::read(&path).unwrap());
    assert!(fs::read_to_string(&hard_link)
        .unwrap()
        .contains(MANAGED_AGENT_PROVIDER_ID));

    let mut externally_edited = fs::read_to_string(&path)
        .unwrap()
        .parse::<toml_edit::Document>()
        .unwrap();
    externally_edited["approval_policy"] = toml_edit::value("never");
    externally_edited["custom_after_enable"] = toml_edit::value(true);
    externally_edited["model_provider"] = toml_edit::value("external-provider");
    externally_edited["model"] = toml_edit::value("external-model");
    let provider = externally_edited["model_providers"]
        .as_table_mut()
        .unwrap()
        .get_mut(MANAGED_AGENT_PROVIDER_ID)
        .and_then(toml_edit::Item::as_table_mut)
        .unwrap();
    provider["base_url"] = toml_edit::value("https://external.invalid/v1");
    provider["custom_option"] = toml_edit::value("keep-updated");
    fs::write(&path, externally_edited.to_string()).unwrap();

    let (configured, current_model, _, _) =
        inspect_codex_agent_config(&path, 8317, DEFAULT_API_KEY).unwrap();
    let inspection = inspect_agent_modification(
        AgentClient::Codex,
        &home,
        8317,
        configured,
        current_model.as_deref(),
    );
    assert!(inspection.enabled);
    assert_eq!(inspection.state, "active");
    assert!(inspection
        .warnings
        .iter()
        .any(|warning| warning.contains("自动重新同步")));

    let updated = update_agent_modification(
        AgentClient::Codex,
        &home,
        8317,
        "gpt-three",
        &available_models,
        Some(&codex_models),
    )
    .unwrap();
    assert_eq!(updated.outcome, "updated");
    assert_eq!(fs::read(&backup).unwrap(), original);
    assert_eq!(fs::read(&hard_link).unwrap(), fs::read(&path).unwrap());
    let managed: toml::Value = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        managed["model_provider"].as_str(),
        Some(MANAGED_AGENT_PROVIDER_ID)
    );
    assert_eq!(managed["model"].as_str(), Some("gpt-three"));
    assert_eq!(managed["approval_policy"].as_str(), Some("never"));
    assert_eq!(managed["custom_after_enable"].as_bool(), Some(true));
    assert_eq!(
        managed["model_providers"][MANAGED_AGENT_PROVIDER_ID]["base_url"].as_str(),
        Some("http://127.0.0.1:8317/v1")
    );
    assert_eq!(
        managed["model_providers"][MANAGED_AGENT_PROVIDER_ID]["custom_option"].as_str(),
        Some("keep-updated")
    );

    let restored = disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
    assert_eq!(restored.outcome, "disabled");
    assert!(restored.conflict_files.is_empty());
    let restored_content = fs::read_to_string(&path).unwrap();
    let restored_value: toml::Value = toml::from_str(&restored_content).unwrap();
    assert!(restored_content.contains("# original comment"));
    assert_eq!(
        restored_value["model_provider"].as_str(),
        Some("user-provider")
    );
    assert_eq!(restored_value["model"].as_str(), Some("user-model"));
    assert_eq!(
        restored_value["model_catalog_json"].as_str(),
        Some("user-catalog.json")
    );
    assert_eq!(restored_value["approval_policy"].as_str(), Some("never"));
    assert_eq!(restored_value["custom_after_enable"].as_bool(), Some(true));
    assert_eq!(
        restored_value["model_providers"][MANAGED_AGENT_PROVIDER_ID]["name"].as_str(),
        Some("Existing CPA")
    );
    assert_eq!(
        restored_value["model_providers"][MANAGED_AGENT_PROVIDER_ID]["base_url"].as_str(),
        Some("https://existing.invalid/v1")
    );
    assert_eq!(
        restored_value["model_providers"][MANAGED_AGENT_PROVIDER_ID]["custom_option"].as_str(),
        Some("keep-updated")
    );
    assert_eq!(
        restored_value["model_providers"]["user-provider"]["base_url"].as_str(),
        Some("https://example.com/v1")
    );
    assert_eq!(fs::read(&hard_link).unwrap(), fs::read(&path).unwrap());
    assert!(!catalog_path.exists());
    assert!(!backup.exists());
    assert!(!state.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn codex_disable_keeps_user_configuration_added_after_enable() {
    let home = agent_test_home("codex-created-config");
    let path = home.join(".codex/config.toml");
    let models = test_agent_models(&["gpt-test"]);
    let codex_models = test_codex_models(&["gpt-test"]);

    enable_agent_modification(
        AgentClient::Codex,
        &home,
        8317,
        "gpt-test",
        &models,
        Some(&codex_models),
    )
    .unwrap();
    let mut edited = fs::read_to_string(&path)
        .unwrap()
        .parse::<toml_edit::Document>()
        .unwrap();
    edited["approval_policy"] = toml_edit::value("never");
    fs::write(&path, edited.to_string()).unwrap();

    let result = disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
    assert_eq!(result.outcome, "disabled");
    let restored_content = fs::read_to_string(&path).unwrap();
    let restored: toml::Value = toml::from_str(&restored_content).unwrap();
    assert_eq!(restored["approval_policy"].as_str(), Some("never"));
    assert!(restored.get("model_provider").is_none());
    assert!(restored.get("model").is_none());
    assert!(restored.get("model_catalog_json").is_none());
    assert!(restored.get("model_providers").is_none());
    assert!(!codex_model_catalog_path(&home).exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_modification_removes_files_that_did_not_exist_before_enable() {
    let home = agent_test_home("opencode-absent");
    let path = home.join(".config/opencode/opencode.json");

    let models = test_agent_models(&["gpt-test"]);
    enable_agent_modification(
        AgentClient::OpenCode,
        &home,
        8317,
        "gpt-test",
        &models,
        None,
    )
    .unwrap();
    assert!(path.is_file());
    assert!(!agent_backup_path(&path).unwrap().exists());

    disable_agent_modification(AgentClient::OpenCode, &home, 8317, false).unwrap();
    assert!(!path.exists());
    assert!(!agent_state_path(&[path]).unwrap().exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn opencode_jsonc_configuration_can_be_applied_and_restored() {
    let home = agent_test_home("opencode-jsonc-transaction");
    let path = home.join(".config/opencode/opencode.jsonc");
    let original = b"{\n  // Keep this comment.\n  \"theme\": \"dark\",\n}\n";
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, original).unwrap();

    enable_agent_modification(
        AgentClient::OpenCode,
        &home,
        8317,
        "gpt-test",
        &test_agent_models(&["gpt-test"]),
        None,
    )
    .unwrap();
    let applied: serde_json::Value = json5::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(applied["model"], "cpa-gui/gpt-test");
    assert!(fs::read_to_string(&path)
        .unwrap()
        .contains("// Keep this comment."));

    disable_agent_modification(AgentClient::OpenCode, &home, 8317, false).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_enable_discards_backup_when_state_cannot_be_written() {
    let home = agent_test_home("state-write-failure");
    let path = home.join(".codex/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"approval_policy = \"never\"\n").unwrap();
    let state_path = agent_state_path(std::slice::from_ref(&path)).unwrap();
    fs::create_dir(&state_path).unwrap();

    let available_models = test_agent_models(&["gpt-test"]);
    let codex_models = test_codex_models(&["gpt-test"]);
    assert!(enable_agent_modification(
        AgentClient::Codex,
        &home,
        8317,
        "gpt-test",
        &available_models,
        Some(&codex_models),
    )
    .is_err());
    assert_eq!(fs::read(&path).unwrap(), b"approval_policy = \"never\"\n");
    assert!(!agent_backup_path(&path).unwrap().exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn claude_code_keeps_using_the_path_that_owns_active_state() {
    let home = agent_test_home("claude-path-state");
    let directory = home.join(".claude");
    let settings = directory.join("settings.json");
    let legacy = directory.join("claude.json");
    fs::create_dir_all(&directory).unwrap();
    fs::write(&settings, b"{}\n").unwrap();
    fs::write(&legacy, b"{}\n").unwrap();
    fs::write(
        agent_state_path(std::slice::from_ref(&legacy)).unwrap(),
        b"{}\n",
    )
    .unwrap();

    assert_eq!(
        agent_config_paths(AgentClient::ClaudeCode, &home),
        vec![legacy]
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn legacy_agent_backup_restores_even_when_gui_port_changed() {
    let home = agent_test_home("legacy-port");
    let path = home.join(".codex/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = b"approval_policy = \"never\"\n";
    fs::write(agent_backup_path(&path).unwrap(), original).unwrap();
    fs::write(
        &path,
        build_codex_agent_config(
            Some(std::str::from_utf8(original).unwrap()),
            "http://127.0.0.1:9999/v1",
            DEFAULT_API_KEY,
            "gpt-legacy",
        )
        .unwrap(),
    )
    .unwrap();

    assert!(agent_has_managed_marker(AgentClient::Codex, std::slice::from_ref(&path)).unwrap());
    let result = disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
    assert_eq!(result.outcome, "disabled");
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn legacy_generated_only_agent_config_is_removed_without_backup() {
    let home = agent_test_home("legacy-generated");
    let path = home.join(".codex/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        build_codex_agent_config(
            None,
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "gpt-generated",
        )
        .unwrap(),
    )
    .unwrap();

    let result = disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
    assert_eq!(result.outcome, "disabled");
    assert!(!path.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn updating_legacy_codex_state_adds_catalog_without_replacing_original_backup() {
    let home = agent_test_home("legacy-catalog-upgrade");
    let path = home.join(".codex/config.toml");
    let catalog_path = codex_model_catalog_path(&home);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original_config = b"approval_policy = \"never\"\n";
    let original_catalog = b"{\"models\":[{\"slug\":\"user-model\"}]}\n";
    fs::write(agent_backup_path(&path).unwrap(), original_config).unwrap();
    fs::write(
        &path,
        build_codex_agent_config(
            Some(std::str::from_utf8(original_config).unwrap()),
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "gpt-old",
        )
        .unwrap(),
    )
    .unwrap();
    fs::write(&catalog_path, original_catalog).unwrap();
    let mut record = build_legacy_agent_record(AgentClient::Codex, &home, 8317, "gpt-old")
        .unwrap()
        .unwrap();
    record.version = LEGACY_AGENT_MODIFICATION_STATE_VERSION;
    assert_eq!(record.files.len(), 1);
    write_agent_state(
        &agent_state_path(std::slice::from_ref(&path)).unwrap(),
        &record,
    )
    .unwrap();

    let available_models = test_agent_models(&["gpt-new"]);
    let codex_models = test_codex_models(&["gpt-new"]);
    update_agent_modification(
        AgentClient::Codex,
        &home,
        8317,
        "gpt-new",
        &available_models,
        Some(&codex_models),
    )
    .unwrap();
    let upgraded = load_agent_record(AgentClient::Codex, std::slice::from_ref(&path))
        .unwrap()
        .unwrap();
    assert_eq!(upgraded.version, AGENT_MODIFICATION_STATE_VERSION);
    assert_eq!(upgraded.files.len(), 3);
    assert_eq!(
        fs::read(agent_backup_path(&path).unwrap()).unwrap(),
        original_config
    );
    assert_eq!(
        fs::read(agent_backup_path(&catalog_path).unwrap()).unwrap(),
        original_catalog
    );
    fs::write(&catalog_path, b"{\"models\":[]}\n").unwrap();
    let auth_path = path.with_file_name("auth.json");
    assert!(auth_path.is_file());

    disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original_config);
    assert_eq!(fs::read(&catalog_path).unwrap(), original_catalog);
    assert!(!auth_path.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn interrupted_agent_state_is_reported_as_recovery() {
    let home = agent_test_home("recovery-state");
    let path = home.join(".codex/config.toml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "approval_policy = \"never\"\n").unwrap();
    let available_models = test_agent_models(&["gpt-test"]);
    let codex_models = test_codex_models(&["gpt-test"]);
    enable_agent_modification(
        AgentClient::Codex,
        &home,
        8317,
        "gpt-test",
        &available_models,
        Some(&codex_models),
    )
    .unwrap();

    let state_path = agent_state_path(std::slice::from_ref(&path)).unwrap();
    let mut record = load_agent_record(AgentClient::Codex, &[path])
        .unwrap()
        .unwrap();
    record.phase = AGENT_PHASE_APPLYING.to_string();
    write_agent_state(&state_path, &record).unwrap();
    let inspection =
        inspect_agent_modification(AgentClient::Codex, &home, 8317, true, Some("gpt-test"));
    assert!(inspection.enabled);
    assert_eq!(inspection.state, "recovery");

    disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_backup_protocol_restores_multiple_files_and_removes_created_files() {
    let home = agent_test_home("multi-file");
    let first = home.join("first.json");
    let second = home.join("second.json");
    fs::write(&first, b"{\"original\":true}\n").unwrap();
    let updates = vec![
        AgentFileUpdate {
            path: first.clone(),
            after: "{\"managed\":1}\n".to_string(),
        },
        AgentFileUpdate {
            path: second.clone(),
            after: "{\"managed\":2}\n".to_string(),
        },
    ];
    let record = prepare_agent_record(
        AgentClient::ClaudeDesktop,
        &[first.clone(), second.clone()],
        "claude-test",
        &updates,
    )
    .unwrap();

    apply_agent_updates(AgentClient::ClaudeDesktop, &updates).unwrap();
    assert!(first.is_file());
    assert!(second.is_file());
    restore_agent_record_files(AgentClient::ClaudeDesktop, &record).unwrap();
    assert_eq!(fs::read_to_string(&first).unwrap(), "{\"original\":true}\n");
    assert!(!second.exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn interrupted_multi_file_apply_can_restore_without_false_conflict() {
    let home = agent_test_home("partial-recovery");
    let first = home.join("first.json");
    let second = home.join("second.json");
    fs::write(&first, b"{\"original\":1}\n").unwrap();
    fs::write(&second, b"{\"original\":2}\n").unwrap();
    let updates = vec![
        AgentFileUpdate {
            path: first.clone(),
            after: "{\"managed\":1}\n".to_string(),
        },
        AgentFileUpdate {
            path: second.clone(),
            after: "{\"managed\":2}\n".to_string(),
        },
    ];
    let record = prepare_agent_record(
        AgentClient::ClaudeDesktop,
        &[first.clone(), second.clone()],
        "claude-test",
        &updates,
    )
    .unwrap();

    write_bytes_atomically(&first, updates[0].after.as_bytes()).unwrap();
    assert_eq!(
        record_conflict_files(&record).unwrap(),
        vec![path_to_string(&second)]
    );
    assert!(record_restore_conflict_files(&record).unwrap().is_empty());

    fs::write(&second, b"{\"external\":true}\n").unwrap();
    assert_eq!(
        record_restore_conflict_files(&record).unwrap(),
        vec![path_to_string(&second)]
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn partial_agent_write_failure_rolls_back_previous_files() {
    let home = agent_test_home("partial-write");
    let first = home.join("first.txt");
    let blocked_parent = home.join("blocked");
    fs::write(&first, b"original\n").unwrap();
    fs::write(&blocked_parent, b"not a directory").unwrap();
    let updates = vec![
        AgentFileUpdate {
            path: first.clone(),
            after: "changed\n".to_string(),
        },
        AgentFileUpdate {
            path: blocked_parent.join("second.txt"),
            after: "never written\n".to_string(),
        },
    ];

    assert!(apply_agent_updates(AgentClient::ClaudeDesktop, &updates).is_err());
    assert_eq!(fs::read_to_string(&first).unwrap(), "original\n");
    fs::remove_dir_all(home).unwrap();
}
