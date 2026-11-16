use super::*;
use std::io::{BufRead, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

fn models() -> Vec<AcpModel> {
    vec![AcpModel {
        id: "test-model".into(),
        name: "Test model".into(),
    }]
}
fn request(stream: bool) -> Value {
    json!({"model":"acp/test-model","messages":[{"role":"user","content":"ping"}],"stream":stream})
}

#[test]
fn provider_registration_preserves_unrelated_routes_in_both_schemas() {
    for v8 in [false, true] {
        let existing = json!([{"name":"existing","base-url":"https://example.test"}]);
        let mut document: serde_norway::Value = serde_norway::to_value(if v8 {
            json!({"config-version":8,"api-keys":{"openai-compatibility":existing}})
        } else {
            json!({"openai-compatibility":existing})
        })
        .unwrap();
        let original = document.clone();
        let entry = provider_entry(
            "http://127.0.0.1:12345/v1",
            "private-test-key",
            &models(),
            v8,
        )
        .unwrap();
        assert!(patch_provider(&mut document, Some(entry.clone())).unwrap());
        assert!(!patch_provider(&mut document, Some(entry)).unwrap());
        let groups = if v8 {
            &document["api-keys"]["openai-compatibility"]
        } else {
            &document["openai-compatibility"]
        };
        assert_eq!(groups.as_sequence().unwrap().len(), 2);
        assert_eq!(groups[0]["name"].as_str(), Some("existing"));
        assert_eq!(
            groups[1]["models"][0]["alias"].as_str(),
            Some("acp/test-model")
        );
        assert!(groups[1]
            .get(if v8 { "keys" } else { "api-key-entries" })
            .is_some());
        patch_provider(&mut document, None).unwrap();
        assert_eq!(document, original);
    }
}

#[test]
fn unsupported_inputs_are_rejected_without_dropping_parameters() {
    assert!(parse_completion(&request(false), &models()).is_ok());
    for (key, value) in [
        ("tools", json!([])),
        ("temperature", json!(0.5)),
        ("max_tokens", json!(64)),
        ("response_format", json!({"type":"json_object"})),
    ] {
        let mut value_request = request(false);
        value_request[key] = value;
        assert!(parse_completion(&value_request, &models()).is_err());
    }
    for messages in [
        json!([]),
        json!([{"role":"system","content":"x"}]),
        json!([{"role":"user","content":"x"},{"role":"assistant","content":"y"}]),
        json!([{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.test/image"}}]}]),
    ] {
        let mut value = request(false);
        value["messages"] = messages;
        assert!(parse_completion(&value, &models()).is_err());
    }
}

#[test]
fn fake_official_server() {
    if std::env::var_os("ECPA_ACP_BRIDGE_TEST_HELPER").is_none() {
        return;
    }
    let mut selected = false;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let result = match value["method"].as_str().unwrap_or("") {
            "initialize" => json!({"protocolVersion":1,"agentCapabilities":{"auth":{"logout":{}}}}),
            "session/new" => {
                json!({"sessionId":"isolated-session","models":{"currentModelId":"other","availableModels":[{"modelId":"test-model"}]}})
            }
            "session/set_model" => {
                assert_eq!(value["params"]["modelId"], "test-model");
                selected = true;
                json!({})
            }
            "logout" => json!({}),
            "session/prompt" => {
                assert!(selected, "explicit model selection must precede inference");
                if value["params"]["prompt"][0]["text"] == "wait" {
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"started"}}}})
                    );
                    std::io::stdout().flush().unwrap();
                    std::thread::sleep(Duration::from_secs(15));
                }
                for text in ["ACP_", "OK"] {
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})
                    );
                }
                json!({"stopReason":"end_turn"})
            }
            _ => panic!("Unexpected ACP method"),
        };
        println!(
            "{}",
            json!({"jsonrpc":"2.0","id":value["id"],"result":result})
        );
        std::io::stdout().flush().unwrap();
    }
}

fn spawn_fake(_: &Path, _: &Path, _: &str) -> Result<rpc::Client, String> {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "acp::bridge::tests::fake_official_server",
            "--nocapture",
        ])
        .env("ECPA_ACP_BRIDGE_TEST_HELPER", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::configure_background_command(&mut command);
    rpc::Client::spawn_command(command)
}

#[test]
fn reauthentication_uses_official_advertised_logout() {
    let mut client = spawn_fake(Path::new("unused"), Path::new("unused"), "").unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    client.initialize(&cancel).unwrap();
    client.logout(&cancel).unwrap();
}

#[tokio::test]
async fn authenticated_http_bridge_lists_models_completes_streams_and_cancels_disconnects() {
    let app = tauri::test::mock_app();
    app.manage(AcpState::default());
    app.manage(crate::GuiConfigState::new(crate::GuiConfigFile::default()));
    let directory = crate::unique_test_temp_path("acp-http");
    std::fs::create_dir_all(&directory).unwrap();
    {
        let state = app.state::<AcpState>();
        let mut status = state.status.lock().unwrap();
        status.models = models();
        status.authenticated = true;
        status.upstream_enabled = true;
        status.executable = Some("fake-official-cli".into());
        status.profile = directory.to_string_lossy().into_owned();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        app.handle().clone(),
        listener,
        "internal-test-key".into(),
        stop.clone(),
        spawn_fake,
    ));
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert_eq!(
        http.get(format!("{base}/v1/models"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let listing: Value = http
        .get(format!("{base}/v1/models"))
        .bearer_auth("internal-test-key")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listing["data"][0]["id"], "acp/test-model");
    for stream in [false, true] {
        let response = http
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("internal-test-key")
            .json(&request(stream))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        if stream {
            assert_eq!(response.headers()["content-type"], "text/event-stream");
            let body = response.text().await.unwrap();
            assert!(
                body.contains("ACP_")
                    && body.contains("OK")
                    && body.contains("[DONE]")
                    && body.contains("finish_reason")
            );
        } else {
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["choices"][0]["message"]["content"], "ACP_OK");
        }
    }
    let mut waiting = request(true);
    waiting["messages"][0]["content"] = json!("wait");
    let mut response = http
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("internal-test-key")
        .json(&waiting)
        .send()
        .await
        .unwrap();
    assert!(response.chunk().await.unwrap().is_some());
    let busy_response = http
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("internal-test-key")
        .json(&request(false))
        .send()
        .await
        .unwrap();
    assert_eq!(busy_response.status(), 429);
    drop(response);
    tokio::time::timeout(Duration::from_secs(5), async {
        while app.state::<AcpState>().snapshot().unwrap().busy {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("client disconnect must cancel and release the operation");
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
#[ignore = "requires ECPA_ACP_TEST_CORE pointing to a CPA v8 executable; starts an isolated kernel"]
async fn real_cpa_lists_and_routes_registered_acp_models() {
    let executable =
        PathBuf::from(std::env::var_os("ECPA_ACP_TEST_CORE").expect("Set ECPA_ACP_TEST_CORE"));
    let directory = crate::unique_test_temp_path("acp-cpa-contract");
    std::fs::create_dir_all(&directory).unwrap();
    let app = tauri::test::mock_app();
    app.manage(AcpState::default());
    app.manage(crate::GuiConfigState::new(crate::GuiConfigFile::default()));
    {
        let state = app.state::<AcpState>();
        let mut status = state.status.lock().unwrap();
        status.models = models();
        status.authenticated = true;
        status.upstream_enabled = true;
        status.executable = Some("fake-official-cli".into());
        status.profile = directory.to_string_lossy().into_owned();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bridge_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        app.handle().clone(),
        listener,
        "internal-test-key".into(),
        stop.clone(),
        spawn_fake,
    ));
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut document: serde_norway::Value = serde_norway::to_value(json!({
        "config-version":8,"server":{"host":"127.0.0.1","port":port},
        "management":{"disable-control-panel":true,"disable-auto-update-panel":true},
        "auth":{"dir":directory.join("auth")},"access":{"api-keys":["isolated-client-key"]},
        "logging":{"to-file":false},"requests":{"retry":0}
    }))
    .unwrap();
    patch_provider(
        &mut document,
        Some(provider_entry(&bridge_url, "internal-test-key", &models(), true).unwrap()),
    )
    .unwrap();
    let config = directory.join("config.yaml");
    std::fs::write(&config, serde_norway::to_string(&document).unwrap()).unwrap();
    let mut command = Command::new(executable);
    command
        .arg("-config")
        .arg(&config)
        .current_dir(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            std::fs::File::create(directory.join("core.log")).unwrap(),
        ))
        .stderr(Stdio::null());
    crate::configure_background_command(&mut command);
    let mut child = crate::spawn_core_child(command).unwrap();
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let result: Result<(), String> = async {
        let mut listed = false;
        for _ in 0..80 {
            if let Ok(response) = http
                .get(format!("{base}/v1/models"))
                .bearer_auth("isolated-client-key")
                .send()
                .await
            {
                if let Ok(body) = response.json::<Value>().await {
                    if body["data"].as_array().is_some_and(|items| {
                        items.iter().any(|item| item["id"] == "acp/test-model")
                    }) {
                        listed = true;
                        break;
                    }
                }
            }
            if child.try_wait().unwrap().is_some() {
                return Err("Isolated CPA exited".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !listed {
            return Err("CPA did not advertise acp/test-model".into());
        }
        for stream in [false, true] {
            let response = http
                .post(format!("{base}/v1/chat/completions"))
                .bearer_auth("isolated-client-key")
                .json(&request(stream))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = response.status();
            let body = response.text().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!("CPA returned {status}: {body}"));
            }
            if stream {
                if !body.contains("[DONE]") || !body.contains("ACP_") {
                    return Err(format!("Incomplete CPA SSE: {body}"));
                }
            } else if !body.contains("ACP_OK") {
                return Err(format!("Unexpected CPA response: {body}"));
            }
        }
        patch_provider(&mut document, None)?;
        std::fs::write(&config, serde_norway::to_string(&document).unwrap())
            .map_err(|e| e.to_string())?;
        for _ in 0..50 {
            let body: Value = http
                .get(format!("{base}/v1/models"))
                .bearer_auth("isolated-client-key")
                .send()
                .await
                .map_err(|e| e.to_string())?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            if !body["data"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["id"] == "acp/test-model"))
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("Removed ACP model remained listed after hot reload".into())
    }
    .await;
    let _ = crate::terminate_child(&mut child);
    drop(child);
    stop.cancel();
    server.await.unwrap();
    if let Err(error) = result {
        panic!(
            "{error}; kernel log: {}",
            std::fs::read_to_string(directory.join("core.log")).unwrap_or_default()
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}
