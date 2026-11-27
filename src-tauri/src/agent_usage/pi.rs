use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    collect_files_under, env_path, first_cost, first_counter, record_sample, sample_time,
    sanitize_model_name, string_field, FileDelta, SourceSyncContext, UsageCounter,
    MAX_JSON_LINE_BYTES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeaderKind {
    PiSession,
    OmpTitle,
    Unknown,
}

fn sniff_header_kind(path: &Path) -> HeaderKind {
    let Ok(file) = File::open(path) else {
        return HeaderKind::Unknown;
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    for _ in 0..4 {
        line.clear();
        let Ok(bytes) = reader.read_line(&mut line) else {
            break;
        };
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            return match value.get("type").and_then(Value::as_str) {
                Some("title") => HeaderKind::OmpTitle,
                Some("session") => HeaderKind::PiSession,
                _ => HeaderKind::Unknown,
            };
        }
        break;
    }
    HeaderKind::Unknown
}

fn shared_session_dir() -> Option<PathBuf> {
    env_path("PI_CODING_AGENT_SESSION_DIR")
}

pub(super) fn discover_pi_files(home: &Path) -> Vec<PathBuf> {
    let mut dedicated_roots: BTreeSet<PathBuf> = BTreeSet::new();
    if let Some(agent_dir) = env_path("PI_CODING_AGENT_DIR") {
        dedicated_roots.insert(agent_dir.join("sessions"));
    }
    dedicated_roots.insert(home.join(".pi").join("agent").join("sessions"));
    dedicated_roots.insert(home.join(".pi").join("sessions"));

    let mut files = Vec::new();
    for root in dedicated_roots {
        collect_files_under(&root, &mut files, &|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        });
    }

    if let Some(shared) = shared_session_dir() {
        let mut shared_files = Vec::new();
        collect_files_under(&shared, &mut shared_files, &|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        });
        // Partition shared dir by header line: OMP files start with `{"type":"title",...}`.
        for path in shared_files {
            if sniff_header_kind(&path) != HeaderKind::OmpTitle && !files.contains(&path) {
                files.push(path);
            }
        }
    }
    files
}

pub(super) fn discover_omp_files(home: &Path) -> Vec<PathBuf> {
    let mut dedicated_roots: BTreeSet<PathBuf> = BTreeSet::new();
    if let Some(cfg) = env_path("PI_CONFIG_DIR") {
        dedicated_roots.insert(cfg.join("agent").join("sessions"));
    }
    let omp_home = home.join(".omp");
    dedicated_roots.insert(omp_home.join("agent").join("sessions"));
    dedicated_roots.insert(omp_home.join("sessions"));

    if let Ok(profile) = std::env::var("OMP_PROFILE").or_else(|_| std::env::var("PI_PROFILE")) {
        let profile = profile.trim();
        if !profile.is_empty() {
            dedicated_roots.insert(omp_home.join("profiles").join(profile).join("agent").join("sessions"));
        }
    }
    let profiles_dir = omp_home.join("profiles");
    if let Ok(entries) = fs::read_dir(&profiles_dir) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("agent").join("sessions");
            if candidate.is_dir() {
                dedicated_roots.insert(candidate);
            }
        }
    }

    let mut files = Vec::new();
    for root in dedicated_roots {
        collect_files_under(&root, &mut files, &|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        });
    }

    if let Some(shared) = shared_session_dir() {
        let mut shared_files = Vec::new();
        collect_files_under(&shared, &mut shared_files, &|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        });
        for path in shared_files {
            if sniff_header_kind(&path) == HeaderKind::OmpTitle && !files.contains(&path) {
                files.push(path);
            }
        }
    }
    files
}

pub(super) fn build_pi_known_files(files: &[PathBuf]) -> HashSet<PathBuf> {
    let mut known = HashSet::with_capacity(files.len() * 2);
    for path in files {
        known.insert(path.clone());
        if let Ok(canonical) = fs::canonicalize(path) {
            known.insert(canonical);
        }
    }
    known
}

fn counter_from_usage_map(usage: &Map<String, Value>) -> Option<UsageCounter> {
    let input = first_counter(usage, &["input", "input_tokens", "inputTokens"]).unwrap_or(0);
    let output = first_counter(usage, &["output", "output_tokens", "outputTokens"]).unwrap_or(0);
    let cache_read =
        first_counter(usage, &["cacheRead", "cache_read", "cache_read_tokens"]).unwrap_or(0);
    let cache_write = first_counter(
        usage,
        &[
            "cacheWrite",
            "cache_write",
            "cacheCreation",
            "cache_creation_tokens",
        ],
    )
    .unwrap_or(0);
    let reasoning = first_counter(usage, &["reasoning", "reasoningTokens", "reasoning_tokens"]).unwrap_or(0);
    let total = input
        .saturating_add(output)
        .saturating_add(cache_read)
        .saturating_add(cache_write);
    if total == 0 {
        return None;
    }
    let reported_cost = usage
        .get("cost")
        .and_then(|v| {
            v.as_object()
                .and_then(|c| first_cost(c, &["total", "costUSD", "cost"]))
                .or_else(|| v.as_f64())
        })
        .filter(|c| c.is_finite() && *c > 0.0);

    Some(UsageCounter {
        input_tokens: input,
        output_tokens: output,
        cache_creation_tokens: cache_write,
        cache_creation_1h_tokens: 0,
        cache_read_tokens: cache_read,
        reasoning_tokens: reasoning,
        total_tokens: total,
        cost_usd: reported_cost.unwrap_or(0.0),
        reported_cost_usd: reported_cost.unwrap_or(0.0),
        reported_samples: u64::from(reported_cost.is_some()),
        samples: 1,
    })
}

fn is_known_session_file(raw: &str, parent_file: &Path, known: &HashSet<PathBuf>) -> bool {
    let candidate = PathBuf::from(raw.trim());
    if known.contains(&candidate) {
        return true;
    }
    if let Ok(canon) = fs::canonicalize(&candidate) {
        if known.contains(&canon) {
            return true;
        }
    }
    if candidate.is_relative() {
        if let Some(dir) = parent_file.parent() {
            let joined = dir.join(&candidate);
            if known.contains(&joined) {
                return true;
            }
            if let Ok(canon) = fs::canonicalize(&joined) {
                if known.contains(&canon) {
                    return true;
                }
            }
        }
    }
    false
}

pub(super) fn read_pi_file(
    path: &Path,
    ctx: &SourceSyncContext,
    delta: &mut FileDelta,
) -> Result<(), ()> {
    let file = File::open(path).map_err(|_| ())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();

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
        let Some(object) = value.as_object() else {
            continue;
        };

        match object.get("type").and_then(Value::as_str) {
            Some("message") => {
                let Some(message) = object.get("message").and_then(Value::as_object) else {
                    continue;
                };
                match message.get("role").and_then(Value::as_str) {
                    Some("assistant") => {
                        let Some(usage) = message.get("usage").and_then(Value::as_object) else {
                            continue;
                        };
                        let Some(counter) = counter_from_usage_map(usage) else {
                            continue;
                        };
                        let Some(time) = sample_time(&value, path) else {
                            continue;
                        };
                        let model = string_field(message, &["responseModel", "model", "modelName"])
                            .map(|m| sanitize_model_name(&m))
                            .filter(|m| !m.is_empty());
                        record_sample(delta, time, model, counter);
                    }
                    Some("toolResult")
                        if message.get("toolName").and_then(Value::as_str) == Some("subagent") =>
                    {
                        extract_pi_subagent_tool_result(message, &value, path, ctx, delta);
                    }
                    _ => {}
                }
            }
            None => {
                // Legacy flat sample without event `type` wrapper (e.g. `{"timestamp":..., "model":..., "usage":{...}}`).
                let Some(usage) = object.get("usage").and_then(Value::as_object) else {
                    continue;
                };
                let Some(counter) = counter_from_usage_map(usage) else {
                    continue;
                };
                let Some(time) = sample_time(&value, path) else {
                    continue;
                };
                let model = string_field(object, &["responseModel", "model", "modelName"])
                    .map(|m| sanitize_model_name(&m))
                    .filter(|m| !m.is_empty());
                record_sample(delta, time, model, counter);
            }
            Some(_) => {}
        }
    }
    Ok(())
}

fn extract_pi_subagent_tool_result(
    message: &Map<String, Value>,
    outer: &Value,
    path: &Path,
    ctx: &SourceSyncContext,
    delta: &mut FileDelta,
) {
    let Some(details) = message.get("details").and_then(Value::as_object) else {
        return;
    };
    let Some(results) = details.get("results").and_then(Value::as_array) else {
        return;
    };
    for result in results {
        let Some(res_obj) = result.as_object() else {
            continue;
        };
        // If `sessionFile` points to a child session file already discovered by Pi,
        // skip the parent projection so the child's tokens are not double-counted.
        if let Some(session_file) = res_obj
            .get("sessionFile")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            if is_known_session_file(session_file, path, &ctx.pi_known_files) {
                continue;
            }
        }
        if let Some(messages) = res_obj.get("messages").and_then(Value::as_array) {
            let mut extracted_any = false;
            for child_msg in messages {
                let Some(cm) = child_msg.as_object() else {
                    continue;
                };
                if cm
                    .get("role")
                    .and_then(Value::as_str)
                    .is_some_and(|r| r != "assistant")
                {
                    continue;
                }
                let Some(usage) = cm.get("usage").and_then(Value::as_object) else {
                    continue;
                };
                let Some(counter) = counter_from_usage_map(usage) else {
                    continue;
                };
                let Some(time) = sample_time(child_msg, path).or_else(|| sample_time(outer, path))
                else {
                    continue;
                };
                let model = string_field(cm, &["responseModel", "model", "modelName"])
                    .or_else(|| string_field(res_obj, &["model"]))
                    .map(|m| sanitize_model_name(&m))
                    .filter(|m| !m.is_empty());
                record_sample(delta, time, model, counter);
                extracted_any = true;
            }
            if extracted_any {
                continue;
            }
        }
        // Summary fallback when embedded subagent result only has top-level `usage`.
        if let Some(usage) = res_obj.get("usage").and_then(Value::as_object) {
            if let Some(counter) = counter_from_usage_map(usage) {
                if let Some(time) = sample_time(outer, path) {
                    let model = string_field(res_obj, &["model", "responseModel"])
                        .map(|m| sanitize_model_name(&m))
                        .filter(|m| !m.is_empty());
                    record_sample(delta, time, model, counter);
                }
            }
        }
    }
}

pub(super) fn read_omp_file(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    let file = File::open(path).map_err(|_| ())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();

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
        let Some(object) = value.as_object() else {
            continue;
        };

        let kind = object.get("type").and_then(Value::as_str);
        let (usage, model) = match kind {
            Some("message") => {
                let Some(message) = object.get("message").and_then(Value::as_object) else {
                    continue;
                };
                if message.get("role").and_then(Value::as_str) != Some("assistant") {
                    continue;
                }
                let Some(usage) = message.get("usage").and_then(Value::as_object) else {
                    continue;
                };
                let model = string_field(message, &["responseModel", "model", "modelName"]);
                (usage, model)
            }
            Some("model_usage" | "compaction" | "branch_summary") | None => {
                let Some(usage) = object.get("usage").and_then(Value::as_object) else {
                    continue;
                };
                let model = string_field(object, &["responseModel", "model", "modelName"]);
                (usage, model)
            }
            Some(_) => continue,
        };

        let Some(counter) = counter_from_usage_map(usage) else {
            continue;
        };
        let Some(time) = sample_time(&value, path) else {
            continue;
        };
        let model = model
            .map(|m| sanitize_model_name(&m))
            .filter(|m| !m.is_empty());
        record_sample(delta, time, model, counter);
    }
    Ok(())
}
