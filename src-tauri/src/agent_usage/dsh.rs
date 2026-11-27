use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::io::BufRead;
use std::path::{Path, PathBuf};

use super::zstd_frames::{is_zstd_path, open_jsonl_reader};
use super::{
    collect_files_under, env_path, first_counter, local_from_epoch_ms, record_sample, sample_time,
    sanitize_model_name, FileDelta, SourceSyncContext, UsageCounter, MAX_JSON_LINE_BYTES,
};

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let base = env_path("DSH_HOME").unwrap_or_else(|| home.join(".dsh"));
    let sessions_root = base.join("sessions");
    let mut raw = Vec::new();
    collect_files_under(&sessions_root, &mut raw, &|path| {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return false;
        };
        name.starts_with("session.") && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zstd"))
    });

    // Prefer uncompressed `.jsonl` if both `.jsonl` and `.jsonl.zstd` exist side by side.
    let mut best: BTreeMap<PathBuf, (bool, PathBuf)> = BTreeMap::new();
    for path in raw {
        let key = if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            let stripped = name.strip_suffix(".zstd").unwrap_or(name);
            path.with_file_name(stripped)
        } else {
            path.clone()
        };
        let uncompressed = !is_zstd_path(&path);
        match best.get(&key) {
            Some((prev_uncompressed, _)) if *prev_uncompressed >= uncompressed => {}
            _ => {
                best.insert(key, (uncompressed, path));
            }
        }
    }
    best.into_values().map(|(_, path)| path).collect()
}

fn strip_route_prefix(raw: &str) -> &str {
    match raw.trim().split_once(':') {
        Some((_, model)) if !model.trim().is_empty() => model.trim(),
        _ => raw.trim(),
    }
}

pub(super) fn read_file(
    path: &Path,
    ctx: &mut SourceSyncContext,
    delta: &mut FileDelta,
) -> Result<(), ()> {
    let mut reader = open_jsonl_reader(path)?;
    let mut buffer = Vec::new();
    let mut file_seen: HashSet<String> = HashSet::new();

    loop {
        buffer.clear();
        let bytes = reader.read_until(b'\n', &mut buffer).map_err(|_| ())?;
        if bytes == 0 {
            break;
        }
        if buffer.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant/message") {
            continue;
        }
        let Some(data) = value.get("data").and_then(Value::as_object) else {
            continue;
        };
        let Some(usage) = data.get("usage").and_then(Value::as_object) else {
            continue;
        };

        // DSH tokens are already fresh-input normalized (`total = input + output + cacheRead + cacheWrite`).
        let input = first_counter(usage, &["inputTokens", "input_tokens"]).unwrap_or(0);
        let output = first_counter(usage, &["outputTokens", "output_tokens"]).unwrap_or(0);
        let cache_read = first_counter(usage, &["cacheReadTokens", "cache_read_tokens"]).unwrap_or(0);
        let cache_write =
            first_counter(usage, &["cacheWriteTokens", "cache_write_tokens"]).unwrap_or(0);
        let reasoning =
            first_counter(usage, &["reasoningTokens", "reasoning_tokens"]).unwrap_or(0);
        let total = input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_write);
        if total == 0 {
            continue;
        }

        // Cross-file deduplication by `data.message.id` so forked sessions do not double-count history.
        if let Some(msg_id) = data
            .get("message")
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            let dedup_id = format!("dsh:{msg_id}");
            if !file_seen.insert(dedup_id.clone()) || ctx.seen_ids.contains(&dedup_id) {
                continue;
            }
            ctx.seen_ids.insert(dedup_id.clone());
            delta.claimed_ids.push(dedup_id);
        }

        let time = value
            .get("time")
            .and_then(Value::as_i64)
            .and_then(local_from_epoch_ms)
            .or_else(|| sample_time(&value, path));
        let Some(time) = time else {
            continue;
        };

        let model = data
            .get("message")
            .and_then(|m| {
                m.pointer("/source/model")
                    .or_else(|| m.get("model"))
                    .and_then(Value::as_str)
            })
            .or_else(|| data.get("model").and_then(Value::as_str))
            .map(|raw| sanitize_model_name(strip_route_prefix(raw)))
            .filter(|m| !m.is_empty());

        let counter = UsageCounter {
            input_tokens: input,
            output_tokens: output,
            cache_creation_tokens: cache_write,
            cache_creation_1h_tokens: 0,
            cache_read_tokens: cache_read,
            reasoning_tokens: reasoning,
            total_tokens: total,
            cost_usd: 0.0,
            reported_cost_usd: 0.0,
            reported_samples: 0,
            samples: 1,
        };
        record_sample(delta, time, model, counter);
    }

    Ok(())
}
