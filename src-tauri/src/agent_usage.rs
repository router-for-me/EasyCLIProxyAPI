use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

const MAX_SCAN_FILES: usize = 20_000;
const MAX_JSON_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MODEL_NAME_CHARS: usize = 120;

const SOURCE_NAMES: &[&str] = &[
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUsageReport {
    schema_version: u8,
    generated_at: String,
    sources: Vec<AgentUsageSource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUsageSource {
    source: String,
    status: String,
    error: String,
    daily: Vec<AgentUsageDaily>,
    events: Vec<AgentUsageDaily>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUsageDaily {
    date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    #[serde(rename = "reasoningOutputTokens")]
    reasoning_tokens: u64,
    total_tokens: u64,
    #[serde(rename = "costUSD")]
    cost_usd: f64,
    models: Vec<AgentUsageModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUsageModel {
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    #[serde(rename = "reasoningOutputTokens")]
    reasoning_tokens: u64,
    total_tokens: u64,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
}

#[derive(Debug, Default, Clone)]
struct UsageCounter {
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    reasoning_tokens: u64,
    total_tokens: u64,
    cost_usd: f64,
}

#[derive(Debug, Default)]
struct DayAggregate {
    totals: UsageCounter,
    models: BTreeMap<String, UsageCounter>,
}

#[derive(Debug, Clone)]
struct UsageSample {
    counter: UsageCounter,
    model: Option<String>,
}

#[tauri::command]
pub(crate) async fn get_agent_usage(app: tauri::AppHandle) -> Result<AgentUsageReport, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;

    let proxy_usage_database = crate::usage::usage_database_path().ok();

    tauri::async_runtime::spawn_blocking(move || {
        build_report(&home, proxy_usage_database.as_deref())
    })
    .await
    .map_err(|error| format!("Failed to read local Agent usage: {error}"))
}

fn build_report(home: &Path, proxy_usage_database: Option<&Path>) -> AgentUsageReport {
    let sources = SOURCE_NAMES
        .iter()
        .map(|source| {
            let local = read_source(home, source);
            if *source == "codex" && local.status == "empty" {
                if let Some(database) = proxy_usage_database {
                    if let Some(aggregate) = read_proxy_codex_usage(database) {
                        return source_from_aggregate("codex", aggregate);
                    }
                }
            }
            local
        })
        .collect();

    AgentUsageReport {
        schema_version: 1,
        generated_at: Utc::now().to_rfc3339(),
        sources,
    }
}

fn read_source(home: &Path, source: &str) -> AgentUsageSource {
    let files = source_files(home, source);
    if files.is_empty() {
        return empty_source(source);
    }

    let mut aggregate: BTreeMap<String, DayAggregate> = BTreeMap::new();
    let mut readable_files = 0usize;
    let mut failed_files = 0usize;

    for path in files {
        match read_usage_file(&path, source, &mut aggregate) {
            Ok(()) => readable_files += 1,
            Err(_) => failed_files += 1,
        }
    }

    if readable_files == 0 && failed_files > 0 {
        return AgentUsageSource {
            source: source.to_string(),
            status: "error".to_string(),
            error: "Unable to read local usage records".to_string(),
            daily: Vec::new(),
            events: Vec::new(),
        };
    }

    source_from_aggregate(source, aggregate)
}

fn source_from_aggregate(
    source: &str,
    aggregate: BTreeMap<String, DayAggregate>,
) -> AgentUsageSource {
    let rows = aggregate
        .into_iter()
        .map(|(date, day)| AgentUsageDaily {
            timestamp: date.contains('T').then(|| date.clone()),
            date: date.chars().take(10).collect(),
            input_tokens: day.totals.input_tokens,
            output_tokens: day.totals.output_tokens,
            cache_creation_tokens: day.totals.cache_creation_tokens,
            cache_read_tokens: day.totals.cache_read_tokens,
            reasoning_tokens: day.totals.reasoning_tokens,
            total_tokens: day.totals.total_tokens,
            cost_usd: day.totals.cost_usd,
            models: day
                .models
                .into_iter()
                .map(|(model, counter)| AgentUsageModel {
                    model,
                    input_tokens: counter.input_tokens,
                    output_tokens: counter.output_tokens,
                    cache_creation_tokens: counter.cache_creation_tokens,
                    cache_read_tokens: counter.cache_read_tokens,
                    reasoning_tokens: counter.reasoning_tokens,
                    total_tokens: counter.total_tokens,
                    cost_usd: (counter.cost_usd > 0.0).then_some(counter.cost_usd),
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    let (daily, events): (Vec<_>, Vec<_>) =
        rows.into_iter().partition(|row| row.timestamp.is_none());

    AgentUsageSource {
        source: source.to_string(),
        status: if daily.is_empty() {
            "empty".to_string()
        } else {
            "ok".to_string()
        },
        error: String::new(),
        daily,
        events,
    }
}

#[derive(Debug, Clone, Copy)]
struct ProxyModelPrice {
    prompt: f64,
    completion: f64,
    cache_read: f64,
    cache_creation: f64,
}

fn read_proxy_codex_usage(path: &Path) -> Option<BTreeMap<String, DayAggregate>> {
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
                },
            ))
        })
        .ok()?;

    let mut aggregate: BTreeMap<String, DayAggregate> = BTreeMap::new();
    let mut row_count = 0usize;
    for row in rows.flatten() {
        let (timestamp, model, mut counter) = row;
        let Some(date) = proxy_date(&timestamp) else {
            continue;
        };
        if let Some(price) = prices.get(&model.to_ascii_lowercase()) {
            counter.cost_usd = proxy_cost(&counter, price);
        }
        for key in [date, timestamp] {
            let day = aggregate.entry(key).or_default();
            add_counter(&mut day.totals, &counter);
            if !model.trim().is_empty() {
                add_counter(day.models.entry(model.clone()).or_default(), &counter);
            }
        }
        row_count += 1;
    }
    (row_count > 0).then_some(aggregate)
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

fn proxy_date(timestamp: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn empty_source(source: &str) -> AgentUsageSource {
    AgentUsageSource {
        source: source.to_string(),
        status: "empty".to_string(),
        error: String::new(),
        daily: Vec::new(),
        events: Vec::new(),
    }
}

fn source_files(home: &Path, source: &str) -> Vec<PathBuf> {
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
        "mcode" | "zcode" => {
            roots.push(home.join(format!(".{source}/sessions")));
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
            roots.push(home.join(".copilot"));
            if let Some(app_data) = env::var_os("APPDATA") {
                roots.push(PathBuf::from(app_data).join("GitHub Copilot"));
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

fn read_usage_file(
    path: &Path,
    source: &str,
    aggregate: &mut BTreeMap<String, DayAggregate>,
) -> Result<(), ()> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_file() {
        return Ok(());
    }
    if extension.eq_ignore_ascii_case("db") {
        return read_opencode_database(path, aggregate);
    }
    if metadata.len() > MAX_JSON_FILE_BYTES {
        return Ok(());
    }

    let file = File::open(path).map_err(|_| ())?;
    if extension.eq_ignore_ascii_case("json") {
        let value: Value = serde_json::from_reader(file).map_err(|_| ())?;
        add_value_usage(&value, source, path, aggregate);
        return Ok(());
    }

    let reader = BufReader::new(file);
    let mut codex_total = UsageCounter::default();
    let mut codex_model = None;
    let mut claude_messages = HashMap::new();
    let mut gemini_messages = Vec::new();
    let mut gemini_positions = HashMap::new();
    for line in reader.lines() {
        let line = line.map_err(|_| ())?;
        if line.len() > MAX_JSON_FILE_BYTES as usize {
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
                add_value_usage(&value, source, path, aggregate);
            }
        } else if source == "codex" {
            if value["type"] == "turn_context" {
                codex_model = value["payload"]["model"].as_str().map(sanitize_model_name);
            }
            if let Some(mut sample) = extract_codex_usage(&value) {
                if value
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
                add_sample_usage(sample, &value, path, aggregate);
            }
        } else {
            if source == "claude" && extract_claude_usage(&value).is_some() {
                if let Some(id) = value.pointer("/message/id").and_then(Value::as_str) {
                    claude_messages.insert(id.to_string(), value);
                    continue;
                }
            }
            add_value_usage(&value, source, path, aggregate);
        }
    }
    for value in claude_messages.into_values() {
        add_value_usage(&value, source, path, aggregate);
    }
    for value in gemini_messages {
        add_value_usage(&value, source, path, aggregate);
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

fn read_opencode_database(
    path: &Path,
    aggregate: &mut BTreeMap<String, DayAggregate>,
) -> Result<(), ()> {
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
        if data.len() > MAX_JSON_FILE_BYTES as usize {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            add_value_usage(&value, "opencode", path, aggregate);
        }
    }
    Ok(())
}

fn add_value_usage(
    value: &Value,
    source: &str,
    path: &Path,
    aggregate: &mut BTreeMap<String, DayAggregate>,
) {
    if let Some(messages) = value
        .as_array()
        .or_else(|| value.get("messages").and_then(Value::as_array))
    {
        for message in messages {
            add_value_usage(message, source, path, aggregate);
        }
        return;
    }
    let Some(sample) = extract_usage(value, source) else {
        return;
    };
    add_sample_usage(sample, value, path, aggregate);
}

fn add_sample_usage(
    sample: UsageSample,
    value: &Value,
    path: &Path,
    aggregate: &mut BTreeMap<String, DayAggregate>,
) {
    let Some(date) = extract_date(value).or_else(|| file_date(path)) else {
        return;
    };

    let timestamp = extract_timestamp(value)
        .or_else(|| {
            fs::metadata(path)
                .ok()?
                .modified()
                .ok()
                .map(DateTime::<Utc>::from)
        })
        .map(|time| time.to_rfc3339());
    for key in std::iter::once(date).chain(timestamp) {
        let day = aggregate.entry(key).or_default();
        add_counter(&mut day.totals, &sample.counter);
        if let Some(model) = &sample.model {
            add_counter(
                day.models.entry(model.clone()).or_default(),
                &sample.counter,
            );
        }
    }
}

fn extract_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    let object = value.as_object()?;
    for key in ["timestamp", "time", "created_at", "createdAt", "date"] {
        let Some(value) = object.get(key) else {
            continue;
        };
        if let Some(text) = value.as_str() {
            if let Ok(time) = DateTime::parse_from_rfc3339(text) {
                return Some(time.with_timezone(&Utc));
            }
            if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
                return date.and_hms_opt(0, 0, 0).map(|time| time.and_utc());
            }
        }
        let value = value.get("created").unwrap_or(value);
        if let Some(number) = value.as_f64().filter(|number| number.is_finite()) {
            let millis = if number.abs() > 10_000_000_000.0 {
                number
            } else {
                number * 1000.0
            };
            if millis >= i64::MIN as f64 && millis <= i64::MAX as f64 {
                return DateTime::from_timestamp_millis(millis as i64);
            }
        }
    }
    for key in ["message", "payload", "data"] {
        if let Some(time) = object.get(key).and_then(extract_timestamp) {
            return Some(time);
        }
    }
    None
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
                .get("total_token_usage")
                .and_then(Value::as_object)
                .or_else(|| object.get("last_token_usage").and_then(Value::as_object))
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

fn extract_date(value: &Value) -> Option<String> {
    if let Some(timestamp) = extract_timestamp(value) {
        return Some(timestamp.format("%Y-%m-%d").to_string());
    }
    let object = value.as_object()?;
    for key in ["timestamp", "time", "created_at", "createdAt", "date"] {
        if let Some(time) = object.get(key).and_then(Value::as_object) {
            if let Some(date) = time.get("created").and_then(date_value) {
                return Some(date);
            }
        }
        if let Some(date) = object.get(key).and_then(date_value) {
            return Some(date);
        }
    }
    None
}

fn date_value(value: &Value) -> Option<String> {
    if let Some(string) = value.as_str() {
        return valid_date_prefix(string).map(str::to_string);
    }
    let seconds = value.as_i64()?;
    let millis = if seconds.unsigned_abs() > 10_000_000_000 {
        seconds
    } else {
        seconds.saturating_mul(1_000)
    };
    DateTime::<Utc>::from_timestamp_millis(millis).map(|date| date.format("%Y-%m-%d").to_string())
}

fn valid_date_prefix(value: &str) -> Option<&str> {
    let prefix = value.get(..10)?;
    let bytes = prefix.as_bytes();
    if chrono::NaiveDate::parse_from_str(prefix, "%Y-%m-%d").is_ok()
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        Some(prefix)
    } else {
        None
    }
}

fn file_date(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    DateTime::<Utc>::from_timestamp_millis(duration.as_millis().try_into().ok()?)
        .map(|date| date.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn test_directory(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!("cpa-usage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
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
    fn enforces_scan_depth_and_file_size_limits() {
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
        for extension in ["json", "jsonl"] {
            let path = root.join(format!("large.{extension}"));
            let mut file = File::create(&path).unwrap();
            writeln!(file, "{{\"usage\":{{\"input_tokens\":100}}}}").unwrap();
            file.set_len(MAX_JSON_FILE_BYTES + 1).unwrap();
            let mut aggregate = BTreeMap::new();
            read_usage_file(&path, "pi", &mut aggregate).unwrap();
            assert!(aggregate.is_empty());
        }
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
            {"timestamp": "2026-10-29T12:00:00Z", "model": "gemini", "tokens": {
                "input": 100, "output": 20, "cached": 30, "thoughts": 5
            }},
            {"type": "user", "content": "private"}
        ]});
        let mut aggregate = BTreeMap::new();
        add_value_usage(&value, "gemini", Path::new("session.json"), &mut aggregate);
        let counter = &aggregate["2026-10-29"].totals;
        assert_eq!(counter.input_tokens, 70);
        assert_eq!(counter.output_tokens, 25);
        assert_eq!(counter.cache_read_tokens, 30);
        assert_eq!(counter.reasoning_tokens, 5);
        assert_eq!(counter.total_tokens, 125);
        let report = source_from_aggregate("gemini", aggregate);
        assert_eq!(report.daily.len(), 1);
        assert_eq!(report.events.len(), 1);
        assert_eq!(
            report.events[0].timestamp.as_deref(),
            Some("2026-10-29T12:00:00+00:00")
        );
    }

    #[test]
    fn replays_gemini_updates_checkpoints_and_rewinds_without_duplicate_sessions() {
        let home = test_directory("gemini-replay");
        let root = home.join(".gemini/tmp/project/chats");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let message = |id: &str, input: u64| {
            json!({"id": id, "type": "gemini", "timestamp": "2026-10-29T12:00:00Z",
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
        let source = read_source(&home, "gemini");
        assert_eq!(source_files(&home, "gemini"), vec![path]);
        assert_eq!(source.daily.len(), 1);
        assert_eq!(source.daily[0].input_tokens, 80);
        assert_eq!(source.daily[0].total_tokens, 82);
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
        let mut file = File::create(&path).unwrap();
        for output in [10, 20] {
            writeln!(file, "{}", json!({"timestamp": "2026-10-29T12:00:00Z", "message": {
                "id": "one", "model": "claude", "usage": {"input_tokens": 100, "output_tokens": output}
            }})).unwrap();
        }
        drop(file);
        let mut aggregate = BTreeMap::new();
        read_usage_file(&path, "claude", &mut aggregate).unwrap();
        assert_eq!(aggregate["2026-10-29"].totals.total_tokens, 120);
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
            extract_timestamp(&value).unwrap().timestamp_millis(),
            1793275200125
        );
        assert_eq!(sample.counter.total_tokens, 30);
        assert!(valid_date_prefix("2026-02-30").is_none());
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
        let value = json!({"modelID": "model", "time": {"created": 1793275200000i64},
            "tokens": {"input": 10, "output": 20, "reasoning": 5, "cache": {"read": 30, "write": 40}}, "cost": 0.25});
        connection
            .execute("INSERT INTO message VALUES (?1)", [value.to_string()])
            .unwrap();
        drop(connection);
        let mut aggregate = BTreeMap::new();
        read_usage_file(&path, "opencode", &mut aggregate).unwrap();
        let day = aggregate.values().next().unwrap();
        assert_eq!(day.totals.total_tokens, 100);
        assert_eq!(day.totals.cache_read_tokens, 30);
        assert_eq!(day.totals.cache_creation_tokens, 40);
        assert_eq!(day.totals.cost_usd, 0.25);
        assert!(day.models.contains_key("model"));
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
            ("2026-10-29T23:00:00Z", 100, 20, 30),
            ("2026-10-29T23:00:00Z", 100, 20, 30),
            ("2026-10-30T01:00:00Z", 160, 30, 50),
        ] {
            writeln!(file, "{}", json!({"timestamp": timestamp, "payload": {"type": "token_count", "info": {
                "total_token_usage": {"input_tokens": input, "cached_input_tokens": cached, "output_tokens": output},
                "last_token_usage": {"input_tokens": 9999}
            }}})).unwrap();
        }
        drop(file);
        let mut aggregate = BTreeMap::new();
        read_usage_file(&path, "codex", &mut aggregate).unwrap();
        assert_eq!(aggregate["2026-10-29"].totals.input_tokens, 80);
        assert_eq!(aggregate["2026-10-29"].totals.total_tokens, 130);
        assert_eq!(aggregate["2026-10-30"].totals.input_tokens, 50);
        assert_eq!(aggregate["2026-10-30"].totals.total_tokens, 80);
        assert!(aggregate["2026-10-30"].models.contains_key("gpt-test"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_codex_token_count_without_private_fields() {
        let value = json!({
            "timestamp": "2026-10-29T12:00:00Z",
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
        let mut aggregate = BTreeMap::new();
        add_value_usage(&value, "codex", Path::new("rollout.jsonl"), &mut aggregate);
        let row = &aggregate["2026-10-29"];
        assert_eq!(row.totals.total_tokens, 155);
        assert_eq!(row.totals.cache_read_tokens, 10);
        assert!(row.models.contains_key("gpt-5"));
        let output = serde_json::to_string(&row.models.keys().collect::<Vec<_>>()).unwrap();
        assert!(!output.contains("private"));
    }

    #[test]
    fn parses_kimi_usage_and_uses_the_request_model() {
        let value = json!({
            "time": "2026-10-29T12:00:00Z",
            "model": "kimi-k2",
            "usage": {
                "inputOther": 20,
                "inputCacheCreation": 3,
                "inputCacheRead": 4,
                "output": 9
            }
        });
        let mut aggregate = BTreeMap::new();
        add_value_usage(&value, "kimi", Path::new("wire.jsonl"), &mut aggregate);
        let row = &aggregate["2026-10-29"];
        assert_eq!(row.totals.total_tokens, 36);
        assert_eq!(row.totals.input_tokens, 20);
        assert!(row.models.contains_key("kimi-k2"));
    }

    #[test]
    fn parses_claude_message_usage() {
        let value = json!({
            "timestamp": "2026-10-29T12:00:00Z",
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
        let mut aggregate = BTreeMap::new();
        add_value_usage(&value, "claude", Path::new("session.jsonl"), &mut aggregate);
        assert_eq!(aggregate["2026-10-29"].totals.total_tokens, 26);
    }

    #[test]
    fn malformed_lines_are_ignored_without_leaking_content() {
        let path =
            std::env::temp_dir().join(format!("cpa-agent-usage-{}.jsonl", std::process::id()));
        let mut file = File::create(&path).unwrap();
        writeln!(file, "not json").unwrap();
        writeln!(file, "{{\"usage\":{{\"input_tokens\":1,\"output_tokens\":2}},\"time\":\"2026-10-29T00:00:00Z\",\"model\":\"safe\",\"prompt\":\"private\"}}").unwrap();
        drop(file);
        let mut aggregate = BTreeMap::new();
        read_usage_file(&path, "kimi", &mut aggregate).unwrap();
        assert_eq!(aggregate["2026-10-29"].totals.total_tokens, 3);
        assert!(aggregate["2026-10-29"]
            .models
            .keys()
            .all(|model| model != "private"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn proxy_usage_fallback_only_counts_codex_executors_or_unambiguous_sources() {
        let path =
            std::env::temp_dir().join(format!("cpa-agent-usage-proxy-{}.db", std::process::id()));
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
        let timestamp = Utc::now().to_rfc3339();
        let timestamp_ms = Utc::now().timestamp_millis();
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

        let aggregate = read_proxy_codex_usage(&path).unwrap();
        let day = aggregate.values().next().unwrap();
        assert_eq!(day.totals.total_tokens, 160);
        assert_eq!(day.totals.cache_read_tokens, 20);
        assert!((day.totals.cost_usd - 0.00019).abs() < 0.0000001);
        assert!(day.models.contains_key("gpt-5"));
        let _ = fs::remove_file(path);
    }
}
