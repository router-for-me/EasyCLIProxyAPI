use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use super::{
    copy_sqlite_snapshot, env_path, first_cost, first_counter, is_non_empty_regular_file,
    is_transient_sqlite_error, local_from_epoch_ms, record_sample, sample_time,
    sanitize_model_name, string_field, FileDelta, UsageCounter, MAX_JSON_LINE_BYTES,
};

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let mut candidates: BTreeSet<PathBuf> = BTreeSet::new();
    if let Some(custom) = env_path("OPENCODE_DB") {
        if custom.is_file() {
            candidates.insert(custom);
        }
    }
    if let Some(xdg) = env_path("XDG_DATA_HOME") {
        let p = xdg.join("opencode").join("opencode.db");
        if p.is_file() {
            candidates.insert(p);
        }
    }
    let default_db = home
        .join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db");
    if default_db.is_file() {
        candidates.insert(default_db);
    }
    let home_db = home.join(".opencode").join("opencode.db");
    if home_db.is_file() {
        candidates.insert(home_db);
    }
    if let Some(app_data) = env_path("APPDATA") {
        let p = app_data.join("opencode").join("opencode.db");
        if p.is_file() {
            candidates.insert(p);
        }
    }
    if let Some(local_app_data) = env_path("LOCALAPPDATA") {
        let p = local_app_data.join("opencode").join("opencode.db");
        if p.is_file() {
            candidates.insert(p);
        }
    }
    candidates.into_iter().collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenCodeSchema {
    V1,
    V2,
    Mixed,
    None,
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or(false)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return false;
    };
    let found = rows.flatten().any(|name| name.eq_ignore_ascii_case(column));
    found
}

fn detect_schema(conn: &Connection) -> OpenCodeSchema {
    let has_v1 = table_exists(conn, "message");
    let has_v2 = table_exists(conn, "session_message");
    match (has_v1, has_v2) {
        (true, true) => OpenCodeSchema::Mixed,
        (false, true) => OpenCodeSchema::V2,
        (true, false) => OpenCodeSchema::V1,
        (false, false) => OpenCodeSchema::None,
    }
}

struct RawRow {
    id: Option<String>,
    time_updated: i64,
    time_created: Option<i64>,
    schema_priority: u8, // V2 (1) wins over V1 (0) on tie
    is_v2: bool,
    v2_type: Option<String>,
    data: String,
}

pub(super) fn read_file(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    if !is_non_empty_regular_file(path) {
        return Ok(());
    }
    match read_database(path, delta) {
        Ok(()) => Ok(()),
        Err(()) => {
            let Some(snapshot) = copy_sqlite_snapshot(path, "cpa-opencode") else {
                return Err(());
            };
            let outcome = read_database(&snapshot, delta);
            if let Some(dir) = snapshot.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
            outcome
        }
    }
}

fn read_database(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ())?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(2));

    let schema = detect_schema(&conn);
    if schema == OpenCodeSchema::None {
        return Ok(());
    }

    let mut rows: Vec<RawRow> = Vec::new();
    if matches!(schema, OpenCodeSchema::V1 | OpenCodeSchema::Mixed) {
        query_v1_rows(&conn, &mut rows)?;
    }
    if matches!(schema, OpenCodeSchema::V2 | OpenCodeSchema::Mixed) {
        query_v2_rows(&conn, &mut rows)?;
    }

    // Deduplicate across V1/V2 by message id (latest time_updated, V2 wins on tie).
    let mut keyed: HashMap<String, RawRow> = HashMap::new();
    let mut unkeyed: Vec<RawRow> = Vec::new();
    for row in rows {
        if let Some(id) = row.id.clone().filter(|s| !s.is_empty()) {
            match keyed.get(&id) {
                Some(prev)
                    if (prev.time_updated, prev.schema_priority)
                        >= (row.time_updated, row.schema_priority) => {}
                _ => {
                    keyed.insert(id, row);
                }
            }
        } else {
            unkeyed.push(row);
        }
    }

    for row in keyed.into_values().chain(unkeyed) {
        if row.data.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&row.data) else {
            continue;
        };
        if let Some((counter, model, time)) =
            extract_opencode_message(&value, row.is_v2, row.v2_type.as_deref(), row.time_created, path)
        {
            record_sample(delta, time, model, counter);
        }
    }
    Ok(())
}

fn query_v1_rows(conn: &Connection, out: &mut Vec<RawRow>) -> Result<(), ()> {
    let has_id = has_column(conn, "message", "id");
    let has_updated = has_column(conn, "message", "time_updated");
    let has_created = has_column(conn, "message", "time_created");
    let sql = format!(
        "SELECT {}, {}, {}, data FROM message WHERE length(data) <= {MAX_JSON_LINE_BYTES}",
        if has_id { "id" } else { "NULL" },
        if has_updated { "COALESCE(time_updated, 0)" } else { "0" },
        if has_created { "time_created" } else { "NULL" },
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) if is_transient_sqlite_error(&e) => return Err(()),
        Err(_) => return Ok(()),
    };
    let iter = stmt
        .query_map([], |row| {
            Ok(RawRow {
                id: row.get::<_, Option<String>>(0)?,
                time_updated: row.get::<_, i64>(1).unwrap_or(0),
                time_created: row.get::<_, Option<i64>>(2).ok().flatten(),
                schema_priority: 0,
                is_v2: false,
                v2_type: None,
                data: row.get::<_, String>(3)?,
            })
        })
        .map_err(|_| ())?;
    for item in iter {
        match item {
            Ok(r) => out.push(r),
            Err(e) if is_transient_sqlite_error(&e) => return Err(()),
            Err(_) => continue,
        }
    }
    Ok(())
}

fn query_v2_rows(conn: &Connection, out: &mut Vec<RawRow>) -> Result<(), ()> {
    let has_id = has_column(conn, "session_message", "id");
    let has_updated = has_column(conn, "session_message", "time_updated");
    let has_created = has_column(conn, "session_message", "time_created");
    let has_type = has_column(conn, "session_message", "type");
    let type_filter = if has_type {
        "AND type IN ('assistant', 'compaction')"
    } else {
        ""
    };
    let sql = format!(
        "SELECT {}, {}, {}, {}, data FROM session_message WHERE length(data) <= {MAX_JSON_LINE_BYTES} {type_filter}",
        if has_id { "id" } else { "NULL" },
        if has_updated { "COALESCE(time_updated, 0)" } else { "0" },
        if has_created { "time_created" } else { "NULL" },
        if has_type { "type" } else { "NULL" },
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) if is_transient_sqlite_error(&e) => return Err(()),
        Err(_) => return Ok(()),
    };
    let iter = stmt
        .query_map([], |row| {
            Ok(RawRow {
                id: row.get::<_, Option<String>>(0)?,
                time_updated: row.get::<_, i64>(1).unwrap_or(0),
                time_created: row.get::<_, Option<i64>>(2).ok().flatten(),
                schema_priority: 1,
                is_v2: true,
                v2_type: row.get::<_, Option<String>>(3).ok().flatten(),
                data: row.get::<_, String>(4)?,
            })
        })
        .map_err(|_| ())?;
    for item in iter {
        match item {
            Ok(r) => out.push(r),
            Err(e) if is_transient_sqlite_error(&e) => return Err(()),
            Err(_) => continue,
        }
    }
    Ok(())
}

fn extract_opencode_message(
    value: &Value,
    is_v2: bool,
    v2_type: Option<&str>,
    row_created: Option<i64>,
    path: &Path,
) -> Option<(UsageCounter, Option<String>, chrono::DateTime<chrono::Local>)> {
    let object = value.as_object()?;
    if is_v2 {
        let kind = v2_type.or_else(|| object.get("type").and_then(Value::as_str));
        match kind {
            Some("assistant") => {
                // Skip still-streaming assistant messages.
                if value
                    .pointer("/time/completed")
                    .and_then(Value::as_i64)
                    .is_none()
                {
                    return None;
                }
            }
            Some("compaction") => {
                let status = object.get("status").and_then(Value::as_str);
                if !matches!(status, Some("completed" | "failed")) {
                    return None;
                }
            }
            Some(_) => return None,
            None => {}
        }
    } else if let Some(role) = object.get("role").and_then(Value::as_str) {
        if role != "assistant" {
            return None;
        }
        // Real V1 assistant records carry `time.completed` once finished.
        if object.get("time").is_some_and(Value::is_object)
            && value
                .pointer("/time/completed")
                .and_then(Value::as_i64)
                .is_none()
            && object.get("finish").is_none()
        {
            return None;
        }
    }

    let tokens = object
        .get("tokens")
        .or_else(|| object.get("usage"))
        .and_then(Value::as_object)?;

    let input = first_counter(tokens, &["input", "input_tokens", "inputTokens"]).unwrap_or(0);
    let output = first_counter(tokens, &["output", "output_tokens", "outputTokens"]).unwrap_or(0);
    let reasoning = first_counter(tokens, &["reasoning", "reasoning_tokens", "reasoningTokens"]).unwrap_or(0);
    let cache = tokens.get("cache").and_then(Value::as_object);
    let cache_read = cache
        .and_then(|c| first_counter(c, &["read"]))
        .or_else(|| first_counter(tokens, &["cache_read", "cacheRead", "cache_read_tokens"]))
        .unwrap_or(0);
    let cache_write = cache
        .and_then(|c| first_counter(c, &["write"]))
        .or_else(|| first_counter(tokens, &["cache_write", "cacheWrite", "cache_creation_tokens"]))
        .unwrap_or(0);

    // OpenCode reports `reasoning` separately from `output`; include it in billable output tokens.
    let output_total = output.saturating_add(reasoning);
    let total = input
        .saturating_add(output_total)
        .saturating_add(cache_read)
        .saturating_add(cache_write);
    if total == 0 {
        return None;
    }

    let reported_cost = first_cost(object, &["cost", "costUSD", "cost_usd"])
        .filter(|c| c.is_finite() && *c > 0.0);

    let model = string_field(object, &["modelID", "modelId", "model"])
        .or_else(|| {
            object
                .get("model")
                .and_then(Value::as_object)
                .and_then(|m| string_field(m, &["modelID", "modelId", "id"]))
        })
        .map(|m| sanitize_model_name(&m))
        .filter(|m| !m.is_empty());

    let time = value
        .pointer("/time/completed")
        .and_then(Value::as_i64)
        .or_else(|| value.pointer("/time/created").and_then(Value::as_i64))
        .or(row_created)
        .and_then(local_from_epoch_ms)
        .or_else(|| sample_time(value, path))?;

    Some((
        UsageCounter {
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
        },
        model,
        time,
    ))
}
