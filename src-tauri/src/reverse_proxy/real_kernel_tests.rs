use super::*;
use crate::{CoreProcessState, GuiApiKeyEntry, GuiConfigFile};
use std::time::Duration;
use tauri::Manager;

struct Fixture {
    app: tauri::App<tauri::test::MockRuntime>,
    directory: std::path::PathBuf,
    upstream: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = crate::core_runtime::stop_core_process_inner(
            self.app.state::<CoreProcessState>().inner(),
        );
        self.upstream.abort();
        if std::thread::panicking() {
            let log = crate::core_runtime::core_start_log_path(
                &self.directory,
                self.directory.join("auth").to_str().unwrap(),
            )
            .unwrap();
            eprintln!("{}", std::fs::read_to_string(log).unwrap_or_default());
        }
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn message(stream: bool) -> serde_json::Value {
    serde_json::json!({"model":"claude-proof", "max_tokens":64, "stream":stream,
        "messages":[{"role":"user","content":"ping"}]})
}

async fn assert_proxy_serves(
    manager: &ReverseProxyManagerState,
    config: &ReverseProxyConfig,
    url: &str,
    error: Option<&str>,
) {
    let state = manager.get_state().unwrap();
    assert!(state.running, "{state:?}");
    assert_eq!(state.config.as_ref(), Some(config));
    assert_eq!(state.error.as_deref(), error);
    let response = reqwest::Client::builder()
        .no_proxy()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
        .post(url)
        .header("x-api-key", "local-client-key")
        .header("anthropic-version", "2023-06-01")
        .json(&message(false))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.text().await.unwrap().contains("pong-proof"));
}

#[test]
fn enabled_proxy_startup_preserves_tls_and_management_while_hardening_both_schemas() {
    for yaml in [
        "host: 0.0.0.0\nport: 12345\ntrusted-proxies: [192.0.2.1]\ntls: {enable: true}\nremote-management: {allow-remote: false}\n",
        "config-version: 8\nserver: {host: 0.0.0.0, port: 12345, trusted-proxies: [192.0.2.1], tls: {enable: true}}\nmanagement: {allow-remote: false}\n",
    ] {
        let mut document: serde_norway::Value = serde_norway::from_str(yaml).unwrap();
        let config = ReverseProxyConfig { enabled: true, target_port: 54321, ..Default::default() };
        assert!(prepare_core_start(&mut document, Some(&config)).unwrap());
        let hardening = read_core_hardening(&document);
        assert!(hardening.loopback_bind && hardening.trusted_proxies);
        // Hardening never stores the reverse proxy settings in the kernel file.
        assert!(read_proxy_config_document(&document).unwrap().is_none());
        assert!(crate::core_config::core_tls_settings_from_value(&document).unwrap().enabled);
        let server = if core_config_uses_v8(&document) { &document["server"] } else { &document };
        assert_eq!(server["trusted-proxies"][0], "192.0.2.1");
        let management = if core_config_uses_v8(&document) { &document["management"] } else { &document["remote-management"] };
        assert_eq!(management["allow-remote"], false);
        assert!(!prepare_core_start(&mut document, Some(&config)).unwrap());
        // A disabled proxy leaves the kernel document untouched.
        let mut disabled = config.clone();
        disabled.enabled = false;
        let before = document.clone();
        assert!(!prepare_core_start(&mut document, Some(&disabled)).unwrap());
        assert!(!prepare_core_start(&mut document, None).unwrap());
        assert_eq!(document, before);
    }
    let original = "https://untrusted.example/v1/messages?q=1".parse().unwrap();
    assert_eq!(
        build_target_uri_with_scheme(12345, &original, "https").unwrap(),
        "https://127.0.0.1:12345/v1/messages?q=1"
            .parse::<hyper::Uri>()
            .unwrap()
    );
}

#[test]
fn enabled_proxy_effective_endpoint_uses_loopback_for_lan_and_ipv6() {
    for host in ["192.168.100.184", "::"] {
        for tls_enabled in [false, true] {
            for yaml in [
                format!("host: '{host}'\nport: 12345\ntls: {{enable: {tls_enabled}}}\n"),
                format!("config-version: 8\nserver: {{host: '{host}', port: 12345, tls: {{enable: {tls_enabled}}}}}\n"),
            ] {
                let mut document = serde_norway::from_str(&yaml).unwrap();
                prepare_core_start(
                    &mut document,
                    Some(&ReverseProxyConfig {
                        enabled: true,
                        target_port: 12345,
                        ..Default::default()
                    }),
                )
                .unwrap();
                let settings =
                    crate::core_config::core_config_settings_from_value(&document).unwrap();
                let tls = crate::core_config::core_tls_settings_from_value(&document).unwrap();
                assert_eq!(settings.host, "127.0.0.1");
                assert_eq!(settings.port, 12345);
                assert_eq!(tls.enabled, tls_enabled);
                assert_eq!(
                    crate::core_config::core_origin(&settings.host, settings.port, tls.enabled),
                    format!(
                        "{}://127.0.0.1:12345",
                        if tls_enabled { "https" } else { "http" }
                    ),
                );
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "run scripts/prove-reverse-proxy.sh with CPA_V8_TEST_CORE; isolated executable directory required"]
async fn real_kernel_messages_chain() {
    let root =
        std::fs::canonicalize(std::env::var_os("CPA_RP_ISOLATED_DIR").expect("use proof runner"))
            .unwrap();
    assert_eq!(crate::core_runtime::executable_dir().unwrap(), root);
    let directory = crate::core_runtime::core_install_dir().unwrap();
    assert!(
        !directory.exists(),
        "refusing to overwrite any installed kernel/config"
    );
    std::fs::create_dir(&directory).unwrap();
    let binary =
        std::fs::canonicalize(std::env::var_os("CPA_V8_TEST_CORE").expect("set CPA_V8_TEST_CORE"))
            .unwrap();
    std::fs::copy(binary, directory.join("cli-proxy-api")).unwrap();
    let version = std::process::Command::new(directory.join("cli-proxy-api"))
        .arg("-version")
        .output()
        .unwrap();
    println!("{}", String::from_utf8_lossy(&version.stdout));

    let cert = directory.join("cert.pem");
    let key = directory.join("key.pem");
    assert!(std::process::Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
            "-addext",
            "basicConstraints=critical,CA:FALSE",
            "-keyout",
        ])
        .arg(&key)
        .arg("-out")
        .arg(&cert)
        .output()
        .unwrap()
        .status
        .success());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let release = Arc::new(tokio::sync::Notify::new());
    let upstream_release = release.clone();
    let upstream = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let release = upstream_release.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(
                    move |request: hyper::Request<hyper::body::Incoming>| {
                        let release = release.clone();
                        async move {
                            assert_eq!(request.method(), hyper::Method::POST);
                            assert_eq!(request.uri().path(), "/v1/messages");
                            assert_eq!(
                                request.headers()["authorization"],
                                "Bearer local-upstream-key"
                            );
                            assert_eq!(request.headers()["anthropic-version"], "2023-06-01");
                            let body = request.into_body().collect().await.unwrap().to_bytes();
                            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                            assert_eq!(body["model"], "claude-proof");
                            assert!(body["messages"].to_string().contains("ping"));
                            let response = if body["stream"] == true {
                                let events = [
                                "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_proof\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-proof\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
                                "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"pong-proof\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
                            ];
                                let frames = futures_util::stream::unfold(
                                    (release, 0usize),
                                    move |(release, step)| async move {
                                        if step >= events.len() {
                                            return None;
                                        }
                                        if step == 1 {
                                            release.notified().await;
                                        }
                                        Some((
                                            Ok::<_, std::convert::Infallible>(
                                                hyper::body::Frame::data(Bytes::from_static(
                                                    events[step].as_bytes(),
                                                )),
                                            ),
                                            (release, step + 1),
                                        ))
                                    },
                                );
                                hyper::Response::builder()
                                    .header("content-type", "text/event-stream")
                                    .header("cache-control", "no-cache")
                                    .body(http_body_util::StreamBody::new(frames).boxed())
                                    .unwrap()
                            } else {
                                let body = serde_json::json!({"id":"msg_proof","type":"message","role":"assistant","model":"claude-proof",
                                "content":[{"type":"text","text":"pong-proof"}],"stop_reason":"end_turn","stop_sequence":null,
                                "usage":{"input_tokens":1,"output_tokens":1}});
                                hyper::Response::builder()
                                    .header("content-type", "application/json")
                                    .body(Full::new(Bytes::from(body.to_string())).boxed())
                                    .unwrap()
                            };
                            Ok::<_, std::convert::Infallible>(response)
                        }
                    },
                );
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(socket), service)
                    .await;
            });
        }
    });
    let app = tauri::test::mock_app();
    app.manage(CoreProcessState::new(false));
    app.manage(ReverseProxyManagerState::new());
    let fixture = Fixture {
        app,
        directory: directory.clone(),
        upstream,
    };
    let case = std::env::var("CPA_RP_CASE").unwrap_or_else(|_| "http".into());
    let native_tls = case == "tls" || case.starts_with("tls-");
    let port = free_port();
    let config_path = directory.join(crate::CORE_CONFIG_FILE);
    let initial = format!("config-version: 8\nserver:\n  host: 127.0.0.1\n  port: {port}\n  trusted-proxies: [127.0.0.1]\n  tls: {{enable: {native_tls}, cert: cert.pem, key: key.pem}}\nmanagement: {{secret-key: local-management-key, disable-control-panel: true, disable-auto-update-panel: true, allow-remote: false}}\noauth: {{auth-dir: '{}' }}\napi-keys:\n  claude:\n    - name: local-proof\n      base-url: http://127.0.0.1:{upstream_port}\n      models: [{{name: claude-proof}}]\n      keys: [{{api-key: local-upstream-key}}]\n", directory.join("auth").display());
    std::fs::write(directory.join(crate::CORE_EXAMPLE_CONFIG_FILE), &initial).unwrap();
    std::fs::write(&config_path, &initial).unwrap();
    let mut gui = GuiConfigFile {
        port,
        host: "127.0.0.1".into(),
        allow_lan: false,
        auth_dir: directory.join("auth").to_str().unwrap().into(),
        management_secret_key: "local-management-key".into(),
        api_keys: vec![GuiApiKeyEntry {
            key: "local-client-key".into(),
            remark: String::new(),
        }],
        proxy_override: true,
        proxy_url: String::new(),
        plugins_enabled: false,
        request_retry: 0,
        ..GuiConfigFile::default()
    };
    if case.ends_with("lan") || case.ends_with("ipv6") {
        gui.host = if case.ends_with("lan") {
            "192.168.100.184"
        } else {
            "::"
        }
        .into();
        gui.allow_lan = true;
        let config = ReverseProxyConfig {
            enabled: true,
            listen_host: "127.0.0.1".into(),
            listen_port: free_port(),
            target_port: port,
            cert_path: cert.to_str().unwrap().into(),
            key_path: key.to_str().unwrap().into(),
        };
        persist_proxy_config(&config, None).unwrap();
    }
    fixture.app.manage(crate::GuiConfigState::new(gui.clone()));
    if case == "manual" {
        let config = ReverseProxyConfig {
            enabled: true,
            listen_host: "127.0.0.1".into(),
            listen_port: free_port(),
            target_port: port,
            cert_path: cert.to_str().unwrap().into(),
            key_path: key.to_str().unwrap().into(),
        };
        persist_proxy_config(&config, None).unwrap();
    }
    let started = crate::core_runtime::run_core_command(
        fixture.app.handle().clone(),
        crate::core_runtime::start_core_process_with_state,
    )
    .await
    .unwrap();
    assert!(started.running && started.ready);
    if case.ends_with("lan") || case.ends_with("ipv6") {
        assert!(fixture
            .app
            .state::<ReverseProxyManagerState>()
            .get_state()
            .unwrap()
            .running);
        assert!(
            tokio::net::TcpStream::connect((std::net::Ipv6Addr::LOCALHOST, port))
                .await
                .is_err()
        );
    }
    if case == "manual" {
        let state = fixture
            .app
            .state::<ReverseProxyManagerState>()
            .get_state()
            .unwrap();
        println!("after manual production start: {state:?}");
        assert!(
            state.running,
            "manual kernel start did not restore enabled proxy"
        );
        fixture
            .app
            .state::<ReverseProxyManagerState>()
            .stop()
            .await
            .unwrap();
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .add_root_certificate(
            reqwest::Certificate::from_pem(&std::fs::read(&cert).unwrap()).unwrap(),
        )
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap();
    let direct = format!(
        "{}://127.0.0.1:{port}/v1/messages",
        if native_tls { "https" } else { "http" }
    );
    let response = client
        .post(direct)
        .header("x-api-key", "local-client-key")
        .header("anthropic-version", "2023-06-01")
        .json(&message(false))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    println!("direct kernel: {status} {body}");
    assert_eq!(status, 200);
    let manager = fixture.app.state::<ReverseProxyManagerState>();
    let config = ReverseProxyConfig {
        enabled: true,
        listen_host: "127.0.0.1".into(),
        listen_port: free_port(),
        // The stale and restart cases move the kernel port after the proxy is
        // configured; a 0 target keeps following the effective kernel port
        // instead of pinning the forwarding to a stale value.
        target_port: if case == "stale" || case.starts_with("restart") {
            0
        } else {
            port
        },
        cert_path: cert.to_str().unwrap().into(),
        key_path: key.to_str().unwrap().into(),
    };
    if case == "stale" {
        crate::core_runtime::stop_core_process_inner(
            fixture.app.state::<CoreProcessState>().inner(),
        )
        .unwrap();
        gui.port = free_port();
        fixture
            .app
            .state::<crate::GuiConfigState>()
            .replace_external(gui.clone())
            .unwrap();
        crate::core_runtime::run_core_command(
            fixture.app.handle().clone(),
            crate::core_runtime::start_core_process_with_state,
        )
        .await
        .unwrap();
        println!("kernel port changed {port} -> {}", gui.port);
    }
    let state = manager.save_and_apply(config.clone(), None).await.unwrap();
    assert!(state.running, "{state:?}");
    let address: std::net::SocketAddr = state.listening.unwrap().parse().unwrap();
    if case == "stop-race" {
        crate::core_runtime::run_core_command(
            fixture.app.handle().clone(),
            crate::core_runtime::stop_core_process_with_state,
        )
        .await
        .unwrap();
        manager.stop().await.unwrap();
        let operation = manager.operation.lock().await;
        let start = crate::core_runtime::run_core_command(
            fixture.app.handle().clone(),
            crate::core_runtime::start_core_process_with_state,
        );
        tokio::pin!(start);
        assert!(tokio::time::timeout(Duration::from_secs(3), &mut start)
            .await
            .is_err());
        assert!(fixture.app.state::<CoreProcessState>().managed_pid().is_some());
        drop(
            crate::core_runtime::lock_core_operation(
                fixture.app.state::<CoreProcessState>().inner(),
            )
            .expect("start must release the core lock while proxy restoration is blocked"),
        );
        let stopped = tokio::time::timeout(
            Duration::from_secs(3),
            crate::core_runtime::run_core_command(
                fixture.app.handle().clone(),
                crate::core_runtime::stop_core_process_with_state,
            ),
        )
        .await
        .expect("stop must not wait for the proxy operation lock")
        .unwrap();
        assert!(!stopped.running);
        drop(operation);
        let status = tokio::time::timeout(Duration::from_secs(3), &mut start)
            .await
            .unwrap()
            .unwrap();
        assert!(!status.running, "delayed start returned stale running status");
        assert!(!status.ready);
        assert!(status.process_id.is_none());
        assert!(
            !manager.get_state().unwrap().running,
            "delayed start revived the proxy"
        );
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
        println!("delayed start returned stopped status without reviving the proxy");
        return;
    }
    if case == "restart" || case.starts_with("restart-") {
        gui.port = free_port();
        gui.host = match case.as_str() {
            "restart-lan" => "192.168.100.184",
            "restart-ipv6" => "::",
            _ => "0.0.0.0",
        }
        .into();
        gui.allow_lan = true;
        fixture
            .app
            .state::<crate::GuiConfigState>()
            .replace_external(gui.clone())
            .unwrap();
        crate::core_runtime::run_core_command(
            fixture.app.handle().clone(),
            crate::core_runtime::restart_core_process_with_state,
        )
        .await
        .unwrap();
        let restored = manager.get_state().unwrap();
        assert_eq!(restored.listening, Some(address.to_string()));
        assert_eq!(restored.target, Some(format!("127.0.0.1:{}", gui.port)));
        assert_eq!(restored.config.as_ref().unwrap().target_port, 0);
        assert_eq!(
            read_saved_proxy_config_for_test().unwrap().unwrap().target_port,
            0,
            "auto target must stay 0 in the saved config"
        );
        println!("production restart retargeted active proxy: {restored:?}");

        // An explicit target is not rewritten by kernel start preparation and
        // is not retargeted when the kernel port changes again.
        let mut explicit = config.clone();
        explicit.target_port = port;
        let applied = manager.save_and_apply(explicit.clone(), None).await.unwrap();
        assert!(applied.running, "{applied:?}");
        assert_eq!(applied.target, Some(format!("127.0.0.1:{port}")));
        assert_eq!(read_saved_proxy_config_for_test().unwrap(), Some(explicit.clone()));
        crate::core_runtime::run_core_command(
            fixture.app.handle().clone(),
            crate::core_runtime::restart_core_process_with_state,
        )
        .await
        .unwrap();
        let restored = manager.get_state().unwrap();
        assert_eq!(
            restored.target,
            Some(format!("127.0.0.1:{port}")),
            "explicit target must not follow the kernel port"
        );
        assert_eq!(read_saved_proxy_config_for_test().unwrap(), Some(explicit.clone()));
        println!("production restart preserved explicit proxy target: {restored:?}");
        let applied = manager.save_and_apply(config.clone(), None).await.unwrap();
        assert_eq!(applied.target, Some(format!("127.0.0.1:{}", gui.port)));
    }
    let saved: serde_norway::Value =
        serde_norway::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(saved["server"]["host"], "127.0.0.1");
    assert!(saved["server"]["trusted-proxies"]
        .as_sequence()
        .unwrap()
        .iter()
        .any(|value| value.as_str() == Some("127.0.0.1")));
    assert_eq!(saved["management"]["allow-remote"], false);
    let url = format!("https://localhost:{}/v1/messages", address.port());
    let response = client
        .post(&url)
        .header("x-api-key", "local-client-key")
        .header("anthropic-version", "2023-06-01")
        .json(&message(false))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.text().await.unwrap();
    println!("HTTPS proxy POST /v1/messages case={case}: {status} {headers:?} {body}");
    assert_eq!(status, 200);
    assert!(headers["content-type"]
        .to_str()
        .unwrap()
        .contains("application/json"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["content"][0]["text"],
        "pong-proof"
    );
    let unauthorized = client
        .post(&url)
        .json(&message(false))
        .send()
        .await
        .unwrap();
    println!("unauthenticated: {}", unauthorized.status());
    assert_eq!(unauthorized.status(), 401);
    let management_url = format!("https://localhost:{}/v8/management/config", address.port());
    let management = client
        .get(management_url)
        .bearer_auth("local-client-key")
        .send()
        .await
        .unwrap();
    assert_eq!(
        management.status(),
        401,
        "client API key must not grant management access"
    );
    let mut response = client
        .post(&url)
        .bearer_auth("local-client-key")
        .header("anthropic-version", "2023-06-01")
        .json(&message(true))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .contains("text/event-stream"));
    let mut received = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !String::from_utf8_lossy(&received).contains("message_start") {
            received.extend(response.chunk().await.unwrap().expect("premature SSE EOF"));
        }
    })
    .await
    .expect("first SSE event was buffered");
    assert!(!String::from_utf8_lossy(&received).contains("message_stop"));
    assert!(
        tokio::time::timeout(Duration::from_millis(250), response.chunk())
            .await
            .is_err(),
        "SSE ended before fixture release"
    );
    println!(
        "SSE first event observed while completion withheld: {}",
        String::from_utf8_lossy(&received)
    );
    release.notify_one();
    while let Some(chunk) = response.chunk().await.unwrap() {
        received.extend(chunk);
    }
    let events = String::from_utf8(received).unwrap();
    assert!(
        events.contains("pong-proof") && events.contains("message_stop"),
        "{events}"
    );
    println!("SSE completed after release: {events}");
    if case == "save" {
        let good_document = std::fs::read_to_string(&config_path).unwrap();
        let bad_pem = directory.join("invalid.pem");
        std::fs::write(&bad_pem, "not a PEM certificate or key").unwrap();
        let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        for failure in [
            "missing certificate",
            "invalid certificate",
            "missing key",
            "invalid key",
            "occupied port",
        ] {
            let mut invalid = config.clone();
            match failure {
                "missing certificate" => {
                    invalid.cert_path = directory.join("missing.pem").to_str().unwrap().into();
                }
                "invalid certificate" => invalid.cert_path = bad_pem.to_str().unwrap().into(),
                "missing key" => {
                    invalid.key_path = directory.join("missing.key").to_str().unwrap().into();
                }
                "invalid key" => invalid.key_path = bad_pem.to_str().unwrap().into(),
                _ => invalid.listen_port = occupied.local_addr().unwrap().port(),
            }
            let error = manager.save_and_apply(invalid, None).await.unwrap_err();
            println!("rejected {failure}: {error}");
            assert_proxy_serves(&manager, &config, &url, Some(&error)).await;
            assert_eq!(std::fs::read_to_string(&config_path).unwrap(), good_document);
            assert_eq!(read_saved_proxy_config_for_test().unwrap(), Some(config.clone()));
        }

        let overlap = tokio::net::TcpListener::bind(("127.0.0.2", config.listen_port)).await.unwrap();
        let mut wildcard = config.clone();
        wildcard.listen_host = "0.0.0.0".into();
        let error = manager.save_and_apply(wildcard, None).await.unwrap_err();
        assert!(error.contains("Failed to bind listener"), "{error}");
        assert_proxy_serves(&manager, &config, &url, Some(&error)).await;
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), good_document);
        drop(overlap);

        let mut replacement = config.clone();
        replacement.cert_path = directory.join("replacement-cert.pem").to_str().unwrap().into();
        replacement.key_path = directory.join("replacement-key.pem").to_str().unwrap().into();
        std::fs::copy(&config.cert_path, &replacement.cert_path).unwrap();
        std::fs::copy(&config.key_path, &replacement.key_path).unwrap();
        #[cfg(unix)]
        for same_port in [false, true] {
            use std::os::unix::fs::PermissionsExt;
            let permissions = std::fs::metadata(&directory).unwrap().permissions();
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o555)).unwrap();
            let mut candidate = replacement.clone();
            if same_port {
                candidate.listen_host = "0.0.0.0".into();
            } else {
                candidate.listen_port = free_port();
            }
            let result = manager.save_and_apply(candidate.clone(), None).await;
            std::fs::set_permissions(&directory, permissions).unwrap();
            let error = result.unwrap_err();
            assert!(error.contains("write configuration"), "{error}");
            assert_proxy_serves(&manager, &config, &url, Some(&error)).await;
            assert_eq!(std::fs::read_to_string(&config_path).unwrap(), good_document);
            assert_eq!(read_saved_proxy_config_for_test().unwrap(), Some(config.clone()));
            if !same_port {
                assert_eq!(
                    tokio::net::TcpStream::connect(("127.0.0.1", candidate.listen_port))
                        .await.unwrap_err().kind(),
                    std::io::ErrorKind::ConnectionRefused
                );
            }
        }

        // An unwritable GUI configuration rejects the save and keeps the
        // running listener on the previous settings.
        let gui_config_path = crate::core_config::gui_config_path().unwrap();
        let gui_document = std::fs::read_to_string(&gui_config_path).unwrap();
        std::fs::remove_file(&gui_config_path).unwrap();
        std::fs::create_dir_all(&gui_config_path).unwrap();
        let error = manager.save_and_apply(replacement.clone(), None).await.unwrap_err();
        assert!(error.contains("write configuration"), "{error}");
        assert_proxy_serves(&manager, &config, &url, Some(&error)).await;
        std::fs::remove_dir(&gui_config_path).unwrap();
        std::fs::write(&gui_config_path, &gui_document).unwrap();

        let applied = manager.save_and_apply(replacement.clone(), None).await.unwrap();
        assert!(applied.running && applied.error.is_none(), "{applied:?}");
        assert_eq!(applied.listening, Some(address.to_string()));
        assert_eq!(read_saved_proxy_config_for_test().unwrap(), Some(replacement.clone()));
        assert_proxy_serves(&manager, &replacement, &url, None).await;
        replacement.listen_host = "0.0.0.0".into();
        manager.save_and_apply(replacement.clone(), None).await.unwrap();
        assert_proxy_serves(&manager, &replacement, &url, None).await;
        assert_eq!(read_saved_proxy_config_for_test().unwrap(), Some(replacement.clone()));
        replacement.listen_host = "127.0.0.1".into();
        replacement.listen_port = free_port();
        let applied = manager.save_and_apply(replacement.clone(), None).await.unwrap();
        assert!(applied.running && applied.error.is_none(), "{applied:?}");
        assert_eq!(read_saved_proxy_config_for_test().unwrap(), Some(replacement.clone()));
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
        let new_address = applied.listening.unwrap();
        let new_url = format!("https://localhost:{}/v1/messages", replacement.listen_port);
        assert_proxy_serves(&manager, &replacement, &new_url, None).await;
        let stopped = manager.stop_and_save(None).await.unwrap();
        assert!(!stopped.running && stopped.error.is_none(), "{stopped:?}");
        assert!(!read_saved_proxy_config_for_test().unwrap().unwrap().enabled);
        assert!(tokio::net::TcpStream::connect(new_address).await.is_err());
    }
    manager.stop().await.unwrap();
}
