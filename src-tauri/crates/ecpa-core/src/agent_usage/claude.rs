use chrono::{DateTime, Local};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    collect_files_under, env_path, first_counter, record_sample, sample_time, sanitize_model_name,
    string_field, FileDelta, SourceSyncContext, UsageCounter, MAX_JSON_LINE_BYTES,
};

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let mut roots: BTreeSet<PathBuf> = BTreeSet::new();
    if let Some(custom) = env_path("CLAUDE_CONFIG_DIR") {
        roots.insert(custom.join("projects"));
    }
    roots.insert(home.join(".claude").join("projects"));
    roots.insert(home.join(".config").join("claude").join("projects"));

    let mut files = Vec::new();
    for root in roots {
        collect_files_under(&root, &mut files, &|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
        });
    }
    files
}

struct ClaudeCandidate {
    has_stop_reason: bool,
    output_tokens: u64,
    line_index: usize,
    model: Option<String>,
    counter: UsageCounter,
    time: DateTime<Local>,
    message_id: Option<String>,
}

pub(super) fn extract_message_usage(value: &Value) -> Option<(UsageCounter, Option<String>, Option<String>, bool)> {
    let object = value.as_object()?;
    if let Some(kind) = object.get("type").and_then(Value::as_str) {
        if kind != "assistant" {
            return None;
        }
    }
    let (usage, model, message_id, has_stop_reason) =
        if let Some(message) = object.get("message").and_then(Value::as_object) {
            let usage = message.get("usage").and_then(Value::as_object)?;
            let model = string_field(message, &["model", "modelName"]);
            let message_id = string_field(message, &["id"]);
            let has_stop_reason = message
                .get("stop_reason")
                .is_some_and(|v| !v.is_null() && v.as_str().is_none_or(|s| !s.trim().is_empty()));
            (usage, model, message_id, has_stop_reason)
        } else {
            // Standalone legacy object without `type`/`message` wrapper.
            if object.contains_key("type") {
                return None;
            }
            let usage = object.get("usage").and_then(Value::as_object)?;
            let model = string_field(object, &["model", "modelName"]);
            let message_id = string_field(object, &["id"]);
            let has_stop_reason = object
                .get("stop_reason")
                .is_some_and(|v| !v.is_null());
            (usage, model, message_id, has_stop_reason)
        };

    let input_tokens = first_counter(usage, &["input_tokens", "inputTokens"]).unwrap_or(0);
    let output_tokens = first_counter(usage, &["output_tokens", "outputTokens"]).unwrap_or(0);
    let cache_read_tokens = first_counter(
        usage,
        &["cache_read_input_tokens", "cacheReadInputTokens", "cache_read_tokens"],
    )
    .unwrap_or(0);
    let cache_creation_tokens = first_counter(
        usage,
        &[
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
            "cache_creation_tokens",
        ],
    )
    .unwrap_or(0);
    let cache_creation_1h_tokens = usage
        .get("cache_creation")
        .and_then(Value::as_object)
        .and_then(|cc| first_counter(cc, &["ephemeral_1h_input_tokens"]))
        .unwrap_or(0)
        .min(cache_creation_tokens);

    let total_tokens = input_tokens
        .saturating_add(output_tokens)
        .saturating_add(cache_read_tokens)
        .saturating_add(cache_creation_tokens);
    if total_tokens == 0 {
        return None;
    }

    let model = model.map(|m| sanitize_model_name(&m)).filter(|m| !m.is_empty());
    let counter = UsageCounter {
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_creation_1h_tokens,
        cache_read_tokens,
        reasoning_tokens: 0,
        total_tokens,
        cost_usd: 0.0,
        reported_cost_usd: 0.0,
        reported_samples: 0,
        samples: 1,
    };
    Some((counter, model, message_id, has_stop_reason))
}

pub(super) fn read_file(
    path: &Path,
    ctx: &mut SourceSyncContext,
    delta: &mut FileDelta,
) -> Result<(), ()> {
    let file = File::open(path).map_err(|_| ())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut line_index = 0usize;
    let mut keyed: HashMap<String, ClaudeCandidate> = HashMap::new();
    let mut unkeyed: Vec<ClaudeCandidate> = Vec::new();

    loop {
        buffer.clear();
        let bytes = reader.read_until(b'\n', &mut buffer).map_err(|_| ())?;
        if bytes == 0 {
            break;
        }
        line_index += 1;
        if buffer.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        let Some((counter, model, message_id, has_stop_reason)) = extract_message_usage(&value) else {
            continue;
        };
        let Some(time) = sample_time(&value, path) else {
            continue;
        };
        let candidate = ClaudeCandidate {
            has_stop_reason,
            output_tokens: counter.output_tokens,
            line_index,
            model,
            counter,
            time,
            message_id: message_id.clone(),
        };
        if let Some(id) = message_id {
            match keyed.get(&id) {
                Some(existing)
                    if (existing.has_stop_reason, existing.output_tokens, existing.line_index)
                        >= (
                            candidate.has_stop_reason,
                            candidate.output_tokens,
                            candidate.line_index,
                        ) => {}
                _ => {
                    keyed.insert(id, candidate);
                }
            }
        } else {
            unkeyed.push(candidate);
        }
    }

    let mut entries: Vec<ClaudeCandidate> = keyed.into_values().chain(unkeyed).collect();
    entries.sort_by_key(|entry| entry.line_index);
    for entry in entries {
        if let Some(id) = entry.message_id {
            let dedup_id = format!("claude:{id}");
            if ctx.seen_ids.contains(&dedup_id) {
                continue;
            }
            ctx.seen_ids.insert(dedup_id.clone());
            delta.claimed_ids.push(dedup_id);
        }
        record_sample(delta, entry.time, entry.model, entry.counter);
    }
    Ok(())
}
