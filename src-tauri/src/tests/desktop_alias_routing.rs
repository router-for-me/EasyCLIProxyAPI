use super::support::*;
use super::*;

fn json(content: &str) -> serde_json::Value {
    serde_json::to_value(serde_norway::from_str::<serde_norway::Value>(content).unwrap()).unwrap()
}

fn custom_mappings(entries: &[(&str, &str)]) -> ClaudeDesktopModelMappings {
    ClaudeDesktopModelMappings {
        desktop_models: Some(entries.iter().map(|(model, alias)| ClaudeDesktopModelMapping {
            model: (*model).into(), alias: (*alias).into(), context_1m: false,
        }).collect()),
        ..ClaudeDesktopModelMappings::all("")
    }
}

#[test]
fn desktop_aliases_reject_other_model_families() {
    for alias in ["claude-grok-4.6", "claude-opus-gpt-5", "claude-gemini",
        "claude-deepseek", "claude-opus-phi4", "claude-opus-k2.5", "claude-m2.1",
        "claude-ling", "claude-unic", "claude-ds-test"] {
        assert!(!valid_claude_desktop_alias(alias), "{alias}");
        assert!(!is_claude_native_model_id(alias), "{alias}");
        let mappings = custom_mappings(&[("gpt-one", alias)]);
        assert!(validate_claude_desktop_entries(mappings.desktop_models.as_ref().unwrap()).is_err());
    }
    for alias in ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5",
        "claude-fable-5-1", "claude-opus-personal", "claude-linguist",
        "claude-unicorn", "claude-ranking2.1"] {
        assert!(valid_claude_desktop_alias(alias), "{alias}");
    }
}

#[test]
fn desktop_replacing_a_previously_allowed_alias_removes_its_old_route() {
    let input = "codex-api-key:\n  - models:\n      - name: gpt-one\n      - name: gpt-one\n        alias: claude-grok-4.6\n        display-name: EasyCLIProxyAPI managed Claude Desktop mapping\n";
    let mappings = custom_mappings(&[("gpt-one", "claude-opus-personal")]);
    let after = json(&ensure_claude_desktop_model_aliases_in_yaml(input, &mappings, &[]).unwrap());
    let models = after["codex-api-key"][0]["models"].as_array().unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[1]["alias"], "claude-opus-personal");
}

#[test]
fn desktop_unchanged_alias_sync_preserves_legacy_yaml_verbatim() {
    let input = "# Existing core configuration\nrouting:\n  strategy: round-robin\n# Retention duration\n\n  session-affinity-ttl: ''\n# Inherit parent sessions\n\n  session-affinity-subagents: true\ncodex-api-key:\n  - api-key: preserved-key\n    models:\n      - name: model-a\n      - name: model-a\n        alias: claude-opus-custom\n        display-name: EasyCLIProxyAPI managed Claude Desktop mapping\n";
    for mappings in [
        custom_mappings(&[("model-a", "claude-opus-custom")]),
        custom_mappings(&[("claude-opus-custom", "")]),
        ClaudeDesktopModelMappings::all("claude-opus-custom"),
    ] {
        let updated = ensure_claude_desktop_model_aliases_in_yaml(input, &mappings, &[]).unwrap();
        assert_eq!(updated, input);
    }
}

#[test]
fn desktop_empty_alias_uses_original_id_without_creating_a_mapping() {
    let mappings = custom_mappings(&[(" claude-sonnet-custom-7 ", "  ")]);
    let model = resolve_agent_configuration_model(
        AgentClient::ClaudeDesktop, &[], "", Some(&mappings),
    ).unwrap();
    assert_eq!(model, "claude-sonnet-custom-7");
    let mappings = resolve_claude_desktop_model_mappings(
        AgentClient::ClaudeDesktop, &[], &model, Some(mappings),
    ).unwrap().unwrap();
    assert_eq!(mappings.sonnet, model);
    assert_eq!(mappings.desktop_models.as_ref().unwrap()[0].model, model);
    assert!(mappings.desktop_models.as_ref().unwrap()[0].alias.is_empty());
    let profile: serde_json::Value = serde_json::from_str(&build_claude_desktop_profile(
        None, "http://localhost:8317", "key", &model, &[], Some(&mappings),
    ).unwrap()).unwrap();
    assert_eq!(profile["inferenceModels"][0]["name"], model);
    assert_eq!(profile["inferenceModels"][0]["labelOverride"], model);
    let input = "codex-api-key:\n  - models: [{name: gpt-one}]\n";
    let updated = ensure_claude_desktop_model_aliases_in_yaml(input, &mappings, &[]).unwrap();
    assert_eq!(json(&updated), json(input));
    assert!(resolve_agent_configuration_model(
        AgentClient::ClaudeCode, &[], &model, Some(&mappings),
    ).is_err());
}

#[test]
fn desktop_legacy_alias_only_entry_resolves_to_original_with_empty_alias() {
    let mappings = custom_mappings(&[("", "claude-sonnet-custom-7")]);
    let model = resolve_agent_configuration_model(
        AgentClient::ClaudeDesktop, &[], "", Some(&mappings),
    ).unwrap();
    let resolved = resolve_claude_desktop_model_mappings(
        AgentClient::ClaudeDesktop, &[], &model, Some(mappings),
    ).unwrap().unwrap();
    let entry = &resolved.desktop_models.as_ref().unwrap()[0];
    assert_eq!(entry.model, "claude-sonnet-custom-7");
    assert!(entry.alias.is_empty());
}

#[test]
fn desktop_clearing_alias_removes_the_old_mapping_and_keeps_original_and_other_rows() {
    let input = "codex-api-key:\n  - models: [{name: gpt-one}, {name: gpt-two}, {name: claude-opus-4-6}]\n";
    let models = test_agent_models(&["gpt-one", "gpt-two", "claude-opus-4-6"]);
    let mapped = custom_mappings(&[("gpt-one", "claude-sonnet-4-6"), ("gpt-two", "claude-haiku-4-5")]);
    let before = ensure_claude_desktop_model_aliases_in_yaml(input, &mapped, &models).unwrap();
    let direct = custom_mappings(&[("gpt-one", ""), ("gpt-two", "claude-haiku-4-5"), ("claude-opus-4-6", "")]);
    let updated = ensure_claude_desktop_model_aliases_in_yaml(&before, &direct, &models).unwrap();
    let entries = json(&updated)["codex-api-key"][0]["models"].as_array().unwrap().clone();
    assert_eq!(entries.len(), 4);
    assert!(!entries.iter().any(|entry| entry["alias"] == "claude-sonnet-4-6"));
    assert!(entries.iter().any(|entry| entry["name"] == "gpt-one" && entry.get("alias").is_none()));
    assert!(entries.iter().any(|entry| entry["name"] == "gpt-two" && entry["alias"] == "claude-haiku-4-5"));
    assert!(entries.iter().any(|entry| entry["name"] == "claude-opus-4-6"));
    let profile: serde_json::Value = serde_json::from_str(&build_claude_desktop_profile(
        None, "http://localhost:8317", "key", "gpt-one", &models, Some(&direct),
    ).unwrap()).unwrap();
    assert_eq!(profile["inferenceModels"][0]["name"], "gpt-one");
    assert_eq!(profile["inferenceModels"][0]["labelOverride"], "gpt-one");
    assert_eq!(profile["inferenceModels"][1]["name"], "claude-haiku-4-5");
    assert_eq!(profile["inferenceModels"][2]["name"], "claude-opus-4-6");
}

#[test]
fn desktop_custom_list_routes_every_selected_model_and_displays_original_names() {
    let mappings = custom_mappings(&[
        ("gpt-one", "claude-opus-4-6"), ("gpt-two", "claude-sonnet-4-6"),
        ("gpt-one", "claude-haiku-4-5"), ("gpt-two", "claude-sonnet-4-5"),
    ]);
    let models = test_agent_models(&["gpt-one", "gpt-two"]);
    let profile: serde_json::Value = serde_json::from_str(&build_claude_desktop_profile(
        None, "http://localhost:8317", "test-key", "gpt-one", &models, Some(&mappings),
    ).unwrap()).unwrap();
    let entries = profile["inferenceModels"].as_array().unwrap();
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[0]["name"], "claude-opus-4-6");
    assert_eq!(entries[0]["labelOverride"], "gpt-one");
    assert_eq!(entries[1]["isFamilyDefault"], true);
    assert_eq!(entries[3]["isFamilyDefault"], false);
    let input = "codex-api-key:\n  - models: [{name: gpt-one}, {name: gpt-two}]\n";
    let routed = ensure_claude_desktop_model_aliases_in_yaml(input, &mappings, &models).unwrap();
    let after = json(&routed);
    assert_eq!(after["codex-api-key"][0]["models"].as_array().unwrap().len(), 6);
    for entry in mappings.desktop_models.unwrap() {
        assert!(after["codex-api-key"][0]["models"].as_array().unwrap().iter()
            .any(|model| model["alias"] == entry.alias && model["name"] == entry.model));
    }
}

#[test]
fn desktop_custom_alias_edits_remove_old_managed_routes_and_preserve_user_routes() {
    let input = "codex-api-key:\n  - models: [{name: gpt-one}, {name: gpt-two}, {name: gpt-one, alias: claude-user-model}]\n";
    let models = test_agent_models(&["gpt-one", "gpt-two", "claude-user-model"]);
    let first = ensure_claude_desktop_model_aliases_in_yaml(input,
        &custom_mappings(&[("gpt-one", "claude-opus-4-6"), ("gpt-two", "claude-sonnet-4-6")]), &models).unwrap();
    let second = ensure_claude_desktop_model_aliases_in_yaml(&first,
        &custom_mappings(&[("gpt-two", "claude-haiku-4-5")]), &models).unwrap();
    let entries = json(&second)["codex-api-key"][0]["models"].as_array().unwrap().clone();
    assert_eq!(entries.len(), 4);
    assert!(entries.iter().any(|m| m["alias"] == "claude-user-model"));
    assert!(!entries.iter().any(|m| m["alias"] == "claude-opus-4-6" || m["alias"] == "claude-sonnet-4-6"));
    assert!(ensure_claude_desktop_model_aliases_in_yaml(input,
        &custom_mappings(&[("gpt-two", "claude-user-model")]), &models).unwrap_err().contains("已被其他模型使用"));
    assert!(ensure_claude_desktop_model_aliases_in_yaml(input,
        &custom_mappings(&[("gpt-two", "claude-native-model")]),
        &test_agent_models(&["gpt-two", "claude-native-model"])).is_err());
    let duplicate = format!("{first}openai-compatibility:\n  - models: [{{name: claude-opus-4-6}}]\n");
    assert!(ensure_claude_desktop_model_aliases_in_yaml(&duplicate,
        &custom_mappings(&[("gpt-two", "claude-opus-4-6")]), &models).is_err());
}

#[test]
fn desktop_custom_mapping_validates_aliases_and_accepts_one_model() {
    let models = test_agent_models(&["gpt-one"]);
    let resolved = resolve_claude_desktop_model_mappings(AgentClient::ClaudeDesktop, &models, "gpt-one",
        Some(custom_mappings(&[("gpt-one", " claude-sonnet-4-6 ")]))).unwrap().unwrap();
    assert_eq!(resolved.sonnet, "gpt-one");
    assert_eq!(resolved.desktop_models.as_ref().unwrap()[0].alias, "claude-sonnet-4-6");
    for entries in [vec![], vec![("", "")], vec![("gpt-one", "gpt-alias")], vec![("two words", "claude-sonnet-4-6")],
        vec![("claude-sonnet-4-6", ""), ("gpt-one", "claude-sonnet-4-6")],
        vec![("gpt-one", "claude-sonnet-4-6"), ("gpt-one", "claude-sonnet-4-6")]] {
        assert!(resolve_claude_desktop_model_mappings(AgentClient::ClaudeDesktop, &models, "gpt-one",
            Some(custom_mappings(&entries))).is_err());
    }
}

#[test]
fn desktop_manual_source_can_create_an_alias_when_missing_from_the_loaded_model_list() {
    let mappings = custom_mappings(&[(" manual-model ", "claude-opus-5")]);
    let model = resolve_agent_configuration_model(
        AgentClient::ClaudeDesktop, &[], "", Some(&mappings),
    ).unwrap();
    assert_eq!(model, "manual-model");
    let mappings = resolve_claude_desktop_model_mappings(
        AgentClient::ClaudeDesktop, &[], &model, Some(mappings),
    ).unwrap().unwrap();
    let input = "openai-compatibility:\n  - name: manual-provider\n    models: [{name: manual-model}]\n";
    let routed = json(&ensure_claude_desktop_model_aliases_in_yaml(input, &mappings, &[]).unwrap());
    assert!(routed["openai-compatibility"][0]["models"].as_array().unwrap().iter()
        .any(|entry| entry["name"] == model && entry["alias"] == "claude-opus-5"));
    assert!(ensure_claude_desktop_model_aliases_in_yaml("{}", &mappings, &[])
        .unwrap_err().contains("无法确定模型 manual-model"));
}

#[test]
fn desktop_same_original_and_alias_is_normalized_to_no_alias() {
    let mappings = custom_mappings(&[("anthropic/claude-opus-5", " ANTHROPIC/CLAUDE-OPUS-5 ")]);
    let resolved = resolve_claude_desktop_model_mappings(
        AgentClient::ClaudeDesktop, &[], "", Some(mappings),
    ).unwrap().unwrap();
    let entry = &resolved.desktop_models.as_ref().unwrap()[0];
    assert_eq!(entry.model, "anthropic/claude-opus-5");
    assert!(entry.alias.is_empty());
}

#[test]
fn desktop_custom_aliases_preserve_source_alias_options_and_context() {
    let input = "codex-api-key:\n  - models: [{name: gpt-one, alias: gpt-high, reasoning-effort: high}]\n";
    let mut models = test_agent_models(&["gpt-high"]);
    models[0].is_alias = true;
    models[0].alias = Some("gpt-one".into());
    let mut mappings = custom_mappings(&[("gpt-high", "claude-opus-4-6")]);
    mappings.desktop_models.as_mut().unwrap()[0].context_1m = true;
    let after = json(&ensure_claude_desktop_model_aliases_in_yaml(input, &mappings, &models).unwrap());
    let entry = &after["codex-api-key"][0]["models"][1];
    assert_eq!(entry["name"], "gpt-one");
    assert_eq!(entry["reasoning-effort"], "high");
    let profile: serde_json::Value = serde_json::from_str(&build_claude_desktop_profile(
        None, "http://localhost:8317", "key", "gpt-high", &models, Some(&mappings)).unwrap()).unwrap();
    assert_eq!(profile["inferenceModels"][0]["name"], "claude-opus-4-6");
    assert_eq!(profile["inferenceModels"][0]["labelOverride"], "gpt-high");
    assert_eq!(profile["inferenceModels"][0]["supports1m"], true);
}

#[test]
fn desktop_routes_preserve_api_access_when_switching_models() {
    let input = "codex-api-key:\n  - api-key: codex-test-key\n    base-url: https://codex.example.test\n    proxy-url: socks5://127.0.0.1:1080\n    models: [{name: model-a}, {name: model-b}]\nopenai-compatibility:\n  - name: other\n    disabled: true\n    api-key-entries: [{api-key: other-test-key}]\n    models: [{name: other-model}]\npayload:\n  override:\n    - models: [{name: other-model}]\n      params: {custom: retained}\n";
    let before = json(input);
    let mut content = input.to_string();
    for selected in ["model-a", "model-b", "model-b"] {
        content = ensure_claude_desktop_model_aliases_in_yaml(
            &content,
            &ClaudeDesktopModelMappings::all(selected),
            &test_agent_models(&["model-a", "model-b"]),
        )
        .unwrap();
        let mut after = json(&content);
        let models = after["codex-api-key"][0]["models"].as_array_mut().unwrap();
        assert_eq!(models.len(), 5);
        for route in [
            CLAUDE_DESKTOP_OPUS_MODEL_ID,
            CLAUDE_DESKTOP_SONNET_MODEL_ID,
            CLAUDE_DESKTOP_HAIKU_MODEL_ID,
        ] {
            assert!(models
                .iter()
                .any(|model| model["alias"] == route && model["name"] == selected));
        }
        models.retain(|model| model.get("display-name").is_none());
        assert_eq!(after, before);
    }
}

#[test]
fn desktop_route_name_collision_keeps_the_existing_real_model() {
    let input = format!(
        "codex-api-key:\n  - models: [{{name: {route}}}]\n",
        route = CLAUDE_DESKTOP_OPUS_MODEL_ID,
    );
    let models = test_agent_models(&[
        CLAUDE_DESKTOP_OPUS_MODEL_ID,
        CLAUDE_DESKTOP_SONNET_MODEL_ID,
        CLAUDE_DESKTOP_HAIKU_MODEL_ID,
    ]);
    let rendered = ensure_claude_desktop_model_aliases_in_yaml(
        &input,
        &ClaudeDesktopModelMappings {
            opus: CLAUDE_DESKTOP_OPUS_MODEL_ID.to_string(),
            sonnet: CLAUDE_DESKTOP_SONNET_MODEL_ID.to_string(),
            haiku: CLAUDE_DESKTOP_HAIKU_MODEL_ID.to_string(),
            ..ClaudeDesktopModelMappings::all("")
        },
        &models,
    )
    .unwrap();
    let after = json(&rendered);
    let entries = after["codex-api-key"][0]["models"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["name"], CLAUDE_DESKTOP_OPUS_MODEL_ID);
    assert!(entries[0].get("alias").is_none());
}

#[test]
fn desktop_route_name_collision_keeps_existing_legacy_claude_model() {
    let input = format!(
        "codex-api-key:\n  - models: [{{name: {legacy}}}]\n",
        legacy = LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0],
    );
    let models = test_agent_models(&[LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0]]);
    let rendered = ensure_claude_desktop_model_aliases_in_yaml(
        &input,
        &ClaudeDesktopModelMappings::all(LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0]),
        &models,
    )
    .unwrap();
    let after = json(&rendered);
    let entries = after["codex-api-key"][0]["models"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["name"], LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0]);
    assert!(entries[0].get("alias").is_none());
}

#[test]
fn desktop_routes_skip_excluded_sources_and_aliases() {
    let mappings = custom_mappings(&[("model-a", "claude-opus-5")]);
    for excluded in ["*", "model-a", "model-*", "claude-opus-5", " CLAUDE-* ", "*-opus-*", "claude-*-5"] {
        let input = format!("codex-api-key:\n  - api-key: excluded-key\n    excluded-models: ['{excluded}']\n    models: [{{name: model-a}}]\n  - api-key: active-key\n    models: [{{name: model-a, context-length: 123456}}]\n");
        let updated = ensure_claude_desktop_model_aliases_in_yaml(&input, &mappings, &[]).unwrap();
        let after = json(&updated);
        assert_eq!(after["codex-api-key"][0], json(&input)["codex-api-key"][0], "{excluded}");
        assert_eq!(after["codex-api-key"][1]["models"][1]["alias"], "claude-opus-5", "{excluded}");
        assert_eq!(after["codex-api-key"][1]["models"][1]["context-length"], 123456);
    }
}

#[test]
fn desktop_routes_repair_managed_aliases_on_excluded_providers() {
    for mappings in [
        custom_mappings(&[("model-a", "claude-opus-5")]),
        ClaudeDesktopModelMappings::all("model-a"),
    ] {
        let initial = "codex-api-key:\n  - api-key: old-key\n    models: [{name: model-a}]\n";
        let configured = ensure_claude_desktop_model_aliases_in_yaml(initial, &mappings, &[]).unwrap();
        for excluded in ["*", "claude-*"] {
            let blocked = configured.replacen("api-key: old-key", &format!("api-key: old-key\n    excluded-models: ['{excluded}']"), 1);
            assert!(ensure_claude_desktop_model_aliases_in_yaml(&blocked, &mappings, &[]).is_err());
            let input = format!("{blocked}  - api-key: active-key\n    models: [{{name: model-a}}]\n");
            let repaired = ensure_claude_desktop_model_aliases_in_yaml(&input, &mappings, &[]).unwrap();
            let after = json(&repaired);
            assert_eq!(after["codex-api-key"][0]["excluded-models"], serde_json::json!([excluded]));
            assert_eq!(after["codex-api-key"][0]["models"], serde_json::json!([{"name": "model-a"}]));
            let expected_count = if mappings.desktop_models.is_some() { 2 } else { 4 };
            assert_eq!(after["codex-api-key"][1]["models"].as_array().unwrap().len(), expected_count);
            assert_eq!(ensure_claude_desktop_model_aliases_in_yaml(&repaired, &mappings, &[]).unwrap(), repaired);
        }
    }
}

#[test]
fn desktop_routes_move_from_disabled_provider_to_enabled_source() {
    let models = test_agent_models(&["grok-4.6"]);
    let mappings = ClaudeDesktopModelMappings::all("grok-4.6");
    let initial =
        "openai-compatibility:\n  - name: disabled-provider\n    models: [{name: grok-4.6}]\n";
    let configured =
        ensure_claude_desktop_model_aliases_in_yaml(initial, &mappings, &models).unwrap();
    let disabled = configured.replacen(
        "name: disabled-provider",
        "name: disabled-provider\n    disabled: true",
        1,
    );
    let input = format!("{disabled}codex-api-key:\n  - models: [{{name: grok-4.6}}]\n");
    let restored = ensure_claude_desktop_model_aliases_in_yaml(&input, &mappings, &models).unwrap();
    let after = json(&restored);
    assert_eq!(after["openai-compatibility"][0]["disabled"], true);
    assert_eq!(
        after["openai-compatibility"][0]["models"],
        serde_json::json!([{"name": "grok-4.6"}])
    );
    let active_models = after["codex-api-key"][0]["models"].as_array().unwrap();
    for route in [
        CLAUDE_DESKTOP_OPUS_MODEL_ID,
        CLAUDE_DESKTOP_SONNET_MODEL_ID,
        CLAUDE_DESKTOP_HAIKU_MODEL_ID,
    ] {
        assert!(active_models
            .iter()
            .any(|model| model["name"] == "grok-4.6" && model["alias"] == route));
    }
    let repeated =
        ensure_claude_desktop_model_aliases_in_yaml(&restored, &mappings, &models).unwrap();
    assert_eq!(json(&repeated), after);
}

#[test]
fn desktop_routes_skip_disabled_sources_during_creation() {
    let input = "openai-compatibility:\n  - name: disabled-provider\n    disabled: true\n    models: [{name: model-a}]\n  - name: enabled-provider\n    models: [{name: model-a}]\n";
    let updated = ensure_claude_desktop_model_aliases_in_yaml(
        input,
        &ClaudeDesktopModelMappings::all("model-a"),
        &test_agent_models(&["model-a"]),
    )
    .unwrap();
    let after = json(&updated);
    assert_eq!(
        after["openai-compatibility"][0],
        json(input)["openai-compatibility"][0]
    );
    assert_eq!(
        after["openai-compatibility"][1]["models"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
}

#[test]
fn desktop_routes_reject_sources_available_only_in_disabled_providers() {
    for entry in [
        "{name: model-a}".to_string(),
        format!("{{name: model-a, alias: {CLAUDE_DESKTOP_OPUS_MODEL_ID}}}"),
    ] {
        let input = format!("openai-compatibility:\n  - name: disabled-provider\n    disabled: true\n    models: [{entry}]\n");
        let result = ensure_claude_desktop_model_aliases_in_yaml(
            &input,
            &ClaudeDesktopModelMappings::all("model-a"),
            &test_agent_models(&["model-a"]),
        );
        assert!(result.is_err());
    }
}

#[test]
fn disabled_provider_alias_does_not_mark_an_active_real_model_as_an_alias() {
    for exclusions in ["disabled: true", "excluded-models: ['*']", "excluded-models: ['MODEL-*']"] {
        let input = format!("codex-api-key:\n  - {exclusions}\n    models: [{{name: other-model, alias: model-a}}]\n  - models: [{{name: model-a}}]\n");
        let mut models = test_agent_models(&["model-a"]);
        mark_configured_agent_model_aliases(&mut models, &input).unwrap();
        assert!(!models[0].is_alias, "{exclusions}");
    }
}

#[test]
fn legacy_desktop_alias_only_provider_retains_its_source_during_reconfiguration() {
    let input = format!(
        "codex-api-key:\n  - api-key: preserved-key\n    base-url: https://example.test\n    models:\n      - name: model-a\n        alias: {opus}\n        context-length: 123456\n",
        opus = CLAUDE_DESKTOP_OPUS_MODEL_ID,
    );
    let result = ensure_claude_desktop_model_aliases_in_yaml(
        &input,
        &ClaudeDesktopModelMappings::all("model-a"),
        &test_agent_models(&["model-a"]),
    );
    let updated = result.unwrap();
    let after = json(&updated);
    let mut provider = after["codex-api-key"][0].clone();
    let entries = provider.as_object_mut().unwrap().remove("models").unwrap();
    let mut original_provider = json(&input)["codex-api-key"][0].clone();
    original_provider.as_object_mut().unwrap().remove("models");
    assert_eq!(provider, original_provider);
    for route in [
        CLAUDE_DESKTOP_OPUS_MODEL_ID,
        CLAUDE_DESKTOP_SONNET_MODEL_ID,
        CLAUDE_DESKTOP_HAIKU_MODEL_ID,
    ] {
        let entry = entries
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["alias"] == route)
            .unwrap();
        assert_eq!(entry["name"], "model-a");
        assert_eq!(entry["context-length"], 123456);
    }
    assert_eq!(
        json(
            &ensure_claude_desktop_model_aliases_in_yaml(
                &updated,
                &ClaudeDesktopModelMappings::all("model-a"),
                &test_agent_models(&["model-a"]),
            )
            .unwrap()
        ),
        after,
    );
}

#[test]
fn legacy_desktop_alias_source_is_resolved_before_removing_its_route() {
    let input = format!(
        "codex-api-key:\n  - api-key: preserved-key\n    models: [{{name: model-a, alias: {opus}}}]\n",
        opus = CLAUDE_DESKTOP_OPUS_MODEL_ID,
    );
    let selected = CLAUDE_DESKTOP_OPUS_MODEL_ID;
    let updated = ensure_claude_desktop_model_aliases_in_yaml(
        &input,
        &ClaudeDesktopModelMappings::all(selected),
        &test_agent_models(&[selected]),
    )
    .unwrap();
    let entries = json(&updated)["codex-api-key"][0]["models"]
        .as_array()
        .unwrap()
        .clone();
    assert!(entries.iter().all(|m| m["name"] == "model-a"));
    assert!(entries.iter().any(|m| m["alias"] == selected));
}

#[test]
fn legacy_desktop_oauth_alias_supplies_its_existing_channel_without_model_definitions() {
    for channel in ["codex", "antigravity"] {
        let input = format!(
            "oauth-model-alias:\n  {channel}:\n    - name: old-model\n      alias: {opus}\n      fork: true\n      custom: {{retained: true}}\n",
            opus = CLAUDE_DESKTOP_OPUS_MODEL_ID,
        );
        let updated = ensure_claude_desktop_model_aliases_in_yaml(
            &input,
            &ClaudeDesktopModelMappings::all("old-model"),
            &test_agent_models(&["old-model"]),
        )
        .unwrap();
        let after = json(&updated);
        let entries = after["oauth-model-alias"][channel].as_array().unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().all(|entry| entry["name"] == "old-model"
            && entry["fork"] == true
            && entry["custom"]["retained"] == true));
        if channel == "antigravity" {
            assert!(entries.iter().all(|entry| entry["force-mapping"] == true));
        }
    }
}

#[test]
fn legacy_desktop_roles_resolve_from_the_same_original_configuration() {
    let input = format!(
        "codex-api-key:\n  - models: [{{name: old-model, alias: {opus}}}, {{name: new-model}}]\n",
        opus = CLAUDE_DESKTOP_OPUS_MODEL_ID,
    );
    let updated = ensure_claude_desktop_model_aliases_in_yaml(
        &input,
        &ClaudeDesktopModelMappings {
            sonnet: "old-model".into(),
            ..ClaudeDesktopModelMappings::all("new-model")
        },
        &test_agent_models(&["old-model", "new-model"]),
    )
    .unwrap();
    let after = json(&updated);
    let entries = after["codex-api-key"][0]["models"].as_array().unwrap();
    for (alias, source) in [
        (CLAUDE_DESKTOP_OPUS_MODEL_ID, "new-model"),
        (CLAUDE_DESKTOP_SONNET_MODEL_ID, "old-model"),
        (CLAUDE_DESKTOP_HAIKU_MODEL_ID, "new-model"),
    ] {
        assert!(entries
            .iter()
            .any(|entry| entry["alias"] == alias && entry["name"] == source));
    }
}

#[test]
fn legacy_desktop_upstream_fallback_does_not_shadow_an_exact_oauth_alias() {
    let input = "codex-api-key:\n  - models: [{name: chosen-model, alias: unrelated-alias}]\noauth-model-alias:\n  codex:\n    - name: actual-upstream\n      alias: chosen-model\n      fork: true\n";
    let updated = ensure_claude_desktop_model_aliases_in_yaml(
        input,
        &ClaudeDesktopModelMappings::all("chosen-model"),
        &test_agent_models(&["chosen-model"]),
    )
    .unwrap();
    let after = json(&updated);
    assert_eq!(after["codex-api-key"], json(input)["codex-api-key"]);
    let entries = after["oauth-model-alias"]["codex"].as_array().unwrap();
    assert_eq!(entries.len(), 4);
    assert!(entries
        .iter()
        .all(|entry| entry["name"] == "actual-upstream"));
}
