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
    let text = String::from_utf8_lossy(bytes);
    text.lines().any(|line| {
        let line = line.trim();
        let data = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
        if data.is_empty() || data == "[DONE]" {
            return false;
        }
        serde_json::from_str::<serde_json::Value>(data)
            .ok()
            .is_some_and(|value| provider_health_json_has_text(protocol, &value))
    })
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
    let text = String::from_utf8_lossy(bytes);
    text.lines().any(|line| {
        let line = line.trim();
        let data = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
        if data.is_empty() || data == "[DONE]" {
            return false;
        }
        serde_json::from_str::<serde_json::Value>(data)
            .ok()
            .is_some_and(|value| provider_health_json_has_terminal_success(protocol, &value))
    })
}

fn provider_health_usage_tokens(protocol: &str, bytes: &[u8]) -> ProviderHealthUsageTokens {
    let mut tokens = ProviderHealthUsageTokens::default();
    let text = String::from_utf8_lossy(bytes);
    let values = serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .into_iter()
        .chain(text.lines().filter_map(|line| {
            let data = line.trim().strip_prefix("data:")?.trim();
            serde_json::from_str::<serde_json::Value>(data).ok()
        }));
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
    }
    let raw = serde_json::Value::Object(merged);
    let number = |paths: &[&str]| {
        paths
            .iter()
            .find_map(|p| raw.pointer(p).and_then(serde_json::Value::as_u64))
            .unwrap_or(0)
    };
    tokens.input_tokens = number(&["/prompt_tokens", "/input_tokens", "/promptTokenCount"]);
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
        if !response.status().is_success() {
            return Err(format!(
                "Upstream HTTP {}: {}",
                status_code,
                response.text().await.unwrap_or_default()
            ));
        }
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
        if first_token.is_none()
            && !provider_health_stream_has_terminal_success(&request.protocol, &received)
        {
            return Err("Health response contained no model output".to_string());
        }
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
