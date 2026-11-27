mod antigravity;
mod claude;
mod codebuddy;
mod codex;
mod copilot;
mod dsh;
mod gemini;
mod grokbuild;
mod kimi;
mod mcode;
mod opencode;
mod pi;
mod workbuddy;
mod zcode;
mod zstd_frames;

use chrono::{DateTime, Local, NaiveDate, TimeZone, Timelike};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use crate::agent_usage_store::{
    self, AgentUsageQuery, AgentUsageReport, AgentUsageStorage, AgentUsageSyncResult,
};

pub(super) const MAX_SCAN_FILES: usize = 20_000;
pub(super) const MAX_JSON_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const MAX_JSON_LINE_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_MODEL_NAME_CHARS: usize = 120;
const MAX_WALK_DEPTH: usize = 16;

const SYNC_PROGRESS_EVENT: &str = "agent-usage-sync-progress";
const SYNCED_EVENT: &str = "agent-usage-synced";
const SYNC_INTERVAL_PREFERENCE: &str = "cpa-gui.usage-agent-refresh-interval.v1";
const BACKGROUND_SYNC_INTERVALS: [i64; 5] = [0, 300_000, 900_000, 1_800_000, 3_600_000];
const DEFAULT_BACKGROUND_SYNC_INTERVAL: i64 = 300_000;
const BACKGROUND_SYNC_STARTUP_DELAY_SECS: u64 = 20;
const BACKGROUND_SYNC_TICK_SECS: u64 = 60;

pub(crate) const SOURCE_NAMES: &[&str] = &[
    "claude",
    "codex",
    "mcode",
    "opencode",
    "omp",
    "pi",
    "copilot",
    "gemini",
    "antigravity",
    "kimi",
    "workbuddy",
    "codebuddy",
    "dsh",
    "grokbuild",
    "zcode",
];

#[derive(Debug, Default, Clone)]
pub(crate) struct UsageCounter {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cache_creation_tokens: u64,
    pub(crate) cache_creation_1h_tokens: u64,
    pub(crate) cache_read_tokens: u64,
    pub(crate) reasoning_tokens: u64,
    pub(crate) total_tokens: u64,
    pub(crate) cost_usd: f64,
    pub(crate) reported_cost_usd: f64,
    pub(crate) reported_samples: u64,
    pub(crate) samples: u64,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct FileDelta {
    pub(crate) daily: BTreeMap<(String, String), UsageCounter>,
    pub(crate) hourly: BTreeMap<(String, u8, String), UsageCounter>,
    pub(crate) claimed_ids: Vec<String>,
}

#[derive(Default)]
pub(crate) struct SourceSyncContext {
    codex_index: Option<codex::CodexSourceIndex>,
    pi_known_files: HashSet<PathBuf>,
    pub(crate) seen_ids: HashSet<String>,
}

#[derive(Default)]
pub(crate) struct AgentUsageState {
    syncing: AtomicBool,
    last_sync_millis: AtomicI64,
}

struct SyncGuard<'a>(&'a AtomicBool);

impl<'a> SyncGuard<'a> {
    fn acquire(flag: &'a AtomicBool) -> Option<Self> {
        (!flag.swap(true, Ordering::SeqCst)).then_some(Self(flag))
    }
}

impl Drop for SyncGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn background_interval_millis(preferences: &BTreeMap<String, String>) -> i64 {
    preferences
        .get(SYNC_INTERVAL_PREFERENCE)
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| BACKGROUND_SYNC_INTERVALS.contains(value))
        .unwrap_or(DEFAULT_BACKGROUND_SYNC_INTERVAL)
}

fn sync_due(last_sync_millis: i64, interval_millis: i64, now_millis: i64) -> bool {
    interval_millis > 0
        && (last_sync_millis <= 0 || now_millis.saturating_sub(last_sync_millis) >= interval_millis)
}

fn now_millis() -> i64 {
    Local::now().timestamp_millis()
}

fn run_sync(app: &crate::runtime::AppHandle) -> Result<AgentUsageSyncResult, String> {
    let state = app.state::<AgentUsageState>();
    let Some(_guard) = SyncGuard::acquire(&state.syncing) else {
        return Ok(AgentUsageSyncResult {
            skipped: true,
            ..AgentUsageSyncResult::default()
        });
    };
    let outcome = sync_store(app);
    if outcome.is_ok() {
        state.last_sync_millis.store(now_millis(), Ordering::SeqCst);
    }
    let _ = app.emit_to("main", SYNCED_EVENT, outcome.as_ref().ok());
    outcome
}

fn sync_store(app: &crate::runtime::AppHandle) -> Result<AgentUsageSyncResult, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;
    let proxy_database = crate::usage::usage_database_path().ok();
    let mut connection = agent_usage_store::open_store()?;
    agent_usage_store::sync(
        &mut connection,
        &home,
        proxy_database.as_deref(),
        |progress| {
            if app.host().is_ui_active() {
                let _ = app.emit_to("main", SYNC_PROGRESS_EVENT, progress);
            }
        },
    )
}

pub(crate) fn start_background_sync(app: crate::runtime::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(
            BACKGROUND_SYNC_STARTUP_DELAY_SECS,
        ));
        loop {
            let interval = crate::app_settings::get_usage_view_preferences()
                .map(|preferences| background_interval_millis(&preferences))
                .unwrap_or(DEFAULT_BACKGROUND_SYNC_INTERVAL);
            let last = app
                .state::<AgentUsageState>()
                .last_sync_millis
                .load(Ordering::SeqCst);
            if sync_due(last, interval, now_millis()) {
                if let Err(error) = run_sync(&app) {
                    eprintln!("Background Agent usage sync failed: {error}");
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(BACKGROUND_SYNC_TICK_SECS));
        }
    });
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn get_agent_usage(
    app: crate::runtime::AppHandle,
    query: Option<AgentUsageQuery>,
) -> Result<AgentUsageReport, String> {
    let syncing = app
        .state::<AgentUsageState>()
        .syncing
        .load(Ordering::SeqCst);
    let query = query.unwrap_or_default();
    crate::runtime::async_runtime::spawn_blocking(move || {
        let connection = agent_usage_store::open_store()?;
        let mut report = agent_usage_store::report(&connection, &query)?;
        report.syncing = syncing;
        Ok(report)
    })
    .await
    .map_err(|error| format!("Failed to read local Agent usage: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn sync_agent_usage(
    app: crate::runtime::AppHandle,
) -> Result<AgentUsageSyncResult, String> {
    crate::runtime::async_runtime::spawn_blocking(move || run_sync(&app))
        .await
        .map_err(|error| format!("Failed to sync local Agent usage: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn get_agent_usage_storage() -> Result<AgentUsageStorage, String> {
    crate::runtime::async_runtime::spawn_blocking(move || {
        let path = agent_usage_store::store_path()?;
        if !path.is_file() {
            return Ok(agent_usage_store::empty_storage());
        }
        let connection = agent_usage_store::open_store_at(&path)?;
        agent_usage_store::storage(&connection, &path)
    })
    .await
    .map_err(|error| format!("Failed to read Agent usage storage: {error}"))?
}

#[ecpa_macros::ecpa_command]
pub(crate) async fn clear_agent_usage_history(app: crate::runtime::AppHandle) -> Result<(), String> {
    crate::runtime::async_runtime::spawn_blocking(move || {
        let state = app.state::<AgentUsageState>();
        let Some(_guard) = SyncGuard::acquire(&state.syncing) else {
            return Err("Agent usage sync is running; try again when it finishes".to_string());
        };
        let connection = agent_usage_store::open_store()?;
        agent_usage_store::clear(&connection)?;
        state.last_sync_millis.store(0, Ordering::SeqCst);
        Ok(())
    })
    .await
    .map_err(|error| format!("Failed to clear Agent usage history: {error}"))?
}

// ---------------------------------------------------------------------------
// Source dispatch & context hooks used by agent_usage_store
// ---------------------------------------------------------------------------

pub(crate) fn source_files(home: &Path, source: &str) -> Vec<PathBuf> {
    let mut files = match source {
        "claude" => claude::discover_files(home),
        "codex" => codex::discover_files(home),
        "mcode" => mcode::discover_files(home),
        "opencode" => opencode::discover_files(home),
        "omp" => pi::discover_omp_files(home),
        "pi" => pi::discover_pi_files(home),
        "copilot" => copilot::discover_files(home),
        "gemini" => gemini::discover_files(home),
        "antigravity" => antigravity::discover_files(home),
        "kimi" => kimi::discover_files(home),
        "workbuddy" => workbuddy::discover_files(home),
        "codebuddy" => codebuddy::discover_files(home),
        "dsh" => dsh::discover_files(home),
        "grokbuild" => grokbuild::discover_files(home),
        "zcode" => zcode::discover_files(home),
        _ => Vec::new(),
    };
    files.truncate(MAX_SCAN_FILES);
    files
}

pub(crate) fn source_uses_cross_file_dedup(source: &str) -> bool {
    matches!(source, "claude" | "kimi" | "dsh")
}

fn normalized_path_key(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    {
        raw.replace('/', "\\")
    }
    #[cfg(not(windows))]
    {
        raw.into_owned()
    }
}

pub(crate) fn logical_file_key(source: &str, path: &Path) -> String {
    if source == "antigravity" {
        return format!("{source}:v2:{}", normalized_path_key(path));
    }
    if source == "codex" {
        let name = codex::logical_filename(path);
        if !name.is_empty() {
            return format!("{source}:{name}");
        }
    }
    format!("{source}:{}", normalized_path_key(path))
}

pub(crate) fn build_source_context(
    source: &str,
    all_files: &[PathBuf],
    needs_codex_index: bool,
) -> SourceSyncContext {
    let mut ctx = SourceSyncContext::default();
    if source == "pi" {
        ctx.pi_known_files = pi::build_pi_known_files(all_files);
    } else if source == "codex" && needs_codex_index {
        ctx.codex_index = Some(codex::CodexSourceIndex::build(all_files));
    }
    ctx
}

#[cfg(test)]
pub(crate) fn read_usage_file(path: &Path, source: &str, delta: &mut FileDelta) -> Result<(), ()> {
    let mut ctx = SourceSyncContext::default();
    read_usage_file_with_context(path, source, &mut ctx, delta)
}

pub(crate) fn read_usage_file_with_context(
    path: &Path,
    source: &str,
    ctx: &mut SourceSyncContext,
    delta: &mut FileDelta,
) -> Result<(), ()> {
    match source {
        "claude" => claude::read_file(path, ctx, delta),
        "codex" => codex::read_file(path, ctx, delta),
        "mcode" => mcode::read_file(path, delta),
        "opencode" => opencode::read_file(path, delta),
        "omp" => pi::read_omp_file(path, delta),
        "pi" => pi::read_pi_file(path, ctx, delta),
        "copilot" => copilot::read_file(path, delta),
        "gemini" => gemini::read_file(path, delta),
        "antigravity" => antigravity::read_file(path, delta),
        "kimi" => kimi::read_file(path, ctx, delta),
        "workbuddy" => workbuddy::read_file(path, delta),
        "codebuddy" => codebuddy::read_file(path, delta),
        "dsh" => dsh::read_file(path, ctx, delta),
        "grokbuild" => grokbuild::read_file(path, delta),
        "zcode" => zcode::read_file(path, delta),
        _ => Ok(()),
    }
}

pub(crate) fn antigravity_session_id(path: &Path) -> Option<String> {
    antigravity::session_id(path)
}

pub(crate) fn antigravity_session_database(path: &Path) -> Option<PathBuf> {
    antigravity::session_database(path)
}

pub(crate) fn antigravity_covered_steps(path: &Path) -> Option<BTreeSet<u64>> {
    antigravity::covered_steps(path)
}

// ---------------------------------------------------------------------------
// Proxy Codex fallback (used when no local Codex rollouts exist)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct ProxyModelPrice {
    prompt: f64,
    completion: f64,
    cache_read: f64,
    cache_creation: f64,
}

pub(crate) fn proxy_codex_delta(path: &Path) -> Option<FileDelta> {
    if !path.is_file() {
        return None;
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = connection.busy_timeout(std::time::Duration::from_secs(2));
    let prices = load_proxy_model_prices(&connection);
    let mut statement = connection
        .prepare(
            "SELECT timestamp, model, response_model, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens FROM usage_events WHERE lower(trim(executor_type)) IN ('codexexecutor', 'codexwebsocketsexecutor', 'codexautoexecutor', 'codex') OR (trim(executor_type) = '' AND lower(trim(source)) = 'codex') ORDER BY timestamp_ms ASC",
        )
        .ok()?;
    let rows = statement
        .query_map([], |row| {
            let timestamp: String = row.get(0)?;
            let model: String = row.get(1)?;
            let response_model: String = row.get(2)?;
            let input_tokens: u64 = row.get(3)?;
            let output_tokens: u64 = row.get(4)?;
            let reasoning_tokens: u64 = row.get(5)?;
            let cache_read_tokens: u64 = row.get(6)?;
            let cache_creation_tokens: u64 = row.get(7)?;
            let total_tokens: u64 = row.get(8)?;
            Ok((
                timestamp,
                if model.trim().is_empty() {
                    response_model
                } else {
                    model
                },
                UsageCounter {
                    input_tokens: input_tokens
                        .saturating_sub(cache_read_tokens.saturating_add(cache_creation_tokens)),
                    output_tokens,
                    reasoning_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                    cache_creation_1h_tokens: 0,
                    total_tokens: if total_tokens == 0 {
                        input_tokens.saturating_add(output_tokens)
                    } else {
                        total_tokens
                    },
                    cost_usd: 0.0,
                    reported_cost_usd: 0.0,
                    reported_samples: 0,
                    samples: 1,
                },
            ))
        })
        .ok()?;

    let mut delta = FileDelta::default();
    for row in rows.flatten() {
        let (timestamp, model, mut counter) = row;
        let Some(time) = DateTime::parse_from_rfc3339(&timestamp)
            .ok()
            .map(|time| time.with_timezone(&Local))
        else {
            continue;
        };
        if let Some(price) = prices.get(&model.to_ascii_lowercase()) {
            counter.cost_usd = proxy_cost(&counter, price);
        }
        let day = time.format("%Y-%m-%d").to_string();
        let hour = time.hour() as u8;
        add_counter(
            delta.daily.entry((day.clone(), model.clone())).or_default(),
            &counter,
        );
        add_counter(
            delta.hourly.entry((day, hour, model)).or_default(),
            &counter,
        );
    }
    (!delta.daily.is_empty()).then_some(delta)
}

fn load_proxy_model_prices(connection: &Connection) -> HashMap<String, ProxyModelPrice> {
    let Ok(mut statement) = connection.prepare(
        "SELECT model, source_model_id, prompt_per_1m, completion_per_1m, cache_read_per_1m, cache_creation_per_1m FROM model_prices",
    ) else {
        return HashMap::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        let model: String = row.get(0)?;
        let source_model_id: String = row.get(1)?;
        let price = ProxyModelPrice {
            prompt: row.get(2)?,
            completion: row.get(3)?,
            cache_read: row.get(4)?,
            cache_creation: row.get(5)?,
        };
        Ok((model, source_model_id, price))
    }) else {
        return HashMap::new();
    };
    let mut prices = HashMap::new();
    for row in rows.flatten() {
        let (model, source_model_id, price) = row;
        prices.insert(model.to_ascii_lowercase(), price);
        if !source_model_id.trim().is_empty() {
            prices.insert(source_model_id.to_ascii_lowercase(), price);
        }
    }
    prices
}

fn proxy_cost(counter: &UsageCounter, price: &ProxyModelPrice) -> f64 {
    (counter.input_tokens as f64 * price.prompt
        + counter.output_tokens as f64 * price.completion
        + counter.cache_read_tokens as f64 * price.cache_read
        + counter.cache_creation_tokens as f64 * price.cache_creation)
        / 1_000_000.0
}

// ---------------------------------------------------------------------------
// Shared parser utilities
// ---------------------------------------------------------------------------

pub(super) fn contains_any_str(haystack: &[u8], needles: &[&str]) -> bool {
    if let Ok(text) = std::str::from_utf8(haystack) {
        return needles.iter().any(|needle| text.contains(needle));
    }
    needles.iter().any(|needle| {
        let b = needle.as_bytes();
        !b.is_empty() && b.len() <= haystack.len() && haystack.windows(b.len()).any(|w| w == b)
    })
}

pub(super) fn add_counter(target: &mut UsageCounter, delta: &UsageCounter) {
    target.input_tokens = target.input_tokens.saturating_add(delta.input_tokens);
    target.output_tokens = target.output_tokens.saturating_add(delta.output_tokens);
    target.cache_creation_tokens = target
        .cache_creation_tokens
        .saturating_add(delta.cache_creation_tokens);
    target.cache_creation_1h_tokens = target
        .cache_creation_1h_tokens
        .saturating_add(delta.cache_creation_1h_tokens);
    target.cache_read_tokens = target
        .cache_read_tokens
        .saturating_add(delta.cache_read_tokens);
    target.reasoning_tokens = target
        .reasoning_tokens
        .saturating_add(delta.reasoning_tokens);
    target.total_tokens = target.total_tokens.saturating_add(delta.total_tokens);
    target.cost_usd += delta.cost_usd;
    target.reported_cost_usd += delta.reported_cost_usd;
    target.reported_samples = target
        .reported_samples
        .saturating_add(delta.reported_samples);
    target.samples = target.samples.saturating_add(delta.samples);
}

pub(super) fn record_sample(
    delta: &mut FileDelta,
    time: DateTime<Local>,
    model: Option<String>,
    mut counter: UsageCounter,
) {
    let day = time.format("%Y-%m-%d").to_string();
    let hour = time.hour() as u8;
    let model = model.unwrap_or_default();
    if counter.samples == 0 {
        counter.samples = 1;
    }
    add_counter(
        delta.daily.entry((day.clone(), model.clone())).or_default(),
        &counter,
    );
    add_counter(
        delta.hourly.entry((day, hour, model)).or_default(),
        &counter,
    );
}

pub(super) fn sanitize_model_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("unknown")
        || trimmed.eq_ignore_ascii_case("none")
        || trimmed.eq_ignore_ascii_case("null")
    {
        return String::new();
    }
    trimmed
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_MODEL_NAME_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

pub(super) fn env_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub(super) fn is_non_empty_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_file() && meta.len() > 0)
        .unwrap_or(false)
}

pub(super) fn is_transient_sqlite_error(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(
            rusqlite::ErrorCode::DatabaseBusy
                | rusqlite::ErrorCode::DatabaseLocked
                | rusqlite::ErrorCode::SystemIoFailure
                | rusqlite::ErrorCode::CannotOpen
                | rusqlite::ErrorCode::FileLockingProtocolFailed
        )
    )
}

pub(super) fn copy_sqlite_snapshot(database: &Path, prefix: &str) -> Option<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("{prefix}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&directory).ok()?;
    let target = directory.join(database.file_name()?);
    fs::copy(database, &target).ok()?;
    for suffix in ["-wal", "-shm"] {
        let source = PathBuf::from(format!("{}{suffix}", database.display()));
        if source.is_file() {
            let destination = PathBuf::from(format!("{}{suffix}", target.display()));
            let _ = fs::copy(source, destination);
        }
    }
    Some(target)
}

pub(super) fn collect_files_under(
    root: &Path,
    files: &mut Vec<PathBuf>,
    accept: &dyn Fn(&Path) -> bool,
) {
    if !root.is_dir() {
        return;
    }
    walk_directory(root, files, accept, 0);
}

fn walk_directory(
    dir: &Path,
    files: &mut Vec<PathBuf>,
    accept: &dyn Fn(&Path) -> bool,
    depth: usize,
) {
    if depth > MAX_WALK_DEPTH || files.len() >= MAX_SCAN_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    children.sort();
    for path in children {
        if files.len() >= MAX_SCAN_FILES {
            return;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.file_type().is_dir() {
            walk_directory(&path, files, accept, depth + 1);
        } else if meta.file_type().is_file() && accept(&path) {
            files.push(path);
        }
    }
}

pub(super) fn local_from_epoch_ms(ms: i64) -> Option<DateTime<Local>> {
    if ms <= 0 {
        return None;
    }
    let adjusted = if ms < 10_000_000_000 {
        ms.saturating_mul(1000)
    } else {
        ms
    };
    DateTime::from_timestamp_millis(adjusted).map(|dt| dt.with_timezone(&Local))
}

pub(super) fn sample_time(value: &Value, path: &Path) -> Option<DateTime<Local>> {
    if let Some(time) = extract_local_timestamp(value) {
        return Some(time);
    }
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()
        .map(DateTime::<Local>::from)
}

pub(super) fn extract_local_timestamp(value: &Value) -> Option<DateTime<Local>> {
    let object = value.as_object()?;
    for key in ["timestamp", "time", "created_at", "createdAt", "date"] {
        let Some(field) = object.get(key) else {
            continue;
        };
        if let Some(text) = field.as_str() {
            if let Ok(time) = DateTime::parse_from_rfc3339(text) {
                return Some(time.with_timezone(&Local));
            }
            if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
                return local_midnight(date);
            }
        }
        let inner = field
            .get("completed")
            .or_else(|| field.get("created"))
            .unwrap_or(field);
        if let Some(number) = inner.as_f64().filter(|number| number.is_finite()) {
            let millis = if number.abs() > 10_000_000_000.0 {
                number
            } else {
                number * 1000.0
            };
            if millis > 0.0 && millis <= i64::MAX as f64 {
                return DateTime::from_timestamp_millis(millis as i64)
                    .map(|time| time.with_timezone(&Local));
            }
        }
    }
    for key in ["message", "payload", "data"] {
        if let Some(time) = object.get(key).and_then(extract_local_timestamp) {
            return Some(time);
        }
    }
    None
}

fn local_midnight(date: NaiveDate) -> Option<DateTime<Local>> {
    let naive = date.and_hms_opt(0, 0, 0)?;
    Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| Local.from_local_datetime(&naive).earliest())
}

pub(super) fn string_field(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(value) = object.get(*key) else {
            continue;
        };
        if let Some(text) = value.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

pub(super) fn first_counter(map: &Map<String, Value>, keys: &[&str]) -> Option<u64> {
    for key in keys {
        let Some(value) = map.get(*key) else {
            continue;
        };
        if let Some(number) = value.as_u64() {
            return Some(number);
        }
        if let Some(number) = value.as_i64().filter(|n| *n >= 0) {
            return Some(number as u64);
        }
        if let Some(number) = value
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0 && *n <= u64::MAX as f64)
        {
            return Some(number.round() as u64);
        }
    }
    None
}

pub(super) fn first_cost(map: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    for key in keys {
        let Some(value) = map.get(*key) else {
            continue;
        };
        if let Some(number) = value.as_f64().filter(|n| n.is_finite() && *n >= 0.0) {
            return Some(number);
        }
        if let Some(text) = value.as_str() {
            if let Ok(number) = text.trim().parse::<f64>() {
                if number.is_finite() && number >= 0.0 {
                    return Some(number);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests;
