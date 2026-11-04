use super::*;

const CONFIG: &str = r#"# Preserve this operator comment.
config-version: 8
server: {host: 127.0.0.1, port: 8317, future: keep}
access: {api-keys: [client-secret]}
api-keys:
  codex:
    - name: shared-provider
      base-url: https://example.test/v1
      headers: {X-Shared: keep}
      models: [{name: upstream-primary, alias: public-primary}]
      keys:
        - {api-key: first-secret, weight: 2}
        - {api-key: second-secret, priority: null, models: null}
        - {api-key: private-secret, models: [{name: private-model}], headers: {}}
  openai-compatibility:
    - name: other-provider
      base-url: https://other.example.test/v1
      models: [{name: other-upstream, alias: public-primary}]
      keys: [{api-key: third-secret}]
oauth:
  auth-dir: unchanged-auth-dir
  model-alias:
    claude: [{name: claude-primary, alias: public-primary, fork: true}]
routing:
  strategy: round-robin
  model-fallback:
    enabled: false
    max-hops: 3
    on: []
    chains: {public-primary: [global-backup], unrelated: [keep]}
    future: unchanged
requests:
  proxy-url: direct
  payload:
    override:
      - models: [{name: public-primary, protocol: openai}]
        params: {reasoning.effort: high}
future: {nested: [one, two]}
"#;

fn snapshot(content: &str) -> Snapshot {
    Snapshot {
        content: content.into(),
        revision: "\"revision-1\"".into(),
    }
}

fn targets() -> Vec<String> {
    vec!["backup-two".into(), "backup-three".into()]
}

fn save(content: &str, client: &str, slot: &str) -> (String, AgentModelFallback) {
    let snapshot = snapshot(content);
    prepare_save(
        &snapshot,
        client,
        slot,
        "public-primary",
        "public-primary",
        &targets(),
        &snapshot.revision,
        &[],
    )
    .unwrap()
}

#[test]
fn round_trip_is_scoped_and_never_adopts_global_chains() {
    let direct = describe(
        CONFIG,
        "revision",
        "claude-code",
        "sonnet",
        "public-primary",
    )
    .unwrap();
    assert_eq!(direct.primary, "public-primary");
    assert!(direct.fallbacks.is_empty());
    let (content, expected) = save(CONFIG, "claude-code", "sonnet");
    let actual = describe(
        &content,
        &expected.revision,
        "claude-code",
        "sonnet",
        &expected.model,
    )
    .unwrap();
    assert_eq!(actual, expected);
    assert!(valid_claude_desktop_alias(&actual.model));
    for (client, slot) in [("claude-code", "opus"), ("codex", "sonnet")] {
        let unowned = describe(&content, "revision", client, slot, &actual.model).unwrap();
        assert_eq!(unowned.primary, actual.model);
        assert!(unowned.fallbacks.is_empty());
    }
    let root = legacy_view(&content).unwrap();
    assert_eq!(alias_entries(&root, &actual.model).len(), 4);
    assert!(alias_entries(&root, &actual.model)
        .iter()
        .all(|entry| !is_managed_claude_model_alias(entry, &actual.model)));
}

#[test]
fn native_configuration_credentials_and_unrelated_aliases_are_preserved() {
    let before = parse_native(CONFIG).unwrap();
    let (content, descriptor) = save(CONFIG, "claude-code", "sonnet");
    assert!(content.contains("# Preserve this operator comment."));
    let after = parse_native(&content).unwrap();
    for key in ["server", "access", "future"] {
        assert_eq!(after[key], before[key]);
    }
    assert_eq!(
        after["api-keys"]["codex"][0]["keys"],
        before["api-keys"]["codex"][0]["keys"]
    );
    assert_eq!(
        after["api-keys"]["openai-compatibility"][0]["keys"],
        before["api-keys"]["openai-compatibility"][0]["keys"]
    );
    assert_eq!(
        after["api-keys"]["codex"][0]["models"][0],
        before["api-keys"]["codex"][0]["models"][0]
    );
    assert_eq!(after["oauth"]["auth-dir"], before["oauth"]["auth-dir"]);
    assert_eq!(
        after["oauth"]["model-alias"]["claude"][0],
        before["oauth"]["model-alias"]["claude"][0]
    );
    let policy = &after["routing"]["model-fallback"];
    assert_eq!(policy["enabled"], Value::Bool(true));
    assert_eq!(
        policy["max-hops"],
        before["routing"]["model-fallback"]["max-hops"]
    );
    assert_eq!(policy["on"], before["routing"]["model-fallback"]["on"]);
    assert_eq!(
        policy["future"],
        before["routing"]["model-fallback"]["future"]
    );
    for name in ["public-primary", "unrelated"] {
        assert_eq!(
            policy["chains"][name],
            before["routing"]["model-fallback"]["chains"][name]
        );
    }
    assert_eq!(
        policy["chains"][descriptor.model.as_str()],
        Value::Sequence(targets().iter().map(|model| yaml_key(model)).collect())
    );
    let selectors = after["requests"]["payload"]["override"][0]["models"]
        .as_sequence()
        .unwrap();
    assert_eq!(selectors.len(), 2);
    assert_eq!(
        selectors[0],
        before["requests"]["payload"]["override"][0]["models"][0]
    );
    assert_eq!(selectors[1]["name"], yaml_key(&descriptor.model));
    assert_eq!(selectors[1]["protocol"], yaml_key("openai"));
    assert_eq!(
        after["requests"]["payload"]["override"][0]["params"],
        before["requests"]["payload"]["override"][0]["params"]
    );
}

#[test]
fn immutable_aliases_isolate_clients_slots_and_ordered_targets() {
    let (first_content, first) = save(CONFIG, "claude-code", "sonnet");
    for (client, slot) in [
        ("claude-code", "opus"),
        ("codex", "default"),
        ("claude-desktop", "desktop-0"),
    ] {
        let (content, next) = save(&first_content, client, slot);
        assert_ne!(first.model, next.model);
        assert!(valid_claude_desktop_alias(&next.model));
        assert_eq!(
            describe(
                &content,
                &first.revision,
                "claude-code",
                "sonnet",
                &first.model
            )
            .unwrap(),
            first
        );
    }
    let original = snapshot(&first_content);
    let mut reversed = targets();
    reversed.reverse();
    let (updated, second) = prepare_save(
        &original,
        "claude-code",
        "sonnet",
        &first.model,
        "public-primary",
        &reversed,
        &original.revision,
        &[],
    )
    .unwrap();
    assert_ne!(first.model, second.model);
    assert_eq!(
        describe(
            &updated,
            &first.revision,
            "claude-code",
            "sonnet",
            &first.model
        )
        .unwrap(),
        first
    );
    let (unchanged, repeated) = save(&first_content, "claude-code", "sonnet");
    assert_eq!(repeated, first);
    assert_eq!(
        parse_native(&unchanged).unwrap(),
        parse_native(&first_content).unwrap()
    );
    assert_ne!(
        alias_name("a-b", "c", "primary", &targets()),
        alias_name("a", "b-c", "primary", &targets())
    );
}

#[test]
fn empty_list_returns_primary_without_cleanup_or_global_enable() {
    for content in [CONFIG.to_string(), save(CONFIG, "claude-code", "sonnet").0] {
        let original = snapshot(&content);
        let (unchanged, descriptor) = prepare_save(
            &original,
            "claude-code",
            "sonnet",
            "public-primary",
            "public-primary",
            &[],
            &original.revision,
            &[],
        )
        .unwrap();
        assert_eq!(unchanged, original.content);
        assert_eq!(descriptor.model, "public-primary");
        assert_eq!(descriptor.primary, "public-primary");
        assert!(descriptor.fallbacks.is_empty());
    }
}

#[test]
fn stale_revisions_and_invalid_input_do_not_produce_a_write() {
    let original = snapshot(CONFIG);
    let error = prepare_save(
        &original,
        "claude-code",
        "sonnet",
        "public-primary",
        "public-primary",
        &targets(),
        "old",
        &[],
    )
    .unwrap_err();
    assert_eq!(error, CONFLICT);
    for value in ["", "../client", "a/b", "a b", "UPPER", "-slot", "a\n"] {
        assert!(validate_scope(value, "sonnet").is_err());
        assert!(validate_scope("claude-code", value).is_err());
    }
    assert!(validate_scope(&"a".repeat(49), "sonnet").is_err());
    assert!(validate_scope("claude-code", &"a".repeat(49)).is_err());
    for values in [
        vec!["public-primary".into()],
        vec!["same".into(), "SAME".into()],
        vec![" ".into()],
    ] {
        assert!(prepare_save(
            &original,
            "claude-code",
            "sonnet",
            "public-primary",
            "public-primary",
            &values,
            &original.revision,
            &[]
        )
        .is_err());
    }
    let too_many = vec!["a".into(), "b".into(), "c".into(), "d".into()];
    let error = prepare_save(
        &original,
        "claude-code",
        "sonnet",
        "public-primary",
        "public-primary",
        &too_many,
        &original.revision,
        &[],
    )
    .unwrap_err();
    assert!(error.contains("Adjust Maximum hops in Routing"));
}

#[test]
fn omitted_policy_gets_defaults_but_explicit_empty_conditions_stay_empty() {
    let mut native = parse_native(CONFIG).unwrap();
    native["routing"]
        .as_mapping_mut()
        .unwrap()
        .remove(yaml_key("model-fallback"));
    let (content, _) = save(
        &serde_norway::to_string(&native).unwrap(),
        "claude-code",
        "sonnet",
    );
    let stored = parse_native(&content).unwrap();
    let policy = &stored["routing"]["model-fallback"];
    assert_eq!(policy["max-hops"], Value::Number(2.into()));
    assert_eq!(
        policy["on"],
        serde_norway::from_str::<Value>("[429, quota_exhausted, auth_unavailable, 529]").unwrap()
    );
    let (content, _) = save(CONFIG, "claude-code", "sonnet");
    assert_eq!(
        parse_native(&content).unwrap()["routing"]["model-fallback"]["on"],
        Value::Sequence(vec![])
    );
}

#[test]
fn foreign_metadata_or_modified_chains_are_not_adopted_or_overwritten() {
    let (content, descriptor) = save(CONFIG, "claude-code", "sonnet");
    for tamper_metadata in [true, false] {
        let mut native = parse_native(&content).unwrap();
        if tamper_metadata {
            native["api-keys"]["codex"][0]["models"][1]["display-name"] =
                yaml_key("User-owned alias");
        } else {
            native["routing"]["model-fallback"]["chains"][descriptor.model.as_str()] =
                Value::Sequence(vec![yaml_key("different")]);
        }
        let content = serde_norway::to_string(&native).unwrap();
        let read = describe(
            &content,
            "revision",
            "claude-code",
            "sonnet",
            &descriptor.model,
        )
        .unwrap();
        assert_eq!(read.primary, descriptor.model);
        assert!(read.fallbacks.is_empty());
        let original = snapshot(&content);
        assert!(prepare_save(
            &original,
            "claude-code",
            "sonnet",
            "public-primary",
            "public-primary",
            &targets(),
            &original.revision,
            &[]
        )
        .unwrap_err()
        .contains("Reserved fallback alias"));
    }
}

#[test]
fn public_aliases_do_not_gain_unrelated_or_excluded_upstream_routes() {
    let mut native = parse_native(CONFIG).unwrap();
    let unrelated: Value = serde_norway::from_str("name: unrelated-source\nmodels: [{name: public-primary, alias: another-public-model}]\nkeys: [{api-key: untouched}]").unwrap();
    let excluded: Value = serde_norway::from_str("name: excluded-source\nmodels: [{name: blocked-upstream, alias: public-primary}]\nexcluded-models: [blocked-upstream]\nkeys: [{api-key: untouched}]").unwrap();
    let groups = native["api-keys"]["codex"].as_sequence_mut().unwrap();
    groups.push(unrelated.clone());
    groups.push(excluded.clone());
    let (content, _) = save(
        &serde_norway::to_string(&native).unwrap(),
        "claude-code",
        "sonnet",
    );
    let stored = parse_native(&content).unwrap();
    assert_eq!(stored["api-keys"]["codex"][1], unrelated);
    assert_eq!(stored["api-keys"]["codex"][2], excluded);

    let only_excluded = format!(
        "config-version: 8\napi-keys:\n  codex:\n{}",
        serde_norway::to_string(&Value::Sequence(vec![excluded]))
            .unwrap()
            .lines()
            .map(|line| format!("    {line}\n"))
            .collect::<String>()
    );
    let original = snapshot(&only_excluded);
    assert!(prepare_save(
        &original,
        "claude-code",
        "sonnet",
        "public-primary",
        "public-primary",
        &targets(),
        &original.revision,
        &[]
    )
    .is_err());
}

#[test]
fn implicit_provider_catalogs_are_never_inferred_or_replaced() {
    for models in ["", "      models: []\n"] {
        let content = format!("config-version: 8\napi-keys:\n  codex:\n    - name: implicit-provider\n      keys: [{{api-key: unchanged-secret}}]\n{models}");
        let original = snapshot(&content);
        let mut root = legacy_view(&content).unwrap();
        let before = root.clone();
        let alias = alias_name("claude-code", "sonnet", "gpt-primary", &targets());
        let error = append_aliases(
            &mut root,
            "gpt-primary",
            &alias,
            &metadata("claude-code", "sonnet", "gpt-primary"),
            &[],
        )
        .unwrap_err();
        assert!(error.contains("Configure an explicit provider model list"));
        assert_eq!(root, before);
        assert!(prepare_save(
            &original,
            "claude-code",
            "sonnet",
            "gpt-primary",
            "gpt-primary",
            &targets(),
            &original.revision,
            &[]
        )
        .unwrap_err()
        .contains("Implicit provider catalogs are not modified"));
        assert_eq!(original.content, content);
    }
}

#[test]
fn zero_maximum_hops_uses_default_without_widening_stored_policy() {
    let content = CONFIG.replace("max-hops: 3", "max-hops: 0");
    let (saved, _) = save(&content, "claude-code", "sonnet");
    assert_eq!(
        parse_native(&saved).unwrap()["routing"]["model-fallback"]["max-hops"],
        Value::Number(0.into())
    );
    let original = snapshot(&content);
    let three_targets = vec![
        "backup-two".into(),
        "backup-three".into(),
        "backup-four".into(),
    ];
    let error = prepare_save(
        &original,
        "claude-code",
        "sonnet",
        "public-primary",
        "public-primary",
        &three_targets,
        &original.revision,
        &[],
    )
    .unwrap_err();
    assert!(error.contains("Routing allows 2"));
    assert!(error.contains("Adjust Maximum hops in Routing"));
}

#[test]
fn only_strong_etags_allow_versioned_edits() {
    let mut headers = reqwest::header::HeaderMap::new();
    assert!(strong_etag(&headers).is_err());
    for value in ["W/\"weak\"", "unquoted", "*"] {
        headers.insert(reqwest::header::ETAG, value.parse().unwrap());
        assert!(strong_etag(&headers).is_err());
    }
    headers.insert(reqwest::header::ETAG, "\"source-hash\"".parse().unwrap());
    assert_eq!(strong_etag(&headers).unwrap(), "\"source-hash\"");
}

#[test]
fn pooled_upstream_members_survive_scoped_alias_creation() {
    let mut value = parse_native(CONFIG).unwrap();
    let api_member: Value =
        serde_norway::from_str("{name: second-upstream, alias: public-primary}").unwrap();
    value["api-keys"]["codex"][0]["models"]
        .as_sequence_mut()
        .unwrap()
        .push(api_member);
    let oauth_member: Value =
        serde_norway::from_str("{name: second-claude-upstream, alias: public-primary, fork: true}")
            .unwrap();
    value["oauth"]["model-alias"]["claude"]
        .as_sequence_mut()
        .unwrap()
        .push(oauth_member);
    let (content, descriptor) = save(
        &serde_norway::to_string(&value).unwrap(),
        "claude-code",
        "sonnet",
    );
    let root = legacy_view(&content).unwrap();
    let names: Vec<_> = alias_entries(&root, &descriptor.model)
        .into_iter()
        .filter_map(configured_model_identity)
        .map(|(name, _, _)| name)
        .collect();
    assert!(names.iter().any(|name| name == "upstream-primary"));
    assert!(names.iter().any(|name| name == "second-upstream"));
    assert!(names.iter().any(|name| name == "claude-primary"));
    assert!(names.iter().any(|name| name == "second-claude-upstream"));
}
