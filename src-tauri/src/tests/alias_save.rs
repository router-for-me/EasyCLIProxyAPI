use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const CURRENT: &str = "oauth-model-alias:\n  codex:\n    - name: gpt-test\n      alias: my-alias\n      fork: true\npayload:\n  override:\n    - models: [{name: my-alias, protocol: codex}]\n      params: {reasoning.effort: high}\n";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Failure {
    None,
    YamlBeforeWrite,
    YamlAfterWrite,
    OauthAfterWrite,
    Rollback,
    ForeignChange,
}

struct MockCore {
    config: GuiConfigFile,
    finished: Arc<AtomicBool>,
    server: Option<std::thread::JoinHandle<(serde_json::Value, Vec<String>)>>,
}

impl MockCore {
    fn new(initial: &str, failure: Failure) -> Self {
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
                    assert_eq!(path, "/v0/management/config.yaml");
                    response = serde_norway::to_string(&persisted).unwrap();
                } else if path == "/v0/management/oauth-model-alias" {
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
                    assert_eq!(path, "/v0/management/config.yaml");
                    yaml_writes += 1;
                    if yaml_writes == 1
                        && matches!(
                            failure,
                            Failure::YamlBeforeWrite | Failure::Rollback | Failure::ForeignChange
                        )
                    {
                        status = "500 Internal Server Error";
                        if failure == Failure::ForeignChange {
                            persisted["debug"] = serde_json::json!(true);
                        }
                    } else {
                        persisted = yaml_json(std::str::from_utf8(request_body).unwrap());
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
        assert!(result.unwrap_err().contains("已恢复原配置"));
        let (persisted, requests) = core.finish();
        assert_eq!(persisted, yaml_json(CURRENT), "{requests:?}");
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.ends_with("oauth-model-alias"))
                .count(),
            2
        );
    }
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
    assert!(error.contains("自动恢复失败"));
    assert!(error.contains("配置可能已部分写入"));
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
    assert!(result.unwrap_err().contains("检测到其他配置修改"));
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
    assert!(result.unwrap_err().contains("配置已变化"));
    let (_, requests) = core.finish();
    assert_eq!(requests, ["GET /v0/management/config.yaml"]);
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
            .contains("已恢复原配置")
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
        let home = super::support::agent_test_home("desktop-restore");
        let models = super::support::test_agent_models(&["model-a", "model-b"]);
        let initial = "openai-compatibility:\n  - name: provider\n    models: [{name: model-a}, {name: model-b}]\n";
        let mut id = None;
        let mut core_versions = Vec::new();
        for name in ["model-a", "model-b"] {
            let mappings = ClaudeDesktopModelMappings::all(name);
            core_versions.push(
                ensure_claude_desktop_model_aliases_in_yaml(initial, &mappings, &models).unwrap(),
            );
            let result = apply_agent_configuration_with_oauth(
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
                id = result.history_version;
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
async fn desktop_history_restore_updates_core_routes_and_mapping_metadata() {
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
        current_desktop_history_mappings(&fixture.home)
            .unwrap()
            .opus,
        "model-a"
    );
    let (persisted, _) = core.finish();
    assert_eq!(persisted, yaml_json(&fixture.core_a));
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_history_restore_rejects_core_changes_since_preview() {
    let fixture = DesktopRestoreFixture::new();
    let core = MockCore::new(&fixture.core_b, Failure::None);
    let preview = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &fixture.id)
        .await
        .unwrap();
    let changed = format!("{}debug: true\n", fixture.core_b);
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
            .contains("预览后")
    );
    assert_eq!(
        current_desktop_history_mappings(&fixture.home)
            .unwrap()
            .opus,
        "model-b"
    );
    assert_eq!(core.finish().0, yaml_json(&changed));
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_history_restore_rolls_back_core_when_local_files_change() {
    let fixture = DesktopRestoreFixture::new();
    let core = MockCore::new(&fixture.core_b, Failure::None);
    let plan = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &fixture.id)
        .await
        .unwrap();
    let revision = plan.preview.revision.clone();
    let paths = history_paths("claude-desktop", &fixture.home).unwrap();
    fs::write(&paths[0], r#"{"deploymentMode":"3p","external":true}"#).unwrap();
    let before = history_images(&paths).unwrap();
    assert!(execute_restore_plan(&core.config, plan, &revision)
        .await
        .unwrap_err()
        .contains("已恢复原配置"));
    assert_eq!(history_images(&paths).unwrap(), before);
    assert_eq!(
        current_desktop_history_mappings(&fixture.home)
            .unwrap()
            .opus,
        "model-b"
    );
    assert_eq!(core.finish().0, yaml_json(&fixture.core_b));
}

#[tokio::test(flavor = "current_thread")]
async fn desktop_history_restore_does_not_write_local_files_when_core_save_fails() {
    let fixture = DesktopRestoreFixture::new();
    let core = MockCore::new(&fixture.core_b, Failure::YamlAfterWrite);
    let plan = prepare_restore_plan(&core.config, "claude-desktop", &fixture.home, &fixture.id)
        .await
        .unwrap();
    let revision = plan.preview.revision.clone();
    let paths = history_paths("claude-desktop", &fixture.home).unwrap();
    let before = history_images(&paths).unwrap();
    assert!(execute_restore_plan(&core.config, plan, &revision)
        .await
        .is_err());
    assert_eq!(history_images(&paths).unwrap(), before);
    assert_eq!(
        current_desktop_history_mappings(&fixture.home)
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
