use super::support::*;
use super::*;
use crate::core_config::aliases::normalize_oauth_model_provider;
use crate::management_api::normalize_oauth_request_provider;

fn test_oauth_definition_set(channel: &str, models: &[&str]) -> OAuthModelDefinitions {
    OAuthModelDefinitions {
        channel: channel.to_string(),
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
            channel: channel.key.to_string(),
            force_mapping: channel.force_mapping,
        },
    }
}

struct OAuthProviderTestServer {
    config: GuiConfigFile,
    paths: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

impl OAuthProviderTestServer {
    async fn new(
        credentials: serde_json::Value,
        plugins: serde_json::Value,
        models: serde_json::Value,
    ) -> Self {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let paths = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let requests = paths.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 2048];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.to_ascii_lowercase()
                    .contains("authorization: bearer oauth-provider-test-key\r\n"));
                let path = request.split_whitespace().nth(1).unwrap();
                requests.lock().unwrap().push(path.to_string());
                let payload = match path {
                    "/v8/management/credentials" => Some(&credentials),
                    "/v8/management/plugins" => Some(&plugins),
                    _ => path.strip_prefix("/v8/management/routing/model-definitions/")
                        .and_then(|provider| models.get(provider)),
                }.filter(|payload| !payload.is_null());
                let (status, body) = if path == "/v8/management/config.yaml" {
                    ("200 OK", "config-version: 8\n".to_string())
                } else if let Some(payload) = payload {
                    ("200 OK", payload.to_string())
                } else {
                    ("404 Not Found", "{}".to_string())
                };
                socket.write_all(format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                ).as_bytes()).await.unwrap();
            }
        });
        Self {
            config: GuiConfigFile {
                port,
                management_secret_key: "oauth-provider-test-key".to_string(),
                ..GuiConfigFile::default()
            },
            paths,
            task,
        }
    }
}

impl Drop for OAuthProviderTestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn oauth_plugin_providers_from_credentials_and_plugins_reach_definitions() {
    let server = OAuthProviderTestServer::new(
        serde_json::json!({"files": [{"provider": " DouBao ", "type": " DOLA "}]}),
        serde_json::json!({"plugins_enabled": true, "plugins": [{
            "id": "doujie-oauth", "enabled": true, "effective_enabled": true,
            "supports_oauth": true, "oauth_provider": " SINGLE ",
            "oauth_providers": ["DOUBAO", "dola", "doubao"],
            "oauth_provider_entries": [{"identifier": " ENTRIES "}]
        }]}),
        serde_json::json!({
            "doubao": {"models": [{"id": "doubao-pro"}, {"id": "doubao"}]},
            "dola": {"models": [{"id": "dola-model"}]},
            "single": {"models": [{"id": "single-model"}]},
            "entries": {"models": [{"id": "entries-model"}]}
        }),
    ).await;
    let definitions = fetch_oauth_model_definitions(&server.config).await;
    assert_eq!(definitions, vec![
        test_oauth_definition_set("dola", &["dola-model"]),
        test_oauth_definition_set("doubao", &["doubao-pro", "doubao"]),
        test_oauth_definition_set("entries", &["entries-model"]),
        test_oauth_definition_set("single", &["single-model"]),
    ]);
    assert_eq!(server.paths.lock().unwrap().iter()
        .filter(|path| path.ends_with("/model-definitions/doubao")).count(), 1);
}

#[tokio::test]
async fn oauth_builtin_only_definitions_and_alias_yaml_remain_identical() {
    let credentials = serde_json::json!({"files": OAUTH_ALIAS_CHANNELS.iter()
        .map(|channel| serde_json::json!({"provider": channel.key})).collect::<Vec<_>>()});
    let models = OAUTH_ALIAS_CHANNELS.iter().map(|channel| (
        channel.key.to_string(),
        serde_json::json!({"models": [{"id": format!("{}-model", channel.key)}]}),
    )).collect::<serde_json::Map<_, _>>();
    let server = OAuthProviderTestServer::new(
        credentials, serde_json::json!({"plugins": []}), serde_json::Value::Object(models),
    ).await;
    let expected = OAUTH_ALIAS_CHANNELS.iter().map(|channel| {
        test_oauth_definition_set(channel.key, &[&format!("{}-model", channel.key)])
    }).collect::<Vec<_>>();
    let definitions = fetch_oauth_model_definitions(&server.config).await;
    assert_eq!(definitions, expected);
    for definition in &expected {
        let mappings = ClaudeDesktopModelMappings::all(&definition.models[0].id);
        let available = test_agent_models(&[&definition.models[0].id]);
        assert_eq!(
            ensure_claude_desktop_model_aliases_with_oauth_definitions_in_yaml(
                "config-version: 8\n", &mappings, &available, &definitions).unwrap(),
            ensure_claude_desktop_model_aliases_with_oauth_definitions_in_yaml(
                "config-version: 8\n", &mappings, &available, &expected).unwrap(),
        );
    }
}

#[tokio::test]
async fn oauth_builtin_active_filter_and_discovery_failure_fallback_are_preserved() {
    for credentials in [
        serde_json::json!({"files": [{"provider": "anthropic"}, {"type": "anti-gravity"}]}),
        serde_json::Value::Null,
    ] {
        let unavailable = credentials.is_null();
        let server = OAuthProviderTestServer::new(credentials, serde_json::Value::Null,
            serde_json::json!({"claude": {"models": [{"id": "claude-model"}]},
                "antigravity": {"models": [{"id": "antigravity-model"}]}}),
        ).await;
        assert_eq!(fetch_oauth_model_definitions(&server.config).await, vec![
            test_oauth_definition_set("antigravity", &["antigravity-model"]),
            test_oauth_definition_set("claude", &["claude-model"]),
        ]);
        let paths = server.paths.lock().unwrap();
        assert_eq!(paths.iter().filter(|path| path.contains("/model-definitions/")).count(),
            if unavailable { OAUTH_ALIAS_CHANNELS.len() } else { 2 });
    }
}

#[tokio::test]
async fn oauth_unknown_provider_404_is_skipped_without_error() {
    let server = OAuthProviderTestServer::new(
        serde_json::json!({"files": [{"provider": "missing"}, {"provider": "doubao"}]}),
        serde_json::json!({"plugins": []}),
        serde_json::json!({"doubao": {"models": [{"id": "doubao-pro"}]}}),
    ).await;
    assert_eq!(fetch_oauth_model_definitions(&server.config).await,
        vec![test_oauth_definition_set("doubao", &["doubao-pro"])]);
    assert!(server.paths.lock().unwrap().iter()
        .any(|path| path.ends_with("/model-definitions/missing")));
}

#[tokio::test]
async fn oauth_disabled_unavailable_credentials_and_inactive_plugins_are_excluded() {
    let server = OAuthProviderTestServer::new(
        serde_json::json!({"files": [
            {"provider": "disabled", "disabled": true},
            {"type": "unavailable", "unavailable": true},
            {"provider": "", "type": " Active "},
            {"provider": "../unsafe"}, {"provider": "not safe"}
        ]}),
        serde_json::json!({"plugins": [
            {"enabled": false, "supports_oauth": true, "oauth_providers": ["disabled-plugin"]},
            {"enabled": true, "effective_enabled": false, "oauth_provider": "inactive-plugin"},
            {"enabled": true, "supports_oauth": false, "oauth_provider": "non-oauth"},
            {"enabled": true, "oauth_providers": ["", "../unsafe", "not safe", "bad?query", "bad#fragment"]}
        ]}),
        serde_json::json!({"active": {"models": [{"id": "active-model"}]}}),
    ).await;
    assert_eq!(fetch_oauth_model_definitions(&server.config).await,
        vec![test_oauth_definition_set("active", &["active-model"])]);
    assert_eq!(*server.paths.lock().unwrap(), [
        "/v8/management/credentials", "/v8/management/plugins",
        "/v8/management/routing/model-definitions/active",
    ]);
}

#[tokio::test]
async fn oauth_plugin_provider_resolves_claude_desktop_mapping_preparation() {
    let server = OAuthProviderTestServer::new(
        serde_json::json!({"files": [{"provider": "doubao"}]}),
        serde_json::json!({"plugins": [{"enabled": true, "supports_oauth": true,
            "oauth_providers": ["doubao", "dola"]}]}),
        serde_json::json!({"doubao": {"models": [{"id": "doubao-pro"}, {"id": "doubao"}]}}),
    ).await;
    let mut mappings = ClaudeDesktopModelMappings::all("doubao-pro");
    mappings.desktop_models = Some(vec![
        ClaudeDesktopModelMapping {
            model: "doubao-pro".to_string(), alias: "claude-sonnet-5-5".to_string(), context_1m: true,
        },
        ClaudeDesktopModelMapping {
            model: "doubao".to_string(), alias: "claude-haiku-5-5".to_string(), context_1m: false,
        },
    ]);
    let available = test_agent_models(&["doubao-pro", "doubao"]);
    let (_, after) = prepare_desktop_core_update(&server.config, &mut mappings, &available).await.unwrap();
    let document: serde_norway::Value = serde_norway::from_str(&after).unwrap();
    let aliases = document["oauth-model-alias"]["doubao"].as_sequence().unwrap();
    for (model, alias) in [("doubao-pro", "claude-sonnet-5-5"), ("doubao", "claude-haiku-5-5")] {
        assert!(aliases.iter().any(|entry| entry["name"].as_str() == Some(model)
            && entry["alias"].as_str() == Some(alias) && entry["fork"].as_bool() == Some(true)));
    }
    assert!(mappings.desktop_models.as_ref().unwrap()[0].context_1m);
    assert!(!mappings.desktop_models.as_ref().unwrap()[1].context_1m);
    assert_eq!(resolve_available_agent_model(&available, "doubao-pro").unwrap(), "doubao-pro");
}

#[test]
fn oauth_plugin_alias_sources_and_editing_keep_runtime_channels_and_force_mapping() {
    let definitions = [test_oauth_definition_set("doubao", &["doubao-pro"])];
    let available = test_agent_models(&["doubao-pro"]);
    for force_mapping in [false, true] {
        let input = format!("oauth-model-alias:\n  doubao:\n    - name: other\n      alias: existing\n      force-mapping: {force_mapping}\n");
        let sources = resolved_oauth_alias_sources(&input, &definitions, &available, AliasSourceCapability::Base).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].location, ThinkingAliasSourceLocation::Oauth {
            channel: "doubao".to_string(), force_mapping,
        });
        assert!(resolved_oauth_alias_sources(&input, &definitions, &available,
            AliasSourceCapability::Fast).unwrap().is_empty());
        let rendered = add_model_alias_to_yaml(&input, &sources[0], "plugin-alias", "", false).unwrap();
        let entries = thinking_aliases_from_yaml(&rendered).unwrap();
        let entry = entries.iter().find(|entry| entry.alias == "plugin-alias").unwrap();
        for selected in [None, Some(entry)] {
            let source = resolve_model_alias_edit_source_for_mapping(
                &rendered, "plugin-alias", &definitions, selected).unwrap();
            assert_eq!(source.location, sources[0].location);
        }
        let edited = edit_model_alias_in_yaml(&rendered, "plugin-alias", &sources[0], "renamed-plugin-alias", "", false).unwrap();
        let document: serde_norway::Value = serde_norway::from_str(&edited).unwrap();
        let alias = document["oauth-model-alias"]["doubao"].as_sequence().unwrap().iter()
            .find(|entry| entry["alias"].as_str() == Some("renamed-plugin-alias")).unwrap();
        assert_eq!(alias["force-mapping"].as_bool().unwrap_or(false), force_mapping);
        let mappings = ClaudeDesktopModelMappings::all("doubao-pro");
        let desktop = ensure_claude_desktop_model_aliases_with_oauth_definitions_in_yaml(
            &input, &mappings, &available, &definitions).unwrap();
        let document: serde_norway::Value = serde_norway::from_str(&desktop).unwrap();
        assert!(document["oauth-model-alias"]["doubao"].as_sequence().unwrap().iter()
            .filter(|entry| entry["name"].as_str() == Some("doubao-pro"))
            .all(|entry| entry["force-mapping"].as_bool().unwrap_or(false) == force_mapping));
    }
}

#[test]
fn oauth_discovered_provider_ids_match_the_oauth_submission_contract() {
    // Discovery and OAuth submission must agree on what a legal provider id is.
    // Submission accepts lowercase letters, digits and hyphen only, so discovery
    // must reject the same shapes instead of silently keeping an unusable id.
    for provider in ["doubao", "custom-sso", "plugin2", "a"] {
        assert_eq!(
            normalize_oauth_model_provider(provider).as_deref(),
            Some(provider),
            "{provider} should be a legal provider id"
        );
    }
    assert_eq!(
        normalize_oauth_model_provider(" Custom-SSO ").as_deref(),
        Some("custom-sso")
    );
    for provider in ["", "   ", "custom_sso", "custom.sso", "custom sso", "custom/sso"] {
        assert_eq!(
            normalize_oauth_model_provider(provider),
            None,
            "{provider:?} must not be discovered because submission would reject it"
        );
    }
    // Anything discovery accepts must also be accepted by the submission path.
    for provider in ["doubao", "custom-sso", "plugin2"] {
        assert_eq!(
            normalize_oauth_request_provider(provider, true).unwrap(),
            normalize_oauth_model_provider(provider).unwrap()
        );
    }
}

#[test]
fn oauth_plugin_alias_force_mapping_is_channel_level_and_built_ins_use_the_table() {
    // Plugin channels have no static definition, so the flag comes from the
    // kernel config and applies to the channel as a whole.
    let plugin_root: serde_norway::Mapping = serde_norway::from_str(
        "oauth-model-alias:\n  doubao:\n    - name: other\n      alias: existing\n      force-mapping: true\n",
    )
    .unwrap();
    assert!(oauth_alias_force_mapping(&plugin_root, "doubao"));
    assert!(!oauth_alias_force_mapping(&plugin_root, "dola"));

    // A built-in channel keeps its static table value even when the config says
    // otherwise, which is what preserves the existing built-in behaviour.
    let builtin_root: serde_norway::Mapping = serde_norway::from_str(
        "oauth-model-alias:\n  antigravity:\n    - name: other\n      alias: existing\n      force-mapping: false\n",
    )
    .unwrap();
    let table = oauth_alias_channel("antigravity").unwrap().force_mapping;
    assert_eq!(oauth_alias_force_mapping(&builtin_root, "antigravity"), table);
}

#[test]
fn oauth_credential_plugin_provider_field_is_discovered() {
    // Plugin-managed credentials may populate only oauth_provider.
    let files = serde_json::json!({"files": [
        {"oauth_provider": "doubao"},
        {"provider": "dola"},
        {"type": "codex"},
        {"provider": "claude", "oauth_provider": "doubao"},
        {"provider": "ignored", "disabled": true},
    ]});
    let mut discovered = std::collections::BTreeSet::new();
    for file in files["files"].as_array().unwrap() {
        if file.get("disabled").and_then(serde_json::Value::as_bool) == Some(true) {
            continue;
        }
        for value in ["provider", "oauth_provider", "type"]
            .into_iter()
            .filter_map(|key| file.get(key).and_then(serde_json::Value::as_str))
            .filter_map(normalize_oauth_model_provider)
        {
            discovered.insert(value);
        }
    }
    assert!(discovered.contains("doubao"));
    assert!(discovered.contains("dola"));
    assert!(discovered.contains("codex"));
    assert!(discovered.contains("claude"));
    assert!(!discovered.contains("ignored"));
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
    assert_eq!(normalize_oauth_alias_channel("meta"), Some("meta"));
    assert_eq!(normalize_oauth_alias_channel(" Muse "), Some("meta"));
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
fn alias_sources_exclude_blocked_providers_even_when_another_provider_serves_the_model() {
    for section in ["codex-api-key", "openai-compatibility", "claude-api-key", "gemini-api-key"] {
        let input = format!(r#"
{section}:
  - name: disabled
    disabled: true
    models: [{{name: upstream, alias: gpt-test, thinking: {{levels: [low, high]}}}}]
  - name: disabled-with-wildcard
    excluded-models: ['*']
    models: [{{name: upstream, alias: gpt-test, thinking: {{levels: [low, high]}}}}]
  - name: excluded-exactly
    excluded-models: [' GPT-TEST ']
    models: [{{name: upstream, alias: gpt-test, thinking: {{levels: [low, high]}}}}]
  - name: excluded-by-pattern
    excluded-models: ['gpt-*']
    models: [{{name: upstream, alias: gpt-test, thinking: {{levels: [low, high]}}}}]
  - name: active
    excluded-models: [unrelated]
    models: [{{name: upstream, alias: gpt-test, thinking: {{levels: [low, high]}}}}]
"#);
        for capability in [AliasSourceCapability::Base, AliasSourceCapability::Reasoning, AliasSourceCapability::Fast] {
            if capability == AliasSourceCapability::Fast
                && !matches!(section, "codex-api-key" | "openai-compatibility")
            {
                continue;
            }
            let sources = resolved_oauth_alias_sources(
                &input, &[], &test_agent_models(&["gpt-test"]), capability,
            ).unwrap();
            assert_eq!(sources.len(), 1, "{section}: blocked providers must not borrow availability");
            assert_eq!(sources[0].source.provider, "active");
            assert!(matches!(sources[0].location,
                ThinkingAliasSourceLocation::ConfigModel { provider_index: 4, model_index: 0, .. }
            ));
        }
    }
}

#[test]
fn alias_sources_do_not_offer_entries_that_are_already_aliases() {
    let input = r#"
codex-api-key:
  - name: active
    models:
      - name: gpt-test
        thinking:
          levels: [low, high]
      - name: gpt-test
        alias: gpt-test-high
        thinking:
          levels: [low, high]
      - name: GPT-Test
        alias: gpt-test-fast
"#;
    let available = test_agent_models(&["gpt-test", "gpt-test-high", "gpt-test-fast"]);
    for capability in [
        AliasSourceCapability::Base,
        AliasSourceCapability::Reasoning,
        AliasSourceCapability::Fast,
    ] {
        let sources = resolved_oauth_alias_sources(input, &[], &available, capability).unwrap();
        assert_eq!(sources.len(), 1, "{capability:?}");
        assert_eq!(sources[0].source.model, "gpt-test");
        assert!(matches!(
            sources[0].location,
            ThinkingAliasSourceLocation::ConfigModel { model_index: 0, .. }
        ));
    }
    let plain = resolved_oauth_alias_sources(input, &[], &available, AliasSourceCapability::Base).unwrap();
    let created = add_model_alias_to_yaml(input, &plain[0], "gpt-test-again", "high", false).unwrap();
    assert!(created.contains("alias: gpt-test-again"), "{created}");
    let context = model_alias_edit_context(input, "gpt-test-high", &[]).unwrap();
    assert_eq!(context.source.model, "gpt-test");
}

#[test]
fn v8_alias_creation_uses_the_enabled_source_and_keeps_disabled_aliases_editable() {
    let input = r#"
config-version: 8
api-keys:
  codex:
    - name: disabled-luna
      excluded-models: ['*']
      models:
        - name: gpt-5.6-luna
        - name: gpt-5.6-luna
          alias: gpt-5.6-luna-max-fast-fp
      keys: [{api-key: disabled-test-key}]
    - name: active-luna
      models: [{name: gpt-5.6-luna}]
      keys: [{api-key: active-test-key}]
"#;
    let content = management_v8_yaml_to_legacy_view(input).unwrap();
    let sources = resolved_oauth_alias_sources(
        &content, &[], &test_agent_models(&["gpt-5.6-luna"]), AliasSourceCapability::Base,
    ).unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source.provider, "active-luna");
    let updated = add_model_alias_to_yaml(
        &content, &sources[0], "luna-active-max-fast", "max", true,
    ).unwrap();
    let before: serde_norway::Value = serde_norway::from_str(&content).unwrap();
    let after: serde_norway::Value = serde_norway::from_str(&updated).unwrap();
    assert_eq!(before["codex-api-key"][0], after["codex-api-key"][0]);
    assert_eq!(after["codex-api-key"][1]["models"][1]["alias"].as_str(), Some("luna-active-max-fast"));
    let context = model_alias_edit_context(&updated, "luna-active-max-fast", &[]).unwrap();
    assert_eq!(context.effort.as_deref(), Some("max"));
    assert!(context.fast);
    let disabled = model_alias_edit_context(&updated, "gpt-5.6-luna-max-fast-fp", &[]).unwrap();
    assert_eq!(disabled.source.provider, "disabled-luna");
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
            channel: "antigravity".to_string(),
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
            position: ModelAliasPosition { section: "oauth-model-alias".into(), provider_index: None, model_index: 0 },
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
            position: ModelAliasPosition { section: "oauth-model-alias".into(), provider_index: None, model_index: 0 },
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
            position: ModelAliasPosition { section: "oauth-model-alias".into(), provider_index: None, model_index: 0 },
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
fn existing_aliases_with_spaces_can_be_loaded_and_deleted() {
    assert_eq!(
        existing_thinking_alias_model_id(" Codex Auto Review ", "Alias model").unwrap(),
        "Codex Auto Review"
    );
    assert!(validate_thinking_alias_model_id("Codex Auto Review", "Alias model").is_err());
    let content = "codex-api-key:\n  - name: provider\n    base-url: https://www.loomex.cc\n    models:\n      - name: codex-auto-review\n        alias: Codex Auto Review\n      - name: keep-me\n";
    let entries = thinking_aliases_from_yaml(content).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].alias, "Codex Auto Review");
    assert_eq!(entries[0].source_model, "codex-auto-review");
    let context = model_alias_edit_context(content, "Codex Auto Review", &[]).unwrap();
    assert_eq!(context.source.model, "codex-auto-review");
    let deleted = remove_thinking_alias_from_yaml(content, "Codex Auto Review").unwrap();
    assert!(thinking_aliases_from_yaml(&deleted).unwrap().is_empty());
    assert!(deleted.contains("name: keep-me"));
    assert!(!deleted.contains("Codex Auto Review"));
    let source = resolve_model_alias_edit_source(content, "Codex Auto Review", &[]).unwrap();
    let renamed = edit_model_alias_in_yaml(
        content,
        "Codex Auto Review",
        &source,
        "codex-auto-review-alias",
        "",
        false,
    )
    .unwrap();
    let renamed_entries = thinking_aliases_from_yaml(&renamed).unwrap();
    assert_eq!(renamed_entries.len(), 1);
    assert_eq!(renamed_entries[0].alias, "codex-auto-review-alias");
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
fn thinking_alias_allows_duplicate_client_visible_name() {
    let input = "oauth-model-alias:\n  codex:\n    - name: gpt-5.5\n      alias: gpt-5.5-high\n      fork: true\n";
    let source = test_codex_oauth_thinking_source("gpt-5.4");
    let updated = add_model_alias_to_yaml(input, &source, "GPT-5.5-HIGH", "high", false).unwrap();
    assert_eq!(thinking_aliases_from_yaml(&updated).unwrap().len(), 2);
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

#[test]
fn edit_model_alias_replaces_name_effort_and_fast_in_memory() {
    let source = test_oauth_thinking_source("codex", "gpt-test");
    let original =
        add_model_alias_to_yaml("port: 8317\n", &source, "old-alias", "high", true).unwrap();
    let updated = edit_model_alias_in_yaml(&original, "old-alias", &source, "new-alias", "low", false).unwrap();
    let entries = thinking_aliases_from_yaml(&updated).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].alias, "new-alias");
    assert_eq!(entries[0].effort.as_deref(), Some("low"));
    assert!(speed_aliases_from_yaml(&updated).unwrap().is_empty());
    assert!(updated.contains("port: 8317"));
    assert!(!updated.contains("old-alias"));
    let unchanged_name =
        edit_model_alias_in_yaml(&original, "old-alias", &source, "old-alias", "", false).unwrap();
    assert_eq!(
        thinking_aliases_from_yaml(&unchanged_name).unwrap()[0].effort,
        None
    );
}

#[test]
fn edit_model_alias_rejects_missing_and_ambiguous_aliases() {
    assert!(resolve_model_alias_edit_source("port: 8317\n", "missing", &[]).is_err());
    let content = "oauth-model-alias:\n  codex:\n    - name: model-a\n      alias: shared\n  claude:\n    - name: model-b\n      alias: shared\n";
    assert!(resolve_model_alias_edit_source(content, "shared", &[]).is_err());
}

#[test]
fn devin_aliases_use_the_devin_channel_without_unsupported_overrides() {
    assert_eq!(normalize_oauth_alias_channel("cognition"), Some("devin"));
    let available_models = test_agent_models(&["devin/swe-2"]);
    let mut definitions = test_oauth_definition_set("devin", &["devin/swe-2"]);
    definitions.models[0].reasoning_levels = vec!["medium".to_string(), "high".to_string()];
    let definitions = vec![definitions];
    let sources = resolved_oauth_alias_sources("{}\n", &definitions, &available_models, AliasSourceCapability::Base).unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source.kind, "devin-oauth");
    let rendered = add_model_alias_to_yaml("{}\n", &sources[0], "swe-2", "", false).unwrap();
    assert!(rendered.contains("devin:"), "{rendered}");
    assert!(rendered.contains("name: devin/swe-2"), "{rendered}");
    assert!(rendered.contains("alias: swe-2"), "{rendered}");
    assert!(!rendered.contains("payload:"), "{rendered}");
    let edited = model_alias_edit_context(&rendered, "swe-2", &definitions).unwrap();
    assert!(edited.source.reasoning_levels.is_empty());
    for capability in [AliasSourceCapability::Reasoning, AliasSourceCapability::Fast] {
        assert!(resolved_oauth_alias_sources("{}\n", &definitions, &available_models, capability).unwrap().is_empty());
    }
}

#[test]
fn ultrafast_alias_round_trip_preserves_effort_and_can_switch_tiers() {
    let source = test_codex_oauth_thinking_source("gpt-6.1-sol");
    let created = add_model_alias_with_tier_to_yaml("debug: true\n", &source, "sol-ultrafast", "high", Some("ultrafast")).unwrap();
    assert_eq!(speed_aliases_from_yaml(&created).unwrap()[0].service_tier, "ultrafast");
    let context = model_alias_edit_context(&created, "sol-ultrafast", &[]).unwrap();
    assert_eq!(context.service_tier.as_deref(), Some("ultrafast"));
    assert_eq!(context.effort.as_deref(), Some("high"));
    let resolved = resolve_model_alias_edit_source_for_mapping(&created, "sol-ultrafast", &[], None).unwrap();
    let unchanged = edit_model_alias_with_tier_in_yaml_for_mapping(&created, "sol-ultrafast", &resolved, "sol-ultrafast", "high", Some("ultrafast"), None).unwrap();
    assert_eq!(created, unchanged);
    let fast = edit_model_alias_with_tier_in_yaml_for_mapping(&created, "sol-ultrafast", &resolved, "sol-fast", "high", Some("priority"), None).unwrap();
    assert_eq!(speed_aliases_from_yaml(&fast).unwrap()[0].service_tier, "priority");
    let disabled = edit_model_alias_with_tier_in_yaml_for_mapping(&created, "sol-ultrafast", &resolved, "sol-high", "high", None, None).unwrap();
    assert!(speed_aliases_from_yaml(&disabled).unwrap().is_empty());
    assert_eq!(thinking_aliases_from_yaml(&disabled).unwrap()[0].effort.as_deref(), Some("high"));
    assert!(add_model_alias_with_tier_to_yaml("{}", &source, "invalid", "", Some("invalid")).is_err());
    let removed = remove_thinking_alias_from_yaml(&created, "sol-ultrafast").unwrap();
    assert!(!removed.contains("ultrafast"));
    assert!(removed.contains("debug: true"));
}

#[test]
fn ultrafast_alias_edits_raw_tier_without_changing_unrelated_params() {
    let input = "oauth-model-alias:\n  codex: [{name: gpt-6.1-sol, alias: sol, fork: true}]\npayload:\n  override-raw:\n    - models: [{name: sol, protocol: codex}]\n      params: {service_tier: '\"priority\"', temperature: '0.2'}\n";
    let source = resolve_model_alias_edit_source_for_mapping(input, "sol", &[], None).unwrap();
    let updated = edit_model_alias_with_tier_in_yaml_for_mapping(input, "sol", &source, "sol", "", Some("ultrafast"), None).unwrap();
    let value: serde_json::Value = serde_norway::from_str(&updated).unwrap();
    assert_eq!(value["payload"]["override-raw"][0]["params"]["service_tier"], "\"ultrafast\"");
    assert_eq!(value["payload"]["override-raw"][0]["params"]["temperature"], "0.2");
}
