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
    if protocol != "gemini" {
        return tokens;
    }
    let text = String::from_utf8_lossy(bytes);
    for line in text.lines() {
        let line = line.trim();
        let data = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
        let Some(usage) = serde_json::from_str::<serde_json::Value>(data)
            .ok()
            .and_then(|value| value.get("usageMetadata").cloned())
        else {
            continue;
        };
        tokens.input_tokens = tokens.input_tokens.max(
            usage
                .get("promptTokenCount")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default(),
        );
        tokens.output_tokens = tokens.output_tokens.max(
            usage
                .get("candidatesTokenCount")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default(),
        );
        tokens.reasoning_tokens = tokens.reasoning_tokens.max(
            usage
                .get("thoughtsTokenCount")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default(),
        );
        tokens.cache_read_tokens = tokens.cache_read_tokens.max(
            usage
                .get("cachedContentTokenCount")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default(),
        );
        tokens.total_tokens = tokens.total_tokens.max(
            usage
                .get("totalTokenCount")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default(),
        );
    }
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

fn persist_provider_health_success(
    app: &tauri::AppHandle,
    request: &ProviderHealthProbeRequest,
    endpoint: &str,
    latency_ms: u64,
    ttft_ms: Option<u64>,
    received: &[u8],
) {
    let tokens = provider_health_usage_tokens(&request.protocol, received);
    let event = serde_json::json!({
        "timestamp": Local::now().to_rfc3339(),
        "latency_ms": latency_ms,
        "ttft_ms": ttft_ms,
        "source": request.source.as_str(),
        "auth_index": request.auth_index.as_str(),
        "failed": false,
        "provider": provider_health_usage_provider(&request.protocol),
        "model": request.model.as_str(),
        "executor_type": "DesktopProviderHealthCheck",
        "endpoint": endpoint,
        "generate": false,
        "tokens": {
            "input_tokens": tokens.input_tokens,
            "output_tokens": tokens.output_tokens,
            "reasoning_tokens": tokens.reasoning_tokens,
            "cache_read_tokens": tokens.cache_read_tokens,
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
    let response = client
        .post(url)
        .headers(headers)
        .body(request.data.clone())
        .send()
        .await
        .map_err(|error| format!("健康检测请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            format!("上游返回 HTTP {}", status.as_u16())
        } else {
            format!("上游返回 HTTP {}: {}", status.as_u16(), detail)
        });
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !provider_health_content_type_is_streaming(&content_type) {
        return Err("上游未返回流式响应，无法测量首字延迟".to_string());
    }

    let mut stream = response.bytes_stream();
    let mut received = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取健康检测流失败: {error}"))?;
        if received.len().saturating_add(chunk.len()) > MAX_PROVIDER_HEALTH_STREAM_BYTES {
            return Err("健康检测在限制范围内未收到模型首字".to_string());
        }
        received.extend_from_slice(&chunk);
        let elapsed_ms = started_at.elapsed().as_millis().max(1) as u64;
        if provider_health_stream_has_text(&request.protocol, &received) {
            persist_provider_health_success(
                &app,
                &request,
                &endpoint,
                elapsed_ms,
                Some(elapsed_ms),
                &received,
            );
            return Ok(ProviderHealthProbeResponse {
                first_token_latency_ms: Some(elapsed_ms),
                response_latency_ms: elapsed_ms,
            });
        }
        if provider_health_stream_has_terminal_success(&request.protocol, &received) {
            persist_provider_health_success(&app, &request, &endpoint, elapsed_ms, None, &received);
            return Ok(ProviderHealthProbeResponse {
                first_token_latency_ms: None,
                response_latency_ms: elapsed_ms,
            });
        }
    }
    Err("健康检测未收到模型首字".to_string())
}
