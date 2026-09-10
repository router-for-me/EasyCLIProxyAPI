use super::support::*;
use super::*;

fn edit(content: &str, original: &str, alias: &str, effort: &str, fast: bool) -> String {
    let source = resolve_model_alias_edit_source(content, original, &[]).unwrap();
    edit_model_alias_in_yaml(content, original, &source, alias, effort, fast).unwrap()
}

fn value(content: &str) -> serde_json::Value {
    serde_json::to_value(serde_norway::from_str::<serde_norway::Value>(content).unwrap()).unwrap()
}

const MIXED_PAYLOAD: &str = r#"# Keep this comment
port: 8317
oauth-model-alias:
  codex:
    - name: gpt-test
      alias: my-alias
      fork: false
payload:
  override:
    - models:
        - name: my-alias
          protocol: codex
        - name: other-alias
          protocol: codex
      params:
        reasoning.effort: high
        service_tier: priority
        temperature: 0.2
        max_output_tokens: 1024
"#;

#[test]
fn alias_edit_preserves_other_parameters_and_shared_models() {
    let updated = edit(MIXED_PAYLOAD, "my-alias", "my-alias", "low", false);
    let before = value(MIXED_PAYLOAD);
    let after = value(&updated);
    let rules = after["payload"]["override"].as_array().unwrap();
    assert_eq!(rules.len(), 3);
    assert_eq!(rules[0]["models"].as_array().unwrap().len(), 1);
    assert_eq!(rules[0]["models"][0]["name"], "other-alias");
    assert_eq!(
        rules[0]["params"],
        before["payload"]["override"][0]["params"]
    );
    assert_eq!(rules[1]["models"][0]["name"], "my-alias");
    assert_eq!(
        rules[1]["params"],
        serde_json::json!({"temperature": 0.2, "max_output_tokens": 1024})
    );
    assert_eq!(
        rules[2]["params"],
        serde_json::json!({"reasoning.effort": "low"})
    );
    assert_eq!(after["oauth-model-alias"], before["oauth-model-alias"]);
    assert!(updated.contains("# Keep this comment"));
    assert_eq!(after["port"], before["port"]);
}

#[test]
fn alias_edit_resolves_remapped_api_model_without_a_visible_upstream() {
    let content = "openai-compatibility:\n  - name: my-provider\n    models:\n      - name: upstream-gpt\n        alias: public-gpt\n";
    let sources = resolved_oauth_alias_sources(
        content,
        &[],
        &test_agent_models(&["public-gpt"]),
        AliasSourceCapability::Base,
    )
    .unwrap();
    let created = add_model_alias_to_yaml(content, &sources[0], "my-alias", "high", false).unwrap();
    let source = resolve_model_alias_edit_source(&created, "my-alias", &[]).unwrap();
    assert_eq!(source.source.model, "upstream-gpt");
    assert_eq!(source.source.id, model_alias_edit_source_id("my-alias"));
    assert!(source.source.reasoning_levels.contains(&"high".to_string()));
    let updated =
        edit_model_alias_in_yaml(&created, "my-alias", &source, "renamed", "low", true).unwrap();
    let after = value(&updated);
    assert_eq!(
        after["openai-compatibility"][0]["models"][0],
        value(content)["openai-compatibility"][0]["models"][0]
    );
    assert_eq!(
        after["openai-compatibility"][0]["models"][1]["name"],
        "upstream-gpt"
    );
    assert_eq!(
        after["openai-compatibility"][0]["models"][1]["alias"],
        "renamed"
    );
    let entries = thinking_aliases_from_yaml(&updated).unwrap();
    assert_eq!(
        entries
            .iter()
            .find(|entry| entry.alias == "renamed")
            .unwrap()
            .effort
            .as_deref(),
        Some("low")
    );
    assert_eq!(
        speed_aliases_from_yaml(&updated).unwrap()[0].service_tier,
        "priority"
    );
}

#[test]
fn alias_edit_keeps_api_metadata_and_order_on_an_unchanged_save() {
    let content = "openai-compatibility:\n  - name: my-provider\n    models:\n      - name: gpt-test\n        display-name: Base Model\n      - name: gpt-test\n        alias: my-alias\n        display-name: Custom Alias Label\n        thinking:\n          levels: [low, high]\n        custom: {keep: true}\n      - name: other\n";
    let updated = edit(content, "my-alias", "my-alias", "", false);
    assert_eq!(value(&updated), value(content));
    // Selecting the base entry for the same upstream must preserve alias metadata too.
    let source = resolved_oauth_alias_sources(
        content,
        &[],
        &test_agent_models(&["gpt-test"]),
        AliasSourceCapability::Base,
    )
    .unwrap()
    .remove(0);
    let updated =
        edit_model_alias_in_yaml(content, "my-alias", &source, "my-alias", "", false).unwrap();
    assert_eq!(value(&updated), value(content));
}

#[test]
fn alias_edit_renames_default_raw_and_filter_references() {
    let content = format!("{MIXED_PAYLOAD}  default:\n    - models: [{{name: my-alias}}]\n      params: {{temperature: 0.7}}\n  default-raw:\n    - models: [{{name: my-alias, protocol: codex}}]\n      params: {{store: 'false'}}\n  override-raw:\n    - models: [{{name: my-alias, protocol: codex}}]\n      params: {{service_tier: '\"priority\"', store: 'false'}}\n  filter:\n    - models: [{{name: my-alias, protocol: codex}}]\n      params: [metadata]\n");
    let updated = edit(&content, "my-alias", "renamed", "", false);
    let after = value(&updated);
    for section in ["default", "default-raw", "override-raw", "filter"] {
        assert_eq!(after["payload"][section][0]["models"][0]["name"], "renamed");
    }
    assert_eq!(
        after["payload"]["filter"][0]["params"],
        serde_json::json!(["metadata"])
    );
    assert_eq!(
        after["payload"]["override-raw"][0]["params"],
        serde_json::json!({"store":"false"})
    );
    assert!(!updated.contains("my-alias"));
}

#[test]
fn alias_edit_keeps_payload_rules_for_another_protocol() {
    let content = format!("{MIXED_PAYLOAD}    - models: [{{name: my-alias, protocol: openai}}]\n      params: {{reasoning_effort: high}}\n");
    let updated = edit(&content, "my-alias", "my-alias", "", false);
    let after = value(&updated);
    assert!(after["payload"]["override"]
        .as_array()
        .unwrap()
        .iter()
        .any(|rule| rule["models"][0]["protocol"] == "openai"
            && rule["params"]["reasoning_effort"] == "high"));
}

#[test]
fn alias_edit_switches_to_a_later_model_without_shifting_indices() {
    let content = "codex-api-key:\n  - models:\n      - name: old-upstream\n        alias: my-alias\n      - name: new-upstream\n        display-name: New Model\n";
    let source = resolved_oauth_alias_sources(
        content,
        &[],
        &test_agent_models(&["new-upstream"]),
        AliasSourceCapability::Base,
    )
    .unwrap()
    .remove(0);
    let updated =
        edit_model_alias_in_yaml(content, "my-alias", &source, "my-alias", "high", true).unwrap();
    let after = value(&updated);
    assert_eq!(
        after["codex-api-key"][0]["models"][0]["name"],
        "new-upstream"
    );
    assert_eq!(
        after["codex-api-key"][0]["models"][1],
        value(content)["codex-api-key"][0]["models"][1]
    );
    assert_eq!(
        after["codex-api-key"][0]["models"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn alias_edit_selects_exact_provider_even_with_identical_display_names() {
    let content = "openai-compatibility:\n  - name: shared\n    models: [{name: model-a, alias: my-alias}, {name: shared-model}]\n  - name: shared\n    models: [{name: shared-model}]\n";
    let sources = resolved_oauth_alias_sources(
        content,
        &[],
        &test_agent_models(&["shared-model"]),
        AliasSourceCapability::Base,
    )
    .unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.id == "openai-compatibility:1:0")
        .unwrap();
    let updated =
        edit_model_alias_in_yaml(content, "my-alias", source, "my-alias", "", false).unwrap();
    let after = value(&updated);
    assert_eq!(
        after["openai-compatibility"][0]["models"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        after["openai-compatibility"][1]["models"][1]["alias"],
        "my-alias"
    );
}

#[test]
fn alias_edit_moves_between_api_and_oauth_and_updates_payload_protocol() {
    let content = "openai-compatibility:\n  - name: provider\n    models: [{name: api-model, alias: my-alias}]\noauth-model-alias:\n  codex:\n    - name: oauth-model\n      alias: other-alias\n      fork: true\npayload:\n  override:\n    - models: [{name: my-alias, protocol: openai}]\n      params: {temperature: 0.2, reasoning_effort: high}\n";
    let source = resolve_model_alias_edit_source(content, "other-alias", &[]).unwrap();
    let updated =
        edit_model_alias_in_yaml(content, "my-alias", &source, "my-alias", "low", true).unwrap();
    let after = value(&updated);
    assert!(after["openai-compatibility"][0]["models"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        after["oauth-model-alias"]["codex"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        after["payload"]["override"][0]["models"][0]["protocol"],
        "codex"
    );
    assert_eq!(
        after["payload"]["override"][0]["params"],
        serde_json::json!({"temperature":0.2})
    );
    let content = format!("{updated}codex-api-key:\n  - models: [{{name: back-to-api}}]\n");
    let source = resolved_oauth_alias_sources(
        &content,
        &[],
        &test_agent_models(&["back-to-api"]),
        AliasSourceCapability::Base,
    )
    .unwrap()
    .remove(0);
    let updated =
        edit_model_alias_in_yaml(&content, "my-alias", &source, "renamed", "", false).unwrap();
    let after = value(&updated);
    assert_eq!(
        after["oauth-model-alias"]["codex"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(after["codex-api-key"][0]["models"][1]["alias"], "renamed");
}

#[test]
fn alias_edit_rejects_duplicates_missing_aliases_and_name_collisions() {
    let source = resolve_model_alias_edit_source(MIXED_PAYLOAD, "my-alias", &[]).unwrap();
    assert!(
        edit_model_alias_in_yaml("port: 8317\n", "missing", &source, "renamed", "", false).is_err()
    );
    let duplicate = MIXED_PAYLOAD.replace(
        "      fork: false",
        "      fork: false\n    - name: duplicate\n      alias: MY-ALIAS",
    );
    assert!(
        edit_model_alias_in_yaml(&duplicate, "my-alias", &source, "renamed", "", false).is_err()
    );
    let occupied = MIXED_PAYLOAD.replace(
        "      fork: false",
        "      fork: false\n    - name: another\n      alias: taken",
    );
    assert!(edit_model_alias_in_yaml(&occupied, "my-alias", &source, "TAKEN", "", false).is_err());
    // A real model entry without an alias is not an editable alias.
    assert!(resolve_model_alias_edit_source(
        "codex-api-key:\n  - models: [{name: real-model}]\n",
        "real-model",
        &[]
    )
    .is_err());
}

#[test]
fn alias_edit_keeps_an_unavailable_oauth_source_and_existing_effort() {
    let source = resolve_model_alias_edit_source(MIXED_PAYLOAD, "my-alias", &[]).unwrap();
    assert_eq!(source.source.model, "gpt-test");
    assert_eq!(source.source.reasoning_levels, ["high"]);
    let updated = edit(MIXED_PAYLOAD, "my-alias", "renamed", "high", true);
    assert_eq!(
        value(&updated)["oauth-model-alias"]["codex"][0]["fork"],
        false
    );
}

#[test]
fn alias_edit_does_not_change_implicit_or_explicit_oauth_routing_flags() {
    for channel in ["codex", "antigravity"] {
        for flags in ["", "      fork: false\n      force-mapping: false\n"] {
            let content = format!("oauth-model-alias:\n  {channel}:\n    - name: upstream\n      alias: my-alias\n{flags}");
            let updated = edit(&content, "my-alias", "my-alias", "", false);
            assert_eq!(value(&updated), value(&content));
        }
    }
}
