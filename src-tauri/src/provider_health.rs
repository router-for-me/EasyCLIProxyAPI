use super::{
    build_http_client_with_proxy, is_loopback_host, usage, GuiConfigState, APP_USER_AGENT,
};
use chrono::Local;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

const MAX_PROVIDER_HEALTH_STREAM_BYTES: usize = 256 * 1024;
static PROVIDER_HEALTH_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderHealthProbeRequest {
    #[serde(default)]
    provider: String,
    #[serde(default)]
    base_url: String,
    url: String,
    header: HashMap<String, String>,
    data: String,
    protocol: String,
    timeout_ms: Option<u64>,
    #[serde(default)]
    model: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    auth_index: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderHealthProbeResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    first_token_latency_ms: Option<u64>,
    response_latency_ms: u64,
}

#[derive(Default)]
struct ProviderHealthUsageTokens {
    observed: bool,
    raw_usage: serde_json::Value,
    cache_creation_tokens: u64,
    cache_creation_5m_tokens: u64,
    cache_creation_1h_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
    cache_read_tokens: u64,
    total_tokens: u64,
}

fn provider_health_value_has_text(value: Option<&serde_json::Value>) -> bool {
    match value {
        Some(serde_json::Value::String(text)) => !text.trim().is_empty(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .any(|item| provider_health_value_has_text(Some(item))),
        Some(serde_json::Value::Object(object)) => ["text", "content"]
            .iter()
            .any(|key| provider_health_value_has_text(object.get(*key))),
        _ => false,
    }
}

fn provider_health_json_has_text(protocol: &str, value: &serde_json::Value) -> bool {
    match protocol {
        "openai-chat" => value
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|choices| {
                choices.iter().any(|choice| {
                    provider_health_value_has_text(choice.pointer("/delta/content"))
                        || provider_health_value_has_text(
                            choice.pointer("/delta/reasoning_content"),
                        )
                        || provider_health_value_has_text(choice.pointer("/delta/reasoning"))
                        || provider_health_value_has_text(choice.pointer("/delta/thinking"))
                        || provider_health_value_has_text(choice.pointer("/message/content"))
                })
            }),
        "openai-responses" => {
            (matches!(
                value.get("type").and_then(serde_json::Value::as_str),
                Some(
                    "response.output_text.delta"
                        | "response.reasoning_text.delta"
                        | "response.reasoning_summary_text.delta"
                )
            ) && provider_health_value_has_text(value.get("delta")))
                || value
                    .get("output")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|output| {
                        output.iter().any(|item| {
                            item.get("content")
                                .and_then(serde_json::Value::as_array)
                                .is_some_and(|content| {
                                    content.iter().any(|part| {
                                        provider_health_value_has_text(part.get("text"))
                                    })
                                })
                        })
                    })
        }
        "claude" => {
            provider_health_value_has_text(value.pointer("/delta/text"))
                || provider_health_value_has_text(value.pointer("/delta/thinking"))
                || value
                    .get("content")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|content| {
                        content
                            .iter()
                            .any(|part| provider_health_value_has_text(part.get("text")))
                    })
        }
        "gemini" => value
            .get("candidates")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|candidates| {
                candidates.iter().any(|candidate| {
                    candidate
                        .pointer("/content/parts")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|parts| {
                            parts
                                .iter()
                                .any(|part| provider_health_value_has_text(part.get("text")))
                        })
                })
            }),
        _ => false,
    }
}

pub(crate) fn provider_health_stream_has_text(protocol: &str, bytes: &[u8]) -> bool {
    provider_health_values(bytes)
        .iter()
        .any(|value| provider_health_json_has_text(protocol, value))
}

fn provider_health_json_has_terminal_success(protocol: &str, value: &serde_json::Value) -> bool {
    if protocol != "gemini" {
        return false;
    }
    let exhausted_thinking_budget = value
        .get("candidates")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|candidates| {
            candidates.iter().any(|candidate| {
                candidate
                    .get("finishReason")
                    .and_then(serde_json::Value::as_str)
                    == Some("MAX_TOKENS")
            })
        });
    let thoughts = value
        .pointer("/usageMetadata/thoughtsTokenCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default();
    let total = value
        .pointer("/usageMetadata/totalTokenCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default();
    exhausted_thinking_budget && thoughts > 0 && total >= thoughts
}

pub(crate) fn provider_health_stream_has_terminal_success(protocol: &str, bytes: &[u8]) -> bool {
    provider_health_values(bytes)
        .iter()
        .any(|value| provider_health_json_has_terminal_success(protocol, value))
}

fn provider_health_usage_tokens(protocol: &str, bytes: &[u8]) -> ProviderHealthUsageTokens {
    let mut tokens = ProviderHealthUsageTokens::default();
    let values = provider_health_values(bytes);
    let mut merged = serde_json::Map::new();
    for value in values {
        let node = match protocol {
            "gemini" => value.get("usageMetadata"),
            "openai-responses" => value
                .pointer("/response/usage")
                .or_else(|| value.get("usage")),
            "claude" => value
                .pointer("/message/usage")
                .or_else(|| value.get("usage")),
            _ => value.get("usage"),
        };
        if let Some(node) = node.and_then(serde_json::Value::as_object) {
            tokens.observed = true;
            for (key, value) in node {
                merged.insert(key.clone(), value.clone());
            }
        }
        if let Some(tier) = value
            .pointer("/response/service_tier")
            .or_else(|| value.get("service_tier"))
            .and_then(serde_json::Value::as_str)
        {
            merged.insert("service_tier".into(), serde_json::json!(tier));
        }
    }
    let raw = serde_json::Value::Object(merged);
    let number = |paths: &[&str]| {
        paths
            .iter()
            .find_map(|p| raw.pointer(p).and_then(serde_json::Value::as_u64))
            .unwrap_or(0)
    };
    tokens.input_tokens = number(&["/prompt_tokens", "/input_tokens", "/promptTokenCount"]);
    if protocol == "gemini" {
        tokens.input_tokens = tokens
            .input_tokens
            .saturating_add(number(&["/toolUsePromptTokenCount"]));
    }
    tokens.output_tokens = number(&[
        "/completion_tokens",
        "/output_tokens",
        "/candidatesTokenCount",
    ]);
    tokens.reasoning_tokens = number(&[
        "/completion_tokens_details/reasoning_tokens",
        "/output_tokens_details/reasoning_tokens",
        "/output_tokens_details/thinking_tokens",
        "/thoughtsTokenCount",
    ]);
    tokens.cache_read_tokens = number(&[
        "/prompt_tokens_details/cached_tokens",
        "/input_tokens_details/cached_tokens",
        "/input_token_details/cached_tokens",
        "/prompt_cache_hit_tokens",
        "/cache_read_input_tokens",
        "/cachedContentTokenCount",
    ]);
    tokens.cache_creation_tokens = number(&[
        "/cache_creation_input_tokens",
        "/input_tokens_details/cache_creation_tokens",
    ]);
    tokens.cache_creation_5m_tokens = number(&["/cache_creation/ephemeral_5m_input_tokens"]);
    tokens.cache_creation_1h_tokens = number(&["/cache_creation/ephemeral_1h_input_tokens"]);
    tokens.total_tokens = number(&["/total_tokens", "/totalTokenCount"]);
    if tokens.total_tokens == 0 && tokens.observed {
        tokens.total_tokens = tokens.input_tokens.saturating_add(tokens.output_tokens);
        if protocol == "gemini" {
            tokens.total_tokens = tokens.total_tokens.saturating_add(tokens.reasoning_tokens);
        }
        if protocol == "claude" {
            tokens.total_tokens = tokens
                .total_tokens
                .saturating_add(tokens.cache_read_tokens)
                .saturating_add(tokens.cache_creation_tokens);
        }
    }
    tokens.raw_usage = raw;
    tokens
}

fn provider_health_usage_provider(protocol: &str) -> &str {
    match protocol {
        "openai-responses" => "codex",
        "openai-chat" => "openai",
        "claude" => "claude",
        "gemini" => "gemini",
        _ => "unknown",
    }
}

fn persist_provider_health_outcome(
    app: &tauri::AppHandle,
    request: &ProviderHealthProbeRequest,
    endpoint: &str,
    latency_ms: u64,
    ttft_ms: Option<u64>,
    received: &[u8],
    failure: Option<&str>,
    status: u16,
) {
    let tokens = provider_health_usage_tokens(&request.protocol, received);
    let ticks = tokens.raw_usage["cost_in_usd_ticks"].as_u64();
    let cost_usd = ticks.map(|n| format!("{}.{:010}", n / 10_000_000_000, n % 10_000_000_000));
    let provider = if reqwest::Url::parse(&request.url)
        .ok()
        .is_some_and(|u| u.host_str() == Some("api.x.ai"))
    {
        "xai"
    } else if request.provider.is_empty() {
        provider_health_usage_provider(&request.protocol)
    } else {
        &request.provider
    };
    let event = serde_json::json!({
        "timestamp": Local::now().to_rfc3339(),
        "latency_ms": latency_ms,
        "ttft_ms": ttft_ms,
        "source": if request.auth_index.is_empty() { &request.base_url } else { &request.auth_index },
        "api_key": request.source.as_str(),
        "auth_index": request.auth_index.as_str(),
        "failed": failure.is_some(),
        "fail": {"status_code":status, "body":failure.unwrap_or("")},
        "usage_observed": tokens.observed,
        "usage_complete": failure.is_none(),
        "response_service_tier": tokens.raw_usage.get("service_tier"),
        "raw_usage": tokens.raw_usage,
        "kind": "health_check",
        "stream": true,
        "base_url": request.base_url.as_str(),
        "cache_creation_5m_tokens": tokens.cache_creation_5m_tokens,
        "cache_creation_1h_tokens": tokens.cache_creation_1h_tokens,
        "provider": provider,
        "cost_usd": cost_usd,
        "model": request.model.as_str(),
        "executor_type": "DesktopProviderHealthCheck",
        "endpoint": endpoint,
        "generate": false,
        "tokens": {
            "input_tokens": tokens.input_tokens,
            "output_tokens": tokens.output_tokens,
            "reasoning_tokens": tokens.reasoning_tokens,
            "cache_read_tokens": tokens.cache_read_tokens,
            "cache_creation_tokens": tokens.cache_creation_tokens,
            "total_tokens": tokens.total_tokens,
        },
    });
    if let Err(error) = usage::persist_local_usage_event(app, "desktop_health_check", event) {
        eprintln!("保存桌面健康检测使用记录失败: {error}");
    }
}

fn provider_health_values(bytes: &[u8]) -> Vec<serde_json::Value> {
    if let Ok(value) = serde_json::from_slice(bytes) {
        return vec![value];
    }
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(|line| {
            let line = line.trim().trim_start_matches('\u{1e}').trim();
            let data = line.strip_prefix("data:").unwrap_or(line).trim();
            serde_json::from_str(data).ok()
        })
        .collect()
}

fn provider_health_completion_result(
    protocol: &str,
    received: &[u8],
    first_token: Option<u64>,
) -> Result<(), String> {
    let values = provider_health_values(received);
    if values.iter().any(|value| {
        value.get("error").is_some_and(|v| !v.is_null())
            || matches!(
                value["type"].as_str(),
                Some("error" | "response.failed" | "response.incomplete" | "response.cancelled")
            )
            || matches!(
                value["status"]
                    .as_str()
                    .or(value["response"]["status"].as_str()),
                Some("failed" | "incomplete" | "cancelled")
            )
    }) {
        return Err("Health response ended with an upstream error; usage is incomplete".into());
    }
    let whole_json = !String::from_utf8_lossy(received)
        .lines()
        .any(|line| line.trim_start().starts_with("data:"));
    let terminal = match protocol {
        "openai-chat" => {
            String::from_utf8_lossy(received).lines().any(|line| {
                line.trim()
                    .strip_prefix("data:")
                    .is_some_and(|v| v.trim() == "[DONE]")
            }) || whole_json
                && values.iter().any(|v| {
                    v["choices"].as_array().is_some_and(|choices| {
                        !choices.is_empty()
                            && choices
                                .iter()
                                .all(|c| c["finish_reason"].as_str().is_some())
                    })
                })
        }
        "openai-responses" => values
            .iter()
            .any(|v| v["type"] == "response.completed" || whole_json && v["status"] == "completed"),
        "claude" => values.iter().any(|v| {
            v["type"] == "message_stop" || whole_json && v["stop_reason"].as_str().is_some()
        }),
        "gemini" => values.iter().any(|v| {
            v["candidates"].as_array().is_some_and(|cs| {
                !cs.is_empty()
                    && cs
                        .iter()
                        .all(|c| matches!(c["finishReason"].as_str(), Some("STOP" | "MAX_TOKENS")))
            })
        }),
        _ => false,
    };
    if !terminal {
        return Err("Health stream ended before terminal response; usage is incomplete".into());
    }
    if first_token.is_none() && !provider_health_stream_has_terminal_success(protocol, received) {
        return Err("Health response contained no model output".into());
    }
    Ok(())
}

pub(crate) fn provider_health_content_type_is_streaming(content_type: &str) -> bool {
    let content_type = content_type.to_ascii_lowercase();
    content_type.contains("text/event-stream")
        || content_type.contains("application/x-ndjson")
        || content_type.contains("application/json-seq")
}

#[tauri::command]
pub(crate) async fn provider_health_probe(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    request: ProviderHealthProbeRequest,
) -> Result<ProviderHealthProbeResponse, String> {
    let url = reqwest::Url::parse(request.url.trim())
        .map_err(|error| format!("健康检测地址无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("健康检测仅支持 HTTP 或 HTTPS 地址".to_string());
    }
    if !matches!(
        request.protocol.as_str(),
        "openai-chat" | "openai-responses" | "claude" | "gemini"
    ) {
        return Err("不支持的健康检测协议".to_string());
    }
    let endpoint = format!("POST {}", url.path());
    if request.data.len() > 64 * 1024 {
        return Err("健康检测请求体过大".to_string());
    }

    let _permit = PROVIDER_HEALTH_SLOTS
        .acquire()
        .await
        .map_err(|error| error.to_string())?;
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(15_000).clamp(1_000, 120_000));
    let config = gui_config_state.snapshot()?;
    let proxy_url = url
        .host_str()
        .filter(|host| !is_loopback_host(host))
        .map(|_| config.proxy_url.as_str())
        .unwrap_or_default();
    let client = build_http_client_with_proxy(
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(timeout),
        proxy_url,
        "创建健康检测客户端失败",
    )?;
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &request.header {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| format!("健康检测请求头名称无效: {error}"))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|error| format!("健康检测请求头值无效: {error}"))?;
        headers.insert(name, value);
    }
    if !headers.contains_key(reqwest::header::USER_AGENT) {
        headers.insert(
            reqwest::header::USER_AGENT,
            reqwest::header::HeaderValue::from_static(APP_USER_AGENT),
        );
    }

    let started_at = Instant::now();
    let mut received = Vec::new();
    let mut first_token = None;
    let mut status_code = 0;
    let result = async {
        let response = client
            .post(url)
            .headers(headers)
            .body(request.data.clone())
            .send()
            .await
            .map_err(|error| format!("Health request failed: {error}"))?;
        status_code = response.status().as_u16();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("Health stream failed: {error}"))?;
            if received.len().saturating_add(chunk.len()) > MAX_PROVIDER_HEALTH_STREAM_BYTES {
                return Err(
                    "Health response exceeded capture limit; usage is incomplete".to_string(),
                );
            }
            received.extend_from_slice(&chunk);
            if first_token.is_none()
                && provider_health_stream_has_text(&request.protocol, &received)
            {
                first_token = Some(started_at.elapsed().as_millis().max(1) as u64);
            }
        }
        if !(200..300).contains(&status_code) {
            return Err(format!(
                "Upstream HTTP {}: {}",
                status_code,
                String::from_utf8_lossy(&received)
            ));
        }
        provider_health_completion_result(&request.protocol, &received, first_token)?;
        Ok(ProviderHealthProbeResponse {
            first_token_latency_ms: first_token,
            response_latency_ms: started_at.elapsed().as_millis().max(1) as u64,
        })
    }
    .await;
    persist_provider_health_outcome(
        &app,
        &request,
        &endpoint,
        started_at.elapsed().as_millis().max(1) as u64,
        first_token,
        &received,
        result.as_ref().err().map(String::as_str),
        status_code,
    );
    result
}

#[cfg(test)]
mod accounting_tests {
    use super::*;
    #[test]
    fn health_chat_usage_is_not_lost() {
        let tokens = provider_health_usage_tokens(
            "openai-chat",
            br#"data: {"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}"#,
        );
        assert_eq!(tokens.total_tokens, 110);
    }
    #[test]
    fn health_claude_merges_start_and_delta_usage() {
        let tokens = provider_health_usage_tokens("claude", b"data: {\"message\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":1}}}\n\ndata: {\"usage\":{\"output_tokens\":10}}\n\n");
        assert_eq!(tokens.input_tokens, 100);
        assert_eq!(tokens.output_tokens, 10);
    }
}

#[cfg(test)]
mod review_regressions {
    use super::*;
    #[test]
    fn health_eof_after_text_is_incomplete() {
        assert!(provider_health_completion_result(
            "claude",
            b"data: {\"delta\":{\"text\":\"hello\"}}\n\n",
            Some(1)
        )
        .is_err());
    }
    #[test]
    fn health_stream_error_cannot_be_hidden_by_text() {
        let body = b"data: {\"delta\":{\"text\":\"hello\"}}\n\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}\n\n";
        assert!(provider_health_completion_result("claude", body, Some(1)).is_err());
    }
    #[test]
    fn health_parses_provider_cache_and_tool_input_fields() {
        let deepseek = provider_health_usage_tokens("openai-chat", br#"{"usage":{"prompt_tokens":1000,"prompt_cache_hit_tokens":900,"completion_tokens":10,"total_tokens":1010}}"#);
        assert_eq!(deepseek.cache_read_tokens, 900);
        let gemini = provider_health_usage_tokens("gemini", br#"{"usageMetadata":{"promptTokenCount":100,"toolUsePromptTokenCount":50,"candidatesTokenCount":20,"totalTokenCount":170}}"#);
        assert_eq!(gemini.input_tokens, 150);
    }
}

#[cfg(test)]
mod terminal_controls {
    use super::*;
    #[test]
    fn final_success_is_recognized_for_all_probe_protocols() {
        for (protocol, payload) in [
            ("openai-chat", "data: [DONE]\n\n"),
            ("openai-responses", "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"),
            ("claude", "data: {\"type\":\"message_stop\"}\n\n"),
            ("gemini", "data: {\"candidates\":[{\"finishReason\":\"STOP\"}]}\n\n"),
        ] {
            assert!(provider_health_completion_result(protocol, payload.as_bytes(), Some(1)).is_ok(), "{protocol}");
        }
    }
    #[test]
    fn late_error_overrides_a_terminal_success() {
        let bytes =
            b"data: {\"type\":\"response.completed\"}\n\ndata: {\"type\":\"response.failed\"}\n\n";
        assert!(provider_health_completion_result("openai-responses", bytes, Some(1)).is_err());
    }
}

#[cfg(test)]
mod final_review_regressions {
    use super::*;
    #[test]
    fn ndjson_retains_text_usage_and_terminal_state() {
        let body = b"{\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n{\"choices\":[{\"finish_reason\":\"stop\"}]}\n{\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":2,\"total_tokens\":102}}\n";
        assert!(provider_health_stream_has_text("openai-chat", body));
        assert_eq!(
            provider_health_usage_tokens("openai-chat", body).total_tokens,
            102
        );
        assert!(provider_health_completion_result("openai-chat", body, Some(1)).is_ok());
    }
    #[test]
    fn direct_probe_preserves_actual_response_service_tier() {
        let tokens=provider_health_usage_tokens("openai-responses",br#"data: {"type":"response.completed","response":{"service_tier":"fast","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}"#);
        assert_eq!(tokens.raw_usage["service_tier"], "fast");
    }
}
