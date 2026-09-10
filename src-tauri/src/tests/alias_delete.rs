use super::support::*;
use super::*;

fn json(content: &str) -> serde_json::Value {
    serde_json::to_value(serde_norway::from_str::<serde_norway::Value>(content).unwrap()).unwrap()
}

#[test]
fn plain_api_aliases_can_be_deleted_for_every_provider() {
    for section in MODEL_ALIAS_CONFIG_SECTIONS {
        let original = format!("{section}:\n  - name: provider\n    models: [{{name: model-a}}, {{name: model-b, alias: keep}}]\n");
        let source =
            resolved_alias_sources(&original, &[], &test_agent_models(&["model-a"]), false)
                .unwrap()
                .into_iter()
                .find(|source| source.source.model == "model-a")
                .unwrap();
        let created = add_model_alias_to_yaml(&original, &source, "plain", "", false).unwrap();
        assert!(thinking_aliases_from_yaml(&created)
            .unwrap()
            .iter()
            .any(|entry| entry.alias == "plain" && entry.effort.is_none()));
        let deleted = remove_thinking_alias_from_yaml(&created, "plain").unwrap();
        assert_eq!(json(&deleted), json(&original), "{section}");
    }
}

#[test]
fn api_alias_can_be_deleted_after_editing_away_all_options() {
    for section in MODEL_ALIAS_CONFIG_SECTIONS {
        let original = format!("{section}:\n  - name: provider\n    models: [{{name: model-a}}]\n");
        let source =
            resolved_alias_sources(&original, &[], &test_agent_models(&["model-a"]), false)
                .unwrap()
                .remove(0);
        let created = add_model_alias_to_yaml(
            &original,
            &source,
            "editable",
            "high",
            alias_source_supports_fast(&source),
        )
        .unwrap();
        let edit_source = resolve_model_alias_edit_source(&created, "editable", &[]).unwrap();
        let edited =
            edit_model_alias_in_yaml(&created, "editable", &edit_source, "editable", "", false)
                .unwrap();
        let context = model_alias_edit_context(&edited, "editable", &[]).unwrap();
        assert_eq!(context.effort, None);
        assert!(!context.fast);
        let deleted = remove_thinking_alias_from_yaml(&edited, "editable").unwrap();
        assert_eq!(json(&deleted), json(&original), "{section}");
    }
}

#[test]
fn plain_alias_deletion_preserves_real_models_with_the_same_name() {
    let original = "openai-compatibility:\n  - name: provider\n    models: [plain, {name: plain}, {name: plain, alias: plain}, {name: model-a, alias: plain}]\n";
    let deleted = remove_thinking_alias_from_yaml(original, "plain").unwrap();
    assert_eq!(
        json(&deleted)["openai-compatibility"][0]["models"],
        serde_json::json!(["plain", {"name": "plain"}, {"name": "plain", "alias": "plain"}])
    );
    assert!(remove_thinking_alias_from_yaml(&deleted, "plain").is_err());
}

#[test]
fn channel_deletion_preserves_other_protocols_and_shared_models() {
    let original = "oauth-model-alias:\n  codex: [{name: model-a, alias: shared}]\n  claude: [{name: model-b, alias: shared}]\npayload:\n  override:\n    - models: [{name: shared, protocol: codex}]\n      params: {reasoning.effort: high, service_tier: priority}\n    - models: [{name: shared, protocol: claude}, {name: other, protocol: codex}]\n      params: {output_config.effort: high}\n";
    for speed in [false, true] {
        let deleted = if speed {
            remove_speed_alias_from_yaml_for_channel(original, "shared", Some("codex"))
        } else {
            remove_thinking_alias_from_yaml_for_channel(original, "shared", Some("codex"))
        }
        .unwrap();
        let entries = thinking_aliases_from_yaml(&deleted).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].oauth_channel.as_deref(), Some("claude"));
        assert_eq!(entries[0].effort.as_deref(), Some("high"));
        assert_eq!(
            json(&deleted)["payload"]["override"],
            serde_json::json!([json(original)["payload"]["override"][1]])
        );
    }
}

#[test]
fn channel_deletion_preserves_wildcard_rules_for_surviving_aliases() {
    for protocol in ["", ", protocol: ''"] {
        let original = format!("oauth-model-alias:\n  codex: [{{name: model-a, alias: shared}}]\n  claude: [{{name: model-b, alias: shared}}]\npayload:\n  override:\n    - models: [{{name: shared{protocol}}}]\n      params: {{reasoning.effort: high, output_config.effort: high, service_tier: priority}}\n");
        for speed in [false, true] {
            let deleted = if speed {
                remove_speed_alias_from_yaml_for_channel(&original, "shared", Some("codex"))
            } else {
                remove_thinking_alias_from_yaml_for_channel(&original, "shared", Some("codex"))
            }
            .unwrap();
            assert_eq!(json(&deleted)["payload"], json(&original)["payload"]);
            let deleted =
                remove_thinking_alias_from_yaml_for_channel(&deleted, "shared", Some("claude"))
                    .unwrap();
            assert!(json(&deleted).get("payload").is_none());
        }
    }
}

#[test]
fn channel_deletion_preserves_rules_used_by_same_protocol_mappings() {
    for surviving in [
        "  xai: [{name: model-b, alias: shared}]\n",
        "codex-api-key:\n  - models: [{name: model-b, alias: shared}]\n",
        "codex-api-key:\n  - models: [{name: shared}]\n",
    ] {
        let original = format!("oauth-model-alias:\n  codex: [{{name: model-a, alias: shared}}]\n{surviving}payload:\n  override:\n    - models: [{{name: shared, protocol: codex}}]\n      params: {{reasoning.effort: high, service_tier: priority}}\n");
        for speed in [false, true] {
            let deleted = if speed {
                remove_speed_alias_from_yaml_for_channel(&original, "shared", Some("codex"))
            } else {
                remove_thinking_alias_from_yaml_for_channel(&original, "shared", Some("codex"))
            }
            .unwrap();
            assert_eq!(json(&deleted)["payload"], json(&original)["payload"]);
            assert!(json(&deleted)["oauth-model-alias"].get("codex").is_none());
        }
    }
}
