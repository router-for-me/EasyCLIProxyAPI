use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    collect_files_under, env_path, first_counter, record_sample, sample_time, sanitize_model_name,
    string_field, FileDelta, UsageCounter, MAX_JSON_DOCUMENT_BYTES, MAX_JSON_LINE_BYTES,
};

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let mut roots: BTreeSet<PathBuf> = BTreeSet::new();
    if let Some(custom) = env_path("GEMINI_CLI_HOME") {
        roots.insert(custom.join(".gemini").join("tmp"));
    }
    roots.insert(home.join(".gemini").join("tmp"));

    let mut raw = Vec::new();
    for root in roots {
        collect_files_under(&root, &mut raw, &|path| is_gemini_session_file(path));
    }

    // When both `session-foo.jsonl` and `session-foo.json` exist in the same chats
    // directory, skip the `.json` mirror so the session is counted once.
    let jsonl_stems: HashSet<PathBuf> = raw
        .iter()
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
        })
        .map(|path| path.with_extension(""))
        .collect();

    raw.into_iter()
        .filter(|path| {
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
            {
                !jsonl_stems.contains(&path.with_extension(""))
            } else {
                true
            }
        })
        .collect()
}

fn is_gemini_session_file(path: &Path) -> bool {
    let in_chats = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("chats"));
    if !in_chats {
        return false;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.starts_with("session-") && (name.ends_with(".jsonl") || name.ends_with(".json"))
}

pub(super) fn read_file(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let messages = if ext == "jsonl" {
        replay_gemini_jsonl(path)?
    } else if ext == "json" {
        read_gemini_json(path)?
    } else {
        return Ok(());
    };

    for msg in &messages {
        if let Some((counter, model)) = extract_gemini_message(msg) {
            if let Some(time) = sample_time(msg, path) {
                record_sample(delta, time, model, counter);
            }
        }
    }
    Ok(())
}

fn read_gemini_json(path: &Path) -> Result<Vec<Value>, ()> {
    let meta = fs::metadata(path).map_err(|_| ())?;
    if meta.len() > MAX_JSON_DOCUMENT_BYTES {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|_| ())?;
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Ok(Vec::new());
    };
    if let Some(messages) = value.get("messages").and_then(Value::as_array) {
        return Ok(messages.clone());
    }
    if let Some(array) = value.as_array() {
        return Ok(array.clone());
    }
    Ok(vec![value])
}

fn replay_gemini_jsonl(path: &Path) -> Result<Vec<Value>, ()> {
    let file = File::open(path).map_err(|_| ())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
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
        if let Some(rewind) = value.get("$rewindTo") {
            if let Some(index) = rewind.as_u64() {
                messages.truncate(index as usize);
            } else if let Some(target_id) = rewind.as_str() {
                if let Some(pos) = messages
                    .iter()
                    .position(|m| m.get("id").and_then(Value::as_str) == Some(target_id))
                {
                    messages.truncate(pos + 1);
                }
            }
            continue;
        }
        if let Some(set_messages) = value.pointer("/$set/messages").and_then(Value::as_array) {
            messages = set_messages.clone();
            continue;
        }
        if let Some(id) = value.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            if let Some(existing) = messages
                .iter_mut()
                .find(|m| m.get("id").and_then(Value::as_str) == Some(id))
            {
                *existing = value;
                continue;
            }
        }
        messages.push(value);
    }
    Ok(messages)
}

fn extract_gemini_message(msg: &Value) -> Option<(UsageCounter, Option<String>)> {
    let object = msg.as_object()?;
    if let Some(kind) = object.get("type").and_then(Value::as_str) {
        if !kind.eq_ignore_ascii_case("gemini") {
            return None;
        }
    }
    let tokens = object
        .get("tokens")
        .or_else(|| object.get("usageMetadata"))
        .and_then(Value::as_object)?;

    let raw_input = first_counter(tokens, &["input", "promptTokenCount", "input_tokens"]).unwrap_or(0);
    let output = first_counter(tokens, &["output", "candidatesTokenCount", "output_tokens"]).unwrap_or(0);
    let cached = first_counter(tokens, &["cached", "cachedContentTokenCount", "cache_read_tokens"]).unwrap_or(0);
    let thoughts = first_counter(tokens, &["thoughts", "thoughtsTokenCount", "reasoning_tokens"]).unwrap_or(0);

    if raw_input == 0 && output == 0 && cached == 0 && thoughts == 0 {
        return None;
    }

    let cached_clamped = cached.min(raw_input);
    let fresh_input = raw_input.saturating_sub(cached_clamped);
    let output_total = output.saturating_add(thoughts);
    let total_tokens = fresh_input
        .saturating_add(output_total)
        .saturating_add(cached_clamped);

    let model = string_field(object, &["model", "modelName"])
        .map(|m| sanitize_model_name(&m))
        .filter(|m| !m.is_empty());

    Some((
        UsageCounter {
            input_tokens: fresh_input,
            output_tokens: output_total,
            cache_creation_tokens: 0,
            cache_creation_1h_tokens: 0,
            cache_read_tokens: cached_clamped,
            reasoning_tokens: thoughts,
            total_tokens,
            cost_usd: 0.0,
            reported_cost_usd: 0.0,
            reported_samples: 0,
            samples: 1,
        },
        model,
    ))
}
