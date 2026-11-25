use super::*;
use reqwest::Method;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const KEY: &str = "fixture-management-key";
const ETAG: &str = "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"";

#[test]
fn validates_endpoint_base_and_accepts_http_and_https() {
    for (input, expected) in [
        (" http://127.0.0.1:8317 ", "http://127.0.0.1:8317/"),
        ("http://localhost:8317", "http://localhost:8317/"),
        ("http://[::1]:8317", "http://[::1]:8317/"),
        ("http://[fd12::1]/cpa", "http://[fd12::1]/cpa/"),
        ("http://192.168.2.5/cpa/", "http://192.168.2.5/cpa/"),
        (
            "https://CPA.example.com/cpa_A/~edge",
            "https://cpa.example.com/cpa_A/~edge/",
        ),
    ] {
        assert_eq!(parse_endpoint(input).unwrap().as_str(), expected);
    }
    for input in [
        "http://cpa.lan",
        "http://example.com",
        "http://8.8.8.8",
        "http://169.254.169.254",
        "http://[2001:db8::1]/cpa",
    ] {
        assert_eq!(parse_endpoint(input).unwrap().as_str(), format!("{input}/"));
    }
    for input in [
        "ftp://127.0.0.1",
        "http:127.0.0.1",
        "https:///example.com",
        "https://",
        "https://example.com:0",
        "https://user:pass@example.com",
        "https://example.com?a=key",
        "https://example.com/#key",
        "https://example.com//",
        "https://example.com/cpa//core",
        "https://example.com/cpa/../core",
        "https://example.com/cpa/%2e%2e",
        "https://example.com/cpa\\core",
        "https://example.com/cpa/v8/management/",
        "http://0.0.0.0",
    ] {
        assert_eq!(
            parse_endpoint(input).unwrap_err(),
            RemoteError::InvalidEndpoint,
            "{input}"
        );
    }
    assert!(matches!(
        Target::new("http://localhost", "key\r\nforged"),
        Err(RemoteError::InvalidKey)
    ));
    assert!(matches!(
        Target::new("http://localhost", " "),
        Err(RemoteError::KeyRequired)
    ));
}

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let path = crate::unique_test_temp_path("ecpa-remote-test");
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn agent_catalog_uses_remote_prefix_and_client_authorization() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = Target::new(&format!("http://{}/team/cpa", listener.local_addr().unwrap()), KEY).unwrap();
    let fixture = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let (headers, _) = receive(&mut tcp).await;
        assert!(headers.starts_with("GET /team/cpa/v1/models HTTP/1.1"));
        assert!(headers.to_ascii_lowercase().contains("authorization: bearer client-only"));
        assert!(!headers.contains(KEY));
        send(&mut tcp, "200 OK", "", r#"{"data":[{"id":"only-on-remote"}]}"#).await;
    });
    let result = AGENT_ORIGIN.scope(target.endpoint.as_str().trim_end_matches('/').to_owned(), crate::fetch_agent_models(443, "client-only")).await.unwrap();
    assert_eq!(result[0].name, "only-on-remote");
    fixture.await.unwrap();
}

#[test]
fn remote_agent_writes_target_origin_and_client_key_not_loopback() {
    let directory = TestDir::new();
    let origin = "https://example.test:9443/team/cpa";
    for (client, suffix) in [(crate::AgentClient::ClaudeCode, ""), (crate::AgentClient::OpenCode, "/v1"), (crate::AgentClient::Codex, "/v1")] {
        AGENT_ORIGIN.sync_scope(origin.to_owned(), || {
            crate::apply_agent_configuration_with_oauth(client, &directory.0, 8317, "client-only", "fixture-model",
                crate::AgentConfigurationOptions { models: &[], codex_catalog: Some(r#"{"models":[{"slug":"fixture-model"}]}"#), oauth_configuration: false,
                    claude_code_model_mappings: None, claude_desktop_model_mappings: None }).unwrap();
        });
        let saved = fs::read_to_string(&crate::agent_config_paths(client, &directory.0)[0]).unwrap();
        assert!(saved.contains(&format!("{origin}{suffix}")));
        assert!(saved.contains("client-only") || fs::read_to_string(directory.0.join(".codex/auth.json")).unwrap().contains("client-only"));
        assert!(!saved.contains("127.0.0.1") && !saved.contains(KEY));
    }
}

#[tokio::test]
async fn profile_switch_keeps_local_files_unmodified_and_never_exports_its_key() {
    let directory = TestDir::new();
    let path = directory.0.join(PROFILE_FILE);
    let local_file = directory.0.join("config.toml");
    fs::write(&local_file, "local setting sentinel").unwrap();
    let local = RemoteCpaState::from_path(Some(path.clone()));
    assert!(!local.remote_launch);
    let mut selection = local.selection.lock().await;
    let chosen = local
        .persist(
            &mut selection,
            Profile::Remote {
                endpoint: "http://127.0.0.1:9999/".into(),
                key: KEY.into(),
            },
        )
        .unwrap();
    assert!(chosen.remote_active && chosen.remote_selected);
    assert!(!serde_json::to_string(&chosen).unwrap().contains(KEY));
    assert!(matches!(
        current_target(local.remote_launch, &selection, chosen.revision),
        Err(RemoteError::NotActive)
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let remote = RemoteCpaState::from_path(Some(path.clone()));
    assert!(remote.remote_launch);
    let mut selection = remote.selection.lock().await;
    assert!(candidate(&selection, "http://127.0.0.1:9999".into(), "".into()).is_ok());
    for changed in [
        "http://127.0.0.1:9998",
        "http://127.0.0.1:9999/new",
        "https://127.0.0.1:9999",
    ] {
        assert!(matches!(
            candidate(&selection, changed.into(), "".into()),
            Err(RemoteError::KeyRequired)
        ));
    }
    selection.keys_etag = Some((1, header::HeaderValue::from_static(ETAG)));
    let active_revision = selection.revision;
    assert!(remote.selection.try_lock().is_err());
    remote
        .persist(
            &mut selection,
            Profile::Remote {
                endpoint: "http://127.0.0.1:9998/".into(),
                key: "second-key".into(),
            },
        )
        .unwrap();
    assert!(matches!(
        current_target(true, &selection, active_revision),
        Err(RemoteError::EndpointChanged)
    ));
    assert!(selection.keys_etag.is_none());
    let active = current_target(true, &selection, selection.revision).unwrap();
    assert_eq!(active.endpoint.port(), Some(9998));
    assert_eq!(active.auth, "Bearer second-key");
    let restored = remote.persist(&mut selection, Profile::Local).unwrap();
    assert_eq!(restored.endpoint, None);
    assert!(!restored.remote_selected && !restored.remote_active);
    let persisted = read_profile(&path).unwrap();
    assert!(persisted.active.is_none());
    assert_eq!(persisted.instances.len(), 2);
    assert_eq!(candidate(&selection, "http://127.0.0.1:9999/".into(), String::new()).unwrap().1, KEY);
    assert!(!serde_json::to_string(&restored).unwrap().contains("second-key"));
    let mut restarted = RemoteCpaState::from_path(Some(path.clone()));
    assert!(!restarted.remote_launch);
    assert!(restarted.take_builtin_start().unwrap());
    assert!(!RemoteCpaState::from_path(Some(path.clone())).take_builtin_start().unwrap());
    assert_eq!(
        fs::read_to_string(local_file).unwrap(),
        "local setting sentinel"
    );
    fs::write(&path, "unable to parse").unwrap();
    let corrupt = RemoteCpaState::from_path(Some(path));
    assert!(corrupt.remote_launch);
    assert!(corrupt.view(&*corrupt.selection.lock().await).needs_repair);
}

#[tokio::test]
async fn external_dispatch_gate_allows_builtin_commands_after_returning_to_local() {
    let directory = TestDir::new();
    let path = directory.0.join(PROFILE_FILE);

    // Local launch -> Remote -> Local clears external_dispatch immediately in-process.
    let local = RemoteCpaState::from_path(Some(path.clone()));
    assert!(!local.uses_external_dispatch());
    {
        let mut selection = local.selection.lock().await;
        local
            .persist(
                &mut selection,
                Profile::Remote {
                    endpoint: "http://127.0.0.1:9999/".into(),
                    key: KEY.into(),
                },
            )
            .unwrap();
    }
    assert!(local.uses_external_dispatch());
    {
        let mut selection = local.selection.lock().await;
        local.persist(&mut selection, Profile::Local).unwrap();
    }
    assert!(!local.uses_external_dispatch());

    // Remote launch -> persist Local -> restarted process clears remote_launch and allows Built-in IPC.
    {
        let mut selection = local.selection.lock().await;
        local
            .persist(
                &mut selection,
                Profile::Remote {
                    endpoint: "http://127.0.0.1:9999/".into(),
                    key: KEY.into(),
                },
            )
            .unwrap();
    }
    let remote = RemoteCpaState::from_path(Some(path.clone()));
    assert!(remote.remote_launch);
    assert!(remote.uses_external_dispatch());
    {
        let mut selection = remote.selection.lock().await;
        remote.persist(&mut selection, Profile::Local).unwrap();
    }
    assert!(remote.uses_external_dispatch());
    let mut restarted = RemoteCpaState::from_path(Some(path));
    assert!(!restarted.remote_launch);
    assert!(!restarted.uses_external_dispatch());
    assert!(restarted.take_builtin_start().unwrap());
}

async fn receive(tcp: &mut TcpStream) -> (String, String) {
    let mut buf = Vec::new();
    let header_end = loop {
        let mut bytes = [0; 1024];
        let count = tcp.read(&mut bytes).await.unwrap();
        assert_ne!(count, 0);
        buf.extend_from_slice(&bytes[..count]);
        if let Some(i) = buf.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            break i + 4;
        }
        assert!(buf.len() < 16384);
    };
    let headers = std::str::from_utf8(&buf[..header_end]).unwrap().to_owned();
    let len = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while buf.len() < header_end + len {
        let mut bytes = [0; 1024];
        let count = tcp.read(&mut bytes).await.unwrap();
        assert_ne!(count, 0);
        buf.extend_from_slice(&bytes[..count]);
    }
    (
        headers,
        std::str::from_utf8(&buf[header_end..header_end + len])
            .unwrap()
            .to_owned(),
    )
}

async fn send(tcp: &mut TcpStream, status: &str, other_headers: &str, body: &str) {
    let response = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{other_headers}\r\n{body}", body.len());
    tcp.write_all(response.as_bytes()).await.unwrap();
}

#[tokio::test]
async fn settings_form_sends_only_changed_field_and_checks_readback() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/team/", listener.local_addr().unwrap());
    let directory = TestDir::new();
    let path = directory.0.join(PROFILE_FILE);
    fs::write(&path, serde_json::to_vec(&Profile::Remote { endpoint, key: KEY.into() }).unwrap()).unwrap();
    let state = RemoteCpaState::from_path(Some(path));
    let fixture = tokio::spawn(async move {
        for (method, path, body, status, expected) in [
            ("GET", "config", r#"{"config-version":8,"routing":{"strategy":"round-robin"}}"#, "200 OK", ""),
            ("PUT", "config/routing/strategy", "{}", "200 OK", r#""fill-first""#),
            ("GET", "config/routing/strategy", r#""fill-first""#, "200 OK", ""),
            ("GET", "config", r#"{"config-version":8,"routing":{"strategy":"fill-first"}}"#, "200 OK", ""),
            ("GET", "config", r#"{"config-version":8,"routing":{"retry":{"request-retry":2,"max-retry-interval":90}}}"#, "200 OK", ""),
            ("PUT", "config/routing/retry/request-retry", "{}", "412 Precondition Failed", "3"),
        ] {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let (headers, request) = receive(&mut tcp).await;
            assert_eq!(headers.lines().next().unwrap(), format!("{method} /team/v8/management/{path} HTTP/1.1"));
            assert_eq!(request, expected);
            if method == "PUT" { assert!(headers.contains(&format!("if-match: {ETAG}\r\n"))); }
            send(&mut tcp, status, &format!("ETag: {ETAG}\r\n"), body).await;
        }
    });
    let result = remote_settings_operation(&state, 0, "set_core_routing_strategy", serde_json::json!({"strategy":"fill-first","expected":{"routingStrategy":"round-robin"}})).await.unwrap();
    assert_eq!(result["routingStrategy"], "fill-first");
    let retry = serde_json::json!({"settings":{"disableCooling":false,"requestRetry":3,"maxRetryCredentials":0,"maxRetryInterval":20,"streamingBootstrapRetries":0}, "expected":{"requestRetry":2,"maxRetryInterval":20,"disableCooling":false,"maxRetryCredentials":0,"streamingBootstrapRetries":0}});
    assert!(remote_settings_operation(&state, 0, "save_retry_settings", retry).await.unwrap_err().contains("412"));
    fixture.await.unwrap();
}

#[tokio::test]
async fn field_update_falls_back_only_when_route_is_unsupported() {
    for (result, fallback) in [("405 Method Not Allowed", true), ("401 Unauthorized", false), ("500 Server Error", false)] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = Target::new(&format!("http://{}",listener.local_addr().unwrap()),KEY).unwrap();
        let fixture = tokio::spawn(async move {
            let (mut tcp,_) = listener.accept().await.unwrap();
            let (headers,body) = receive(&mut tcp).await;
            assert!(headers.starts_with("PUT /v8/management/config/routing/strategy "));
            assert_eq!(body,r#""fill-first""#); send(&mut tcp,result,"","{}").await;
            if fallback {
                let (mut tcp,_) = listener.accept().await.unwrap(); assert!(receive(&mut tcp).await.0.starts_with("GET /v8/management/config.yaml "));
                send(&mut tcp,"200 OK",&format!("ETag: {ETAG}\r\n"),"routing: {strategy: round-robin}\nunknown: {untouched: true}\n").await;
                let (mut tcp,_) = listener.accept().await.unwrap(); let (headers,body) = receive(&mut tcp).await;
                assert!(headers.starts_with("PUT /v8/management/config.yaml ") && headers.contains(&format!("if-match: {ETAG}")));
                let doc: serde_json::Value = serde_norway::from_str(&body).unwrap();
                assert_eq!(doc,serde_json::json!({"routing":{"strategy":"fill-first"},"unknown":{"untouched":true}}));
                send(&mut tcp,"200 OK","","{}").await;
            }
            assert!(tokio::time::timeout(Duration::from_millis(100),listener.accept()).await.is_err());
        });
        let saved = write_setting_changes(&target,&header::HeaderValue::from_static(ETAG),&[("routing/strategy".into(), Some(serde_json::json!("fill-first")))]).await;
        assert_eq!(saved.is_ok(),fallback); fixture.await.unwrap();
    }
}

#[tokio::test]
async fn partial_multi_field_save_reports_accepted_and_unattempted_fields() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = Target::new(&format!("http://{}",listener.local_addr().unwrap()),KEY).unwrap();
    let fixture = tokio::spawn(async move {
        for (field,status) in [("one","200 OK"),("two","412 Precondition Failed")] {
            let (mut socket,_) = listener.accept().await.unwrap();
            assert!(receive(&mut socket).await.0.starts_with(&format!("PUT /v8/management/config/{field} ")));
            send(&mut socket,status,&format!("ETag: {ETAG}\r\n"),"{}").await;
        }
    });
    let edits = ["one","two","three"].map(|key| (key.into(),Some(serde_json::json!({"field":1}))));
    let error = write_setting_changes(&target,&header::HeaderValue::from_static(ETAG),&edits).await.unwrap_err();
    assert!(error.contains("Saved: [\"one\"]") && error.contains("rejected: two") && error.contains("not attempted: [\"three\"]"));
    fixture.await.unwrap();
}

#[tokio::test]
async fn disconnect_after_endpoint_write_does_not_retry_on_another_route() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = Target::new(&format!("http://{}",listener.local_addr().unwrap()),KEY).unwrap();
    let fixture = tokio::spawn(async move {
        let (mut tcp,_) = listener.accept().await.unwrap();
        let (headers,port) = receive(&mut tcp).await;
        assert!(headers.starts_with("PUT /v8/management/config/server/port "));
        assert_eq!(port,"9999"); drop(tcp);
        assert!(tokio::time::timeout(Duration::from_millis(125),listener.accept()).await.is_err());
    });
    let error = write_setting_changes(&target,&header::HeaderValue::from_static(ETAG),&[("server/port".into(),Some(serde_json::json!(9999)))]).await.unwrap_err();
    assert!(error.contains("unknown")); fixture.await.unwrap();
}

#[tokio::test]
async fn fixed_v8_routes_use_header_auth_prefix_and_conditional_update() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/edge/cpa", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        for (method, route, status, body) in [
            ("GET", VERSION_PATH, "200 OK", "8"),
            ("GET", KEYS_PATH, "200 OK", r#"["first-client"]"#),
            (
                "PUT",
                KEYS_PATH,
                "200 OK",
                r#"{"status":"ok","config-version":8}"#,
            ),
            (
                "PUT",
                KEYS_PATH,
                "412 Precondition Failed",
                r#"{"error":"precondition_failed"}"#,
            ),
        ] {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let (headers, request_body) = receive(&mut tcp).await;
            assert_eq!(
                headers.lines().next().unwrap(),
                format!("{method} /edge/cpa/v8/management/{route} HTTP/1.1")
            );
            assert!(headers
                .lines()
                .any(|line| line == format!("authorization: Bearer {KEY}")));
            assert_eq!(headers.matches(KEY).count(), 1);
            if method == "PUT" {
                assert!(headers.contains(&format!("if-match: {ETAG}\r\n")));
                assert_eq!(request_body, r#"["new-client"]"#);
            }
            send(&mut tcp, status, &format!("ETag: {ETAG}\r\n"), body).await;
        }
    });
    let target = Target::new(&url, KEY).unwrap();
    let (keys, etag) = load_keys(&target).await.unwrap();
    assert_eq!(keys, ["first-client"]);
    let new_keys = vec!["new-client".into()];
    save_keys(&target, etag.clone(), &new_keys).await.unwrap();
    assert_eq!(
        save_keys(&target, etag, &new_keys).await,
        Err(RemoteError::Conflict)
    );
    fixture.await.unwrap();
}

#[tokio::test]
async fn remote_errors_are_actionable_and_do_not_reflect_response_or_follow_redirects() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let other = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = listener.local_addr().unwrap();
    let redirect = format!(
        "Location: http://{}/should-not-see-key\r\n",
        other.local_addr().unwrap()
    );
    let fixture = tokio::spawn(async move {
        for (status, headers, body) in [
            ("401 Unauthorized", "".to_owned(), KEY),
            ("307 Temporary Redirect", redirect, KEY),
            ("200 OK", format!("ETag: {ETAG}\r\n"), KEY),
        ] {
            let (mut tcp, _) = listener.accept().await.unwrap();
            receive(&mut tcp).await;
            send(&mut tcp, status, &headers, body).await;
        }
    });
    let target = Target::new(&format!("http://{origin}"), KEY).unwrap();
    let errors = [
        RemoteError::NotAuthorized,
        RemoteError::Redirect,
        RemoteError::InvalidResponse,
    ];
    for error in errors {
        let actual = check_target(&target).await.unwrap_err();
        assert_eq!(actual, error);
        assert!(!serde_json::to_string(&actual).unwrap().contains(KEY));
    }
    fixture.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), other.accept())
            .await
            .is_err()
    );
    assert_eq!(
        check_target(&target).await.unwrap_err(),
        RemoteError::Unreachable
    );
}

#[test]
fn valid_replacements_require_distinct_nonempty_keys() {
    assert_eq!(
        normalize_keys(vec![" new-client ".into()]).unwrap(),
        ["new-client"]
    );
    for keys in [
        vec![],
        vec!["".into()],
        vec!["a".into(), " a ".into()],
        vec!["with space".into()],
    ] {
        assert_eq!(normalize_keys(keys), Err(RemoteError::InvalidKeys));
    }
}

#[tokio::test]
#[ignore = "requires a pinned disposable CPA binary via CPA_V8_TEST_CORE"]
async fn pinned_cpa_accepts_reads_and_conditional_updates_only_on_selected_instance() {
    use std::process::{Child, Command, Stdio};
    struct Core(Child);
    impl Drop for Core {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let executable =
        fs::canonicalize(std::env::var_os("CPA_V8_TEST_CORE").expect("CPA_V8_TEST_CORE")).unwrap();
    let directory = TestDir::new();
    let config = directory.0.join("config.yaml");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    fs::write(&config, format!("config-version: 8\nserver: {{host: 127.0.0.1, port: {port}}}\nmanagement: {{secret-key: {KEY}, disable-control-panel: true, disable-auto-update-panel: true}}\noauth: {{auth-dir: auth}}\n")).unwrap();
    let origin = format!("http://127.0.0.1:{port}");
    drop(listener);
    let mut core = Core(
        Command::new(executable)
            .args(["--config", config.to_str().unwrap(), "--local-model"])
            .current_dir(&directory.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let target = Target::new(&origin, KEY).unwrap();
    let (keys, _) = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            assert!(
                core.0.try_wait().unwrap().is_none(),
                "fixture core exited during startup"
            );
            if let Ok(result) = load_keys(&target).await {
                break result;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    })
    .await
    .expect("v8 fixture did not return supported version and keys");
    assert!(keys.is_empty());
    let profile_path = directory.0.join(PROFILE_FILE);
    fs::write(&profile_path, serde_json::to_vec(&Profile::Remote { endpoint: origin.clone(), key: KEY.into() }).unwrap()).unwrap();
    let workspace = RemoteCpaState::from_path(Some(profile_path));
    assert!(workspace.management_operation(Some(1), async { Ok(()) }).await.is_err());
    workspace.management_operation(Some(0), async {
        let config = AGENT_CONFIG.with(Clone::clone);
        let current = crate::fetch_management_config_yaml(&config).await?;
        let mut updated: serde_norway::Value = serde_norway::from_str(&current).unwrap();
        updated["oauth-model-alias"] = serde_norway::from_str("codex: [{name: sample-model, alias: external-only, fork: true}]").unwrap();
        crate::put_management_alias_config_changes(&config, &current, &serde_norway::to_string(&updated).unwrap()).await?;
        assert!(crate::fetch_management_config_yaml(&config).await?.contains("external-only"));
        Ok(())
    }).await.unwrap();
    let before = remote_settings_operation(&workspace, 0, "get_core_config_settings", serde_json::json!({})).await.unwrap();
    assert_eq!(before["port"], port);
    remote_settings_operation(&workspace, 0, "save_session_routing_settings", serde_json::json!({"settings": {"routingSessionAffinity": true, "routingSessionAffinityTtl": "15m"}})).await.unwrap();
    let after = remote_settings_operation(&workspace, 0, "get_core_config_settings", serde_json::json!({})).await.unwrap();
    assert_eq!(after["routingSessionAffinityTtl"], "15m");
    assert_eq!(after["port"], port);
    assert!(remote_settings_operation(&workspace, 1, "get_core_config_settings", serde_json::json!({})).await.is_err());
    let logging = serde_json::json!({"debug":false,"commercialMode":false,"loggingToFile":true,"logsMaxTotalSizeMb":10,"errorLogsMaxFiles":3,"usageStatisticsEnabled":true,"redisUsageQueueRetentionSeconds":90});
    let logging_view = remote_settings_operation(&workspace,0,"save_core_logging_settings",serde_json::json!({"settings":logging,"expected":after})).await.unwrap();
    assert_eq!(logging_view["usageStatisticsEnabled"],true);
    let logs = workspace.workspace_request(Method::GET, "/observability/logs", 0).await.unwrap().query(&[("limit", 200)]).send().await.unwrap().error_for_status().unwrap().json::<serde_json::Value>().await.unwrap();
    assert!(logs["lines"].is_array());
    let retry = serde_json::json!({"disableCooling":true,"requestRetry":4,"maxRetryCredentials":2,"maxRetryInterval":12,"streamingBootstrapRetries":1});
    let retry_view = remote_settings_operation(&workspace,0,"save_retry_settings",serde_json::json!({"settings":retry})).await.unwrap();
    assert_eq!(retry_view["requestRetry"],4);
    let tls = serde_json::json!({"enabled":false,"cert":"server.crt","key":"server.key"});
    assert_eq!(remote_settings_operation(&workspace,0,"save_core_tls_settings",serde_json::json!({"settings":tls})).await.unwrap(),tls);
    let words = serde_json::json!({"antigravitySensitiveWords":["fixture-word"],"devinSensitiveWords":[],"antigravitySensitiveWordsReplace":{},"devinSensitiveWordsReplace":{}});
    assert_eq!(remote_settings_operation(&workspace,0,"save_core_sensitive_words_settings",serde_json::json!({"settings":words})).await.unwrap(),words);
    let network = remote_settings_operation(&workspace,0,"save_network_endpoint_settings",serde_json::json!({"settings":{"host":"127.0.0.1","port":port,"proxyUrl":"direct","proxyOverride":true}})).await.unwrap();
    assert_eq!(network["proxyUrl"],"direct");
    let extended = remote_settings_operation(&workspace,0,"get_extended_core_config",serde_json::json!({})).await.unwrap();
    let original = extended.pointer("/observability/logs/request-log");
    let result = remote_settings_operation(&workspace,0,"save_extended_core_config",serde_json::json!({"changes":[{"path":["observability","logs","request-log"],"expectedExists":original.is_some(),"expected":original,"value":true}]})).await.unwrap();
    assert_eq!(result["config"]["observability"]["logs"]["request-log"], true);
    let added = remote_settings_operation(&workspace,0,"add_core_api_key",serde_json::json!({"apiKey":"test-client","remark":"A"})).await.unwrap();
    assert_eq!(added["apiKeys"][0]["remark"],"A");
    assert!(remote_settings_operation(&workspace,0,"delete_core_api_key",serde_json::json!({"apiKey":"test-client"})).await.is_err());
    remote_settings_operation(&workspace,0,"add_core_api_key",serde_json::json!({"apiKey":"retained-client","remark":"B"})).await.unwrap();
    let removed = remote_settings_operation(&workspace,0,"delete_core_api_key",serde_json::json!({"apiKey":"test-client"})).await.unwrap();
    assert_eq!(removed["apiKeys"].as_array().unwrap().len(),1);
    assert_eq!(removed["apiKeys"][0]["remark"],"B");
    let route = "/config/routing/strategy";
    let response = workspace.workspace_request(Method::PUT, route, 0).await.unwrap()
        .json("fill-first").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value = workspace.workspace_request(Method::GET, route, 0).await.unwrap()
        .send().await.unwrap().json::<String>().await.unwrap();
    assert_eq!(value, "fill-first");
    assert!(workspace.workspace_request(Method::GET, "/credentials/../config", 0).await.is_err());
    let (_, stale_tag) = load_keys(&target).await.unwrap();
    let updated = vec!["isolated-client".into(), "second-isolated-client".into()];
    save_keys(&target, stale_tag.clone(), &updated)
        .await
        .unwrap();
    assert_eq!(load_keys(&target).await.unwrap().0, updated);
    assert_eq!(
        save_keys(&target, stale_tag, &["stale-edit".into()]).await,
        Err(RemoteError::Conflict)
    );
    let bad = Target::new(&origin, "incorrect-test-key").unwrap();
    assert_eq!(
        check_target(&bad).await.unwrap_err(),
        RemoteError::NotAuthorized
    );
    assert_eq!(
        target
            .send(Method::GET, KEYS_PATH, None)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert!(
        core.0.try_wait().unwrap().is_none(),
        "CPA still belongs to the fixture owner"
    );
}
