use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::workbuddy::{collect_buddy_project_files, extract_buddy_model, extract_buddy_tokens};
use super::{
    env_path, local_from_epoch_ms, record_sample, sample_time, FileDelta, MAX_JSON_LINE_BYTES,
};

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let mut roots: BTreeSet<PathBuf> = BTreeSet::new();
    if let Some(custom) = env_path("CODEBUDDY_CONFIG_DIR") {
        roots.insert(custom.join("projects"));
    }
    roots.insert(home.join(".codebuddy").join("projects"));

    let mut files = Vec::new();
    for projects in roots {
        collect_buddy_project_files(&projects, &mut files);
    }
    files
}

pub(super) fn read_file(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    let file = File::open(path).map_err(|_| ())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();

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
        match record.get("type").and_then(Value::as_str) {
            Some("message") if record.get("role").and_then(Value::as_str) == Some("assistant") => {}
            Some("function_call") => {}
            _ => continue,
        }
        let Some(provider_data) = record.get("providerData") else {
            continue;
        };
        let Some(counter) = extract_buddy_tokens(provider_data) else {
            continue;
        };
        let session = record
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let dedup_key = match (
            provider_data
                .get("messageId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty()),
            provider_data.get("stepSeq").and_then(Value::as_i64),
        ) {
            (Some(msg_id), Some(step_seq)) => format!("{session}:{msg_id}:{step_seq}"),
            _ => match record
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                Some(id) => format!("{session}:{id}"),
                None => String::new(),
            },
        };
        if !dedup_key.is_empty() && !seen_keys.insert(dedup_key) {
            continue;
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
