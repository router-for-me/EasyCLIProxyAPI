use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const CURRENT: &str = "oauth-model-alias:\n  codex:\n    - name: gpt-test\n      alias: my-alias\n      fork: true\npayload:\n  override:\n    - models: [{name: my-alias, protocol: codex}]\n      params: {reasoning.effort: high}\n";

#[test]
fn v8_management_yaml_is_projected_to_the_legacy_alias_editor_view() {
    let input = "config-version: 8\naccess: {api-keys: [client-key]}\noauth:\n  model-alias: {codex: [{name: upstream, alias: public, fork: true}]}\nrequests:\n  payload: {override: [{models: [{name: public}], params: {reasoning.effort: high}}]}\napi-keys:\n  codex:\n    - name: codex-group\n      base-url: https://codex.example/v1\n      models: [{name: model-a}]\n      keys:\n        - {api-key: first, priority: 7}\n        - {api-key: second, priority: null}\n  openai-compatibility:\n    - name: openai-group\n      base-url: https://openai.example/v1\n      keys: [{api-key: third}]\n    - name: empty-openai-group\n      base-url: https://empty.example/v1\n      keys: []\n";
    let view = yaml_json(&management_v8_yaml_to_legacy_view(input).unwrap());
    assert_eq!(view["api-keys"], serde_json::json!(["client-key"]));
    assert_eq!(view["oauth-model-alias"]["codex"][0]["alias"], "public");
    assert_eq!(view["payload"]["override"][0]["params"]["reasoning.effort"], "high");
    assert!(view["access"].get("api-keys").is_none());
    assert!(view["oauth"].get("model-alias").is_none());
    assert!(view["requests"].get("payload").is_none());
    assert_eq!(view["codex-api-key"][0]["api-key"], "first");
    assert_eq!(view["codex-api-key"][0]["priority"], 7);
    assert_eq!(view["codex-api-key"][0]["models"][0]["name"], "model-a");
    assert_eq!(view["codex-api-key"][1]["api-key"], "second");
    assert!(view["codex-api-key"][1].get("priority").is_none());
    assert_eq!(
        view["openai-compatibility"][0]["api-key-entries"][0]["api-key"],
        "third"
    );
    assert!(view["openai-compatibility"][1]
        .get("api-key-entries")
        .is_none());
    assert_eq!(view["gemini-api-key"], serde_json::json!([]));
}

#[test]
fn non_v8_management_yaml_is_returned_without_reformatting() {
    let input = "# mock legacy config\nport: 8317\n";
    assert_eq!(management_v8_yaml_to_legacy_view(input).unwrap(), input);
}

#[test]
fn v8_alias_projection_normalizes_empty_parents_but_preserves_siblings() {
    let project = |input| yaml_json(&management_v8_yaml_to_legacy_view(input).unwrap());
    assert_eq!(
        project("config-version: 8\n"),
        project("config-version: 8\naccess: {}\noauth: {}\nrequests: {}\n")
    );
    let view = project("config-version: 8\noauth: {auth-dir: credentials, model-alias: {}}\nrequests: {proxy-url: direct, payload: {}}\n");
    assert_eq!(view["oauth"]["auth-dir"], "credentials");
    assert_eq!(view["requests"]["proxy-url"], "direct");
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_creates_first_oauth_and_payload_nodes() {
    let core = MockCore::new_v8("config-version: 8\n", Failure::None);
    let current = fetch_management_config_yaml(&core.config).await.unwrap();
    let updated = format!("{current}{CURRENT}");
    put_management_alias_config_changes(&core.config, &current, &updated)
        .await
        .unwrap();
    let (persisted, _) = core.finish();
    assert_eq!(persisted["oauth-model-alias"], yaml_json(CURRENT)["oauth-model-alias"]);
    assert_eq!(persisted["payload"], yaml_json(CURRENT)["payload"]);
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_rolls_back_a_new_payload_parent() {
    let initial = "oauth-model-alias: {codex: [{name: gpt-test, alias: my-alias, fork: true}]}\n";
    let core = MockCore::new_v8(initial, Failure::YamlAfterWrite);
    let current = fetch_management_config_yaml(&core.config).await.unwrap();
    let updated = format!("{}payload: {{override: []}}\n", current.replace("my-alias", "renamed"));
    let error = put_management_alias_config_changes(&core.config, &current, &updated)
        .await
        .unwrap_err();
    assert!(error.contains("Original configuration was restored"), "{error}");
    let (persisted, _) = core.finish();
    assert_eq!(persisted, yaml_json(initial));
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Failure {
    None,
    YamlBeforeWrite,
    SecondYamlBeforeWrite,
    YamlAfterWrite,
    OauthAfterWrite,
    Rollback,
    ForeignChange,
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_rejects_loss_of_api_access_before_any_write() {
    let initial = format!("{CURRENT}codex-api-key:\n  - api-key: test-key\n    base-url: https://example.test\n    models: [{{name: model-a}}]\nopenai-compatibility:\n  - name: preserved\n    disabled: true\n    api-key-entries: [{{api-key: other-test-key}}]\n    models: [{{name: model-b}}]\n");
    for section in ["codex-api-key", "openai-compatibility"] {
        for mode in ["missing", "empty", "credential"] {
            let mut corrupted = yaml_json(&initial);
            match mode {
                "missing" => {
                    corrupted.as_object_mut().unwrap().remove(section);
                }
                "empty" => corrupted[section] = serde_json::json!([]),
                _ => {
                    corrupted[section][0]
                        .as_object_mut()
                        .unwrap()
                        .retain(|key, _| !key.starts_with("api-key"));
                }
            }
            let core = MockCore::new(&initial, Failure::None);
            let result = put_management_alias_config_changes(
                &core.config,
                &initial,
                &serde_norway::to_string(&corrupted).unwrap(),
            )
            .await;
            let (persisted, requests) = core.finish();
            assert!(
                result.is_err(),
                "accepted provider loss: {section}/{mode}"
            );
            assert_eq!(persisted, yaml_json(&initial));
            assert!(!requests.iter().any(|request| request.starts_with("PUT")));
        }
    }
}

struct MockCore {
    config: GuiConfigFile,
    finished: Arc<AtomicBool>,
    server: Option<std::thread::JoinHandle<(serde_json::Value, Vec<String>)>>,
}

impl MockCore {
    fn new(initial: &str, failure: Failure) -> Self {
        Self::with_response_layout(initial, failure, false)
    }

    fn new_v8(initial: &str, failure: Failure) -> Self {
        Self::with_response_layout(initial, failure, true)
    }

    fn with_response_layout(initial: &str, failure: Failure, v8_response: bool) -> Self {
        assert!(!current_core_tls_settings().unwrap().enabled);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let finished = Arc::new(AtomicBool::new(false));
        let server_finished = finished.clone();
        let mut persisted = yaml_json(initial);
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            let mut requests = Vec::new();
            let mut oauth_writes = 0;
            let mut yaml_writes = 0;
            while !server_finished.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("mock accept: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let (header_end, content_length) = loop {
                    let mut buffer = [0; 2048];
                    let read = stream.read(&mut buffer).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&buffer[..read]);
                    if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]);
                        let length: usize = header
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap_or(0);
                        break (end + 4, length);
                    }
                };
                while bytes.len() < header_end + content_length {
                    let mut buffer = [0; 2048];
                    let read = stream.read(&mut buffer).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&buffer[..read]);
                }
                let header = String::from_utf8_lossy(&bytes[..header_end]);
                let first = header.lines().next().unwrap();
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap();
                let path = parts.next().unwrap();
                requests.push(format!("{method} {path}"));
                let request_body = &bytes[header_end..header_end + content_length];
                let mut status = "200 OK";
                let mut response = "{\"status\":\"ok\"}".to_string();
                if method == "GET" {
                    assert_eq!(path, "/v8/management/config.yaml");
                    response = if v8_response {
                        v8_yaml_from_legacy_json(&persisted)
                    } else {
                        serde_norway::to_string(&persisted).unwrap()
                    };
                } else if path == "/v8/management/config/oauth/model-alias" {
                    oauth_writes += 1;
                    if failure == Failure::Rollback && oauth_writes == 2 {
                        status = "500 Internal Server Error";
                    } else {
                        persisted["oauth-model-alias"] =
                            serde_json::from_slice(request_body).unwrap();
                        if failure == Failure::OauthAfterWrite && oauth_writes == 1 {
                            status = "500 Internal Server Error";
                        }
                    }
                } else {
                    yaml_writes += 1;
                    if (yaml_writes == 1
                        && matches!(
                            failure,
                            Failure::YamlBeforeWrite | Failure::Rollback | Failure::ForeignChange
                        ))
                        || (yaml_writes == 2 && failure == Failure::SecondYamlBeforeWrite)
                    {
                        status = "500 Internal Server Error";
                        if failure == Failure::ForeignChange {
                            persisted["debug"] = serde_json::json!(true);
                        }
                    } else {
                        let suffix = path
                            .strip_prefix("/v8/management/config/")
                            .unwrap_or_else(|| panic!("unexpected management path: {path}"));
                        match (method, suffix) {
                            ("PUT", "requests/payload") => {
                                persisted["payload"] =
                                    serde_json::from_slice(request_body).unwrap();
                            }
                            ("DELETE", "requests/payload") => {
                                persisted.as_object_mut().unwrap().remove("payload");
                            }
                            ("PUT", provider_path)
                                if provider_path.starts_with("api-keys/") =>
                            {
                                let provider = provider_path
                                    .strip_prefix("api-keys/")
                                    .unwrap();
                                let legacy = V8_PROVIDER_FAMILIES
                                    .iter()
                                    .find_map(|(legacy, candidate)| {
                                        (*candidate == provider).then_some(*legacy)
                                    })
                                    .unwrap();
                                let groups: serde_norway::Value =
                                    serde_json::from_slice(request_body).unwrap();
                                persisted[legacy] = serde_json::to_value(
                                    flatten_v8_provider_groups(provider, &groups).unwrap(),
                                )
                                .unwrap();
                            }
                            ("DELETE", provider_path)
                                if provider_path.starts_with("api-keys/") =>
                            {
                                let provider = provider_path
                                    .strip_prefix("api-keys/")
                                    .unwrap();
                                let legacy = V8_PROVIDER_FAMILIES
                                    .iter()
                                    .find_map(|(legacy, candidate)| {
                                        (*candidate == provider).then_some(*legacy)
                                    })
                                    .unwrap();
                                persisted.as_object_mut().unwrap().remove(legacy);
                            }
                            _ => panic!("unexpected management request: {method} {path}"),
                        }
                        if yaml_writes == 1 && failure == Failure::YamlAfterWrite {
                            status = "500 Internal Server Error";
                        }
                    }
                }
                if status.starts_with("500") {
                    response = "{\"error\":\"write_failed\"}".to_string();
                }
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            }
            (persisted, requests)
        });
        Self {
            config: GuiConfigFile {
                port,
                management_secret_key: "test-only".to_string(),
                ..Default::default()
            },
            finished,
            server: Some(server),
        }
    }

    fn finish(mut self) -> (serde_json::Value, Vec<String>) {
        self.finished.store(true, Ordering::SeqCst);
        self.server.take().unwrap().join().unwrap()
    }
}

impl Drop for MockCore {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::SeqCst);
        if let Some(server) = self.server.take() {
            let _ = server.join();
        }
    }
}

fn yaml_json(content: &str) -> serde_json::Value {
    serde_json::to_value(serde_norway::from_str::<serde_norway::Value>(content).unwrap()).unwrap()
}

fn v8_yaml_from_legacy_json(legacy: &serde_json::Value) -> String {
    let mut root = legacy.as_object().unwrap().clone();
    root.insert("config-version".into(), serde_json::json!(8));
    if let Some(client_keys) = root.remove("api-keys") {
        root.entry("access")
            .or_insert_with(|| serde_json::json!({}))["api-keys"] = client_keys;
    }
    if let Some(aliases) = root.remove("oauth-model-alias") {
        root.entry("oauth")
            .or_insert_with(|| serde_json::json!({}))["model-alias"] = aliases;
    }
    if let Some(payload) = root.remove("payload") {
        root.entry("requests")
            .or_insert_with(|| serde_json::json!({}))["payload"] = payload;
    }
    let mut upstreams = serde_json::Map::new();
    for (legacy, provider) in V8_PROVIDER_FAMILIES {
        let records: serde_norway::Value = serde_json::from_value(
            root.remove(legacy).unwrap_or_else(|| serde_json::json!([])),
        )
        .unwrap();
        upstreams.insert(
            provider.into(),
            serde_json::to_value(group_legacy_provider_records(provider, &records).unwrap())
                .unwrap(),
        );
    }
    root.insert("api-keys".into(), serde_json::Value::Object(upstreams));
    serde_norway::to_string(&serde_json::Value::Object(root)).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_uses_only_targeted_writes_with_a_real_v8_config_view() {
    let core = MockCore::new_v8(CURRENT, Failure::None);
    let current = fetch_management_config_yaml(&core.config).await.unwrap();
    let updated = current.replace("my-alias", "renamed");
    put_management_alias_config_changes(&core.config, &current, &updated)
        .await
        .unwrap();
    let (persisted, requests) = core.finish();
    assert_eq!(persisted, yaml_json(&CURRENT.replace("my-alias", "renamed")));
    assert!(requests
        .iter()
        .any(|request| request == "PUT /v8/management/config/oauth/model-alias"));
    assert!(requests
        .iter()
        .any(|request| request == "PUT /v8/management/config/requests/payload"));
    assert!(!requests
        .iter()
        .any(|request| request == "PUT /v8/management/config.yaml"));
}

#[tokio::test(flavor = "current_thread")]
async fn provider_alias_edits_round_trip_through_v8_key_groups() {
    let initial = format!(
        "{CURRENT}codex-api-key:\n  - api-key: preserved-secret\n    base-url: https://codex.example/v1\n    models: [{{name: model-a}}]\n"
    );
    let core = MockCore::new_v8(&initial, Failure::None);
    let current = fetch_management_config_yaml(&core.config).await.unwrap();
    let updated = current.replace("name: model-a\n", "name: model-b\n");
    put_management_alias_config_changes(&core.config, &current, &updated)
        .await
        .unwrap();
    let (persisted, requests) = core.finish();
    let mut expected = yaml_json(&initial);
    expected["codex-api-key"][0]["models"][0]["name"] = serde_json::json!("model-b");
    assert_eq!(persisted, expected);
    assert_eq!(persisted["codex-api-key"][0]["api-key"], "preserved-secret");
    assert!(requests
        .iter()
        .any(|request| request == "PUT /v8/management/config/api-keys/codex"));
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_recovers_failures_before_and_after_writes() {
    for failure in [
        Failure::YamlBeforeWrite,
        Failure::YamlAfterWrite,
        Failure::OauthAfterWrite,
    ] {
        let core = MockCore::new(CURRENT, failure);
        let updated = CURRENT.replace("my-alias", "renamed");
        let result = put_management_alias_config_changes(&core.config, CURRENT, &updated).await;
        assert!(result.unwrap_err().contains("Original configuration was restored"));
        let (persisted, requests) = core.finish();
        assert_eq!(persisted, yaml_json(CURRENT), "{requests:?}");
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.ends_with("oauth/model-alias"))
                .count(),
            2
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_restores_a_partial_v8_multi_path_write() {
    let initial = format!(
        "{CURRENT}codex-api-key:\n  - api-key: preserved-secret\n    models: [{{name: my-alias}}]\n"
    );
    let core = MockCore::new_v8(&initial, Failure::SecondYamlBeforeWrite);
    let current = fetch_management_config_yaml(&core.config).await.unwrap();
    let updated = current.replace("my-alias", "renamed");
    assert!(put_management_alias_config_changes(&core.config, &current, &updated)
        .await
        .unwrap_err()
        .contains("Original configuration was restored"));
    let (persisted, requests) = core.finish();
    assert_eq!(persisted, yaml_json(&initial));
    assert!(requests
        .iter()
        .any(|request| request == "PUT /v8/management/config/requests/payload"));
    assert!(requests
        .iter()
        .any(|request| request == "PUT /v8/management/config/api-keys/codex"));
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_reports_failed_rollback_without_claiming_restoration() {
    let core = MockCore::new(CURRENT, Failure::Rollback);
    let result = put_management_alias_config_changes(
        &core.config,
        CURRENT,
        &CURRENT.replace("my-alias", "renamed"),
    )
    .await;
    let error = result.unwrap_err();
    assert!(error.contains("automatic restoration failed"));
    assert!(error.contains("configuration may be partially written"));
    let (persisted, _) = core.finish();
    assert_eq!(
        persisted["oauth-model-alias"]["codex"][0]["alias"],
        "renamed"
    );
    assert_eq!(persisted["payload"], yaml_json(CURRENT)["payload"]);
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_does_not_rollback_over_external_changes() {
    let core = MockCore::new(CURRENT, Failure::ForeignChange);
    let result = put_management_alias_config_changes(
        &core.config,
        CURRENT,
        &CURRENT.replace("my-alias", "renamed"),
    )
    .await;
    assert!(result
        .unwrap_err()
        .contains("Other configuration changes were detected"));
    let (persisted, requests) = core.finish();
    assert_eq!(persisted["debug"], true);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.starts_with("PUT"))
            .count(),
        2
    );
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_rejects_stale_snapshot_before_any_write() {
    let core = MockCore::new(&format!("{CURRENT}debug: true\n"), Failure::None);
    let result = put_management_alias_config_changes(
        &core.config,
        CURRENT,
        &CURRENT.replace("my-alias", "renamed"),
    )
    .await;
    assert!(result.unwrap_err().contains("Configuration changed"));
    let (_, requests) = core.finish();
    assert_eq!(requests, ["GET /v8/management/config.yaml"]);
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_succeeds_for_mixed_oauth_only_and_yaml_only_changes() {
    for updated in [
        CURRENT.replace("my-alias", "renamed"),
        CURRENT.replacen("my-alias", "renamed", 1),
        CURRENT.replace("high", "low"),
    ] {
        let core = MockCore::new(CURRENT, Failure::None);
        put_management_alias_config_changes(&core.config, CURRENT, &updated)
            .await
            .unwrap();
        let (persisted, _) = core.finish();
        assert_eq!(persisted, yaml_json(&updated));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_serializes_concurrent_writers_and_rejects_the_stale_one() {
    let core = MockCore::new(CURRENT, Failure::None);
    let first = CURRENT.replace("my-alias", "first");
    let second = CURRENT.replace("my-alias", "second");
    let (a, b) = tokio::join!(
        put_management_alias_config_changes(&core.config, CURRENT, &first),
        put_management_alias_config_changes(&core.config, CURRENT, &second),
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let (persisted, requests) = core.finish();
    assert_eq!(
        persisted,
        yaml_json(if a.is_ok() { &first } else { &second })
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.starts_with("PUT"))
            .count(),
        2
    );
}

#[tokio::test(flavor = "current_thread")]
async fn alias_save_can_retry_after_restoration_reformats_yaml() {
    let context = model_alias_edit_context(CURRENT, "my-alias", &[]).unwrap();
    let core = MockCore::new(CURRENT, Failure::YamlBeforeWrite);
    let updated = CURRENT.replace("my-alias", "renamed");
    assert!(
        put_management_alias_config_changes(&core.config, CURRENT, &updated)
            .await
            .unwrap_err()
            .contains("Original configuration was restored")
    );
    let restored = fetch_management_config_yaml(&core.config).await.unwrap();
    validate_model_alias_revision(&restored, Some(&context.revision)).unwrap();
    let source = resolve_model_alias_edit_source(&restored, "my-alias", &[]).unwrap();
    let updated =
        edit_model_alias_in_yaml(&restored, "my-alias", &source, "renamed", "high", false).unwrap();
    put_management_alias_config_changes(&core.config, &restored, &updated)
        .await
        .unwrap();
    let (persisted, _) = core.finish();
    assert_eq!(persisted, yaml_json(&updated));
}

struct DesktopRestoreFixture {
    home: PathBuf,
    id: String,
    core_a: String,
    core_b: String,
}

impl DesktopRestoreFixture {
    fn new() -> Self {
        Self::build(false)
    }

    fn build(custom: bool) -> Self {
        Self::build_with_direct_model(custom, false)
    }

    fn build_with_direct_model(custom: bool, direct: bool) -> Self {
        let home = super::support::agent_test_home("desktop-restore");
        let models = super::support::test_agent_models(&["model-a", "model-b"]);
        let initial = "openai-compatibility:\n  - name: provider\n    models: [{name: model-a}, {name: model-b}]\n";
        let mut id = None;
        let mut core_versions = Vec::new();
        for name in ["model-a", "model-b"] {
            let mut mappings = ClaudeDesktopModelMappings::all(name);
            if custom {
                mappings.desktop_models = Some(vec![ClaudeDesktopModelMapping {
                    model: name.into(),
                    alias: if direct && name == "model-a" { String::new() } else { format!("claude-sonnet-4-6-{name}") }, context_1m: true,
                }]);
                mappings.sonnet = mappings.desktop_models.as_ref().unwrap()[0].source_or_alias().to_string();
            }
            core_versions.push(
                ensure_claude_desktop_model_aliases_in_yaml(initial, &mappings, &models).unwrap(),
            );
            let _result = apply_agent_configuration_with_oauth(
                AgentClient::ClaudeDesktop,
                &home,
                8317,
                "test-key",
                name,
                AgentConfigurationOptions {
                    models: &models,
                    codex_catalog: None,
                    oauth_configuration: false,
                    claude_code_model_mappings: None,
                    claude_desktop_model_mappings: Some(&mappings),
                },
            )
            .unwrap();
            if name == "model-a" {
                id = Some(create_backup("claude-desktop", &home).unwrap().id);
            }
        }
        Self {
            home,
            id: id.unwrap(),
            core_a: core_versions.remove(0),
            core_b: core_versions.remove(0),
        }
    }
}

impl Drop for DesktopRestoreFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_backup_restore_updates_core_routes_and_mapping_metadata() {
    let fixture = DesktopRestoreFixture::new();
    let core = MockCore::new(&fixture.core_b, Failure::None);
    let plan = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &fixture.id)
        .await
        .unwrap();
    assert!(!plan.preview.differences.is_empty());
    let revision = plan.preview.revision.clone();
    execute_restore_plan(&core.config, plan, &revision)
        .await
        .unwrap();
    assert_eq!(
        current_desktop_mappings(&fixture.home)
            .unwrap()
            .opus,
        "model-a"
    );
    let (persisted, _) = core.finish();
    assert_eq!(persisted, yaml_json(&fixture.core_a));
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_legacy_backup_restores_the_routes_referenced_by_its_profile() {
    for source in ["claude-sonnet-test", LEGACY_CLAUDE_DESKTOP_MODEL_IDS[1]] {
        let fixture = DesktopRestoreFixture::new();
        let paths = agent_config_paths(AgentClient::ClaudeDesktop, &fixture.home);
        let before = config_images(&paths).unwrap();
        let mut after = before.clone();
        let mut profile: serde_json::Value = serde_json::from_slice(after[2].1.as_ref().unwrap()).unwrap();
        profile["inferenceModels"] = serde_json::json!(LEGACY_CLAUDE_DESKTOP_MODEL_IDS
            .map(|name| serde_json::json!({"name": name})));
        after[2].1 = Some(serde_json::to_vec(&profile).unwrap());
        let mappings = ClaudeDesktopModelMappings::all(source);
        commit_config_with_mappings("claude-desktop", &paths, &before, &after,
            "update", Some(source.into()), Some(mappings.clone())).unwrap();
        let backup = create_backup("claude-desktop", &fixture.home).unwrap();
        for routes_exist in [false, true] {
            let initial = format!("{}claude-api-key:\n  - models: [{{name: {source}}}]\n", fixture.core_b);
            let mut initial = yaml_json(&initial);
            if routes_exist {
                for route in LEGACY_CLAUDE_DESKTOP_MODEL_IDS {
                    if route != source {
                        initial["claude-api-key"][0]["models"].as_array_mut().unwrap()
                            .push(serde_json::json!({
                                "name": source,
                                "alias": route,
                                "display-name": managed_claude_alias_display_name(route).unwrap(),
                            }));
                    }
                }
            }
            let core = MockCore::new(&serde_norway::to_string(&initial).unwrap(), Failure::None);
            let plan = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &backup.id)
                .await.unwrap();
            let revision = plan.preview.revision.clone();
            execute_restore_plan(&core.config, plan, &revision).await.unwrap();
            assert_eq!(config_images(&paths).unwrap(), after);
            assert_eq!(current_desktop_mappings(&fixture.home).unwrap(), mappings);
            let (persisted, _) = core.finish();
            let models = persisted["claude-api-key"][0]["models"].as_array().unwrap();
            for route in LEGACY_CLAUDE_DESKTOP_MODEL_IDS {
                assert!(models.iter().any(|model| model["name"] == source
                    && model.get("alias").unwrap_or(&model["name"]) == route), "missing {route}: {persisted}");
            }
            assert!(models.iter().any(|model| model["name"] == source && model.get("alias").is_none()));
            assert!(persisted["openai-compatibility"][0]["models"].as_array().unwrap()
                .iter().all(|model| model.get("alias").is_none()));
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_backup_keeps_a_direct_legacy_id_alongside_a_new_family_route() {
    let fixture = DesktopRestoreFixture::new();
    let paths = agent_config_paths(AgentClient::ClaudeDesktop, &fixture.home);
    let before = config_images(&paths).unwrap();
    let mut after = before.clone();
    let direct = LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0];
    let mut profile: serde_json::Value = serde_json::from_slice(after[2].1.as_ref().unwrap()).unwrap();
    profile["inferenceModels"] = serde_json::json!([
        {"name": CLAUDE_DESKTOP_OPUS_MODEL_ID, "labelOverride": "gpt-one"},
        {"name": direct},
        {"name": CLAUDE_DESKTOP_HAIKU_MODEL_ID, "labelOverride": "gpt-two"},
    ]);
    after[2].1 = Some(serde_json::to_vec(&profile).unwrap());
    let mappings = ClaudeDesktopModelMappings {
        opus: "gpt-one".into(),
        sonnet: direct.into(),
        haiku: "gpt-two".into(),
        ..ClaudeDesktopModelMappings::all("")
    };
    commit_config_with_mappings("claude-desktop", &paths, &before, &after,
        "update", Some(direct.into()), Some(mappings)).unwrap();
    let backup = create_backup("claude-desktop", &fixture.home).unwrap();
    let initial = format!("openai-compatibility:\n  - name: provider\n    models: [{{name: gpt-one}}, {{name: gpt-two}}, {{name: {direct}}}]\n");
    let core = MockCore::new(&initial, Failure::None);
    let plan = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &backup.id)
        .await.unwrap();
    let revision = plan.preview.revision.clone();
    execute_restore_plan(&core.config, plan, &revision).await.unwrap();
    assert_eq!(config_images(&paths).unwrap(), after);
    let (persisted, _) = core.finish();
    let models = persisted["openai-compatibility"][0]["models"].as_array().unwrap();
    assert!(models.iter().any(|model| model["name"] == direct && model.get("alias").is_none()));
    for (alias, source) in [(CLAUDE_DESKTOP_OPUS_MODEL_ID, "gpt-one"), (CLAUDE_DESKTOP_HAIKU_MODEL_ID, "gpt-two")] {
        assert!(models.iter().any(|model| model["name"] == source && model["alias"] == alias));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_custom_backup_restores_aliases_profile_and_mapping_metadata() {
    let fixture = DesktopRestoreFixture::build(true);
    let core = MockCore::new(&fixture.core_b, Failure::None);
    let plan = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &fixture.id)
        .await.unwrap();
    assert!(plan.preview.differences.iter().any(|difference|
        difference.field == "modelMappings.claude-sonnet-4-6-model-a"));
    assert!(plan.preview.differences.iter().any(|difference|
        difference.field == "modelMappings.claude-sonnet-4-6-model-b"));
    let revision = plan.preview.revision.clone();
    execute_restore_plan(&core.config, plan, &revision).await.unwrap();
    let mappings = current_desktop_mappings(&fixture.home).unwrap();
    let entries = mappings.desktop_models.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].model, "model-a");
    assert_eq!(entries[0].alias, "claude-sonnet-4-6-model-a");
    assert!(entries[0].context_1m);
    let paths = agent_config_paths(AgentClient::ClaudeDesktop, &fixture.home);
    let profile: serde_json::Value = serde_json::from_slice(&fs::read(&paths[2]).unwrap()).unwrap();
    assert_eq!(profile["inferenceModels"][0]["name"], entries[0].alias);
    assert_eq!(profile["inferenceModels"][0]["labelOverride"], "model-a");
    let (persisted, _) = core.finish();
    assert_eq!(persisted, yaml_json(&fixture.core_a));
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_direct_model_backup_restores_without_an_alias_route() {
    let fixture = DesktopRestoreFixture::build_with_direct_model(true, true);
    let core = MockCore::new(&fixture.core_b, Failure::None);
    let plan = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &fixture.id)
        .await.unwrap();
    let revision = plan.preview.revision.clone();
    execute_restore_plan(&core.config, plan, &revision).await.unwrap();
    let mappings = current_desktop_mappings(&fixture.home).unwrap();
    let entry = &mappings.desktop_models.as_ref().unwrap()[0];
    assert!(entry.alias.is_empty());
    assert_eq!(entry.model, "model-a");
    assert_eq!(mappings.sonnet, entry.model);
    let paths = agent_config_paths(AgentClient::ClaudeDesktop, &fixture.home);
    let profile: serde_json::Value = serde_json::from_slice(&fs::read(&paths[2]).unwrap()).unwrap();
    assert_eq!(profile["inferenceModels"][0]["name"], entry.model);
    assert_eq!(profile["inferenceModels"][0]["labelOverride"], entry.model);
    let (persisted, _) = core.finish();
    assert_eq!(persisted, yaml_json(&fixture.core_a));
    assert!(!persisted.to_string().contains("\"alias\""));
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_backup_restore_rejects_core_changes_since_preview() {
    let fixture = DesktopRestoreFixture::new();
    let core = MockCore::new(&fixture.core_b, Failure::None);
    let preview = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &fixture.id)
        .await
        .unwrap();
    let changed = fixture
        .core_b
        .replace("model-b", "externally-changed-model");
    put_management_alias_config_changes(&core.config, &fixture.core_b, &changed)
        .await
        .unwrap();
    let plan = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &fixture.id)
        .await
        .unwrap();
    assert!(
        execute_restore_plan(&core.config, plan, &preview.preview.revision)
            .await
            .unwrap_err()
            .contains("changed after preview")
    );
    assert_eq!(
        current_desktop_mappings(&fixture.home)
            .unwrap()
            .opus,
        "model-b"
    );
    assert_eq!(core.finish().0, yaml_json(&changed));
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_backup_restore_rolls_back_core_when_local_files_change() {
    let fixture = DesktopRestoreFixture::new();
    let core = MockCore::new(&fixture.core_b, Failure::None);
    let plan = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &fixture.id)
        .await
        .unwrap();
    let revision = plan.preview.revision.clone();
    let paths = config_paths("claude-desktop", &fixture.home).unwrap();
    fs::write(&paths[0], r#"{"deploymentMode":"3p","external":true}"#).unwrap();
    let before = config_images(&paths).unwrap();
    assert!(execute_restore_plan(&core.config, plan, &revision)
        .await
        .unwrap_err()
        .contains("Original configuration was restored"));
    assert_eq!(config_images(&paths).unwrap(), before);
    assert_eq!(
        current_desktop_mappings(&fixture.home)
            .unwrap()
            .opus,
        "model-b"
    );
    assert_eq!(core.finish().0, yaml_json(&fixture.core_b));
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_backup_restore_does_not_write_local_files_when_core_save_fails() {
    let fixture = DesktopRestoreFixture::new();
    let core = MockCore::new(&fixture.core_b, Failure::YamlAfterWrite);
    let plan = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &fixture.id)
        .await
        .unwrap();
    let revision = plan.preview.revision.clone();
    let paths = config_paths("claude-desktop", &fixture.home).unwrap();
    let before = config_images(&paths).unwrap();
    assert!(execute_restore_plan(&core.config, plan, &revision)
        .await
        .is_err());
    assert_eq!(config_images(&paths).unwrap(), before);
    assert_eq!(
        current_desktop_mappings(&fixture.home)
            .unwrap()
            .opus,
        "model-b"
    );
    assert_eq!(core.finish().0, yaml_json(&fixture.core_b));
}

#[tokio::test(flavor = "current_thread")]
async fn alias_transaction_rolls_back_when_followup_commit_fails() {
    let core = MockCore::new(CURRENT, Failure::None);
    let updated = CURRENT.replace("my-alias", "renamed");
    let result = commit_management_alias_config_changes(&core.config, CURRENT, &updated, || {
        Err::<(), _>("local history write failed".into())
    })
    .await;
    assert!(result.unwrap_err().contains("local history write failed"));
    assert_eq!(core.finish().0, yaml_json(CURRENT));
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_update_and_template_preserve_core_access_and_rollback_failed_local_changes() {
    let initial = "debug: true\napi-keys: [client-key]\nopenai-compatibility:\n  - name: provider\n    base-url: https://provider.test/v1\n    api-key-entries: [{api-key: provider-secret}]\n    custom: {nested: keep}\n    models: [{name: model-a}]\ncodex-api-key:\n  - api-key: unrelated-secret\n    base-url: https://codex.test\n    models: [{name: unrelated-model}]\n";
    let legacy = initial.replace(
        "{name: model-a}",
        &format!("{{name: model-a, alias: {CLAUDE_DESKTOP_OPUS_MODEL_ID}}}"),
    );
    let models = super::support::test_agent_models(&["model-a"]);
    let mappings = ClaudeDesktopModelMappings::all("model-a");
    for initial in [initial, legacy.as_str()] {
        for template in [false, true] {
            for fail in [false, true] {
                let home = super::support::agent_test_home("desktop-protected-update");
                let paths = config_paths("claude-desktop", &home).unwrap();
                if template {
                    fs::create_dir_all(paths[0].parent().unwrap()).unwrap();
                    fs::write(&paths[0], "broken-client-config").unwrap();
                }
                let before = config_images(&paths).unwrap();
                let core = MockCore::new(initial, Failure::None);
                let result = commit_agent_with_core(&core.config, Some(&mappings), &models, || {
                    if fail {
                        return Err("local write rejected".into());
                    }
                    if template {
                        reset_agent_configuration_to_default_with_oauth(AgentDefaultConfiguration {
                            client: AgentClient::ClaudeDesktop,
                            home: &home,
                            port: 8317,
                            api_key: "client-key",
                            model: "model-a",
                            models: &models,
                            codex_catalog: None,
                            oauth_configuration: false,
                            claude_code_model_mappings: None,
                            claude_desktop_model_mappings: Some(&mappings),
                        })
                    } else {
                        apply_agent_configuration_with_oauth(
                            AgentClient::ClaudeDesktop,
                            &home,
                            8317,
                            "client-key",
                            "model-a",
                            AgentConfigurationOptions {
                                models: &models,
                                codex_catalog: None,
                                oauth_configuration: false,
                                claude_code_model_mappings: None,
                                claude_desktop_model_mappings: Some(&mappings),
                            },
                        )
                    }
                })
                .await;
                let (persisted, _) = core.finish();
                if fail {
                    assert!(result.is_err());
                    assert_eq!(persisted, yaml_json(initial));
                    assert_eq!(before, config_images(&paths).unwrap());
                } else {
                    result.unwrap();
                    assert_eq!(persisted["api-keys"], yaml_json(initial)["api-keys"]);
                    assert_eq!(
                        persisted["codex-api-key"],
                        yaml_json(initial)["codex-api-key"]
                    );
                    let mut provider = persisted["openai-compatibility"][0].clone();
                    provider.as_object_mut().unwrap().remove("models");
                    let mut original = yaml_json(initial)["openai-compatibility"][0].clone();
                    original.as_object_mut().unwrap().remove("models");
                    assert_eq!(provider, original);
                    assert_eq!(persisted["debug"], true);
                    assert_eq!(current_desktop_mappings(&home).unwrap().opus, "model-a");
                }
                assert_eq!(test_backup_count(AgentClient::ClaudeDesktop, &home), 0);
                fs::remove_dir_all(home).unwrap();
            }
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn alias_transaction_checks_core_before_a_local_only_commit() {
    let current = format!("{CURRENT}debug: true\n");
    let core = MockCore::new(&current, Failure::None);
    let committed = AtomicBool::new(false);
    let result = commit_management_alias_config_changes(&core.config, CURRENT, CURRENT, || {
        committed.store(true, Ordering::SeqCst);
        Ok(())
    })
    .await;
    assert!(result.is_err());
    assert!(!committed.load(Ordering::SeqCst));
    assert_eq!(core.finish().0, yaml_json(&current));
}
