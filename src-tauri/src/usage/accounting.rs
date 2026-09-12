use super::*;
use chrono::{Datelike, Timelike};
use serde_json::json;

pub(super) fn normalize_accounting(value: &Value, tokens: &mut UsageTokenStats) -> Value {
    let mut accounting = json!({"raw_tokens": value.get("tokens")});
    for key in [
        "transport",
        "billing_id",
        "cost_scope",
        "event_id",
        "attempt_id",
        "generation_id",
        "usage_complete",
        "kind",
        "base_url",
        "session_id",
        "parent_session_id",
        "stream",
        "usage_observed",
        "raw_usage",
        "cost_usd",
        "cache_creation_5m_tokens",
        "cache_creation_1h_tokens",
        "accounting_version",
        "token_breakdown",
    ] {
        if let Some(v) = value.get(key) {
            accounting[key] = v.clone();
        }
    }
    let mut quality = "legacy";
    if let Some(b) = value.get("token_breakdown") {
        if b["schema_version"].as_u64() == Some(2) {
            tokens.input_tokens = b["input"]["total_tokens"].as_u64().unwrap_or(0);
            tokens.output_tokens = b["output"]["total_tokens"].as_u64().unwrap_or(0);
            tokens.reasoning_tokens = b["output"]["reasoning_tokens"].as_u64().unwrap_or(0);
            tokens.cache_read_tokens = b["input"]["cache_read_tokens"].as_u64().unwrap_or(0);
            tokens.cache_creation_tokens = b["input"]["cache_write_tokens"].as_u64().unwrap_or(0);
            tokens.total_tokens = b["total_tokens"].as_u64().unwrap_or(0);
            quality = if b["quality"] == "complete"
                && b["unclassified_tokens"].as_u64() == Some(0)
                && b["input"]["uncached_tokens"]
                    .as_u64()
                    .and_then(|n| n.checked_add(tokens.cache_read_tokens))
                    .and_then(|n| n.checked_add(tokens.cache_creation_tokens))
                    == Some(tokens.input_tokens)
                && b["output"]["non_reasoning_tokens"]
                    .as_u64()
                    .and_then(|n| n.checked_add(tokens.reasoning_tokens))
                    == Some(tokens.output_tokens)
                && tokens.input_tokens.checked_add(tokens.output_tokens)
                    == Some(tokens.total_tokens)
            {
                "complete"
            } else {
                "inconsistent"
            };
        } else {
            quality = "unsupported";
        }
    } else {
        let identity = format!(
            "{} {}",
            value["provider"].as_str().unwrap_or(""),
            value["executor_type"].as_str().unwrap_or("")
        )
        .to_ascii_lowercase();
        if ["gemini", "antigravity", "vertex"]
            .iter()
            .any(|p| identity.contains(p))
        {
            tokens.output_tokens = tokens.output_tokens.saturating_add(tokens.reasoning_tokens);
            if value["tokens"]["total_tokens"].as_u64().unwrap_or(0) == 0 {
                tokens.total_tokens = tokens.input_tokens.saturating_add(tokens.output_tokens);
            }
        }
        if tokens.input_tokens.checked_add(tokens.output_tokens) != Some(tokens.total_tokens)
            || tokens
                .cache_read_tokens
                .checked_add(tokens.cache_creation_tokens)
                .is_none_or(|n| n > tokens.input_tokens)
            || tokens.reasoning_tokens > tokens.output_tokens
        {
            quality = "inconsistent";
        }
    }
    if value["usage_observed"] == false && tokens.total_tokens == 0 {
        quality = "unknown";
    }
    if !value.get("usage_observed").is_some() && tokens.total_tokens == 0 {
        quality = "unknown";
    }
    if value["tokens"].as_object().is_some_and(|o| {
        o.values().any(|v| {
            v.as_i64().is_some_and(|n| n < 0) || v.as_u64().is_some_and(|n| n > i64::MAX as u64)
        })
    }) {
        quality = "inconsistent";
    }
    if value["usage_complete"] == false {
        quality = "partial";
    }
    accounting["quality"] = json!(quality);
    accounting
}

pub(super) fn estimate(group: &UsageCostGroup, prices: &HashMap<String, ModelPrice>) -> Value {
    if let Some(snapshot) = group.accounting.get("valuation") {
        return snapshot.clone();
    }
    let unknown = |reason: &str| json!({"status":"unknown", "reason":reason, "cost":null});
    // xAI reports cost in exact USD ticks. This takes precedence over estimates,
    // including image/video charges that cannot be represented as text tokens.
    if group.provider.eq_ignore_ascii_case("xai") {
        if let Some(cost) = group.accounting["cost_usd"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v >= 0.0)
        {
            return json!({"status":"reported", "cost":cost, "currency":"USD", "source":"provider", "decimal":group.accounting["cost_usd"]});
        }
    }
    let quality = group.accounting["quality"].as_str().unwrap_or("legacy");
    if !matches!(quality, "complete" | "legacy") {
        return unknown("usage_incomplete");
    }
    if group.tokens.input.checked_add(group.tokens.output) != Some(group.total_tokens)
        || group.total_tokens == 0 && quality != "complete"
    {
        return unknown("usage_missing");
    }
    let Some(price) = price_for_group(group, prices) else {
        return unknown("tariff_missing");
    };
    let model = normalized_model_tail(&price.model);
    let mut tier: &str = if group.response_service_tier.trim().is_empty() {
        &group.service_tier
    } else {
        &group.response_service_tier
    };
    if model.starts_with("claude-") && price.source != "manual" {
        let raw = &group.accounting["raw_usage"];
        // Anthropic Priority is a negotiated commitment, not OpenAI Fast mode.
        if tier.eq_ignore_ascii_case("priority") || raw["service_tier"] == "priority" {
            return unknown("tariff_dimensions_missing");
        }
        if let Some(speed) = raw["speed"].as_str() {
            if !matches!(speed, "fast" | "standard") || speed == "fast" && tier == "batch" {
                return unknown("tariff_dimensions_missing");
            }
            if tier != "batch" {
                tier = speed;
            }
        }
    }
    let Some(cost) = tariff_cost(
        &model,
        tier,
        &group.tokens,
        &price,
        &group.accounting,
        &group.timestamp,
    ) else {
        return unknown("tariff_dimensions_missing");
    };
    json!({"status":"estimated", "cost":cost, "currency":"USD", "source":price.source, "model":price.model, "price":price, "rules_version":"2026-09-12", "tier":tier, "captured_at":Local::now().to_rfc3339()})
}

pub(super) fn tariff_cost(
    model: &str,
    tier: &str,
    t: &CostTokens,
    price: &ModelPrice,
    a: &Value,
    timestamp: &str,
) -> Option<f64> {
    let regional = if price.source == "manual" {
        1.0
    } else {
        regional_multiplier(model, tier, a)?
    };
    if price.source != "manual" && multimodal::supported(model) {
        let raw = &a["raw_usage"];
        if raw["unpriced_server_tools"] == true
            || raw.get("tool_usage").is_some()
            || raw.get("server_tool_use").is_some()
            || raw["web_search_calls"].as_u64().unwrap_or(0) > 0
            || raw["file_search_calls"].as_u64().unwrap_or(0) > 0
        {
            return None;
        }
        return multimodal::cost(model, &tier.trim().to_ascii_lowercase(), t, &a["raw_usage"])
            .map(|cost| cost * regional);
    }
    let price = enriched_model_price(model, price);
    if t.cache_read > 0 && !price.cache_read_configured && price.cache <= 0.0
        || t.cache_creation > 0 && !price.cache_creation_configured
    {
        return None;
    }
    let prompt = t
        .input
        .checked_sub(t.cache_read.checked_add(t.cache_creation)?)?;
    let mut input = price.prompt;
    let mut output = price.completion;
    let mut read = price.cache_read;
    let mut write = price.cache_creation;
    let tier = tier.trim().to_ascii_lowercase();
    let manual = price.source == "manual";
    if !manual {
        let long_openai = matches!(
            model,
            "gpt-6-astra"
                | "gpt-5.6"
                | "gpt-5.6-sol"
                | "gpt-5.6-terra"
                | "gpt-5.6-luna"
                | "gpt-5.5"
                | "gpt-5.5-pro"
                | "gpt-5.4"
                | "gpt-5.4-pro"
        ) && t.input > 272_000;
        let long_gemini = matches!(
            model,
            "gemini-2.5-pro" | "gemini-3-pro-preview" | "gemini-3.1-pro-preview" | "gemini-3.1-pro"
        ) && t.input > 200_000;
        let long_grok = matches!(
            model,
            "grok-4.6"
                | "grok-4.5"
                | "grok-4.3"
                | "grok-4.20"
                | "grok-4.20-multi-agent"
                | "grok-build-0.1"
        ) && t.input >= 200_000;
        if long_openai || long_gemini || long_grok {
            input *= 2.0;
            read *= 2.0;
            write *= 2.0;
            output *= if long_grok { 2.0 } else { 1.5 };
        }
        match tier.as_str() {
            "" | "default" | "auto" | "standard" => {}
            "priority" | "fast" => {
                // Unpublished mode/context combinations must not inherit standard rates.
                if long_openai
                    && matches!(model, "gpt-5.5" | "gpt-5.5-pro" | "gpt-5.4" | "gpt-5.4-pro")
                {
                    return None;
                }
                let mult = match model {
                    "gpt-6-astra" | "gpt-5.6" | "gpt-5.6-sol" | "gpt-5.6-terra"
                    | "gpt-5.6-luna" | "gpt-5.4" | "gpt-5.4-mini" | "gpt-5.3-codex" | "gpt-5.2"
                    | "gpt-5.2-codex" | "gpt-5.1" | "gpt-5" | "gpt-4.1-nano" => 2.0,
                    "gpt-5.5" => 2.5,
                    "gpt-5-mini" => 1.8,
                    "gpt-4.1" | "gpt-4.1-mini" | "gpt-4o-2024-05-13" | "o3" => 1.75,
                    "gpt-4o" => 1.7,
                    "gpt-4o-mini" => 5.0 / 3.0,
                    "o4-mini" => 20.0 / 11.0,
                    "claude-opus-5" | "claude-opus-4-8" => 2.0,
                    _ => return None,
                };
                input *= mult;
                output *= mult;
                read *= mult;
                write *= mult;
            }
            "batch" | "flex" => {
                if model.starts_with("gemini-") {
                    input *= 0.5;
                    output *= 0.5; /* cached input stays at standard rates */
                } else if model.starts_with("claude-") && tier == "batch" {
                    input *= 0.5;
                    output *= 0.5;
                    read *= 0.5;
                    write *= 0.5;
                } else if matches!(
                    model,
                    "gpt-6-astra"
                        | "gpt-5.6"
                        | "gpt-5.6-sol"
                        | "gpt-5.6-terra"
                        | "gpt-5.6-luna"
                        | "gpt-5.5"
                        | "gpt-5.4"
                        | "gpt-5.4-mini"
                        | "gpt-5.4-nano"
                        | "gpt-5.2"
                        | "gpt-5.1"
                        | "gpt-5"
                        | "gpt-5-mini"
                        | "gpt-5-nano"
                        | "o3"
                        | "o4-mini"
                ) {
                    input *= 0.5;
                    output *= 0.5;
                    read *= 0.5;
                    write *= 0.5;
                } else {
                    return None;
                }
            }
            _ => return None,
        }
        if model.starts_with("deepseek-") {
            let dt = DateTime::parse_from_rfc3339(timestamp)
                .ok()?
                .with_timezone(&chrono::Utc);
            // Current rates cannot be applied retrospectively to pre-audit events.
            if dt.format("%Y-%m-%d").to_string().as_str() < "2026-09-12" {
                return None;
            }
            let peak = dt.weekday().number_from_monday() <= 5
                && ((1..4).contains(&dt.hour()) || (6..10).contains(&dt.hour()));
            if !peak {
                input *= 0.5;
                output *= 0.5;
                read *= 0.5;
            }
        }
    }
    let mut cache_cost = t.cache_creation as f64 * write;
    if model.starts_with("claude-") && t.cache_creation > 0 && !manual {
        let hour = a["cache_creation_1h_tokens"].as_u64().unwrap_or(0);
        let five = a["cache_creation_5m_tokens"].as_u64().unwrap_or(0);
        if hour.checked_add(five)? != t.cache_creation {
            return None;
        }
        cache_cost = five as f64 * write + hour as f64 * input * 2.0;
    }
    // Non-text modalities and server tools have independent prices. Preserve raw
    // dimensions, but do not label a text-only estimate as complete coverage.
    let raw = &a["raw_usage"];
    let mut tool_cost = 0.0;
    if raw["unpriced_server_tools"] == true {
        return None;
    }
    if let Some(tools) = raw["tool_usage"].as_object() {
        if tools.keys().any(|key| key != "image_gen") {
            return None;
        }
    }
    if let Some(tools) = raw["server_tool_use"].as_object() {
        for (key, value) in tools {
            let count = value.as_u64()?;
            match key.as_str() {
                "web_search_requests" => tool_cost += count as f64 * 0.01,
                "web_fetch_requests" => {}
                _ if count > 0 => return None,
                _ => {}
            }
        }
    }
    let web_calls = raw["web_search_calls"].as_u64().unwrap_or(0);
    if web_calls > 0 {
        return None;
    } // The response does not distinguish standard and legacy preview billing.
    tool_cost +=
        web_calls as f64 * 0.01 + raw["file_search_calls"].as_u64().unwrap_or(0) as f64 * 0.0025;
    for path in [
        "/input_token_details/audio_tokens",
        "/output_token_details/audio_tokens",
        "/prompt_tokens_details/audio_tokens",
        "/completion_tokens_details/audio_tokens",
    ] {
        if raw.pointer(path).and_then(Value::as_u64).unwrap_or(0) > 0 && !manual {
            return None;
        }
    }
    let audio_count = |key: &str| {
        raw[key]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| {
                        p["modality"]
                            .as_str()
                            .is_some_and(|m| m.eq_ignore_ascii_case("AUDIO"))
                    })
                    .map(|p| p["tokenCount"].as_u64().unwrap_or(0))
                    .sum::<u64>()
            })
            .unwrap_or(0)
    };
    let audio_input = audio_count("promptTokensDetails");
    let audio_output =
        audio_count("candidatesTokensDetails").max(audio_count("responseTokensDetails"));
    let mut audio_adjustment = 0.0;
    if !manual && (audio_input > 0 || audio_output > 0) {
        if model != "gemini-2.5-flash" || audio_output > 0 {
            return None;
        }
        if t.cache_read > 0 && !raw["cacheTokensDetails"].is_array() {
            return None;
        }
        let audio_cached = audio_count("cacheTokensDetails");
        let audio_uncached = audio_input.checked_sub(audio_cached)?;
        if audio_uncached > prompt || audio_cached > t.cache_read {
            return None;
        }
        audio_adjustment = audio_uncached as f64 * input * (1.0 / 0.3 - 1.0)
            + audio_cached as f64 * read * (1.0 / 0.3 - 1.0);
    }
    let mut cost = (prompt as f64 * input
        + t.output as f64 * output
        + t.cache_read as f64 * read
        + cache_cost
        + audio_adjustment)
        / TOKENS_PER_PRICE_UNIT;
    if !manual
        && model.starts_with("claude-")
        && raw["inference_geo"]
            .as_str()
            .is_some_and(|geo| geo.eq_ignore_ascii_case("us"))
    {
        cost *= 1.1;
    }
    cost *= regional;
    cost += tool_cost;
    cost.is_finite().then_some(cost)
}

// Only processing regions incur this premium; storage-only regions do not.
// Sources: OpenAI pricing and Your data model/endpoint support (2026-09-12).
fn regional_multiplier(model: &str, tier: &str, a: &Value) -> Option<f64> {
    let host = reqwest::Url::parse(a["base_url"].as_str().unwrap_or(""))
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    if !matches!(
        host.as_str(),
        "us.api.openai.com" | "eu.api.openai.com" | "ae.api.openai.com"
    ) {
        return Some(1.0);
    }
    if host == "eu.api.openai.com" && model == "gpt-6-astra" && matches!(tier, "fast" | "priority")
    {
        return None;
    }
    let recent = matches!(
        model,
        "gpt-6-astra"
            | "gpt-5.6"
            | "gpt-5.6-sol"
            | "gpt-5.6-terra"
            | "gpt-5.6-luna"
            | "gpt-5.5"
            | "gpt-5.5-pro"
            | "gpt-5.4"
            | "gpt-5.4-pro"
            | "gpt-5.4-mini"
            | "gpt-5.4-nano"
    );
    if recent {
        if host == "ae.api.openai.com"
            && !matches!(model, "gpt-5.6-luna" | "gpt-5.5" | "gpt-5.5-pro")
        {
            return None;
        }
        return Some(1.1);
    }
    if matches!(
        model,
        "gpt-5.3-codex"
            | "gpt-5.2"
            | "gpt-5.2-codex"
            | "gpt-5.2-pro"
            | "gpt-5.1"
            | "gpt-5"
            | "gpt-5-mini"
            | "gpt-5-nano"
            | "gpt-4.1"
            | "gpt-4.1-mini"
            | "gpt-4.1-nano"
            | "gpt-4o"
            | "gpt-4o-mini"
            | "o3"
            | "o4-mini"
    ) {
        return Some(1.0);
    }
    None
}

pub(super) fn snapshot(record: &UsageRecord, prices: &HashMap<String, ModelPrice>) -> Value {
    let group = UsageCostGroup {
        model: record.model.clone(),
        alias: record.alias.clone(),
        provider: record.provider.clone(),
        executor_type: record.executor_type.clone(),
        auth_type: record.auth_type.clone(),
        service_tier: record.service_tier.clone(),
        response_service_tier: record.response_service_tier.clone(),
        requests: 1,
        total_tokens: record.tokens.total_tokens,
        timestamp: record.timestamp.clone(),
        accounting: record.accounting.clone(),
        tokens: CostTokens {
            input: record.tokens.input_tokens,
            output: record.tokens.output_tokens,
            cache_read: record.tokens.cache_read_tokens,
            cache_creation: record.tokens.cache_creation_tokens,
            ..CostTokens::default()
        },
    };
    estimate(&group, prices)
}

// Sanitize before the raw inbox write, including legacy and direct probe events.
pub(super) fn redact_credentials(message: String) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(&message) else {
        return message;
    };
    let Some(fields) = value.as_object_mut() else {
        return message;
    };
    let key = fields
        .remove("api_key")
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    if !key.is_empty() {
        fields.insert("api_key_hash".into(), json!(hash_text(&key)));
        fields.insert("api_key_display".into(), json!(mask_api_key(&key)));
    }
    let auth = fields
        .get("auth_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    let source = fields.get("source").and_then(Value::as_str).unwrap_or("");
    if !source.is_empty()
        && !source.starts_with("sha256:")
        && (source == key || matches!(auth, "api_key" | "apikey"))
    {
        fields.insert(
            "source".into(),
            json!(format!("sha256:{}", hash_text(source))),
        );
    }
    fields.remove("response_headers");
    serde_json::to_string(&value).unwrap_or(message)
}
