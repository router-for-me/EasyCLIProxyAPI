use super::{
    apply_configured_proxy, current_core_status, management_authorization, management_endpoint,
    management_http_client, CoreProcessState, GuiConfigFile, GuiConfigState,
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
    collections::HashMap,
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
const TOKENS_PER_PRICE_UNIT: f64 = 1_000_000.0;
const LONG_CONTEXT_INPUT_TOKEN_THRESHOLD: u64 = 272_000;
const BUNDLED_MODEL_PRICE_CATALOG: &str = include_str!("../resources/model_prices.json");
const MODEL_PRICE_SYNC_URL: &str =
    "https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/src-tauri/resources/model_prices.json";

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
    source_display: String,
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

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UsageExportFormat {
    Csv,
    Json,
}

impl UsageExportFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageExportResult {
    path: String,
    record_count: usize,
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
    tps: f64,
    average_latency_ms: f64,
    cache_hit_rate: f64,
    estimated_cost: f64,
    priced_requests: u64,
    timeline: Vec<UsageTimelinePoint>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPrice {
    model: String,
    prompt: f64,
    completion: f64,
    cache: f64,
    cache_read: f64,
    cache_creation: f64,
    prompt_configured: bool,
    completion_configured: bool,
    cache_read_configured: bool,
    cache_creation_configured: bool,
    source: String,
    source_model_id: String,
    updated_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelPriceCatalog {
    schema_version: u8,
    #[serde(default)]
    updated_at: String,
    models: HashMap<String, CatalogModelPrice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogModelPrice {
    input_per_1_m: f64,
    output_per_1_m: f64,
    #[serde(default)]
    cache_read_per_1_m: Option<f64>,
    #[serde(default)]
    cache_creation_per_1_m: Option<f64>,
}

#[derive(Default)]
struct CostTokens {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    long_input: u64,
    long_output: u64,
    long_cache_read: u64,
    long_cache_creation: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsagePricing {
    rows: Vec<UsagePriceRow>,
    total_cost: f64,
    total_requests: u64,
    priced_requests: u64,
    saved_prices: usize,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsagePriceRow {
    model: String,
    requests: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    estimated_cost: f64,
    price: Option<ModelPrice>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPriceSyncResult {
    imported: usize,
    skipped: usize,
    unmatched: Vec<String>,
    used_builtin: bool,
}

struct UsageCostGroup {
    model: String,
    alias: String,
    service_tier: String,
    response_service_tier: String,
    executor_type: String,
    provider: String,
    auth_type: String,
    requests: u64,
    tokens: CostTokens,
    total_tokens: u64,
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

    fn set_total_records(&self, total_records: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status.total_records = total_records;
        }
    }

    fn increment_total_records(&self, added: usize) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status.total_records = inner.status.total_records.saturating_add(added as u64);
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

            CREATE TABLE IF NOT EXISTS model_prices (
                model TEXT PRIMARY KEY NOT NULL,
                prompt_per_1m REAL NOT NULL DEFAULT 0,
                completion_per_1m REAL NOT NULL DEFAULT 0,
                cache_per_1m REAL NOT NULL DEFAULT 0,
                cache_read_per_1m REAL NOT NULL DEFAULT 0,
                cache_creation_per_1m REAL NOT NULL DEFAULT 0,
                prompt_configured INTEGER NOT NULL DEFAULT 0,
                completion_configured INTEGER NOT NULL DEFAULT 0,
                cache_read_configured INTEGER NOT NULL DEFAULT 0,
                cache_creation_configured INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT '',
                source_model_id TEXT NOT NULL DEFAULT '',
                updated_at_ms INTEGER NOT NULL DEFAULT 0
            );

            PRAGMA user_version = 2;
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
    if let Ok(total_records) = total_usage_records() {
        state.set_total_records(total_records);
    }
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
                    if saved > 0 {
                        app.state::<UsageCollectorState>()
                            .increment_total_records(saved);
                    }
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
    let total_records = previous
        .as_ref()
        .map(|value| value.total_records)
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
    let raw_cache_read_tokens = token_u64(tokens_object, "cache_read_tokens");
    let cache_creation_tokens = token_u64(tokens_object, "cache_creation_tokens");
    let compatible_cached_tokens = token_u64(tokens_object, "cached_tokens")
        .max(token_u64(tokens_object, "cache_tokens"))
        .saturating_sub(raw_cache_read_tokens.saturating_add(cache_creation_tokens));
    let mut tokens = UsageTokenStats {
        input_tokens: token_u64(tokens_object, "input_tokens"),
        output_tokens: token_u64(tokens_object, "output_tokens"),
        reasoning_tokens: token_u64(tokens_object, "reasoning_tokens"),
        cache_read_tokens: raw_cache_read_tokens.saturating_add(compatible_cached_tokens),
        cache_creation_tokens,
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
        source_display: String::new(),
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
            COALESCE(AVG(CASE
                WHEN output_tokens > 0 AND latency_ms > 0
                THEN CAST(output_tokens AS REAL) * 1000.0 / latency_ms
            END), 0.0),
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
                    row.get::<_, f64>(10)?,
                    row.get::<_, Option<i64>>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                ))
            },
        )
        .map_err(|error| format!("统计 SQLite 使用记录失败: {error}"))?;

    let (estimated_cost, priced_requests) = load_estimated_cost(connection, &filter)?;

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
        estimated_cost,
        priced_requests,
        timeline,
        ..UsageOverview::default()
    };
    if overview.total_requests > 0 {
        overview.success_rate =
            overview.success_count as f64 * 100.0 / overview.total_requests as f64;
        overview.average_latency_ms =
            from_sql_i64(summary.9) as f64 / overview.total_requests as f64;
        overview.tps = summary.10;
        if overview.input_tokens > 0 {
            overview.cache_hit_rate =
                (overview.cache_read_tokens as f64 / overview.input_tokens as f64).min(1.0);
        }
        let minutes = query_window_minutes(query, summary.11, summary.12);
        overview.rpm = overview.total_requests as f64 / minutes;
        overview.tpm = overview.total_tokens as f64 / minutes;
    }
    Ok(overview)
}

fn load_estimated_cost(
    connection: &Connection,
    filter: &UsageSqlFilter,
) -> Result<(f64, u64), String> {
    let prices = load_model_prices(connection)?;
    let groups = load_usage_cost_groups(connection, filter)?;
    Ok(sum_usage_cost(&groups, &prices))
}

fn load_usage_cost_groups(
    connection: &Connection,
    filter: &UsageSqlFilter,
) -> Result<Vec<UsageCostGroup>, String> {
    let sql = format!(
        r#"
        SELECT
            model,
            alias,
            service_tier,
            response_service_tier,
            executor_type,
            provider,
            auth_type,
            COUNT(*),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(cache_read_tokens), 0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COALESCE(SUM(CASE WHEN input_tokens > {LONG_CONTEXT_INPUT_TOKEN_THRESHOLD} THEN input_tokens ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN input_tokens > {LONG_CONTEXT_INPUT_TOKEN_THRESHOLD} THEN output_tokens ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN input_tokens > {LONG_CONTEXT_INPUT_TOKEN_THRESHOLD} THEN cache_read_tokens ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN input_tokens > {LONG_CONTEXT_INPUT_TOKEN_THRESHOLD} THEN cache_creation_tokens ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0)
        FROM usage_events{}
        GROUP BY model, alias, service_tier, response_service_tier, executor_type, provider, auth_type
        "#,
        filter.clause
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("准备使用成本查询失败: {error}"))?;
    let groups = statement
        .query_map(params_from_iter(filter.params.iter()), |row| {
            Ok(UsageCostGroup {
                model: row.get(0)?,
                alias: row.get(1)?,
                service_tier: row.get(2)?,
                response_service_tier: row.get(3)?,
                executor_type: row.get(4)?,
                provider: row.get(5)?,
                auth_type: row.get(6)?,
                requests: from_sql_i64(row.get(7)?),
                tokens: CostTokens {
                    input: from_sql_i64(row.get(8)?),
                    output: from_sql_i64(row.get(9)?),
                    cache_read: from_sql_i64(row.get(10)?),
                    cache_creation: from_sql_i64(row.get(11)?),
                    long_input: from_sql_i64(row.get(12)?),
                    long_output: from_sql_i64(row.get(13)?),
                    long_cache_read: from_sql_i64(row.get(14)?),
                    long_cache_creation: from_sql_i64(row.get(15)?),
                },
                total_tokens: from_sql_i64(row.get(16)?),
            })
        })
        .map_err(|error| format!("查询使用成本失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取使用成本失败: {error}"))?;
    Ok(groups)
}

fn sum_usage_cost(groups: &[UsageCostGroup], prices: &HashMap<String, ModelPrice>) -> (f64, u64) {
    let mut total_cost = 0.0;
    let mut priced_requests = 0_u64;
    for group in groups {
        let Some((model, price)) = resolve_model_price(&group.model, &group.alias, prices) else {
            continue;
        };
        let identity = format!(
            "{} {} {}",
            group.executor_type, group.provider, group.auth_type
        )
        .to_ascii_lowercase();
        let service_tier =
            if identity.contains("codex") || group.response_service_tier.trim().is_empty() {
                group.service_tier.as_str()
            } else {
                group.response_service_tier.as_str()
            };
        total_cost += cost_for_price(model, service_tier, &group.tokens, &price);
        priced_requests = priced_requests.saturating_add(group.requests);
    }
    (total_cost, priced_requests)
}

fn cost_for_price(model: &str, service_tier: &str, tokens: &CostTokens, price: &ModelPrice) -> f64 {
    let price = enriched_model_price(model, price);
    let short_cost = cost_for_token_segment(
        tokens.input.saturating_sub(tokens.long_input),
        tokens.output.saturating_sub(tokens.long_output),
        tokens.cache_read.saturating_sub(tokens.long_cache_read),
        tokens
            .cache_creation
            .saturating_sub(tokens.long_cache_creation),
        &price,
        1.0,
        1.0,
    );
    let long_cost = cost_for_token_segment(
        tokens.long_input,
        tokens.long_output,
        tokens.long_cache_read,
        tokens.long_cache_creation,
        &price,
        2.0,
        1.5,
    );
    let tier = service_tier.trim().to_ascii_lowercase();
    let multiplier = if tokens.long_input > 0 && matches!(tier.as_str(), "priority" | "fast") {
        1.0
    } else {
        match tier.as_str() {
            "flex" | "batch" => 0.5,
            "priority" | "fast" => service_tier_multiplier(model),
            _ => 1.0,
        }
    };
    (short_cost + long_cost) * multiplier
}

fn cost_for_token_segment(
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    price: &ModelPrice,
    input_multiplier: f64,
    output_multiplier: f64,
) -> f64 {
    let prompt = input.saturating_sub(cache_read.saturating_add(cache_creation));
    ((prompt as f64 * price.prompt
        + cache_read as f64 * price.cache_read
        + cache_creation as f64 * price.cache_creation)
        * input_multiplier
        + output as f64 * price.completion * output_multiplier)
        / TOKENS_PER_PRICE_UNIT
}

fn official_model_price(model: &str) -> Option<ModelPrice> {
    let prices = bundled_model_prices().ok()?;
    find_model_price(&prices, model).cloned()
}

fn bundled_model_prices() -> Result<HashMap<String, ModelPrice>, String> {
    parse_model_price_catalog(BUNDLED_MODEL_PRICE_CATALOG, "builtin", 0)
}

fn parse_model_price_catalog(
    content: &str,
    source: &str,
    updated_at_ms: i64,
) -> Result<HashMap<String, ModelPrice>, String> {
    let catalog = serde_json::from_str::<ModelPriceCatalog>(content)
        .map_err(|error| format!("解析模型价格文件失败: {error}"))?;
    if catalog.schema_version != 1 {
        return Err(format!(
            "不支持的模型价格文件版本 {}",
            catalog.schema_version
        ));
    }
    if catalog.models.is_empty() {
        return Err("模型价格文件不包含任何模型".to_string());
    }
    let _catalog_updated_at = catalog.updated_at;
    let mut prices = HashMap::with_capacity(catalog.models.len());
    for (model, entry) in catalog.models {
        let cache_read = entry.cache_read_per_1_m.unwrap_or(0.0);
        let cache_creation = entry.cache_creation_per_1_m.unwrap_or(0.0);
        let price = ModelPrice {
            model: model.trim().to_string(),
            prompt: entry.input_per_1_m,
            completion: entry.output_per_1_m,
            cache: cache_read,
            cache_read,
            cache_creation,
            prompt_configured: true,
            completion_configured: true,
            cache_read_configured: entry.cache_read_per_1_m.is_some(),
            cache_creation_configured: entry.cache_creation_per_1_m.is_some(),
            source: source.to_string(),
            source_model_id: String::new(),
            updated_at_ms,
        };
        validate_model_price(&price)?;
        prices.insert(price.model.clone(), price);
    }
    Ok(prices)
}

fn find_model_price<'a>(
    prices: &'a HashMap<String, ModelPrice>,
    model: &str,
) -> Option<&'a ModelPrice> {
    if let Some(price) = prices.get(model) {
        return Some(price);
    }
    let case_insensitive = prices
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(model))
        .collect::<Vec<_>>();
    if case_insensitive.len() == 1 {
        return Some(case_insensitive[0].1);
    }
    let tail = canonical_model_tail(model);
    let exact_tail = prices
        .iter()
        .filter(|(key, _)| canonical_model_tail(key) == tail)
        .collect::<Vec<_>>();
    if exact_tail.len() == 1 {
        return Some(exact_tail[0].1);
    }
    let normalized_tail = normalized_model_tail(model);
    prices
        .iter()
        .filter_map(|(key, price)| {
            let key_tail = normalized_model_tail(key);
            normalized_tail
                .starts_with(&format!("{key_tail}-"))
                .then_some((key_tail.len(), price))
        })
        .max_by_key(|(length, _)| *length)
        .map(|(_, price)| price)
}

fn resolve_model_price<'a>(
    model: &'a str,
    alias: &'a str,
    prices: &HashMap<String, ModelPrice>,
) -> Option<(&'a str, ModelPrice)> {
    for candidate in [model, alias] {
        if candidate.trim().is_empty() {
            continue;
        }
        if let Some(price) = find_model_price(prices, candidate) {
            return Some((model, price.clone()));
        }
    }
    None
}

fn enriched_model_price(model: &str, price: &ModelPrice) -> ModelPrice {
    let mut price = price.clone();
    if let Some(official) = official_model_price(model) {
        if !price.prompt_configured && price.prompt <= 0.0 {
            price.prompt = official.prompt;
        }
        if !price.completion_configured && price.completion <= 0.0 {
            price.completion = official.completion;
        }
    }
    if !price.cache_read_configured && price.cache_read <= 0.0 {
        price.cache_read = if price.cache > 0.0 {
            price.cache
        } else {
            price.prompt * 0.1
        };
    }
    if !price.cache_creation_configured && price.cache_creation <= 0.0 {
        price.cache_creation = price.prompt
            * if is_model_family(model, "gpt-5.6") {
                1.25
            } else {
                1.0
            };
    }
    price
}

fn is_model_family(model: &str, family: &str) -> bool {
    let normalized = model
        .trim()
        .to_ascii_lowercase()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    normalized == family || normalized.starts_with(&format!("{family}-"))
}

fn service_tier_multiplier(model: &str) -> f64 {
    if is_model_family(model, "gpt-5.5") {
        2.5
    } else if is_model_family(model, "gpt-5.6")
        || is_model_family(model, "gpt-5.4")
        || is_model_family(model, "gpt-5.4-mini")
        || is_model_family(model, "gpt-5.3-codex")
    {
        2.0
    } else {
        1.0
    }
}

fn load_model_prices(connection: &Connection) -> Result<HashMap<String, ModelPrice>, String> {
    let mut merged = bundled_model_prices()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT model, prompt_per_1m, completion_per_1m, cache_per_1m,
                   cache_read_per_1m, cache_creation_per_1m,
                   prompt_configured, completion_configured,
                   cache_read_configured, cache_creation_configured,
                   source, source_model_id, updated_at_ms
            FROM model_prices ORDER BY model
            "#,
        )
        .map_err(|error| format!("准备模型价格查询失败: {error}"))?;
    let prices = statement
        .query_map([], |row| {
            Ok(ModelPrice {
                model: row.get(0)?,
                prompt: row.get(1)?,
                completion: row.get(2)?,
                cache: row.get(3)?,
                cache_read: row.get(4)?,
                cache_creation: row.get(5)?,
                prompt_configured: row.get(6)?,
                completion_configured: row.get(7)?,
                cache_read_configured: row.get(8)?,
                cache_creation_configured: row.get(9)?,
                source: row.get(10)?,
                source_model_id: row.get(11)?,
                updated_at_ms: row.get(12)?,
            })
        })
        .map_err(|error| format!("查询模型价格失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取模型价格失败: {error}"))?;
    for price in prices {
        if price.source != "litellm" {
            if let Some(existing) = merged
                .keys()
                .find(|model| model.eq_ignore_ascii_case(&price.model))
                .cloned()
            {
                merged.remove(&existing);
            }
            merged.insert(price.model.clone(), price);
        }
    }
    Ok(merged)
}

fn validate_model_price(price: &ModelPrice) -> Result<(), String> {
    if price.model.trim().is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    for value in [
        price.prompt,
        price.completion,
        price.cache,
        price.cache_read,
        price.cache_creation,
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(format!("模型 {} 包含无效价格", price.model));
        }
    }
    Ok(())
}

fn upsert_model_price(connection: &Connection, price: &ModelPrice) -> Result<(), String> {
    validate_model_price(price)?;
    connection
        .execute(
            r#"
            INSERT INTO model_prices (
                model, prompt_per_1m, completion_per_1m, cache_per_1m,
                cache_read_per_1m, cache_creation_per_1m,
                prompt_configured, completion_configured,
                cache_read_configured, cache_creation_configured,
                source, source_model_id, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(model) DO UPDATE SET
                prompt_per_1m = excluded.prompt_per_1m,
                completion_per_1m = excluded.completion_per_1m,
                cache_per_1m = excluded.cache_per_1m,
                cache_read_per_1m = excluded.cache_read_per_1m,
                cache_creation_per_1m = excluded.cache_creation_per_1m,
                prompt_configured = excluded.prompt_configured,
                completion_configured = excluded.completion_configured,
                cache_read_configured = excluded.cache_read_configured,
                cache_creation_configured = excluded.cache_creation_configured,
                source = excluded.source,
                source_model_id = excluded.source_model_id,
                updated_at_ms = excluded.updated_at_ms
            "#,
            params![
                price.model.trim(),
                price.prompt,
                price.completion,
                price.cache,
                price.cache_read,
                price.cache_creation,
                price.prompt_configured,
                price.completion_configured,
                price.cache_read_configured,
                price.cache_creation_configured,
                price.source,
                price.source_model_id,
                price.updated_at_ms,
            ],
        )
        .map_err(|error| format!("保存模型价格失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn get_usage_pricing(query: UsageQuery) -> Result<UsagePricing, String> {
    let connection = open_usage_database()?;
    load_usage_pricing(&connection, &query)
}

fn load_usage_pricing(connection: &Connection, query: &UsageQuery) -> Result<UsagePricing, String> {
    let filter = build_usage_filter(query);
    let prices = load_model_prices(connection)?;
    let groups = load_usage_cost_groups(connection, &filter)?;
    let mut rows = HashMap::<String, UsagePriceRow>::new();
    let mut total_requests = 0_u64;
    let mut priced_requests = 0_u64;
    let mut total_cost = 0.0;
    for group in &groups {
        total_requests = total_requests.saturating_add(group.requests);
        let entry = rows
            .entry(group.model.clone())
            .or_insert_with(|| UsagePriceRow {
                model: group.model.clone(),
                ..UsagePriceRow::default()
            });
        entry.requests = entry.requests.saturating_add(group.requests);
        entry.input_tokens = entry.input_tokens.saturating_add(group.tokens.input);
        entry.output_tokens = entry.output_tokens.saturating_add(group.tokens.output);
        entry.cache_read_tokens = entry
            .cache_read_tokens
            .saturating_add(group.tokens.cache_read);
        entry.cache_creation_tokens = entry
            .cache_creation_tokens
            .saturating_add(group.tokens.cache_creation);
        entry.total_tokens = entry.total_tokens.saturating_add(group.total_tokens);

        if let Some((model, price)) = resolve_model_price(&group.model, &group.alias, &prices) {
            let identity = format!(
                "{} {} {}",
                group.executor_type, group.provider, group.auth_type
            )
            .to_ascii_lowercase();
            let service_tier =
                if identity.contains("codex") || group.response_service_tier.trim().is_empty() {
                    group.service_tier.as_str()
                } else {
                    group.response_service_tier.as_str()
                };
            let cost = cost_for_price(model, service_tier, &group.tokens, &price);
            entry.estimated_cost += cost;
            entry.price = Some(price);
            total_cost += cost;
            priced_requests = priced_requests.saturating_add(group.requests);
        }
    }
    for price in prices.values() {
        rows.entry(price.model.clone())
            .or_insert_with(|| UsagePriceRow {
                model: price.model.clone(),
                price: Some(price.clone()),
                ..UsagePriceRow::default()
            });
    }
    let mut rows = rows.into_values().collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left.price
            .is_some()
            .cmp(&right.price.is_some())
            .then_with(|| right.requests.cmp(&left.requests))
            .then_with(|| left.model.cmp(&right.model))
    });
    Ok(UsagePricing {
        rows,
        total_cost,
        total_requests,
        priced_requests,
        saved_prices: prices.len(),
    })
}

#[tauri::command]
pub(crate) fn save_usage_model_price(mut price: ModelPrice) -> Result<(), String> {
    let connection = open_usage_database()?;
    price.model = price.model.trim().to_string();
    price.source = "manual".to_string();
    price.source_model_id.clear();
    price.updated_at_ms = Local::now().timestamp_millis();
    upsert_model_price(&connection, &price)
}

#[tauri::command]
pub(crate) fn delete_usage_model_price(model: String) -> Result<(), String> {
    let connection = open_usage_database()?;
    connection
        .execute(
            "DELETE FROM model_prices WHERE model = ?1 COLLATE NOCASE",
            params![model.trim()],
        )
        .map_err(|error| format!("删除模型价格失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_usage_model_prices(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<ModelPriceSyncResult, String> {
    let config = gui_config_state.snapshot()?;
    let client_builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30));
    let proxy_url = config.proxy_url.trim();
    let client = if proxy_url.is_empty() {
        client_builder.build().ok()
    } else {
        apply_configured_proxy(client_builder, proxy_url)
            .ok()
            .and_then(|builder| builder.build().ok())
    };
    let remote_content = match client {
        Some(client) => match client.get(MODEL_PRICE_SYNC_URL).send().await {
            Ok(response) if response.status().is_success() => response.text().await.ok(),
            _ => None,
        },
        None => None,
    };
    let now = Local::now().timestamp_millis();
    let (remote_prices, used_builtin) = match remote_content
        .as_deref()
        .and_then(|content| parse_model_price_catalog(content, "github", now).ok())
    {
        Some(prices) => (prices, false),
        None => (bundled_model_prices()?, true),
    };

    let mut connection = open_usage_database()?;
    let current_prices = load_model_prices(&connection)?;
    let manual_models = current_prices
        .values()
        .filter(|price| price.source == "manual")
        .map(|price| price.model.to_ascii_lowercase())
        .collect::<std::collections::HashSet<_>>();
    let mut result = ModelPriceSyncResult {
        used_builtin,
        ..ModelPriceSyncResult::default()
    };
    if !used_builtin {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开始更新模型价格失败: {error}"))?;
        transaction
            .execute("DELETE FROM model_prices WHERE source = 'github'", [])
            .map_err(|error| format!("清理旧模型价格失败: {error}"))?;
        for price in remote_prices.values() {
            if manual_models.contains(&price.model.to_ascii_lowercase()) {
                result.skipped += 1;
                continue;
            }
            upsert_model_price(&transaction, price)?;
            result.imported += 1;
        }
        transaction
            .commit()
            .map_err(|error| format!("提交模型价格更新失败: {error}"))?;
    } else {
        connection
            .execute("DELETE FROM model_prices WHERE source = 'github'", [])
            .map_err(|error| format!("恢复软件内置模型价格失败: {error}"))?;
    }

    let filter = build_usage_filter(&query);
    let models = load_usage_cost_groups(&connection, &filter)?
        .into_iter()
        .map(|group| group.model)
        .collect::<std::collections::BTreeSet<_>>();
    let effective_prices = load_model_prices(&connection)?;
    for model in models {
        if resolve_model_price(&model, "", &effective_prices).is_none() {
            result.unmatched.push(model);
        }
    }
    Ok(result)
}

fn canonical_model_tail(value: &str) -> String {
    normalized_model_tail(value)
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn normalized_model_tail(value: &str) -> String {
    value
        .trim()
        .rsplit('/')
        .find(|part| !part.trim().is_empty() && !part.eq_ignore_ascii_case("models"))
        .unwrap_or(value)
        .to_ascii_lowercase()
}

#[tauri::command]
pub(crate) fn get_usage_analysis(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageAnalysis, String> {
    let connection = open_usage_database()?;
    let config = gui_config_state.snapshot()?;
    load_usage_analysis(&connection, &query, &config)
}

fn load_usage_analysis(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
) -> Result<UsageAnalysis, String> {
    Ok(UsageAnalysis {
        models: load_simple_categories(connection, query, "model", "unknown")?,
        providers: load_simple_categories(connection, query, "provider", "未知 Provider")?,
        sources: load_source_categories(connection, query, config)?,
        api_keys: load_api_key_categories(connection, query)?,
    })
}

fn load_source_categories(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
) -> Result<Vec<UsageCategory>, String> {
    let mut categories = load_simple_categories(connection, query, "source", "未知来源")?;
    for category in &mut categories {
        category.label = usage_source_display(config, "", &category.key);
    }
    Ok(categories)
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
            let label = api_key_category_label(remark, display);
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
pub(crate) fn get_usage_events(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageEventPage, String> {
    let connection = open_usage_database()?;
    let config = gui_config_state.snapshot()?;
    load_usage_events(&connection, &query, &config)
}

#[tauri::command]
pub(crate) fn export_usage_records(
    path: String,
    format: UsageExportFormat,
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageExportResult, String> {
    let connection = open_usage_database()?;
    let config = gui_config_state.snapshot()?;
    let records = load_usage_records_for_export(&connection, &query, &config)?;
    let path = normalized_usage_export_path(&path, format)?;
    let content = match format {
        UsageExportFormat::Csv => render_usage_records_csv(&records).into_bytes(),
        UsageExportFormat::Json => serde_json::to_vec_pretty(&records)
            .map_err(|error| format!("Failed to serialize usage records as JSON: {error}"))?,
    };
    fs::write(&path, content).map_err(|error| {
        format!(
            "Failed to write usage export {}: {error}",
            path.to_string_lossy()
        )
    })?;
    Ok(UsageExportResult {
        path: path.to_string_lossy().into_owned(),
        record_count: records.len(),
    })
}

fn normalized_usage_export_path(value: &str, format: UsageExportFormat) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Usage export path is empty".to_string());
    }
    let mut path = PathBuf::from(value);
    if path.file_name().is_none() {
        return Err("Usage export path does not contain a file name".to_string());
    }
    if path.extension().and_then(|value| value.to_str()) != Some(format.extension()) {
        path.set_extension(format.extension());
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err(format!(
            "Usage export directory does not exist: {}",
            parent.to_string_lossy()
        ));
    }
    Ok(path)
}

fn load_usage_records_for_export(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
) -> Result<Vec<UsageRecord>, String> {
    let filter = build_usage_filter(query);
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
        "#,
        filter.clause
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare usage export query: {error}"))?;
    let mut records = statement
        .query_map(
            params_from_iter(filter.params.iter()),
            usage_record_from_row,
        )
        .map_err(|error| format!("Failed to query usage records for export: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read usage records for export: {error}"))?;
    for record in &mut records {
        record.source_display = usage_source_display(config, &record.provider, &record.source);
    }
    Ok(records)
}

fn render_usage_records_csv(records: &[UsageRecord]) -> String {
    const HEADERS: [&str; 27] = [
        "id",
        "timestamp",
        "result",
        "latency_ms",
        "ttft_ms",
        "provider",
        "model",
        "alias",
        "source_display",
        "source",
        "auth_index",
        "auth_type",
        "api_key_display",
        "api_key_remark",
        "api_key_hash",
        "endpoint",
        "reasoning_effort",
        "service_tier",
        "response_service_tier",
        "executor_type",
        "request_id",
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "cache_read_tokens",
        "cache_creation_tokens",
        "total_tokens",
    ];

    let mut output = String::from('\u{feff}');
    append_csv_row(&mut output, HEADERS.iter().copied());
    for record in records {
        let ttft_ms = record
            .ttft_ms
            .map(|value| value.to_string())
            .unwrap_or_default();
        append_csv_row(
            &mut output,
            [
                record.id.clone(),
                record.timestamp.clone(),
                if record.failed { "failed" } else { "success" }.to_string(),
                record.latency_ms.to_string(),
                ttft_ms,
                record.provider.clone(),
                record.model.clone(),
                record.alias.clone(),
                record.source_display.clone(),
                record.source.clone(),
                record.auth_index.clone(),
                record.auth_type.clone(),
                record.api_key_display.clone(),
                record.api_key_remark.clone(),
                record.api_key_hash.clone(),
                record.endpoint.clone(),
                record.reasoning_effort.clone(),
                record.service_tier.clone(),
                record.response_service_tier.clone(),
                record.executor_type.clone(),
                record.request_id.clone(),
                record.tokens.input_tokens.to_string(),
                record.tokens.output_tokens.to_string(),
                record.tokens.reasoning_tokens.to_string(),
                record.tokens.cache_read_tokens.to_string(),
                record.tokens.cache_creation_tokens.to_string(),
                record.tokens.total_tokens.to_string(),
            ],
        );
    }
    output
}

fn append_csv_row<I, S>(output: &mut String, fields: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut first = true;
    for field in fields {
        if !first {
            output.push(',');
        }
        first = false;
        let field = field.as_ref();
        if field.contains([',', '"', '\r', '\n']) {
            output.push('"');
            output.push_str(&field.replace('"', "\"\""));
            output.push('"');
        } else {
            output.push_str(field);
        }
    }
    output.push_str("\r\n");
}

fn load_usage_events(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
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
    let mut items = statement
        .query_map(params_from_iter(values.iter()), usage_record_from_row)
        .map_err(|error| format!("查询 SQLite 使用事件失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 SQLite 使用事件失败: {error}"))?;
    for item in &mut items {
        item.source_display = usage_source_display(config, &item.provider, &item.source);
    }
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
        source_display: String::new(),
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

fn api_key_category_label(remark: String, display: String) -> String {
    if !remark.is_empty() {
        remark
    } else if !display.is_empty() {
        mask_api_key(&display)
    } else {
        "未记录密钥".to_string()
    }
}

fn usage_source_display(config: &GuiConfigFile, provider: &str, source: &str) -> String {
    let source = source.trim();
    if source.is_empty() {
        return "未知来源".to_string();
    }
    if let Some(remark) = config.api_access_remark_for_source(provider, source) {
        return remark.to_string();
    }
    let character_count = source.chars().count();
    let looks_like_secret = !source.contains('@')
        && !source.chars().any(char::is_whitespace)
        && (source.starts_with("sk-")
            || source.starts_with("AIza")
            || source.starts_with("key-")
            || character_count >= 48);
    if looks_like_secret {
        mask_api_key(source)
    } else {
        source.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_total_records_are_cached_and_incremented() {
        let state = UsageCollectorState::default();
        state.set_total_records(40);
        state.increment_total_records(2);

        assert_eq!(state.status().unwrap().total_records, 42);
    }

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
            source_display: String::new(),
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
    fn api_key_category_uses_either_remark_or_masked_key() {
        assert_eq!(
            api_key_category_label("生产环境".to_string(), "12••••".to_string()),
            "生产环境"
        );
        assert_eq!(
            api_key_category_label(String::new(), "123456".to_string()),
            "12••••"
        );
    }

    #[test]
    fn usage_source_prefers_api_access_remark_and_masks_secret_fallbacks() {
        let key = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
        let mut config = GuiConfigFile::default();
        config.api_access_remarks.push(crate::GuiApiAccessRemark {
            provider_section: "codex-api-key".to_string(),
            api_key_hash: hash_text(key),
            remark: "生产环境".to_string(),
        });

        assert_eq!(usage_source_display(&config, "codex", key), "生产环境");
        assert_eq!(
            usage_source_display(&GuiConfigFile::default(), "codex", key),
            "sk-1••••wxyz"
        );
        assert_eq!(
            usage_source_display(&config, "codex", "account@example.com"),
            "account@example.com"
        );
    }

    #[test]
    fn local_hour_key_uses_year_month_day_and_hour() {
        let record = sample_record("id", "2026-07-17T20:30:00+08:00", "model");
        assert_eq!(record_local_hour(&record).len(), "2026-07-17-20".len());
    }

    #[test]
    fn normalizes_queue_records_without_persisting_secrets_or_headers() {
        let config = GuiConfigFile {
            locale: "zh-CN".to_string(),
            port: 8317,
            allow_lan: false,
            host: "127.0.0.1".to_string(),
            run_on_startup: false,
            silent_start: false,
            close_behavior: crate::WindowsCloseBehavior::Ask,
            window_width: None,
            window_height: None,
            auth_dir: String::new(),
            api_keys: Vec::new(),
            api_access_remarks: Vec::new(),
            management_secret_key: "123456".to_string(),
            usage_statistics_enabled: true,
            plugins_enabled: false,
            routing_strategy: "round-robin".to_string(),
            proxy_url: String::new(),
            routing_session_affinity: false,
            routing_session_affinity_ttl: String::new(),
        };
        let record = normalize_usage_record(
            serde_json::json!({
                "timestamp": "2026-07-17T20:30:00+08:00",
                "request_id": "request-1",
                "api_key": "secret-client-key",
                "response_headers": { "authorization": ["secret-upstream-token"] },
                "model": "gpt-test",
                "tokens": {
                    "input_tokens": 10,
                    "output_tokens": 20,
                    "cached_tokens": 7,
                    "cache_read_tokens": 5,
                    "cache_creation_tokens": 2
                }
            }),
            &config,
        )
        .unwrap();
        let rendered = serde_json::to_string(&record).unwrap();

        assert!(!rendered.contains("secret-client-key"));
        assert!(!rendered.contains("secret-upstream-token"));
        assert_eq!(record.tokens.total_tokens, 30);
        assert_eq!(record.tokens.cache_read_tokens, 5);
        assert!(!record.api_key_hash.is_empty());
    }

    #[test]
    fn persists_successful_health_checks_and_zero_token_websocket_events() {
        let root = test_root("queue-events-without-generation");
        initialize_usage_storage_at(&root).unwrap();
        let config = GuiConfigFile::default();
        let inserted = persist_queue_items(
            &root,
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:00+08:00",
                    "request_id": "cherry-health-check",
                    "generate": false,
                    "failed": false,
                    "provider": "openai",
                    "model": "gpt-test",
                    "endpoint": "POST /v1/chat/completions",
                    "tokens": {
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "total_tokens": 2
                    }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:01+08:00",
                    "request_id": "websocket-zero-token",
                    "failed": false,
                    "provider": "codex",
                    "model": "gpt-test",
                    "executor_type": "CodexWebsocketsExecutor",
                    "tokens": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "total_tokens": 0
                    }
                }),
            ],
            &config,
        )
        .unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let events = load_usage_events(
            &connection,
            &UsageQuery {
                failed: Some(false),
                ..UsageQuery::default()
            },
            &config,
        )
        .unwrap();

        assert_eq!(inserted, 2);
        assert_eq!(events.total, 2);
        assert!(events.items.iter().all(|event| !event.failed));
        assert!(events
            .items
            .iter()
            .any(|event| event.request_id == "cherry-health-check"));
        assert!(events
            .items
            .iter()
            .any(|event| event.request_id == "websocket-zero-token"));
        drop(connection);
        fs::remove_dir_all(root).unwrap();
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
        drop(connection);
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
        drop(connection);
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
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_queries_filter_aggregate_and_paginate() {
        let root = test_root("sqlite-query");
        let mut connection = open_test_database(&root);
        let success = sample_record("request-1", "2026-07-17T20:30:00+08:00", "gpt-a");
        let mut failed = sample_record("request-2", "2026-07-17T21:30:00+08:00", "gpt-5.6-terra");
        failed.failed = true;
        insert_usage_records(&mut connection, &[success, failed]).unwrap();
        let query = UsageQuery {
            model: Some("GPT-5.6-TERRA".to_string()),
            failed: Some(true),
            page_size: Some(20),
            ..UsageQuery::default()
        };

        let overview = load_usage_overview(&connection, &query).unwrap();
        let config = GuiConfigFile::default();
        let analysis = load_usage_analysis(&connection, &query, &config).unwrap();
        let events = load_usage_events(&connection, &query, &config).unwrap();

        assert_eq!(overview.total_requests, 1);
        assert_eq!(overview.failure_count, 1);
        assert_eq!(overview.tps, 200.0);
        assert_eq!(overview.cache_hit_rate, 0.2);
        assert!((overview.estimated_cost - 0.0003205).abs() < 0.0000001);
        assert_eq!(overview.priced_requests, 1);
        assert_eq!(analysis.models[0].key, "gpt-5.6-terra");
        assert_eq!(events.total, 1);
        assert_eq!(events.items[0].id, "request-2");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn usage_export_query_applies_filters_without_pagination() {
        let root = test_root("export-query");
        let mut connection = open_test_database(&root);
        let first = sample_record("request-1", "2026-07-17T20:30:00+08:00", "gpt-a");
        let second = sample_record("request-2", "2026-07-17T21:30:00+08:00", "gpt-a");
        let mut failed = sample_record("request-3", "2026-07-17T22:30:00+08:00", "gpt-a");
        failed.failed = true;
        insert_usage_records(&mut connection, &[first, second, failed]).unwrap();

        let records = load_usage_records_for_export(
            &connection,
            &UsageQuery {
                model: Some("GPT-A".to_string()),
                failed: Some(false),
                page: Some(2),
                page_size: Some(1),
                ..UsageQuery::default()
            },
            &GuiConfigFile::default(),
        )
        .unwrap();

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, "request-2");
        assert_eq!(records[1].id, "request-1");
        assert!(records.iter().all(|record| !record.failed));
        assert!(records
            .iter()
            .all(|record| record.source_display == "source"));
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn csv_export_is_excel_friendly_and_escapes_special_characters() {
        let mut record = sample_record(
            "request-1",
            "2026-07-17T20:30:00+08:00",
            "模型, \"A\"\n下一行",
        );
        record.api_key_remark = "繁體中文".to_string();
        let csv = render_usage_records_csv(&[record]);

        assert!(csv.starts_with('\u{feff}'));
        assert!(csv.starts_with("\u{feff}id,timestamp,result,"));
        assert!(csv.contains("\"模型, \"\"A\"\"\n下一行\""));
        assert!(csv.contains("繁體中文"));
        assert!(csv.ends_with("\r\n"));
    }

    #[test]
    fn export_path_adds_the_selected_extension() {
        let root = test_root("export-path");
        let base = root.join("usage-history");
        let csv =
            normalized_usage_export_path(base.to_string_lossy().as_ref(), UsageExportFormat::Csv)
                .unwrap();
        let explicit_json = root.join("usage-history.json");
        let json = normalized_usage_export_path(
            explicit_json.to_string_lossy().as_ref(),
            UsageExportFormat::Json,
        )
        .unwrap();

        assert_eq!(csv, base.with_extension("csv"));
        assert_eq!(json, explicit_json);
        assert_eq!(
            normalized_usage_export_path(
                explicit_json.to_string_lossy().as_ref(),
                UsageExportFormat::Csv,
            )
            .unwrap(),
            explicit_json.with_extension("csv")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn estimates_gpt56_cost_with_cache_and_service_tier_rules() {
        let terra = official_model_price("openai/gpt-5.6-terra").unwrap();
        let standard_tokens = CostTokens {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 200_000,
            cache_creation: 100_000,
            ..CostTokens::default()
        };
        let standard = cost_for_price("openai/gpt-5.6-terra", "default", &standard_tokens, &terra);
        assert!((standard - 17.1125).abs() < 0.000001);

        let long_tokens = CostTokens {
            input: 300_000,
            output: 200_000,
            cache_read: 100_000,
            long_input: 300_000,
            long_output: 200_000,
            long_cache_read: 100_000,
            ..CostTokens::default()
        };
        let long_priority = cost_for_price("gpt-5.6-terra", "priority", &long_tokens, &terra);
        assert!((long_priority - 5.55).abs() < 0.000001);
        assert!(official_model_price("unpriced-model").is_none());
    }

    #[test]
    fn bundled_model_prices_are_available_offline_and_override_legacy_cloud_cache() {
        let root = test_root("bundled-pricing");
        let connection = open_test_database(&root);
        let bundled = bundled_model_prices().unwrap();
        assert!(bundled.len() >= 50);
        assert!(bundled.values().all(|price| price.source == "builtin"));
        assert_eq!(
            find_model_price(&bundled, "openai/gpt-5.6-terra-high")
                .unwrap()
                .prompt,
            2.5
        );

        upsert_model_price(
            &connection,
            &ModelPrice {
                model: "gpt-5.6-terra".to_string(),
                prompt: 999.0,
                completion: 999.0,
                prompt_configured: true,
                completion_configured: true,
                source: "litellm".to_string(),
                ..ModelPrice::default()
            },
        )
        .unwrap();
        let prices = load_model_prices(&connection).unwrap();
        assert_eq!(prices["gpt-5.6-terra"].prompt, 2.5);
        assert_eq!(prices["gpt-5.6-terra"].source, "builtin");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manual_model_prices_drive_pricing_and_overview_cost() {
        let root = test_root("manual-pricing");
        let mut connection = open_test_database(&root);
        let record = sample_record("request-1", "2026-07-17T20:30:00+08:00", "custom-model");
        insert_usage_records(&mut connection, &[record]).unwrap();
        upsert_model_price(
            &connection,
            &ModelPrice {
                model: "custom-model".to_string(),
                prompt: 1.0,
                completion: 2.0,
                cache: 0.1,
                prompt_configured: true,
                completion_configured: true,
                source: "manual".to_string(),
                ..ModelPrice::default()
            },
        )
        .unwrap();

        let query = UsageQuery::default();
        let overview = load_usage_overview(&connection, &query).unwrap();
        let pricing = load_usage_pricing(&connection, &query).unwrap();

        assert!((overview.estimated_cost - 0.0000482).abs() < 0.0000001);
        assert_eq!(overview.priced_requests, 1);
        assert!((pricing.total_cost - overview.estimated_cost).abs() < f64::EPSILON);
        assert_eq!(pricing.rows[0].model, "custom-model");
        assert_eq!(
            pricing.saved_prices,
            bundled_model_prices().unwrap().len() + 1
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
