use super::support::agent_test_home;
use super::*;
use std::process::{Child, Stdio};

struct TestCore {
    child: Option<Child>,
    directory: PathBuf,
    config: PathBuf,
    executable: PathBuf,
    origin: String,
    client: reqwest::Client,
}

impl Drop for TestCore {
    fn drop(&mut self) {
        self.stop();
        if self.directory.parent() == Some(std::env::temp_dir().as_path())
            && self
                .directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cpa-gui-agent-v8-contract-")
        {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

impl TestCore {
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    async fn start(&mut self) {
        let mut command = Command::new(&self.executable);
        command
            .args(["-config"])
            .arg(&self.config)
            .arg("-local-model")
            .current_dir(&self.directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut command);
        self.child = Some(command.spawn().unwrap());
        for _ in 0..100 {
            assert!(
                self.child.as_mut().unwrap().try_wait().unwrap().is_none(),
                "test kernel exited during startup"
            );
            if self
                .client
                .get(format!("{}/v8/management/config", self.origin))
                .bearer_auth("isolated-test-secret")
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("test kernel startup timed out");
    }

    async fn config_view(&self) -> serde_json::Value {
        self.client
            .get(format!("{}/v8/management/config", self.origin))
            .bearer_auth("isolated-test-secret")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    async fn validate_save(&self, yaml: &str) -> serde_json::Value {
        let response = self
            .client
            .put(format!("{}/v8/management/config.yaml", self.origin))
            .bearer_auth("isolated-test-secret")
            .header("Content-Type", "application/yaml")
            .body(yaml.to_string())
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body = response.text().await.unwrap();
        assert!(
            status.is_success(),
            "v8 rejected generated settings: {status} {body}"
        );
        self.config_view().await
    }

    async fn wait_for_client_key(&self, key: &str, expected: u16) {
        for _ in 0..100 {
            let status = self
                .client
                .get(format!("{}/v1/models", self.origin))
                .bearer_auth(key)
                .send()
                .await
                .unwrap()
                .status()
                .as_u16();
            if status == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("client key did not reach HTTP {expected}");
    }
}

#[tokio::test]
#[ignore = "requires CPA_V8_TEST_CORE pointing to a v8 executable"]
async fn v8_accepts_gui_settings_and_reloads_client_keys() {
    let executable =
        fs::canonicalize(std::env::var_os("CPA_V8_TEST_CORE").expect("set CPA_V8_TEST_CORE"))
            .unwrap();
    let directory = agent_test_home("v8-contract");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut core = TestCore {
        child: None,
        config: directory.join("config.yaml"),
        directory,
        executable,
        origin: format!("http://127.0.0.1:{port}"),
        client: reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap(),
    };
    let mut gui = GuiConfigFile {
        host: "127.0.0.1".into(),
        port,
        auth_dir: path_to_string(&core.directory.join("auth")),
        management_secret_key: "isolated-test-secret".into(),
        api_keys: vec![GuiApiKeyEntry {
            key: "client-one".into(),
            remark: String::new(),
        }],
        proxy_url: "direct".into(),
        routing_strategy: "round-robin".into(),
        routing_session_affinity: true,
        routing_session_affinity_ttl: "2h30m".into(),
        request_retry: 2,
        max_retry_credentials: 3,
        max_retry_interval: 5,
        streaming_bootstrap_retries: 2,
        disable_cooling: true,
        debug: true,
        commercial_mode: true,
        logging_to_file: true,
        logs_max_total_size_mb: 5,
        error_logs_max_files: 4,
        usage_statistics_enabled: true,
        redis_usage_queue_retention_seconds: 90,
        request_log: true,
        ..GuiConfigFile::default()
    };
    let initial = "config-version: 8\nmanagement: {disable-control-panel: true, disable-auto-update-panel: true}\nrequests: null\nobservability: null\noauth: {providers: {codex: {header-defaults: {user-agent: preserve-test}}}}\napi-keys: {openai-compatibility: [{name: preserved, base-url: 'http://127.0.0.1:1/v1', models: [{name: test-model}], keys: [{api-key: upstream-test}]}]}\n";
    let content = apply_gui_managed_settings(initial, &gui).unwrap();
    let content = patch_core_sensitive_words_yaml(
        &content,
        &CoreSensitiveWordsSettings {
            antigravity_sensitive_words: vec!["sample".into()],
            devin_sensitive_words: vec!["sample-devin".into()],
        },
    )
    .unwrap()
    .unwrap();
    fs::write(&core.config, &content).unwrap();
    core.start().await;
    let view = core.validate_save(&content).await;
    assert_eq!(view["routing"]["strategy"], "round-robin");
    assert_eq!(view["routing"]["retry"]["request-retry"], 2);
    assert_eq!(view["routing"]["retry"]["max-retry-credentials"], 3);
    assert_eq!(view["routing"]["retry"]["max-retry-interval"], 5);
    assert_eq!(view["requests"]["streaming"]["bootstrap-retries"], 2);
    assert_eq!(view["routing"]["cooldown"]["disable-cooling"], true);
    assert_eq!(
        view["observability"]["usage"]["redis-usage-queue-retention-seconds"],
        90
    );
    assert_eq!(
        view["oauth"]["providers"]["devin"]["sensitive-words"][0],
        "sample-devin"
    );

    gui.request_retry = 0;
    gui.max_retry_credentials = 0;
    gui.max_retry_interval = 0;
    gui.streaming_bootstrap_retries = 0;
    gui.disable_cooling = false;
    gui.routing_session_affinity = false;
    gui.routing_session_affinity_ttl.clear();
    gui.proxy_url.clear();
    let current = fs::read_to_string(&core.config).unwrap();
    let content = patch_core_retry_yaml(&current, &gui).unwrap().unwrap();
    let content = patch_core_session_routing_yaml(&content, &gui)
        .unwrap()
        .unwrap();
    let content = patch_core_network_endpoint_yaml(&content, &gui)
        .unwrap()
        .unwrap();
    let mut logging =
        core_config_settings_from_value(&serde_norway::from_str(&content).unwrap()).unwrap();
    logging.debug = false;
    logging.commercial_mode = false;
    logging.logging_to_file = false;
    logging.logs_max_total_size_mb = 0;
    logging.error_logs_max_files = 0;
    logging.usage_statistics_enabled = false;
    logging.redis_usage_queue_retention_seconds = 1;
    let content =
        patch_core_yaml_document(&content, |doc| apply_core_logging_settings(doc, &logging))
            .unwrap()
            .unwrap();
    let content = patch_core_sensitive_words_yaml(&content, &CoreSensitiveWordsSettings::default())
        .unwrap()
        .unwrap();
    let content = patch_core_tls_settings_yaml(
        &content,
        &CoreTlsSettings {
            enabled: false,
            cert: "test-cert.pem".into(),
            key: "test-key.pem".into(),
        },
    )
    .unwrap()
    .unwrap();
    let view = core.validate_save(&content).await;
    assert_eq!(view["routing"]["retry"]["request-retry"], 0);
    assert_eq!(view["routing"]["session-affinity"], false);
    assert_eq!(view["routing"]["session-affinity-ttl"], "");
    assert_eq!(view["routing"]["cooldown"]["disable-cooling"], false);
    assert_eq!(
        view["observability"]["usage"]["usage-statistics-enabled"],
        false
    );
    assert_eq!(view["observability"]["logs"]["logging-to-file"], false);
    assert_eq!(view["observability"]["logs"]["request-log"], true);
    assert_eq!(view["server"]["tls"]["cert"], "test-cert.pem");
    assert_eq!(view["server"]["tls"]["enable"], false);
    assert_eq!(
        view["api-keys"]["openai-compatibility"][0]["name"],
        "preserved"
    );
    assert_eq!(
        view["oauth"]["providers"]["codex"]["header-defaults"]["user-agent"],
        "preserve-test"
    );
    assert_eq!(
        view["oauth"]["providers"]["antigravity"]["sensitive-words"],
        serde_json::json!([])
    );
    let current = fs::read_to_string(&core.config).unwrap();
    let content = patch_core_api_keys_yaml(&current, &["client-two".into()]).unwrap();
    write_yaml_if_changed(&core.config, &content).unwrap();
    core.wait_for_client_key("client-two", 200).await;
    core.wait_for_client_key("client-one", 401).await;
    core.stop();
    core.start().await;
    core.wait_for_client_key("client-two", 200).await;
    core.wait_for_client_key("client-one", 401).await;
}
