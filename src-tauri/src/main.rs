#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod app_settings;
mod app_update;
mod claude_catalog;
mod codex_catalog;
mod codex_sessions;
mod configuration_watcher;
mod core_config;
mod core_runtime;
mod management_api;
mod provider_health;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod tray;
mod usage;

#[cfg(test)]
use configuration_watcher::nearest_existing_watch_directory;
use management_api::{
    management_authorization, management_endpoint, management_http_client, read_management_text,
    read_management_value,
};
#[cfg(test)]
use provider_health::{provider_health_content_type_is_streaming, provider_health_stream_has_text};

use agents::*;
use app_settings::*;
use app_update::*;
use core_config::*;
use core_runtime::*;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSEvent;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::Arc;
use std::{
    collections::HashSet,
    env, fs,
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{LazyLock, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tar::Archive;
#[cfg(target_os = "windows")]
use tauri::menu::PredefinedMenuItem;
#[cfg(target_os = "macos")]
use tauri::tray::{MouseButtonState, TrayIcon};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};
use tauri::{Emitter, LogicalSize, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tray::*;
use zip::ZipArchive;

const RELEASE_PAGE_URL: &str = "https://github.com/router-for-me/CLIProxyAPI/releases/latest";
const RELEASE_ATOM_URL: &str = "https://github.com/router-for-me/CLIProxyAPI/releases.atom";
const RELEASE_DOWNLOAD_PREFIX: &str =
    "https://github.com/router-for-me/CLIProxyAPI/releases/download/";
#[cfg(windows)]
const APP_UPDATE_MANIFEST_URL: &str = "https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest/download/portable-update-windows.json";
#[cfg(target_os = "linux")]
const APP_UPDATE_MANIFEST_URL: &str = "https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest/download/portable-update-linux.json";
#[cfg(target_os = "macos")]
const APP_UPDATE_MANIFEST_URL: &str = "https://github.com/router-for-me/EasyCLIProxyAPI/releases/latest/download/portable-update-darwin.json";
const APP_RELEASE_DOWNLOAD_PREFIX: &str =
    "https://github.com/router-for-me/EasyCLIProxyAPI/releases/download/";
#[cfg(windows)]
const APP_UPDATE_MANIFEST_NAME: &str = "portable-update-windows.json";
#[cfg(target_os = "linux")]
const APP_UPDATE_MANIFEST_NAME: &str = "portable-update-linux.json";
#[cfg(target_os = "macos")]
const APP_UPDATE_MANIFEST_NAME: &str = "portable-update-darwin.json";
const CODEX_MODEL_CATALOG_URL: &str = "https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/src-tauri/resources/codex_models/model-catalog.json";
const CODEX_MODEL_CATALOG_OVERRIDE_DIR: &str = "codex_models";
const CODEX_MODEL_CATALOG_SOURCE_FILE: &str = "model-catalog.json";
const MAX_CODEX_MODEL_CATALOG_BYTES: usize = 4 * 1024 * 1024;
const APP_UPDATE_PROGRESS_EVENT: &str = "app-update-progress";
const PORTABLE_APP_MANIFEST_FILE: &str = "portable-app.json";
#[cfg(windows)]
const PORTABLE_APP_BINARY: &str = "EasyCLIProxyAPI.exe";
#[cfg(target_os = "linux")]
const PORTABLE_APP_BINARY: &str = "EasyCLIProxyAPI";
const CORE_INSTALL_PROGRESS_EVENT: &str = "core-install-progress";
const CORE_STATUS_EVENT: &str = "core-status-changed";
const CONFIG_FILES_CHANGED_EVENT: &str = "config-files-changed";
#[cfg(target_os = "windows")]
const WINDOWS_CLOSE_REQUEST_EVENT: &str = "windows-close-requested";
const CORE_METADATA_FILE: &str = "cpa-gui-meta.json";
const CORE_CONFIG_FILE: &str = "config.yaml";
const CORE_EXAMPLE_CONFIG_FILE: &str = "config.example.yaml";
const CORE_VERSION_FILE: &str = "core-version.txt";
const CORE_CHECKSUMS_FILE: &str = "checksums.txt";
const GUI_CONFIG_FILE: &str = "config.toml";
const LEGACY_GUI_CONFIG_FILE: &str = "cpa-gui.yaml";
const MIN_MAIN_WINDOW_WIDTH: u32 = 640;
const MIN_MAIN_WINDOW_HEIGHT: u32 = 600;
const MAX_SAVED_WINDOW_DIMENSION: u32 = 16_384;
const DEFAULT_MAIN_WINDOW_WIDTH: u32 = 1531;
const DEFAULT_MAIN_WINDOW_HEIGHT: u32 = 891;
const OAUTH_DIR_NAME: &str = "oauth";
const DEFAULT_AUTH_DIR: &str = "../oauth";
const DEFAULT_API_KEY: &str = "123456";
const DEFAULT_API_KEY_INITIAL_REMARK: &str = "默认密钥";
const DEFAULT_REQUEST_RETRY: u32 = 3;
const DEFAULT_MAX_RETRY_CREDENTIALS: u32 = 0;
const DEFAULT_MAX_RETRY_INTERVAL: u32 = 30;
const DEFAULT_STREAMING_BOOTSTRAP_RETRIES: u32 = 0;
const LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY: &str = "123456";
const MANAGED_AGENT_PROVIDER_ID: &str = "cpa-gui";
const PI_AGENT_ID: &str = "pi";
const PI_AGENT_NAME: &str = "Pi";
const PI_CLIPROXYAPI_PACKAGE: &str = "npm:@router-for-me/pi-cliproxyapi-provider";
const PI_CLIPROXYAPI_NPM_LATEST_URL: &str =
    "https://registry.npmjs.org/@router-for-me%2Fpi-cliproxyapi-provider/latest";
const PI_CLIPROXYAPI_PROVIDER_ID: &str = "cliproxyapi";
const PI_AGENT_CONFIG_FILE: &str = "cliproxyapi.json";
const PI_AGENT_SETTINGS_FILE: &str = "settings.json";
const CODEX_MODEL_CATALOG_FILE: &str = "cpa-gui-model-catalog.json";
const CODEX_OAUTH_LOGIN_REQUIRED_ERROR: &str = "CODEX_OAUTH_LOGIN_REQUIRED";
const CLAUDE_DESKTOP_PROFILE_ID: &str = "00000000-0000-4000-8000-000000831700";
const CLAUDE_DESKTOP_OPUS_MODEL_ID: &str = "claude-opus-5";
const CLAUDE_DESKTOP_SONNET_MODEL_ID: &str = "claude-sonnet-4-6";
const CLAUDE_DESKTOP_HAIKU_MODEL_ID: &str = "claude-haiku-4-5";
const MANAGED_CLAUDE_OPUS_ALIAS_DISPLAY_NAME: &str = "EasyCLIProxyAPI managed Claude Opus mapping";
const MANAGED_CLAUDE_SONNET_ALIAS_DISPLAY_NAME: &str =
    "EasyCLIProxyAPI managed Claude Sonnet mapping";
const MANAGED_CLAUDE_HAIKU_ALIAS_DISPLAY_NAME: &str =
    "EasyCLIProxyAPI managed Claude Haiku mapping";
const DEFAULT_CLAUDE_CONTEXT_WINDOW: u64 = 200_000;
const CLAUDE_DESKTOP_EXTENDED_CONTEXT_WINDOW: u64 = 1_000_000;
const CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV: &str = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
const CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV: &str = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
const DISABLE_AUTO_COMPACT_ENV: &str = "DISABLE_AUTO_COMPACT";
const DEFAULT_CLAUDE_AUTO_COMPACT_PCT: u8 = 90;
const MODEL_ALIAS_CONFIG_SECTIONS: &[&str] = &[
    "codex-api-key",
    "openai-compatibility",
    "claude-api-key",
    "gemini-api-key",
];
const LEGACY_AGENT_MODIFICATION_STATE_VERSION: u8 = 1;
const AGENT_MODIFICATION_STATE_VERSION: u8 = 2;
const AGENT_APPLIED_STATE_VERSION: u8 = 4;
const AGENT_PHASE_APPLYING: &str = "applying";
const AGENT_PHASE_ACTIVE: &str = "active";
const AGENT_PHASE_RESTORING: &str = "restoring";
const AGENT_PHASE_RECOVERY: &str = "recovery";
#[cfg(test)]
const AGENT_MODIFICATION_STATE_CONFLICT: &str = "conflict";
const USER_AGENT: &str = concat!(
    "CPA-GUI/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/router-for-me/CLIProxyAPI)"
);
const APP_USER_AGENT: &str = concat!(
    "EasyCLIProxyAPI/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/router-for-me/EasyCLIProxyAPI)"
);
static CORE_CONFIG_FILE_LOCK: Mutex<()> = Mutex::new(());
static AGENT_CONFIG_FILE_LOCK: Mutex<()> = Mutex::new(());
static CODEX_APPLIED_STATES: LazyLock<
    Mutex<std::collections::HashMap<PathBuf, AgentAppliedState>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
static CONFIG_WRITE_HASHES: LazyLock<Mutex<std::collections::HashMap<PathBuf, String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn normalize_app_locale(locale: &str) -> &'static str {
    let normalized = locale.trim().to_ascii_lowercase();
    if normalized.starts_with("en") {
        "en"
    } else if normalized.starts_with("ja") {
        "ja"
    } else if normalized == "zh-tw"
        || normalized == "zh-hk"
        || normalized == "zh-mo"
        || normalized.starts_with("zh-hant")
    {
        "zh-TW"
    } else {
        "zh-CN"
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn locale_text<'a>(locale: &str, zh_cn: &'a str, en: &'a str) -> &'a str {
    match normalize_app_locale(locale) {
        "en" => en,
        "zh-TW" => match zh_cn {
            "打开主界面" => "開啟主介面",
            "退出" => "退出",
            "内核状态：处理中" => "核心狀態：處理中",
            "内核状态：未安装" => "核心狀態：未安裝",
            "内核状态：运行中" => "核心狀態：執行中",
            "内核状态：已停止" => "核心狀態：已停止",
            "处理中..." => "處理中...",
            "停止内核" => "停止核心",
            "启动内核" => "啟動核心",
            "重启内核" => "重新啟動核心",
            "EasyCLIProxyAPI · 内核处理中" => "EasyCLIProxyAPI · 核心處理中",
            "EasyCLIProxyAPI · 内核未安装" => "EasyCLIProxyAPI · 核心未安裝",
            "EasyCLIProxyAPI · 内核运行中" => "EasyCLIProxyAPI · 核心執行中",
            "EasyCLIProxyAPI · 内核已停止" => "EasyCLIProxyAPI · 核心已停止",
            "EasyCLIProxyAPI · 内核操作失败" => "EasyCLIProxyAPI · 核心操作失敗",
            "内核状态：正在检查" => "核心狀態：正在檢查",
            _ => zh_cn,
        },
        "ja" => match zh_cn {
            "打开主界面" => "メイン画面を開く",
            "退出" => "終了",
            "内核状态：处理中" => "コア状態：処理中",
            "内核状态：未安装" => "コア状態：未インストール",
            "内核状态：运行中" => "コア状態：実行中",
            "内核状态：已停止" => "コア状態：停止済み",
            "处理中..." => "処理中...",
            "停止内核" => "コアを停止",
            "启动内核" => "コアを起動",
            "重启内核" => "コアを再起動",
            "EasyCLIProxyAPI · 内核处理中" => "EasyCLIProxyAPI · コア処理中",
            "EasyCLIProxyAPI · 内核未安装" => "EasyCLIProxyAPI · コア未インストール",
            "EasyCLIProxyAPI · 内核运行中" => "EasyCLIProxyAPI · コア実行中",
            "EasyCLIProxyAPI · 内核已停止" => "EasyCLIProxyAPI · コア停止済み",
            "EasyCLIProxyAPI · 内核操作失败" => "EasyCLIProxyAPI · コア操作失敗",
            "内核状态：正在检查" => "コア状態：確認中",
            _ => zh_cn,
        },
        _ => zh_cn,
    }
}

#[derive(Default)]
struct CoreDownloadState {
    inner: Mutex<CoreDownloadInner>,
}

#[derive(Default)]
struct CoreDownloadInner {
    running: bool,
    token: Option<CancellationToken>,
    task: CoreInstallTask,
}

#[derive(Default)]
struct AppUpdateState {
    inner: Mutex<AppUpdateInner>,
}

#[derive(Default)]
struct AppUpdateInner {
    task: AppUpdateTask,
    token: Option<CancellationToken>,
    pending: Option<PendingAppUpdate>,
}

#[derive(Default)]
struct CoreProcessState {
    child: Mutex<Option<Child>>,
    #[cfg(windows)]
    job: Mutex<Option<isize>>,
}

struct GuiConfigState {
    inner: Mutex<GuiConfigFile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SavedWindowSize {
    width: u32,
    height: u32,
}

struct MainWindowSizeState {
    inner: Mutex<Option<SavedWindowSize>>,
}

#[derive(Default)]
struct AgentConfigStatusCache {
    refresh_lock: Mutex<()>,
    entry: Mutex<Option<AgentConfigStatusCacheEntry>>,
}

struct AgentConfigStatusCacheEntry {
    port: u16,
    api_key_sha256: String,
    statuses: Vec<AgentConfigStatus>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFilesChangedPayload {
    paths: Vec<String>,
    errors: Vec<String>,
}

impl AgentConfigStatusCache {
    fn get(&self, port: u16, api_key: &str) -> Result<Option<Vec<AgentConfigStatus>>, String> {
        let api_key_sha256 = sha256_bytes(api_key.as_bytes());
        self.entry
            .lock()
            .map(|entry| {
                entry
                    .as_ref()
                    .filter(|entry| entry.port == port && entry.api_key_sha256 == api_key_sha256)
                    .map(|entry| entry.statuses.clone())
            })
            .map_err(|_| "智能体配置状态缓存锁已损坏".to_string())
    }

    fn replace(
        &self,
        port: u16,
        api_key: &str,
        statuses: Vec<AgentConfigStatus>,
    ) -> Result<(), String> {
        let mut current = self
            .entry
            .lock()
            .map_err(|_| "智能体配置状态缓存锁已损坏".to_string())?;
        *current = Some(AgentConfigStatusCacheEntry {
            port,
            api_key_sha256: sha256_bytes(api_key.as_bytes()),
            statuses,
        });
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        let mut current = self
            .entry
            .lock()
            .map_err(|_| "智能体配置状态缓存锁已损坏".to_string())?;
        *current = None;
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CorePlatform {
    os: String,
    arch: String,
    asset_os: String,
    asset_arch: String,
    archive_kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreStatus {
    installed: bool,
    running: bool,
    managed: bool,
    process_id: Option<u32>,
    current_version: Option<String>,
    install_dir: String,
    binary_path: Option<String>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreLatest {
    version: String,
    asset_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInfo {
    current_version: String,
    latest_version: String,
    update_available: bool,
    release_url: String,
    auto_update_supported: bool,
    download_size_bytes: Option<u64>,
    unsupported_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableUpdateManifest {
    schema_version: u32,
    version: String,
    published_at: String,
    release_url: String,
    assets: std::collections::HashMap<String, PortableUpdateAsset>,
    #[serde(default)]
    full_assets: Option<std::collections::HashMap<String, PortableUpdateAsset>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableUpdateAsset {
    url: String,
    #[serde(default)]
    fallback_urls: Vec<String>,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct GitcodeRelease {
    tag_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableAppManifest {
    schema_version: u32,
    application: String,
    version: String,
    platform: String,
    arch: String,
    #[serde(default)]
    auto_update: bool,
}

#[derive(Clone)]
struct PendingAppUpdate {
    version: String,
    asset: PortableUpdateAsset,
    #[cfg_attr(not(windows), allow(dead_code))]
    arch: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateTask {
    running: bool,
    cancellable: bool,
    phase: String,
    target_version: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<f64>,
    message: Option<String>,
}

impl Default for AppUpdateTask {
    fn default() -> Self {
        Self {
            running: false,
            cancellable: false,
            phase: "idle".to_string(),
            target_version: None,
            downloaded_bytes: 0,
            total_bytes: None,
            percent: None,
            message: None,
        }
    }
}

#[cfg(any(windows, target_os = "linux"))]
struct PortablePackagePayload {
    manifest: PortableAppManifest,
    core_archive_name: Option<String>,
}

#[cfg(any(windows, target_os = "linux"))]
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableUpdateDescriptor {
    parent_pid: u32,
    current_exe: PathBuf,
    staged_exe: PathBuf,
    current_manifest: PathBuf,
    staged_manifest: PathBuf,
    backup_exe: PathBuf,
    backup_manifest: PathBuf,
    current_core_version: PathBuf,
    staged_core_version: PathBuf,
    backup_core_version: PathBuf,
    staged_core_archive: PathBuf,
    target_core_archive: PathBuf,
    install_core_archive: bool,
    ack_path: PathBuf,
    work_dir: PathBuf,
    target_version: String,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MacosUpdateDescriptor {
    parent_pid: u32,
    current_app: PathBuf,
    staged_app: PathBuf,
    backup_app: PathBuf,
    executable_relative_path: PathBuf,
    ack_path: PathBuf,
    work_dir: PathBuf,
    target_version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundledCoreInfo {
    version: String,
    asset_name: String,
    size_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreInstallResult {
    version: String,
    asset_name: String,
    install_dir: String,
    binary_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreInstallTask {
    running: bool,
    cancellable: bool,
    phase: String,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<f64>,
    message: Option<String>,
    result: Option<CoreInstallResult>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
struct GuiConfigFile {
    locale: String,
    port: u16,
    allow_lan: bool,
    host: String,
    run_on_startup: bool,
    silent_start: bool,
    close_behavior: WindowsCloseBehavior,
    window_width: Option<u32>,
    window_height: Option<u32>,
    auth_dir: String,
    #[serde(deserialize_with = "deserialize_gui_api_keys")]
    api_keys: Vec<GuiApiKeyEntry>,
    api_access_remarks: Vec<GuiApiAccessRemark>,
    management_secret_key: String,
    usage_statistics_enabled: bool,
    plugins_enabled: bool,
    routing_strategy: String,
    proxy_url: String,
    routing_session_affinity: bool,
    routing_session_affinity_ttl: String,
    request_retry: u32,
    max_retry_credentials: u32,
    max_retry_interval: u32,
    streaming_bootstrap_retries: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum WindowsCloseAction {
    Exit,
    MinimizeToTray,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum WindowsCloseBehavior {
    #[default]
    Ask,
    Exit,
    MinimizeToTray,
}

impl WindowsCloseBehavior {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Exit => "exit",
            Self::MinimizeToTray => "minimize-to-tray",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct GuiApiKeyEntry {
    key: String,
    #[serde(default)]
    remark: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct GuiApiAccessRemark {
    provider_section: String,
    api_key_hash: String,
    remark: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiAccessRemarkQuery {
    provider_section: String,
    api_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiAccessRemarkUpdate {
    provider_section: String,
    previous_api_keys: Vec<String>,
    api_keys: Vec<String>,
    remark: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum GuiApiKeyInput {
    Legacy(String),
    Entry(GuiApiKeyEntry),
}

fn deserialize_gui_api_keys<'de, D>(deserializer: D) -> Result<Vec<GuiApiKeyEntry>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries = Vec::<GuiApiKeyInput>::deserialize(deserializer)?;
    Ok(entries
        .into_iter()
        .map(|entry| match entry {
            GuiApiKeyInput::Legacy(key) => GuiApiKeyEntry {
                remark: String::new(),
                key,
            },
            GuiApiKeyInput::Entry(entry) => entry,
        })
        .collect())
}

impl Default for GuiConfigFile {
    fn default() -> Self {
        Self {
            locale: "zh-CN".to_string(),
            port: 8317,
            allow_lan: false,
            host: "127.0.0.1".to_string(),
            run_on_startup: false,
            silent_start: false,
            close_behavior: WindowsCloseBehavior::Ask,
            window_width: Some(DEFAULT_MAIN_WINDOW_WIDTH),
            window_height: Some(DEFAULT_MAIN_WINDOW_HEIGHT),
            auth_dir: DEFAULT_AUTH_DIR.to_string(),
            api_keys: vec![default_api_key_entry()],
            api_access_remarks: Vec::new(),
            // Populated with an OS-generated secret while loading the GUI
            // configuration. Core hashes the value written into config.yaml.
            management_secret_key: String::new(),
            usage_statistics_enabled: true,
            plugins_enabled: false,
            routing_strategy: "round-robin".to_string(),
            proxy_url: String::new(),
            routing_session_affinity: false,
            routing_session_affinity_ttl: String::new(),
            request_retry: DEFAULT_REQUEST_RETRY,
            max_retry_credentials: DEFAULT_MAX_RETRY_CREDENTIALS,
            max_retry_interval: DEFAULT_MAX_RETRY_INTERVAL,
            streaming_bootstrap_retries: DEFAULT_STREAMING_BOOTSTRAP_RETRIES,
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
struct GuiConfigPresence {
    locale: Option<String>,
    port: Option<u16>,
    allow_lan: Option<bool>,
    host: Option<String>,
    auth_dir: Option<String>,
    api_keys: Option<Vec<GuiApiKeyInput>>,
    api_access_remarks: Option<Vec<GuiApiAccessRemark>>,
    management_secret_key: Option<String>,
    close_behavior: Option<WindowsCloseBehavior>,
    silent_start: Option<bool>,
    usage_statistics_enabled: Option<bool>,
    plugins_enabled: Option<bool>,
    routing_strategy: Option<String>,
    proxy_url: Option<String>,
    routing_session_affinity: Option<bool>,
    routing_session_affinity_ttl: Option<String>,
    request_retry: Option<u32>,
    max_retry_credentials: Option<u32>,
    max_retry_interval: Option<u32>,
    streaming_bootstrap_retries: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GuiSettings {
    port: u16,
    allow_lan: bool,
    run_on_startup: bool,
    close_behavior: WindowsCloseBehavior,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SoftwareSettings {
    close_behavior: WindowsCloseBehavior,
    autostart_enabled: bool,
    silent_start_enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoftwareSettingsInput {
    close_behavior: WindowsCloseBehavior,
    autostart_enabled: bool,
    silent_start_enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfigStatus {
    id: String,
    name: String,
    supported_platform: bool,
    installed: bool,
    plugin_installed: bool,
    version: Option<String>,
    cli_version: Option<String>,
    app_version: Option<String>,
    plugin_version: Option<String>,
    config_paths: Vec<String>,
    config_exists: bool,
    config_valid: bool,
    configured: bool,
    current_model: Option<String>,
    oauth_configuration: bool,
    modification_enabled: bool,
    modification_state: String,
    backup_available: bool,
    applied_model: Option<String>,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
    warnings: Vec<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfigActionResult {
    outcome: String,
    enabled: bool,
    model: Option<String>,
    changed_files: Vec<String>,
    conflict_files: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiProviderUpdateStatus {
    installed_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexModelCatalogUpdateResult {
    outcome: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentModelOption {
    name: String,
    alias: Option<String>,
    #[serde(default)]
    is_alias: bool,
    #[serde(default)]
    context_window: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDesktopModelMappings {
    opus: String,
    sonnet: String,
    haiku: String,
    #[serde(default)]
    opus_1m: bool,
    #[serde(default)]
    sonnet_1m: bool,
    #[serde(default)]
    haiku_1m: bool,
    #[serde(default = "default_claude_code_max_context_tokens")]
    max_context_tokens: u64,
    #[serde(default = "default_claude_auto_compact_pct")]
    auto_compact_pct: u8,
    #[serde(default)]
    disable_auto_compact: bool,
}

fn default_claude_code_max_context_tokens() -> u64 {
    DEFAULT_CLAUDE_CONTEXT_WINDOW
}

fn default_claude_auto_compact_pct() -> u8 {
    DEFAULT_CLAUDE_AUTO_COMPACT_PCT
}

impl ClaudeDesktopModelMappings {
    fn all(model: &str) -> Self {
        Self {
            opus: model.to_string(),
            sonnet: model.to_string(),
            haiku: model.to_string(),
            opus_1m: false,
            sonnet_1m: false,
            haiku_1m: false,
            max_context_tokens: default_claude_code_max_context_tokens(),
            auto_compact_pct: default_claude_auto_compact_pct(),
            disable_auto_compact: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CodexModelDefinition {
    id: String,
    display_name: Option<String>,
    description: Option<String>,
    context_window: Option<u64>,
    reasoning_levels: Vec<String>,
    supports_tools: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinkingAliasEntry {
    source_model: String,
    alias: String,
    effort: Option<String>,
    provider: String,
    kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeedAliasEntry {
    source_model: String,
    alias: String,
    service_tier: String,
    provider: String,
    kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinkingAliasSource {
    id: String,
    model: String,
    display_name: Option<String>,
    provider: String,
    kind: String,
    protocol: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ThinkingAliasSourceLocation {
    CodexOauth,
    ConfigModel {
        section: &'static str,
        provider_index: usize,
        model_index: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedThinkingAliasSource {
    source: ThinkingAliasSource,
    location: ThinkingAliasSourceLocation,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentModificationRecord {
    version: u8,
    client: String,
    phase: String,
    model: String,
    files: Vec<AgentModificationFile>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentModificationFile {
    path: PathBuf,
    backup_path: PathBuf,
    existed_before: bool,
    original_sha256: Option<String>,
    managed_sha256: String,
}

struct AgentModificationInspection {
    enabled: bool,
    state: String,
    backup_available: bool,
    applied_model: Option<String>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
    warnings: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAppliedState {
    version: u8,
    client: String,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    backup_files: Vec<AgentAppliedBackupFile>,
    updated_at_unix: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAppliedBackupFile {
    path: PathBuf,
    backup_path: PathBuf,
    existed_before: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentClient {
    ClaudeCode,
    ClaudeDesktop,
    Codex,
    OpenCode,
    OpenClaw,
    Hermes,
}

#[derive(Clone, Debug)]
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))] // The desktop-app variants are constructed only on macOS/Windows builds.
enum CodexAppTarget {
    Application(PathBuf),
    #[cfg(target_os = "windows")]
    WindowsAppId(String),
}

impl AgentClient {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude-code" => Ok(Self::ClaudeCode),
            "claude-desktop" => Ok(Self::ClaudeDesktop),
            "codex" => Ok(Self::Codex),
            "opencode" => Ok(Self::OpenCode),
            "openclaw" => Ok(Self::OpenClaw),
            "hermes" => Ok(Self::Hermes),
            _ => Err(format!("不支持的智能体客户端: {value}")),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::ClaudeDesktop => "claude-desktop",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::OpenClaw => "openclaw",
            Self::Hermes => "hermes",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::ClaudeDesktop => "Claude Desktop",
            Self::Codex => "Codex",
            Self::OpenCode => "OpenCode",
            Self::OpenClaw => "OpenClaw",
            Self::Hermes => "Hermes Agent",
        }
    }

    fn supported_platform(self) -> bool {
        self != Self::ClaudeDesktop
            || cfg!(any(
                target_os = "windows",
                target_os = "macos",
                target_os = "linux"
            ))
    }

    fn executable_names(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["claude"],
            Self::ClaudeDesktop => &[],
            Self::Codex => &["codex"],
            Self::OpenCode => &["opencode"],
            Self::OpenClaw => &["openclaw"],
            Self::Hermes => &["hermes"],
        }
    }
}

struct AgentFileUpdate {
    path: PathBuf,
    after: String,
}

struct AgentConfigurationOptions<'a> {
    models: &'a [AgentModelOption],
    codex_catalog: Option<&'a str>,
    oauth_configuration: bool,
    claude_code_model_mappings: Option<&'a ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<&'a ClaudeDesktopModelMappings>,
}

struct PreparedAgentModels {
    models: Vec<AgentModelOption>,
    codex_catalog: Option<String>,
}

type FileSnapshot = (PathBuf, Option<Vec<u8>>);
#[cfg(test)]
type AgentRecordExtension = (AgentModificationRecord, Vec<FileSnapshot>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuiNetworkSettings {
    port: u16,
    allow_lan: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuiNetworkRoutingSettings {
    port: u16,
    allow_lan: bool,
    proxy_url: String,
    routing_session_affinity: bool,
    routing_session_affinity_ttl: String,
    request_retry: u32,
    max_retry_credentials: u32,
    max_retry_interval: u32,
    streaming_bootstrap_retries: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreConfigSettings {
    #[serde(skip_serializing)]
    host: String,
    #[serde(skip_serializing)]
    port: u16,
    #[serde(skip_serializing)]
    auth_dir: String,
    api_keys: Vec<String>,
    management_secret_configured: bool,
    #[serde(skip_serializing)]
    usage_statistics_enabled: bool,
    plugins_enabled: bool,
    routing_strategy: String,
    proxy_url: String,
    routing_session_affinity: bool,
    routing_session_affinity_ttl: String,
    request_retry: u32,
    max_retry_credentials: u32,
    max_retry_interval: u32,
    streaming_bootstrap_retries: u32,
    // Kept for internal config migration/tests; never exposed to the WebView.
    #[allow(dead_code)]
    #[serde(skip_serializing)]
    management_secret_key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreApiKeyView {
    api_key: String,
    remark: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreConfigView {
    api_keys: Vec<CoreApiKeyView>,
    management_secret_configured: bool,
    port: u16,
    allow_lan: bool,
    plugins_enabled: bool,
    routing_strategy: String,
    proxy_url: String,
    routing_session_affinity: bool,
    routing_session_affinity_ttl: String,
    request_retry: u32,
    max_retry_credentials: u32,
    max_retry_interval: u32,
    streaming_bootstrap_retries: u32,
}

impl Default for CoreInstallTask {
    fn default() -> Self {
        Self {
            running: false,
            cancellable: false,
            phase: "空闲".to_string(),
            downloaded: 0,
            total: None,
            percent: None,
            message: None,
            result: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreMetadata {
    version: String,
    asset_name: String,
    installed_at_unix: u64,
}

struct DownloadedArchive {
    size: u64,
    sha256: String,
}

impl CoreDownloadState {
    fn start(&self, token: CancellationToken, version: Option<String>) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "内核安装状态锁已损坏".to_string())?;

        if inner.running {
            return Err("已有内核安装任务正在运行".to_string());
        }

        inner.running = true;
        inner.token = Some(token);
        inner.task = CoreInstallTask {
            running: true,
            cancellable: true,
            phase: version
                .map(|version| format!("准备安装 {version}"))
                .unwrap_or_else(|| "准备安装最新版".to_string()),
            downloaded: 0,
            total: None,
            percent: None,
            message: None,
            result: None,
        };

        Ok(())
    }

    fn cancel(&self) {
        if let Ok(inner) = self.inner.lock() {
            if let Some(token) = &inner.token {
                token.cancel();
            }
        }
    }

    fn snapshot(&self) -> CoreInstallTask {
        self.inner
            .lock()
            .map(|inner| inner.task.clone())
            .unwrap_or_default()
    }

    fn progress(
        &self,
        window: &tauri::Window,
        phase: &str,
        downloaded: u64,
        total: Option<u64>,
        cancellable: bool,
    ) {
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| downloaded as f64 * 100.0 / total as f64);

        let task = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };

            inner.task.running = inner.running;
            inner.task.cancellable = cancellable;
            inner.task.phase = phase.to_string();
            inner.task.downloaded = downloaded;
            inner.task.total = total;
            inner.task.percent = percent;
            inner.task.clone()
        };

        let _ = window.emit(CORE_INSTALL_PROGRESS_EVENT, task);
    }

    fn finish(&self, window: &tauri::Window, result: Result<CoreInstallResult, String>) {
        let task = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };

            inner.running = false;
            inner.token = None;
            inner.task.running = false;
            inner.task.cancellable = false;

            match result {
                Ok(result) => {
                    inner.task.phase = "安装完成".to_string();
                    inner.task.downloaded = 1;
                    inner.task.total = Some(1);
                    inner.task.percent = Some(100.0);
                    inner.task.message = Some(format!("{} 安装完成", result.version));
                    inner.task.result = Some(result);
                }
                Err(error) => {
                    inner.task.phase = if error.contains("取消") {
                        "已取消".to_string()
                    } else {
                        "安装失败".to_string()
                    };
                    inner.task.message = Some(error);
                    inner.task.result = None;
                }
            }

            inner.task.clone()
        };

        let _ = window.emit(CORE_INSTALL_PROGRESS_EVENT, task);
    }
}

impl AppUpdateState {
    fn snapshot(&self) -> AppUpdateTask {
        self.inner
            .lock()
            .map(|inner| inner.task.clone())
            .unwrap_or_default()
    }

    fn set_pending(&self, pending: Option<PendingAppUpdate>, task: AppUpdateTask) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.pending = pending;
            if !inner.task.running {
                inner.task = task;
            }
        }
    }

    fn start(&self, token: CancellationToken) -> Result<PendingAppUpdate, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "应用更新状态锁已损坏".to_string())?;
        if inner.task.running {
            return Err("已有应用更新任务正在运行".to_string());
        }
        let pending = inner
            .pending
            .clone()
            .ok_or_else(|| "没有可安装的应用更新，请先检查更新".to_string())?;
        inner.token = Some(token);
        inner.task = AppUpdateTask {
            running: true,
            cancellable: true,
            phase: "downloading".to_string(),
            target_version: Some(pending.version.clone()),
            downloaded_bytes: 0,
            total_bytes: Some(pending.asset.size_bytes),
            percent: Some(0.0),
            message: None,
        };
        Ok(pending)
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    fn update_task<F>(&self, update: F) -> AppUpdateTask
    where
        F: FnOnce(&mut AppUpdateTask),
    {
        let Ok(mut inner) = self.inner.lock() else {
            return AppUpdateTask::default();
        };
        update(&mut inner.task);
        inner.task.clone()
    }

    fn finish(&self, phase: &str, message: Option<String>) -> AppUpdateTask {
        let Ok(mut inner) = self.inner.lock() else {
            return AppUpdateTask::default();
        };
        inner.task.running = false;
        inner.task.cancellable = false;
        inner.task.phase = phase.to_string();
        inner.task.message = message;
        inner.token = None;
        inner.task.clone()
    }

    fn cancel(&self) {
        if let Ok(inner) = self.inner.lock() {
            if let Some(token) = &inner.token {
                token.cancel();
            }
        }
    }
}

impl CoreProcessState {
    fn managed_pid(&self) -> Option<u32> {
        let Ok(mut child) = self.child.lock() else {
            return None;
        };

        let process = child.as_mut()?;

        if let Ok(None) = process.try_wait() {
            return Some(process.id());
        }

        *child = None;
        drop(child);
        self.clear_lifetime_guard();

        None
    }

    fn clear_lifetime_guard(&self) {
        #[cfg(windows)]
        if let Ok(mut job) = self.job.lock() {
            if let Some(handle) = job.take() {
                close_windows_handle(handle);
            }
        }
    }

    fn take_child(&self) -> Option<Child> {
        self.child.lock().ok().and_then(|mut child| child.take())
    }

    fn store_child(&self, child: Child) -> Result<u32, String> {
        let pid = child.id();

        #[cfg(windows)]
        {
            let job = attach_child_to_windows_job(&child)?;
            let Ok(mut managed_child) = self.child.lock() else {
                close_windows_handle(job);
                return Err("内核进程状态锁已损坏".to_string());
            };
            let Ok(mut managed_job) = self.job.lock() else {
                close_windows_handle(job);
                return Err("内核进程作业状态锁已损坏".to_string());
            };
            *managed_child = Some(child);
            *managed_job = Some(job);
        }

        #[cfg(not(windows))]
        {
            let mut managed_child = self
                .child
                .lock()
                .map_err(|_| "内核进程状态锁已损坏".to_string())?;
            *managed_child = Some(child);
        }

        Ok(pid)
    }
}

impl MainWindowSizeState {
    fn new(size: Option<SavedWindowSize>) -> Self {
        Self {
            inner: Mutex::new(size),
        }
    }

    fn snapshot(&self) -> Result<Option<SavedWindowSize>, String> {
        self.inner
            .lock()
            .map(|size| *size)
            .map_err(|_| "主窗口尺寸状态锁已损坏".to_string())
    }

    fn replace(&self, size: SavedWindowSize) -> Result<(), String> {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "主窗口尺寸状态锁已损坏".to_string())?;
        *current = Some(size);
        Ok(())
    }
}

impl GuiConfigState {
    fn new(config: GuiConfigFile) -> Self {
        Self {
            inner: Mutex::new(config),
        }
    }

    fn snapshot(&self) -> Result<GuiConfigFile, String> {
        self.inner
            .lock()
            .map(|config| config.clone())
            .map_err(|_| "GUI 配置状态锁已损坏".to_string())
    }

    fn replace_external(&self, config: GuiConfigFile) -> Result<(), String> {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "GUI 配置状态锁已损坏".to_string())?;
        *current = config;
        Ok(())
    }

    fn replace_core_settings_external(
        &self,
        settings: &CoreConfigSettings,
    ) -> Result<GuiConfigFile, String> {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "GUI 配置状态锁已损坏".to_string())?;
        let mut config = current.clone();
        apply_core_settings_to_gui_config(&mut config, settings);
        validate_gui_config(&config)?;
        *current = config.clone();
        Ok(config)
    }

    fn update_network(&self, port: u16, allow_lan: bool) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.port = port;
            config.allow_lan = allow_lan;
            config.host = if allow_lan { "0.0.0.0" } else { "127.0.0.1" }.to_string();
            Ok(())
        })
    }

    fn update_network_routing(&self, settings: &GuiConfigFile) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.port = settings.port;
            config.allow_lan = settings.allow_lan;
            config.host = settings.host.clone();
            config.proxy_url = settings.proxy_url.clone();
            config.routing_session_affinity = settings.routing_session_affinity;
            config.routing_session_affinity_ttl = settings.routing_session_affinity_ttl.clone();
            config.request_retry = settings.request_retry;
            config.max_retry_credentials = settings.max_retry_credentials;
            config.max_retry_interval = settings.max_retry_interval;
            config.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
            Ok(())
        })
    }

    fn set_run_on_startup(&self, run_on_startup: bool) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.run_on_startup = run_on_startup;
            Ok(())
        })
    }

    fn set_close_behavior(
        &self,
        close_behavior: WindowsCloseBehavior,
    ) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.close_behavior = close_behavior;
            Ok(())
        })
    }

    fn set_software_preferences(
        &self,
        close_behavior: WindowsCloseBehavior,
        silent_start: bool,
    ) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.close_behavior = close_behavior;
            config.silent_start = silent_start;
            Ok(())
        })
    }

    fn set_locale(&self, locale: String) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.locale = normalize_app_locale(&locale).to_string();
            Ok(())
        })
    }

    fn set_window_size(&self, size: SavedWindowSize) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.window_width = Some(size.width);
            config.window_height = Some(size.height);
            Ok(())
        })
    }

    fn set_management_secret_key(&self, secret_key: String) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.management_secret_key = secret_key;
            Ok(())
        })
    }

    fn sync_core_settings(&self, settings: &CoreConfigSettings) -> Result<GuiConfigFile, String> {
        self.sync_core_settings_with_api_key(settings, None)
    }

    fn sync_core_settings_with_api_key(
        &self,
        settings: &CoreConfigSettings,
        added_api_key: Option<GuiApiKeyEntry>,
    ) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.api_keys = merge_core_api_keys_with_gui_metadata(
                &config.api_keys,
                &settings.api_keys,
                added_api_key.as_ref(),
            );
            config.host = settings.host.clone();
            config.port = settings.port;
            config.allow_lan = !is_loopback_host(&settings.host);
            config.auth_dir = settings.auth_dir.clone();
            config.usage_statistics_enabled = settings.usage_statistics_enabled;
            if let Some(secret_key) = settings
                .management_secret_key
                .as_deref()
                .filter(|secret_key| !secret_key.is_empty())
                .filter(|secret_key| !is_hashed_management_secret_key(secret_key))
            {
                config.management_secret_key = secret_key.to_string();
            }
            config.plugins_enabled = settings.plugins_enabled;
            config.routing_strategy = settings.routing_strategy.clone();
            config.proxy_url = settings.proxy_url.clone();
            config.routing_session_affinity = settings.routing_session_affinity;
            config.routing_session_affinity_ttl = settings.routing_session_affinity_ttl.clone();
            config.request_retry = settings.request_retry;
            config.max_retry_credentials = settings.max_retry_credentials;
            config.max_retry_interval = settings.max_retry_interval;
            config.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
            Ok(())
        })
    }

    fn update<F>(&self, update: F) -> Result<GuiConfigFile, String>
    where
        F: FnOnce(&mut GuiConfigFile) -> Result<(), String>,
    {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "GUI 配置状态锁已损坏".to_string())?;
        let mut config = current.clone();
        update(&mut config)?;
        write_gui_config(&config)?;
        *current = config.clone();
        Ok(config)
    }
}

impl From<&GuiConfigFile> for GuiSettings {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            port: config.port,
            allow_lan: config.allow_lan,
            run_on_startup: config.run_on_startup,
            close_behavior: config.close_behavior,
        }
    }
}

impl From<&GuiConfigFile> for CoreConfigSettings {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            host: config.host.clone(),
            port: config.port,
            auth_dir: config.auth_dir.clone(),
            api_keys: gui_api_key_values(&config.api_keys),
            management_secret_configured: !config.management_secret_key.is_empty(),
            usage_statistics_enabled: config.usage_statistics_enabled,
            plugins_enabled: config.plugins_enabled,
            routing_strategy: config.routing_strategy.clone(),
            proxy_url: config.proxy_url.clone(),
            routing_session_affinity: config.routing_session_affinity,
            routing_session_affinity_ttl: config.routing_session_affinity_ttl.clone(),
            request_retry: config.request_retry,
            max_retry_credentials: config.max_retry_credentials,
            max_retry_interval: config.max_retry_interval,
            streaming_bootstrap_retries: config.streaming_bootstrap_retries,
            management_secret_key: Some(config.management_secret_key.clone()),
        }
    }
}

impl From<&GuiConfigFile> for CoreConfigView {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            api_keys: config
                .api_keys
                .iter()
                .map(|entry| CoreApiKeyView {
                    api_key: entry.key.clone(),
                    remark: entry.remark.clone(),
                })
                .collect(),
            management_secret_configured: !config.management_secret_key.is_empty(),
            port: config.port,
            allow_lan: config.allow_lan,
            plugins_enabled: config.plugins_enabled,
            routing_strategy: config.routing_strategy.clone(),
            proxy_url: config.proxy_url.clone(),
            routing_session_affinity: config.routing_session_affinity,
            routing_session_affinity_ttl: config.routing_session_affinity_ttl.clone(),
            request_retry: config.request_retry,
            max_retry_credentials: config.max_retry_credentials,
            max_retry_interval: config.max_retry_interval,
            streaming_bootstrap_retries: config.streaming_bootstrap_retries,
        }
    }
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    fallback_download_urls: Vec<String>,
    size: Option<u64>,
    digest: Option<String>,
}

fn main() {
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    {
        let mut args = env::args_os();
        while let Some(argument) = args.next() {
            if argument == "--portable-update-helper" {
                let result = args
                    .next()
                    .map(PathBuf::from)
                    .ok_or_else(|| "应用更新助手缺少描述文件".to_string())
                    .and_then(|path| run_portable_update_helper(&path));
                if let Err(error) = result {
                    eprintln!("{error}");
                }
                return;
            }
        }
    }

    let portable_update_ack = portable_update_ack_argument();
    let gui_config = match load_or_create_gui_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            let mut config = GuiConfigFile::default();
            if let Err(secret_error) = ensure_strong_management_secret(&mut config) {
                eprintln!("初始化 WebUI 安全密钥失败: {secret_error}");
                return;
            }
            if let Err(sanitize_error) = sanitize_gui_config(&mut config) {
                eprintln!("初始化固定凭证目录失败: {sanitize_error}");
            }
            config
        }
    };
    let initial_window_size = configured_window_size(&gui_config);
    let start_hidden = should_start_hidden(&gui_config);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(CoreDownloadState::default())
        .manage(AppUpdateState::default())
        .manage(CoreProcessState::default())
        .manage(usage::UsageCollectorState::default())
        .manage(GuiConfigState::new(gui_config))
        .manage(MainWindowSizeState::new(initial_window_size))
        .manage(AgentConfigStatusCache::default());

    let app = app.on_window_event(|window, event| {
        if window.label() != "main" {
            return;
        }

        let observed_size = match event {
            tauri::WindowEvent::Resized(physical_size) => {
                window.scale_factor().ok().and_then(|scale_factor| {
                    logical_window_size_from_physical(physical_size, scale_factor)
                })
            }
            tauri::WindowEvent::ScaleFactorChanged {
                scale_factor,
                new_inner_size,
                ..
            } => logical_window_size_from_physical(new_inner_size, *scale_factor),
            _ => None,
        };

        if let Some(observed_size) = observed_size {
            let window_size_state = window.state::<MainWindowSizeState>();
            if let Err(error) = window_size_state.replace(observed_size) {
                eprintln!("记录主窗口尺寸失败: {error}");
            }
        }
    });

    #[cfg(target_os = "macos")]
    let app = app.on_window_event(|window, event| {
        if window.label() == "main" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                set_macos_dock_visible(window.app_handle(), false);
                if let Err(error) = window.hide() {
                    eprintln!("隐藏主窗口失败: {error}");
                    set_macos_dock_visible(window.app_handle(), true);
                }
            }
        }
    });

    #[cfg(target_os = "windows")]
    let app = app.on_window_event(|window, event| {
        if window.label() == "main" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.emit(WINDOWS_CLOSE_REQUEST_EVENT, ()) {
                    eprintln!("显示 Windows 关闭确认失败: {error}");
                }
            }
        }
    });

    let app = app
        .setup(move |app| {
            if let Err(error) = codex_catalog::validate_embedded_catalog() {
                eprintln!("Codex 内置模型目录无效: {error}");
            }
            if let Err(error) = load_codex_model_catalog_override(app.handle()) {
                eprintln!("加载 Codex 模型目录更新文件失败，将使用内置目录: {error}");
            }
            let catalog_update_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = update_codex_model_catalog_inner(&catalog_update_app).await {
                    eprintln!("后台更新 Codex 模型目录失败，继续使用当前目录: {error}");
                }
            });
            if let Err(error) = restore_main_window_size(app.handle()) {
                eprintln!("{error}");
            }

            #[cfg(target_os = "macos")]
            setup_macos_tray(app)?;
            #[cfg(target_os = "windows")]
            setup_windows_tray(app)?;

            if let Err(error) = configure_initial_main_window(app.handle(), start_hidden) {
                eprintln!("配置启动窗口状态失败: {error}");
            }

            if let Err(error) =
                configuration_watcher::start_configuration_file_watcher(app.handle().clone())
            {
                eprintln!("启动配置文件监控失败: {error}");
            }

            let usage_app = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = usage::initialize_usage_storage() {
                    eprintln!("初始化使用记录目录失败: {error}");
                }
                usage::start_usage_collector(usage_app);
            });

            let agent_status_app = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let gui_config_state = agent_status_app.state::<GuiConfigState>();
                let cache = agent_status_app.state::<AgentConfigStatusCache>();
                if let Err(error) = refresh_agent_config_status_cache(
                    &agent_status_app,
                    gui_config_state.inner(),
                    cache.inner(),
                ) {
                    eprintln!("后台刷新智能体配置状态失败: {error}");
                }
            });

            let core_app = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let gui_config_state = core_app.state::<GuiConfigState>();
                let process_state = core_app.state::<CoreProcessState>();
                let Ok(config) = gui_config_state.snapshot() else {
                    return;
                };

                match auto_install_bundled_core_if_missing(&core_app) {
                    Ok(true) => eprintln!("未检测到 CPA 内核，已自动安装内置离线版本"),
                    Ok(false) => {}
                    Err(error) => eprintln!("自动安装 CPA 离线内核失败: {error}"),
                }

                if config.run_on_startup {
                    if let Err(error) = start_core_process_inner(process_state.inner(), &config) {
                        eprintln!("自动启动 CPA 内核失败: {error}");
                    }
                }

                if let Ok(status) =
                    current_core_status(Some(process_state.inner()), Some(config.port))
                {
                    emit_core_status(&core_app, &status);
                }
            });

            if let Some(ack_path) = portable_update_ack.as_ref() {
                fs::write(ack_path, env!("CARGO_PKG_VERSION").as_bytes())
                    .map_err(|error| format!("写入应用更新启动确认失败: {error}"))?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            detect_core_platform,
            get_core_status,
            get_gui_settings,
            resolve_api_access_remarks,
            save_api_access_remark,
            set_app_locale,
            resolve_windows_close_request,
            get_software_settings,
            save_software_settings,
            get_agent_config_statuses,
            refresh_agent_config_statuses,
            get_agent_models,
            check_pi_provider_update,
            install_pi_provider,
            update_pi_provider,
            repair_pi_provider,
            uninstall_pi_provider,
            check_codex_oauth_login,
            update_codex_model_catalog,
            get_thinking_aliases,
            get_thinking_alias_sources,
            create_thinking_alias,
            delete_thinking_alias,
            get_speed_aliases,
            get_speed_alias_sources,
            create_speed_alias,
            delete_speed_alias,
            apply_agent_config,
            close_agent_config_modification,
            reset_agent_config_to_default,
            clear_codex_config,
            set_agent_config_enabled,
            update_agent_config,
            get_lan_ipv4,
            save_gui_settings,
            save_network_routing_settings,
            get_core_config_settings,
            add_core_api_key,
            update_core_api_key,
            delete_core_api_key,
            set_core_management_secret_key,
            clear_core_management_secret_key,
            management_api::management_request,
            provider_health::provider_health_probe,
            management_api::upload_auth_file,
            management_api::open_auth_files_directory,
            set_core_plugins_enabled,
            set_core_routing_strategy,
            set_core_proxy_url,
            set_core_session_affinity,
            set_core_session_affinity_ttl,
            management_api::start_oauth_login,
            management_api::get_oauth_status,
            management_api::submit_oauth_callback,
            open_external_url,
            check_app_update,
            get_app_update_task,
            start_app_update,
            cancel_app_update,
            check_latest_core,
            detect_bundled_core,
            install_core_version,
            install_bundled_core,
            cancel_core_install,
            get_core_install_task,
            usage::get_usage_collector_status,
            usage::get_usage_overview,
            usage::get_usage_analysis,
            usage::get_usage_events,
            usage::export_usage_records,
            usage::get_usage_pricing,
            usage::save_usage_model_price,
            usage::delete_usage_model_price,
            usage::sync_usage_model_prices,
            start_core_process,
            stop_core_process,
            restart_core_process,
            codex_sessions::list_codex_sessions,
            codex_sessions::delete_codex_sessions,
            codex_sessions::repair_codex_session_metadata,
            codex_sessions::preview_codex_session_index_cleanup,
            codex_sessions::apply_codex_session_index_cleanup
        ])
        .build(tauri::generate_context!())
        .expect("failed to build app");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            if let Err(error) = persist_main_window_size(app_handle) {
                eprintln!("保存主窗口尺寸失败: {error}");
            }
        }
        tauri::RunEvent::Exit => {
            usage::stop_usage_collector(app_handle);
            let gui_config_state = app_handle.state::<GuiConfigState>();
            match gui_config_state.snapshot() {
                Ok(config) => {
                    if let Err(error) =
                        tauri::async_runtime::block_on(remove_managed_claude_model_aliases(&config))
                    {
                        eprintln!("退出时清理 EasyCLIProxyAPI 托管的 Claude 模型别名失败: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("退出时读取 GUI 配置失败，无法清理 Claude 模型别名: {error}");
                }
            }
            if let Ok(home) = app_handle.path().home_dir() {
                let _guard = AGENT_CONFIG_FILE_LOCK.lock();
                restore_all_agent_session_configurations(&home);
            }
            let process_state = app_handle.state::<CoreProcessState>();
            shutdown_managed_core(process_state.inner(), gui_config_state.inner());
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests;
