use serde_json::Value;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    collect_files_under, env_path, first_counter, record_sample, sample_time, sanitize_model_name,
    string_field, FileDelta, UsageCounter, MAX_JSON_LINE_BYTES,
};

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let mut roots: std::collections::BTreeSet<PathBuf> = std::collections::BTreeSet::new();
    let base = env_path("COPILOT_HOME").unwrap_or_else(|| home.join(".copilot"));
    roots.insert(base.join("session-state"));
    if let Some(app_data) = env_path("APPDATA") {
        roots.insert(app_data.join("GitHub Copilot").join("session-state"));
    }
    let mut files = Vec::new();
    for state_root in roots {
        collect_files_under(&state_root, &mut files, &|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("events.jsonl"))
        });
    }
    files
}

pub(super) fn read_file(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    // Non-JSONL files (such as JSONC config files passed directly in tests) are ignored safely.
    if !path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
    {
        return Ok(());
    }

    let file = File::open(path).map_err(|_| ())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut seen_sequences: HashSet<u64> = HashSet::new();

    loop {
        buffer.clear();
        let bytes = reader.read_until(b'\n', &mut buffer).map_err(|_| ())?;
        if bytes == 0 {
            break;
        }
        if buffer.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        let Ok(event) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        let Some(object) = event.as_object() else {
            continue;
        };

        match object.get("type").and_then(Value::as_str) {
            Some("session.usage_record") => {
                let Some(usage) = event.pointer("/data/usage").and_then(Value::as_object) else {
                    continue;
                };
                if let Some(id) = object
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    if !seen_ids.insert(id.to_string()) {
                        continue;
                    }
                } else if let Some(seq) = event
                    .pointer("/data/usage/accounting/sequence")
                    .and_then(Value::as_u64)
                {
                    if !seen_sequences.insert(seq) {
                        continue;
                    }
                }

                let detail = |kind: &str| -> Option<u64> {
                    let details = usage
                        .get("copilotUsage")
                        .and_then(|c| c.get("tokenDetails"))
                        .and_then(Value::as_array)?;
                    let mut sum = 0u64;
                    let mut found = false;
                    for item in details {
                        if item.get("tokenType").and_then(Value::as_str) == Some(kind) {
                            if let Some(count) = item.get("tokenCount").and_then(Value::as_u64) {
                                sum = sum.saturating_add(count);
                                found = true;
                            }
                        }
                    }
                    found.then_some(sum)
                };

                let raw_input =
                    first_counter(usage, &["inputTokens", "input_tokens"]).unwrap_or(0);
                let cache_read = detail("cache_read").unwrap_or_else(|| {
                    first_counter(usage, &["cacheReadTokens", "cache_read_tokens"]).unwrap_or(0)
                });
                let cache_write = detail("cache_write").unwrap_or_else(|| {
                    first_counter(
                        usage,
                        &[
                            "cacheWriteTokens",
                            "cache_write_tokens",
                            "cacheCreationTokens",
                            "cache_creation_tokens",
                        ],
                    )
                    .unwrap_or(0)
                });
                let fresh_input = detail("input").unwrap_or_else(|| {
                    let cr = cache_read.min(raw_input);
                    let cw = cache_write.min(raw_input.saturating_sub(cr));
                    raw_input.saturating_sub(cr).saturating_sub(cw)
                });
                let output = detail("output").unwrap_or_else(|| {
                    first_counter(usage, &["outputTokens", "output_tokens"]).unwrap_or(0)
                });

                let total = fresh_input
                    .saturating_add(output)
                    .saturating_add(cache_read)
                    .saturating_add(cache_write);
                if total == 0 {
                    continue;
                }
                let Some(time) = sample_time(&event, path) else {
                    continue;
                };
                let model = string_field(usage, &["model", "modelName"])
                    .or_else(|| {
                        event
                            .get("data")
                            .and_then(Value::as_object)
                            .and_then(|d| string_field(d, &["model", "modelName"]))
                    })
                    .map(|m| sanitize_model_name(&m))
                    .filter(|m| !m.is_empty());

                let counter = UsageCounter {
                    input_tokens: fresh_input,
                    output_tokens: output,
                    cache_creation_tokens: cache_write,
                    cache_creation_1h_tokens: 0,
                    cache_read_tokens: cache_read,
                    reasoning_tokens: 0,
                    total_tokens: total,
                    cost_usd: 0.0,
                    reported_cost_usd: 0.0,
                    reported_samples: 0,
                    samples: 1,
                };
                record_sample(delta, time, model, counter);
            }
            None => {
                // Legacy flat event without Copilot CLI event envelope.
                let Some(usage) = object.get("usage").and_then(Value::as_object) else {
                    continue;
                };
                let input =
                    first_counter(usage, &["input_tokens", "inputTokens", "input"]).unwrap_or(0);
                let output =
                    first_counter(usage, &["output_tokens", "outputTokens", "output"]).unwrap_or(0);
                let cache_read =
                    first_counter(usage, &["cache_read_tokens", "cacheReadTokens"]).unwrap_or(0);
                let cache_write = first_counter(
                    usage,
                    &[
                        "cache_write_tokens",
                        "cache_creation_tokens",
                        "cacheWriteTokens",
                    ],
                )
                .unwrap_or(0);
                let total = input
                    .saturating_add(output)
                    .saturating_add(cache_read)
                    .saturating_add(cache_write);
                if total == 0 {
                    continue;
                }
                let Some(time) = sample_time(&event, path) else {
                    continue;
                };
                let model = string_field(object, &["model", "modelName"])
                    .or_else(|| string_field(usage, &["model", "modelName"]))
                    .map(|m| sanitize_model_name(&m))
                    .filter(|m| !m.is_empty());
                let counter = UsageCounter {
                    input_tokens: input,
                    output_tokens: output,
                    cache_creation_tokens: cache_write,
                    cache_creation_1h_tokens: 0,
                    cache_read_tokens: cache_read,
                    reasoning_tokens: 0,
                    total_tokens: total,
                    cost_usd: 0.0,
                    reported_cost_usd: 0.0,
                    reported_samples: 0,
                    samples: 1,
                };
                record_sample(delta, time, model, counter);
            }
            Some(_) => {
                // Ignore all non-usage Copilot CLI event types (e.g. assistant.message, tool.execution_complete).
            }
        }
    }

    Ok(())
}
