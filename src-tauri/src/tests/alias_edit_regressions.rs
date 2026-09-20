use super::support::*;
use super::*;

const BASE: &str =
    "oauth-model-alias:\n  codex:\n    - name: gpt-test\n      alias: my-alias\n      fork: true\n";

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
fn alias_regression_edit_snapshot_rejects_recreated_alias_and_missing_revision() {
    let context = model_alias_edit_context(BASE, "my-alias", &[]).unwrap();
    assert!(validate_model_alias_revision(BASE, Some(&context.revision)).is_ok());
    let reformatted = serde_norway::to_string(&json(BASE)).unwrap();
    assert!(validate_model_alias_revision(&reformatted, Some(&context.revision)).is_ok());
    assert!(validate_model_alias_revision(BASE, None).is_err());
    let recreated = BASE.replace("gpt-test", "another-upstream");
    assert!(validate_model_alias_revision(&recreated, Some(&context.revision)).is_err());
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
