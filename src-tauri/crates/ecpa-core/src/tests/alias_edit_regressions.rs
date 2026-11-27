use super::support::*;
use super::*;

const BASE: &str =
    "oauth-model-alias:\n  codex:\n    - name: gpt-test\n      alias: my-alias\n      fork: true\n";

const SHARED: &str = "openai-compatibility:\n  - name: Provider\n    models:\n      - {name: first, alias: shared}\n      - {name: second, alias: shared}\npayload:\n  override:\n    - models: [{name: shared, protocol: openai, headers: {X-Client: premium}}]\n      params: {reasoning_effort: high, service_tier: priority, temperature: 0.5}\n";

#[test]
fn alias_shared_rename_keeps_the_other_mapping_and_its_rules() {
    let entries = thinking_aliases_from_yaml(SHARED).unwrap();
    assert_ne!(entries[0].source_model, entries[1].source_model);
    let selected = entries.iter().find(|entry| entry.source_model == "second").unwrap();
    let source = resolve_model_alias_edit_source_for_mapping(SHARED, "shared", &[], Some(selected)).unwrap();
    let updated = edit_model_alias_in_yaml_for_mapping(SHARED, "shared", &source, "renamed", "low", false, Some(selected)).unwrap();
    let value = json(&updated);
    assert_eq!(value["openai-compatibility"][0]["models"][0]["alias"], "shared");
    assert_eq!(value["openai-compatibility"][0]["models"][1]["alias"], "renamed");
    let rules = value["payload"]["override"].as_array().unwrap();
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0], json(SHARED)["payload"]["override"][0]);
    assert_eq!(rules[1]["models"][0]["name"], "renamed");
    assert_eq!(rules[1]["models"][0]["headers"]["X-Client"], "premium");
    assert_eq!(rules[1]["params"]["reasoning_effort"], "low");
    assert!(rules[1]["params"].get("service_tier").is_none());
    assert_eq!(rules[1]["params"]["temperature"], 0.5);
}

#[test]
fn alias_shared_delete_only_removes_the_selected_mapping() {
    let entry = thinking_aliases_from_yaml(SHARED).unwrap().remove(1);
    let latest = format!("debug: true\n{SHARED}");
    let updated = remove_model_alias_mapping_from_yaml(&latest, "shared", &entry).unwrap();
    let value = json(&updated);
    assert_eq!(value["debug"], true);
    assert_eq!(value["openai-compatibility"][0]["models"].as_array().unwrap().len(), 1);
    assert_eq!(value["openai-compatibility"][0]["models"][0]["name"], "first");
    assert_eq!(value["payload"], json(SHARED)["payload"]);
}

#[test]
fn alias_shared_edit_follows_source_after_rows_are_reordered() {
    let entry = thinking_aliases_from_yaml(SHARED).unwrap().remove(1);
    let mut latest = json(SHARED);
    latest["openai-compatibility"][0]["models"].as_array_mut().unwrap().swap(0, 1);
    let latest = serde_norway::to_string(&latest).unwrap();
    let source = resolve_model_alias_edit_source_for_mapping(&latest, "shared", &[], Some(&entry)).unwrap();
    let updated = edit_model_alias_in_yaml_for_mapping(&latest, "shared", &source, "renamed", "high", true, Some(&entry)).unwrap();
    assert_eq!(json(&updated)["openai-compatibility"][0]["models"][0]["name"], "second");
    assert_eq!(json(&updated)["openai-compatibility"][0]["models"][0]["alias"], "renamed");
    assert_eq!(json(&updated)["openai-compatibility"][0]["models"][1]["alias"], "shared");
}

#[test]
fn alias_shared_delete_distinguishes_providers_with_the_same_model() {
    let input = "openai-compatibility:\n  - name: First\n    models: [{name: model, alias: shared}]\n  - name: Second\n    models: [{name: model, alias: shared}]\n";
    let entry = thinking_aliases_from_yaml(input).unwrap().into_iter().find(|entry| entry.provider == "Second").unwrap();
    let updated = remove_model_alias_mapping_from_yaml(input, "shared", &entry).unwrap();
    assert_eq!(json(&updated)["openai-compatibility"][0]["models"].as_array().unwrap().len(), 1);
    assert!(json(&updated)["openai-compatibility"][1]["models"].as_array().unwrap().is_empty());
}

#[test]
fn alias_identical_entries_can_be_removed_one_at_a_time() {
    let input = "openai-compatibility:\n  - name: Provider\n    models: [{name: model, alias: shared}, {name: model, alias: shared}]\n";
    let entry = thinking_aliases_from_yaml(input).unwrap().remove(0);
    let updated = remove_model_alias_mapping_from_yaml(input, "shared", &entry).unwrap();
    assert_eq!(thinking_aliases_from_yaml(&updated).unwrap().len(), 1);
}

#[test]
fn alias_shared_can_use_an_existing_real_model_name() {
    let input = "openai-compatibility:\n  - name: Provider\n    models: [{name: real}, {name: source}]\n";
    let available = test_agent_models(&["real", "source"]);
    let source = resolved_alias_sources(input, &[], &available, false).unwrap()
        .into_iter().find(|source| source.source.model == "source").unwrap();
    let updated = add_model_alias_to_yaml(input, &source, "real", "", false).unwrap();
    let entry = thinking_aliases_from_yaml(&updated).unwrap().remove(0);
    let resolved = resolve_model_alias_edit_source_for_mapping(&updated, "real", &[], Some(&entry)).unwrap();
    let renamed = edit_model_alias_in_yaml_for_mapping(&updated, "real", &resolved, "renamed", "", false, Some(&entry)).unwrap();
    assert_eq!(json(&renamed)["openai-compatibility"][0]["models"][0]["name"], "real");
    assert_eq!(thinking_aliases_from_yaml(&renamed).unwrap()[0].alias, "renamed");
}

#[test]
fn alias_shared_creation_preserves_existing_reasoning_and_fast() {
    let input = SHARED.replace("payload:", "      - {name: third}\npayload:");
    let available = test_agent_models(&["shared", "third"]);
    let source = resolved_alias_sources(&input, &[], &available, false).unwrap().remove(0);
    let updated = add_model_alias_to_yaml(&input, &source, "shared", "", false).unwrap();
    assert_eq!(thinking_aliases_from_yaml(&updated).unwrap().len(), 3);
    assert_eq!(json(&updated)["payload"], json(SHARED)["payload"]);
}

#[test]
fn alias_shared_source_switch_preserves_rules_used_by_the_old_protocol() {
    let input = SHARED.replace(", protocol: openai", "");
    let selected = thinking_aliases_from_yaml(&input).unwrap().remove(1);
    let source = test_codex_oauth_thinking_source("gpt-test");
    let updated = edit_model_alias_in_yaml_for_mapping(&input, "shared", &source, "shared", "high", true, Some(&selected)).unwrap();
    let value = json(&updated);
    assert_eq!(value["openai-compatibility"][0]["models"].as_array().unwrap().len(), 1);
    assert_eq!(value["openai-compatibility"][0]["models"][0]["name"], "first");
    assert_eq!(value["oauth-model-alias"]["codex"][0]["alias"], "shared");
    assert_eq!(value["payload"]["override"][0], json(&input)["payload"]["override"][0]);
    assert_eq!(value["payload"]["override"][1]["models"][0]["protocol"], "codex");
    assert_eq!(value["payload"]["override"][1]["params"]["reasoning.effort"], "high");
}

fn json(content: &str) -> serde_json::Value {
    serde_json::to_value(serde_norway::from_str::<serde_norway::Value>(content).unwrap()).unwrap()
}

fn unchanged_save(content: &str) -> String {
    let context = model_alias_edit_context(content, "my-alias", &[]).unwrap();
    let source = resolve_model_alias_edit_source(content, "my-alias", &[]).unwrap();
    edit_model_alias_in_yaml(
        content,
        "my-alias",
        &source,
        "my-alias",
        context.effort.as_deref().unwrap_or(""),
        context.fast,
    )
    .unwrap()
}

#[test]
fn alias_regression_noop_preserves_raw_effort_and_fast() {
    let content = format!("{BASE}payload:\n  override-raw:\n    - models: [{{name: my-alias, protocol: codex}}]\n      params: {{reasoning.effort: '\"high\"', service_tier: '\"priority\"'}}\n");
    let updated = unchanged_save(&content);
    assert_eq!(
        json(&updated),
        json(&content),
        "An unchanged save must preserve raw effort/Fast overrides"
    );
}

#[test]
fn alias_regression_noop_preserves_rules_without_protocol() {
    let content = format!("{BASE}payload:\n  override:\n    - models: [{{name: my-alias}}]\n      params: {{reasoning.effort: high, service_tier: priority}}\n");
    let updated = unchanged_save(&content);
    assert_eq!(
        json(&updated),
        json(&content),
        "Omitting protocol is a valid match-all selector, not an unset option"
    );
}

#[test]
fn alias_regression_noop_preserves_conditional_effort_and_fast() {
    let content = format!("{BASE}payload:\n  override:\n    - models:\n        - name: my-alias\n          protocol: codex\n          headers: {{X-Client: premium}}\n          from-protocol: responses\n      params: {{reasoning.effort: high, service_tier: priority}}\n");
    let updated = unchanged_save(&content);
    assert_eq!(
        json(&updated),
        json(&content),
        "An unchanged save must not broaden a conditional override to every request"
    );
}

#[test]
fn alias_regression_rejects_collision_with_real_model() {
    let content = "codex-api-key:\n  - models:\n      - name: my-alias\n      - name: gpt-test\n        alias: my-alias\n";
    assert!(resolve_model_alias_edit_source(content, "my-alias", &[]).is_err());
    let unambiguous = content.replace("      - name: my-alias\n", "");
    let source = resolve_model_alias_edit_source(&unambiguous, "my-alias", &[]).unwrap();
    assert!(edit_model_alias_in_yaml(content, "my-alias", &source, "renamed", "", false).is_err());
}

#[test]
fn alias_regression_source_id_does_not_retarget_after_reordering() {
    let content = "openai-compatibility:\n  - name: original-provider\n    models: [{name: original-model, alias: my-alias}]\n  - name: intended-provider\n    models: [{name: intended-model}]\n  - name: other-provider\n    models: [{name: other-model}]\n";
    let available = test_agent_models(&["my-alias", "intended-model", "other-model"]);
    let chosen =
        resolved_oauth_alias_sources(content, &[], &available, AliasSourceCapability::Base)
            .unwrap()
            .into_iter()
            .find(|source| source.source.model == "intended-model")
            .unwrap();
    let mut changed = json(content);
    changed["openai-compatibility"]
        .as_array_mut()
        .unwrap()
        .swap(1, 2);
    let changed = serde_norway::to_string(&changed).unwrap();
    let resolved =
        resolved_oauth_alias_sources(&changed, &[], &available, AliasSourceCapability::Base)
            .unwrap()
            .into_iter()
            .find(|source| source.source.id == chosen.source.id);
    assert!(
        resolved.is_none(),
        "A stale positional selection must be rejected"
    );
}

#[test]
fn alias_regression_edit_uses_latest_config_after_unrelated_changes() {
    let entry = thinking_aliases_from_yaml(BASE).unwrap().remove(0);
    let latest = format!("debug: true\n{BASE}payload:\n  override:\n    - models: [{{name: unrelated}}]\n      params: {{temperature: 0.5}}\n");
    let source = resolve_model_alias_edit_source_for_mapping(&latest, "my-alias", &[], Some(&entry)).unwrap();
    let updated = edit_model_alias_in_yaml_for_mapping(&latest, "my-alias", &source, "renamed", "", false, Some(&entry)).unwrap();
    assert_eq!(json(&updated)["debug"], true);
    assert_eq!(json(&updated)["payload"], json(&latest)["payload"]);
    assert_eq!(thinking_aliases_from_yaml(&updated).unwrap()[0].alias, "renamed");
}

#[test]
fn alias_regression_readers_use_raw_and_last_override_values() {
    let content = format!("{BASE}payload:\n  override:\n    - models: [{{name: my-alias, protocol: codex}}]\n      params: {{reasoning.effort: high, service_tier: priority}}\n    - models: [{{name: my-alias, protocol: codex}}]\n      params: {{reasoning.effort: low}}\n  override-raw:\n    - models: [{{name: my-alias}}]\n      params: {{service_tier: '\"flex\"'}}\n");
    let context = model_alias_edit_context(&content, "my-alias", &[]).unwrap();
    assert_eq!(context.effort.as_deref(), Some("low"));
    assert!(!context.fast);
    assert_eq!(json(&unchanged_save(&content)), json(&content));
    assert_eq!(
        thinking_aliases_from_yaml(&content).unwrap()[0]
            .effort
            .as_deref(),
        Some("low")
    );
    assert_eq!(
        speed_aliases_from_yaml(&content).unwrap()[0].service_tier,
        "flex"
    );
}

#[test]
fn alias_regression_explicit_changes_keep_raw_conditions_and_other_fields() {
    let content = format!("{BASE}payload:\n  override-raw:\n    - models:\n        - name: my-alias\n          protocol: ''\n          headers: {{X-Client: premium}}\n          from-protocol: responses\n          match: [{{metadata.client: codex}}]\n        - name: other-alias\n      params: {{reasoning.effort: '\"high\"', service_tier: '\"priority\"', temperature: '0.2'}}\n");
    let source = resolve_model_alias_edit_source(&content, "my-alias", &[]).unwrap();
    let updated =
        edit_model_alias_in_yaml(&content, "my-alias", &source, "renamed", "low", true).unwrap();
    let before = json(&content);
    let after = json(&updated);
    assert!(
        after["payload"]["override"].is_null(),
        "Existing conditional settings must not produce unconditional rules"
    );
    let rules = after["payload"]["override-raw"].as_array().unwrap();
    assert_eq!(rules.len(), 2);
    assert_eq!(
        rules[0]["params"],
        before["payload"]["override-raw"][0]["params"]
    );
    assert_eq!(rules[0]["models"][0]["name"], "other-alias");
    let mut expected_selector = before["payload"]["override-raw"][0]["models"][0].clone();
    expected_selector["name"] = serde_json::json!("renamed");
    assert_eq!(rules[1]["models"][0], expected_selector);
    assert_eq!(
        rules[1]["params"],
        serde_json::json!({"reasoning.effort":"\"low\"", "service_tier":"\"priority\"", "temperature":"0.2"})
    );
    let context = model_alias_edit_context(&updated, "renamed", &[]).unwrap();
    assert_eq!(context.effort.as_deref(), Some("low"));
    assert!(context.fast);
}

#[test]
fn alias_regression_toggle_fast_preserves_distinct_conditional_efforts() {
    let content = format!("{BASE}payload:\n  override:\n    - models: [{{name: my-alias, protocol: codex, headers: {{X-Client: a}}}}]\n      params: {{reasoning.effort: low, service_tier: flex}}\n    - models: [{{name: my-alias, protocol: codex, headers: {{X-Client: b}}}}]\n      params: {{reasoning.effort: high, service_tier: flex}}\n");
    let source = resolve_model_alias_edit_source(&content, "my-alias", &[]).unwrap();
    let updated =
        edit_model_alias_in_yaml(&content, "my-alias", &source, "my-alias", "high", true).unwrap();
    let after = json(&updated);
    let rules = after["payload"]["override"].as_array().unwrap();
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0]["params"]["reasoning.effort"], "low");
    assert_eq!(rules[1]["params"]["reasoning.effort"], "high");
    for (index, rule) in rules.iter().enumerate() {
        assert_eq!(
            rule["models"],
            json(&content)["payload"]["override"][index]["models"]
        );
        assert_eq!(rule["params"]["service_tier"], "priority");
    }
}

#[test]
fn alias_regression_provider_change_with_same_model_invalidates_selection() {
    let content = "openai-compatibility:\n  - name: provider\n    base-url: https://one.example/v1\n    models: [{name: shared-model}]\n";
    let models = test_agent_models(&["shared-model"]);
    let original =
        resolved_oauth_alias_sources(content, &[], &models, AliasSourceCapability::Base).unwrap();
    let changed = resolved_oauth_alias_sources(
        &content.replace("one.example", "two.example"),
        &[],
        &models,
        AliasSourceCapability::Base,
    )
    .unwrap();
    assert_eq!(original[0].source.model, changed[0].source.model);
    assert_ne!(original[0].source.id, changed[0].source.id);
}

#[test]
fn alias_regression_unchanged_save_keeps_comments_and_empty_rules_byte_for_byte() {
    let content = format!("# custom config\n{BASE}payload: {{override: []}} # keep placeholder\n");
    assert_eq!(unchanged_save(&content), content);
}
