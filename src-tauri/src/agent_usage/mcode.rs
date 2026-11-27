use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    collect_files_under, copy_sqlite_snapshot, env_path, first_cost, first_counter,
    is_non_empty_regular_file, is_transient_sqlite_error, local_from_epoch_ms, record_sample,
    sample_time, sanitize_model_name, string_field, FileDelta, UsageCounter, MAX_JSON_LINE_BYTES,
};

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let mut files: BTreeSet<PathBuf> = BTreeSet::new();
    let data_dir = env_path("MINIMAX_DATA_DIR")
        .or_else(|| env_path("MAVIS_DATA_DIR"))
        .unwrap_or_else(|| home.join(".minimax"));
    let sqlite_path = data_dir
        .join("v2")
        .join("sqlite")
        .join("runtime-state.sqlite");
    if sqlite_path.is_file() {
        files.insert(sqlite_path);
    }

    // Legacy fallback if older JSONL sessions exist under `~/.mcode/sessions`.
    let legacy_sessions = home.join(".mcode").join("sessions");
    if legacy_sessions.is_dir() {
        let mut legacy = Vec::new();
        collect_files_under(&legacy_sessions, &mut legacy, &|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        });
        files.extend(legacy);
    }
    files.into_iter().collect()
}

pub(super) fn read_file(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("sqlite") || e.eq_ignore_ascii_case("db"))
    {
        return read_sqlite(path, delta);
    }
    read_legacy_jsonl(path, delta)
}

fn read_sqlite(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    if !is_non_empty_regular_file(path) {
        return Ok(());
    }
    match read_sqlite_conn(path, delta) {
        Ok(()) => Ok(()),
        Err(()) => {
            let Some(snapshot) = copy_sqlite_snapshot(path, "cpa-mcode") else {
                return Err(());
            };
            let outcome = read_sqlite_conn(&snapshot, delta);
            if let Some(dir) = snapshot.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
            outcome
        }
    }
}

struct HistoryModels<'a> {
    rows_stmt: Option<rusqlite::Statement<'a>>,
    legacy_stmt: Option<rusqlite::Statement<'a>>,
    legacy_cache: HashMap<String, HashMap<i64, String>>,
}

impl<'a> HistoryModels<'a> {
    fn prepare(conn: &'a Connection) -> Self {
        let rows_stmt = conn
            .prepare(
                "SELECT json_extract(data_json, '$.model')
                 FROM local_runtime_pi_history_rows
                 WHERE session_id = ?1 AND created_at_ms = ?2 AND role = 'assistant'
                 LIMIT 1",
            )
            .ok();
        let legacy_stmt = conn
            .prepare(
                "SELECT json_extract(message.value, '$.timestamp'),
                        json_extract(message.value, '$.model')
                 FROM local_runtime_messages, json_each(pi_history_json) AS message
                 WHERE session_id = ?1 AND json_extract(message.value, '$.role') = 'assistant'",
            )
            .ok();
        Self {
            rows_stmt,
            legacy_stmt,
            legacy_cache: HashMap::new(),
        }
    }

    fn lookup(&mut self, session_id: &str, ts: i64) -> Option<String> {
        if let Some(stmt) = self.rows_stmt.as_mut() {
            if let Ok(Some(model)) = stmt
                .query_row(params![session_id, ts], |row| row.get::<_, Option<String>>(0))
                .optional()
                .map(|v| v.flatten())
            {
                let trimmed = model.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        if !self.legacy_cache.contains_key(session_id) {
            let mut map = HashMap::new();
            if let Some(stmt) = self.legacy_stmt.as_mut() {
                if let Ok(rows) = stmt.query_map([session_id], |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                }) {
                    for (t, m) in rows.flatten() {
                        if let (Some(t), Some(m)) = (t, m) {
                            let trimmed = m.trim();
                            if !trimmed.is_empty() {
                                map.insert(t, trimmed.to_string());
                            }
                        }
                    }
                }
            }
            self.legacy_cache.insert(session_id.to_string(), map);
        }
        self.legacy_cache
            .get(session_id)
            .and_then(|map| map.get(&ts).cloned())
    }
}

fn read_sqlite_conn(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ())?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(2));

    let has_table: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_runtime_token_usage')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !has_table {
        return Ok(());
    }

    let mut history = HistoryModels::prepare(&conn);
    let mut stmt = match conn.prepare(
        "SELECT session_id, model, ts, input_tokens, output_tokens,
                reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd
         FROM local_runtime_token_usage
         ORDER BY id ASC",
    ) {
        Ok(s) => s,
        Err(e) if is_transient_sqlite_error(&e) => return Err(()),
        Err(_) => return Ok(()),
    };

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0).unwrap_or_default(),
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3).unwrap_or(0).max(0) as u64,
                row.get::<_, i64>(4).unwrap_or(0).max(0) as u64,
                row.get::<_, i64>(5).unwrap_or(0).max(0) as u64,
                row.get::<_, i64>(6).unwrap_or(0).max(0) as u64,
                row.get::<_, i64>(7).unwrap_or(0).max(0) as u64,
                row.get::<_, Option<f64>>(8).ok().flatten(),
            ))
        })
        .map_err(|_| ())?;

    for row in rows {
        let (
            session_id,
            native_model,
            ts,
            input,
            output,
            reasoning,
            cache_read,
            cache_write,
            cost_usd,
        ) = match row {
            Ok(tuple) => tuple,
            Err(e) if is_transient_sqlite_error(&e) => return Err(()),
            Err(_) => continue,
        };
        let output_total = output.saturating_add(reasoning);
        let total = input
            .saturating_add(output_total)
            .saturating_add(cache_read)
            .saturating_add(cache_write);
        if total == 0 {
            continue;
        }
        let Some(time) = local_from_epoch_ms(ts) else {
            continue;
        };
        let raw_model = native_model
            .filter(|m| !m.trim().is_empty())
            .or_else(|| history.lookup(&session_id, ts));
        let model = raw_model
            .map(|m| {
                let tail = m.split_once('/').map_or(m.as_str(), |(_, right)| right);
                sanitize_model_name(tail)
            })
            .filter(|m| !m.is_empty());

        let reported_cost = cost_usd.filter(|c| c.is_finite() && *c > 0.0);

        let counter = UsageCounter {
            input_tokens: input,
            output_tokens: output_total,
            cache_creation_tokens: cache_write,
            cache_creation_1h_tokens: 0,
            cache_read_tokens: cache_read,
            reasoning_tokens: reasoning,
            total_tokens: total,
            cost_usd: reported_cost.unwrap_or(0.0),
            reported_cost_usd: reported_cost.unwrap_or(0.0),
            reported_samples: u64::from(reported_cost.is_some()),
            samples: 1,
        };
        record_sample(delta, time, model, counter);
    }
    Ok(())
}

fn read_legacy_jsonl(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
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
        let reasoning = first_counter(usage, &["reasoning_tokens", "reasoningTokens"]).unwrap_or(0);
        let cache_read = first_counter(usage, &["cache_read_tokens", "cacheRead"]).unwrap_or(0);
        let cache_write =
            first_counter(usage, &["cache_write_tokens", "cache_creation_tokens", "cacheWrite"])
                .unwrap_or(0);
        let output_total = output.saturating_add(reasoning);
        let total = input
            .saturating_add(output_total)
            .saturating_add(cache_read)
            .saturating_add(cache_write);
        if total == 0 {
            continue;
        }
        let Some(time) = sample_time(&value, path) else {
            continue;
        };
        let reported_cost = first_cost(container, &["costUSD", "cost_usd", "cost"])
            .or_else(|| {
                usage
                    .get("cost")
                    .and_then(Value::as_object)
                    .and_then(|c| first_cost(c, &["total"]))
            })
            .filter(|c| c.is_finite() && *c > 0.0);
        let model = string_field(container, &["model", "modelName"])
            .map(|m| sanitize_model_name(m.split_once('/').map_or(m.as_str(), |(_, r)| r)))
            .filter(|m| !m.is_empty());
        let counter = UsageCounter {
            input_tokens: input,
            output_tokens: output_total,
            cache_creation_tokens: cache_write,
            cache_creation_1h_tokens: 0,
            cache_read_tokens: cache_read,
            reasoning_tokens: reasoning,
            total_tokens: total,
            cost_usd: reported_cost.unwrap_or(0.0),
            reported_cost_usd: reported_cost.unwrap_or(0.0),
            reported_samples: u64::from(reported_cost.is_some()),
            samples: 1,
        };
        record_sample(delta, time, model, counter);
    }
    Ok(())
}
