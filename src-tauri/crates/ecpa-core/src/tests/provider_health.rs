use super::*;
use crate::provider_health::provider_health_stream_has_budget_exhausted;

#[test]
fn provider_health_stream_detects_only_real_model_text() {
    assert!(provider_health_content_type_is_streaming(
        "text/event-stream; charset=utf-8"
    ));
    assert!(provider_health_content_type_is_streaming(
        "application/x-ndjson"
    ));
    assert!(!provider_health_content_type_is_streaming(
        "application/json"
    ));

    let openai_metadata = br#"data: {"choices":[{"delta":{"role":"assistant","content":""}}]}

"#;
    let openai_text = br#"data: {"choices":[{"delta":{"content":"H"}}]}

"#;
    assert!(!provider_health_stream_has_text(
        "openai-chat",
        openai_metadata
    ));
    assert!(provider_health_stream_has_text("openai-chat", openai_text));
    let openai_reasoning = br#"data: {"choices":[{"delta":{"reasoning_content":"R"}}]}

"#;
    assert!(provider_health_stream_has_text(
        "openai-chat",
        openai_reasoning
    ));

    let responses_metadata = br#"event: response.created
data: {"type":"response.created"}

"#;
    let responses_text = br#"event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"H"}

"#;
    assert!(!provider_health_stream_has_text(
        "openai-responses",
        responses_metadata
    ));
    assert!(provider_health_stream_has_text(
        "openai-responses",
        responses_text
    ));

    let claude_metadata = br#"event: message_start
data: {"type":"message_start"}

"#;
    let claude_text = br#"event: content_block_delta
data: {"delta":{"type":"text_delta","text":"H"}}

"#;
    assert!(!provider_health_stream_has_text("claude", claude_metadata));
    assert!(provider_health_stream_has_text("claude", claude_text));

    let gemini_text = br#"data: {"candidates":[{"content":{"parts":[{"text":"H"}]}}]}

"#;
    assert!(provider_health_stream_has_text("gemini", gemini_text));

    let gemini_thought_only = br#"data: {"candidates":[{"content":{},"finishReason":"MAX_TOKENS","index":0}],"usageMetadata":{"promptTokenCount":1,"totalTokenCount":14,"thoughtsTokenCount":13},"modelVersion":"gemini-3.7-flash"}

"#;
    assert!(!provider_health_stream_has_text(
        "gemini",
        gemini_thought_only
    ));
    assert!(provider_health_stream_has_budget_exhausted(
        "gemini",
        gemini_thought_only
    ));

    let gemini_empty_max_tokens =
        br#"data: {"candidates":[{"finishReason":"MAX_TOKENS"}],"usageMetadata":{"totalTokenCount":1,"thoughtsTokenCount":0}}

"#;
    assert!(!provider_health_stream_has_budget_exhausted(
        "gemini",
        gemini_empty_max_tokens
    ));

    let gemini_safety = br#"data: {"candidates":[{"finishReason":"SAFETY"}],"usageMetadata":{"totalTokenCount":14,"thoughtsTokenCount":13}}

"#;
    assert!(!provider_health_stream_has_budget_exhausted(
        "gemini",
        gemini_safety
    ));
    assert!(!provider_health_stream_has_terminal_success(
        "openai-chat",
        gemini_thought_only
    ));
}

#[test]
fn interactions_health_probe_recognizes_content_and_completed_events() {
    assert!(provider_health_stream_has_text(
        "interactions",
        br#"data: {"event_type":"content.delta","delta":{"type":"text","text":"Hello"}}
"#
    ));
    assert!(provider_health_stream_has_text("interactions", br#"data: {"event_type":"interaction.complete","interaction":{"status":"completed","outputs":[{"type":"text","text":"Hello"}]}}
"#));
    assert!(provider_health_stream_has_terminal_success(
        "interactions",
        br#"data: {"event_type":"interaction.complete","interaction":{"status":"completed"}}
"#
    ));
    assert!(!provider_health_stream_has_terminal_success(
        "interactions",
        br#"data: {"event_type":"interaction.complete","interaction":{"status":"failed"}}
"#
    ));
    assert!(!provider_health_stream_has_text(
        "interactions",
        br#"data: {"event_type":"content.delta","delta":{"type":"image","text":"metadata"}}
"#
    ));
}

#[test]
fn interactions_health_probe_recognizes_new_and_legacy_text_deltas() {
    for event in ["step.delta", "content.delta"] {
        for event_key in ["event_type", "type"] {
            for (delta, expected) in [
                (serde_json::json!({"type": "text", "text": "Hello"}), true),
                (serde_json::json!({"type": "text", "text": ""}), false),
                (serde_json::json!({"type": "text", "text": " \n\t"}), false),
                (
                    serde_json::json!({"type": "image", "text": "metadata"}),
                    false,
                ),
                (serde_json::json!({"type": "text"}), false),
            ] {
                let mut payload = serde_json::json!({"delta": delta});
                payload[event_key] = serde_json::json!(event);
                let stream = format!("event: {event}\ndata: {payload}\n\n");
                assert_eq!(
                    provider_health_stream_has_text("interactions", stream.as_bytes()),
                    expected,
                    "{payload}"
                );
                assert!(!provider_health_stream_has_terminal_success(
                    "interactions",
                    stream.as_bytes()
                ));
            }
        }
    }
}

#[test]
fn interactions_health_probe_checks_completed_event_status_and_text() {
    for event in ["interaction.completed", "interaction.complete"] {
        for event_key in ["event_type", "type"] {
            for (status, expected) in [
                (Some(serde_json::json!("completed")), true),
                (Some(serde_json::json!("succeeded")), true),
                (None, true),
                (Some(serde_json::json!("failed")), false),
                (Some(serde_json::json!("cancelled")), false),
                (Some(serde_json::json!("canceled")), false),
                (Some(serde_json::json!("in_progress")), false),
                (Some(serde_json::json!(42)), false),
            ] {
                for output_key in ["steps", "outputs"] {
                    for output in [
                        serde_json::json!([{"type": "text", "text": "Hello"}]),
                        serde_json::json!([{"content": [{"type": "text", "text": "Hello"}]}]),
                        serde_json::json!([]),
                    ] {
                        let has_text = output.as_array().is_some_and(|items| !items.is_empty());
                        let mut payload = serde_json::json!({"interaction": {}});
                        payload[event_key] = serde_json::json!(event);
                        payload["interaction"][output_key] = output;
                        if let Some(status) = &status {
                            payload["interaction"]["status"] = status.clone();
                        }
                        let stream = format!("event: {event}\ndata: {payload}\n\n");
                        assert_eq!(
                            provider_health_stream_has_terminal_success(
                                "interactions",
                                stream.as_bytes()
                            ),
                            expected,
                            "{payload}"
                        );
                        assert_eq!(
                            provider_health_stream_has_text("interactions", stream.as_bytes()),
                            expected && has_text,
                            "{payload}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn interactions_health_probe_handles_chunk_boundaries_and_done() {
    let chunks: &[(&[u8], bool, bool)] = &[
        (
            b"event: step.delta\ndata: {\"index\":1,\"delta\":{\"text\":\"Hel",
            false,
            false,
        ),
        (
            b"lo! How can I help\",\"type\":\"text\"},\"event_type\":\"step.",
            false,
            false,
        ),
        (
            b"delta\"}\n\nevent: interaction.completed\ndata: {\"interaction\":{\"status\":\"comp",
            true,
            false,
        ),
        (
            b"leted\"},\"event_type\":\"interaction.completed\"}\n\nevent: done\ndata: [DO",
            true,
            true,
        ),
        (b"NE]\n\n", true, true),
    ];
    let mut received = Vec::new();
    for (chunk, has_text, has_terminal_success) in chunks {
        received.extend_from_slice(chunk);
        assert_eq!(
            provider_health_stream_has_text("interactions", &received),
            *has_text
        );
        assert_eq!(
            provider_health_stream_has_terminal_success("interactions", &received),
            *has_terminal_success
        );
    }
    for stream in [
        "event: done\ndata: [DONE]\n\n",
        "event: step.delta\ndata: not json\n\n",
        "data: {}\n\n",
    ] {
        assert!(!provider_health_stream_has_text(
            "interactions",
            stream.as_bytes()
        ));
        assert!(!provider_health_stream_has_terminal_success(
            "interactions",
            stream.as_bytes()
        ));
    }
}
async fn interactions_serve_new_events_once(listener: tokio::net::TcpListener) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut socket, _) = listener.accept().await.expect("accept");
    let mut buffer = vec![0u8; 4096];
    let _ = socket.read(&mut buffer).await;
    let request = String::from_utf8_lossy(&buffer);
    assert!(
        request.contains("/v1beta/interactions"),
        "unexpected path: {request}"
    );
    let body = concat!(
        "event: step.delta\n",
        "data: {\"index\":1,\"delta\":{\"text\":\"Hello! How can I help\",\"type\":\"text\"},\"event_type\":\"step.delta\"}\n\n",
        "event: interaction.completed\n",
        "data: {\"interaction\":{\"status\":\"completed\"},\"event_type\":\"interaction.completed\"}\n\n",
        "event: done\n",
        "data: [DONE]\n\n"
    );
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(body.as_bytes()).await;
    let _ = socket.flush().await;
}

/// Drives the same streaming loop the desktop probe uses against a local server
/// replaying the real Interactions event names, so the deploy path is covered
/// without a live provider key.
#[tokio::test]
async fn interactions_streaming_probe_path_accepts_new_events() {
    use futures_util::StreamExt;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(interactions_serve_new_events_once(listener));

    let client = reqwest::Client::builder().build().expect("client");
    let response = client
        .post(format!("http://{addr}/v1beta/interactions"))
        .header("Content-Type", "application/json")
        .body("{\"model\":\"gemini-4-hydrogen\",\"input\":\"hi\",\"stream\":true}")
        .send()
        .await
        .expect("send");
    assert!(response.status().is_success());
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    assert!(provider_health_content_type_is_streaming(content_type));

    let mut stream = response.bytes_stream();
    let mut received = Vec::new();
    let mut first_token = false;
    let mut terminal = false;
    while let Some(chunk) = stream.next().await {
        received.extend_from_slice(&chunk.expect("chunk"));
        if provider_health_stream_has_text("interactions", &received) {
            first_token = true;
        }
        if provider_health_stream_has_terminal_success("interactions", &received) {
            terminal = true;
        }
        if first_token && terminal {
            break;
        }
    }
    assert!(first_token, "probe never saw the first token");
    assert!(terminal, "probe never saw a terminal success");
    let _ = server.await;
}
/// Serves one raw HTTP response with the given body and closes the connection.
async fn serve_raw_http_once(listener: tokio::net::TcpListener, body: &'static str) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut socket, _) = listener.accept().await.expect("accept");
    let mut buffer = vec![0u8; 8192];
    let _ = socket.read(&mut buffer).await;
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = socket.write_all(head.as_bytes()).await;
    for chunk in body.as_bytes().chunks(48) {
        let _ = socket.write_all(chunk).await;
        let _ = socket.flush().await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn interactions_probe_request(url: String) -> crate::provider_health::ProviderHealthProbeRequest {
    crate::provider_health::ProviderHealthProbeRequest {
        url,
        header: std::collections::HashMap::from([(
            "Content-Type".to_string(),
            "application/json".to_string(),
        )]),
        source_provider: None,
        data: "{\"model\":\"gemini-4-hydrogen\",\"input\":\"hi\",\"stream\":true}".to_string(),
        protocol: "interactions".to_string(),
        model: "gemini-4-hydrogen".to_string(),
        source: "test-key".to_string(),
        auth_index: String::new(),
        proxy_url: None,
        timeout_ms: Some(5_000),
    }
}

/// The production probe path, not a re-implementation, must accept a stream
/// that only carries the interaction.completed event and its steps payload.
#[tokio::test]
async fn interactions_probe_path_accepts_completed_only_stream() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(serve_raw_http_once(
        listener,
        "event: interaction.completed\ndata: {\"interaction\":{\"status\":\"completed\",\"steps\":[{\"type\":\"text\",\"text\":\"Hello\"}]},\"event_type\":\"interaction.completed\"}\n\nevent: done\ndata: [DONE]\n\n",
    ));

    let request = interactions_probe_request(format!("http://{addr}/v1beta/interactions"));
    let client = reqwest::Client::builder().build().expect("client");
    let result = crate::provider_health::execute_health_probe(None, client, request).await;
    server.await.expect("server");
    let response = result.expect("completed-only stream must be accepted");
    // The probe reports the terminal-event latency as a first token because the
    // completed payload carries text, which is the pre-existing behaviour for
    // completed-only streams and must stay accepted.
    assert!(response.first_token_latency_ms.is_some());
    assert!(response.response_latency_ms > 0);
}

/// A stream whose only text arrives through step.delta must report a first
/// token latency measured on the real production loop.
#[tokio::test]
async fn interactions_probe_path_reports_first_token_for_step_delta() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(serve_raw_http_once(
        listener,
        "event: step.delta\ndata: {\"index\":1,\"delta\":{\"text\":\"Hello! How can I help\",\"type\":\"text\"},\"event_type\":\"step.delta\"}\n\nevent: interaction.completed\ndata: {\"interaction\":{\"status\":\"completed\"},\"event_type\":\"interaction.completed\"}\n\nevent: done\ndata: [DONE]\n\n",
    ));

    let request = interactions_probe_request(format!("http://{addr}/v1beta/interactions"));
    let client = reqwest::Client::builder().build().expect("client");
    let result = crate::provider_health::execute_health_probe(None, client, request).await;
    server.await.expect("server");
    let response = result.expect("step.delta stream must be accepted");
    assert!(
        response.first_token_latency_ms.is_some(),
        "a text delta must produce a first-token latency"
    );
}

/// A failed completion must never be accepted by the production probe.
#[tokio::test]
async fn interactions_probe_path_rejects_failed_completion_stream() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(serve_raw_http_once(
        listener,
        "event: interaction.completed\ndata: {\"interaction\":{\"status\":\"failed\"},\"event_type\":\"interaction.completed\"}\n\nevent: done\ndata: [DONE]\n\n",
    ));

    let request = interactions_probe_request(format!("http://{addr}/v1beta/interactions"));
    let client = reqwest::Client::builder().build().expect("client");
    let result = crate::provider_health::execute_health_probe(None, client, request).await;
    server.await.expect("server");
    assert!(
        result.is_err(),
        "a failed interaction must not be reported as healthy"
    );
}
