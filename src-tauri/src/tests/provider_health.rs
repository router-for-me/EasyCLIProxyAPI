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
    assert!(provider_health_stream_has_text("interactions", br#"data: {"event_type":"content.delta","delta":{"type":"text","text":"Hello"}}
"#));
    assert!(provider_health_stream_has_text("interactions", br#"data: {"event_type":"interaction.complete","interaction":{"status":"completed","outputs":[{"type":"text","text":"Hello"}]}}
"#));
    assert!(provider_health_stream_has_terminal_success("interactions", br#"data: {"event_type":"interaction.complete","interaction":{"status":"completed"}}
"#));
    assert!(!provider_health_stream_has_terminal_success("interactions", br#"data: {"event_type":"interaction.complete","interaction":{"status":"failed"}}
"#));
    assert!(!provider_health_stream_has_text("interactions", br#"data: {"event_type":"content.delta","delta":{"type":"image","text":"metadata"}}
"#));
}
