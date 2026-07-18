use super::{
    current_core_status, management_authorization, management_endpoint, management_http_client,
    CoreProcessState, GuiConfigFile, GuiConfigState,
};
use chrono::{DateTime, Local};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row,
    Transaction,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

const USAGE_DIR_NAME: &str = "usage-records";
const USAGE_DATABASE_FILE: &str = "usage.db";
const LEGACY_USAGE_EVENTS_DIR: &str = "events";
const LEGACY_USAGE_INBOX_DIR: &str = "inbox";
const LEGACY_JSON_MIGRATION_KEY: &str = "legacy_json_v1";
const USAGE_UPDATED_EVENT: &str = "usage-records-updated";
const USAGE_SCHEMA_VERSION: u8 = 1;
const USAGE_QUEUE_BATCH_SIZE: usize = 500;
const SQLITE_BUSY_TIMEOUT_SECONDS: u64 = 5;

pub(crate) struct UsageCollectorState {
    inner: Mutex<UsageCollectorInner>,
}

struct UsageCollectorInner {
    token: Option<CancellationToken>,
    status: UsageCollectorStatus,
}

impl Default for UsageCollectorState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(UsageCollectorInner {
                token: None,
                status: UsageCollectorStatus::waiting(),
            }),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageCollectorStatus {
    state: String,
    message: String,
    last_collected_at: Option<String>,
    total_records: u64,
}

impl UsageCollectorStatus {
    fn waiting() -> Self {
        Self {
            state: "waiting-core".to_string(),
            message: "等待内核启动".to_string(),
            last_collected_at: None,
            total_records: 0,
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct UsageTokenStats {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    reasoning_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    #[serde(default)]
    cache_creation_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct UsageRecord {
    id: String,
    timestamp: String,
    #[serde(default)]
    latency_ms: u64,
    #[serde(default)]
    ttft_ms: Option<u64>,
    #[serde(default)]
    source: String,
    #[serde(default)]
    auth_index: String,
    #[serde(default)]
    failed: bool,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    alias: String,
    #[serde(default)]
    reasoning_effort: String,
    #[serde(default)]
    service_tier: String,
    #[serde(default)]
    response_service_tier: String,
    #[serde(default)]
    executor_type: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    auth_type: String,
    #[serde(default)]
    api_key_hash: String,
    #[serde(default)]
    api_key_display: String,
    #[serde(default)]
    api_key_remark: String,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    tokens: UsageTokenStats,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyUsageHourFile {
    schema_version: u8,
    records: Vec<UsageRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyUsageInboxFile {
    schema_version: u8,
    records: Vec<UsageRecord>,
}

#[derive(Clone, Default, Deserialize)]
pub(crate) struct UsageQuery {
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    api_key_hash: Option<String>,
    #[serde(default)]
    failed: Option<bool>,
    #[serde(default)]
    page: Option<usize>,
    #[serde(default)]
    page_size: Option<usize>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageOverview {
    total_requests: u64,
    success_count: u64,
    failure_count: u64,
    success_rate: f64,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    rpm: f64,
    tpm: f64,
    average_latency_ms: f64,
    timeline: Vec<UsageTimelinePoint>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageTimelinePoint {
    hour: String,
    requests: u64,
    success: u64,
    failure: u64,
    tokens: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageAnalysis {
    models: Vec<UsageCategory>,
    providers: Vec<UsageCategory>,
    sources: Vec<UsageCategory>,
    api_keys: Vec<UsageCategory>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageCategory {
    key: String,
    label: String,
    requests: u64,
    failures: u64,
    tokens: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageEventPage {
    items: Vec<UsageRecord>,
    total: usize,
    page: usize,
    page_size: usize,
    total_pages: usize,
}

struct UsageSqlFilter {
    clause: String,
    params: Vec<SqlValue>,
}

impl UsageCollectorState {
    fn start(&self) -> Option<CancellationToken> {
        let mut inner = self.inner.lock().ok()?;
        if inner.token.is_some() {
            return None;
        }
        let token = CancellationToken::new();
        inner.token = Some(token.clone());
        Some(token)
    }

    fn stop(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(token) = inner.token.take() {
                token.cancel();
            }
        }
    }

    fn set_status(&self, status: UsageCollectorStatus) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = status;
        }
    }

    fn status(&self) -> Result<UsageCollectorStatus, String> {
        self.inner
            .lock()
            .map(|inner| inner.status.clone())
            .map_err(|_| "使用记录采集状态锁已损坏".to_string())
    }
}

pub(crate) fn initialize_usage_storage() -> Result<(), String> {
    initialize_usage_storage_at(&usage_root_dir()?)
}

fn initialize_usage_storage_at(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("创建使用记录目录失败: {error}"))?;
    let mut connection = open_usage_database_at(root)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("启用 SQLite WAL 失败: {error}"))?;
    initialize_usage_schema(&connection)?;
    migrate_legacy_json_storage(&mut connection, root)
}

fn initialize_usage_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS usage_metadata (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usage_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL UNIQUE,
                timestamp TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                local_hour TEXT NOT NULL,
                latency_ms INTEGER NOT NULL DEFAULT 0,
                ttft_ms INTEGER,
                source TEXT NOT NULL DEFAULT '',
                auth_index TEXT NOT NULL DEFAULT '',
                failed INTEGER NOT NULL DEFAULT 0,
                provider TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                alias TEXT NOT NULL DEFAULT '',
                reasoning_effort TEXT NOT NULL DEFAULT '',
                service_tier TEXT NOT NULL DEFAULT '',
                response_service_tier TEXT NOT NULL DEFAULT '',
                executor_type TEXT NOT NULL DEFAULT '',
                endpoint TEXT NOT NULL DEFAULT '',
                auth_type TEXT NOT NULL DEFAULT '',
                api_key_hash TEXT NOT NULL DEFAULT '',
                api_key_display TEXT NOT NULL DEFAULT '',
                api_key_remark TEXT NOT NULL DEFAULT '',
                request_id TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp
                ON usage_events(timestamp_ms DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_local_hour
                ON usage_events(local_hour, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_model_timestamp
                ON usage_events(model, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_provider_timestamp
                ON usage_events(provider, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_source_timestamp
                ON usage_events(source, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_api_key_timestamp
                ON usage_events(api_key_hash, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_failed_timestamp
                ON usage_events(failed, timestamp_ms DESC);

            PRAGMA user_version = 1;
            "#,
        )
        .map_err(|error| format!("初始化 SQLite 使用记录结构失败: {error}"))
}

fn open_usage_database() -> Result<Connection, String> {
    open_usage_database_at(&usage_root_dir()?)
}

fn open_usage_database_at(root: &Path) -> Result<Connection, String> {
    fs::create_dir_all(root).map_err(|error| format!("创建使用记录目录失败: {error}"))?;
    let path = root.join(USAGE_DATABASE_FILE);
    let connection = Connection::open(&path)
        .map_err(|error| format!("打开 SQLite 使用记录数据库失败 {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_SECONDS))
        .map_err(|error| format!("设置 SQLite busy timeout 失败: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("启用 SQLite foreign keys 失败: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("设置 SQLite synchronous 模式失败: {error}"))?;
    Ok(connection)
}

fn migrate_legacy_json_storage(connection: &mut Connection, root: &Path) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![LEGACY_JSON_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("读取旧使用记录迁移状态失败: {error}"))?
        .is_some();
    if migrated {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始旧使用记录迁移事务失败: {error}"))?;
    let mut migrated_records = 0_usize;

    for path in sorted_json_files(&root.join(LEGACY_USAGE_EVENTS_DIR))? {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("读取旧使用记录失败 {}: {error}", path.display()))?;
        let file = serde_json::from_str::<LegacyUsageHourFile>(&content)
            .map_err(|error| format!("解析旧使用记录失败 {}: {error}", path.display()))?;
        validate_legacy_schema(file.schema_version, &path)?;
        migrated_records = migrated_records.saturating_add(insert_usage_records_in_transaction(
            &transaction,
            &file.records,
        )?);
    }

    for path in sorted_json_files(&root.join(LEGACY_USAGE_INBOX_DIR))? {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("读取旧使用记录收件箱失败 {}: {error}", path.display()))?;
        let file = serde_json::from_str::<LegacyUsageInboxFile>(&content)
            .map_err(|error| format!("解析旧使用记录收件箱失败 {}: {error}", path.display()))?;
        validate_legacy_schema(file.schema_version, &path)?;
        migrated_records = migrated_records.saturating_add(insert_usage_records_in_transaction(
            &transaction,
            &file.records,
        )?);
    }

    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![LEGACY_JSON_MIGRATION_KEY, migrated_records.to_string()],
        )
        .map_err(|error| format!("记录旧使用记录迁移状态失败: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交旧使用记录迁移失败: {error}"))?;
    Ok(())
}

fn sorted_json_files(directory: &Path) -> Result<Vec<PathBuf>, String> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(directory)
        .map_err(|error| format!("读取旧使用记录目录失败 {}: {error}", directory.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn validate_legacy_schema(version: u8, path: &Path) -> Result<(), String> {
    if version == USAGE_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(format!(
            "不支持的旧使用记录版本 {version}: {}",
            path.display()
        ))
    }
}

pub(crate) fn start_usage_collector(app: tauri::AppHandle) {
    let state = app.state::<UsageCollectorState>();
    let Some(token) = state.start() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        usage_collector_loop(app, token).await;
    });
}

pub(crate) fn stop_usage_collector(app: &tauri::AppHandle) {
    app.state::<UsageCollectorState>().stop();
}

async fn usage_collector_loop(app: tauri::AppHandle, token: CancellationToken) {
    let root = match usage_root_dir() {
        Ok(root) => root,
        Err(error) => {
            set_collector_error(&app, error);
            return;
        }
    };

    let mut retry_seconds = 1_u64;
    loop {
        if token.is_cancelled() {
            return;
        }
        let config = match app.state::<GuiConfigState>().snapshot() {
            Ok(config) => config,
            Err(error) => {
                set_collector_error(&app, error);
                wait_or_cancel(&token, retry_seconds).await;
                retry_seconds = (retry_seconds * 2).min(10);
                continue;
            }
        };
        let process_state = app.state::<CoreProcessState>();
        let core_running = current_core_status(Some(process_state.inner()), Some(config.port))
            .map(|status| status.running)
            .unwrap_or(false);
        if !core_running {
            set_collector_status(&app, "waiting-core", "等待内核启动", None);
            retry_seconds = 1;
            wait_or_cancel(&token, 1).await;
            continue;
        }

        match fetch_usage_queue(&config).await {
            Ok(items) if items.is_empty() => {
                set_collector_status(&app, "collecting", "使用记录采集中", None);
                retry_seconds = 1;
                wait_or_cancel(&token, 1).await;
            }
            Ok(items) => match persist_queue_items(&root, items, &config) {
                Ok(saved) => {
                    let collected_at = Local::now().to_rfc3339();
                    set_collector_status(
                        &app,
                        "collecting",
                        &format!("已保存 {saved} 条新记录"),
                        Some(collected_at.clone()),
                    );
                    if saved > 0 {
                        let _ = app.emit(USAGE_UPDATED_EVENT, collected_at);
                    }
                    retry_seconds = 1;
                }
                Err(error) => {
                    set_collector_error(&app, error);
                    wait_or_cancel(&token, retry_seconds).await;
                    retry_seconds = (retry_seconds * 2).min(10);
                }
            },
            Err(error) => {
                set_collector_error(&app, error);
                wait_or_cancel(&token, retry_seconds).await;
                retry_seconds = (retry_seconds * 2).min(10);
            }
        }
    }
}

async fn wait_or_cancel(token: &CancellationToken, seconds: u64) {
    tokio::select! {
        _ = token.cancelled() => {},
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => {},
    }
}

async fn fetch_usage_queue(config: &GuiConfigFile) -> Result<Vec<Value>, String> {
    let client = management_http_client()?;
    let response = client
        .get(management_endpoint(config, "usage-queue")?)
        .header("Authorization", management_authorization(config)?)
        .query(&[("count", USAGE_QUEUE_BATCH_SIZE)])
        .send()
        .await
        .map_err(|error| format!("读取 CPA 使用记录队列失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取 CPA 使用记录响应失败: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "CPA 使用记录队列返回 HTTP {}: {}",
            status.as_u16(),
            text.trim()
        ));
    }
    serde_json::from_str::<Vec<Value>>(&text)
        .map_err(|error| format!("解析 CPA 使用记录失败: {error}"))
}

fn set_collector_error(app: &tauri::AppHandle, error: String) {
    set_collector_status(app, "error", &error, None);
}

fn set_collector_status(
    app: &tauri::AppHandle,
    state_name: &str,
    message: &str,
    last_collected_at: Option<String>,
) {
    let state = app.state::<UsageCollectorState>();
    let previous = state.status().ok();
    let total_records = total_usage_records()
        .ok()
        .or_else(|| previous.as_ref().map(|value| value.total_records))
        .unwrap_or(0);
    state.set_status(UsageCollectorStatus {
        state: state_name.to_string(),
        message: message.to_string(),
        last_collected_at: last_collected_at
            .or_else(|| previous.and_then(|value| value.last_collected_at)),
        total_records,
    });
}

fn persist_queue_items(
    root: &Path,
    items: Vec<Value>,
    config: &GuiConfigFile,
) -> Result<usize, String> {
    let records = items
        .into_iter()
        .filter(Value::is_object)
        .filter(is_generated_usage_event)
        .map(|item| normalize_usage_record(item, config))
        .collect::<Result<Vec<_>, _>>()?;
    if records.is_empty() {
        return Ok(0);
    }
    let mut connection = open_usage_database_at(root)?;
    insert_usage_records(&mut connection, &records)
}

fn insert_usage_records(
    connection: &mut Connection,
    records: &[UsageRecord],
) -> Result<usize, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始 SQLite 使用记录事务失败: {error}"))?;
    let inserted = insert_usage_records_in_transaction(&transaction, records)?;
    transaction
        .commit()
        .map_err(|error| format!("提交 SQLite 使用记录失败: {error}"))?;
    Ok(inserted)
}

fn insert_usage_records_in_transaction(
    transaction: &Transaction<'_>,
    records: &[UsageRecord],
) -> Result<usize, String> {
    if records.is_empty() {
        return Ok(0);
    }
    let mut statement = transaction
        .prepare(
            r#"
            INSERT OR IGNORE INTO usage_events (
                event_key, timestamp, timestamp_ms, local_hour, latency_ms, ttft_ms,
                source, auth_index, failed, provider, model, alias, reasoning_effort,
                service_tier, response_service_tier, executor_type, endpoint, auth_type,
                api_key_hash, api_key_display, api_key_remark, request_id,
                input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
                cache_creation_tokens, total_tokens, created_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
            )
            "#,
        )
        .map_err(|error| format!("准备 SQLite 使用记录写入失败: {error}"))?;
    let created_at = Local::now().to_rfc3339();
    let mut inserted = 0_usize;
    for record in records {
        inserted = inserted.saturating_add(
            statement
                .execute(params![
                    record.id,
                    record.timestamp,
                    record_timestamp_millis(record),
                    record_local_hour(record),
                    to_sql_i64(record.latency_ms),
                    record.ttft_ms.map(to_sql_i64),
                    record.source,
                    record.auth_index,
                    record.failed,
                    record.provider,
                    record.model,
                    record.alias,
                    record.reasoning_effort,
                    record.service_tier,
                    record.response_service_tier,
                    record.executor_type,
                    record.endpoint,
                    record.auth_type,
                    record.api_key_hash,
                    record.api_key_display,
                    record.api_key_remark,
                    record.request_id,
                    to_sql_i64(record.tokens.input_tokens),
                    to_sql_i64(record.tokens.output_tokens),
                    to_sql_i64(record.tokens.reasoning_tokens),
                    to_sql_i64(record.tokens.cache_read_tokens),
                    to_sql_i64(record.tokens.cache_creation_tokens),
                    to_sql_i64(record.tokens.total_tokens),
                    created_at,
                ])
                .map_err(|error| format!("写入 SQLite 使用记录失败: {error}"))?,
        );
    }
    Ok(inserted)
}

fn is_generated_usage_event(value: &Value) -> bool {
    if value.get("generate").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    let legacy_websocket_prewarm = value
        .get("executor_type")
        .and_then(Value::as_str)
        .is_some_and(|value| value.trim() == "CodexWebsocketsExecutor")
        && value
            .get("tokens")
            .and_then(Value::as_object)
            .is_some_and(|tokens| {
                [
                    "input_tokens",
                    "output_tokens",
                    "reasoning_tokens",
                    "cached_tokens",
                    "cache_read_tokens",
                    "cache_creation_tokens",
                    "total_tokens",
                ]
                .into_iter()
                .all(|key| u64_field(tokens, key) == 0)
            });
    !legacy_websocket_prewarm
}

fn normalize_usage_record(value: Value, config: &GuiConfigFile) -> Result<UsageRecord, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "CPA 使用记录必须是 JSON 对象".to_string())?;
    let timestamp = string_field(object, "timestamp")
        .filter(|value| DateTime::parse_from_rfc3339(value).is_ok())
        .unwrap_or_else(|| Local::now().to_rfc3339());
    let request_id = string_field(object, "request_id").unwrap_or_default();
    let api_key = string_field(object, "api_key").unwrap_or_default();
    let api_key_hash = hash_text(&api_key);
    let api_key_remark = config
        .api_keys
        .iter()
        .find(|entry| entry.key == api_key)
        .map(|entry| entry.remark.clone())
        .unwrap_or_default();
    let tokens_object = object.get("tokens").and_then(Value::as_object);
    let mut tokens = UsageTokenStats {
        input_tokens: token_u64(tokens_object, "input_tokens"),
        output_tokens: token_u64(tokens_object, "output_tokens"),
        reasoning_tokens: token_u64(tokens_object, "reasoning_tokens"),
        cache_read_tokens: token_u64(tokens_object, "cache_read_tokens")
            .max(token_u64(tokens_object, "cached_tokens")),
        cache_creation_tokens: token_u64(tokens_object, "cache_creation_tokens"),
        total_tokens: token_u64(tokens_object, "total_tokens"),
    };
    if tokens.total_tokens == 0 {
        tokens.total_tokens = tokens.input_tokens.saturating_add(tokens.output_tokens);
    }
    let mut canonical = object.clone();
    canonical.remove("response_headers");
    canonical.remove("api_key");
    let id = if request_id.is_empty() {
        hash_text(&serde_json::to_string(&canonical).unwrap_or_default())
    } else {
        request_id.clone()
    };
    Ok(UsageRecord {
        id,
        timestamp,
        latency_ms: u64_field(object, "latency_ms"),
        ttft_ms: optional_u64_field(object, "ttft_ms"),
        source: string_field(object, "source").unwrap_or_default(),
        auth_index: string_field(object, "auth_index").unwrap_or_default(),
        failed: object
            .get("failed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        provider: string_field(object, "provider").unwrap_or_default(),
        model: string_field(object, "model").unwrap_or_else(|| "unknown".to_string()),
        alias: string_field(object, "alias").unwrap_or_default(),
        reasoning_effort: string_field(object, "reasoning_effort").unwrap_or_default(),
        service_tier: string_field(object, "service_tier").unwrap_or_default(),
        response_service_tier: string_field(object, "response_service_tier").unwrap_or_default(),
        executor_type: string_field(object, "executor_type").unwrap_or_default(),
        endpoint: string_field(object, "endpoint").unwrap_or_default(),
        auth_type: string_field(object, "auth_type").unwrap_or_default(),
        api_key_hash,
        api_key_display: mask_api_key(&api_key),
        api_key_remark,
        request_id,
        tokens,
    })
}

fn build_usage_filter(query: &UsageQuery) -> UsageSqlFilter {
    let mut clauses = Vec::<String>::new();
    let mut params = Vec::<SqlValue>::new();
    if let Some(start) = query.start.as_deref().and_then(parse_timestamp_millis) {
        clauses.push("timestamp_ms >= ?".to_string());
        params.push(SqlValue::Integer(start));
    }
    if let Some(end) = query.end.as_deref().and_then(parse_timestamp_millis) {
        clauses.push("timestamp_ms <= ?".to_string());
        params.push(SqlValue::Integer(end));
    }
    add_text_filter(&mut clauses, &mut params, "model", query.model.as_deref());
    add_text_filter(
        &mut clauses,
        &mut params,
        "provider",
        query.provider.as_deref(),
    );
    add_text_filter(&mut clauses, &mut params, "source", query.source.as_deref());
    add_text_filter(
        &mut clauses,
        &mut params,
        "api_key_hash",
        query.api_key_hash.as_deref(),
    );
    if let Some(failed) = query.failed {
        clauses.push("failed = ?".to_string());
        params.push(SqlValue::Integer(i64::from(failed)));
    }
    UsageSqlFilter {
        clause: if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        },
        params,
    }
}

fn add_text_filter(
    clauses: &mut Vec<String>,
    params: &mut Vec<SqlValue>,
    column: &str,
    value: Option<&str>,
) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        clauses.push(format!("{column} = ? COLLATE NOCASE"));
        params.push(SqlValue::Text(value.to_string()));
    }
}

#[tauri::command]
pub(crate) fn get_usage_collector_status(
    state: tauri::State<'_, UsageCollectorState>,
) -> Result<UsageCollectorStatus, String> {
    state.status()
}

#[tauri::command]
pub(crate) fn get_usage_overview(query: UsageQuery) -> Result<UsageOverview, String> {
    let connection = open_usage_database()?;
    load_usage_overview(&connection, &query)
}

fn load_usage_overview(
    connection: &Connection,
    query: &UsageQuery,
) -> Result<UsageOverview, String> {
    let filter = build_usage_filter(query);
    let summary_sql = format!(
        r#"
        SELECT
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN failed != 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(reasoning_tokens), 0),
            COALESCE(SUM(cache_read_tokens), 0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COALESCE(SUM(total_tokens), 0),
            COALESCE(SUM(latency_ms), 0),
            MIN(timestamp_ms),
            MAX(timestamp_ms)
        FROM usage_events{}
        "#,
        filter.clause
    );
    let summary = connection
        .query_row(
            &summary_sql,
            params_from_iter(filter.params.iter()),
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                    row.get::<_, Option<i64>>(11)?,
                ))
            },
        )
        .map_err(|error| format!("统计 SQLite 使用记录失败: {error}"))?;

    let timeline_sql = format!(
        r#"
        SELECT
            local_hour,
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN failed != 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0)
        FROM usage_events{}
        GROUP BY local_hour
        ORDER BY local_hour ASC
        "#,
        filter.clause
    );
    let mut statement = connection
        .prepare(&timeline_sql)
        .map_err(|error| format!("准备 SQLite 使用趋势查询失败: {error}"))?;
    let timeline = statement
        .query_map(params_from_iter(filter.params.iter()), |row| {
            Ok(UsageTimelinePoint {
                hour: row.get(0)?,
                requests: from_sql_i64(row.get(1)?),
                success: from_sql_i64(row.get(2)?),
                failure: from_sql_i64(row.get(3)?),
                tokens: from_sql_i64(row.get(4)?),
            })
        })
        .map_err(|error| format!("查询 SQLite 使用趋势失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 SQLite 使用趋势失败: {error}"))?;

    let mut overview = UsageOverview {
        total_requests: from_sql_i64(summary.0),
        success_count: from_sql_i64(summary.1),
        failure_count: from_sql_i64(summary.2),
        input_tokens: from_sql_i64(summary.3),
        output_tokens: from_sql_i64(summary.4),
        reasoning_tokens: from_sql_i64(summary.5),
        cache_read_tokens: from_sql_i64(summary.6),
        cache_creation_tokens: from_sql_i64(summary.7),
        total_tokens: from_sql_i64(summary.8),
        timeline,
        ..UsageOverview::default()
    };
    if overview.total_requests > 0 {
        overview.success_rate =
            overview.success_count as f64 * 100.0 / overview.total_requests as f64;
        overview.average_latency_ms =
            from_sql_i64(summary.9) as f64 / overview.total_requests as f64;
        let minutes = query_window_minutes(query, summary.10, summary.11);
        overview.rpm = overview.total_requests as f64 / minutes;
        overview.tpm = overview.total_tokens as f64 / minutes;
    }
    Ok(overview)
}

#[tauri::command]
pub(crate) fn get_usage_analysis(query: UsageQuery) -> Result<UsageAnalysis, String> {
    let connection = open_usage_database()?;
    load_usage_analysis(&connection, &query)
}

fn load_usage_analysis(
    connection: &Connection,
    query: &UsageQuery,
) -> Result<UsageAnalysis, String> {
    Ok(UsageAnalysis {
        models: load_simple_categories(connection, query, "model", "unknown")?,
        providers: load_simple_categories(connection, query, "provider", "未知 Provider")?,
        sources: load_simple_categories(connection, query, "source", "未知来源")?,
        api_keys: load_api_key_categories(connection, query)?,
    })
}

fn load_simple_categories(
    connection: &Connection,
    query: &UsageQuery,
    column: &str,
    fallback: &str,
) -> Result<Vec<UsageCategory>, String> {
    let filter = build_usage_filter(query);
    let sql = format!(
        r#"
        SELECT
            COALESCE(NULLIF(TRIM({column}), ''), ?),
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed != 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0)
        FROM usage_events{}
        GROUP BY 1
        ORDER BY 4 DESC, 2 DESC
        "#,
        filter.clause
    );
    let mut values = Vec::with_capacity(filter.params.len() + 1);
    values.push(SqlValue::Text(fallback.to_string()));
    values.extend(filter.params);
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("准备 SQLite 使用分析查询失败: {error}"))?;
    let categories = statement
        .query_map(params_from_iter(values.iter()), |row| {
            let key = row.get::<_, String>(0)?;
            Ok(UsageCategory {
                label: key.clone(),
                key,
                requests: from_sql_i64(row.get(1)?),
                failures: from_sql_i64(row.get(2)?),
                tokens: from_sql_i64(row.get(3)?),
            })
        })
        .map_err(|error| format!("查询 SQLite 使用分析失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 SQLite 使用分析失败: {error}"))?;
    Ok(categories)
}

fn load_api_key_categories(
    connection: &Connection,
    query: &UsageQuery,
) -> Result<Vec<UsageCategory>, String> {
    let filter = build_usage_filter(query);
    let sql = format!(
        r#"
        SELECT
            COALESCE(NULLIF(TRIM(api_key_hash), ''), '未记录密钥'),
            MAX(TRIM(api_key_remark)),
            MAX(TRIM(api_key_display)),
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed != 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0)
        FROM usage_events{}
        GROUP BY 1
        ORDER BY 6 DESC, 4 DESC
        "#,
        filter.clause
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("准备 SQLite API Key 使用分析查询失败: {error}"))?;
    let categories = statement
        .query_map(params_from_iter(filter.params.iter()), |row| {
            let key = row.get::<_, String>(0)?;
            let remark = row.get::<_, String>(1)?;
            let display = row.get::<_, String>(2)?;
            let label = if !remark.is_empty() {
                if display.is_empty() {
                    remark
                } else {
                    format!("{remark} · {display}")
                }
            } else if !display.is_empty() {
                display
            } else {
                "未记录密钥".to_string()
            };
            Ok(UsageCategory {
                key,
                label,
                requests: from_sql_i64(row.get(3)?),
                failures: from_sql_i64(row.get(4)?),
                tokens: from_sql_i64(row.get(5)?),
            })
        })
        .map_err(|error| format!("查询 SQLite API Key 使用分析失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 SQLite API Key 使用分析失败: {error}"))?;
    Ok(categories)
}

#[tauri::command]
pub(crate) fn get_usage_events(query: UsageQuery) -> Result<UsageEventPage, String> {
    let connection = open_usage_database()?;
    load_usage_events(&connection, &query)
}

fn load_usage_events(
    connection: &Connection,
    query: &UsageQuery,
) -> Result<UsageEventPage, String> {
    let filter = build_usage_filter(query);
    let total_sql = format!("SELECT COUNT(*) FROM usage_events{}", filter.clause);
    let total = connection
        .query_row(&total_sql, params_from_iter(filter.params.iter()), |row| {
            row.get::<_, i64>(0)
        })
        .map(from_sql_i64)
        .map_err(|error| format!("统计 SQLite 使用事件失败: {error}"))?
        .min(usize::MAX as u64) as usize;
    let page_size = query.page_size.unwrap_or(50).clamp(20, 200);
    let total_pages = total.div_ceil(page_size).max(1);
    let page = query.page.unwrap_or(1).clamp(1, total_pages);
    let offset = (page - 1).saturating_mul(page_size);

    let sql = format!(
        r#"
        SELECT
            event_key, timestamp, latency_ms, ttft_ms, source, auth_index, failed,
            provider, model, alias, reasoning_effort, service_tier,
            response_service_tier, executor_type, endpoint, auth_type,
            api_key_hash, api_key_display, api_key_remark, request_id,
            input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
            cache_creation_tokens, total_tokens
        FROM usage_events{}
        ORDER BY timestamp_ms DESC, id DESC
        LIMIT ? OFFSET ?
        "#,
        filter.clause
    );
    let mut values = filter.params;
    values.push(SqlValue::Integer(page_size as i64));
    values.push(SqlValue::Integer(offset.min(i64::MAX as usize) as i64));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("准备 SQLite 使用事件查询失败: {error}"))?;
    let items = statement
        .query_map(params_from_iter(values.iter()), usage_record_from_row)
        .map_err(|error| format!("查询 SQLite 使用事件失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 SQLite 使用事件失败: {error}"))?;
    Ok(UsageEventPage {
        items,
        total,
        page,
        page_size,
        total_pages,
    })
}

fn usage_record_from_row(row: &Row<'_>) -> rusqlite::Result<UsageRecord> {
    Ok(UsageRecord {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        latency_ms: from_sql_i64(row.get(2)?),
        ttft_ms: row.get::<_, Option<i64>>(3)?.map(from_sql_i64),
        source: row.get(4)?,
        auth_index: row.get(5)?,
        failed: row.get::<_, i64>(6)? != 0,
        provider: row.get(7)?,
        model: row.get(8)?,
        alias: row.get(9)?,
        reasoning_effort: row.get(10)?,
        service_tier: row.get(11)?,
        response_service_tier: row.get(12)?,
        executor_type: row.get(13)?,
        endpoint: row.get(14)?,
        auth_type: row.get(15)?,
        api_key_hash: row.get(16)?,
        api_key_display: row.get(17)?,
        api_key_remark: row.get(18)?,
        request_id: row.get(19)?,
        tokens: UsageTokenStats {
            input_tokens: from_sql_i64(row.get(20)?),
            output_tokens: from_sql_i64(row.get(21)?),
            reasoning_tokens: from_sql_i64(row.get(22)?),
            cache_read_tokens: from_sql_i64(row.get(23)?),
            cache_creation_tokens: from_sql_i64(row.get(24)?),
            total_tokens: from_sql_i64(row.get(25)?),
        },
    })
}

fn total_usage_records() -> Result<u64, String> {
    let connection = open_usage_database()?;
    connection
        .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(from_sql_i64)
        .map_err(|error| format!("统计 SQLite 使用记录总数失败: {error}"))
}

fn query_window_minutes(query: &UsageQuery, first: Option<i64>, last: Option<i64>) -> f64 {
    let start = query
        .start
        .as_deref()
        .and_then(parse_timestamp_millis)
        .or(first)
        .unwrap_or(0);
    let end = query
        .end
        .as_deref()
        .and_then(parse_timestamp_millis)
        .or(last)
        .unwrap_or(start);
    ((end.saturating_sub(start)) as f64 / 60_000.0).max(1.0)
}

fn usage_root_dir() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("读取程序路径失败: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "程序路径没有父目录".to_string())?;
    Ok(directory.join(USAGE_DIR_NAME))
}

fn record_local_hour(record: &UsageRecord) -> String {
    local_hour_from_timestamp(&record.timestamp)
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d-%H").to_string())
}

fn local_hour_from_timestamp(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value).ok().map(|timestamp| {
        timestamp
            .with_timezone(&Local)
            .format("%Y-%m-%d-%H")
            .to_string()
    })
}

fn record_timestamp_millis(record: &UsageRecord) -> i64 {
    parse_timestamp_millis(&record.timestamp).unwrap_or(0)
}

fn parse_timestamp_millis(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn to_sql_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn from_sql_i64(value: i64) -> u64 {
    value.max(0) as u64
}

#[cfg(test)]
fn unique_file_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(|value| match value {
            Value::String(value) => Some(value.trim().to_string()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
}

fn u64_field(object: &serde_json::Map<String, Value>, key: &str) -> u64 {
    optional_u64_field(object, key).unwrap_or(0)
}

fn optional_u64_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_i64()
                .map(|number| number.max(0) as u64)
                .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
        })
    })
}

fn token_u64(object: Option<&serde_json::Map<String, Value>>, key: &str) -> u64 {
    object.map(|object| u64_field(object, key)).unwrap_or(0)
}

fn hash_text(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn mask_api_key(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    if value.chars().count() <= 8 {
        return format!("{}••••", value.chars().take(2).collect::<String>());
    }
    let start = value.chars().take(4).collect::<String>();
    let end = value
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{start}••••{end}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "cpa-gui-usage-{name}-{}-{}",
            std::process::id(),
            unique_file_stamp()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn open_test_database(root: &Path) -> Connection {
        initialize_usage_storage_at(root).unwrap();
        open_usage_database_at(root).unwrap()
    }

    fn sample_record(id: &str, timestamp: &str, model: &str) -> UsageRecord {
        UsageRecord {
            id: id.to_string(),
            timestamp: timestamp.to_string(),
            latency_ms: 100,
            ttft_ms: Some(20),
            source: "source".to_string(),
            auth_index: "auth".to_string(),
            failed: false,
            provider: "openai".to_string(),
            model: model.to_string(),
            alias: String::new(),
            reasoning_effort: "high".to_string(),
            service_tier: String::new(),
            response_service_tier: String::new(),
            executor_type: String::new(),
            endpoint: "POST /v1/responses".to_string(),
            auth_type: "oauth".to_string(),
            api_key_hash: "hash".to_string(),
            api_key_display: "12••••".to_string(),
            api_key_remark: "内置密钥".to_string(),
            request_id: id.to_string(),
            tokens: UsageTokenStats {
                input_tokens: 10,
                output_tokens: 20,
                reasoning_tokens: 5,
                cache_read_tokens: 2,
                cache_creation_tokens: 0,
                total_tokens: 30,
            },
        }
    }

    #[test]
    fn masks_api_keys_without_exposing_the_full_value() {
        assert_eq!(mask_api_key("123456"), "12••••");
        assert_eq!(mask_api_key("sk-1234567890"), "sk-1••••7890");
    }

    #[test]
    fn local_hour_key_uses_year_month_day_and_hour() {
        let record = sample_record("id", "2026-07-17T20:30:00+08:00", "model");
        assert_eq!(record_local_hour(&record).len(), "2026-07-17-20".len());
    }

    #[test]
    fn normalizes_queue_records_without_persisting_secrets_or_headers() {
        let config = GuiConfigFile {
            port: 8317,
            allow_lan: false,
            run_on_startup: false,
            auth_dir: String::new(),
            api_keys: Vec::new(),
            management_secret_key: "123456".to_string(),
            plugins_enabled: false,
            routing_strategy: "round-robin".to_string(),
        };
        let record = normalize_usage_record(
            serde_json::json!({
                "timestamp": "2026-07-17T20:30:00+08:00",
                "request_id": "request-1",
                "api_key": "secret-client-key",
                "response_headers": { "authorization": ["secret-upstream-token"] },
                "model": "gpt-test",
                "tokens": { "input_tokens": 10, "output_tokens": 20 }
            }),
            &config,
        )
        .unwrap();
        let rendered = serde_json::to_string(&record).unwrap();

        assert!(!rendered.contains("secret-client-key"));
        assert!(!rendered.contains("secret-upstream-token"));
        assert_eq!(record.tokens.total_tokens, 30);
        assert!(!record.api_key_hash.is_empty());
    }

    #[test]
    fn sqlite_storage_uses_wal_and_reference_busy_timeout() {
        let root = test_root("sqlite-pragmas");
        let connection = open_test_database(&root);
        let journal_mode = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap();
        let busy_timeout = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get::<_, i64>(0))
            .unwrap();
        let foreign_keys = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
            .unwrap();

        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(busy_timeout, 5_000);
        assert_eq!(foreign_keys, 1);
        assert!(root.join(USAGE_DATABASE_FILE).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_storage_deduplicates_event_keys_transactionally() {
        let root = test_root("sqlite-deduplicate");
        let mut connection = open_test_database(&root);
        let record = sample_record("request-1", "2026-07-17T20:30:00+08:00", "gpt-test");

        assert_eq!(
            insert_usage_records(&mut connection, std::slice::from_ref(&record)).unwrap(),
            1
        );
        assert_eq!(insert_usage_records(&mut connection, &[record]).unwrap(), 0);
        let count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();

        assert_eq!(count, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_hour_and_inbox_json_are_migrated_once() {
        let root = test_root("legacy-migration");
        let events_dir = root.join(LEGACY_USAGE_EVENTS_DIR);
        let inbox_dir = root.join(LEGACY_USAGE_INBOX_DIR);
        fs::create_dir_all(&events_dir).unwrap();
        fs::create_dir_all(&inbox_dir).unwrap();
        let first = sample_record("request-1", "2026-07-17T20:30:00+08:00", "gpt-a");
        let second = sample_record("request-2", "2026-07-17T20:31:00+08:00", "gpt-b");
        fs::write(
            events_dir.join("2026-07-17-20.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": USAGE_SCHEMA_VERSION,
                "hour": "2026-07-17-20",
                "timezone": "+08:00",
                "records": [first]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            inbox_dir.join("pending.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": USAGE_SCHEMA_VERSION,
                "records": [second]
            }))
            .unwrap(),
        )
        .unwrap();

        initialize_usage_storage_at(&root).unwrap();
        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let marker = connection
            .query_row(
                "SELECT value FROM usage_metadata WHERE key = ?1",
                params![LEGACY_JSON_MIGRATION_KEY],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        assert_eq!(count, 2);
        assert_eq!(marker, "2");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_queries_filter_aggregate_and_paginate() {
        let root = test_root("sqlite-query");
        let mut connection = open_test_database(&root);
        let success = sample_record("request-1", "2026-07-17T20:30:00+08:00", "gpt-a");
        let mut failed = sample_record("request-2", "2026-07-17T21:30:00+08:00", "gpt-b");
        failed.failed = true;
        insert_usage_records(&mut connection, &[success, failed]).unwrap();
        let query = UsageQuery {
            model: Some("GPT-B".to_string()),
            failed: Some(true),
            page_size: Some(20),
            ..UsageQuery::default()
        };

        let overview = load_usage_overview(&connection, &query).unwrap();
        let analysis = load_usage_analysis(&connection, &query).unwrap();
        let events = load_usage_events(&connection, &query).unwrap();

        assert_eq!(overview.total_requests, 1);
        assert_eq!(overview.failure_count, 1);
        assert_eq!(analysis.models[0].key, "gpt-b");
        assert_eq!(events.total, 1);
        assert_eq!(events.items[0].id, "request-2");
        fs::remove_dir_all(root).unwrap();
    }
}
