use super::*;

#[test]
fn claude_code_compaction_percentage_is_written_and_round_trips() {
    let directory = super::support::agent_test_home("compact-percentage");
    let path = directory.join("settings.json");
    let mut mappings = ClaudeDesktopModelMappings::all("route-model");
    mappings.auto_compact_pct = 75;
    let rendered = build_claude_agent_config(
        None,
        "http://127.0.0.1:8317",
        "test-key",
        "route-model",
        &super::support::test_agent_models(&["route-model"]),
        Some(&mappings),
    )
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    assert_eq!(value["env"][CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV], "75");
    fs::write(&path, rendered).unwrap();
    assert_eq!(
        inspect_claude_code_model_mappings(&path)
            .unwrap()
            .unwrap()
            .auto_compact_pct,
        75
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn claude_code_context_window_can_be_reduced_after_disabling_1m() {
    let models = super::support::test_agent_models(&["route-model"]);
    let mut mappings = ClaudeDesktopModelMappings::all("route-model");
    mappings.opus_1m = true;
    mappings.max_context_tokens = 1_000_000;
    mappings.startup_model = Some("opus".into());
    let extended = build_claude_agent_config(
        None,
        "http://127.0.0.1:8317",
        "test-key",
        "route-model",
        &models,
        Some(&mappings),
    )
    .unwrap();
    mappings.opus_1m = false;
    mappings.max_context_tokens = 200_000;
    let reduced = build_claude_agent_config(
        Some(&extended),
        "http://127.0.0.1:8317",
        "test-key",
        "route-model",
        &models,
        Some(&mappings),
    )
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&reduced).unwrap();
    assert_eq!(
        value["modelSettings"]["route-model"]["autoCompactWindow"],
        200_000
    );
    assert!(value["modelSettings"].get("opus").is_none());
}

#[test]
fn claude_code_restore_restores_compaction_settings_and_preserves_unrelated_model_metadata() {
    let original = r#"{"autoCompactWindow":150000,"autoCompactEnabled":false,"modelSettings":{"route-model":{"autoCompactWindow":125000,"effortLevel":"low"},"user-model":{"autoCompactWindow":120000}}}"#;
    let generated = build_claude_agent_config(
        Some(original),
        "http://127.0.0.1:8317",
        "test-key",
        "route-model",
        &super::support::test_agent_models(&["route-model"]),
        None,
    )
    .unwrap();
    let restored = build_restored_claude_code_config(&generated, Some(original))
        .unwrap()
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&restored).unwrap();
    assert_eq!(
        value,
        serde_json::from_str::<serde_json::Value>(original).unwrap()
    );
}

#[test]
fn claude_code_clear_removes_explicit_role_selection_and_preserves_user_model_metadata() {
    let directory = super::support::agent_test_home("clear-explicit-role");
    let path = directory.join("settings.json");
    let models = super::support::test_agent_models(&["route-model"]);
    let mut mappings = ClaudeDesktopModelMappings::all("route-model");
    mappings.startup_model = Some("opus".into());
    mappings.subagent_model = Some(String::new());
    let rendered = build_claude_agent_config(
        Some(r#"{"modelSettings":{"route-model":{"effortLevel":"low"},"user-model":{"autoCompactWindow":150000}}}"#),
        "http://127.0.0.1:8317", "test-key", "route-model", &models, Some(&mappings)).unwrap();
    fs::write(&path, rendered).unwrap();
    let cleared = prepare_claude_code_managed_removal(&[path], "http://127.0.0.1:8317").unwrap();
    let value: serde_json::Value = serde_json::from_slice(cleared[0].1.as_ref().unwrap()).unwrap();
    assert!(value.get("model").is_none());
    assert_eq!(
        value["modelSettings"]["route-model"],
        serde_json::json!({"effortLevel":"low"})
    );
    assert_eq!(
        value["modelSettings"]["user-model"],
        serde_json::json!({"autoCompactWindow":150000})
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn claude_code_clears_old_windows_after_route_changes_and_custom_startup_on_close() {
    let directory = super::support::agent_test_home("clear-changed-routes");
    let path = directory.join("settings.json");
    let models = super::support::test_agent_models(&["route-a", "route-b"]);
    let first = build_claude_agent_config(
        None,
        "http://127.0.0.1:8317",
        "test-key",
        "route-a",
        &models,
        None,
    )
    .unwrap();
    let mut mappings = ClaudeDesktopModelMappings::all("route-b");
    mappings.startup_model = Some("custom-startup".into());
    mappings.subagent_model = Some(String::new());
    let updated = build_claude_agent_config(
        Some(&first),
        "http://127.0.0.1:8317",
        "test-key",
        "route-b",
        &models,
        Some(&mappings),
    )
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&updated).unwrap();
    assert!(value["modelSettings"].get("route-a").is_none());
    fs::write(&path, updated).unwrap();
    let cleared =
        prepare_claude_code_managed_removal(&[path.clone()], "http://127.0.0.1:8317").unwrap();
    assert_eq!(cleared, vec![(path, None)]);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn claude_code_clear_preserves_later_user_selection_and_its_context_window() {
    let directory = super::support::agent_test_home("clear-user-model-edit");
    let path = directory.join("settings.json");
    let mut mappings = ClaudeDesktopModelMappings::all("route-model");
    mappings.startup_model = Some("opus".into());
    let rendered = build_claude_agent_config(
        None,
        "http://127.0.0.1:8317",
        "test-key",
        "route-model",
        &super::support::test_agent_models(&["route-model"]),
        Some(&mappings),
    )
    .unwrap();
    let mut edited: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    edited["model"] = serde_json::json!("sonnet");
    edited["modelSettings"]["sonnet"] = serde_json::json!({"autoCompactWindow":150000});
    fs::write(&path, edited.to_string()).unwrap();
    let cleared = prepare_claude_code_managed_removal(&[path], "http://127.0.0.1:8317").unwrap();
    let value: serde_json::Value = serde_json::from_slice(cleared[0].1.as_ref().unwrap()).unwrap();
    assert_eq!(value["model"], "sonnet");
    assert_eq!(
        value["modelSettings"]["sonnet"]["autoCompactWindow"],
        150_000
    );
    fs::remove_dir_all(directory).unwrap();
}

// The Node live runner provides only model IDs and a loopback observer URL.
// Real credentials stay in that runner's memory and never enter these fixtures.
#[test]
#[ignore = "invoked by tests/claude-code-live.cjs with isolated fixture paths"]
fn export_claude_code_live_configurations() {
    let request_path = std::env::var("EZCPA_CLAUDE_LIVE_REQUEST").expect("live request path");
    let output_path = std::env::var("EZCPA_CLAUDE_LIVE_OUTPUT").expect("live output path");
    let request: serde_json::Value =
        serde_json::from_slice(&fs::read(request_path).unwrap()).unwrap();
    let models: Vec<AgentModelOption> = serde_json::from_value(request["models"].clone()).unwrap();
    let base_url = request["baseUrl"].as_str().unwrap();
    let mut outputs = Vec::new();
    let mut previous_settings = std::collections::BTreeMap::<String, String>::new();
    for case in request["cases"].as_array().unwrap() {
        let mappings: ClaudeDesktopModelMappings =
            serde_json::from_value(case["mappings"].clone()).unwrap();
        let resolved = resolve_claude_code_model_mappings(
            AgentClient::ClaudeCode,
            &models,
            &mappings.sonnet,
            Some(mappings.clone()),
        )
        .unwrap()
        .unwrap();
        let existing = case
            .get("existingFrom")
            .and_then(serde_json::Value::as_str)
            .and_then(|id| previous_settings.get(id).cloned())
            .or_else(|| {
                case.get("existing")
                    .filter(|value| !value.is_null())
                    .map(|value| value.to_string())
            });
        let rendered = build_claude_agent_config(
            existing.as_deref(),
            base_url,
            "isolated-live-test",
            &resolved.sonnet,
            &models,
            Some(&resolved),
        )
        .unwrap();
        let settings: serde_json::Value = serde_json::from_str(&rendered).unwrap();
        previous_settings.insert(case["id"].as_str().unwrap().to_string(), rendered);
        outputs.push(serde_json::json!({ "id": case["id"], "settings": settings }));
    }
    fs::write(output_path, serde_json::to_vec_pretty(&outputs).unwrap()).unwrap();
}
