use chrono::{Local, TimeZone, Timelike};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    add_counter, collect_files_under, copy_sqlite_snapshot, env_path, first_counter,
    is_non_empty_regular_file, is_transient_sqlite_error, record_sample, sample_time,
    sanitize_model_name, string_field, FileDelta, UsageCounter, MAX_JSON_LINE_BYTES,
};

pub(super) fn read_custom_data_dir(home: &Path) -> Option<PathBuf> {
    let settings_path = home.join(".zcode").join("v2").join("setting.json");
    let content = fs::read_to_string(settings_path).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    let dir = value.get("dataBaseDir")?.as_str()?.trim();
    if dir.is_empty() {
        return None;
    }
    let path = PathBuf::from(dir);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

fn push_zcode_db_candidates(base: &Path, dirs: &mut Vec<PathBuf>) {
    dirs.push(base.join(".zcode").join("cli").join("db"));
    dirs.push(base.join("cli").join("db"));
    dirs.push(base.join("v2"));
    dirs.push(base.to_path_buf());
}

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let mut files: BTreeSet<PathBuf> = BTreeSet::new();
    let mut candidate_dirs: Vec<PathBuf> = Vec::new();
    if let Some(custom) = env_path("ZCODE_DATA_BASE_DIR") {
        push_zcode_db_candidates(&custom, &mut candidate_dirs);
    }
    if let Some(custom) = read_custom_data_dir(home) {
        push_zcode_db_candidates(&custom, &mut candidate_dirs);
    }
    let zcode_root = home.join(".zcode");
    candidate_dirs.push(zcode_root.join("cli").join("db"));
    candidate_dirs.push(zcode_root.join("v2"));
    candidate_dirs.push(zcode_root.clone());

    for dir in &candidate_dirs {
        for name in ["db.sqlite", "model_usage.db"] {
            let db = dir.join(name);
            if db.is_file() {
                files.insert(db);
            }
        }
    }

    if files.is_empty() {
        let mut jsonl = Vec::new();
        let sessions_dir = zcode_root.join("sessions");
        if sessions_dir.is_dir() {
            collect_files_under(&sessions_dir, &mut jsonl, &|path| {
                path.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
            });
        }
        files.extend(jsonl);
    }
    files.into_iter().collect()
}

pub(super) fn read_file(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("sqlite") || e.eq_ignore_ascii_case("db"))
    {
        return read_database(path, delta);
    }
    read_jsonl(path, delta)
}

pub(super) fn read_database(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    if !is_non_empty_regular_file(path) {
        return Ok(());
    }
    match read_database_conn(path, delta) {
        Ok(()) => Ok(()),
        Err(()) => {
            let Some(snapshot) = copy_sqlite_snapshot(path, "cpa-zcode") else {
                return Err(());
            };
            let outcome = read_database_conn(&snapshot, delta);
            if let Some(dir) = snapshot.parent() {
                let _ = fs::remove_dir_all(dir);
            }
            outcome
        }
    }
}

fn read_database_conn(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ())?;
    let _ = connection.busy_timeout(std::time::Duration::from_secs(2));

    let table_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_usage')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !table_exists {
        return Ok(());
    }

    let mut statement = match connection.prepare(
        "SELECT started_at, coalesce(model_id, 'unknown'), \
                coalesce(input_tokens, 0), coalesce(output_tokens, 0), \
                coalesce(cache_read_input_tokens, 0), coalesce(cache_creation_input_tokens, 0), \
                coalesce(reasoning_tokens, 0), coalesce(computed_total_tokens, 0) \
         FROM model_usage \
         WHERE lower(coalesce(provider_id, '')) NOT LIKE 'account:%' \
           AND lower(coalesce(provider_id, '')) NOT LIKE 'official%' \
         ORDER BY started_at ASC",
    ) {
        Ok(stmt) => stmt,
        Err(e) if is_transient_sqlite_error(&e) => return Err(()),
        Err(_) => return Ok(()),
    };

    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2).unwrap_or(0).max(0) as u64,
                row.get::<_, i64>(3).unwrap_or(0).max(0) as u64,
                row.get::<_, i64>(4).unwrap_or(0).max(0) as u64,
                row.get::<_, i64>(5).unwrap_or(0).max(0) as u64,
                row.get::<_, i64>(6).unwrap_or(0).max(0) as u64,
                row.get::<_, i64>(7).unwrap_or(0).max(0) as u64,
            ))
        })
        .map_err(|_| ())?;

    for row in rows {
        let (
            started_at,
            model,
            input,
            output,
            cache_read,
            cache_creation,
            reasoning,
            computed_total,
        ) = match row {
            Ok(values) => values,
            Err(e) if is_transient_sqlite_error(&e) => return Err(()),
            Err(_) => continue,
        };
        let Some(timestamp) = Local.timestamp_millis_opt(started_at).single() else {
            continue;
        };
        let day = timestamp.format("%Y-%m-%d").to_string();
        let hour = timestamp.hour() as u8;
        let model = sanitize_model_name(&model);

        let cr = cache_read.min(input);
        let fresh_input = input.saturating_sub(cr);
        let total = if computed_total > 0 {
            computed_total
        } else {
            fresh_input
                .saturating_add(output)
                .saturating_add(cr)
                .saturating_add(cache_creation)
        };
        if total == 0 {
            continue;
        }
        let counter = UsageCounter {
            cache_read_tokens: cr,
            cache_creation_tokens: cache_creation,
            reasoning_tokens: reasoning,
            output_tokens: output,
            input_tokens: fresh_input,
            total_tokens: total,
            samples: 1,
            ..Default::default()
        };

        add_counter(
            delta.daily.entry((day.clone(), model.clone())).or_default(),
            &counter,
        );
        add_counter(
            delta.hourly.entry((day, hour, model)).or_default(),
            &counter,
        );
    }
    Ok(())
}

fn read_jsonl(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
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
        let container = object
            .get("message")
            .and_then(Value::as_object)
            .unwrap_or(object);
        let Some(usage) = container.get("usage").and_then(Value::as_object) else {
            continue;
        };
        let input = first_counter(usage, &["input_tokens", "inputTokens", "input"]).unwrap_or(0);
        let output = first_counter(usage, &["output_tokens", "outputTokens", "output"]).unwrap_or(0);
        let cache_read =
            first_counter(usage, &["cache_read_input_tokens", "cache_read_tokens"]).unwrap_or(0);
        let cache_creation = first_counter(
            usage,
            &["cache_creation_input_tokens", "cache_creation_tokens"],
        )
        .unwrap_or(0);
        let reasoning = first_counter(usage, &["reasoning_tokens", "reasoningTokens"]).unwrap_or(0);
        let total = input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_creation);
        if total == 0 {
            continue;
        }
        let Some(time) = sample_time(&value, path) else {
            continue;
        };
        let model = string_field(container, &["model", "modelName", "model_id"])
            .map(|m| sanitize_model_name(&m))
            .filter(|m| !m.is_empty());
        let counter = UsageCounter {
            input_tokens: input,
            output_tokens: output,
            cache_creation_tokens: cache_creation,
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
