use super::support::*;
use super::*;

fn json(content: &str) -> serde_json::Value {
    serde_json::to_value(serde_norway::from_str::<serde_norway::Value>(content).unwrap()).unwrap()
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
    let input = "openai-compatibility:\n  - name: disabled-provider\n    disabled: true\n    models: [{name: other-model, alias: model-a}]\ncodex-api-key:\n  - models: [{name: model-a}]\n";
    let mut models = test_agent_models(&["model-a"]);
    mark_configured_agent_model_aliases(&mut models, input).unwrap();
    assert!(!models[0].is_alias);
}

#[test]
fn legacy_desktop_alias_only_provider_retains_its_source_during_reconfiguration() {
    let input = format!(
        "codex-api-key:\n  - api-key: preserved-key\n    base-url: https://example.test\n    models:\n      - name: model-a\n        alias: {opus}\n        context-length: 123456\n",
        opus = CLAUDE_DESKTOP_OPUS_MODEL_ID,
    );
    // Older configurations can retain only the aliased entry for the upstream model.
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
    // Legacy callers and restore previews may have model IDs without is_alias metadata.
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
