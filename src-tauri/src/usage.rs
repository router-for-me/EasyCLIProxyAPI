mod resp;

#[cfg(target_os = "macos")]
use super::executable_dir;
#[cfg(test)]
use super::VersionDownloadSource;
use super::{
    apply_configured_proxy, core_base_dir, current_core_status, format_management_request_error,
    management_authorization, management_endpoint, management_http_client, CoreProcessState,
    GuiConfigFile, GuiConfigState,
};
use chrono::{DateTime, Local};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row,
    Transaction,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

use self::resp::UsageSubscription;

const USAGE_DIR_NAME: &str = "usage-records";
const USAGE_DATABASE_FILE: &str = "usage.db";
const USAGE_BACKUP_DIR_NAME: &str = "backups";
const LEGACY_USAGE_EVENTS_DIR: &str = "events";
const LEGACY_USAGE_INBOX_DIR: &str = "inbox";
const LEGACY_JSON_MIGRATION_KEY: &str = "legacy_json_v1";
const USAGE_DATABASE_MIGRATION_KEY: &str = "keeper_v3";
const USAGE_FAILURE_MIGRATION_KEY: &str = "failure_details_v4";
const USAGE_EVENT_KEY_MIGRATION_KEY: &str = "event_key_v5";
const USAGE_UPDATED_EVENT: &str = "usage-records-updated";
const USAGE_SCHEMA_VERSION: u8 = 1;
const USAGE_DATABASE_SCHEMA_VERSION: i64 = 5;
const MAX_USAGE_FAILURE_BODY_CHARS: usize = 2_000;
const USAGE_QUEUE_BATCH_SIZE: usize = 500;
const USAGE_INBOX_PROCESS_LIMIT: usize = 500;
const USAGE_INBOX_MAX_ATTEMPTS: i64 = 5;
const USAGE_SUBSCRIBE_RETRY_SECONDS: u64 = 30;
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UsageDatabaseLayout {
    Empty,
    LegacyV2,
    CurrentV3,
}

#[derive(Debug)]
struct UsageInboxRow {
    id: i64,
    source: String,
    raw_message: String,
    attempt_count: i64,
}

#[derive(Debug, Eq, PartialEq)]
struct UsageMigrationSnapshot {
    records: i64,
    input_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    total_tokens: i64,
    successes: i64,
    failures: i64,
    first_timestamp: Option<String>,
    last_timestamp: Option<String>,
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
    canceled: bool,
    #[serde(default)]
    failure_status: u16,
    #[serde(default)]
    failure_body: String,
    #[serde(default)]
    provider: String,
    #[serde(default, skip_serializing)]
    api_group_key: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    alias: String,
    #[serde(default, skip_serializing)]
    client_ip: Option<String>,
    #[serde(default, skip_serializing)]
    x_forwarded_for: Option<String>,
    #[serde(default, skip_serializing)]
    user_agent: Option<String>,
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
    #[serde(default = "default_usage_generate", skip_serializing)]
    generate: bool,
    #[serde(default, skip_serializing)]
    cached_tokens: u64,
    #[serde(default, skip_serializing)]
    collector_source: String,
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
    canceled: Option<bool>,
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
    canceled_count: u64,
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
    tps_sample_count: u64,
    average_latency_ms: f64,
    cache_hit_rate: f64,
    estimated_cost: f64,
    priced_requests: u64,
    timeline: Vec<UsageTimelinePoint>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageRepairResult {
    scanned: u64,
    repaired: u64,
    deleted: u64,
    backup_path: Option<String>,
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
    canceled: u64,
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
    let root = usage_root_dir()?;
    migrate_legacy_usage_storage(&root)?;
    initialize_usage_storage_at(&root)
}

#[cfg(target_os = "macos")]
fn migrate_legacy_usage_storage(target: &Path) -> Result<(), String> {
    let legacy = executable_dir()?.join(USAGE_DIR_NAME);
    migrate_usage_storage_directory(&legacy, target)
}

#[cfg(not(target_os = "macos"))]
fn migrate_legacy_usage_storage(target: &Path) -> Result<(), String> {
    let _ = target;
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn migrate_usage_storage_directory(source: &Path, target: &Path) -> Result<(), String> {
    if source == target || !source.is_dir() || target.exists() {
        return Ok(());
    }
    let target_parent = target
        .parent()
        .ok_or_else(|| "使用记录目标目录没有父目录".to_string())?;
    fs::create_dir_all(target_parent)
        .map_err(|error| format!("创建使用记录迁移目标目录失败: {error}"))?;
    if fs::rename(source, target).is_ok() {
        return Ok(());
    }

    if let Err(error) = copy_usage_storage_directory(source, target) {
        let _ = fs::remove_dir_all(target);
        return Err(format!("迁移旧版使用记录失败: {error}"));
    }
    if let Err(error) = fs::remove_dir_all(source) {
        eprintln!(
            "旧版使用记录已复制，但无法清理原目录 {}: {error}",
            source.display()
        );
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn copy_usage_storage_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("创建使用记录目录失败: {error}"))?;
    let entries = fs::read_dir(source).map_err(|error| format!("读取旧版使用记录失败: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取旧版使用记录项目失败: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取旧版使用记录项目类型失败: {error}"))?;
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_usage_storage_directory(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &destination)
                .map_err(|error| format!("复制旧版使用记录失败: {error}"))?;
        } else {
            return Err(format!(
                "旧版使用记录包含不支持的文件类型: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

fn initialize_usage_storage_at(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("创建使用记录目录失败: {error}"))?;
    let mut connection = open_usage_database_at(root)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("启用 SQLite WAL 失败: {error}"))?;
    migrate_usage_database(&mut connection, root)?;
    migrate_legacy_json_storage(&mut connection, root)?;
    cleanup_usage_inbox(&connection, Local::now())
}

#[tauri::command]
pub(crate) fn repair_usage_cache_records() -> Result<UsageRepairResult, String> {
    let root = usage_root_dir()?;
    repair_usage_cache_records_at(&root)
}

fn repair_usage_cache_records_at(root: &Path) -> Result<UsageRepairResult, String> {
    let mut connection = open_usage_database_at(root)?;
    let candidate_count: i64 = connection
        .query_row(
            r#"SELECT COUNT(*) FROM usage_events
               WHERE lower(trim(model)) = 'unknown'
                  OR (input_tokens > 0
                      AND cache_read_tokens + cache_creation_tokens > input_tokens
                      AND (lower(executor_type) = 'claudeexecutor'
                           OR lower(provider) = 'claude'
                           OR lower(provider) LIKE '%anthropic%'))"#,
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查历史使用记录异常行失败: {error}"))?;

    if candidate_count <= 0 {
        return Ok(UsageRepairResult::default());
    }

    let backup_path = {
        let backup_dir = root.join(USAGE_BACKUP_DIR_NAME);
        fs::create_dir_all(&backup_dir)
            .map_err(|error| format!("创建 Claude 使用记录迁移备份目录失败: {error}"))?;
        let backup_path = backup_dir.join(format!(
            "usage-before-history-repair-v2-{}.db",
            unique_file_stamp()
        ));
        connection
            .execute(
                "VACUUM INTO ?1",
                params![backup_path.to_string_lossy().to_string()],
            )
            .map_err(|error| format!("备份 Claude 使用记录失败: {error}"))?;
        backup_path.to_string_lossy().to_string()
    };

    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始 Claude 使用记录迁移事务失败: {error}"))?;
    let migrated = transaction
        .execute(
            r#"UPDATE usage_events
               SET input_tokens = input_tokens + cache_read_tokens + cache_creation_tokens,
                   total_tokens = CASE
                       WHEN total_tokens = 0
                            OR total_tokens = input_tokens + output_tokens
                       THEN input_tokens + cache_read_tokens + cache_creation_tokens + output_tokens
                       ELSE total_tokens
                   END,
                   cached_tokens = MAX(cached_tokens, cache_read_tokens + cache_creation_tokens)
               WHERE input_tokens > 0
                 AND cache_read_tokens + cache_creation_tokens > input_tokens
                 AND lower(trim(model)) <> 'unknown'
                 AND (lower(executor_type) = 'claudeexecutor'
                      OR lower(provider) = 'claude'
                      OR lower(provider) LIKE '%anthropic%')"#,
            [],
        )
        .map_err(|error| format!("迁移 Claude 使用记录失败: {error}"))?;
    let deleted = transaction
        .execute(
            "DELETE FROM usage_events WHERE lower(trim(model)) = 'unknown'",
            [],
        )
        .map_err(|error| format!("删除历史 unknown 记录失败: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交 Claude 使用记录迁移失败: {error}"))?;
    Ok(UsageRepairResult {
        scanned: candidate_count.max(0) as u64,
        repaired: migrated as u64,
        deleted: deleted as u64,
        backup_path: Some(backup_path),
    })
}

fn migrate_usage_database(connection: &mut Connection, root: &Path) -> Result<(), String> {
    match detect_usage_database_layout(connection)? {
        UsageDatabaseLayout::Empty => initialize_usage_schema(connection),
        UsageDatabaseLayout::CurrentV3 => {
            initialize_usage_schema(connection)?;
            migrate_usage_event_key_uniqueness(connection)
        }
        UsageDatabaseLayout::LegacyV2 => {
            let backup_path = create_usage_migration_backup(connection, root)?;
            if let Err(error) = migrate_legacy_v2_usage_schema(connection) {
                return Err(format!(
                    "迁移旧版使用记录数据库失败，备份保留在 {}: {error}",
                    backup_path.display()
                ));
            }
            initialize_usage_schema(connection)
        }
    }
}

fn detect_usage_database_layout(connection: &Connection) -> Result<UsageDatabaseLayout, String> {
    if !usage_table_exists(connection, "usage_events")? {
        return Ok(UsageDatabaseLayout::Empty);
    }
    let columns = usage_table_columns(connection, "usage_events")?;
    let legacy_columns = [
        "event_key",
        "timestamp_ms",
        "local_hour",
        "api_key_hash",
        "api_key_display",
        "api_key_remark",
    ];
    if !legacy_columns
        .iter()
        .all(|column| columns.contains(*column))
    {
        return Err("无法识别使用记录数据库结构，已拒绝自动迁移".to_string());
    }
    let keeper_columns = [
        "api_group_key",
        "model_alias",
        "client_ip",
        "x_forwarded_for",
        "user_agent",
        "generate",
        "cached_tokens",
        "collector_source",
    ];
    let keeper_column_count = keeper_columns
        .iter()
        .filter(|column| columns.contains(**column))
        .count();
    if keeper_column_count == 0 && !usage_table_exists(connection, "usage_inbox")? {
        return Ok(UsageDatabaseLayout::LegacyV2);
    }
    if keeper_column_count == keeper_columns.len()
        && usage_table_exists(connection, "usage_inbox")?
        && usage_table_exists(connection, "usage_aggregation_checkpoints")?
    {
        return Ok(UsageDatabaseLayout::CurrentV3);
    }
    Err("检测到不完整的使用记录数据库迁移，已拒绝继续修改".to_string())
}

fn usage_table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists != 0)
        .map_err(|error| format!("检查 SQLite 表 {table} 失败: {error}"))
}

fn usage_table_columns(connection: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .map_err(|error| format!("准备读取 SQLite 表结构失败 {table}: {error}"))?;
    let columns = statement
        .query_map(params![table], |row| row.get::<_, String>(0))
        .map_err(|error| format!("读取 SQLite 表结构失败 {table}: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("解析 SQLite 表结构失败 {table}: {error}"))?;
    Ok(columns)
}

fn migrate_usage_event_key_uniqueness(connection: &mut Connection) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![USAGE_EVENT_KEY_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("read usage event key migration state failed: {error}"))?;
    if migrated.is_some() {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("begin usage event key migration failed: {error}"))?;
    ensure_usage_event_key_non_unique_in_transaction(&transaction)?;
    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![USAGE_EVENT_KEY_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("record usage event key migration state failed: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("commit usage event key migration failed: {error}"))
}

fn ensure_usage_event_key_non_unique_in_transaction(connection: &Connection) -> Result<(), String> {
    if !usage_table_exists(connection, "usage_events")? {
        return Ok(());
    }

    let unique_indexes = usage_event_key_unique_indexes(connection)?;
    if unique_indexes.is_empty() {
        create_usage_event_key_index(connection)?;
        return Ok(());
    }

    if unique_indexes
        .iter()
        .all(|(_, is_auto_index)| !is_auto_index)
    {
        for (index_name, _) in unique_indexes {
            connection
                .execute(
                    &format!(
                        "DROP INDEX IF EXISTS {}",
                        quote_sqlite_identifier(&index_name)
                    ),
                    [],
                )
                .map_err(|error| {
                    format!("drop unique usage event key index {index_name} failed: {error}")
                })?;
        }
        create_usage_event_key_index(connection)?;
        return Ok(());
    }

    rebuild_usage_events_without_event_key_unique(connection, &unique_indexes)
}

fn usage_event_key_unique_indexes(connection: &Connection) -> Result<Vec<(String, bool)>, String> {
    let index_names = {
        let mut statement = connection
            .prepare("SELECT name FROM pragma_index_list(?1) WHERE \"unique\" != 0 ORDER BY seq")
            .map_err(|error| format!("prepare usage event key index query failed: {error}"))?;
        let index_names = statement
            .query_map(params!["usage_events"], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query usage event key indexes failed: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read usage event key indexes failed: {error}"))?;
        index_names
    };

    let mut matches = Vec::new();
    for index_name in index_names {
        let mut statement = connection
            .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
            .map_err(|error| format!("prepare usage event key index columns failed: {error}"))?;
        let columns = statement
            .query_map(params![index_name.as_str()], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query usage event key index columns failed: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read usage event key index columns failed: {error}"))?;
        if columns.len() == 1 && columns[0] == "event_key" {
            matches.push((
                index_name.clone(),
                index_name.starts_with("sqlite_autoindex_"),
            ));
        }
    }
    Ok(matches)
}

fn rebuild_usage_events_without_event_key_unique(
    connection: &Connection,
    unique_indexes: &[(String, bool)],
) -> Result<(), String> {
    let table_sql = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params!["usage_events"],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("read usage events table schema failed: {error}"))?;
    let temporary_table = format!("usage_events_rebuild_{}", unique_file_stamp());
    let create_table_sql = replace_sql_fragment_case_insensitive(
        &table_sql,
        "create table usage_events",
        &format!("CREATE TABLE {temporary_table}"),
    )
    .or_else(|| {
        replace_sql_fragment_case_insensitive(
            &table_sql,
            "create table if not exists usage_events",
            &format!("CREATE TABLE {temporary_table}"),
        )
    })
    .ok_or_else(|| "usage events table schema has an unsupported CREATE TABLE form".to_string())?;
    let create_table_sql = replace_sql_fragment_case_insensitive(
        &create_table_sql,
        "event_key text not null unique",
        "event_key TEXT NOT NULL",
    )
    .ok_or_else(|| {
        "usage events table schema does not contain the expected unique event_key constraint"
            .to_string()
    })?;

    let unique_index_names = unique_indexes
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<HashSet<_>>();
    let index_sqls = {
        let mut statement = connection
            .prepare(
                "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL ORDER BY name",
            )
            .map_err(|error| format!("prepare usage event index schema query failed: {error}"))?;
        let index_sqls = statement
            .query_map(params!["usage_events"], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("query usage event index schemas failed: {error}"))?
            .filter_map(|row| match row {
                Ok((name, sql)) if !unique_index_names.contains(name.as_str()) => Some(Ok(sql)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read usage event index schemas failed: {error}"))?;
        index_sqls
    };

    connection
        .execute_batch(&create_table_sql)
        .map_err(|error| format!("create rebuilt usage events table failed: {error}"))?;
    connection
        .execute(
            &format!(
                "INSERT INTO {} SELECT * FROM usage_events",
                quote_sqlite_identifier(&temporary_table)
            ),
            [],
        )
        .map_err(|error| format!("copy usage events during event key migration failed: {error}"))?;
    connection
        .execute("DROP TABLE usage_events", [])
        .map_err(|error| format!("drop old usage events table failed: {error}"))?;
    connection
        .execute(
            &format!(
                "ALTER TABLE {} RENAME TO usage_events",
                quote_sqlite_identifier(&temporary_table)
            ),
            [],
        )
        .map_err(|error| format!("rename rebuilt usage events table failed: {error}"))?;

    for index_sql in index_sqls {
        connection
            .execute_batch(&index_sql)
            .map_err(|error| format!("restore usage event index failed: {error}"))?;
    }
    create_usage_event_key_index(connection)
}

fn create_usage_event_key_index(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_events_event_key ON usage_events(event_key)",
            [],
        )
        .map(|_| ())
        .map_err(|error| format!("create usage event key index failed: {error}"))
}

fn quote_sqlite_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn replace_sql_fragment_case_insensitive(
    value: &str,
    needle: &str,
    replacement: &str,
) -> Option<String> {
    let value_lower = value.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();
    let start = value_lower.find(&needle_lower)?;
    let mut result = String::with_capacity(value.len() + replacement.len());
    result.push_str(&value[..start]);
    result.push_str(replacement);
    result.push_str(&value[start + needle.len()..]);
    Some(result)
}

fn create_usage_migration_backup(connection: &Connection, root: &Path) -> Result<PathBuf, String> {
    let backup_dir = root.join(USAGE_BACKUP_DIR_NAME);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("创建使用记录备份目录失败: {error}"))?;
    let backup_path = backup_dir.join(format!("usage-before-keeper-v3-{}.db", unique_file_stamp()));
    connection
        .execute(
            "VACUUM INTO ?1",
            params![backup_path.to_string_lossy().to_string()],
        )
        .map_err(|error| format!("备份旧版使用记录数据库失败: {error}"))?;
    Ok(backup_path)
}

fn migrate_legacy_v2_usage_schema(connection: &mut Connection) -> Result<(), String> {
    let before = load_usage_migration_snapshot(connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始使用记录数据库迁移事务失败: {error}"))?;
    transaction
        .execute_batch(
            r#"
            ALTER TABLE usage_events ADD COLUMN api_group_key TEXT NOT NULL DEFAULT '';
            ALTER TABLE usage_events ADD COLUMN model_alias TEXT;
            ALTER TABLE usage_events ADD COLUMN client_ip TEXT;
            ALTER TABLE usage_events ADD COLUMN x_forwarded_for TEXT;
            ALTER TABLE usage_events ADD COLUMN user_agent TEXT;
            ALTER TABLE usage_events ADD COLUMN generate INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE usage_events ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE usage_events ADD COLUMN collector_source TEXT NOT NULL DEFAULT 'legacy_migration';

            UPDATE usage_events
            SET api_group_key = CASE
                    WHEN api_key_hash != '' THEN api_key_hash
                    WHEN provider != '' THEN provider
                    WHEN endpoint != '' THEN endpoint
                    ELSE 'unknown'
                END,
                model_alias = NULLIF(alias, ''),
                generate = CASE
                    WHEN failed = 0
                         AND executor_type = 'CodexWebsocketsExecutor'
                         AND input_tokens = 0
                         AND output_tokens = 0
                         AND reasoning_tokens = 0
                         AND cache_read_tokens = 0
                         AND cache_creation_tokens = 0
                         AND total_tokens = 0
                    THEN 0 ELSE 1
                END,
                cached_tokens = cache_read_tokens + cache_creation_tokens,
                collector_source = 'legacy_migration';
            "#,
        )
        .map_err(|error| format!("转换旧版使用记录字段失败: {error}"))?;
    let after = load_usage_migration_snapshot(&transaction)?;
    if before != after {
        return Err(format!(
            "使用记录迁移校验不一致，迁移前 {before:?}，迁移后 {after:?}"
        ));
    }
    initialize_usage_schema(&transaction)?;
    ensure_usage_event_key_non_unique_in_transaction(&transaction)?;
    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![USAGE_EVENT_KEY_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("record usage event key migration state failed: {error}"))?;
    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![USAGE_DATABASE_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("写入使用记录迁移标记失败: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交使用记录数据库迁移失败: {error}"))
}

fn load_usage_migration_snapshot(
    connection: &Connection,
) -> Result<UsageMigrationSnapshot, String> {
    connection
        .query_row(
            r#"
            SELECT
                COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(reasoning_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_creation_tokens), 0),
                COALESCE(SUM(total_tokens), 0),
                COALESCE(SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN failed != 0 THEN 1 ELSE 0 END), 0),
                MIN(timestamp),
                MAX(timestamp)
            FROM usage_events
            "#,
            [],
            |row| {
                Ok(UsageMigrationSnapshot {
                    records: row.get(0)?,
                    input_tokens: row.get(1)?,
                    output_tokens: row.get(2)?,
                    reasoning_tokens: row.get(3)?,
                    cache_read_tokens: row.get(4)?,
                    cache_creation_tokens: row.get(5)?,
                    total_tokens: row.get(6)?,
                    successes: row.get(7)?,
                    failures: row.get(8)?,
                    first_timestamp: row.get(9)?,
                    last_timestamp: row.get(10)?,
                })
            },
        )
        .map_err(|error| format!("读取使用记录迁移校验快照失败: {error}"))
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
                event_key TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                local_hour TEXT NOT NULL,
                latency_ms INTEGER NOT NULL DEFAULT 0,
                ttft_ms INTEGER,
                source TEXT NOT NULL DEFAULT '',
                auth_index TEXT NOT NULL DEFAULT '',
                failed INTEGER NOT NULL DEFAULT 0,
                canceled INTEGER NOT NULL DEFAULT 0,
                failure_status INTEGER NOT NULL DEFAULT 0,
                failure_body TEXT NOT NULL DEFAULT '',
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
                api_group_key TEXT NOT NULL DEFAULT '',
                model_alias TEXT,
                client_ip TEXT,
                x_forwarded_for TEXT,
                user_agent TEXT,
                generate INTEGER NOT NULL DEFAULT 1,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                collector_source TEXT NOT NULL DEFAULT '',
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
            CREATE INDEX IF NOT EXISTS idx_usage_events_event_key
                ON usage_events(event_key);
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
            CREATE INDEX IF NOT EXISTS idx_usage_events_api_group_timestamp
                ON usage_events(api_group_key, timestamp_ms DESC);

            CREATE TABLE IF NOT EXISTS usage_inbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                message_hash TEXT NOT NULL,
                raw_message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',
                usage_event_key TEXT NOT NULL DEFAULT '',
                received_at TEXT NOT NULL,
                processed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_usage_inbox_status_id
                ON usage_inbox(status, id);

            CREATE TABLE IF NOT EXISTS usage_aggregation_checkpoints (
                name TEXT PRIMARY KEY NOT NULL,
                last_usage_event_id INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );

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
            "#,
        )
        .map_err(|error| format!("初始化 SQLite 使用记录结构失败: {error}"))?;
    ensure_usage_failure_columns(connection)?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_events_canceled_timestamp ON usage_events(canceled, timestamp_ms DESC)",
            [],
        )
        .map_err(|error| format!("创建 SQLite 取消记录索引失败: {error}"))?;
    connection
        .pragma_update(None, "user_version", USAGE_DATABASE_SCHEMA_VERSION)
        .map_err(|error| format!("更新 SQLite 使用记录版本失败: {error}"))
}

fn ensure_usage_failure_columns(connection: &Connection) -> Result<(), String> {
    let mut columns = usage_table_columns(connection, "usage_events")?;
    for (column, definition) in [
        ("canceled", "INTEGER NOT NULL DEFAULT 0"),
        ("failure_status", "INTEGER NOT NULL DEFAULT 0"),
        ("failure_body", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if columns.contains(column) {
            continue;
        }
        connection
            .execute(
                &format!("ALTER TABLE usage_events ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| format!("添加 SQLite 使用记录字段 {column} 失败: {error}"))?;
        columns.insert(column.to_string());
    }
    backfill_usage_failure_details(connection)?;
    Ok(())
}

fn backfill_usage_failure_details(connection: &Connection) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![USAGE_FAILURE_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("读取使用记录失败详情迁移状态失败: {error}"))?;
    if migrated.is_some() {
        return Ok(());
    }

    if usage_table_exists(connection, "usage_inbox")? {
        let rows = {
            let mut statement = connection
                .prepare(
                    r#"
                    SELECT usage_event_key, raw_message
                    FROM usage_inbox
                    WHERE status = 'processed' AND usage_event_key != ''
                    "#,
                )
                .map_err(|error| format!("准备回填使用记录失败详情失败: {error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("查询使用记录失败详情失败: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("读取使用记录失败详情失败: {error}"))?;
            rows
        };
        for (event_key, raw_message) in rows {
            let Some(object) = serde_json::from_str::<Value>(&raw_message)
                .ok()
                .and_then(|value| value.as_object().cloned())
            else {
                continue;
            };
            if !object
                .get("failed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let (failure_status, failure_body) = usage_failure_details(&object);
            let canceled = usage_failure_is_canceled(failure_status, &failure_body);
            connection
                .execute(
                    r#"
                    UPDATE usage_events
                    SET canceled = ?1, failure_status = ?2, failure_body = ?3
                    WHERE event_key = ?4
                    "#,
                    params![canceled, i64::from(failure_status), failure_body, event_key],
                )
                .map_err(|error| format!("回填使用记录失败详情失败: {error}"))?;
        }
    }

    connection
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![USAGE_FAILURE_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("记录使用记录失败详情迁移状态失败: {error}"))?;
    Ok(())
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
    let mut subscription: Option<UsageSubscription> = None;
    let mut subscribe_retry_at = tokio::time::Instant::now();
    let mut next_inbox_cleanup_at = tokio::time::Instant::now() + Duration::from_secs(60 * 60);
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
        if tokio::time::Instant::now() >= next_inbox_cleanup_at {
            if let Err(error) = open_usage_database_at(&root)
                .and_then(|connection| cleanup_usage_inbox(&connection, Local::now()))
            {
                eprintln!("清理使用记录 inbox 失败: {error}");
            }
            next_inbox_cleanup_at = tokio::time::Instant::now() + Duration::from_secs(60 * 60);
        }
        let recovered = open_usage_database_at(&root)
            .and_then(|mut connection| process_usage_inbox(&mut connection, &config));
        match recovered {
            Ok(saved) if saved > 0 => {
                let collected_at = Local::now().to_rfc3339();
                app.state::<UsageCollectorState>()
                    .increment_total_records(saved);
                set_collector_status(
                    &app,
                    "collecting",
                    &format!("已恢复 {saved} 条待处理记录"),
                    Some(collected_at.clone()),
                );
                let _ = app.emit(USAGE_UPDATED_EVENT, collected_at);
                retry_seconds = 1;
                continue;
            }
            Ok(_) => {}
            Err(error) => {
                set_collector_error(&app, error);
                wait_or_cancel(&token, retry_seconds).await;
                retry_seconds = (retry_seconds * 2).min(10);
                continue;
            }
        }
        let process_state = app.state::<CoreProcessState>();
        let core_running = current_core_status(Some(process_state.inner()), Some(config.port))
            .map(|status| status.running)
            .unwrap_or(false);
        if !core_running {
            subscription = None;
            set_collector_status(&app, "waiting-core", "等待内核启动", None);
            retry_seconds = 1;
            wait_or_cancel(&token, 1).await;
            continue;
        }

        if subscription.is_none() && tokio::time::Instant::now() >= subscribe_retry_at {
            match UsageSubscription::connect(config.port, &config.management_secret_key).await {
                Ok(next_subscription) => {
                    subscription = Some(next_subscription);
                    set_collector_status(&app, "collecting", "已连接 CPA usage 实时订阅", None);
                    match backfill_usage_queue(&root, &config).await {
                        Ok(saved) => {
                            publish_collected_records(
                                &app,
                                saved,
                                &format!("实时订阅已连接，补录 {saved} 条队列记录"),
                            );
                            retry_seconds = 1;
                        }
                        Err(error) => {
                            set_collector_status(
                                &app,
                                "collecting",
                                &format!("实时订阅已连接，历史队列补录失败: {error}"),
                                None,
                            );
                        }
                    }
                    continue;
                }
                Err(error) => {
                    subscribe_retry_at = tokio::time::Instant::now()
                        + Duration::from_secs(USAGE_SUBSCRIBE_RETRY_SECONDS);
                    set_collector_status(
                        &app,
                        "collecting",
                        &format!("使用 HTTP 兼容模式采集；实时订阅不可用: {error}"),
                        None,
                    );
                }
            }
        }

        if let Some(active_subscription) = subscription.as_mut() {
            let message = tokio::select! {
                _ = token.cancelled() => return,
                result = tokio::time::timeout(
                    Duration::from_secs(2),
                    active_subscription.next_message(),
                ) => result,
            };
            match message {
                Ok(Ok(payload)) => {
                    match persist_raw_usage_message_from_source(
                        &root,
                        "redis_subscribe:usage",
                        payload,
                        &config,
                    ) {
                        Ok(saved) => {
                            publish_collected_records(
                                &app,
                                saved,
                                &format!("实时订阅已保存 {saved} 条新记录"),
                            );
                            retry_seconds = 1;
                        }
                        Err(error) => {
                            set_collector_error(&app, error);
                            wait_or_cancel(&token, retry_seconds).await;
                            retry_seconds = (retry_seconds * 2).min(10);
                        }
                    }
                    continue;
                }
                Err(_) => {
                    set_collector_status(&app, "collecting", "CPA usage 实时订阅采集中", None);
                    retry_seconds = 1;
                    continue;
                }
                Ok(Err(error)) => {
                    subscription = None;
                    subscribe_retry_at = tokio::time::Instant::now()
                        + Duration::from_secs(USAGE_SUBSCRIBE_RETRY_SECONDS);
                    set_collector_status(
                        &app,
                        "collecting",
                        &format!("实时订阅断开，已切换 HTTP 兼容模式: {error}"),
                        None,
                    );
                }
            }
        }

        match fetch_usage_queue(&config).await {
            Ok(items) if items.is_empty() => {
                set_collector_status(&app, "collecting", "使用记录采集中", None);
                retry_seconds = 1;
                wait_or_cancel(&token, 1).await;
            }
            Ok(items) => match persist_queue_items(&root, items, &config) {
                Ok(saved) => {
                    publish_collected_records(
                        &app,
                        saved,
                        &format!("HTTP 兼容模式已保存 {saved} 条新记录"),
                    );
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

async fn backfill_usage_queue(root: &Path, config: &GuiConfigFile) -> Result<usize, String> {
    let mut saved_total = 0_usize;
    loop {
        let items = fetch_usage_queue(config).await?;
        let fetched = items.len();
        if fetched == 0 {
            return Ok(saved_total);
        }
        saved_total = saved_total.saturating_add(persist_queue_items_from_source(
            root,
            "http_backfill",
            items,
            config,
        )?);
        if fetched < USAGE_QUEUE_BATCH_SIZE {
            return Ok(saved_total);
        }
    }
}

fn publish_collected_records(app: &tauri::AppHandle, saved: usize, message: &str) {
    let collected_at = Local::now().to_rfc3339();
    if saved > 0 {
        app.state::<UsageCollectorState>()
            .increment_total_records(saved);
    }
    set_collector_status(
        app,
        "collecting",
        message,
        (saved > 0).then_some(collected_at.clone()),
    );
    if saved > 0 {
        let _ = app.emit(USAGE_UPDATED_EVENT, collected_at);
    }
}

pub(crate) fn persist_local_usage_event(
    app: &tauri::AppHandle,
    collector_source: &str,
    mut value: Value,
) -> Result<usize, String> {
    if let Some(object) = value.as_object_mut() {
        if string_field(object, "request_id").is_none() {
            object.insert(
                "request_id".to_string(),
                Value::String(format!("{collector_source}-{}", unique_file_stamp())),
            );
        }
    }
    let config = app.state::<GuiConfigState>().snapshot()?;
    let root = usage_root_dir()?;
    let saved = persist_queue_items_from_source(&root, collector_source, vec![value], &config)?;
    publish_collected_records(app, saved, "已保存桌面健康检测使用记录");
    Ok(saved)
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
        .map_err(|error| format_management_request_error("读取 CPA 使用记录队列失败", &error))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format_management_request_error("读取 CPA 使用记录响应失败", &error))?;
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
    persist_queue_items_from_source(root, "http_pull", items, config)
}

fn persist_queue_items_from_source(
    root: &Path,
    source: &str,
    items: Vec<Value>,
    config: &GuiConfigFile,
) -> Result<usize, String> {
    let mut connection = open_usage_database_at(root)?;
    enqueue_usage_queue_items(&mut connection, source, items)?;
    process_usage_inbox(&mut connection, config)
}

fn enqueue_usage_queue_items(
    connection: &mut Connection,
    source: &str,
    items: Vec<Value>,
) -> Result<usize, String> {
    let messages = items
        .into_iter()
        .map(|item| {
            serde_json::to_string(&item)
                .map_err(|error| format!("序列化 CPA 使用记录失败: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    enqueue_usage_raw_messages(connection, source, messages)
}

fn enqueue_usage_raw_messages(
    connection: &mut Connection,
    source: &str,
    messages: Vec<String>,
) -> Result<usize, String> {
    let messages = messages
        .into_iter()
        .filter(|message| !is_ignorable_usage_message(message))
        .collect::<Vec<_>>();
    if messages.is_empty() {
        return Ok(0);
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始 SQLite 使用记录 inbox 事务失败: {error}"))?;
    let mut statement = transaction
        .prepare(
            r#"
            INSERT INTO usage_inbox (
                source, message_hash, raw_message, status, attempt_count,
                received_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, 'pending', 0, ?4, ?4, ?4)
            "#,
        )
        .map_err(|error| format!("准备 SQLite 使用记录 inbox 写入失败: {error}"))?;
    let received_at = Local::now().to_rfc3339();
    let mut inserted = 0_usize;
    for raw_message in messages {
        inserted = inserted.saturating_add(
            statement
                .execute(params![
                    source,
                    hash_text(&raw_message),
                    raw_message,
                    received_at,
                ])
                .map_err(|error| format!("写入 SQLite 使用记录 inbox 失败: {error}"))?,
        );
    }
    drop(statement);
    transaction
        .commit()
        .map_err(|error| format!("提交 SQLite 使用记录 inbox 失败: {error}"))?;
    Ok(inserted)
}

fn is_ignorable_usage_message(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return true;
    }
    if trimmed.contains("\"request_id\"") {
        return false;
    }

    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != 1 {
        return false;
    }
    object
        .get("refresh")
        .and_then(Value::as_bool)
        .is_some_and(|enabled| enabled)
        || object
            .get("support_refresh")
            .and_then(Value::as_bool)
            .is_some_and(|enabled| enabled)
}

fn persist_raw_usage_message_from_source(
    root: &Path,
    source: &str,
    raw_message: String,
    config: &GuiConfigFile,
) -> Result<usize, String> {
    let mut connection = open_usage_database_at(root)?;
    enqueue_usage_raw_messages(&mut connection, source, vec![raw_message])?;
    process_usage_inbox(&mut connection, config)
}

fn process_usage_inbox(
    connection: &mut Connection,
    config: &GuiConfigFile,
) -> Result<usize, String> {
    let rows = list_processable_usage_inbox(connection, USAGE_INBOX_PROCESS_LIMIT)?;
    if rows.is_empty() {
        return Ok(0);
    }
    let mut valid_rows = Vec::with_capacity(rows.len());
    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        let parsed = serde_json::from_str::<Value>(&row.raw_message)
            .map_err(|error| format!("解析 inbox JSON 失败: {error}"))
            .and_then(|value| normalize_usage_record(value, config));
        match parsed {
            Ok(mut record) => {
                record.collector_source = row.source.clone();
                valid_rows.push(row);
                records.push(record);
            }
            Err(error) => mark_usage_inbox_decode_failed(connection, row.id, &error)?,
        }
    }
    if records.is_empty() {
        return Ok(0);
    }

    let persist_result = (|| -> Result<usize, String> {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开始 SQLite inbox 处理事务失败: {error}"))?;
        let inserted = insert_usage_records_in_transaction(&transaction, &records)?;
        let processed_at = Local::now().to_rfc3339();
        for (row, record) in valid_rows.iter().zip(records.iter()) {
            transaction
                .execute(
                    r#"
                    UPDATE usage_inbox
                    SET status = 'processed', attempt_count = attempt_count + 1,
                        last_error = '', usage_event_key = ?1,
                        processed_at = ?2, updated_at = ?2
                    WHERE id = ?3
                    "#,
                    params![record.id, processed_at, row.id],
                )
                .map_err(|error| format!("标记 SQLite 使用记录 inbox 已处理失败: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("提交 SQLite inbox 处理事务失败: {error}"))?;
        Ok(inserted)
    })();
    match persist_result {
        Ok(inserted) => Ok(inserted),
        Err(error) => {
            mark_usage_inbox_process_failed(connection, &valid_rows, &error)?;
            Err(error)
        }
    }
}

fn list_processable_usage_inbox(
    connection: &Connection,
    limit: usize,
) -> Result<Vec<UsageInboxRow>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, source, raw_message, attempt_count
            FROM usage_inbox
            WHERE status IN ('pending', 'process_failed')
              AND attempt_count < ?1
            ORDER BY id ASC
            LIMIT ?2
            "#,
        )
        .map_err(|error| format!("准备读取 SQLite 使用记录 inbox 失败: {error}"))?;
    let rows = statement
        .query_map(
            params![
                USAGE_INBOX_MAX_ATTEMPTS,
                limit.min(i64::MAX as usize) as i64
            ],
            |row| {
                Ok(UsageInboxRow {
                    id: row.get(0)?,
                    source: row.get(1)?,
                    raw_message: row.get(2)?,
                    attempt_count: row.get(3)?,
                })
            },
        )
        .map_err(|error| format!("查询 SQLite 使用记录 inbox 失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 SQLite 使用记录 inbox 失败: {error}"))?;
    Ok(rows)
}

fn mark_usage_inbox_decode_failed(
    connection: &Connection,
    id: i64,
    error: &str,
) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    connection
        .execute(
            r#"
            UPDATE usage_inbox
            SET status = 'decode_failed', attempt_count = attempt_count + 1,
                last_error = ?1, processed_at = ?2, updated_at = ?2
            WHERE id = ?3
            "#,
            params![bounded_usage_inbox_error(error), now, id],
        )
        .map(|_| ())
        .map_err(|update_error| {
            format!("标记 SQLite 使用记录 inbox 解码失败时出错: {update_error}")
        })
}

fn mark_usage_inbox_process_failed(
    connection: &Connection,
    rows: &[UsageInboxRow],
    error: &str,
) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    let error = bounded_usage_inbox_error(error);
    for row in rows {
        let next_attempt = row.attempt_count.saturating_add(1);
        let status = if next_attempt >= USAGE_INBOX_MAX_ATTEMPTS {
            "discarded"
        } else {
            "process_failed"
        };
        connection
            .execute(
                r#"
                UPDATE usage_inbox
                SET status = ?1, attempt_count = ?2, last_error = ?3,
                    processed_at = CASE WHEN ?1 = 'discarded' THEN ?4 ELSE NULL END,
                    updated_at = ?4
                WHERE id = ?5
                "#,
                params![status, next_attempt, error, now, row.id],
            )
            .map_err(|update_error| {
                format!("标记 SQLite 使用记录 inbox 处理失败时出错: {update_error}")
            })?;
    }
    Ok(())
}

fn bounded_usage_inbox_error(error: &str) -> String {
    error.chars().take(1_000).collect()
}

fn cleanup_usage_inbox(connection: &Connection, now: DateTime<Local>) -> Result<(), String> {
    let processed_cutoff = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|value| value.and_local_timezone(Local).single())
        .unwrap_or(now)
        .to_rfc3339();
    let failed_cutoff = (now - chrono::Duration::days(7)).to_rfc3339();
    connection
        .execute(
            "DELETE FROM usage_inbox WHERE status = 'processed' AND processed_at < ?1",
            params![processed_cutoff],
        )
        .map_err(|error| format!("清理已处理使用记录 inbox 失败: {error}"))?;
    connection
        .execute(
            "DELETE FROM usage_inbox WHERE status IN ('decode_failed', 'discarded') AND updated_at < ?1",
            params![failed_cutoff],
        )
        .map_err(|error| format!("清理失败使用记录 inbox 失败: {error}"))?;
    Ok(())
}

#[cfg(test)]
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
            INSERT INTO usage_events (
                event_key, timestamp, timestamp_ms, local_hour, latency_ms, ttft_ms,
                source, auth_index, failed, provider, model, alias, reasoning_effort,
                service_tier, response_service_tier, executor_type, endpoint, auth_type,
                api_key_hash, api_key_display, api_key_remark, request_id,
                api_group_key, model_alias, client_ip, x_forwarded_for, user_agent,
                generate, cached_tokens, collector_source,
                input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
                cache_creation_tokens, total_tokens, canceled, failure_status,
                failure_body, created_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
                ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40
            )
            "#,
        )
        .map_err(|error| format!("准备 SQLite 使用记录写入失败: {error}"))?;
    let created_at = Local::now().to_rfc3339();
    let mut inserted = 0_usize;
    for record in records {
        let api_group_key = if !record.api_group_key.trim().is_empty() {
            record.api_group_key.as_str()
        } else if !record.api_key_hash.trim().is_empty() {
            record.api_key_hash.as_str()
        } else if !record.provider.trim().is_empty() {
            record.provider.as_str()
        } else if !record.endpoint.trim().is_empty() {
            record.endpoint.as_str()
        } else {
            "unknown"
        };
        let cache_components = record
            .tokens
            .cache_read_tokens
            .saturating_add(record.tokens.cache_creation_tokens);
        let input_before_invariant = record.tokens.input_tokens;
        let input_tokens = if cache_components > input_before_invariant {
            input_before_invariant.saturating_add(cache_components)
        } else {
            input_before_invariant
        };
        let total_tokens = if record.tokens.total_tokens == 0
            || record.tokens.total_tokens
                == input_before_invariant.saturating_add(record.tokens.output_tokens)
        {
            input_tokens.saturating_add(record.tokens.output_tokens)
        } else {
            record.tokens.total_tokens
        };
        let cached_tokens = record.cached_tokens.max(cache_components);
        let collector_source = if record.collector_source.trim().is_empty() {
            "legacy_json"
        } else {
            record.collector_source.as_str()
        };
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
                    api_group_key,
                    if record.alias.trim().is_empty() {
                        None::<&str>
                    } else {
                        Some(record.alias.as_str())
                    },
                    record.client_ip,
                    record.x_forwarded_for,
                    record.user_agent,
                    record.generate,
                    to_sql_i64(cached_tokens),
                    collector_source,
                    to_sql_i64(input_tokens),
                    to_sql_i64(record.tokens.output_tokens),
                    to_sql_i64(record.tokens.reasoning_tokens),
                    to_sql_i64(record.tokens.cache_read_tokens),
                    to_sql_i64(record.tokens.cache_creation_tokens),
                    to_sql_i64(total_tokens),
                    record.canceled,
                    i64::from(record.failure_status),
                    record.failure_body,
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
    let request_id = string_field(object, "request_id")
        .ok_or_else(|| "CPA 使用记录必须包含 request_id".to_string())?;
    let api_key = string_field(object, "api_key").unwrap_or_default();
    let api_key_hash = hash_text(&api_key);
    let api_key_remark = config
        .api_keys
        .iter()
        .find(|entry| entry.key == api_key)
        .map(|entry| entry.remark.clone())
        .unwrap_or_default();
    let provider = string_field(object, "provider").unwrap_or_default();
    let executor_type = string_field(object, "executor_type").unwrap_or_default();
    let tokens_object = object.get("tokens").and_then(Value::as_object);
    let cache_read_present = tokens_object
        .and_then(|tokens| tokens.get("cache_read_tokens"))
        .is_some();
    let raw_cache_read_tokens = token_u64(tokens_object, "cache_read_tokens");
    let cache_creation_tokens = token_u64(tokens_object, "cache_creation_tokens");
    let raw_cached_tokens =
        token_u64(tokens_object, "cached_tokens").max(token_u64(tokens_object, "cache_tokens"));
    let normalized_cache_read_tokens = if cache_read_present {
        raw_cache_read_tokens
    } else {
        raw_cached_tokens
    };
    let raw_input_tokens = token_u64(tokens_object, "input_tokens");
    let mut tokens = UsageTokenStats {
        input_tokens: raw_input_tokens,
        output_tokens: token_u64(tokens_object, "output_tokens"),
        reasoning_tokens: token_u64(tokens_object, "reasoning_tokens"),
        cache_read_tokens: normalized_cache_read_tokens,
        cache_creation_tokens,
        total_tokens: token_u64(tokens_object, "total_tokens"),
    };

    let provider_lower = provider.to_ascii_lowercase();
    let is_claude_executor = executor_type.eq_ignore_ascii_case("ClaudeExecutor")
        || provider_lower == "claude"
        || provider_lower.contains("anthropic");
    let cache_components = tokens
        .cache_read_tokens
        .saturating_add(tokens.cache_creation_tokens);
    let raw_total_without_cache = raw_input_tokens.saturating_add(tokens.output_tokens);
    let raw_total_with_cache = raw_total_without_cache.saturating_add(cache_components);
    let claude_excludes_cache = is_claude_executor
        && cache_components > 0
        && (raw_input_tokens < cache_components || tokens.total_tokens == raw_total_with_cache);
    if claude_excludes_cache {
        tokens.input_tokens = raw_input_tokens
            .saturating_add(tokens.cache_read_tokens)
            .saturating_add(tokens.cache_creation_tokens);
    }
    let input_before_invariant = tokens.input_tokens;
    if cache_components > input_before_invariant {
        tokens.input_tokens = input_before_invariant.saturating_add(cache_components);
        if tokens.total_tokens == 0
            || tokens.total_tokens == input_before_invariant.saturating_add(tokens.output_tokens)
        {
            tokens.total_tokens = tokens.input_tokens.saturating_add(tokens.output_tokens);
        }
    }
    if tokens.total_tokens == 0
        || (claude_excludes_cache && tokens.total_tokens == raw_total_without_cache)
    {
        tokens.total_tokens = tokens.input_tokens.saturating_add(tokens.output_tokens);
    }
    let id = request_id.clone();
    let endpoint = string_field(object, "endpoint").unwrap_or_default();
    let failed = object
        .get("failed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let (failure_status, failure_body) = usage_failure_details(object);
    let canceled = failed && usage_failure_is_canceled(failure_status, &failure_body);
    let generate = object
        .get("generate")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            !(executor_type == "CodexWebsocketsExecutor"
                && !failed
                && tokens.input_tokens == 0
                && tokens.output_tokens == 0
                && tokens.reasoning_tokens == 0
                && tokens.cache_read_tokens == 0
                && tokens.cache_creation_tokens == 0
                && tokens.total_tokens == 0)
        });
    let api_group_key = if api_key_hash.is_empty() {
        if !provider.is_empty() {
            provider.clone()
        } else if !endpoint.is_empty() {
            endpoint.clone()
        } else {
            "unknown".to_string()
        }
    } else {
        api_key_hash.clone()
    };
    Ok(UsageRecord {
        id,
        timestamp,
        latency_ms: u64_field(object, "latency_ms"),
        ttft_ms: optional_u64_field(object, "ttft_ms"),
        source: string_field(object, "source").unwrap_or_default(),
        source_display: String::new(),
        auth_index: string_field(object, "auth_index").unwrap_or_default(),
        failed,
        canceled,
        failure_status,
        failure_body,
        provider,
        api_group_key,
        model: string_field(object, "model").unwrap_or_else(|| "unknown".to_string()),
        alias: string_field(object, "alias").unwrap_or_default(),
        client_ip: string_field(object, "client_ip"),
        x_forwarded_for: string_field(object, "x_forwarded_for"),
        user_agent: string_field(object, "user_agent"),
        reasoning_effort: string_field(object, "reasoning_effort").unwrap_or_default(),
        service_tier: string_field(object, "service_tier").unwrap_or_default(),
        response_service_tier: string_field(object, "response_service_tier").unwrap_or_default(),
        executor_type,
        endpoint,
        auth_type: string_field(object, "auth_type").unwrap_or_default(),
        api_key_hash,
        api_key_display: mask_api_key(&api_key),
        api_key_remark,
        request_id,
        generate,
        cached_tokens: raw_cached_tokens.max(
            tokens
                .cache_read_tokens
                .saturating_add(tokens.cache_creation_tokens),
        ),
        collector_source: "http_pull".to_string(),
        tokens,
    })
}

fn usage_failure_body(value: &Value) -> String {
    let body = match value {
        Value::String(value) => value.trim().to_string(),
        Value::Null => String::new(),
        value => serde_json::to_string(value).unwrap_or_default(),
    };
    if body.chars().count() <= MAX_USAGE_FAILURE_BODY_CHARS {
        body
    } else {
        let mut bounded = body
            .chars()
            .take(MAX_USAGE_FAILURE_BODY_CHARS)
            .collect::<String>();
        bounded.push('…');
        bounded
    }
}

fn usage_failure_details(object: &serde_json::Map<String, Value>) -> (u16, String) {
    let failure = object.get("fail").and_then(Value::as_object);
    let status = failure
        .and_then(|value| value.get("status_code").or_else(|| value.get("statusCode")))
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .min(u16::MAX as u64) as u16;
    let body = failure
        .and_then(|value| value.get("body"))
        .map(usage_failure_body)
        .unwrap_or_default();
    (status, body)
}

fn usage_failure_is_canceled(status: u16, body: &str) -> bool {
    if status == 499 {
        return true;
    }
    let body = body.to_ascii_lowercase();
    body.contains("context canceled") || body.contains("client closed request")
}

fn default_usage_generate() -> bool {
    true
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
    if let Some(canceled) = query.canceled {
        clauses.push("canceled = ?".to_string());
        params.push(SqlValue::Integer(i64::from(canceled)));
    }
    if let Some(failed) = query.failed {
        if failed {
            clauses.push("failed != 0 AND canceled = 0".to_string());
        } else {
            clauses.push("failed = 0".to_string());
        }
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
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN canceled != 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(reasoning_tokens), 0),
            COALESCE(SUM(cache_read_tokens), 0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COALESCE(SUM(total_tokens), 0),
            COALESCE(SUM(latency_ms), 0),
            COALESCE(
                SUM(CASE
                    WHEN generate != 0
                     AND failed = 0
                     AND canceled = 0
                     AND output_tokens > 0
                     AND ttft_ms IS NOT NULL
                     AND ttft_ms > 0
                     AND latency_ms > ttft_ms
                    THEN output_tokens
                    ELSE 0
                END) * 1000.0
                / NULLIF(SUM(CASE
                    WHEN generate != 0
                     AND failed = 0
                     AND canceled = 0
                     AND output_tokens > 0
                     AND ttft_ms IS NOT NULL
                     AND ttft_ms > 0
                     AND latency_ms > ttft_ms
                    THEN latency_ms - ttft_ms
                    ELSE 0
                END), 0),
                0.0
            ),
            COALESCE(SUM(CASE
                WHEN generate != 0
                 AND failed = 0
                 AND canceled = 0
                 AND output_tokens > 0
                 AND ttft_ms IS NOT NULL
                 AND ttft_ms > 0
                 AND latency_ms > ttft_ms
                THEN 1
                ELSE 0
            END), 0),
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
                    row.get::<_, i64>(10)?,
                    row.get::<_, f64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                    row.get::<_, Option<i64>>(14)?,
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
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN canceled != 0 THEN 1 ELSE 0 END), 0),
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
                canceled: from_sql_i64(row.get(4)?),
                tokens: from_sql_i64(row.get(5)?),
            })
        })
        .map_err(|error| format!("查询 SQLite 使用趋势失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 SQLite 使用趋势失败: {error}"))?;

    let mut overview = UsageOverview {
        total_requests: from_sql_i64(summary.0),
        success_count: from_sql_i64(summary.1),
        failure_count: from_sql_i64(summary.2),
        canceled_count: from_sql_i64(summary.3),
        input_tokens: from_sql_i64(summary.4),
        output_tokens: from_sql_i64(summary.5),
        reasoning_tokens: from_sql_i64(summary.6),
        cache_read_tokens: from_sql_i64(summary.7),
        cache_creation_tokens: from_sql_i64(summary.8),
        total_tokens: from_sql_i64(summary.9),
        estimated_cost,
        priced_requests,
        timeline,
        ..UsageOverview::default()
    };
    if overview.total_requests > 0 {
        let completed_requests = overview
            .success_count
            .saturating_add(overview.failure_count);
        if completed_requests > 0 {
            overview.success_rate =
                overview.success_count as f64 * 100.0 / completed_requests as f64;
        }
        overview.average_latency_ms =
            from_sql_i64(summary.10) as f64 / overview.total_requests as f64;
        overview.tps = summary.11;
        overview.tps_sample_count = from_sql_i64(summary.12);
        if overview.input_tokens > 0 {
            overview.cache_hit_rate =
                (overview.cache_read_tokens as f64 / overview.input_tokens as f64).min(1.0);
        }
        let minutes = query_window_minutes(query, summary.13, summary.14);
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
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
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
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
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
            api_group_key, client_ip, x_forwarded_for, user_agent, generate,
            cached_tokens, collector_source,
            input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
            cache_creation_tokens, total_tokens, canceled, failure_status,
            failure_body
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
        canceled: row.get::<_, i64>(33)? != 0,
        failure_status: row.get::<_, i64>(34)?.clamp(0, u16::MAX as i64) as u16,
        failure_body: row.get(35)?,
        provider: row.get(7)?,
        api_group_key: row.get(20)?,
        model: row.get(8)?,
        alias: row.get(9)?,
        client_ip: row.get(21)?,
        x_forwarded_for: row.get(22)?,
        user_agent: row.get(23)?,
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
        generate: row.get::<_, i64>(24)? != 0,
        cached_tokens: from_sql_i64(row.get(25)?),
        collector_source: row.get(26)?,
        tokens: UsageTokenStats {
            input_tokens: from_sql_i64(row.get(27)?),
            output_tokens: from_sql_i64(row.get(28)?),
            reasoning_tokens: from_sql_i64(row.get(29)?),
            cache_read_tokens: from_sql_i64(row.get(30)?),
            cache_creation_tokens: from_sql_i64(row.get(31)?),
            total_tokens: from_sql_i64(row.get(32)?),
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
    Ok(core_base_dir()?.join(USAGE_DIR_NAME))
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

    #[test]
    fn legacy_usage_storage_is_moved_with_nested_files() {
        let root = test_root("storage-location-migration");
        let source = root.join("legacy").join(USAGE_DIR_NAME);
        let target = root.join("application-support").join(USAGE_DIR_NAME);
        fs::create_dir_all(source.join(USAGE_BACKUP_DIR_NAME)).unwrap();
        fs::write(source.join(USAGE_DATABASE_FILE), b"database").unwrap();
        fs::write(
            source.join(USAGE_BACKUP_DIR_NAME).join("usage.db.backup"),
            b"backup",
        )
        .unwrap();

        migrate_usage_storage_directory(&source, &target).unwrap();

        assert!(!source.exists());
        assert_eq!(
            fs::read(target.join(USAGE_DATABASE_FILE)).unwrap(),
            b"database"
        );
        assert_eq!(
            fs::read(target.join(USAGE_BACKUP_DIR_NAME).join("usage.db.backup")).unwrap(),
            b"backup"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn open_test_database(root: &Path) -> Connection {
        initialize_usage_storage_at(root).unwrap();
        open_usage_database_at(root).unwrap()
    }

    #[test]
    fn repairs_legacy_claude_input_tokens_on_demand() {
        let root = test_root("claude-input-migration");
        let connection = open_test_database(&root);
        connection
            .execute(
                r#"INSERT INTO usage_events (
                    event_key, timestamp, timestamp_ms, local_hour, provider,
                    executor_type, input_tokens, output_tokens, cache_read_tokens,
                    cache_creation_tokens, total_tokens, created_at
                ) VALUES ('legacy-claude', '2026-08-27T00:00:00Z', 1,
                          '2026-08-27T00', 'claude', 'ClaudeExecutor',
                          100, 20, 600, 20, 740, '2026-08-27T00:00:00Z')"#,
                [],
            )
            .unwrap();
        drop(connection);

        let result = repair_usage_cache_records_at(&root).unwrap();
        assert_eq!(result.scanned, 1);
        assert_eq!(result.repaired, 1);
        assert!(result.backup_path.is_some());
        let connection = open_usage_database_at(&root).unwrap();
        let row: (i64, i64, i64) = connection
            .query_row(
                "SELECT input_tokens, total_tokens, cached_tokens FROM usage_events WHERE event_key = 'legacy-claude'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (720, 740, 620));
        drop(connection);

        let second = repair_usage_cache_records_at(&root).unwrap();
        assert_eq!(second.scanned, 0);
        assert_eq!(second.repaired, 0);
        let rerun_connection = open_usage_database_at(&root).unwrap();
        let rerun_input: i64 = rerun_connection
            .query_row(
                "SELECT input_tokens FROM usage_events WHERE event_key = 'legacy-claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(rerun_connection);
        assert_eq!(rerun_input, 720);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removes_historical_unknown_records_on_demand() {
        let root = test_root("unknown-repair");
        let connection = open_test_database(&root);
        for (key, index) in ["refresh-control", "support-refresh-control"]
            .iter()
            .zip([1_i64, 2_i64])
        {
            connection
                .execute(
                    "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, provider, model, request_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, latency_ms, failed, canceled, generate, created_at) VALUES (?1, '2026-08-27T00:00:00Z', ?2, '2026-08-27T00', '', 'unknown', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, '2026-08-27T00:00:00Z')",
                    params![key, index],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, provider, model, request_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, latency_ms, failed, canceled, generate, created_at) VALUES ('legitimate-unknown', '2026-08-27T00:00:00Z', 3, '2026-08-27T00', '', 'unknown', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, '2026-08-27T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);

        let result = repair_usage_cache_records_at(&root).unwrap();
        assert_eq!(result.scanned, 3);
        assert_eq!(result.repaired, 0);
        assert_eq!(result.deleted, 3);
        let connection = open_usage_database_at(&root).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_events WHERE model = 'unknown'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    fn create_legacy_v2_database(root: &Path) -> Connection {
        fs::create_dir_all(root).unwrap();
        let connection = Connection::open(root.join(USAGE_DATABASE_FILE)).unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE usage_metadata (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );
                CREATE TABLE usage_events (
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
                PRAGMA user_version = 2;
                "#,
            )
            .unwrap();
        connection
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
            canceled: false,
            failure_status: 0,
            failure_body: String::new(),
            provider: "openai".to_string(),
            api_group_key: "hash".to_string(),
            model: model.to_string(),
            alias: String::new(),
            client_ip: None,
            x_forwarded_for: None,
            user_agent: None,
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
            generate: true,
            cached_tokens: 2,
            collector_source: "test".to_string(),
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
            start_core_on_launch: true,
            silent_start: false,
            close_behavior: crate::WindowsCloseBehavior::Ask,
            default_terminal: crate::DEFAULT_AGENT_TERMINAL.to_string(),
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
            download_source: VersionDownloadSource::Github,
            custom_download_mirrors: Vec::new(),
            active_custom_download_mirror: String::new(),
            prefer_gitcode_downloads: false,
            routing_session_affinity: false,
            routing_session_affinity_ttl: String::new(),
            request_retry: crate::DEFAULT_REQUEST_RETRY,
            max_retry_credentials: crate::DEFAULT_MAX_RETRY_CREDENTIALS,
            max_retry_interval: crate::DEFAULT_MAX_RETRY_INTERVAL,
            streaming_bootstrap_retries: crate::DEFAULT_STREAMING_BOOTSTRAP_RETRIES,
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
    fn preserves_explicit_cache_read_and_only_backfills_missing_alias() {
        let config = GuiConfigFile::default();
        let explicit = normalize_usage_record(
            serde_json::json!({
                "request_id": "explicit-cache-read",
                "tokens": {
                    "input_tokens": 100,
                    "cached_tokens": 10,
                    "cache_read_tokens": 5,
                    "cache_creation_tokens": 2,
                    "total_tokens": 100
                }
            }),
            &config,
        )
        .unwrap();
        assert_eq!(explicit.tokens.cache_read_tokens, 5);

        let legacy = normalize_usage_record(
            serde_json::json!({
                "request_id": "legacy-cache-alias",
                "tokens": {
                    "input_tokens": 100,
                    "cached_tokens": 10,
                    "cache_creation_tokens": 2,
                    "total_tokens": 100
                }
            }),
            &config,
        )
        .unwrap();
        assert_eq!(legacy.tokens.cache_read_tokens, 10);
    }

    #[test]
    fn normalizes_claude_input_to_include_cache_tokens() {
        let record = normalize_usage_record(
            serde_json::json!({
                "executor_type": "ClaudeExecutor",
                "provider": "anthropic",
                "request_id": "claude-cache-rate",
                "tokens": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "cache_read_tokens": 600,
                    "cache_creation_tokens": 20,
                    "total_tokens": 120
                }
            }),
            &GuiConfigFile::default(),
        )
        .unwrap();

        assert_eq!(record.tokens.input_tokens, 720);
        assert_eq!(record.tokens.total_tokens, 740);
        assert_eq!(record.tokens.cache_read_tokens, 600);
    }

    #[test]
    fn keeps_already_inclusive_claude_input_unchanged() {
        let record = normalize_usage_record(
            serde_json::json!({
                "provider": "anthropic",
                "request_id": "claude-inclusive",
                "tokens": {
                    "input_tokens": 720,
                    "output_tokens": 20,
                    "cache_read_tokens": 600,
                    "cache_creation_tokens": 20,
                    "total_tokens": 740
                }
            }),
            &GuiConfigFile::default(),
        )
        .unwrap();
        assert_eq!(record.tokens.input_tokens, 720);
        assert_eq!(record.tokens.total_tokens, 740);
    }

    #[test]
    fn enforces_cache_input_invariant_for_unknown_producers() {
        let record = normalize_usage_record(
            serde_json::json!({
                "provider": "custom",
                "request_id": "unknown-cache-shape",
                "tokens": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "cache_read_tokens": 600,
                    "total_tokens": 120
                }
            }),
            &GuiConfigFile::default(),
        )
        .unwrap();
        assert_eq!(record.tokens.input_tokens, 700);
        assert_eq!(record.tokens.total_tokens, 720);
        assert!(record.tokens.cache_read_tokens <= record.tokens.input_tokens);
    }

    #[test]
    fn filters_usage_control_messages_before_inbox() {
        assert!(is_ignorable_usage_message(""));
        assert!(is_ignorable_usage_message("  null\n"));
        assert!(is_ignorable_usage_message(r#"{"refresh":true}"#));
        assert!(is_ignorable_usage_message(
            r#"{ "support_refresh" : true }"#
        ));
        assert!(!is_ignorable_usage_message(r#"{"refresh":false}"#));
        assert!(!is_ignorable_usage_message(
            r#"{"refresh":true,"request_id":"usage"}"#
        ));
        assert!(!is_ignorable_usage_message(r#"{"request_id":"usage"}"#));
        assert!(!is_ignorable_usage_message("not-json"));

        let root = test_root("usage-control-messages");
        initialize_usage_storage_at(&root).unwrap();
        let config = GuiConfigFile::default();
        let inserted = persist_queue_items(
            &root,
            vec![
                serde_json::json!({"refresh": true}),
                serde_json::json!({"support_refresh": true}),
                serde_json::json!({
                    "request_id": "real-usage",
                    "provider": "codex",
                    "model": "gpt-test"
                }),
            ],
            &config,
        )
        .unwrap();
        assert_eq!(inserted, 1);
        let connection = open_usage_database_at(&root).unwrap();
        let inbox_count = connection
            .query_row("SELECT COUNT(*) FROM usage_inbox", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(inbox_count, 1);
        assert_eq!(event_count, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_usage_messages_without_request_id() {
        let root = test_root("usage-missing-request-id");
        initialize_usage_storage_at(&root).unwrap();
        let mut connection = open_usage_database_at(&root).unwrap();
        enqueue_usage_queue_items(
            &mut connection,
            "redis_subscribe:usage",
            vec![serde_json::json!({
                "provider": "codex",
                "model": "gpt-test"
            })],
        )
        .unwrap();
        let inserted = process_usage_inbox(&mut connection, &GuiConfigFile::default()).unwrap();
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let status = connection
            .query_row("SELECT status FROM usage_inbox", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();
        assert_eq!(inserted, 0);
        assert_eq!(event_count, 0);
        assert_eq!(status, "decode_failed");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
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
    fn persists_failure_details_and_excludes_client_cancellations_from_failures() {
        let root = test_root("usage-failure-details");
        initialize_usage_storage_at(&root).unwrap();
        let config = GuiConfigFile::default();
        persist_queue_items(
            &root,
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:00+08:00",
                    "request_id": "success",
                    "failed": false,
                    "provider": "antigravity",
                    "model": "gemini-test"
                }),
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:01+08:00",
                    "request_id": "upstream-failure",
                    "failed": true,
                    "provider": "antigravity",
                    "model": "gemini-test",
                    "fail": {
                        "status_code": 429,
                        "body": { "error": { "message": "quota exhausted" } }
                    }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:02+08:00",
                    "request_id": "client-canceled",
                    "failed": true,
                    "provider": "antigravity",
                    "model": "gemini-test",
                    "fail": {
                        "status_code": 499,
                        "body": "context canceled"
                    }
                }),
            ],
            &config,
        )
        .unwrap();

        let connection = open_usage_database_at(&root).unwrap();
        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();
        let failures = load_usage_events(
            &connection,
            &UsageQuery {
                failed: Some(true),
                ..UsageQuery::default()
            },
            &config,
        )
        .unwrap();
        let cancellations = load_usage_events(
            &connection,
            &UsageQuery {
                canceled: Some(true),
                ..UsageQuery::default()
            },
            &config,
        )
        .unwrap();

        assert_eq!(overview.total_requests, 3);
        assert_eq!(overview.success_count, 1);
        assert_eq!(overview.failure_count, 1);
        assert_eq!(overview.canceled_count, 1);
        assert_eq!(overview.success_rate, 50.0);
        assert_eq!(failures.total, 1);
        assert_eq!(failures.items[0].request_id, "upstream-failure");
        assert_eq!(failures.items[0].failure_status, 429);
        assert!(failures.items[0].failure_body.contains("quota exhausted"));
        assert_eq!(cancellations.total, 1);
        assert_eq!(cancellations.items[0].request_id, "client-canceled");
        assert!(cancellations.items[0].canceled);
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
    fn legacy_v2_database_is_backed_up_and_migrated_once() {
        let root = test_root("keeper-v3-migration");
        let connection = create_legacy_v2_database(&root);
        connection
            .execute(
                r#"
                INSERT INTO usage_events (
                    event_key, timestamp, timestamp_ms, local_hour, latency_ms, ttft_ms,
                    source, auth_index, failed, provider, model, alias, reasoning_effort,
                    service_tier, response_service_tier, executor_type, endpoint, auth_type,
                    api_key_hash, api_key_display, api_key_remark, request_id,
                    input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
                    cache_creation_tokens, total_tokens, created_at
                ) VALUES (
                    'request-1', '2026-07-17T20:30:00+08:00', 1784291400000,
                    '2026-07-17-20', 100, 20, 'source', 'auth', 0, 'openai',
                    'gpt-test', 'alias-test', 'high', '', '', '',
                    'POST /v1/responses', 'oauth', 'legacy-hash', '12••••',
                    '旧密钥', 'request-1', 10, 20, 5, 2, 3, 30,
                    '2026-07-17T20:30:01+08:00'
                )
                "#,
                [],
            )
            .unwrap();
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let user_version = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap();
        let migrated = connection
            .query_row(
                r#"
                SELECT COUNT(*), SUM(total_tokens), api_group_key, model_alias,
                       cached_tokens, collector_source
                FROM usage_events
                "#,
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        let marker = connection
            .query_row(
                "SELECT value FROM usage_metadata WHERE key = ?1",
                params![USAGE_DATABASE_MIGRATION_KEY],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let backups = fs::read_dir(root.join(USAGE_BACKUP_DIR_NAME))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(user_version, USAGE_DATABASE_SCHEMA_VERSION);
        assert_eq!(migrated.0, 1);
        assert_eq!(migrated.1, 30);
        assert_eq!(migrated.2, "legacy-hash");
        assert_eq!(migrated.3.as_deref(), Some("alias-test"));
        assert_eq!(migrated.4, 5);
        assert_eq!(migrated.5, "legacy_migration");
        assert!(!marker.is_empty());
        assert_eq!(backups.len(), 1);

        let duplicate_inserted = connection
            .execute(
                r#"
                INSERT INTO usage_events (
                    event_key, timestamp, timestamp_ms, local_hour, created_at
                ) VALUES (
                    'request-1', '2026-07-17T20:31:00+08:00', 1784291460000,
                    '2026-07-17-20', '2026-07-17T20:31:01+08:00'
                )
                "#,
                [],
            )
            .unwrap();
        assert_eq!(duplicate_inserted, 1);
        let duplicate_count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_events WHERE event_key = 'request-1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(duplicate_count, 2);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failure_detail_migration_backfills_processed_inbox_rows_once() {
        let root = test_root("failure-detail-v4-migration");
        let mut connection = open_test_database(&root);
        let mut record = sample_record(
            "legacy-canceled",
            "2026-07-17T20:30:00+08:00",
            "gemini-test",
        );
        record.failed = true;
        insert_usage_records(&mut connection, &[record]).unwrap();
        connection
            .execute(
                r#"
                INSERT INTO usage_inbox (
                    source, message_hash, raw_message, status, attempt_count,
                    usage_event_key, received_at, processed_at, created_at, updated_at
                ) VALUES (
                    'test', 'legacy-canceled-hash', ?1, 'processed', 1,
                    'legacy-canceled', ?2, ?2, ?2, ?2
                )
                "#,
                params![
                    serde_json::json!({
                        "request_id": "legacy-canceled",
                        "failed": true,
                        "fail": {
                            "status_code": 499,
                            "body": "client closed request"
                        }
                    })
                    .to_string(),
                    Local::now().to_rfc3339(),
                ],
            )
            .unwrap();
        connection
            .execute(
                "DELETE FROM usage_metadata WHERE key = ?1",
                params![USAGE_FAILURE_MIGRATION_KEY],
            )
            .unwrap();
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let migrated = connection
            .query_row(
                r#"
                SELECT canceled, failure_status, failure_body
                FROM usage_events
                WHERE event_key = 'legacy-canceled'
                "#,
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        let markers = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_metadata WHERE key = ?1",
                params![USAGE_FAILURE_MIGRATION_KEY],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(migrated.0, 1);
        assert_eq!(migrated.1, 499);
        assert_eq!(migrated.2, "client closed request");
        assert_eq!(markers, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_inbox_recovers_valid_rows_and_isolates_malformed_rows() {
        let root = test_root("durable-inbox");
        initialize_usage_storage_at(&root).unwrap();
        let mut connection = open_usage_database_at(&root).unwrap();
        enqueue_usage_queue_items(
            &mut connection,
            "http_pull",
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-17T20:30:00+08:00",
                    "request_id": "request-1",
                    "model": "gpt-test",
                    "tokens": { "input_tokens": 10, "output_tokens": 20 }
                }),
                serde_json::json!("not-an-object"),
            ],
        )
        .unwrap();
        drop(connection);

        let mut connection = open_usage_database_at(&root).unwrap();
        let inserted = process_usage_inbox(&mut connection, &GuiConfigFile::default()).unwrap();
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let processed_count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_inbox WHERE status = 'processed'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let failed_count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_inbox WHERE status = 'decode_failed'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(inserted, 1);
        assert_eq!(event_count, 1);
        assert_eq!(processed_count, 1);
        assert_eq!(failed_count, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_inbox_preserves_multiple_events_with_same_request_id() {
        let root = test_root("durable-inbox-duplicate-request-id");
        initialize_usage_storage_at(&root).unwrap();
        let mut connection = open_usage_database_at(&root).unwrap();
        enqueue_usage_queue_items(
            &mut connection,
            "redis_subscribe:usage",
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-17T20:30:00+08:00",
                    "request_id": "persistent-connection",
                    "model": "gpt-first",
                    "tokens": { "input_tokens": 10, "output_tokens": 20, "total_tokens": 30 }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-17T20:31:00+08:00",
                    "request_id": "persistent-connection",
                    "model": "gpt-second",
                    "tokens": { "input_tokens": 30, "output_tokens": 40, "total_tokens": 70 }
                }),
            ],
        )
        .unwrap();

        let inserted = process_usage_inbox(&mut connection, &GuiConfigFile::default()).unwrap();
        assert_eq!(inserted, 2);
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(event_count, 2);

        let rows = {
            let mut statement = connection
                .prepare("SELECT event_key, model, total_tokens FROM usage_events ORDER BY id")
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            rows,
            vec![
                (
                    "persistent-connection".to_string(),
                    "gpt-first".to_string(),
                    30
                ),
                (
                    "persistent-connection".to_string(),
                    "gpt-second".to_string(),
                    70
                ),
            ]
        );

        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inbox_cleanup_preserves_pending_and_recent_failure_rows() {
        let root = test_root("inbox-cleanup");
        let connection = open_test_database(&root);
        let now = Local::now();
        let old_processed = (now - chrono::Duration::days(1)).to_rfc3339();
        let recent_failure = (now - chrono::Duration::days(1)).to_rfc3339();
        let old_failure = (now - chrono::Duration::days(8)).to_rfc3339();
        for (status, processed_at, updated_at) in [
            (
                "processed",
                Some(old_processed.as_str()),
                old_processed.as_str(),
            ),
            ("pending", None, old_failure.as_str()),
            (
                "decode_failed",
                Some(recent_failure.as_str()),
                recent_failure.as_str(),
            ),
            (
                "discarded",
                Some(old_failure.as_str()),
                old_failure.as_str(),
            ),
        ] {
            connection
                .execute(
                    r#"
                    INSERT INTO usage_inbox (
                        source, message_hash, raw_message, status, attempt_count,
                        received_at, processed_at, created_at, updated_at
                    ) VALUES ('test', 'hash', '{}', ?1, 0, ?3, ?2, ?3, ?3)
                    "#,
                    params![status, processed_at, updated_at],
                )
                .unwrap();
        }

        cleanup_usage_inbox(&connection, now).unwrap();
        let statuses = {
            let mut statement = connection
                .prepare("SELECT status FROM usage_inbox ORDER BY id")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };

        assert_eq!(statuses, vec!["pending", "decode_failed"]);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_storage_preserves_duplicate_event_keys_transactionally() {
        let root = test_root("sqlite-duplicate-event-keys");
        let mut connection = open_test_database(&root);
        let first = sample_record("request-1", "2026-07-17T20:30:00+08:00", "gpt-test");
        let second = sample_record("request-1", "2026-07-17T20:31:00+08:00", "gpt-test-updated");

        assert_eq!(
            insert_usage_records(&mut connection, std::slice::from_ref(&first)).unwrap(),
            1
        );
        assert_eq!(insert_usage_records(&mut connection, &[second]).unwrap(), 1);
        let count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();

        assert_eq!(count, 2);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_v3_database_migrates_unique_event_key_without_losing_rows() {
        let root = test_root("event-key-v5-migration");
        let mut connection = open_test_database(&root);
        let table_sql = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let indexes = {
            let mut statement = connection
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_events'")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        for index in indexes {
            connection
                .execute(
                    &format!("DROP INDEX {}", quote_sqlite_identifier(&index)),
                    [],
                )
                .unwrap();
        }
        connection
            .execute(
                "ALTER TABLE usage_events RENAME TO usage_events_previous",
                [],
            )
            .unwrap();
        let unique_table_sql = replace_sql_fragment_case_insensitive(
            &table_sql,
            "event_key TEXT NOT NULL,",
            "event_key TEXT NOT NULL UNIQUE,",
        )
        .unwrap();
        connection.execute_batch(&unique_table_sql).unwrap();
        connection
            .execute("DROP TABLE usage_events_previous", [])
            .unwrap();

        migrate_usage_database(&mut connection, &root).unwrap();
        connection
            .execute(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, created_at) VALUES ('persistent', '2026-07-17T20:30:00+08:00', 1, '2026-07-17-20', '2026-07-17T20:30:00+08:00'), ('persistent', '2026-07-17T20:31:00+08:00', 2, '2026-07-17-20', '2026-07-17T20:31:00+08:00')",
                [],
            )
            .unwrap();
        let count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_events WHERE event_key = 'persistent'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM usage_metadata WHERE key = ?1",
                    params![USAGE_EVENT_KEY_MIGRATION_KEY],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
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
        assert_eq!(overview.tps, 0.0);
        assert_eq!(overview.tps_sample_count, 0);
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
    fn overview_tps_uses_weighted_generation_time_and_ignores_invalid_records() {
        let root = test_root("tps-overview");
        let mut connection = open_test_database(&root);

        let mut first = sample_record("tps-1", "2026-07-17T20:30:00+08:00", "gpt-a");
        first.latency_ms = 1_000;
        first.ttft_ms = Some(200);
        first.tokens.output_tokens = 80;

        let mut second = sample_record("tps-2", "2026-07-17T20:31:00+08:00", "gpt-a");
        second.latency_ms = 2_000;
        second.ttft_ms = Some(1_000);
        second.tokens.output_tokens = 20;

        let mut missing_ttft = sample_record("tps-3", "2026-07-17T20:32:00+08:00", "gpt-a");
        missing_ttft.latency_ms = 500;
        missing_ttft.ttft_ms = None;
        missing_ttft.tokens.output_tokens = 100;

        let mut equal_latency = sample_record("tps-4", "2026-07-17T20:33:00+08:00", "gpt-a");
        equal_latency.latency_ms = 500;
        equal_latency.ttft_ms = Some(500);
        equal_latency.tokens.output_tokens = 100;

        let mut failed = sample_record("tps-5", "2026-07-17T20:34:00+08:00", "gpt-a");
        failed.failed = true;
        failed.tokens.output_tokens = 100;

        let mut canceled = sample_record("tps-6", "2026-07-17T20:35:00+08:00", "gpt-a");
        canceled.canceled = true;
        canceled.tokens.output_tokens = 100;

        let mut non_generation = sample_record("tps-7", "2026-07-17T20:36:00+08:00", "gpt-a");
        non_generation.generate = false;
        non_generation.tokens.output_tokens = 100;

        insert_usage_records(
            &mut connection,
            &[
                first,
                second,
                missing_ttft,
                equal_latency,
                failed,
                canceled,
                non_generation,
            ],
        )
        .unwrap();

        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();

        assert!((overview.tps - (100.0 * 1_000.0 / 1_800.0)).abs() < f64::EPSILON);
        assert_eq!(overview.tps_sample_count, 2);
        drop(connection);
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
