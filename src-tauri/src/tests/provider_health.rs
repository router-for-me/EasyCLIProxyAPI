use super::*;

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
    assert!(provider_health_stream_has_terminal_success(
        "gemini",
        gemini_thought_only
    ));

    let gemini_empty_max_tokens =
        br#"data: {"candidates":[{"finishReason":"MAX_TOKENS"}],"usageMetadata":{"totalTokenCount":1,"thoughtsTokenCount":0}}

"#;
    assert!(!provider_health_stream_has_terminal_success(
        "gemini",
        gemini_empty_max_tokens
    ));

    let gemini_safety = br#"data: {"candidates":[{"finishReason":"SAFETY"}],"usageMetadata":{"totalTokenCount":14,"thoughtsTokenCount":13}}

"#;
    assert!(!provider_health_stream_has_terminal_success(
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
