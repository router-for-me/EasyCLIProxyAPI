use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    env_path, local_from_epoch_ms, record_sample, sample_time, sanitize_model_name, FileDelta,
    UsageCounter, MAX_JSON_LINE_BYTES,
};

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let mut roots: BTreeSet<PathBuf> = BTreeSet::new();
    if let Some(custom) = env_path("WORKBUDDY_CONFIG_DIR") {
        roots.insert(custom.join("projects"));
    }
    roots.insert(home.join(".workbuddy-ai").join("projects"));
    roots.insert(home.join(".workbuddy").join("projects"));

    let mut files = Vec::new();
    for projects in roots {
        collect_buddy_project_files(&projects, &mut files);
    }
    files
}

/// Shared layout for WorkBuddy and CodeBuddy:
/// `projects/<cwd>/<session>.jsonl` and `projects/<cwd>/<session>/subagents/*.jsonl`.
pub(super) fn collect_buddy_project_files(projects: &Path, files: &mut Vec<PathBuf>) {
    let Ok(project_entries) = fs::read_dir(projects) else {
        return;
    };
    for project in project_entries.flatten() {
        let project_path = project.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&project_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
            {
                files.push(path);
            } else if path.is_dir() {
                let subagents = path.join("subagents");
                if let Ok(sub_entries) = fs::read_dir(&subagents) {
                    for sub in sub_entries.flatten() {
                        let sp = sub.path();
                        if sp.is_file()
                            && sp
                                .extension()
                                .and_then(|e| e.to_str())
                                .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
                        {
                            files.push(sp);
                        }
                    }
                }
            }
        }
    }
}

pub(super) fn strip_custom_prefix(model: &str) -> &str {
    match model.split_once(':') {
        Some((prefix, id)) if prefix.starts_with("custom-") && !id.trim().is_empty() => id.trim(),
        _ => model,
    }
}

fn ptr_u64(value: &Value, pointer: &str) -> u64 {
    value.pointer(pointer).and_then(Value::as_u64).unwrap_or(0)
}

/// Extracts fresh-input normalized counters from `providerData.rawUsage`
/// (with optional fallback to normalized `providerData.usage`).
/// Note: `rawUsage.credit` is platform credit rather than USD and is ignored.
pub(super) fn extract_buddy_tokens(provider_data: &Value) -> Option<UsageCounter> {
    if let Some(raw) = provider_data.get("rawUsage").filter(|v| v.is_object()) {
        let prompt = ptr_u64(raw, "/prompt_tokens").max(ptr_u64(raw, "/input_tokens"));
        let cache_read = [
            "/prompt_cache_hit_tokens",
            "/cache_read_input_tokens",
            "/cached_tokens",
            "/prompt_tokens_details/cached_tokens",
        ]
        .iter()
        .map(|p| ptr_u64(raw, p))
        .max()
        .unwrap_or(0);
        let cache_write = ptr_u64(raw, "/prompt_cache_write_tokens")
            .max(ptr_u64(raw, "/cache_creation_input_tokens"));
        let output = ptr_u64(raw, "/completion_tokens").max(ptr_u64(raw, "/output_tokens"));
        let reasoning = ptr_u64(raw, "/completion_thinking_tokens")
            .max(ptr_u64(raw, "/completion_tokens_details/reasoning_tokens"));

        let cr = cache_read.min(prompt);
        let cw = cache_write.min(prompt.saturating_sub(cr));
        let fresh_input = prompt.saturating_sub(cr).saturating_sub(cw);
        let total = fresh_input
            .saturating_add(output)
            .saturating_add(cr)
            .saturating_add(cw);
        if total == 0 {
            return None;
        }
        return Some(UsageCounter {
            input_tokens: fresh_input,
            output_tokens: output,
            cache_creation_tokens: cw,
            cache_creation_1h_tokens: 0,
            cache_read_tokens: cr,
            reasoning_tokens: reasoning,
            total_tokens: total,
            cost_usd: 0.0,
            reported_cost_usd: 0.0,
            reported_samples: 0,
            samples: 1,
        });
    }

    let usage = provider_data.get("usage").filter(|v| v.is_object())?;
    let prompt = ptr_u64(usage, "/inputTokens");
    let cache_read: u64 = usage
        .get("inputTokensDetails")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|d| ptr_u64(d, "/cached_tokens"))
        .sum();
    let reasoning: u64 = usage
        .get("outputTokensDetails")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|d| ptr_u64(d, "/reasoning_tokens"))
        .sum();
    let output = ptr_u64(usage, "/outputTokens");
    let cr = cache_read.min(prompt);
    let fresh_input = prompt.saturating_sub(cr);
    let total = fresh_input.saturating_add(output).saturating_add(cr);
    if total == 0 {
        return None;
    }
    Some(UsageCounter {
        input_tokens: fresh_input,
        output_tokens: output,
        cache_creation_tokens: 0,
        cache_creation_1h_tokens: 0,
        cache_read_tokens: cr,
        reasoning_tokens: reasoning,
        total_tokens: total,
        cost_usd: 0.0,
        reported_cost_usd: 0.0,
        reported_samples: 0,
        samples: 1,
    })
}

pub(super) fn extract_buddy_model(provider_data: &Value) -> Option<String> {
    ["requestModelId", "model"]
        .iter()
        .find_map(|key| provider_data.get(*key).and_then(Value::as_str))
        .map(|raw| sanitize_model_name(strip_custom_prefix(raw.trim())))
        .filter(|m| !m.is_empty())
}

pub(super) fn read_file(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    let file = File::open(path).map_err(|_| ())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();

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
        if record.get("role").and_then(Value::as_str) == Some("user")
            || record.get("type").and_then(Value::as_str) == Some("user")
        {
            continue;
        }
        let Some(provider_data) = record.get("providerData") else {
            continue;
        };
        if !provider_data.get("rawUsage").is_some_and(Value::is_object) {
            continue;
        }
        let Some(counter) = extract_buddy_tokens(provider_data) else {
            continue;
        };
        if let Some(id) = record
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            if !seen_ids.insert(id.to_string()) {
                continue;
            }
        }
        let time = record
            .get("timestamp")
            .and_then(Value::as_i64)
            .and_then(local_from_epoch_ms)
            .or_else(|| sample_time(&record, path));
        let Some(time) = time else {
            continue;
        };
        let model = extract_buddy_model(provider_data);
        record_sample(delta, time, model, counter);
    }
    Ok(())
}
