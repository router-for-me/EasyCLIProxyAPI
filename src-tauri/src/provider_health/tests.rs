use super::*;
use crate::GuiApiKeyEntry;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn provider_proxy_override_preserves_direct_and_global_inheritance() {
    let upstream = reqwest::Url::parse("https://provider.invalid/v1/responses").unwrap();
    let global = "http://127.0.0.1:18080";
    assert_eq!(provider_health_proxy_url(&upstream, None, global), global);
    assert_eq!(provider_health_proxy_url(&upstream, Some("  "), global), global);
    assert_eq!(provider_health_proxy_url(&upstream, Some(" direct "), global), "");
    assert_eq!(provider_health_proxy_url(&upstream, Some("socks5://127.0.0.1:19080"), global), "socks5://127.0.0.1:19080");
    let local = reqwest::Url::parse("http://127.0.0.1:8317/v1/responses").unwrap();
    assert_eq!(provider_health_proxy_url(&local, None, global), "");
}

#[tokio::test]
async fn provider_health_uses_request_proxy_instead_of_global_proxy() {
    let (port, server) = mock_core_response("200 OK", "text/event-stream", "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"OK\"}]}}]}\n\n", "").await;
    let request: ProviderHealthProbeRequest = serde_json::from_value(serde_json::json!({
        "url": "http://provider.invalid/v1beta/models/test:streamGenerateContent?alt=sse",
        "header": {}, "data": "{}", "protocol": "gemini",
        "proxyUrl": format!("http://127.0.0.1:{port}"),
    })).unwrap();
    let url = reqwest::Url::parse(&request.url).unwrap();
    let selected = provider_health_proxy_url(&url, request.proxy_url.as_deref(), "http://127.0.0.1:1");
    let client = build_http_client_with_proxy(reqwest::Client::builder().timeout(Duration::from_secs(3)), selected, "proxy test").unwrap();
    assert!(execute_health_probe(None, client, request).await.unwrap().first_token_latency_ms.is_some());
    let wire_request = server.await.unwrap();
    assert!(wire_request.starts_with("POST http://provider.invalid/v1beta/models/test:streamGenerateContent?alt=sse HTTP/1.1"));
}

async fn mock_core_response(
    status: &str,
    content_type: &str,
    initial_body: &str,
    delayed_body: &str,
) -> (u16, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{initial_body}",
        initial_body.len() + delayed_body.len(),
    );
    let delayed_body = delayed_body.to_string();
    let server = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(5), async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            loop {
                let mut chunk = [0; 2048];
                let size = socket.read(&mut chunk).await.unwrap();
                assert!(size > 0, "request ended before its body");
                received.extend_from_slice(&chunk[..size]);
                let Some(end) = received.windows(4).position(|window| window == b"\r\n\r\n") else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&received[..end]);
                let length = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                }).unwrap_or(0);
                if received.len() >= end + 4 + length {
                    break;
                }
            }
            socket.write_all(head.as_bytes()).await.unwrap();
            if !delayed_body.is_empty() {
                tokio::time::sleep(Duration::from_millis(60)).await;
                let _ = socket.write_all(delayed_body.as_bytes()).await;
            }
            String::from_utf8(received).unwrap()
        }).await.expect("mock kernel timed out")
    });
    (port, server)
}

fn probe_config(port: u16) -> GuiConfigFile {
    GuiConfigFile {
        port,
        api_keys: vec![
            GuiApiKeyEntry { key: " ".to_string(), remark: String::new() },
            GuiApiKeyEntry { key: " test-client-access-key ".to_string(), remark: String::new() },
        ],
        management_secret_key: "must-never-be-used-for-inference".to_string(),
        // A local kernel probe must succeed independently of upstream proxy settings.
        proxy_url: "http://127.0.0.1:1".to_string(),
        ..GuiConfigFile::default()
    }
}

#[tokio::test]
async fn core_health_probe_uses_local_inference_key_and_waits_for_model_text() {
    let metadata = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n";
    let text = "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\n";
    let (port, server) = mock_core_response("200 OK", "text/event-stream", metadata, text).await;
    let result = probe_core_model(&probe_config(port), "  custom/model-alias  ", Some(2_000))
        .await.unwrap();
    assert!(result.first_token_latency_ms.unwrap() >= 50);
    assert_eq!(result.first_token_latency_ms, Some(result.response_latency_ms));
    let request = server.await.unwrap();
    assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"));
    assert!(request.to_ascii_lowercase().contains("authorization: bearer test-client-access-key\r\n"));
    assert!(!request.contains("must-never-be-used-for-inference"));
    let body: serde_json::Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["model"], "custom/model-alias");
    assert_eq!(body["stream"], true);
    assert_eq!(body["max_tokens"], 16);
    assert_eq!(body["messages"][0]["role"], "user");
    let payload = serde_json::to_value(result).unwrap();
    assert!(payload["firstTokenLatencyMs"].as_u64().is_some());
    assert!(payload["responseLatencyMs"].as_u64().is_some());
}

#[tokio::test]
async fn core_health_probe_rejects_http_errors_redirects_and_empty_streams() {
    for (status, content_type, body, expected) in [
        ("401 Unauthorized", "application/json", "access denied", "HTTP 401"),
        ("200 OK", "application/json", "{\"choices\":[]}", "streaming response"),
        ("200 OK", "text/event-stream", "data: [DONE]\n\n", "first token"),
        ("302 Found\r\nLocation: http://127.0.0.1:1/v1/chat/completions", "text/plain", "", "HTTP 302"),
    ] {
        let (port, server) = mock_core_response(status, content_type, body, "").await;
        let error = probe_core_model(&probe_config(port), "test-model", Some(2_000)).await.err().unwrap();
        assert!(error.contains(expected), "unexpected probe error: {error}");
        server.await.unwrap();
    }
}

#[tokio::test]
async fn core_health_probe_rejects_invalid_model_and_port_without_a_request() {
    let config = probe_config(0);
    for model in ["", "  ", "bad\nmodel", &"a".repeat(241)] {
        let error = probe_core_model(&config, model, None).await.err().unwrap();
        assert!(error.contains("model"), "unexpected validation error: {error}");
    }
    assert!(probe_core_model(&config, "valid-model", None).await.err().unwrap().contains("port"));
}

#[tokio::test]
async fn core_health_model_list_preserves_all_provider_models() {
    let body = r#"{"data":[{"id":"gpt-test"},{"id":"claude-test"},{"id":"gemini-test"},{"id":"custom-alias"},{"id":"Foo","alias":"metadata-alias"},{"id":"foo"},{"id":"Foo"}]}"#;
    let (port, server) = mock_core_response("200 OK", "application/json", body, "").await;
    let config = probe_config(port);
    let models = fetch_core_models(config.port, effective_agent_api_key(&config)).await.unwrap();
    assert_eq!(models.iter().map(|model| model.name.as_str()).collect::<Vec<_>>(),
        vec!["gpt-test", "claude-test", "gemini-test", "custom-alias", "Foo", "foo"]);
    let request = server.await.unwrap();
    assert!(request.starts_with("GET /v1/models HTTP/1.1\r\n"));
    assert!(request.to_ascii_lowercase().contains("authorization: bearer test-client-access-key\r\n"));
    assert!(!request.contains("must-never-be-used-for-inference"));
}

#[test]
fn core_health_probe_timeout_is_bounded() {
    assert_eq!(health_probe_timeout(None), Duration::from_secs(15));
    assert_eq!(health_probe_timeout(Some(0)), Duration::from_secs(1));
    assert_eq!(health_probe_timeout(Some(u64::MAX)), Duration::from_secs(120));
}

#[test]
fn core_model_parser_keeps_public_ids_without_agent_alias_rewrites() {
    let models = parse_core_models(&serde_json::json!({ "data": [
        { "id": "Foo", "name": "Display Foo", "alias": "never-use-this-alias" },
        { "id": "foo", "displayName": "Lowercase foo" },
        { "id": "Foo", "displayName": "duplicate" },
        { "name": "legacy-model", "alias": "legacy-alias" },
    ] })).unwrap();
    assert_eq!(serde_json::to_value(models).unwrap(), serde_json::json!([
        { "name": "Foo", "displayName": "Display Foo" },
        { "name": "foo", "displayName": "Lowercase foo" },
        { "name": "legacy-model" },
    ]));
    let catalog = parse_core_models(&serde_json::json!({ "models": {
        "public-id": { "alias": "private-alias", "display_name": "Public model" },
    } })).unwrap();
    assert_eq!(catalog[0].name, "public-id");
    assert!(parse_core_models(&serde_json::json!({ "data": [{}] })).is_err());
    assert!(parse_core_models(&serde_json::json!({ "data": null })).is_err());
    assert!(parse_core_models(&serde_json::json!({ "data": [] })).unwrap().is_empty());
}

#[tokio::test]
async fn core_health_accepts_confirmed_reasoning_only_budget_exhaustion_without_ttft() {
    for finish_reason in ["max_tokens", "length"] {
        let body = format!("data: {}\n\ndata: [DONE]\n\n", serde_json::json!({
            "choices": [{ "delta": {}, "finish_reason": finish_reason }],
            "usage": { "completion_tokens": 16, "completion_tokens_details": { "reasoning_tokens": 16 } },
        }));
        let (port, server) = mock_core_response("200 OK", "text/event-stream", &body, "").await;
        let result = probe_core_model(&probe_config(port), "gemini-thinking", Some(2_000)).await.unwrap();
        assert!(result.first_token_latency_ms.is_none());
        assert!(result.response_latency_ms > 0);
        server.await.unwrap();
    }
}

#[test]
fn openai_terminal_success_requires_both_exhausted_budget_and_valid_reasoning_usage() {
    for value in [
        serde_json::json!({ "choices": [{ "delta": {}, "finish_reason": "max_tokens" }] }),
        serde_json::json!({ "choices": [{ "finish_reason": "max_tokens" }], "usage": {
            "completion_tokens": 16, "completion_tokens_details": { "reasoning_tokens": 0 },
        } }),
        serde_json::json!({ "choices": [{ "finish_reason": "max_tokens" }], "usage": {
            "completion_tokens": 4, "completion_tokens_details": { "reasoning_tokens": 16 },
        } }),
        serde_json::json!({ "choices": [{ "finish_reason": "content_filter" }], "usage": {
            "completion_tokens": 16, "completion_tokens_details": { "reasoning_tokens": 16 },
        } }),
        serde_json::json!({ "choices": [], "usage": {
            "completion_tokens": 16, "completion_tokens_details": { "reasoning_tokens": 16 },
        } }),
    ] {
        let body = format!("data: {value}\n\ndata: [DONE]\n\n");
        assert!(!provider_health_stream_has_terminal_success("openai-chat", body.as_bytes()));
    }
}
