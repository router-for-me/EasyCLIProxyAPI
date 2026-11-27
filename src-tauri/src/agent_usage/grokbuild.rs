use serde_json::Value;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    collect_files_under, env_path, local_from_epoch_ms, record_sample, sample_time,
    sanitize_model_name, FileDelta, UsageCounter, MAX_JSON_LINE_BYTES,
};

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let base = env_path("GROK_HOME").unwrap_or_else(|| home.join(".grok"));
    let mut files = Vec::new();
    for subdir in ["sessions", "archived_sessions"] {
        let root = base.join(subdir);
        collect_files_under(&root, &mut files, &|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("updates.jsonl"))
        });
    }
    files
}

fn parse_event_time(record: &Value, path: &Path) -> Option<chrono::DateTime<chrono::Local>> {
    if let Some(ts) = record.get("timestamp") {
        if let Some(n) = ts.as_i64() {
            let ms = if n > 100_000_000_000 { n } else { n.saturating_mul(1000) };
            return local_from_epoch_ms(ms);
        }
        if let Some(s) = ts.as_str() {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                return Some(dt.with_timezone(&chrono::Local));
            }
        }
    }
    sample_time(record, path)
}

fn parse_counters(value: &Value, event_partial: bool) -> Option<UsageCounter> {
    let get = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    let raw_input = get("inputTokens");
    let output = get("outputTokens");
    let cached = get("cachedReadTokens").min(raw_input);
    let reasoning = get("reasoningTokens");
    let fresh_input = raw_input.saturating_sub(cached);
    // `outputTokens` already includes `reasoningTokens`.
    let total = fresh_input.saturating_add(output).saturating_add(cached);
    if total == 0 {
        return None;
    }

    let cost_ticks = get("costUsdTicks");
    let is_partial = event_partial
        || value
            .get("costIsPartial")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    // Only treat `costUsdTicks` as authoritative reported cost when non-zero and not partial.
    let reported_cost = if cost_ticks > 0 && !is_partial {
        Some(cost_ticks as f64 / 10_000_000_000.0)
    } else {
        None
    };

    Some(UsageCounter {
        input_tokens: fresh_input,
        output_tokens: output,
        cache_creation_tokens: 0,
        cache_creation_1h_tokens: 0,
        cache_read_tokens: cached,
        reasoning_tokens: reasoning,
        total_tokens: total,
        cost_usd: reported_cost.unwrap_or(0.0),
        reported_cost_usd: reported_cost.unwrap_or(0.0),
        reported_samples: u64::from(reported_cost.is_some()),
        samples: 1,
    })
}

pub(super) fn read_file(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    let file = File::open(path).map_err(|_| ())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let session_id = path
        .parent()
        .and_then(|dir| dir.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut seen_turns: HashSet<String> = HashSet::new();

    loop {
        buffer.clear();
        let bytes = reader.read_until(b'\n', &mut buffer).map_err(|_| ())?;
        if bytes == 0 {
            break;
        }
        if buffer.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        if record.get("method").and_then(Value::as_str) != Some("_x.ai/session/update") {
            continue;
        }
        let Some(update) = record.pointer("/params/update") else {
            continue;
        };
        let kind = update.get("sessionUpdate").and_then(Value::as_str);
        if kind.is_some() && kind != Some("turn_completed") {
            continue;
        }
        let Some(usage) = update.get("usage").filter(|u| u.is_object()) else {
            continue;
        };
        let Some(time) = parse_event_time(&record, path) else {
            continue;
        };
        let prompt_id = update
            .get("prompt_id")
            .or_else(|| update.get("promptId"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let event_partial = usage
            .get("costIsPartial")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if let Some(model_map) = usage.get("modelUsage").and_then(Value::as_object) {
            let mut entries: Vec<(&String, &Value)> = model_map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.cmp(b));
            for (model_raw, counters) in entries {
                if !prompt_id.is_empty() {
                    let key = format!("{session_id}:{prompt_id}:{model_raw}");
                    if !seen_turns.insert(key) {
                        continue;
                    }
                }
                let Some(counter) = parse_counters(counters, event_partial) else {
                    continue;
                };
                let model = Some(sanitize_model_name(model_raw)).filter(|m| !m.is_empty());
                record_sample(delta, time, model, counter);
            }
        } else {
            if !prompt_id.is_empty() {
                let key = format!("{session_id}:{prompt_id}:__top__");
                if !seen_turns.insert(key) {
                    continue;
                }
            }
            if let Some(counter) = parse_counters(usage, event_partial) {
                record_sample(delta, time, None, counter);
            }
        }
    }

    Ok(())
}
