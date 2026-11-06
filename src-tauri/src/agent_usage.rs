use chrono::{DateTime, Local, NaiveDate, TimeZone, Timelike};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use tauri::{Emitter, Manager};

use crate::agent_usage_store::{
    self, AgentUsageQuery, AgentUsageReport, AgentUsageStorage, AgentUsageSyncResult,
};

const MAX_SCAN_FILES: usize = 20_000;
const MAX_JSON_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_JSON_LINE_BYTES: usize = 16 * 1024 * 1024;
const MAX_MODEL_NAME_CHARS: usize = 120;
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
    "zcode",
];

#[derive(Debug, Default, Clone)]
pub(crate) struct UsageCounter {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cache_creation_tokens: u64,
    pub(crate) cache_read_tokens: u64,
    pub(crate) reasoning_tokens: u64,
    pub(crate) total_tokens: u64,
    pub(crate) cost_usd: f64,
    pub(crate) samples: u64,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct FileDelta {
    pub(crate) daily: BTreeMap<(String, String), UsageCounter>,
    pub(crate) hourly: BTreeMap<(String, u8, String), UsageCounter>,
}

#[derive(Debug, Clone)]
struct UsageSample {
    counter: UsageCounter,
    model: Option<String>,
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

fn run_sync(app: &tauri::AppHandle) -> Result<AgentUsageSyncResult, String> {
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

fn sync_store(app: &tauri::AppHandle) -> Result<AgentUsageSyncResult, String> {
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
            if crate::window_activity::is_active(app) {
                let _ = app.emit_to("main", SYNC_PROGRESS_EVENT, progress);
            }
        },
    )
}

pub(crate) fn start_background_sync(app: tauri::AppHandle) {
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

#[tauri::command]
pub(crate) async fn get_agent_usage(
    app: tauri::AppHandle,
    query: Option<AgentUsageQuery>,
) -> Result<AgentUsageReport, String> {
    let syncing = app
        .state::<AgentUsageState>()
        .syncing
        .load(Ordering::SeqCst);
    let query = query.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = agent_usage_store::open_store()?;
        let mut report = agent_usage_store::report(&connection, &query)?;
        report.syncing = syncing;
        Ok(report)
    })
    .await
    .map_err(|error| format!("Failed to read local Agent usage: {error}"))?
}

#[tauri::command]
pub(crate) async fn sync_agent_usage(
    app: tauri::AppHandle,
) -> Result<AgentUsageSyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_sync(&app))
        .await
        .map_err(|error| format!("Failed to sync local Agent usage: {error}"))?
}

#[tauri::command]
pub(crate) async fn get_agent_usage_storage() -> Result<AgentUsageStorage, String> {
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub(crate) async fn clear_agent_usage_history(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
                    total_tokens: if total_tokens == 0 {
                        input_tokens.saturating_add(output_tokens)
                    } else {
                        total_tokens
                    },
                    cost_usd: 0.0,
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

pub(crate) fn source_files(home: &Path, source: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut extensions = vec!["jsonl"];

    match source {
        "codex" => {
            let root = env_directory("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
            roots.push(root.join("sessions"));
            roots.push(root.join("archived_sessions"));
        }
        "claude" => {
            let root = env_directory("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
            roots.push(root.join("projects"));
        }
        "gemini" => {
            roots.push(home.join(".gemini/tmp"));
            extensions.push("json");
        }
        "antigravity" => {
            roots.push(home.join(".gemini"));
            roots.push(home.join(".antigravity-ide"));
            extensions.push("json");
        }
        "pi" | "omp" => {
            roots.push(home.join(format!(".{source}/agent/sessions")));
            roots.push(home.join(format!(".{source}/sessions")));
        }
        "mcode" => {
            roots.push(home.join(".mcode/sessions"));
        }
        "zcode" => {
            if let Some(custom) = env_directory("ZCODE_DATA_BASE_DIR") {
                roots.push(custom.join(".zcode").join("cli").join("db"));
            }
            if let Some(custom_dir) = read_zcode_custom_data_dir(home) {
                roots.push(custom_dir.join(".zcode").join("cli").join("db"));
            }
            roots.push(home.join(".zcode").join("cli").join("db"));
            roots.push(home.join(".zcode").join("sessions"));
            extensions.push("sqlite");
            extensions.push("db");
        }
        "kimi" => {
            let root = env_directory("KIMI_CODE_HOME").unwrap_or_else(|| home.join(".kimi-code"));
            roots.push(root.join("sessions"));
        }
        "opencode" => {
            roots.push(home.join(".opencode"));
            roots.push(home.join(".local").join("share").join("opencode"));
            if let Some(app_data) = env::var_os("APPDATA") {
                roots.push(PathBuf::from(app_data).join("opencode"));
            }
            if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
                roots.push(PathBuf::from(local_app_data).join("opencode"));
            }
            extensions.push("json");
            extensions.push("db");
        }
        "copilot" => {
            extensions.push("json");
            let root = env_directory("COPILOT_HOME").unwrap_or_else(|| home.join(".copilot"));
            roots.push(root.join("session-state"));
            if let Some(app_data) = env::var_os("APPDATA") {
                roots.push(
                    PathBuf::from(app_data)
                        .join("GitHub Copilot")
                        .join("session-state"),
                );
            }
        }
        _ => return Vec::new(),
    }

    let mut files = Vec::new();
    for root in roots {
        if root.ancestors().any(|path| {
            fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        }) {
            continue;
        }
        collect_files(&root, 0, &extensions, &mut files);
        if files.len() >= MAX_SCAN_FILES {
            break;
        }
    }
    files.truncate(MAX_SCAN_FILES);
    if source == "gemini" || source == "antigravity" {
        let tmp = home.join(".gemini/tmp");
        files.retain(|path| {
            let chat = path
                .strip_prefix(&tmp)
                .ok()
                .and_then(|relative| relative.components().nth(1))
                .is_some_and(|part| part.as_os_str() == "chats");
            chat == (source == "gemini")
        });
        if source == "gemini" {
            files.retain(|path| {
                path.extension().and_then(|extension| extension.to_str()) != Some("json")
                    || !fs::symlink_metadata(path.with_extension("jsonl"))
                        .is_ok_and(|metadata| metadata.is_file())
            });
        }
    }
    if source == "copilot" {
        files.retain(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            !name.eq_ignore_ascii_case("config.json")
                && !name.eq_ignore_ascii_case("settings.json")
                && !name.eq_ignore_ascii_case("hosts.json")
                && !name.eq_ignore_ascii_case("ezcpa-connection.json")
        });
    }
    if source == "zcode" {
        files.retain(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            let ext = path
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or_default();
            if ext.eq_ignore_ascii_case("sqlite") || ext.eq_ignore_ascii_case("db") {
                name.eq_ignore_ascii_case("db.sqlite") || name.eq_ignore_ascii_case("model_usage.db")
            } else {
                ext.eq_ignore_ascii_case("jsonl")
            }
        });
    }
    files.sort();
    files.dedup();
    files
}

fn env_directory(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

fn collect_files(root: &Path, depth: usize, extensions: &[&str], output: &mut Vec<PathBuf>) {
    if output.len() >= MAX_SCAN_FILES || depth > 8 {
        return;
    }
    if !fs::symlink_metadata(root).is_ok_and(|metadata| metadata.is_dir()) {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if output.len() >= MAX_SCAN_FILES {
            return;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_files(&path, depth + 1, extensions, output);
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extensions
                        .iter()
                        .any(|candidate| extension.eq_ignore_ascii_case(candidate))
                })
        {
            output.push(path);
        }
    }
}

pub(crate) fn read_usage_file(path: &Path, source: &str, delta: &mut FileDelta) -> Result<(), ()> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_file() {
        return Ok(());
    }
    if extension.eq_ignore_ascii_case("db") || extension.eq_ignore_ascii_case("sqlite") {
        if source == "zcode" {
            return read_zcode_database(path, delta);
        }
        return read_opencode_database(path, delta);
    }

    let mut file = File::open(path).map_err(|_| ())?;
    if extension.eq_ignore_ascii_case("json") {
        if metadata.len() > MAX_JSON_DOCUMENT_BYTES {
            return Ok(());
        }
        let value = match serde_json::from_reader::<_, Value>(&file) {
            Ok(value) => Some(value),
            Err(error) if error.is_io() => return Err(()),
            Err(_) => {
                let mut content = String::new();
                file.seek(SeekFrom::Start(0)).map_err(|_| ())?;
                match file.read_to_string(&mut content) {
                    Ok(_) => json5::from_str::<Value>(&content).ok(),
                    Err(read_error) if read_error.kind() == std::io::ErrorKind::InvalidData => None,
                    Err(_) => return Err(()),
                }
            }
        };
        if let Some(value) = value {
            add_value_usage(&value, source, path, delta);
        }
        return Ok(());
    }

    let reader = BufReader::new(file);
    let mut codex_total = UsageCounter::default();
    let mut codex_model = None;
    let mut claude_samples: HashMap<String, (UsageSample, Option<DateTime<Local>>)> =
        HashMap::new();
    let mut gemini_messages = Vec::new();
    let mut gemini_positions = HashMap::new();
    for line in reader.lines() {
        let line = line.map_err(|_| ())?;
        if line.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if source == "gemini" {
            if let Some(id) = value.get("$rewindTo").and_then(Value::as_str) {
                let end = gemini_positions.get(id).copied().unwrap_or(0);
                gemini_messages.truncate(end);
                gemini_positions.retain(|_, position| *position < end);
            } else if let Some(messages) = value.pointer("/$set/messages").and_then(Value::as_array)
            {
                gemini_messages.clear();
                gemini_positions.clear();
                for message in messages {
                    upsert_gemini_message(
                        message.clone(),
                        &mut gemini_messages,
                        &mut gemini_positions,
                    );
                }
            } else if let Some(messages) = value.get("messages").and_then(Value::as_array) {
                for message in messages {
                    upsert_gemini_message(
                        message.clone(),
                        &mut gemini_messages,
                        &mut gemini_positions,
                    );
                }
            } else if value.get("id").and_then(Value::as_str).is_some() {
                upsert_gemini_message(value, &mut gemini_messages, &mut gemini_positions);
            } else {
                add_value_usage(&value, source, path, delta);
            }
        } else if source == "codex" {
            if value["type"] == "turn_context" {
                codex_model = value["payload"]["model"].as_str().map(sanitize_model_name);
            }
            if let Some(mut sample) = extract_codex_usage(&value) {
                let has_last = value
                    .pointer("/payload/info/last_token_usage")
                    .is_some_and(Value::is_object);
                if !has_last
                    && value
                        .pointer("/payload/info/total_token_usage")
                        .is_some_and(Value::is_object)
                {
                    let current = sample.counter.clone();
                    sample.counter.input_tokens = current
                        .input_tokens
                        .saturating_sub(codex_total.input_tokens);
                    sample.counter.output_tokens = current
                        .output_tokens
                        .saturating_sub(codex_total.output_tokens);
                    sample.counter.cache_read_tokens = current
                        .cache_read_tokens
                        .saturating_sub(codex_total.cache_read_tokens);
                    sample.counter.cache_creation_tokens = current
                        .cache_creation_tokens
                        .saturating_sub(codex_total.cache_creation_tokens);
                    sample.counter.reasoning_tokens = current
                        .reasoning_tokens
                        .saturating_sub(codex_total.reasoning_tokens);
                    sample.counter.total_tokens = current
                        .total_tokens
                        .saturating_sub(codex_total.total_tokens);
                    codex_total = current;
                }
                sample.model = sample.model.or_else(|| codex_model.clone());
                add_sample_usage(sample, &value, path, delta);
            }
        } else {
            if source == "claude" {
                if let Some(sample) = extract_claude_usage(&value) {
                    if let Some(id) = value.pointer("/message/id").and_then(Value::as_str) {
                        claude_samples.insert(id.to_string(), (sample, sample_time(&value, path)));
                        continue;
                    }
                }
            }
            add_value_usage(&value, source, path, delta);
        }
    }
    for (sample, time) in claude_samples.into_values() {
        add_sample_at(sample, time, delta);
    }
    for value in gemini_messages {
        add_value_usage(&value, source, path, delta);
    }
    Ok(())
}

fn upsert_gemini_message(
    value: Value,
    messages: &mut Vec<Value>,
    positions: &mut HashMap<String, usize>,
) {
    let Some(id) = value.get("id").and_then(Value::as_str) else {
        return;
    };
    if let Some(position) = positions.get(id) {
        messages[*position] = value;
    } else {
        positions.insert(id.to_string(), messages.len());
        messages.push(value);
    }
}

fn read_opencode_database(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| ())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| ())?;
    let mut statement = connection
        .prepare("SELECT data FROM message WHERE length(data) <= 16777216")
        .or_else(|_| connection.prepare("SELECT data FROM session_message WHERE type = 'assistant' AND length(data) <= 16777216"))
        .map_err(|_| ())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| ())?;
    for row in rows {
        let data = row.map_err(|_| ())?;
        if data.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            add_value_usage(&value, "opencode", path, delta);
        }
    }
    Ok(())
}

fn read_zcode_custom_data_dir(home: &Path) -> Option<PathBuf> {
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

fn read_zcode_database(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    if fs::metadata(path).map(|m| m.len() == 0).unwrap_or(true) {
        return Ok(());
    }
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

    let mut statement = connection
        .prepare(
            "SELECT started_at, coalesce(model_id, 'unknown'), \
                    coalesce(input_tokens, 0), coalesce(output_tokens, 0), \
                    coalesce(cache_read_input_tokens, 0), coalesce(cache_creation_input_tokens, 0), \
                    coalesce(reasoning_tokens, 0), coalesce(computed_total_tokens, 0) \
             FROM model_usage \
             WHERE lower(coalesce(provider_id, '')) NOT LIKE 'account:%' \
               AND lower(coalesce(provider_id, '')) NOT LIKE 'official%' \
             ORDER BY started_at ASC",
        )
        .map_err(|_| ())?;

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
        let (started_at, model, input, output, cache_read, cache_creation, reasoning, computed_total) =
            row.map_err(|_| ())?;
        let Some(timestamp) = Local.timestamp_millis_opt(started_at).single() else {
            continue;
        };
        let day = timestamp.format("%Y-%m-%d").to_string();
        let hour = timestamp.hour() as u8;
        let model = sanitize_model_name(&model);

        let mut counter = UsageCounter::default();
        counter.cache_read_tokens = cache_read;
        counter.cache_creation_tokens = cache_creation;
        counter.reasoning_tokens = reasoning;
        counter.output_tokens = output;
        counter.input_tokens = input.saturating_sub(cache_read);
        if computed_total > 0 {
            counter.total_tokens = computed_total;
        } else {
            counter.total_tokens = counter
                .input_tokens
                .saturating_add(output)
                .saturating_add(cache_read)
                .saturating_add(cache_creation);
        }
        counter.samples = 1;

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

fn add_value_usage(value: &Value, source: &str, path: &Path, delta: &mut FileDelta) {
    if let Some(messages) = value
        .as_array()
        .or_else(|| value.get("messages").and_then(Value::as_array))
    {
        for message in messages {
            add_value_usage(message, source, path, delta);
        }
        return;
    }
    let Some(sample) = extract_usage(value, source) else {
        return;
    };
    add_sample_usage(sample, value, path, delta);
}

fn add_sample_usage(sample: UsageSample, value: &Value, path: &Path, delta: &mut FileDelta) {
    add_sample_at(sample, sample_time(value, path), delta);
}

fn add_sample_at(sample: UsageSample, time: Option<DateTime<Local>>, delta: &mut FileDelta) {
    let Some(time) = time else {
        return;
    };
    let day = time.format("%Y-%m-%d").to_string();
    let hour = time.hour() as u8;
    let model = sample.model.unwrap_or_default();
    let mut counter = sample.counter;
    counter.samples = 1;
    add_counter(
        delta.daily.entry((day.clone(), model.clone())).or_default(),
        &counter,
    );
    add_counter(
        delta.hourly.entry((day, hour, model)).or_default(),
        &counter,
    );
}

fn sample_time(value: &Value, path: &Path) -> Option<DateTime<Local>> {
    if let Some(time) = extract_local_timestamp(value) {
        return Some(time);
    }
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()
        .map(DateTime::<Local>::from)
}

fn extract_local_timestamp(value: &Value) -> Option<DateTime<Local>> {
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
        let inner = field.get("created").unwrap_or(field);
        if let Some(number) = inner.as_f64().filter(|number| number.is_finite()) {
            let millis = if number.abs() > 10_000_000_000.0 {
                number
            } else {
                number * 1000.0
            };
            if millis >= i64::MIN as f64 && millis <= i64::MAX as f64 {
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

fn extract_usage(value: &Value, source: &str) -> Option<UsageSample> {
    match source {
        "codex" => extract_codex_usage(value),
        "kimi" => extract_top_level_usage(value),
        "claude" => extract_claude_usage(value),
        "opencode" | "gemini" | "antigravity" | "pi" | "omp" | "mcode" | "copilot" | "zcode" => {
            extract_generic_usage(value)
        }
        _ => None,
    }
}

fn extract_codex_usage(value: &Value) -> Option<UsageSample> {
    let payload = value.get("payload")?.as_object()?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let info = payload.get("info").and_then(Value::as_object);
    let usage = info
        .and_then(|object| {
            object
                .get("last_token_usage")
                .and_then(Value::as_object)
                .or_else(|| object.get("total_token_usage").and_then(Value::as_object))
        })
        .or_else(|| payload.get("usage").and_then(Value::as_object))?;
    let mut sample = sample_from_map(usage)?;
    sample.counter.input_tokens = sample
        .counter
        .input_tokens
        .saturating_sub(sample.counter.cache_read_tokens);
    if first_counter(usage, &["totalTokens", "total_tokens"]).is_none() {
        sample.counter.total_tokens = sample
            .counter
            .input_tokens
            .saturating_add(sample.counter.output_tokens)
            .saturating_add(sample.counter.cache_read_tokens)
            .saturating_add(sample.counter.cache_creation_tokens);
    }
    sample.model = string_field(usage, &["model", "modelName"]);
    Some(sample)
}

fn extract_top_level_usage(value: &Value) -> Option<UsageSample> {
    let object = value.as_object()?;
    let object = value
        .pointer("/message/meta")
        .and_then(Value::as_object)
        .unwrap_or(object);
    let object = object
        .get("payload")
        .or_else(|| object.get("event"))
        .and_then(Value::as_object)
        .unwrap_or(object);
    let usage = object
        .get("usage")
        .or_else(|| object.get("token_usage"))?
        .as_object()?;
    let mut sample = sample_from_map(usage)?;
    sample.model = string_field(object, &["model", "modelName", "modelAlias"]);
    Some(sample)
}

fn extract_claude_usage(value: &Value) -> Option<UsageSample> {
    let object = value.as_object()?;
    let (usage, model) = if let Some(message) = object.get("message").and_then(Value::as_object) {
        (
            message.get("usage").and_then(Value::as_object),
            string_field(message, &["model", "modelName"]),
        )
    } else {
        (
            object.get("usage").and_then(Value::as_object),
            string_field(object, &["model", "modelName"]),
        )
    };
    let mut sample = sample_from_map(usage?)?;
    sample.model = model;
    Some(sample)
}

fn extract_generic_usage(value: &Value) -> Option<UsageSample> {
    let object = value.as_object()?;
    for key in ["usage", "tokens", "usageMetadata"] {
        if let Some(usage) = object.get(key).and_then(Value::as_object) {
            let Some(mut sample) = sample_from_map(usage) else {
                continue;
            };
            sample.model = string_field(object, &["model", "modelName", "modelAlias", "modelID"]);
            if let Some(cost) = first_cost(object, &["costUSD", "costUsd", "cost_usd", "cost"]) {
                sample.counter.cost_usd = cost;
            }
            return Some(sample);
        }
    }
    if let Some(message) = object.get("message").and_then(Value::as_object) {
        return extract_generic_usage(&Value::Object(message.clone()));
    }
    if let Some(payload) = object.get("data").or_else(|| object.get("payload")) {
        return extract_generic_usage(payload);
    }
    first_counter(
        object,
        &[
            "input_tokens",
            "output_tokens",
            "inputTokens",
            "outputTokens",
            "prompt_tokens",
            "completion_tokens",
        ],
    )?;
    let mut sample = sample_from_map(object)?;
    sample.model = string_field(object, &["model", "modelName", "modelAlias", "modelID"]);
    Some(sample)
}

fn sample_from_map(map: &Map<String, Value>) -> Option<UsageSample> {
    let input_tokens = first_counter(
        map,
        &[
            "inputTokens",
            "input_tokens",
            "input",
            "inputOther",
            "prompt_tokens",
            "promptTokenCount",
        ],
    );
    let output_tokens = first_counter(
        map,
        &[
            "outputTokens",
            "output_tokens",
            "output",
            "completion_tokens",
            "candidatesTokenCount",
        ],
    );
    let cache_creation_tokens = first_counter(
        map,
        &[
            "cacheCreationTokens",
            "cache_creation_input_tokens",
            "cache_write_input_tokens",
            "inputCacheCreation",
            "cache_write",
            "cache_write_tokens",
            "cacheWrite",
        ],
    )
    .or_else(|| {
        map.get("cache")
            .and_then(Value::as_object)
            .and_then(|cache| first_counter(cache, &["write"]))
    });
    let cache_read_tokens = first_counter(
        map,
        &[
            "cacheReadTokens",
            "cache_read_input_tokens",
            "cached_input_tokens",
            "inputCacheRead",
            "cache_read",
            "cache_read_tokens",
            "cacheRead",
            "cached",
            "cachedContentTokenCount",
        ],
    )
    .or_else(|| {
        map.get("cache")
            .and_then(Value::as_object)
            .and_then(|cache| first_counter(cache, &["read"]))
    })
    .or_else(|| {
        map.get("prompt_tokens_details")
            .and_then(Value::as_object)
            .and_then(|details| first_counter(details, &["cached_tokens"]))
    });
    let reasoning_tokens = first_counter(
        map,
        &[
            "reasoningOutputTokens",
            "reasoningTokens",
            "reasoning_tokens",
            "reasoning_output_tokens",
            "reasoning",
            "thinking",
            "thinking_tokens",
            "thoughts",
            "thoughtsTokenCount",
        ],
    )
    .or_else(|| {
        map.get("completion_tokens_details")
            .and_then(Value::as_object)
            .and_then(|details| first_counter(details, &["reasoning_tokens"]))
    });
    let has_usage_field = input_tokens.is_some()
        || output_tokens.is_some()
        || cache_creation_tokens.is_some()
        || cache_read_tokens.is_some()
        || reasoning_tokens.is_some()
        || map.contains_key("totalTokens")
        || map.contains_key("total_tokens");
    if !has_usage_field {
        return None;
    }

    let mut input_tokens = input_tokens.unwrap_or(0);
    if map.contains_key("prompt_tokens")
        || map.contains_key("promptTokenCount")
        || map.contains_key("cached")
    {
        input_tokens = input_tokens.saturating_sub(cache_read_tokens.unwrap_or(0));
    }
    let output_tokens = output_tokens
        .unwrap_or(0)
        .saturating_add(first_counter(map, &["thoughts", "thoughtsTokenCount"]).unwrap_or(0));
    let cache_creation_tokens = cache_creation_tokens.unwrap_or(0);
    let cache_read_tokens = cache_read_tokens.unwrap_or(0);
    let reasoning_tokens = reasoning_tokens.unwrap_or(0);
    let known_total = input_tokens
        .saturating_add(output_tokens)
        .saturating_add(cache_creation_tokens)
        .saturating_add(cache_read_tokens);
    let total_tokens = first_counter(
        map,
        &["totalTokens", "total_tokens", "total", "totalTokenCount"],
    )
    .unwrap_or(known_total);

    Some(UsageSample {
        counter: UsageCounter {
            input_tokens,
            output_tokens,
            cache_creation_tokens,
            cache_read_tokens,
            reasoning_tokens,
            total_tokens,
            cost_usd: first_cost(map, &["costUSD", "costUsd", "cost_usd", "cost"])
                .or_else(|| {
                    map.get("cost")
                        .and_then(Value::as_object)
                        .and_then(|cost| first_cost(cost, &["total"]))
                })
                .unwrap_or(0.0),
            samples: 0,
        },
        model: None,
    })
}

fn add_counter(target: &mut UsageCounter, value: &UsageCounter) {
    target.input_tokens = target.input_tokens.saturating_add(value.input_tokens);
    target.output_tokens = target.output_tokens.saturating_add(value.output_tokens);
    target.cache_creation_tokens = target
        .cache_creation_tokens
        .saturating_add(value.cache_creation_tokens);
    target.cache_read_tokens = target
        .cache_read_tokens
        .saturating_add(value.cache_read_tokens);
    target.reasoning_tokens = target
        .reasoning_tokens
        .saturating_add(value.reasoning_tokens);
    target.total_tokens = target.total_tokens.saturating_add(value.total_tokens);
    target.samples = target.samples.saturating_add(value.samples);
    if value.cost_usd.is_finite() && value.cost_usd >= 0.0 {
        target.cost_usd += value.cost_usd;
    }
}

fn first_counter(map: &Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| map.get(*key).and_then(as_counter))
}

fn first_cost(map: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        let value = map.get(*key)?;
        let cost = value
            .as_f64()
            .or_else(|| value.as_str()?.parse::<f64>().ok())?;
        (cost.is_finite() && cost >= 0.0).then_some(cost)
    })
}

fn as_counter(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    let number = value.as_f64()?;
    (number.is_finite() && number >= 0.0 && number.fract() == 0.0 && number <= u64::MAX as f64)
        .then_some(number as u64)
}

fn string_field(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| {
            map.get(*key).and_then(|value| {
                value
                    .as_str()
                    .or_else(|| value.get("id").and_then(Value::as_str))
                    .or_else(|| value.get("model").and_then(Value::as_str))
            })
        })
        .map(sanitize_model_name)
        .filter(|value| !value.is_empty())
}

fn sanitize_model_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_MODEL_NAME_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn test_directory(name: &str) -> PathBuf {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("cpa-usage-{name}-{}", std::process::id()));
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

    fn delta_total(delta: &FileDelta) -> UsageCounter {
        let mut total = UsageCounter::default();
        for counter in delta.daily.values() {
            add_counter(&mut total, counter);
        }
        total
    }

    #[test]
    fn discovers_supported_session_roots_without_overlapping_gemini() {
        let home = test_directory("roots");
        for (source, directory, name) in [
            ("gemini", ".gemini/tmp/project/chats", "session.json"),
            ("antigravity", ".antigravity-ide/logs", "session.jsonl"),
            ("antigravity", ".gemini/antigravity", "session.json"),
            ("opencode", ".local/share/opencode", "opencode.db"),
            ("opencode", ".opencode/storage/message", "message.json"),
            ("kimi", ".kimi-code/sessions/one", "wire.jsonl"),
            ("pi", ".pi/agent/sessions", "session.jsonl"),
            ("pi", ".pi/sessions", "session.jsonl"),
            ("omp", ".omp/agent/sessions", "session.jsonl"),
            ("omp", ".omp/sessions", "session.jsonl"),
            ("mcode", ".mcode/sessions", "session.jsonl"),
            ("copilot", ".copilot/session-state", "events.jsonl"),
            ("zcode", ".zcode/sessions", "session.jsonl"),
        ] {
            let directory = home.join(directory);
            fs::create_dir_all(&directory).unwrap();
            let path = directory.join(name);
            fs::write(&path, "{}").unwrap();
            assert!(
                source_files(&home, source).contains(&path),
                "{source}: {path:?}"
            );
        }
        assert_eq!(source_files(&home, "gemini").len(), 1);
        assert_eq!(source_files(&home, "antigravity").len(), 2);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn copilot_session_state_root_ignores_unrelated_trees() {
        let home = test_directory("copilot-root");
        fs::create_dir_all(home.join(".copilot")).unwrap();
        fs::write(home.join(".copilot/config.json"), "{not json").unwrap();
        fs::create_dir_all(home.join(".copilot/session-state")).unwrap();
        fs::write(home.join(".copilot/session-state/events.jsonl"), "{}\n").unwrap();
        let files = source_files(&home, "copilot");
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].ends_with("session-state/events.jsonl"));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn enforces_scan_depth_and_document_size_limits() {
        let root = test_directory("limits");
        let mut directory = root.clone();
        for depth in 0..10 {
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("usage.jsonl"), "{}").unwrap();
            directory = directory.join(format!("level-{depth}"));
        }
        let mut files = Vec::new();
        collect_files(&root, 0, &["jsonl"], &mut files);
        assert_eq!(files.len(), 9);

        let document = root.join("large.json");
        let mut file = File::create(&document).unwrap();
        writeln!(file, "{{\"usage\":{{\"input_tokens\":100}}}}").unwrap();
        file.set_len(MAX_JSON_DOCUMENT_BYTES + 1).unwrap();
        drop(file);
        let mut delta = FileDelta::default();
        read_usage_file(&document, "pi", &mut delta).unwrap();
        assert!(delta.daily.is_empty());

        let stream = root.join("large.jsonl");
        let mut file = File::create(&stream).unwrap();
        writeln!(
            file,
            "{}",
            json!({"timestamp": local_timestamp(2026, 10, 29, 12), "usage": {"input_tokens": 100, "output_tokens": 1}})
        )
        .unwrap();
        file.set_len(MAX_JSON_DOCUMENT_BYTES + 1).unwrap();
        drop(file);
        let mut delta = FileDelta::default();
        read_usage_file(&stream, "pi", &mut delta).unwrap();
        assert_eq!(delta_total(&delta).input_tokens, 100);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ignores_directory_and_file_symlinks_including_scan_roots() {
        use std::os::unix::fs::symlink;
        let root = test_directory("symlinks");
        let actual = root.join("actual");
        fs::create_dir_all(actual.join("sessions")).unwrap();
        fs::write(actual.join("usage.jsonl"), "{}").unwrap();
        symlink(&root, actual.join("cycle")).unwrap();
        symlink(actual.join("usage.jsonl"), root.join("linked.jsonl")).unwrap();
        symlink(&actual, root.join(".pi")).unwrap();
        let mut files = Vec::new();
        collect_files(&root, 0, &["jsonl"], &mut files);
        assert_eq!(files, vec![actual.join("usage.jsonl")]);
        assert!(source_files(&root, "pi").is_empty());
        files.clear();
        collect_files(&root.join(".pi"), 0, &["jsonl"], &mut files);
        assert!(files.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_gemini_message_arrays_and_thinking_without_double_counting_cache() {
        let value = json!({"messages": [
            {"timestamp": local_timestamp(2026, 10, 29, 12), "model": "gemini", "tokens": {
                "input": 100, "output": 20, "cached": 30, "thoughts": 5
            }},
            {"type": "user", "content": "private"}
        ]});
        let mut delta = FileDelta::default();
        add_value_usage(&value, "gemini", Path::new("session.json"), &mut delta);
        let counter = delta
            .daily
            .get(&("2026-10-29".to_string(), "gemini".to_string()))
            .unwrap();
        assert_eq!(counter.input_tokens, 70);
        assert_eq!(counter.output_tokens, 25);
        assert_eq!(counter.cache_read_tokens, 30);
        assert_eq!(counter.reasoning_tokens, 5);
        assert_eq!(counter.total_tokens, 125);
        assert_eq!(counter.samples, 1);
        let hourly = delta
            .hourly
            .get(&("2026-10-29".to_string(), 12, "gemini".to_string()))
            .unwrap();
        assert_eq!(hourly.total_tokens, 125);
    }

    #[test]
    fn replays_gemini_updates_checkpoints_and_rewinds_without_duplicate_sessions() {
        let home = test_directory("gemini-replay");
        let root = home.join(".gemini/tmp/project/chats");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let timestamp = local_timestamp(2026, 10, 29, 12);
        let message = |id: &str, input: u64| {
            json!({"id": id, "type": "gemini", "timestamp": timestamp,
            "model": "gemini", "tokens": {"input": input, "output": 1}})
        };
        let mut file = File::create(&path).unwrap();
        for value in [
            json!({"sessionId": "one"}),
            message("one", 10),
            message("one", 20),
            message("two", 1000),
            json!({"$rewindTo": "two"}),
            json!({"$set": {"messages": [message("three", 30)]}}),
            message("four", 40),
            message("four", 50),
        ] {
            writeln!(file, "{value}").unwrap();
        }
        drop(file);
        fs::write(
            root.join("session.json"),
            json!({"messages": [message("old", 10000)]}).to_string(),
        )
        .unwrap();
        assert_eq!(source_files(&home, "gemini"), vec![path.clone()]);
        let mut delta = FileDelta::default();
        read_usage_file(&path, "gemini", &mut delta).unwrap();
        let total = delta_total(&delta);
        assert_eq!(total.input_tokens, 80);
        assert_eq!(total.total_tokens, 82);
        assert_eq!(delta.daily.len(), 1);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn parses_pi_omp_and_openai_details_without_adding_reasoning_twice() {
        for source in ["pi", "omp", "mcode", "copilot", "zcode"] {
            let sample = extract_usage(
                &json!({"message": {"model": "model", "usage": {
                    "input": 10, "output": 20, "cacheRead": 30, "cacheWrite": 40, "reasoning": 5
                }}}),
                source,
            )
            .unwrap();
            assert_eq!(sample.counter.total_tokens, 100, "{source}");
            assert_eq!(sample.counter.reasoning_tokens, 5);
            assert_eq!(sample.counter.cache_creation_tokens, 40);
        }
        let sample = extract_generic_usage(&json!({"usage": {
            "prompt_tokens": 100, "completion_tokens": 20,
            "prompt_tokens_details": {"cached_tokens": 30},
            "completion_tokens_details": {"reasoning_tokens": 5}
        }}))
        .unwrap();
        assert_eq!(sample.counter.input_tokens, 70);
        assert_eq!(sample.counter.total_tokens, 120);
        assert_eq!(sample.counter.reasoning_tokens, 5);
        let sample = extract_generic_usage(&json!({"message": {"model": "model", "usage": {
            "input": 10, "output": 20, "reasoningTokens": 5, "cost": {"total": 0.5}
        }}}))
        .unwrap();
        assert_eq!(sample.counter.reasoning_tokens, 5);
        assert_eq!(sample.counter.total_tokens, 30);
        assert_eq!(sample.counter.cost_usd, 0.5);
        let sample = extract_usage(
            &json!({"type": "assistant.usage", "data": {
                "model": "model", "inputTokens": 10, "outputTokens": 20
            }}),
            "copilot",
        )
        .unwrap();
        assert_eq!(sample.counter.total_tokens, 30);
        assert!(extract_generic_usage(&json!({"totalTokens": 1000000})).is_none());
    }

    #[test]
    fn keeps_the_latest_claude_message_usage_instead_of_counting_updates() {
        let root = test_directory("claude-updates");
        let path = root.join("session.jsonl");
        let timestamp = local_timestamp(2026, 10, 29, 12);
        let mut file = File::create(&path).unwrap();
        for output in [10, 20] {
            writeln!(file, "{}", json!({"timestamp": timestamp, "message": {
                "id": "one", "model": "claude", "usage": {"input_tokens": 100, "output_tokens": output}
            }})).unwrap();
        }
        drop(file);
        let mut delta = FileDelta::default();
        read_usage_file(&path, "claude", &mut delta).unwrap();
        assert_eq!(delta_total(&delta).total_tokens, 120);
        assert_eq!(delta_total(&delta).samples, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_nested_kimi_metadata_and_fractional_timestamps() {
        let value = json!({"time": 1793275200.125, "message": {"meta": {
            "model": {"id": "kimi-k2"}, "usage": {"inputOther": 10, "output": 20}
        }}});
        let sample = extract_usage(&value, "kimi").unwrap();
        assert_eq!(sample.model.as_deref(), Some("kimi-k2"));
        assert_eq!(
            extract_local_timestamp(&value).unwrap().timestamp_millis(),
            1793275200125
        );
        assert_eq!(sample.counter.total_tokens, 30);
        let sample = extract_codex_usage(&json!({"payload": {"type": "token_count", "info": {
            "total_token_usage": null, "last_token_usage": {"input_tokens": 100, "cached_input_tokens": 20, "output_tokens": 30}
        }}})).unwrap();
        assert_eq!(sample.counter.input_tokens, 80);
        assert_eq!(sample.counter.total_tokens, 130);
    }

    #[test]
    fn reads_opencode_sqlite_messages_read_only() {
        let root = test_directory("opencode-db");
        let path = root.join("opencode.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("CREATE TABLE message (data TEXT NOT NULL)")
            .unwrap();
        let created = Local
            .with_ymd_and_hms(2026, 10, 29, 12, 0, 0)
            .unwrap()
            .timestamp_millis();
        let value = json!({"modelID": "model", "time": {"created": created},
            "tokens": {"input": 10, "output": 20, "reasoning": 5, "cache": {"read": 30, "write": 40}}, "cost": 0.25});
        connection
            .execute("INSERT INTO message VALUES (?1)", [value.to_string()])
            .unwrap();
        drop(connection);
        let mut delta = FileDelta::default();
        read_usage_file(&path, "opencode", &mut delta).unwrap();
        let counter = delta
            .daily
            .get(&("2026-10-29".to_string(), "model".to_string()))
            .unwrap();
        assert_eq!(counter.total_tokens, 100);
        assert_eq!(counter.cache_read_tokens, 30);
        assert_eq!(counter.cache_creation_tokens, 40);
        assert_eq!(counter.cost_usd, 0.25);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn counts_codex_cumulative_deltas_once_on_the_correct_day() {
        let root = test_directory("codex-deltas");
        let path = root.join("rollout.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type": "turn_context", "payload": {"model": "gpt-test"}})
        )
        .unwrap();
        for (timestamp, input, cached, output) in [
            (local_timestamp(2026, 10, 29, 12), 100, 20, 30),
            (local_timestamp(2026, 10, 29, 12), 100, 20, 30),
            (local_timestamp(2026, 10, 30, 12), 160, 30, 50),
        ] {
            writeln!(file, "{}", json!({"timestamp": timestamp, "payload": {"type": "token_count", "info": {
                "total_token_usage": {"input_tokens": input, "cached_input_tokens": cached, "output_tokens": output}
            }}})).unwrap();
        }
        drop(file);
        let mut delta = FileDelta::default();
        read_usage_file(&path, "codex", &mut delta).unwrap();
        let first = delta
            .daily
            .get(&("2026-10-29".to_string(), "gpt-test".to_string()))
            .unwrap();
        assert_eq!(first.input_tokens, 80);
        assert_eq!(first.total_tokens, 130);
        let second = delta
            .daily
            .get(&("2026-10-30".to_string(), "gpt-test".to_string()))
            .unwrap();
        assert_eq!(second.input_tokens, 50);
        assert_eq!(second.total_tokens, 80);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn counts_codex_last_token_usage_when_present() {
        let root = test_directory("codex-last-usage");
        let path = root.join("rollout.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type": "turn_context", "payload": {"model": "gpt-test"}})
        )
        .unwrap();
        for (timestamp, total, last) in [
            (
                local_timestamp(2026, 10, 29, 12),
                (1000, 200, 600),
                (40, 10, 12),
            ),
            (
                local_timestamp(2026, 10, 29, 12),
                (2500, 500, 1400),
                (60, 15, 18),
            ),
            (
                local_timestamp(2026, 10, 30, 12),
                (9000, 900, 4000),
                (25, 5, 7),
            ),
        ] {
            writeln!(file, "{}", json!({"timestamp": timestamp, "payload": {"type": "token_count", "info": {
                "total_token_usage": {"input_tokens": total.0, "cached_input_tokens": total.1, "output_tokens": total.2},
                "last_token_usage": {"input_tokens": last.0, "cached_input_tokens": last.1, "output_tokens": last.2}
            }}})).unwrap();
        }
        drop(file);
        let mut delta = FileDelta::default();
        read_usage_file(&path, "codex", &mut delta).unwrap();
        let first = delta
            .daily
            .get(&("2026-10-29".to_string(), "gpt-test".to_string()))
            .unwrap();
        assert_eq!(first.input_tokens, 75);
        assert_eq!(first.output_tokens, 30);
        assert_eq!(first.cache_read_tokens, 25);
        assert_eq!(first.total_tokens, 130);
        let second = delta
            .daily
            .get(&("2026-10-30".to_string(), "gpt-test".to_string()))
            .unwrap();
        assert_eq!(second.input_tokens, 20);
        assert_eq!(second.output_tokens, 7);
        assert_eq!(second.cache_read_tokens, 5);
        assert_eq!(second.total_tokens, 32);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_codex_token_count_without_private_fields() {
        let value = json!({
            "timestamp": local_timestamp(2026, 10, 29, 12),
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 90,
                        "cached_input_tokens": 10,
                        "output_tokens": 50,
                        "reasoning_output_tokens": 5,
                        "total_tokens": 155,
                        "model": "gpt-5",
                        "cwd": "C:\\private"
                    }
                }
            }
        });
        let mut delta = FileDelta::default();
        add_value_usage(&value, "codex", Path::new("rollout.jsonl"), &mut delta);
        let counter = delta
            .daily
            .get(&("2026-10-29".to_string(), "gpt-5".to_string()))
            .unwrap();
        assert_eq!(counter.total_tokens, 155);
        assert_eq!(counter.cache_read_tokens, 10);
        let output = serde_json::to_string(&delta.daily.keys().collect::<Vec<_>>()).unwrap();
        assert!(!output.contains("private"));
    }

    #[test]
    fn parses_kimi_usage_and_uses_the_request_model() {
        let value = json!({
            "time": local_timestamp(2026, 10, 29, 12),
            "model": "kimi-k2",
            "usage": {
                "inputOther": 20,
                "inputCacheCreation": 3,
                "inputCacheRead": 4,
                "output": 9
            }
        });
        let mut delta = FileDelta::default();
        add_value_usage(&value, "kimi", Path::new("wire.jsonl"), &mut delta);
        let counter = delta
            .daily
            .get(&("2026-10-29".to_string(), "kimi-k2".to_string()))
            .unwrap();
        assert_eq!(counter.total_tokens, 36);
        assert_eq!(counter.input_tokens, 20);
    }

    #[test]
    fn parses_claude_message_usage() {
        let value = json!({
            "timestamp": local_timestamp(2026, 10, 29, 12),
            "message": {
                "model": "claude-sonnet",
                "usage": {
                    "input_tokens": 11,
                    "cache_creation_input_tokens": 5,
                    "cache_read_input_tokens": 3,
                    "output_tokens": 7
                }
            }
        });
        let mut delta = FileDelta::default();
        add_value_usage(&value, "claude", Path::new("session.jsonl"), &mut delta);
        assert_eq!(delta_total(&delta).total_tokens, 26);
    }

    #[test]
    fn buckets_samples_by_local_day_and_hour() {
        let value = json!({
            "timestamp": local_timestamp(2026, 10, 29, 23),
            "model": "model",
            "usage": {"input": 10, "output": 5}
        });
        let mut delta = FileDelta::default();
        add_value_usage(&value, "pi", Path::new("session.jsonl"), &mut delta);
        assert!(delta
            .daily
            .contains_key(&("2026-10-29".to_string(), "model".to_string())));
        assert!(delta
            .hourly
            .contains_key(&("2026-10-29".to_string(), 23, "model".to_string())));
    }

    #[test]
    fn malformed_lines_are_ignored_without_leaking_content() {
        let path =
            std::env::temp_dir().join(format!("cpa-agent-usage-{}.jsonl", std::process::id()));
        let mut file = File::create(&path).unwrap();
        writeln!(file, "not json").unwrap();
        writeln!(file, "{{\"usage\":{{\"input_tokens\":1,\"output_tokens\":2}},\"time\":\"2026-10-29T12:00:00Z\",\"model\":\"safe\",\"prompt\":\"private\"}}").unwrap();
        drop(file);
        let mut delta = FileDelta::default();
        read_usage_file(&path, "kimi", &mut delta).unwrap();
        assert_eq!(delta_total(&delta).total_tokens, 3);
        let output = serde_json::to_string(&delta.daily.keys().collect::<Vec<_>>()).unwrap();
        assert!(!output.contains("private"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn copilot_jsonc_config_and_malformed_json_do_not_fail_read_usage_file() {
        let home = test_directory("copilot-config");
        let copilot_dir = home.join(".copilot");
        fs::create_dir_all(&copilot_dir).unwrap();

        let config_path = copilot_dir.join("config.json");
        fs::write(
            &config_path,
            "// User settings belong in settings.json.\n{\"firstLaunchAt\": \"2026-01-01T00:00:00.000Z\"}\n",
        )
        .unwrap();

        // 1. source_files excludes config.json
        let files = source_files(&home, "copilot");
        assert!(!files.contains(&config_path));
        assert!(files.is_empty());

        // 2. read_usage_file on config.json with // comments returns Ok(())
        let mut delta = FileDelta::default();
        assert!(read_usage_file(&config_path, "copilot", &mut delta).is_ok());
        assert_eq!(delta_total(&delta).total_tokens, 0);

        // 3. read_usage_file on malformed non-JSON/JSON5 returns Ok(()) without breaking
        let malformed_path = copilot_dir.join("malformed.json");
        fs::write(&malformed_path, "// not valid json\n{ invalid :::").unwrap();
        let mut malformed_delta = FileDelta::default();
        assert!(read_usage_file(&malformed_path, "copilot", &mut malformed_delta).is_ok());
        assert_eq!(delta_total(&malformed_delta).total_tokens, 0);

        // 4. Valid session-state/events.jsonl is discovered and counted
        let session_dir = copilot_dir.join("session-state");
        fs::create_dir_all(&session_dir).unwrap();
        let events_path = session_dir.join("events.jsonl");
        let timestamp = local_timestamp(2026, 10, 29, 12);
        fs::write(
            &events_path,
            format!(
                "{}\n",
                json!({
                    "timestamp": timestamp,
                    "model": "copilot-model",
                    "usage": {
                        "input_tokens": 100,
                        "output_tokens": 50,
                        "total_tokens": 150
                    }
                })
            ),
        )
        .unwrap();

        let files_with_session = source_files(&home, "copilot");
        assert!(files_with_session.contains(&events_path));
        assert!(!files_with_session.contains(&config_path));

        let mut session_delta = FileDelta::default();
        read_usage_file(&events_path, "copilot", &mut session_delta).unwrap();
        assert_eq!(delta_total(&session_delta).total_tokens, 150);

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn proxy_usage_fallback_only_counts_codex_executors_or_unambiguous_sources() {
        let path =
            std::env::temp_dir().join(format!("cpa-agent-usage-proxy-{}.db", std::process::id()));
        let _ = fs::remove_file(&path);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE usage_events (
                    timestamp TEXT NOT NULL,
                    timestamp_ms INTEGER NOT NULL,
                    model TEXT NOT NULL,
                    response_model TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL,
                    reasoning_tokens INTEGER NOT NULL,
                    cache_read_tokens INTEGER NOT NULL,
                    cache_creation_tokens INTEGER NOT NULL,
                    total_tokens INTEGER NOT NULL,
                    source TEXT NOT NULL DEFAULT 'codex',
                    executor_type TEXT NOT NULL DEFAULT 'CodexExecutor'
                );
                CREATE TABLE model_prices (
                    model TEXT PRIMARY KEY,
                    source_model_id TEXT NOT NULL,
                    prompt_per_1m REAL NOT NULL,
                    completion_per_1m REAL NOT NULL,
                    cache_read_per_1m REAL NOT NULL,
                    cache_creation_per_1m REAL NOT NULL
                );",
            )
            .unwrap();
        let timestamp = local_timestamp(2026, 10, 29, 12);
        let timestamp_ms = Local
            .with_ymd_and_hms(2026, 10, 29, 12, 0, 0)
            .unwrap()
            .timestamp_millis();
        connection
            .execute(
                "INSERT INTO usage_events VALUES (?1, ?2, 'gpt-5', '', 120, 40, 2, 20, 0, 160, 'codex', 'CodexExecutor')",
                rusqlite::params![timestamp, timestamp_ms],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO model_prices VALUES ('gpt-5', '', 1.0, 2.0, 0.5, 0.0)",
                [],
            )
            .unwrap();
        for (source, executor) in [
            ("claude", "ClaudeExecutor"),
            ("codex", "ClaudeExecutor"),
            ("claude", ""),
        ] {
            connection.execute(
                "INSERT INTO usage_events VALUES (?1, ?2, 'other', '', 1000, 1000, 0, 0, 0, 2000, ?3, ?4)",
                rusqlite::params![timestamp, timestamp_ms, source, executor],
            ).unwrap();
        }
        drop(connection);

        let delta = proxy_codex_delta(&path).unwrap();
        let total = delta_total(&delta);
        assert_eq!(total.total_tokens, 160);
        assert_eq!(total.cache_read_tokens, 20);
        assert!((total.cost_usd - 0.00019).abs() < 0.0000001);
        assert!(delta
            .daily
            .contains_key(&("2026-10-29".to_string(), "gpt-5".to_string())));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn schedules_background_sync_from_the_saved_interval() {
        let mut preferences = BTreeMap::new();
        assert_eq!(background_interval_millis(&preferences), 300_000);
        preferences.insert(SYNC_INTERVAL_PREFERENCE.to_string(), "3600000".to_string());
        assert_eq!(background_interval_millis(&preferences), 3_600_000);
        preferences.insert(SYNC_INTERVAL_PREFERENCE.to_string(), "60000".to_string());
        assert_eq!(background_interval_millis(&preferences), 300_000);
        preferences.insert(SYNC_INTERVAL_PREFERENCE.to_string(), "0".to_string());
        assert_eq!(background_interval_millis(&preferences), 0);
        assert!(!sync_due(0, 0, 1_000));
        assert!(!sync_due(1_000_000, 0, 9_000_000));
        assert!(sync_due(0, 300_000, 1_000));
        assert!(!sync_due(1_000_000, 300_000, 1_200_000));
        assert!(sync_due(1_000_000, 300_000, 1_300_000));
    }

    #[test]
    fn keeps_sync_and_clear_mutually_exclusive() {
        let flag = AtomicBool::new(false);
        let guard = SyncGuard::acquire(&flag).unwrap();
        assert!(SyncGuard::acquire(&flag).is_none());
        drop(guard);
        assert!(SyncGuard::acquire(&flag).is_some());
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn reads_zcode_sqlite_database_filtering_account_providers() {
        let root = test_directory("zcode-db");
        let path = root.join("db.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE model_usage (
                    id TEXT PRIMARY KEY,
                    started_at INTEGER NOT NULL,
                    model_id TEXT,
                    provider_id TEXT,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    cache_read_input_tokens INTEGER,
                    cache_creation_input_tokens INTEGER,
                    reasoning_tokens INTEGER,
                    computed_total_tokens INTEGER
                );",
            )
            .unwrap();
        let timestamp = Local
            .with_ymd_and_hms(2026, 11, 2, 14, 0, 0)
            .unwrap()
            .timestamp_millis();
        connection
            .execute(
                "INSERT INTO model_usage VALUES ('1', ?1, 'deepseek-v4.1-flash', 'cpa-gui', 100, 20, 30, 10, 5, 120);",
                [timestamp],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO model_usage VALUES ('2', ?1, 'GLM-5.3-Flash', 'account:bigmodel-start-plan', 500, 50, 0, 0, 0, 550);",
                [timestamp],
            )
            .unwrap();
        drop(connection);

        let mut delta = FileDelta::default();
        read_zcode_database(&path, &mut delta).unwrap();
        let total = delta_total(&delta);
        assert_eq!(total.total_tokens, 120);
        assert_eq!(total.output_tokens, 20);
        assert_eq!(total.cache_read_tokens, 30);
        assert_eq!(total.cache_creation_tokens, 10);
        assert_eq!(total.input_tokens, 70);
        assert_eq!(delta.daily.len(), 1);
        assert!(delta
            .daily
            .contains_key(&("2026-11-02".to_string(), "deepseek-v4.1-flash".to_string())));
        assert!(!delta
            .daily
            .contains_key(&("2026-11-02".to_string(), "glm-5.3-flash".to_string())));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovers_zcode_custom_data_dir() {
        let home = test_directory("zcode-home");
        let v2 = home.join(".zcode").join("v2");
        fs::create_dir_all(&v2).unwrap();
        let custom = test_directory("zcode-custom");
        let custom_str = custom.to_string_lossy().replace(r#"\"#, r#"\\"#);
        fs::write(
            v2.join("setting.json"),
            format!(r#"{{"dataBaseDir": "{custom_str}"}}"#),
        )
        .unwrap();
        assert_eq!(read_zcode_custom_data_dir(&home), Some(custom.clone()));
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(custom).unwrap();
    }

    #[test]
    fn codex_prefers_last_token_usage_without_subagent_history_inflation() {
        let sample = extract_codex_usage(&json!({
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 800000000,
                        "output_tokens": 1000000,
                        "cached_input_tokens": 700000000,
                        "total_tokens": 801000000
                    },
                    "last_token_usage": {
                        "input_tokens": 500,
                        "output_tokens": 50,
                        "cached_input_tokens": 100,
                        "total_tokens": 550
                    }
                }
            }
        }))
        .unwrap();
        assert_eq!(sample.counter.input_tokens, 400);
        assert_eq!(sample.counter.output_tokens, 50);
        assert_eq!(sample.counter.cache_read_tokens, 100);
        assert_eq!(sample.counter.total_tokens, 550);
    }
}
