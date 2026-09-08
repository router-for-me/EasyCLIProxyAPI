use super::support::*;
use super::*;

fn test_oauth_definition_set(channel: &str, models: &[&str]) -> OAuthModelDefinitions {
    OAuthModelDefinitions {
        channel: oauth_alias_channel(channel).unwrap(),
        models: models
            .iter()
            .map(|model| CodexModelDefinition {
                id: (*model).to_string(),
                display_name: None,
                description: None,
                context_window: None,
                reasoning_levels: Vec::new(),
                supports_tools: None,
            })
            .collect(),
    }
}

fn test_oauth_thinking_source(channel: &str, model: &str) -> ResolvedThinkingAliasSource {
    let channel = oauth_alias_channel(channel).unwrap();
    ResolvedThinkingAliasSource {
        source: ThinkingAliasSource {
            id: format!("{}:{model}", channel.kind),
            model: model.to_string(),
            display_name: None,
            provider: channel.provider.to_string(),
            kind: channel.kind.to_string(),
            protocol: channel.protocol.to_string(),
            reasoning_levels: vec!["low".to_string(), "high".to_string()],
        },
        location: ThinkingAliasSourceLocation::Oauth {
            channel: channel.key,
            force_mapping: channel.force_mapping,
        },
    }
}

#[test]
fn oauth_auth_provider_names_map_to_alias_channels() {
    assert_eq!(
        normalize_oauth_alias_channel("anti-gravity"),
        Some("antigravity")
    );
    assert_eq!(normalize_oauth_alias_channel("anthropic"), Some("claude"));
    assert_eq!(
        normalize_oauth_alias_channel("gemini-cli"),
        Some("aistudio")
    );
    assert_eq!(normalize_oauth_alias_channel("grok"), Some("xai"));
}

#[test]
fn oauth_reasoning_sources_follow_each_model_definition() {
    let definition_sets = [
        "vertex",
        "aistudio",
        "antigravity",
        "claude",
        "codex",
        "kimi",
        "xai",
    ]
    .into_iter()
    .map(|channel| {
        let mut definitions = test_oauth_definition_set(channel, &[&format!("{channel}-model")]);
        definitions.models[0].reasoning_levels = vec!["low".to_string(), "high".to_string()];
        definitions
    })
    .collect::<Vec<_>>();
    let available = definition_sets
        .iter()
        .map(|definitions| definitions.models[0].id.as_str())
        .collect::<Vec<_>>();
    let sources = resolved_oauth_alias_sources(
        "{}\n",
        &definition_sets,
        &test_agent_models(&available),
        AliasSourceCapability::Reasoning,
    )
    .unwrap();

    assert_eq!(sources.len(), definition_sets.len());
    assert!(sources
        .iter()
        .all(|source| source.source.reasoning_levels == ["low", "high"]));
    assert_eq!(
        sources
            .iter()
            .find(|source| source.source.kind == "xai-oauth")
            .unwrap()
            .source
            .protocol,
        "codex"
    );
}

#[test]
fn thinking_alias_uses_source_native_override_parameters() {
    let cases = [
        (
            "codex",
            "gpt-5.6-sol",
            "high",
            &["reasoning.effort: high"][..],
        ),
        (
            "claude",
            "claude-opus-4-6",
            "high",
            &["thinking.type: adaptive", "output_config.effort: high"][..],
        ),
        (
            "claude",
            "claude-opus-4-6",
            "auto",
            &["thinking.type: adaptive"][..],
        ),
        (
            "claude",
            "claude-opus-4-6",
            "none",
            &["thinking.type: disabled"][..],
        ),
        (
            "aistudio",
            "gemini-3.1-pro",
            "high",
            &["generationConfig.thinkingConfig.thinkingLevel: high"][..],
        ),
        (
            "antigravity",
            "gemini-3.1-pro",
            "high",
            &["generationConfig.thinkingConfig.thinkingLevel: high"][..],
        ),
        (
            "kimi",
            "kimi-k2.5",
            "high",
            &["thinking.type: enabled", "thinking.effort: high"][..],
        ),
        (
            "kimi",
            "kimi-k2.5",
            "none",
            &["thinking.type: disabled"][..],
        ),
        ("xai", "grok-4", "high", &["reasoning.effort: high"][..]),
    ];

    for (channel, model, effort, expected) in cases {
        let source = test_oauth_thinking_source(channel, model);
        let alias = format!("{model}-{effort}");
        let rendered = add_model_alias_to_yaml("{}\n", &source, &alias, effort, false).unwrap();
        for parameter in expected {
            assert!(
                rendered.contains(parameter),
                "{channel}: missing {parameter}\n{rendered}"
            );
        }
        assert_eq!(
            thinking_aliases_from_yaml(&rendered).unwrap()[0]
                .effort
                .as_deref(),
            Some(effort)
        );
        let restored = remove_thinking_alias_from_yaml(&rendered, &alias).unwrap();
        assert!(!restored.contains(&alias), "{channel}: {restored}");
    }
}

#[test]
fn configured_claude_and_gemini_models_use_native_overrides() {
    let input = "claude-api-key:\n  - api-key: claude-key\n    models:\n      - name: claude-opus-4-6\n        thinking:\n          levels: [low, high]\ngemini-api-key:\n  - api-key: gemini-key\n    models:\n      - name: gemini-3.1-pro\n        thinking:\n          levels: [low, high]\n";
    let available_models = test_agent_models(&["claude-opus-4-6", "gemini-3.1-pro"]);
    let sources = resolved_oauth_alias_sources(
        input,
        &[],
        &available_models,
        AliasSourceCapability::Reasoning,
    )
    .unwrap();

    let claude = sources
        .iter()
        .find(|source| source.source.kind == "claude-api")
        .unwrap();
    let with_claude =
        add_model_alias_to_yaml(input, claude, "claude-fixed", "high", false).unwrap();
    assert!(
        with_claude.contains("output_config.effort: high"),
        "{with_claude}"
    );

    let sources = resolved_oauth_alias_sources(
        &with_claude,
        &[],
        &available_models,
        AliasSourceCapability::Reasoning,
    )
    .unwrap();
    let gemini = sources
        .iter()
        .find(|source| source.source.kind == "gemini-api")
        .unwrap();
    let rendered =
        add_model_alias_to_yaml(&with_claude, gemini, "gemini-fixed", "low", false).unwrap();
    assert!(
        rendered.contains("generationConfig.thinkingConfig.thinkingLevel: low"),
        "{rendered}"
    );
    assert!(thinking_aliases_from_yaml(&rendered)
        .unwrap()
        .iter()
        .any(|entry| entry.alias == "claude-fixed"));
    assert!(thinking_aliases_from_yaml(&rendered)
        .unwrap()
        .iter()
        .any(|entry| entry.alias == "gemini-fixed"));
    let document: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
    let root = document.as_mapping().unwrap();
    for (section, alias, protocol) in [
        ("claude-api-key", "claude-fixed", "claude"),
        ("gemini-api-key", "gemini-fixed", "gemini"),
    ] {
        let alias_model = yaml_mapping_value(root, section)
            .and_then(serde_norway::Value::as_sequence)
            .and_then(|providers| providers[0].as_mapping())
            .and_then(|provider| yaml_mapping_value(provider, "models"))
            .and_then(serde_norway::Value::as_sequence)
            .unwrap()
            .iter()
            .find(|model| {
                configured_model_identity(model)
                    .is_some_and(|(_, model_alias, _)| model_alias == alias)
            })
            .unwrap();
        assert_eq!(
            configured_model_reasoning_levels(alias_model, protocol),
            ["low", "high"]
        );
    }
}

#[test]
fn antigravity_alias_uses_its_own_oauth_channel_and_force_mapping() {
    let available_models = test_agent_models(&["gemini-pro-agent"]);
    let definitions = vec![test_oauth_definition_set(
        "antigravity",
        &["gemini-pro-agent"],
    )];
    let sources = resolved_oauth_alias_sources(
        "{}\n",
        &definitions,
        &available_models,
        AliasSourceCapability::Base,
    )
    .unwrap();

    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source.kind, "antigravity-oauth");
    let rendered =
        add_model_alias_to_yaml("{}\n", &sources[0], "gemini-3.1-pro-preview", "", false).unwrap();

    assert!(rendered.contains("antigravity:"), "{rendered}");
    assert!(rendered.contains("name: gemini-pro-agent"), "{rendered}");
    assert!(
        rendered.contains("alias: gemini-3.1-pro-preview"),
        "{rendered}"
    );
    assert!(rendered.contains("force-mapping: true"), "{rendered}");
    assert!(!rendered.contains("codex:"), "{rendered}");
}

#[test]
fn oauth_alias_reader_and_delete_preserve_the_exact_channel() {
    let input = "oauth-model-alias:\n  antigravity:\n    - name: gemini-pro-agent\n      alias: shared-alias\n      force-mapping: true\n  codex:\n    - name: gpt-5.5\n      alias: shared-alias\n      fork: true\n";
    let entries = thinking_aliases_from_yaml(input).unwrap();

    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|entry| {
        entry.oauth_channel.as_deref() == Some("antigravity") && entry.kind == "antigravity-oauth"
    }));
    let rendered =
        remove_thinking_alias_from_yaml_for_channel(input, "shared-alias", Some("antigravity"))
            .unwrap();

    assert!(!rendered.contains("antigravity:"), "{rendered}");
    assert!(rendered.contains("codex:"), "{rendered}");
    assert!(rendered.contains("name: gpt-5.5"), "{rendered}");
}

#[test]
fn fast_is_only_available_for_supported_model_sources() {
    let input = "openai-compatibility:\n  - name: Relay\n    base-url: https://example.com/v1\n    models:\n      - name: gpt-test\n      - name: deepseek-chat\n";
    let available_models = test_agent_models(&["gpt-test", "deepseek-chat"]);
    let sources =
        resolved_oauth_alias_sources(input, &[], &available_models, AliasSourceCapability::Fast)
            .unwrap();

    assert_eq!(sources.len(), 2);
    assert!(sources
        .iter()
        .any(|source| source.source.model == "gpt-test"));
    assert!(sources
        .iter()
        .any(|source| source.source.model == "deepseek-chat"));

    let deepseek_source = ResolvedThinkingAliasSource {
        source: ThinkingAliasSource {
            id: "test:deepseek-chat".to_string(),
            model: "deepseek-chat".to_string(),
            display_name: None,
            provider: "Relay".to_string(),
            kind: "openai-compatible".to_string(),
            protocol: "openai".to_string(),
            reasoning_levels: vec!["low".to_string(), "medium".to_string(), "high".to_string()],
        },
        location: ThinkingAliasSourceLocation::ConfigModel {
            section: "openai-compatibility",
            provider_index: 0,
            model_index: 1,
        },
    };
    let deepseek_fast = add_speed_alias_to_yaml(input, &deepseek_source, "deepseek-fast").unwrap();
    assert!(
        deepseek_fast.contains("service_tier: priority"),
        "{deepseek_fast}"
    );

    let antigravity_source = ResolvedThinkingAliasSource {
        source: ThinkingAliasSource {
            id: "antigravity-oauth:gpt-test".to_string(),
            model: "gpt-test".to_string(),
            display_name: None,
            provider: "Antigravity OAuth".to_string(),
            kind: "antigravity-oauth".to_string(),
            protocol: "antigravity".to_string(),
            reasoning_levels: vec!["low".to_string(), "high".to_string()],
        },
        location: ThinkingAliasSourceLocation::Oauth {
            channel: "antigravity",
            force_mapping: true,
        },
    };
    let antigravity_fast_sources = resolved_oauth_alias_sources(
        "{}\n",
        &[test_oauth_definition_set("antigravity", &["gpt-test"])],
        &test_agent_models(&["gpt-test"]),
        AliasSourceCapability::Fast,
    )
    .unwrap();
    assert!(antigravity_fast_sources.is_empty());
    assert!(add_speed_alias_to_yaml("{}\n", &antigravity_source, "gpt-fast").is_err());
}

#[test]
fn thinking_alias_adds_fork_and_matching_payload_rule() {
    let input = "# Keep this comment\ndebug: true\npayload:\n  override:\n    - models:\n        - name: existing-fast\n          protocol: codex\n      params:\n        service_tier: priority\n";
    let source = test_codex_oauth_thinking_source("gpt-5.5");
    let rendered =
        add_model_alias_to_yaml(input, &source, "gpt-5.5-xhigh", "xhigh", false).unwrap();
    let aliases = thinking_aliases_from_yaml(&rendered).unwrap();

    assert!(rendered.contains("# Keep this comment"), "{rendered}");
    assert!(rendered.contains("service_tier: priority"), "{rendered}");
    assert_eq!(
        aliases,
        vec![ThinkingAliasEntry {
            source_model: "gpt-5.5".to_string(),
            alias: "gpt-5.5-xhigh".to_string(),
            effort: Some("xhigh".to_string()),
            provider: "Codex OAuth".to_string(),
            kind: "codex-oauth".to_string(),
            oauth_channel: Some("codex".to_string()),
        }]
    );
}

#[test]
fn model_alias_can_be_created_without_overrides() {
    let source = test_codex_oauth_thinking_source("gpt-5.5");
    let rendered = add_model_alias_to_yaml("{}\n", &source, "gpt-5.5-alias", "", false).unwrap();

    assert!(rendered.contains("alias: gpt-5.5-alias"), "{rendered}");
    assert!(!rendered.contains("payload:"), "{rendered}");
    assert_eq!(
        thinking_aliases_from_yaml(&rendered).unwrap(),
        vec![ThinkingAliasEntry {
            source_model: "gpt-5.5".to_string(),
            alias: "gpt-5.5-alias".to_string(),
            effort: None,
            provider: "Codex OAuth".to_string(),
            kind: "codex-oauth".to_string(),
            oauth_channel: Some("codex".to_string()),
        }]
    );
}

#[test]
fn configured_model_alias_can_be_created_without_overrides() {
    let input = "codex-api-key:\n  - api-key: test\n    base-url: https://example.com/v1\n    models:\n      - name: gpt-custom\n";
    let available_models = test_agent_models(&["gpt-custom"]);
    let sources = resolved_alias_sources(input, &[], &available_models, false).unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.model == "gpt-custom")
        .unwrap();
    let rendered = add_model_alias_to_yaml(input, source, "gpt-custom-alias", "", false).unwrap();

    assert!(rendered.contains("alias: gpt-custom-alias"), "{rendered}");
    assert!(!rendered.contains("thinking:"), "{rendered}");
    assert!(!rendered.contains("payload:"), "{rendered}");
    let entries = thinking_aliases_from_yaml(&rendered).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].effort, None);
}

#[test]
fn thinking_alias_removal_cleans_legacy_combined_rules() {
    let legacy = "oauth-model-alias:\n  codex:\n    - name: gpt-5.6-sol\n      alias: legacy-combined\n      fork: true\npayload:\n  override:\n    - models:\n        - name: legacy-combined\n          protocol: codex\n      params:\n        reasoning.effort: high\n    - models:\n        - name: legacy-combined\n          protocol: codex\n      params:\n        service_tier: priority\n";
    let restored = remove_thinking_alias_from_yaml(legacy, "legacy-combined").unwrap();
    assert!(!restored.contains("legacy-combined"), "{restored}");
    assert!(!restored.contains("service_tier: priority"), "{restored}");
}

#[test]
fn model_alias_combines_reasoning_and_fast_as_independent_overrides() {
    let source = test_codex_oauth_thinking_source("gpt-5.6-sol");
    let alias = "gpt-5.6-sol-high-fast";
    let rendered = add_model_alias_to_yaml("{}\n", &source, alias, "high", true).unwrap();

    assert!(rendered.contains("reasoning.effort: high"), "{rendered}");
    assert!(rendered.contains("service_tier: priority"), "{rendered}");
    let document: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
    let root = document.as_mapping().unwrap();
    let rules = nested_yaml_value(root, &["payload", "override"])
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    let alias_rules = rules
        .iter()
        .filter_map(serde_norway::Value::as_mapping)
        .filter(|rule| {
            yaml_mapping_value(rule, "models")
                .and_then(serde_norway::Value::as_sequence)
                .is_some_and(|models| {
                    models
                        .iter()
                        .any(|model| thinking_payload_model_matches(model, alias, "codex"))
                })
        })
        .collect::<Vec<_>>();

    assert_eq!(alias_rules.len(), 2, "{rendered}");
    assert!(alias_rules.iter().any(|rule| {
        yaml_mapping_value(rule, "params")
            .and_then(serde_norway::Value::as_mapping)
            .is_some_and(|params| {
                yaml_mapping_value(params, "reasoning.effort").is_some()
                    && yaml_mapping_value(params, "service_tier").is_none()
            })
    }));
    assert!(alias_rules.iter().any(|rule| {
        yaml_mapping_value(rule, "params")
            .and_then(serde_norway::Value::as_mapping)
            .is_some_and(|params| {
                yaml_mapping_value(params, "service_tier").is_some()
                    && yaml_mapping_value(params, "reasoning.effort").is_none()
            })
    }));
    assert_eq!(thinking_aliases_from_yaml(&rendered).unwrap().len(), 1);
    assert_eq!(speed_aliases_from_yaml(&rendered).unwrap().len(), 1);

    let restored = remove_thinking_alias_from_yaml(&rendered, alias).unwrap();
    assert!(!restored.contains(alias), "{restored}");
}

#[test]
fn speed_alias_adds_fast_service_tier_and_removes_only_its_rule() {
    let input = "payload:\n  override:\n    - models:\n        - name: existing-thinker\n          protocol: codex\n      params:\n        reasoning.effort: xhigh\n";
    let source = test_codex_oauth_thinking_source("gpt-5.6-sol");
    let rendered = add_speed_alias_to_yaml(input, &source, "gpt-5.6-sol-fast").unwrap();

    assert!(rendered.contains("alias: gpt-5.6-sol-fast"), "{rendered}");
    assert!(rendered.contains("service_tier: priority"), "{rendered}");
    assert!(!rendered.contains("reasoning.effort: fast"), "{rendered}");
    assert_eq!(
        speed_aliases_from_yaml(&rendered).unwrap(),
        vec![SpeedAliasEntry {
            source_model: "gpt-5.6-sol".to_string(),
            alias: "gpt-5.6-sol-fast".to_string(),
            service_tier: "priority".to_string(),
            provider: "Codex OAuth".to_string(),
            kind: "codex-oauth".to_string(),
            oauth_channel: Some("codex".to_string()),
        }]
    );

    let restored = remove_speed_alias_from_yaml(&rendered, "gpt-5.6-sol-fast").unwrap();
    assert!(!restored.contains("gpt-5.6-sol-fast"), "{restored}");
    assert!(restored.contains("reasoning.effort: xhigh"), "{restored}");
}

#[test]
fn speed_alias_supports_openai_compatible_model_entries() {
    let input = "openai-compatibility:\n  - name: Relay\n    base-url: https://example.com/v1\n    api-key-entries:\n      - api-key: test\n    models:\n      - name: gpt-5.6-terra\n        display-name: Terra\n";
    let available_models = test_agent_models(&["gpt-5.6-terra"]);
    let sources = resolved_thinking_alias_sources(input, &[], &available_models).unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.model == "gpt-5.6-terra")
        .unwrap();
    let rendered = add_speed_alias_to_yaml(input, source, "gpt-5.6-terra-fast").unwrap();

    assert!(rendered.contains("alias: gpt-5.6-terra-fast"), "{rendered}");
    assert!(
        rendered.contains("display-name: Terra (Fast)"),
        "{rendered}"
    );
    assert!(rendered.contains("protocol: openai"), "{rendered}");
    assert!(rendered.contains("service_tier: priority"), "{rendered}");
    assert_eq!(speed_aliases_from_yaml(&rendered).unwrap().len(), 1);

    let restored = remove_speed_alias_from_yaml(&rendered, "gpt-5.6-terra-fast").unwrap();
    assert!(!restored.contains("gpt-5.6-terra-fast"), "{restored}");
}

#[test]
fn speed_alias_sources_include_codex_models_without_reasoning_levels() {
    let definitions = vec![CodexModelDefinition {
        id: "gpt-speed-only".to_string(),
        display_name: None,
        description: None,
        context_window: None,
        reasoning_levels: Vec::new(),
        supports_tools: None,
    }];
    let available_models = test_agent_models(&["gpt-speed-only"]);

    assert!(
        resolved_thinking_alias_sources("{}", &definitions, &available_models)
            .unwrap()
            .is_empty()
    );
    let sources = resolved_speed_alias_sources("{}", &definitions, &available_models).unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source.model, "gpt-speed-only");
}

#[test]
fn thinking_alias_effort_accepts_provider_defined_levels() {
    assert_eq!(validate_thinking_alias_effort(" AUTO ").unwrap(), "auto");
    assert_eq!(validate_thinking_alias_effort("ultra").unwrap(), "ultra");
    assert_eq!(
        validate_thinking_alias_effort("vendor_level-2.1").unwrap(),
        "vendor_level-2.1"
    );
    assert!(validate_thinking_alias_effort("").is_err());
    assert!(validate_thinking_alias_effort("high value").is_err());
    assert!(validate_thinking_alias_effort("32768").is_err());
}

#[test]
fn thinking_alias_removal_keeps_other_models_in_grouped_rule() {
    let input = "oauth-model-alias:\n  codex:\n    - name: gpt-5.5\n      alias: gpt-5.5-xhigh\n      fork: true\n    - name: gpt-5.4\n      alias: gpt-5.4-xhigh\n      fork: true\npayload:\n  override:\n    - models:\n        - name: gpt-5.5-xhigh\n          protocol: codex\n        - name: gpt-5.4-xhigh\n          protocol: codex\n      params:\n        reasoning.effort: xhigh\n";
    let rendered = remove_thinking_alias_from_yaml(input, "gpt-5.5-xhigh").unwrap();
    let aliases = thinking_aliases_from_yaml(&rendered).unwrap();

    assert_eq!(aliases.len(), 1);
    assert_eq!(aliases[0].alias, "gpt-5.4-xhigh");
    assert!(!rendered.contains("gpt-5.5-xhigh"), "{rendered}");
    assert!(rendered.contains("gpt-5.4-xhigh"), "{rendered}");
    assert!(rendered.contains("reasoning.effort: xhigh"), "{rendered}");
}

#[test]
fn thinking_alias_rejects_duplicate_client_visible_name() {
    let input = "oauth-model-alias:\n  codex:\n    - name: gpt-5.5\n      alias: gpt-5.5-high\n      fork: true\n";
    let source = test_codex_oauth_thinking_source("gpt-5.4");
    assert!(
        add_model_alias_to_yaml(input, &source, "GPT-5.5-HIGH", "high", false)
            .unwrap_err()
            .contains("已存在")
    );
}

#[test]
fn thinking_alias_supports_openai_compatible_model_entries() {
    let input = "openai-compatibility:\n  - name: DeepSeek\n    base-url: https://api.deepseek.com\n    api-key-entries:\n      - api-key: test\n    models:\n      - name: deepseek-chat\n        display-name: DeepSeek Chat\n        thinking:\n          levels: [low, medium, high]\n";
    let available_models = test_agent_models(&["deepseek-chat"]);
    let sources = resolved_thinking_alias_sources(input, &[], &available_models).unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.model == "deepseek-chat")
        .unwrap();
    let rendered =
        add_model_alias_to_yaml(input, source, "deepseek-chat-high", "high", false).unwrap();
    let value: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
    let root = value.as_mapping().unwrap();
    let providers = yaml_mapping_value(root, "openai-compatibility")
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    let models = yaml_mapping_value(providers[0].as_mapping().unwrap(), "models")
        .and_then(serde_norway::Value::as_sequence)
        .unwrap();
    let alias_model = models[1].as_mapping().unwrap();

    assert_eq!(models.len(), 2);
    assert_eq!(
        yaml_mapping_value(alias_model, "name").and_then(serde_norway::Value::as_str),
        Some("deepseek-chat")
    );
    assert_eq!(
        yaml_mapping_value(alias_model, "alias").and_then(serde_norway::Value::as_str),
        Some("deepseek-chat-high")
    );
    assert!(rendered.contains("protocol: openai"), "{rendered}");
    assert!(rendered.contains("reasoning_effort: high"), "{rendered}");
    assert!(rendered.contains("thinking.type: enabled"), "{rendered}");
    assert!(!rendered.contains("oauth-model-alias"), "{rendered}");

    let entries = thinking_aliases_from_yaml(&rendered).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].provider, "DeepSeek");
    assert_eq!(entries[0].kind, "openai-compatible");

    let restored = remove_thinking_alias_from_yaml(&rendered, "deepseek-chat-high").unwrap();
    assert!(!restored.contains("deepseek-chat-high"), "{restored}");
    assert!(!restored.contains("reasoning_effort"), "{restored}");
}

#[test]
fn thinking_alias_supports_codex_api_model_entries() {
    let input = "codex-api-key:\n  - api-key: test\n    base-url: https://example.com/v1\n    models:\n      - name: gpt-custom\n";
    let available_models = test_agent_models(&["gpt-custom"]);
    let sources = resolved_thinking_alias_sources(input, &[], &available_models).unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.kind == "codex-api")
        .unwrap();
    let rendered =
        add_model_alias_to_yaml(input, source, "gpt-custom-xhigh", "xhigh", false).unwrap();

    assert!(rendered.contains("alias: gpt-custom-xhigh"), "{rendered}");
    assert!(rendered.contains("protocol: codex"), "{rendered}");
    assert!(rendered.contains("reasoning.effort: xhigh"), "{rendered}");
    assert!(!rendered.contains("oauth-model-alias"), "{rendered}");
    let entries = thinking_aliases_from_yaml(&rendered).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, "codex-api");
}

#[test]
fn speed_alias_supports_codex_api_model_entries() {
    let input = "codex-api-key:\n  - api-key: test\n    base-url: https://example.com/v1\n    models:\n      - name: codex-custom\n";
    let available_models = test_agent_models(&["codex-custom"]);
    let sources = resolved_speed_alias_sources(input, &[], &available_models).unwrap();
    let source = sources
        .iter()
        .find(|source| source.source.kind == "codex-api")
        .unwrap();
    let rendered = add_speed_alias_to_yaml(input, source, "codex-custom-fast").unwrap();

    assert!(rendered.contains("alias: codex-custom-fast"), "{rendered}");
    assert!(rendered.contains("protocol: codex"), "{rendered}");
    assert!(rendered.contains("service_tier: priority"), "{rendered}");
    assert!(!rendered.contains("oauth-model-alias"), "{rendered}");
    let entries = speed_aliases_from_yaml(&rendered).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, "codex-api");
}
