use super::support::*;
use super::*;

fn json(content: &str) -> serde_json::Value {
    serde_json::to_value(serde_norway::from_str::<serde_norway::Value>(content).unwrap()).unwrap()
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
    let input = "openai-compatibility:\n  - name: disabled-provider\n    disabled: true\n    models: [{name: model-a}]\n";
    let result = ensure_claude_desktop_model_aliases_in_yaml(
        input,
        &ClaudeDesktopModelMappings::all("model-a"),
        &test_agent_models(&["model-a"]),
    );
    assert!(result.is_err());
}

#[test]
fn disabled_provider_alias_does_not_mark_an_active_real_model_as_an_alias() {
    let input = "openai-compatibility:\n  - name: disabled-provider\n    disabled: true\n    models: [{name: other-model, alias: model-a}]\ncodex-api-key:\n  - models: [{name: model-a}]\n";
    let mut models = test_agent_models(&["model-a"]);
    mark_configured_agent_model_aliases(&mut models, input).unwrap();
    assert!(!models[0].is_alias);
}
