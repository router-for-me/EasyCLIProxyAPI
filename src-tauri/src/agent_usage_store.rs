use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Timelike, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::agent_usage::{
    proxy_codex_delta, read_usage_file, source_files, FileDelta, UsageCounter, SOURCE_NAMES,
};
use crate::usage::{load_agent_usage_prices, resolve_agent_usage_price, ModelPrice};

const STORE_DIRECTORY: &str = "agent-usage";
const STORE_DATABASE: &str = "agent_usage.db";
const STORE_SCHEMA_VERSION: i64 = 1;
const HOURLY_RETENTION_DAYS: i64 = 30;
const PROXY_FILE_KEY: &str = "codex:proxy-usage-db";
const SYNC_BATCH_FILES: usize = 32;
const MODEL_ROUTE_PREFIXES: &[&str] = &["workbuddyglobal-"];

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageQuery {
    #[serde(default)]
    pub(crate) range: String,
    #[serde(default)]
    pub(crate) sources: Vec<String>,
    #[serde(default)]
    pub(crate) group_by: String,
    #[serde(default)]
    pub(crate) granularity: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageTotals {
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    reasoning_tokens: u64,
    total_tokens: u64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
    samples: u64,
    days: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageReport {
    pub(crate) schema_version: u8,
    pub(crate) generated_at: String,
    pub(crate) last_sync_at: String,
    pub(crate) syncing: bool,
    pub(crate) bucket: String,
    pub(crate) range_start: String,
    pub(crate) range_end: String,
    pub(crate) totals: AgentUsageTotals,
    pub(crate) previous: Option<AgentUsagePeriodTotals>,
    pub(crate) sources: Vec<AgentUsageSource>,
    pub(crate) timeline: Vec<AgentUsageBucket>,
    pub(crate) calendar: Vec<AgentUsageCalendarRow>,
    pub(crate) hourly: Vec<AgentUsageHourRow>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsagePeriodTotals {
    total_tokens: u64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageSource {
    source: String,
    status: String,
    archived_at: String,
    error: String,
    totals: AgentUsageTotals,
    models: Vec<AgentUsageModelRow>,
    series: Vec<AgentUsageBucket>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageModelRow {
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    reasoning_tokens: u64,
    total_tokens: u64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
    priced: bool,
    prompt: Option<f64>,
    completion: Option<f64>,
    cache_read: Option<f64>,
    cache_creation: Option<f64>,
    days: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageBucket {
    bucket: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    reasoning_tokens: u64,
    total_tokens: u64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
    samples: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageCalendarRow {
    date: String,
    total_tokens: u64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageHourRow {
    weekday: u8,
    hour: u8,
    total_tokens: u64,
    samples: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageSyncResult {
    pub(crate) skipped: bool,
    pub(crate) changed_files: u64,
    pub(crate) scanned_files: u64,
    pub(crate) duration_ms: u64,
    pub(crate) last_sync_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageStorage {
    pub(crate) database_size_bytes: u64,
    pub(crate) daily_rows: u64,
    pub(crate) hourly_rows: u64,
    pub(crate) file_rows: u64,
    pub(crate) last_sync_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageSyncProgress {
    pub(crate) source: String,
    pub(crate) scanned: u64,
    pub(crate) total: u64,
    pub(crate) finished: bool,
}

#[derive(Debug, Clone)]
struct SourceMeta {
    last_present_at: i64,
    last_scan_at: i64,
    status: String,
    error: String,
}

#[derive(Debug)]
struct AggregatedRow {
    source: String,
    day: String,
    hour: u8,
    model: String,
    counter: UsageCounter,
}

pub(crate) fn store_directory() -> Result<PathBuf, String> {
    Ok(crate::core_runtime::core_base_dir()?.join(STORE_DIRECTORY))
}

pub(crate) fn store_path() -> Result<PathBuf, String> {
    Ok(store_directory()?.join(STORE_DATABASE))
}

pub(crate) fn open_store() -> Result<Connection, String> {
    open_store_at(&store_path()?)
}

pub(crate) fn open_store_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create agent usage directory: {error}"))?;
    }
    let connection = Connection::open(path)
        .map_err(|error| format!("Failed to open agent usage database: {error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("Failed to configure agent usage database: {error}"))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("Failed to enable agent usage WAL: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("Failed to configure agent usage sync: {error}"))?;
    connection
        .pragma_update(None, "cache_size", -2048)
        .map_err(|error| format!("Failed to configure agent usage cache: {error}"))?;
    connection
        .pragma_update(None, "mmap_size", 0)
        .map_err(|error| format!("Failed to configure agent usage memory map: {error}"))?;
    initialize_schema(&connection)?;
    Ok(connection)
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS agent_usage_meta (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_usage_sources (
                source TEXT PRIMARY KEY NOT NULL,
                last_present_at INTEGER NOT NULL DEFAULT 0,
                last_scan_at INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'empty',
                error TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS agent_usage_files (
                file_key TEXT PRIMARY KEY NOT NULL,
                source TEXT NOT NULL,
                path TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                scanned_at INTEGER NOT NULL,
                present INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_agent_usage_files_source
                ON agent_usage_files(source, present);

            CREATE TABLE IF NOT EXISTS agent_usage_daily (
                file_key TEXT NOT NULL,
                source TEXT NOT NULL,
                day TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL,
                cache_creation_tokens INTEGER NOT NULL,
                reasoning_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                samples INTEGER NOT NULL,
                PRIMARY KEY (file_key, day, model)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_agent_usage_daily_source_day
                ON agent_usage_daily(source, day);

            CREATE TABLE IF NOT EXISTS agent_usage_hourly (
                file_key TEXT NOT NULL,
                source TEXT NOT NULL,
                day TEXT NOT NULL,
                hour INTEGER NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL,
                cache_creation_tokens INTEGER NOT NULL,
                reasoning_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                samples INTEGER NOT NULL,
                PRIMARY KEY (file_key, day, hour, model)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_agent_usage_hourly_day
                ON agent_usage_hourly(day);
            "#,
        )
        .map_err(|error| format!("Failed to initialize agent usage schema: {error}"))?;
    connection
        .pragma_update(None, "user_version", STORE_SCHEMA_VERSION)
        .map_err(|error| format!("Failed to update agent usage schema version: {error}"))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn millis_to_rfc3339(value: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(value)
        .map(|time| time.to_rfc3339())
        .unwrap_or_default()
}

fn file_key(source: &str, path: &Path) -> String {
    if source == "codex" {
        if let Some(name) = path.file_name() {
            return format!("{source}:{}", name.to_string_lossy());
        }
    }
    format!("{source}:{}", path.to_string_lossy())
}

fn file_stamp(path: &Path) -> Option<(i64, i64)> {
    let stamp = |path: &Path| -> Option<(i64, i64)> {
        let metadata = fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        let nanos = metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos()
            .min(i64::MAX as u128) as i64;
        Some((metadata.len().min(i64::MAX as u64) as i64, nanos))
    };
    let (size, mtime) = stamp(path)?;
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    Some(match stamp(Path::new(&wal)) {
        Some((wal_size, wal_mtime)) => (size.saturating_add(wal_size), mtime.max(wal_mtime)),
        None => (size, mtime),
    })
}

fn read_meta(connection: &Connection, key: &str) -> String {
    connection
        .query_row(
            "SELECT value FROM agent_usage_meta WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn write_meta(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO agent_usage_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|error| format!("Failed to store agent usage metadata: {error}"))?;
    Ok(())
}

fn load_sources(connection: &Connection) -> HashMap<String, SourceMeta> {
    let Ok(mut statement) = connection.prepare(
        "SELECT source, last_present_at, last_scan_at, status, error FROM agent_usage_sources",
    ) else {
        return HashMap::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            SourceMeta {
                last_present_at: row.get(1)?,
                last_scan_at: row.get(2)?,
                status: row.get(3)?,
                error: row.get(4)?,
            },
        ))
    }) else {
        return HashMap::new();
    };
    rows.flatten().collect()
}

fn save_source(
    connection: &Connection,
    source: &str,
    last_present_at: i64,
    status: &str,
    error: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO agent_usage_sources (source, last_present_at, last_scan_at, status, error)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(source) DO UPDATE SET
                last_present_at = excluded.last_present_at,
                last_scan_at = excluded.last_scan_at,
                status = excluded.status,
                error = excluded.error",
            params![source, last_present_at, now_millis(), status, error],
        )
        .map_err(|error| format!("Failed to store agent usage source: {error}"))?;
    Ok(())
}

fn replace_file_rows(
    transaction: &rusqlite::Transaction<'_>,
    source: &str,
    key: &str,
    delta: &FileDelta,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM agent_usage_daily WHERE file_key = ?1", [key])
        .map_err(|error| format!("Failed to replace agent usage rows: {error}"))?;
    transaction
        .execute("DELETE FROM agent_usage_hourly WHERE file_key = ?1", [key])
        .map_err(|error| format!("Failed to replace agent usage rows: {error}"))?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO agent_usage_daily (
                    file_key, source, day, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                    total_tokens, samples
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )
            .map_err(|error| format!("Failed to prepare agent usage insert: {error}"))?;
        for ((day, model), counter) in &delta.daily {
            statement
                .execute(params![
                    key,
                    source,
                    day,
                    model,
                    counter.input_tokens,
                    counter.output_tokens,
                    counter.cache_read_tokens,
                    counter.cache_creation_tokens,
                    counter.reasoning_tokens,
                    counter.total_tokens,
                    counter.samples
                ])
                .map_err(|error| format!("Failed to store agent usage row: {error}"))?;
        }
    }
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO agent_usage_hourly (
                    file_key, source, day, hour, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                    total_tokens, samples
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )
            .map_err(|error| format!("Failed to prepare agent usage insert: {error}"))?;
        for ((day, hour, model), counter) in &delta.hourly {
            statement
                .execute(params![
                    key,
                    source,
                    day,
                    hour,
                    model,
                    counter.input_tokens,
                    counter.output_tokens,
                    counter.cache_read_tokens,
                    counter.cache_creation_tokens,
                    counter.reasoning_tokens,
                    counter.total_tokens,
                    counter.samples
                ])
                .map_err(|error| format!("Failed to store agent usage row: {error}"))?;
        }
    }
    Ok(())
}

fn store_file(
    transaction: &rusqlite::Transaction<'_>,
    source: &str,
    key: &str,
    path: &Path,
    size: i64,
    mtime_ns: i64,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO agent_usage_files (file_key, source, path, size, mtime_ns, scanned_at, present)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
             ON CONFLICT(file_key) DO UPDATE SET
                source = excluded.source,
                path = excluded.path,
                size = excluded.size,
                mtime_ns = excluded.mtime_ns,
                scanned_at = excluded.scanned_at,
                present = 1",
            params![
                key,
                source,
                path.to_string_lossy(),
                size,
                mtime_ns,
                now_millis()
            ],
        )
        .map_err(|error| format!("Failed to store agent usage file: {error}"))?;
    Ok(())
}

fn newest_first(files: Vec<PathBuf>) -> Vec<(PathBuf, (i64, i64))> {
    let mut stamped: Vec<(PathBuf, (i64, i64))> = files
        .into_iter()
        .filter_map(|path| file_stamp(&path).map(|stamp| (path, stamp)))
        .collect();
    stamped.sort_by(|left, right| {
        right
            .1
             .1
            .cmp(&left.1 .1)
            .then_with(|| left.0.cmp(&right.0))
    });
    stamped
}

fn existing_files(
    transaction: &rusqlite::Transaction<'_>,
    source: &str,
) -> HashMap<String, (i64, i64, bool)> {
    let Ok(mut statement) = transaction.prepare(
        "SELECT file_key, size, mtime_ns, present FROM agent_usage_files WHERE source = ?1",
    ) else {
        return HashMap::new();
    };
    let Ok(rows) = statement.query_map([source], |row| {
        Ok((
            row.get::<_, String>(0)?,
            (
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)? != 0,
            ),
        ))
    }) else {
        return HashMap::new();
    };
    rows.flatten().collect()
}

fn codex_has_local_rows(connection: &Connection) -> bool {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_usage_daily WHERE source = 'codex' AND file_key <> ?1)",
            [PROXY_FILE_KEY],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .unwrap_or(false)
}

fn delete_proxy_rows(connection: &mut Connection) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start agent usage transaction: {error}"))?;
    for table in [
        "agent_usage_daily",
        "agent_usage_hourly",
        "agent_usage_files",
    ] {
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE file_key = ?1"),
                [PROXY_FILE_KEY],
            )
            .map_err(|error| format!("Failed to clear agent usage rows: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit agent usage transaction: {error}"))
}

fn sync_proxy_codex(
    connection: &mut Connection,
    proxy_database: Option<&Path>,
) -> Result<bool, String> {
    if codex_has_local_rows(connection) {
        delete_proxy_rows(connection)?;
        return Ok(false);
    }
    let Some(path) = proxy_database else {
        return Ok(false);
    };
    let Some((size, mtime_ns)) = file_stamp(path) else {
        return Ok(false);
    };
    let unchanged = connection
        .query_row(
            "SELECT size, mtime_ns FROM agent_usage_files WHERE file_key = ?1",
            [PROXY_FILE_KEY],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .ok()
        .flatten()
        .is_some_and(|(stored_size, stored_mtime)| stored_size == size && stored_mtime == mtime_ns);
    if unchanged {
        return Ok(false);
    }
    let Some(delta) = proxy_codex_delta(path) else {
        delete_proxy_rows(connection)?;
        return Ok(false);
    };
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start agent usage transaction: {error}"))?;
    replace_file_rows(&transaction, "codex", PROXY_FILE_KEY, &delta)?;
    store_file(&transaction, "codex", PROXY_FILE_KEY, path, size, mtime_ns)?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit agent usage transaction: {error}"))?;
    Ok(true)
}

pub(crate) fn sync(
    connection: &mut Connection,
    home: &Path,
    proxy_database: Option<&Path>,
    mut progress: impl FnMut(AgentUsageSyncProgress),
) -> Result<AgentUsageSyncResult, String> {
    let started = Instant::now();
    let mut changed_files = 0u64;
    let mut scanned_files = 0u64;
    let previous_sources = load_sources(connection);

    for source in SOURCE_NAMES {
        let files = newest_first(source_files(home, source));
        let total = files.len() as u64;
        let mut readable = 0u64;
        let mut failed = 0u64;
        let existing = {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("Failed to start agent usage transaction: {error}"))?;
            existing_files(&transaction, source)
        };
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut transaction = connection
            .transaction()
            .map_err(|error| format!("Failed to start agent usage transaction: {error}"))?;
        let mut pending = 0usize;

        for (index, (path, (size, mtime_ns))) in files.iter().enumerate() {
            scanned_files += 1;
            let key = file_key(source, path);
            seen.insert(key.clone());
            let stored = existing.get(&key);
            if stored.is_some_and(|(stored_size, stored_mtime, _)| {
                stored_size == size && stored_mtime == mtime_ns
            }) {
                if stored.is_some_and(|(_, _, present)| !*present) {
                    transaction
                        .execute(
                            "UPDATE agent_usage_files SET present = 1 WHERE file_key = ?1",
                            [&key],
                        )
                        .map_err(|error| format!("Failed to update agent usage file: {error}"))?;
                }
                readable += 1;
                continue;
            }
            let mut delta = FileDelta::default();
            match read_usage_file(path, source, &mut delta) {
                Ok(()) => {
                    readable += 1;
                    replace_file_rows(&transaction, source, &key, &delta)?;
                    store_file(&transaction, source, &key, path, *size, *mtime_ns)?;
                    changed_files += 1;
                    pending += 1;
                }
                Err(()) => failed += 1,
            }
            if pending >= SYNC_BATCH_FILES {
                transaction.commit().map_err(|error| {
                    format!("Failed to commit agent usage transaction: {error}")
                })?;
                transaction = connection
                    .transaction()
                    .map_err(|error| format!("Failed to start agent usage transaction: {error}"))?;
                pending = 0;
                progress(AgentUsageSyncProgress {
                    source: (*source).to_string(),
                    scanned: index as u64 + 1,
                    total,
                    finished: false,
                });
            } else if index % 16 == 0 {
                progress(AgentUsageSyncProgress {
                    source: (*source).to_string(),
                    scanned: index as u64 + 1,
                    total,
                    finished: false,
                });
            }
        }

        for key in existing.keys() {
            if !seen.contains(key) {
                transaction
                    .execute(
                        "UPDATE agent_usage_files SET present = 0 WHERE file_key = ?1",
                        [key],
                    )
                    .map_err(|error| format!("Failed to update agent usage file: {error}"))?;
            }
        }

        transaction
            .commit()
            .map_err(|error| format!("Failed to commit agent usage transaction: {error}"))?;

        let previous = previous_sources.get(*source);
        let status = if failed > 0 && readable == 0 {
            "error"
        } else if files.is_empty() {
            previous.map(|meta| meta.status.as_str()).unwrap_or("empty")
        } else {
            "ok"
        };
        let error = if status == "error" {
            "Unable to read local usage records"
        } else {
            ""
        };
        let last_present_at = if files.is_empty() {
            previous.map(|meta| meta.last_present_at).unwrap_or(0)
        } else {
            now_millis()
        };
        save_source(connection, source, last_present_at, status, error)?;
        progress(AgentUsageSyncProgress {
            source: (*source).to_string(),
            scanned: total,
            total,
            finished: true,
        });
    }

    sync_proxy_codex(connection, proxy_database)?;

    let cutoff = (Local::now().date_naive() - Duration::days(HOURLY_RETENTION_DAYS - 1))
        .format("%Y-%m-%d")
        .to_string();
    connection
        .execute("DELETE FROM agent_usage_hourly WHERE day < ?1", [cutoff])
        .map_err(|error| format!("Failed to prune agent usage rows: {error}"))?;

    let last_sync_at = Utc::now().to_rfc3339();
    write_meta(connection, "last_sync_at", &last_sync_at)?;

    Ok(AgentUsageSyncResult {
        skipped: false,
        changed_files,
        scanned_files,
        duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        last_sync_at,
    })
}

pub(crate) fn empty_storage() -> AgentUsageStorage {
    AgentUsageStorage {
        database_size_bytes: 0,
        daily_rows: 0,
        hourly_rows: 0,
        file_rows: 0,
        last_sync_at: String::new(),
    }
}

pub(crate) fn storage(connection: &Connection, path: &Path) -> Result<AgentUsageStorage, String> {
    let count = |table: &str| -> u64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|value| value.max(0) as u64)
            .unwrap_or(0)
    };
    let database_size_bytes = ["", "-wal", "-shm"]
        .iter()
        .filter_map(|suffix| {
            let mut candidate = path.as_os_str().to_owned();
            candidate.push(suffix);
            fs::metadata(PathBuf::from(candidate)).ok()
        })
        .map(|metadata| metadata.len())
        .sum();
    Ok(AgentUsageStorage {
        database_size_bytes,
        daily_rows: count("agent_usage_daily"),
        hourly_rows: count("agent_usage_hourly"),
        file_rows: count("agent_usage_files"),
        last_sync_at: read_meta(connection, "last_sync_at"),
    })
}

pub(crate) fn clear(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "DELETE FROM agent_usage_daily;
             DELETE FROM agent_usage_hourly;
             DELETE FROM agent_usage_files;
             DELETE FROM agent_usage_sources;
             DELETE FROM agent_usage_meta;
             VACUUM;",
        )
        .map_err(|error| format!("Failed to clear agent usage history: {error}"))
}

fn query_rows(connection: &Connection, hourly: bool, start: &str, end: &str) -> Vec<AggregatedRow> {
    let sql = if hourly {
        "SELECT source, day, hour, model, SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens),
                SUM(cache_creation_tokens), SUM(reasoning_tokens), SUM(total_tokens), SUM(samples)
         FROM agent_usage_hourly WHERE day BETWEEN ?1 AND ?2
         GROUP BY source, day, hour, model"
    } else {
        "SELECT source, day, 0, model, SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens),
                SUM(cache_creation_tokens), SUM(reasoning_tokens), SUM(total_tokens), SUM(samples)
         FROM agent_usage_daily WHERE day BETWEEN ?1 AND ?2
         GROUP BY source, day, model"
    };
    let Ok(mut statement) = connection.prepare(sql) else {
        return Vec::new();
    };
    statement
        .query_map(params![start, end], |row| {
            Ok(AggregatedRow {
                source: row.get(0)?,
                day: row.get(1)?,
                hour: row.get::<_, i64>(2)?.clamp(0, 23) as u8,
                model: normalize_model(&row.get::<_, String>(3)?),
                counter: UsageCounter {
                    input_tokens: row.get::<_, i64>(4)?.max(0) as u64,
                    output_tokens: row.get::<_, i64>(5)?.max(0) as u64,
                    cache_read_tokens: row.get::<_, i64>(6)?.max(0) as u64,
                    cache_creation_tokens: row.get::<_, i64>(7)?.max(0) as u64,
                    reasoning_tokens: row.get::<_, i64>(8)?.max(0) as u64,
                    total_tokens: row.get::<_, i64>(9)?.max(0) as u64,
                    cost_usd: 0.0,
                    samples: row.get::<_, i64>(10)?.max(0) as u64,
                },
            })
        })
        .map(|rows| {
            rows.flatten()
                .filter(|row| row.counter.total_tokens > 0)
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_model(value: &str) -> String {
    let tail = crate::usage::normalized_model_tail(value);
    MODEL_ROUTE_PREFIXES
        .iter()
        .find_map(|prefix| tail.strip_prefix(prefix).filter(|rest| !rest.is_empty()))
        .map(str::to_string)
        .unwrap_or(tail)
}

fn parse_day(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

fn bucket_key(day: &str, hour: u8, kind: &str) -> String {
    match kind {
        "hour" => format!("{day}T{hour:02}"),
        "week" => parse_day(day)
            .map(|date| {
                (date - Duration::days(date.weekday().num_days_from_monday() as i64))
                    .format("%Y-%m-%d")
                    .to_string()
            })
            .unwrap_or_else(|| day.to_string()),
        "month" => day.get(..7).unwrap_or(day).to_string(),
        _ => day.to_string(),
    }
}

fn cost_for(counter: &UsageCounter, price: Option<&ModelPrice>) -> f64 {
    let Some(price) = price else {
        return 0.0;
    };
    cost_for_tokens(
        counter,
        price.prompt,
        price.completion,
        price.cache_read,
        price.cache_creation,
    )
}

fn cost_for_tokens(
    counter: &UsageCounter,
    prompt: f64,
    completion: f64,
    cache_read: f64,
    cache_creation: f64,
) -> f64 {
    (counter.input_tokens as f64 * prompt
        + counter.output_tokens as f64 * completion
        + counter.cache_read_tokens as f64 * cache_read
        + counter.cache_creation_tokens as f64 * cache_creation)
        / 1_000_000.0
}

fn add_totals(target: &mut AgentUsageTotals, counter: &UsageCounter, cost: f64) {
    target.input_tokens = target.input_tokens.saturating_add(counter.input_tokens);
    target.output_tokens = target.output_tokens.saturating_add(counter.output_tokens);
    target.cache_read_tokens = target
        .cache_read_tokens
        .saturating_add(counter.cache_read_tokens);
    target.cache_creation_tokens = target
        .cache_creation_tokens
        .saturating_add(counter.cache_creation_tokens);
    target.reasoning_tokens = target
        .reasoning_tokens
        .saturating_add(counter.reasoning_tokens);
    target.total_tokens = target.total_tokens.saturating_add(counter.total_tokens);
    target.samples = target.samples.saturating_add(counter.samples);
    target.cost_usd += cost;
}

fn bucket_row(bucket: &str, counter: &UsageCounter, cost: f64) -> AgentUsageBucket {
    AgentUsageBucket {
        bucket: bucket.to_string(),
        input_tokens: counter.input_tokens,
        output_tokens: counter.output_tokens,
        cache_creation_tokens: counter.cache_creation_tokens,
        cache_read_tokens: counter.cache_read_tokens,
        reasoning_tokens: counter.reasoning_tokens,
        total_tokens: counter.total_tokens,
        cost_usd: cost,
        samples: counter.samples,
    }
}

struct Window {
    start: NaiveDate,
    end: NaiveDate,
    hours: Option<BTreeSet<(String, u8)>>,
    hourly: bool,
}

impl Window {
    fn rows(&self, connection: &Connection) -> Vec<AggregatedRow> {
        let rows = query_rows(
            connection,
            self.hourly,
            &self.start.format("%Y-%m-%d").to_string(),
            &self.end.format("%Y-%m-%d").to_string(),
        );
        match &self.hours {
            Some(hours) => rows
                .into_iter()
                .filter(|row| hours.contains(&(row.day.clone(), row.hour)))
                .collect(),
            None => rows,
        }
    }

    fn buckets(&self, kind: &str) -> Vec<String> {
        let mut keys = BTreeSet::new();
        if let Some(hours) = &self.hours {
            for (day, hour) in hours {
                keys.insert(bucket_key(day, *hour, kind));
            }
            return keys.into_iter().collect();
        }
        let now = Local::now();
        let mut date = self.start;
        while date <= self.end {
            let day = date.format("%Y-%m-%d").to_string();
            if kind == "hour" {
                let last = if date == now.date_naive() {
                    now.hour() as u8
                } else {
                    23
                };
                for hour in 0..=last {
                    keys.insert(bucket_key(&day, hour, kind));
                }
            } else {
                keys.insert(bucket_key(&day, 0, kind));
            }
            date += Duration::days(1);
        }
        keys.into_iter().collect()
    }
}

fn hours_back(now: DateTime<Local>, from: i64, count: i64) -> BTreeSet<(String, u8)> {
    (from..from + count)
        .map(|offset| {
            let time = now - Duration::hours(offset);
            (time.format("%Y-%m-%d").to_string(), time.hour() as u8)
        })
        .collect()
}

fn hours_of_day(date: NaiveDate, last: u32) -> BTreeSet<(String, u8)> {
    let day = date.format("%Y-%m-%d").to_string();
    (0..=last).map(|hour| (day.clone(), hour as u8)).collect()
}

fn earliest_day(connection: &Connection) -> Option<NaiveDate> {
    connection
        .query_row("SELECT MIN(day) FROM agent_usage_daily", [], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()
        .ok()
        .flatten()
        .flatten()
        .and_then(|value| parse_day(&value))
}

fn resolve_kind(range: &str, granularity: &str, span_days: i64) -> &'static str {
    let hour_allowed = range != "all";
    match granularity {
        "hour" if hour_allowed => "hour",
        "hour" | "day" => "day",
        "week" => "week",
        "month" => "month",
        _ => match range {
            "today" | "24h" => "hour",
            "all" if span_days > 92 => "week",
            _ => "day",
        },
    }
}

fn resolve_windows(
    connection: &Connection,
    query: &AgentUsageQuery,
) -> (Window, Option<Window>, &'static str) {
    let now = Local::now();
    let today = now.date_naive();
    let days = |count: i64, offset: i64, hourly: bool| Window {
        start: today - Duration::days(offset + count - 1),
        end: today - Duration::days(offset),
        hours: None,
        hourly,
    };
    match query.range.as_str() {
        "today" => {
            let kind = resolve_kind("today", &query.granularity, 1);
            let yesterday = today - Duration::days(1);
            (
                Window {
                    start: today,
                    end: today,
                    hours: Some(hours_of_day(today, now.hour())),
                    hourly: true,
                },
                Some(Window {
                    start: yesterday,
                    end: yesterday,
                    hours: Some(hours_of_day(yesterday, now.hour())),
                    hourly: true,
                }),
                kind,
            )
        }
        "24h" => {
            let kind = resolve_kind("24h", &query.granularity, 1);
            (
                Window {
                    start: today - Duration::days(1),
                    end: today,
                    hours: Some(hours_back(now, 0, 24)),
                    hourly: true,
                },
                Some(Window {
                    start: today - Duration::days(2),
                    end: today - Duration::days(1),
                    hours: Some(hours_back(now, 24, 24)),
                    hourly: true,
                }),
                kind,
            )
        }
        "7d" | "30d" => {
            let count = if query.range == "7d" { 7 } else { 30 };
            let kind = resolve_kind(&query.range, &query.granularity, count);
            let hourly = kind == "hour";
            (
                days(count, 0, hourly),
                Some(days(count, count, false)),
                kind,
            )
        }
        _ => {
            let start = earliest_day(connection).unwrap_or(today).min(today);
            let span = (today - start).num_days() + 1;
            let kind = resolve_kind("all", &query.granularity, span);
            (
                Window {
                    start,
                    end: today,
                    hours: None,
                    hourly: false,
                },
                None,
                kind,
            )
        }
    }
}

fn add_counter(target: &mut UsageCounter, counter: &UsageCounter, cost: f64) {
    target.input_tokens = target.input_tokens.saturating_add(counter.input_tokens);
    target.output_tokens = target.output_tokens.saturating_add(counter.output_tokens);
    target.cache_read_tokens = target
        .cache_read_tokens
        .saturating_add(counter.cache_read_tokens);
    target.cache_creation_tokens = target
        .cache_creation_tokens
        .saturating_add(counter.cache_creation_tokens);
    target.reasoning_tokens = target
        .reasoning_tokens
        .saturating_add(counter.reasoning_tokens);
    target.total_tokens = target.total_tokens.saturating_add(counter.total_tokens);
    target.samples = target.samples.saturating_add(counter.samples);
    target.cost_usd += cost;
}

pub(crate) fn report(
    connection: &Connection,
    query: &AgentUsageQuery,
) -> Result<AgentUsageReport, String> {
    let prices = load_agent_usage_prices();
    let mut price_cache: HashMap<String, Option<ModelPrice>> = HashMap::new();
    let mut price_of = |model: &str| -> Option<ModelPrice> {
        price_cache
            .entry(model.to_string())
            .or_insert_with(|| resolve_agent_usage_price(&prices, model).cloned())
            .clone()
    };
    let (window, previous_window, kind) = resolve_windows(connection, query);
    let selected: BTreeSet<&str> = query
        .sources
        .iter()
        .map(String::as_str)
        .filter(|source| !source.is_empty())
        .collect();
    let included = |source: &str| selected.is_empty() || selected.contains(source);
    let all_rows = window.rows(connection);
    let source_meta = load_sources(connection);
    let group_by_model = query.group_by == "model";

    let mut totals = AgentUsageTotals::default();
    let mut days: BTreeSet<String> = BTreeSet::new();
    let mut source_totals: BTreeMap<String, AgentUsageTotals> = BTreeMap::new();
    let mut source_days: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut source_buckets: BTreeMap<String, BTreeMap<String, UsageCounter>> = BTreeMap::new();
    let mut timeline: BTreeMap<String, UsageCounter> = window
        .buckets(kind)
        .into_iter()
        .map(|bucket| (bucket, UsageCounter::default()))
        .collect();
    let mut model_totals: BTreeMap<(String, String), (UsageCounter, BTreeSet<String>)> =
        BTreeMap::new();

    for row in &all_rows {
        let price = price_of(&row.model);
        let cost = cost_for(&row.counter, price.as_ref());
        add_totals(
            source_totals.entry(row.source.clone()).or_default(),
            &row.counter,
            cost,
        );
        source_days
            .entry(row.source.clone())
            .or_default()
            .insert(row.day.clone());
        if !included(&row.source) {
            continue;
        }
        let bucket = bucket_key(&row.day, row.hour, kind);
        add_totals(&mut totals, &row.counter, cost);
        days.insert(row.day.clone());
        let group_key = if group_by_model {
            format!("{}|{}", bucket, row.model)
        } else {
            bucket.clone()
        };
        add_counter(
            source_buckets
                .entry(row.source.clone())
                .or_default()
                .entry(group_key)
                .or_default(),
            &row.counter,
            cost,
        );
        add_counter(timeline.entry(bucket).or_default(), &row.counter, cost);
        let model = model_totals
            .entry((row.source.clone(), row.model.clone()))
            .or_default();
        add_counter(&mut model.0, &row.counter, cost);
        model.1.insert(row.day.clone());
    }
    totals.days = days.len() as u64;

    let previous = previous_window.map(|window| {
        let mut period = AgentUsagePeriodTotals::default();
        for row in window.rows(connection) {
            if included(&row.source) {
                let price = price_of(&row.model);
                period.total_tokens = period.total_tokens.saturating_add(row.counter.total_tokens);
                period.cost_usd += cost_for(&row.counter, price.as_ref());
            }
        }
        period
    });

    let today = Local::now().date_naive();
    let day_text = |day: NaiveDate| day.format("%Y-%m-%d").to_string();
    let mut calendar: BTreeMap<String, (u64, f64)> = BTreeMap::new();
    let calendar_start = earliest_day(connection).unwrap_or(today).min(today);
    for row in query_rows(
        connection,
        false,
        &day_text(calendar_start),
        &day_text(today),
    )
    .iter()
    .filter(|row| included(&row.source))
    {
        let price = price_of(&row.model);
        let day = calendar.entry(row.day.clone()).or_default();
        day.0 = day.0.saturating_add(row.counter.total_tokens);
        day.1 += cost_for(&row.counter, price.as_ref());
    }
    let hourly_start = today - Duration::days(HOURLY_RETENTION_DAYS - 1);
    let hourly_rows = query_rows(connection, true, &day_text(hourly_start), &day_text(today));
    let mut cells: BTreeMap<(u8, u8), (u64, u64)> = BTreeMap::new();
    for row in hourly_rows.iter().filter(|row| included(&row.source)) {
        let Some(date) = parse_day(&row.day) else {
            continue;
        };
        let cell = cells
            .entry((date.weekday().num_days_from_monday() as u8, row.hour))
            .or_default();
        cell.0 = cell.0.saturating_add(row.counter.total_tokens);
        cell.1 = cell.1.saturating_add(row.counter.samples);
    }
    let hourly = cells
        .into_iter()
        .map(
            |((weekday, hour), (total_tokens, samples))| AgentUsageHourRow {
                weekday,
                hour,
                total_tokens,
                samples,
            },
        )
        .collect();

    let sources = SOURCE_NAMES
        .iter()
        .map(|source| {
            let meta = source_meta.get(*source);
            let has_rows = source_totals.contains_key(*source);
            let status = if has_rows {
                match meta {
                    Some(meta) if meta.last_present_at < meta.last_scan_at => "archived",
                    _ => "ok",
                }
            } else if meta.is_some_and(|meta| meta.status == "error") {
                "error"
            } else if meta.is_some_and(|meta| {
                meta.last_present_at > 0 && meta.last_present_at < meta.last_scan_at
            }) {
                "archived"
            } else if meta.is_some_and(|meta| meta.last_present_at > 0) {
                "ok"
            } else {
                "empty"
            };
            let archived_at = if status == "archived" {
                meta.map(|meta| millis_to_rfc3339(meta.last_present_at))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            let error = if status == "error" {
                meta.map(|meta| meta.error.clone()).unwrap_or_default()
            } else {
                String::new()
            };
            let mut models: Vec<AgentUsageModelRow> = model_totals
                .iter()
                .filter(|((row_source, _), _)| row_source == source)
                .map(|((_, model), (counter, model_days))| {
                    let price = price_of(model);
                    AgentUsageModelRow {
                        model: model.clone(),
                        input_tokens: counter.input_tokens,
                        output_tokens: counter.output_tokens,
                        cache_creation_tokens: counter.cache_creation_tokens,
                        cache_read_tokens: counter.cache_read_tokens,
                        reasoning_tokens: counter.reasoning_tokens,
                        total_tokens: counter.total_tokens,
                        cost_usd: counter.cost_usd,
                        priced: price.is_some(),
                        prompt: price.as_ref().map(|price| price.prompt),
                        completion: price.as_ref().map(|price| price.completion),
                        cache_read: price.as_ref().map(|price| price.cache_read),
                        cache_creation: price.as_ref().map(|price| price.cache_creation),
                        days: model_days.len() as u64,
                    }
                })
                .collect();
            models.sort_by(|left, right| {
                right
                    .total_tokens
                    .cmp(&left.total_tokens)
                    .then_with(|| left.model.cmp(&right.model))
            });
            let series = source_buckets
                .remove(*source)
                .map(|buckets| {
                    buckets
                        .into_iter()
                        .map(|(bucket, counter)| bucket_row(&bucket, &counter, counter.cost_usd))
                        .collect()
                })
                .unwrap_or_default();
            let mut totals = source_totals.remove(*source).unwrap_or_default();
            totals.days = source_days
                .get(*source)
                .map(|days| days.len() as u64)
                .unwrap_or(0);
            AgentUsageSource {
                source: (*source).to_string(),
                status: status.to_string(),
                archived_at,
                error,
                totals,
                models,
                series,
            }
        })
        .collect();

    Ok(AgentUsageReport {
        schema_version: 2,
        generated_at: Utc::now().to_rfc3339(),
        last_sync_at: read_meta(connection, "last_sync_at"),
        syncing: false,
        bucket: kind.to_string(),
        range_start: window.start.format("%Y-%m-%d").to_string(),
        range_end: window.end.format("%Y-%m-%d").to_string(),
        totals,
        previous,
        sources,
        timeline: timeline
            .into_iter()
            .map(|(bucket, counter)| bucket_row(&bucket, &counter, counter.cost_usd))
            .collect(),
        calendar: calendar
            .into_iter()
            .map(|(date, (total_tokens, cost_usd))| AgentUsageCalendarRow {
                date,
                total_tokens,
                cost_usd,
            })
            .collect(),
        hourly,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;
    use std::io::Write;

    fn test_root(name: &str) -> PathBuf {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("cpa-agent-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn local_timestamp(year: i32, month: u32, day: u32, hour: u32) -> String {
        Local
            .with_ymd_and_hms(year, month, day, hour, 0, 0)
            .unwrap()
            .to_rfc3339()
    }

    fn write_sample(path: &Path, input: u64, output: u64) {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        let timestamp = local_timestamp(2026, 10, 29, 12);
        writeln!(
            file,
            "{}",
            json!({"timestamp": timestamp, "model": "model-a",
                "usage": {"input": input, "output": output}})
        )
        .unwrap();
    }

    fn session_path(root: &Path) -> PathBuf {
        root.join("home/.pi/agent/sessions/session.jsonl")
    }

    fn query(range: &str) -> AgentUsageQuery {
        AgentUsageQuery {
            range: range.to_string(),
            sources: Vec::new(),
            group_by: String::new(),
            granularity: String::new(),
        }
    }

    #[test]
    fn syncs_only_changed_files_and_replaces_their_rows() {
        let root = test_root("incremental");
        let home = root.join("home");
        let session = session_path(&root);
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        write_sample(&session, 100, 10);

        let mut connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        let first = sync(&mut connection, &home, None, |_| {}).unwrap();
        assert_eq!(first.changed_files, 1);

        let second = sync(&mut connection, &home, None, |_| {}).unwrap();
        assert_eq!(second.changed_files, 0);

        write_sample(&session, 5, 1);
        let third = sync(&mut connection, &home, None, |_| {}).unwrap();
        assert_eq!(third.changed_files, 1);

        let report = report(&connection, &query("all")).unwrap();
        let pi = report
            .sources
            .iter()
            .find(|source| source.source == "pi")
            .unwrap();
        assert_eq!(pi.status, "ok");
        assert_eq!(pi.totals.input_tokens, 105);
        assert_eq!(pi.totals.output_tokens, 11);
        assert_eq!(pi.totals.samples, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_history_and_marks_the_source_archived_after_files_disappear() {
        let root = test_root("archived");
        let home = root.join("home");
        let session = session_path(&root);
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        write_sample(&session, 40, 4);

        let mut connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        sync(&mut connection, &home, None, |_| {}).unwrap();
        fs::remove_dir_all(session.parent().unwrap()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        sync(&mut connection, &home, None, |_| {}).unwrap();

        let report = report(&connection, &query("all")).unwrap();
        let pi = report
            .sources
            .iter()
            .find(|source| source.source == "pi")
            .unwrap();
        assert_eq!(pi.status, "archived");
        assert!(!pi.archived_at.is_empty());
        assert_eq!(pi.totals.total_tokens, 44);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prunes_hourly_rows_beyond_the_retention_window() {
        let root = test_root("retention");
        let home = root.join("home");
        let mut connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        let old_day = (Local::now().date_naive() - Duration::days(HOURLY_RETENTION_DAYS + 1))
            .format("%Y-%m-%d")
            .to_string();
        connection
            .execute(
                "INSERT INTO agent_usage_hourly (file_key, source, day, hour, model, input_tokens,
                    output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                    total_tokens, samples) VALUES ('x', 'pi', ?1, 3, 'm', 1, 1, 0, 0, 0, 2, 1)",
                [&old_day],
            )
            .unwrap();
        sync(&mut connection, &home, None, |_| {}).unwrap();
        let remaining: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM agent_usage_hourly WHERE day = ?1",
                [&old_day],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn buckets_long_ranges_and_filters_by_source() {
        let root = test_root("buckets");
        let mut connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        let today = Local::now().date_naive();
        for offset in [0, 40] {
            let day = (today - Duration::days(offset))
                .format("%Y-%m-%d")
                .to_string();
            connection
                .execute(
                    "INSERT INTO agent_usage_daily (file_key, source, day, model, input_tokens,
                        output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                        total_tokens, samples) VALUES ('x', 'pi', ?1, 'm', 10, 5, 0, 0, 0, 15, 1)",
                    [&day],
                )
                .unwrap();
        }
        let daily = report(&connection, &query("30d")).unwrap();
        assert_eq!(daily.bucket, "day");
        assert_eq!(daily.totals.total_tokens, 15);

        let all = report(&connection, &query("all")).unwrap();
        assert_eq!(all.bucket, "day");
        assert_eq!(all.totals.total_tokens, 30);
        assert_eq!(all.timeline.len(), 41);

        let mut filtered = query("all");
        filtered.sources = vec!["codex".to_string()];
        assert_eq!(
            report(&connection, &filtered).unwrap().totals.total_tokens,
            0
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn returns_the_hourly_grid_for_day_ranges_within_retention() {
        let root = test_root("hourly-grid");
        let mut connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        let today = Local::now().date_naive();
        let day = today.format("%Y-%m-%d").to_string();
        for hour in [9, 10] {
            connection
                .execute(
                    "INSERT INTO agent_usage_hourly (file_key, source, day, hour, model, input_tokens,
                        output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                        total_tokens, samples) VALUES ('x', 'pi', ?1, ?2, 'm', 10, 5, 0, 0, 0, 15, 1)",
                    params![day, hour],
                )
                .unwrap();
        }
        let report = report(&connection, &query("7d")).unwrap();
        let weekday = today.weekday().num_days_from_monday() as u8;
        assert!(report
            .hourly
            .iter()
            .any(|row| row.weekday == weekday && row.hour == 9 && row.total_tokens == 15));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn activity_views_cover_full_history_regardless_of_range() {
        let root = test_root("activity-history");
        let connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        let today = Local::now().date_naive();
        let old_day = (today - Duration::days(200)).format("%Y-%m-%d").to_string();
        let recent = today - Duration::days(10);
        insert_daily(&connection, "f1", "pi", &old_day, 40);
        insert_daily(
            &connection,
            "f2",
            "pi",
            &recent.format("%Y-%m-%d").to_string(),
            15,
        );
        connection
            .execute(
                "INSERT INTO agent_usage_hourly (file_key, source, day, hour, model, input_tokens,
                    output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                    total_tokens, samples) VALUES ('f2', 'pi', ?1, 9, 'm', 10, 5, 0, 0, 0, 15, 1)",
                params![recent.format("%Y-%m-%d").to_string()],
            )
            .unwrap();
        let today_report = report(&connection, &query("today")).unwrap();
        assert_eq!(today_report.totals.total_tokens, 0);
        assert_eq!(
            today_report
                .calendar
                .iter()
                .map(|row| (row.date.clone(), row.total_tokens))
                .collect::<Vec<_>>(),
            vec![
                (old_day.clone(), 40),
                (recent.format("%Y-%m-%d").to_string(), 15)
            ]
        );
        let weekday = recent.weekday().num_days_from_monday() as u8;
        assert!(today_report
            .hourly
            .iter()
            .any(|row| row.weekday == weekday && row.hour == 9 && row.total_tokens == 15));
        let mut other = query("today");
        other.sources = vec!["codex".to_string()];
        let filtered = report(&connection, &other).unwrap();
        assert!(filtered.calendar.is_empty());
        assert!(filtered.hourly.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    fn insert_daily(connection: &Connection, key: &str, source: &str, day: &str, tokens: i64) {
        connection
            .execute(
                "INSERT INTO agent_usage_daily (file_key, source, day, model, input_tokens,
                    output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                    total_tokens, samples) VALUES (?1, ?2, ?3, 'm', ?4, 5, 0, 0, 0, ?4, 1)",
                params![key, source, day, tokens],
            )
            .unwrap();
    }

    #[test]
    fn serializes_cost_with_the_cost_usd_key() {
        let root = test_root("serde-cost");
        let connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        insert_daily(&connection, "f1", "pi", "2026-10-29", 15);
        let json = serde_json::to_value(report(&connection, &query("all")).unwrap()).unwrap();
        assert!(json["totals"].get("costUSD").is_some());
        assert!(json["timeline"][0].get("costUSD").is_some());
        assert!(json["calendar"][0].get("costUSD").is_some());
        let pi = json["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|source| source["source"] == "pi")
            .unwrap();
        assert!(pi["totals"].get("costUSD").is_some());
        assert!(pi["models"][0].get("costUSD").is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn charges_net_input_tokens_without_subtracting_cache_again() {
        let counter = UsageCounter {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_tokens: 1_000_000,
            cache_creation_tokens: 1_000_000,
            ..UsageCounter::default()
        };
        let cost = cost_for_tokens(&counter, 1.0, 2.0, 0.5, 0.25);
        assert!((cost - 3.75).abs() < 1e-9);
    }

    #[test]
    fn reports_distinct_days_per_source() {
        let root = test_root("source-days");
        let connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        for (index, day) in ["2026-10-28", "2026-10-29", "2026-10-29"]
            .iter()
            .enumerate()
        {
            insert_daily(&connection, &format!("f{index}"), "pi", day, 10);
        }
        let report = report(&connection, &query("all")).unwrap();
        let pi = report
            .sources
            .iter()
            .find(|source| source.source == "pi")
            .unwrap();
        assert_eq!(pi.totals.days, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_the_timeline_day_level_when_grouping_by_model() {
        let root = test_root("grouped-timeline");
        let connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        for (index, day) in ["2026-10-28", "2026-10-29"].iter().enumerate() {
            insert_daily(&connection, &format!("f{index}"), "pi", day, 10);
        }
        let mut grouped = query("30d");
        grouped.group_by = "model".to_string();
        let report = report(&connection, &grouped).unwrap();
        assert_eq!(report.timeline.len(), 30);
        assert_eq!(
            report
                .timeline
                .iter()
                .filter(|row| row.total_tokens > 0)
                .count(),
            2
        );
        assert!(report.timeline.iter().all(|row| !row.bucket.contains('|')));
        assert!(report
            .sources
            .iter()
            .flat_map(|source| &source.series)
            .any(|row| row.bucket.contains('|')));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restores_the_present_flag_for_files_that_reappear() {
        let root = test_root("present-flag");
        let home = root.join("home");
        let session = session_path(&root);
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        write_sample(&session, 10, 1);
        let mut connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        sync(&mut connection, &home, None, |_| {}).unwrap();
        connection
            .execute("UPDATE agent_usage_files SET present = 0", [])
            .unwrap();
        sync(&mut connection, &home, None, |_| {}).unwrap();
        let present: i64 = connection
            .query_row(
                "SELECT present FROM agent_usage_files WHERE source = 'pi'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(present, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clears_every_stored_row() {
        let root = test_root("clear");
        let connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        connection
            .execute(
                "INSERT INTO agent_usage_daily (file_key, source, day, model, input_tokens,
                    output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                    total_tokens, samples) VALUES ('x', 'pi', '2026-10-29', 'm', 1, 1, 0, 0, 0, 2, 1)",
                [],
            )
            .unwrap();
        clear(&connection).unwrap();
        let storage = storage(&connection, &root.join("agent_usage.db")).unwrap();
        assert_eq!(storage.daily_rows, 0);
        assert_eq!(storage.file_rows, 0);
        fs::remove_dir_all(root).unwrap();
    }

    fn insert_model_row(
        connection: &Connection,
        key: &str,
        source: &str,
        day: &str,
        model: &str,
        tokens: i64,
    ) {
        connection
            .execute(
                "INSERT INTO agent_usage_daily (file_key, source, day, model, input_tokens,
                    output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
                    total_tokens, samples) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 0, 0, ?5, 1)",
                params![key, source, day, model, tokens],
            )
            .unwrap();
    }

    fn day_offset(offset: i64) -> String {
        (Local::now().date_naive() - Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string()
    }

    #[test]
    fn merges_model_name_variants_and_drops_empty_models() {
        let root = test_root("model-names");
        let connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        let today = day_offset(0);
        insert_model_row(&connection, "f1", "pi", &today, "deepseek-v4.1-flash", 10);
        insert_model_row(&connection, "f2", "pi", &today, "DeepSeek-V4.1-Flash", 20);
        insert_model_row(
            &connection,
            "f3",
            "pi",
            &today,
            "workbuddyglobal-deepseek-v4.1-flash",
            30,
        );
        insert_model_row(&connection, "f4", "pi", &today, "qwen/Qwen3.8-27b", 5);
        insert_model_row(&connection, "f5", "claude", &today, "<synthetic>", 0);
        let report = report(&connection, &query("7d")).unwrap();
        let models: Vec<(String, u64)> = report
            .sources
            .iter()
            .flat_map(|source| {
                source
                    .models
                    .iter()
                    .map(|model| (model.model.clone(), model.total_tokens))
            })
            .collect();
        assert_eq!(
            models,
            vec![
                ("deepseek-v4.1-flash".to_string(), 60),
                ("qwen3.8-27b".to_string(), 5)
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn counts_active_days_and_keeps_empty_buckets() {
        let root = test_root("active-days");
        let connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        insert_daily(&connection, "f1", "pi", &day_offset(0), 10);
        insert_daily(&connection, "f2", "codex", &day_offset(0), 10);
        insert_daily(&connection, "f3", "pi", &day_offset(3), 10);
        let report = report(&connection, &query("7d")).unwrap();
        assert_eq!(report.totals.days, 2);
        assert_eq!(report.timeline.len(), 7);
        assert_eq!(
            report
                .timeline
                .iter()
                .filter(|row| row.total_tokens == 0)
                .count(),
            5
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn applies_the_requested_granularity_to_any_range() {
        let root = test_root("granularity");
        let connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        insert_daily(&connection, "f1", "pi", &day_offset(0), 10);
        insert_daily(&connection, "f2", "pi", &day_offset(200), 10);
        let mut all_days = query("all");
        all_days.granularity = "day".to_string();
        let report_days = report(&connection, &all_days).unwrap();
        assert_eq!(report_days.bucket, "day");
        assert_eq!(report_days.timeline.len(), 201);
        let mut all_hours = query("all");
        all_hours.granularity = "hour".to_string();
        assert_eq!(report(&connection, &all_hours).unwrap().bucket, "day");
        let mut monthly = query("30d");
        monthly.granularity = "month".to_string();
        let report_months = report(&connection, &monthly).unwrap();
        assert_eq!(report_months.bucket, "month");
        assert!(report_months
            .timeline
            .iter()
            .all(|row| row.bucket.len() == 7));
        let mut hourly = query("7d");
        hourly.granularity = "hour".to_string();
        let report_hours = report(&connection, &hourly).unwrap();
        assert_eq!(report_hours.bucket, "hour");
        assert_eq!(
            report_hours.timeline.len() as u32,
            6 * 24 + Local::now().hour() + 1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn filters_by_several_sources_and_reports_the_previous_period() {
        let root = test_root("multi-source");
        let connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        insert_daily(&connection, "f1", "pi", &day_offset(0), 10);
        insert_daily(&connection, "f2", "codex", &day_offset(1), 20);
        insert_daily(&connection, "f3", "claude", &day_offset(2), 40);
        insert_daily(&connection, "f4", "pi", &day_offset(8), 7);
        let mut selected = query("7d");
        selected.sources = vec!["pi".to_string(), "codex".to_string()];
        let report = report(&connection, &selected).unwrap();
        assert_eq!(report.totals.total_tokens, 30);
        assert_eq!(report.previous.as_ref().unwrap().total_tokens, 7);
        let claude = report
            .sources
            .iter()
            .find(|source| source.source == "claude")
            .unwrap();
        assert_eq!(claude.totals.total_tokens, 40);
        assert!(claude.models.is_empty());
        assert!(report_all_previous_is_none(&connection));
        fs::remove_dir_all(root).unwrap();
    }

    fn report_all_previous_is_none(connection: &Connection) -> bool {
        report(connection, &query("all"))
            .unwrap()
            .previous
            .is_none()
    }

    #[test]
    fn does_not_double_count_codex_sessions_moved_to_the_archive() {
        let root = test_root("codex-move");
        let home = root.join("home");
        let active = home.join(".codex/sessions/2026/10/29/rollout-a.jsonl");
        fs::create_dir_all(active.parent().unwrap()).unwrap();
        let timestamp = local_timestamp(2026, 10, 29, 12);
        fs::write(
            &active,
            format!(
                "{}\n",
                json!({"timestamp": timestamp, "type": "event_msg", "payload": {"type": "token_count",
                    "info": {"last_token_usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}}})
            ),
        )
        .unwrap();
        let mut connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        sync(&mut connection, &home, None, |_| {}).unwrap();
        let before = report(&connection, &query("all"))
            .unwrap()
            .totals
            .total_tokens;
        assert!(before > 0);
        let archived = home.join(".codex/archived_sessions/rollout-a.jsonl");
        fs::create_dir_all(archived.parent().unwrap()).unwrap();
        fs::rename(&active, &archived).unwrap();
        sync(&mut connection, &home, None, |_| {}).unwrap();
        assert_eq!(
            report(&connection, &query("all"))
                .unwrap()
                .totals
                .total_tokens,
            before
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resyncs_sqlite_sources_when_only_the_wal_grows() {
        let root = test_root("sqlite-wal");
        let home = root.join("home");
        let database = home.join(".local/share/opencode/opencode.db");
        fs::create_dir_all(database.parent().unwrap()).unwrap();
        let writer = Connection::open(&database).unwrap();
        writer
            .execute_batch(
                "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
                 CREATE TABLE message (data TEXT NOT NULL);",
            )
            .unwrap();
        let created = Local
            .with_ymd_and_hms(2026, 10, 29, 12, 0, 0)
            .unwrap()
            .timestamp_millis();
        let insert = |input: u64| {
            let value = json!({"modelID": "model", "time": {"created": created},
                "tokens": {"input": input, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}}});
            writer
                .execute("INSERT INTO message VALUES (?1)", [value.to_string()])
                .unwrap();
        };
        insert(10);
        let mut connection = open_store_at(&root.join("agent_usage.db")).unwrap();
        sync(&mut connection, &home, None, |_| {}).unwrap();
        assert_eq!(
            report(&connection, &query("all"))
                .unwrap()
                .totals
                .total_tokens,
            11
        );
        let main_size = fs::metadata(&database).unwrap().len();
        insert(20);
        assert_eq!(fs::metadata(&database).unwrap().len(), main_size);
        let second = sync(&mut connection, &home, None, |_| {}).unwrap();
        assert_eq!(second.changed_files, 1);
        assert_eq!(
            report(&connection, &query("all"))
                .unwrap()
                .totals
                .total_tokens,
            32
        );
        drop(writer);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_the_newest_files_first() {
        let root = test_root("newest-first");
        let older = root.join("older.jsonl");
        let newer = root.join("newer.jsonl");
        fs::write(&older, "{}\n").unwrap();
        fs::write(&newer, "{}\n").unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&older)
            .unwrap()
            .set_modified(past)
            .unwrap();
        let ordered = newest_first(vec![older.clone(), newer.clone()]);
        assert_eq!(
            ordered
                .iter()
                .map(|(path, _)| path.clone())
                .collect::<Vec<_>>(),
            vec![newer, older]
        );
        fs::remove_dir_all(root).unwrap();
    }
}
