#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod usage;

use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    fs::File,
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, UdpSocket},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tar::Archive;
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;
use zip::ZipArchive;

const RELEASE_PAGE_URL: &str = "https://github.com/router-for-me/CLIProxyAPI/releases/latest";
const RELEASE_ATOM_URL: &str = "https://github.com/router-for-me/CLIProxyAPI/releases.atom";
const RELEASE_DOWNLOAD_PREFIX: &str =
    "https://github.com/router-for-me/CLIProxyAPI/releases/download/";
const CORE_INSTALL_PROGRESS_EVENT: &str = "core-install-progress";
const CORE_METADATA_FILE: &str = "cpa-gui-meta.json";
const CORE_CONFIG_FILE: &str = "config.yaml";
const CORE_EXAMPLE_CONFIG_FILE: &str = "config.example.yaml";
const CORE_VERSION_FILE: &str = "core-version.txt";
const CORE_CHECKSUMS_FILE: &str = "checksums.txt";
const GUI_CONFIG_FILE: &str = "config.toml";
const LEGACY_GUI_CONFIG_FILE: &str = "cpa-gui.yaml";
const OAUTH_DIR_NAME: &str = "oauth";
const DEFAULT_API_KEY: &str = "123456";
const DEFAULT_API_KEY_REMARK: &str = "内置密钥";
const DEFAULT_MANAGEMENT_SECRET_KEY: &str = "123456";
const MANAGED_AGENT_PROVIDER_ID: &str = "cpa-gui";
const CODEX_MODEL_CATALOG_FILE: &str = "cpa-gui-model-catalog.json";
const DEFAULT_CODEX_CONTEXT_WINDOW: u64 = 128_000;
const CLAUDE_DESKTOP_PROFILE_ID: &str = "00000000-0000-4000-8000-000000831700";
const AGENT_MODIFICATION_STATE_VERSION: u8 = 1;
const AGENT_PHASE_APPLYING: &str = "applying";
const AGENT_PHASE_ACTIVE: &str = "active";
const AGENT_PHASE_RESTORING: &str = "restoring";
const AGENT_PHASE_RECOVERY: &str = "recovery";
const AGENT_MODIFICATION_STATE_CONFLICT: &str = "conflict";
const USER_AGENT: &str = concat!(
    "CPA-GUI/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/router-for-me/CLIProxyAPI)"
);
static CORE_CONFIG_FILE_LOCK: Mutex<()> = Mutex::new(());
static AGENT_CONFIG_FILE_LOCK: Mutex<()> = Mutex::new(());

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
struct CoreProcessState {
    child: Mutex<Option<Child>>,
    #[cfg(windows)]
    job: Mutex<Option<isize>>,
}

struct GuiConfigState {
    inner: Mutex<GuiConfigFile>,
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

#[derive(Serialize)]
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
    port: u16,
    allow_lan: bool,
    run_on_startup: bool,
    auth_dir: String,
    #[serde(deserialize_with = "deserialize_gui_api_keys")]
    api_keys: Vec<GuiApiKeyEntry>,
    management_secret_key: String,
    plugins_enabled: bool,
    routing_strategy: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct GuiApiKeyEntry {
    key: String,
    #[serde(default)]
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
            port: 8317,
            allow_lan: false,
            run_on_startup: false,
            auth_dir: env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(|parent| parent.join(OAUTH_DIR_NAME)))
                .map(|path| path_to_string(&path))
                .unwrap_or_else(|| OAUTH_DIR_NAME.to_string()),
            api_keys: vec![built_in_api_key_entry()],
            // Keep plaintext here for management API auth. Core hashes the
            // value written into config.yaml on startup.
            management_secret_key: DEFAULT_MANAGEMENT_SECRET_KEY.to_string(),
            plugins_enabled: false,
            routing_strategy: "round-robin".to_string(),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
struct GuiConfigPresence {
    auth_dir: Option<String>,
    api_keys: Option<Vec<GuiApiKeyInput>>,
    management_secret_key: Option<String>,
    plugins_enabled: Option<bool>,
    routing_strategy: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GuiSettings {
    port: u16,
    allow_lan: bool,
    run_on_startup: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfigStatus {
    id: String,
    name: String,
    supported_platform: bool,
    installed: bool,
    executable_path: Option<String>,
    launch_targets: Vec<AgentLaunchTarget>,
    version: Option<String>,
    config_paths: Vec<String>,
    config_exists: bool,
    config_valid: bool,
    configured: bool,
    current_model: Option<String>,
    modification_enabled: bool,
    modification_state: String,
    backup_available: bool,
    applied_model: Option<String>,
    warnings: Vec<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentLaunchTarget {
    id: String,
    label: String,
    detail: String,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentModelOption {
    name: String,
    alias: Option<String>,
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct CodexModelCatalogSpec {
    id: String,
    display_name: String,
    description: String,
    context_window: u64,
    reasoning_levels: Vec<String>,
    supports_parallel_tool_calls: bool,
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
    warnings: Vec<String>,
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

type FileSnapshot = (PathBuf, Option<Vec<u8>>);
type AgentRecordExtension = (AgentModificationRecord, Vec<FileSnapshot>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuiNetworkSettings {
    port: u16,
    allow_lan: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreConfigSettings {
    api_keys: Vec<String>,
    management_secret_configured: bool,
    plugins_enabled: bool,
    routing_strategy: String,
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
    built_in: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreConfigView {
    api_keys: Vec<CoreApiKeyView>,
    management_secret_configured: bool,
    plugins_enabled: bool,
    routing_strategy: String,
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

    fn update_network(&self, port: u16, allow_lan: bool) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.port = port;
            config.allow_lan = allow_lan;
            Ok(())
        })
    }

    fn set_run_on_startup(&self, run_on_startup: bool) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.run_on_startup = run_on_startup;
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
            config.plugins_enabled = settings.plugins_enabled;
            config.routing_strategy = settings.routing_strategy.clone();
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
        }
    }
}

impl From<&GuiConfigFile> for CoreConfigSettings {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            api_keys: gui_api_key_values(&config.api_keys),
            management_secret_configured: !config.management_secret_key.is_empty(),
            plugins_enabled: config.plugins_enabled,
            routing_strategy: config.routing_strategy.clone(),
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
                    built_in: entry.key == DEFAULT_API_KEY,
                })
                .collect(),
            management_secret_configured: !config.management_secret_key.is_empty(),
            plugins_enabled: config.plugins_enabled,
            routing_strategy: config.routing_strategy.clone(),
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
    size: Option<u64>,
    digest: Option<String>,
}

#[tauri::command]
fn health_check() -> &'static str {
    "CPA GUI Rust backend is ready"
}

#[tauri::command]
fn detect_core_platform() -> Result<CorePlatform, String> {
    current_core_platform()
}

#[tauri::command]
fn get_core_status(
    process_state: tauri::State<'_, CoreProcessState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreStatus, String> {
    let config = gui_config_state.snapshot()?;
    current_core_status(Some(process_state.inner()), Some(config.port))
}

#[tauri::command]
fn get_gui_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<GuiSettings, String> {
    let config = gui_config_state.snapshot()?;
    Ok(GuiSettings::from(&config))
}

#[tauri::command]
fn get_agent_config_statuses(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<AgentConfigStatus>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let port = gui_config_state.snapshot()?.port;
    Ok([
        AgentClient::ClaudeCode,
        AgentClient::ClaudeDesktop,
        AgentClient::Codex,
        AgentClient::OpenCode,
        AgentClient::OpenClaw,
        AgentClient::Hermes,
    ]
    .into_iter()
    .map(|client| inspect_agent_config(client, &home, port))
    .collect())
}

#[tauri::command]
async fn get_agent_models(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<AgentModelOption>, String> {
    let config = gui_config_state.snapshot()?;
    fetch_agent_models(config.port).await
}

#[tauri::command]
async fn get_thinking_aliases(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let content = fetch_management_config_yaml(&config).await?;
    thinking_aliases_from_yaml(&content)
}

#[tauri::command]
async fn get_thinking_alias_sources(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ThinkingAliasSource>, String> {
    let config = gui_config_state.snapshot()?;
    let content = fetch_management_config_yaml(&config).await?;
    let definitions = fetch_codex_model_definitions(&config)
        .await
        .unwrap_or_default();
    Ok(resolved_thinking_alias_sources(&content, &definitions)?
        .into_iter()
        .map(|resolved| resolved.source)
        .collect())
}

#[tauri::command]
async fn create_thinking_alias(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    source_id: String,
    alias: String,
    effort: String,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let source_id = source_id.trim().to_string();
    if source_id.is_empty() {
        return Err("请先选择原模型".to_string());
    }
    let alias = validate_thinking_alias_model_id(&alias, "别名模型")?;
    let effort = validate_thinking_alias_effort(&effort)?;
    let content = fetch_management_config_yaml(&config).await?;
    let definitions = fetch_codex_model_definitions(&config)
        .await
        .unwrap_or_default();
    let sources = resolved_thinking_alias_sources(&content, &definitions)?;
    let source = sources
        .iter()
        .find(|source| source.source.id == source_id)
        .cloned()
        .ok_or_else(|| "原模型来源已经变化，请刷新后重新选择".to_string())?;
    if source.source.model.eq_ignore_ascii_case(&alias) {
        return Err("别名模型不能和原模型相同".to_string());
    }

    let available_models = fetch_agent_models(config.port).await?;
    if available_models
        .iter()
        .any(|model| model.name.eq_ignore_ascii_case(&alias))
    {
        return Err(format!("{alias} 已经是实际模型 ID，不能再作为别名"));
    }
    let document = serde_norway::from_str::<serde_norway::Value>(&content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    if configured_model_alias_exists(root, &alias) {
        return Err(format!("别名模型 {alias} 已存在"));
    }

    let updated = add_thinking_alias_to_yaml(&content, &source, &alias, &effort)?;
    put_management_config_yaml(&config, &updated).await?;
    thinking_aliases_from_yaml(&updated)
}

#[tauri::command]
async fn delete_thinking_alias(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    alias: String,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let config = gui_config_state.snapshot()?;
    let alias = validate_thinking_alias_model_id(&alias, "别名模型")?;
    let content = fetch_management_config_yaml(&config).await?;
    let updated = remove_thinking_alias_from_yaml(&content, &alias)?;
    put_management_config_yaml(&config, &updated).await?;
    thinking_aliases_from_yaml(&updated)
}

async fn fetch_agent_models(port: u16) -> Result<Vec<AgentModelOption>, String> {
    if port == 0 {
        return Err("内核端口无效".to_string());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("创建模型列表客户端失败: {error}"))?;
    let base_url = format!("http://127.0.0.1:{port}");
    let endpoints = [
        format!("{base_url}/v1/models"),
        format!("{base_url}/models"),
    ];

    for (index, endpoint) in endpoints.iter().enumerate() {
        let response = client
            .get(endpoint)
            .bearer_auth(DEFAULT_API_KEY)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send()
            .await
            .map_err(|error| format!("请求本机模型列表失败: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("读取本机模型列表失败: {error}"))?;
        if status.is_success() {
            let payload = serde_json::from_str::<serde_json::Value>(&body).map_err(|error| {
                format!(
                    "解析本机模型列表失败: {error}; body={}",
                    truncate_for_error(&body)
                )
            })?;
            return parse_agent_model_options(&payload);
        }

        let can_try_legacy_path = index == 0 && matches!(status.as_u16(), 404 | 405);
        if !can_try_legacy_path {
            return Err(format_agent_models_error(status.as_u16(), &body));
        }
    }

    Err("本机内核不支持模型列表接口".to_string())
}

#[tauri::command]
async fn set_agent_config_enabled(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
    model: String,
    enabled: bool,
    force_restore: bool,
) -> Result<AgentConfigActionResult, String> {
    let client = AgentClient::parse(&client)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let config = gui_config_state.snapshot()?;
    let port = config.port;

    if enabled {
        validate_agent_can_enable(client, &home, port)?;
        let available_models = fetch_agent_models(port).await?;
        let model =
            resolve_available_agent_model(&available_models, &validate_agent_model(&model)?)?;
        let codex_models = if client == AgentClient::Codex {
            Some(fetch_codex_model_catalog_specs(&config, &available_models).await)
        } else {
            None
        };
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "智能体配置文件锁已损坏".to_string())?;
        enable_agent_modification(
            client,
            &home,
            port,
            &model,
            &available_models,
            codex_models.as_deref(),
        )
    } else {
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "智能体配置文件锁已损坏".to_string())?;
        disable_agent_modification(client, &home, port, force_restore)
    }
}

#[tauri::command]
async fn update_agent_config(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
    model: String,
) -> Result<AgentConfigActionResult, String> {
    let client = AgentClient::parse(&client)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let config = gui_config_state.snapshot()?;
    let port = config.port;
    let available_models = fetch_agent_models(port).await?;
    let model = resolve_available_agent_model(&available_models, &validate_agent_model(&model)?)?;
    let codex_models = if client == AgentClient::Codex {
        Some(fetch_codex_model_catalog_specs(&config, &available_models).await)
    } else {
        None
    };
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "智能体配置文件锁已损坏".to_string())?;
    update_agent_modification(
        client,
        &home,
        port,
        &model,
        &available_models,
        codex_models.as_deref(),
    )
}

#[tauri::command]
fn launch_agent(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
    target: Option<String>,
) -> Result<(), String> {
    let client = AgentClient::parse(&client)?;
    if !client.supported_platform() {
        return Err(format!("当前平台不支持启动 {}", client.name()));
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let port = gui_config_state.snapshot()?.port;
    let status = inspect_agent_config(client, &home, port);
    validate_agent_launch_modification(
        client,
        status.modification_enabled,
        &status.modification_state,
    )?;
    let requested_target = target
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if client == AgentClient::Codex && requested_target != Some("cli") {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(codex_cli) = find_agent_executable(AgentClient::Codex, &home) {
            if launch_codex_app_via_cli(&codex_cli, &home).is_ok() {
                return Ok(());
            }
        }
        if let Some(app_target) = find_codex_app_target(&home) {
            return launch_codex_app(&app_target);
        }
        if requested_target == Some("app") {
            return Err("未检测到 Codex App，请重新检测或改用 Codex CLI".to_string());
        }
    }
    if requested_target.is_some_and(|value| value != "cli" && value != "app") {
        return Err("不支持的智能体启动方式".to_string());
    }
    if client == AgentClient::ClaudeDesktop && requested_target == Some("cli") {
        return Err("Claude Desktop 不支持 CLI 启动方式".to_string());
    }
    if client != AgentClient::Codex
        && client != AgentClient::ClaudeDesktop
        && requested_target == Some("app")
    {
        return Err(format!("{} 不支持桌面 App 启动方式", client.name()));
    }

    let executable = find_agent_executable(client, &home)
        .ok_or_else(|| format!("未找到 {} 的可执行文件", client.name()))?;
    if client == AgentClient::ClaudeDesktop {
        launch_desktop_agent(&executable, client.name())
    } else {
        launch_cli_agent(&executable, client.name(), &home)
    }
}

fn validate_agent_launch_modification(
    client: AgentClient,
    enabled: bool,
    state: &str,
) -> Result<(), String> {
    if enabled && state == AGENT_PHASE_ACTIVE {
        return Ok(());
    }
    Err(format!(
        "请先为 {} 开启“修改智能体配置”，确保 CPA 配置生效后再启动",
        client.name()
    ))
}

fn validate_agent_can_enable(client: AgentClient, home: &Path, port: u16) -> Result<(), String> {
    if !client.supported_platform() {
        return Err(format!(
            "{} 当前仅支持在 Windows、macOS 和 Linux 上配置",
            client.name()
        ));
    }
    let detection = inspect_agent_config(client, home, port);
    if !detection.installed {
        return Err(format!("未检测到 {}，请先安装后再配置", client.name()));
    }
    if !detection.config_valid {
        return Err(detection
            .error
            .unwrap_or_else(|| "原配置格式异常，请先修复后再开启".to_string()));
    }
    Ok(())
}

fn validate_agent_model(value: &str) -> Result<String, String> {
    let model = value.trim();
    if model.is_empty() {
        return Err("请先选择模型".to_string());
    }
    if model.len() > 240 || model.chars().any(char::is_control) {
        return Err("模型名称格式无效".to_string());
    }
    Ok(model.to_string())
}

fn resolve_available_agent_model(
    models: &[AgentModelOption],
    model: &str,
) -> Result<String, String> {
    if models.is_empty() {
        return Err("当前内核没有可选模型，无法修改智能体配置".to_string());
    }
    models
        .iter()
        .find(|available| available.name.eq_ignore_ascii_case(model))
        .map(|available| available.name.clone())
        .ok_or_else(|| format!("模型 {model} 不在当前可用模型列表中，请刷新后重新选择"))
}

fn parse_agent_model_options(payload: &serde_json::Value) -> Result<Vec<AgentModelOption>, String> {
    let source = payload
        .as_array()
        .or_else(|| payload.get("data").and_then(serde_json::Value::as_array))
        .or_else(|| payload.get("models").and_then(serde_json::Value::as_array))
        .ok_or_else(|| "本机模型列表响应缺少 data 或 models 数组".to_string())?;
    let mut models = Vec::new();
    for item in source {
        let name = if let Some(name) = item.as_str() {
            name.trim().to_string()
        } else {
            ["id", "name", "model", "value"]
                .into_iter()
                .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
                .unwrap_or_default()
                .trim()
                .to_string()
        };
        if name.is_empty()
            || models
                .iter()
                .any(|model: &AgentModelOption| model.name.eq_ignore_ascii_case(&name))
        {
            continue;
        }
        let alias = ["alias", "display_name", "displayName"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case(&name))
            .map(str::to_string);
        models.push(AgentModelOption { name, alias });
    }
    Ok(models)
}

async fn fetch_codex_model_catalog_specs(
    config: &GuiConfigFile,
    models: &[AgentModelOption],
) -> Vec<CodexModelCatalogSpec> {
    let definitions = match fetch_codex_model_definitions(config).await {
        Ok(definitions) => definitions,
        Err(error) => {
            eprintln!("读取 CPA Codex 模型定义失败，将使用默认模型参数: {error}");
            Vec::new()
        }
    };
    merge_codex_model_catalog_specs(models, &definitions)
}

fn merge_codex_model_catalog_specs(
    models: &[AgentModelOption],
    definitions: &[CodexModelDefinition],
) -> Vec<CodexModelCatalogSpec> {
    models
        .iter()
        .map(|model| {
            let definition = definitions
                .iter()
                .find(|definition| definition.id.eq_ignore_ascii_case(&model.name));
            let reasoning_levels = definition
                .map(|definition| definition.reasoning_levels.clone())
                .filter(|levels| !levels.is_empty())
                .unwrap_or_else(default_codex_reasoning_levels);
            CodexModelCatalogSpec {
                id: model.name.clone(),
                display_name: definition
                    .and_then(|definition| definition.display_name.clone())
                    .or_else(|| model.alias.clone())
                    .unwrap_or_else(|| model.name.clone()),
                description: definition
                    .and_then(|definition| definition.description.clone())
                    .unwrap_or_else(|| format!("由 CPA 提供的模型 {}", model.name)),
                context_window: definition
                    .and_then(|definition| definition.context_window)
                    .unwrap_or(DEFAULT_CODEX_CONTEXT_WINDOW),
                reasoning_levels,
                supports_parallel_tool_calls: definition
                    .and_then(|definition| definition.supports_tools)
                    .unwrap_or(true),
            }
        })
        .collect()
}

fn default_codex_reasoning_levels() -> Vec<String> {
    ["low", "medium", "high", "xhigh"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn parse_codex_model_definitions(
    payload: &serde_json::Value,
) -> Result<Vec<CodexModelDefinition>, String> {
    let source = payload
        .as_array()
        .or_else(|| payload.get("models").and_then(serde_json::Value::as_array))
        .or_else(|| payload.get("data").and_then(serde_json::Value::as_array))
        .ok_or_else(|| "Codex 模型定义响应缺少 models 或 data 数组".to_string())?;
    let mut definitions = Vec::new();
    for item in source {
        let id = ["id", "ID", "name"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(id) = id else {
            continue;
        };
        if definitions
            .iter()
            .any(|definition: &CodexModelDefinition| definition.id.eq_ignore_ascii_case(id))
        {
            continue;
        }
        let display_name = ["display_name", "displayName", "DisplayName"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let description = item
            .get("description")
            .or_else(|| item.get("Description"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let context_window = ["context_length", "contextLength", "ContextLength"]
            .into_iter()
            .find_map(|key| item.get(key).and_then(json_positive_u64));
        let reasoning_levels = item
            .get("thinking")
            .or_else(|| item.get("Thinking"))
            .and_then(|thinking| thinking.get("levels").or_else(|| thinking.get("Levels")))
            .and_then(serde_json::Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .map(str::to_ascii_lowercase)
                    .filter(|level| is_codex_reasoning_level(level))
                    .fold(Vec::new(), |mut result, level| {
                        if !result.contains(&level) {
                            result.push(level);
                        }
                        result
                    })
            })
            .unwrap_or_default();
        let supports_tools = item
            .get("supported_parameters")
            .or_else(|| item.get("supportedParameters"))
            .or_else(|| item.get("SupportedParameters"))
            .and_then(serde_json::Value::as_array)
            .map(|parameters| {
                parameters.iter().any(|parameter| {
                    parameter
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case("tools"))
                })
            });
        definitions.push(CodexModelDefinition {
            id: id.to_string(),
            display_name,
            description,
            context_window,
            reasoning_levels,
            supports_tools,
        });
    }
    Ok(definitions)
}

fn json_positive_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn is_codex_reasoning_level(value: &str) -> bool {
    matches!(
        value,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
}

fn format_agent_models_error(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        let message = value
            .get("error")
            .and_then(|error| {
                error
                    .as_str()
                    .or_else(|| error.get("message").and_then(serde_json::Value::as_str))
            })
            .or_else(|| value.get("message").and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|message| !message.is_empty());
        if let Some(message) = message {
            return format!("获取本机模型列表失败 ({status}): {message}");
        }
    }
    let body = body.trim();
    if body.is_empty() {
        format!("获取本机模型列表失败 ({status})")
    } else {
        format!(
            "获取本机模型列表失败 ({status}): {}",
            truncate_for_error(body)
        )
    }
}

fn agent_config_paths(client: AgentClient, home: &Path) -> Vec<PathBuf> {
    match client {
        AgentClient::ClaudeCode => {
            let directory = home.join(".claude");
            let settings = directory.join("settings.json");
            let legacy = directory.join("claude.json");
            let settings_state_exists = agent_state_path(std::slice::from_ref(&settings))
                .map(|path| path.exists())
                .unwrap_or(false);
            let legacy_state_exists = agent_state_path(std::slice::from_ref(&legacy))
                .map(|path| path.exists())
                .unwrap_or(false);
            vec![if settings_state_exists {
                settings
            } else if legacy_state_exists || (!settings.exists() && legacy.exists()) {
                legacy
            } else {
                settings
            }]
        }
        AgentClient::ClaudeDesktop => claude_desktop_config_paths(home),
        AgentClient::Codex => vec![home.join(".codex/config.toml")],
        AgentClient::OpenCode => vec![home.join(".config/opencode/opencode.json")],
        AgentClient::OpenClaw => vec![home.join(".openclaw/openclaw.json")],
        AgentClient::Hermes => vec![hermes_agent_config_path(home)],
    }
}

fn codex_model_catalog_path(home: &Path) -> PathBuf {
    home.join(".codex").join(CODEX_MODEL_CATALOG_FILE)
}

fn expected_agent_record_paths(client: AgentClient, paths: &[PathBuf]) -> Vec<PathBuf> {
    if client == AgentClient::Codex && paths.len() == 1 {
        let mut expected = paths.to_vec();
        expected.push(paths[0].with_file_name(CODEX_MODEL_CATALOG_FILE));
        expected
    } else {
        paths.to_vec()
    }
}

fn claude_desktop_config_paths(_home: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    let (normal, threep) = {
        let support = _home.join("Library/Application Support");
        (support.join("Claude"), support.join("Claude-3p"))
    };
    #[cfg(target_os = "windows")]
    let (normal, threep) = {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| _home.join("AppData/Local"));
        (local.join("Claude"), local.join("Claude-3p"))
    };
    #[cfg(target_os = "linux")]
    let (normal, threep) = {
        let config_home = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| _home.join(".config"));
        (config_home.join("Claude"), config_home.join("Claude-3p"))
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return Vec::new();

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let library = threep.join("configLibrary");
        vec![
            normal.join("claude_desktop_config.json"),
            threep.join("claude_desktop_config.json"),
            library.join(format!("{CLAUDE_DESKTOP_PROFILE_ID}.json")),
            library.join("_meta.json"),
        ]
    }
}

fn hermes_agent_config_path(home: &Path) -> PathBuf {
    if let Some(directory) = env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return directory.join("config.yaml");
    }
    #[cfg(target_os = "windows")]
    {
        return env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("hermes/config.yaml");
    }
    #[cfg(not(target_os = "windows"))]
    home.join(".hermes/config.yaml")
}

fn inspect_agent_config(client: AgentClient, home: &Path, port: u16) -> AgentConfigStatus {
    let paths = agent_config_paths(client, home);
    let config_exists = paths.iter().any(|path| path.is_file());
    let result = inspect_agent_managed_config(client, &paths, port);
    let (configured, current_model, config_valid, error) = match result {
        Ok((configured, model)) => (configured, model, true, None),
        Err(error) => (false, None, false, Some(error)),
    };
    let launch_targets = agent_launch_targets(client, home);
    let executable = find_agent_executable(client, home);
    let installed = !launch_targets.is_empty() || config_exists;
    let version = executable
        .as_deref()
        .filter(|_| client != AgentClient::ClaudeDesktop)
        .and_then(read_agent_version);
    let mut warnings = Vec::new();
    if !client.supported_platform() {
        warnings.push("当前平台不支持 Claude Desktop 3P 配置".to_string());
    } else if launch_targets.is_empty() && config_exists {
        warnings.push("只检测到配置文件，未在 PATH 中找到客户端命令".to_string());
    }
    if let Some(message) = error.as_ref() {
        warnings.push(message.clone());
    }
    let modification = inspect_agent_modification(
        client,
        home,
        port,
        agent_has_managed_marker(client, &paths).unwrap_or(configured),
        current_model.as_deref(),
    );
    warnings.extend(modification.warnings.iter().cloned());

    AgentConfigStatus {
        id: client.id().to_string(),
        name: client.name().to_string(),
        supported_platform: client.supported_platform(),
        installed,
        executable_path: launch_targets.first().map(|target| target.detail.clone()),
        launch_targets,
        version,
        config_paths: paths.iter().map(|path| path_to_string(path)).collect(),
        config_exists,
        config_valid,
        configured,
        current_model,
        modification_enabled: modification.enabled,
        modification_state: modification.state,
        backup_available: modification.backup_available,
        applied_model: modification.applied_model,
        warnings,
        error,
    }
}

fn inspect_agent_managed_config(
    client: AgentClient,
    paths: &[PathBuf],
    port: u16,
) -> Result<(bool, Option<String>), String> {
    match client {
        AgentClient::ClaudeCode => inspect_claude_agent_config(&paths[0], port),
        AgentClient::ClaudeDesktop if client.supported_platform() => {
            inspect_claude_desktop_agent_config(paths, port)
        }
        AgentClient::ClaudeDesktop => Ok((false, None)),
        AgentClient::Codex => inspect_codex_agent_config(&paths[0], port),
        AgentClient::OpenCode => inspect_opencode_agent_config(&paths[0], port),
        AgentClient::OpenClaw => inspect_openclaw_agent_config(&paths[0], port),
        AgentClient::Hermes => inspect_hermes_agent_config(&paths[0], port),
    }
}

fn agent_has_managed_marker(client: AgentClient, paths: &[PathBuf]) -> Result<bool, String> {
    match client {
        AgentClient::ClaudeCode => {
            if !paths[0].is_file() {
                return Ok(false);
            }
            let root = read_agent_json_or_empty(&paths[0], "Claude Code 配置")?;
            let env = root.get("env");
            Ok(env
                .and_then(|value| value.get("ANTHROPIC_BASE_URL"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| {
                    value.starts_with("http://127.0.0.1:") || value.starts_with("http://localhost:")
                })
                && env
                    .and_then(|value| value.get("ANTHROPIC_AUTH_TOKEN"))
                    .and_then(serde_json::Value::as_str)
                    == Some(DEFAULT_API_KEY))
        }
        AgentClient::ClaudeDesktop => {
            if paths.len() != 4 || !paths[3].is_file() {
                return Ok(false);
            }
            let meta = read_agent_json_or_empty(&paths[3], "Claude Desktop 配置索引")?;
            Ok(meta.get("appliedId").and_then(serde_json::Value::as_str)
                == Some(CLAUDE_DESKTOP_PROFILE_ID))
        }
        AgentClient::Codex => {
            if !paths[0].is_file() {
                return Ok(false);
            }
            let root: toml::Value = toml::from_str(
                &fs::read_to_string(&paths[0])
                    .map_err(|error| format!("读取 Codex 配置失败: {error}"))?,
            )
            .map_err(|error| format!("解析 Codex 配置失败: {error}"))?;
            Ok(root.get("model_provider").and_then(toml::Value::as_str)
                == Some(MANAGED_AGENT_PROVIDER_ID))
        }
        AgentClient::OpenCode => {
            if !paths[0].is_file() {
                return Ok(false);
            }
            let root = read_agent_json_or_empty(&paths[0], "OpenCode 配置")?;
            Ok(root
                .get("provider")
                .and_then(|value| value.get(MANAGED_AGENT_PROVIDER_ID))
                .is_some())
        }
        AgentClient::OpenClaw => {
            if !paths[0].is_file() {
                return Ok(false);
            }
            let root: serde_json::Value = json5::from_str(
                &fs::read_to_string(&paths[0])
                    .map_err(|error| format!("读取 OpenClaw 配置失败: {error}"))?,
            )
            .map_err(|error| format!("解析 OpenClaw 配置失败: {error}"))?;
            Ok(root
                .get("models")
                .and_then(|value| value.get("providers"))
                .and_then(|value| value.get(MANAGED_AGENT_PROVIDER_ID))
                .is_some())
        }
        AgentClient::Hermes => {
            if !paths[0].is_file() {
                return Ok(false);
            }
            let root: serde_yaml::Value = serde_yaml::from_str(
                &fs::read_to_string(&paths[0])
                    .map_err(|error| format!("读取 Hermes 配置失败: {error}"))?,
            )
            .map_err(|error| format!("解析 Hermes 配置失败: {error}"))?;
            Ok(root
                .get("custom_providers")
                .and_then(serde_yaml::Value::as_sequence)
                .is_some_and(|providers| {
                    providers.iter().any(|provider| {
                        provider.get("name").and_then(serde_yaml::Value::as_str)
                            == Some(MANAGED_AGENT_PROVIDER_ID)
                    })
                }))
        }
    }
}

fn agent_launch_targets(client: AgentClient, home: &Path) -> Vec<AgentLaunchTarget> {
    let mut targets = Vec::new();
    if client == AgentClient::Codex {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(executable) = find_agent_executable(AgentClient::Codex, home) {
            targets.push(AgentLaunchTarget {
                id: "app".to_string(),
                label: "Codex App".to_string(),
                detail: format!("{} app", path_to_string(&executable)),
            });
        } else if let Some(target) = find_codex_app_target(home) {
            targets.push(AgentLaunchTarget {
                id: "app".to_string(),
                label: "Codex App".to_string(),
                detail: codex_app_target_detail(&target),
            });
        }
    }

    if let Some(executable) = find_agent_executable(client, home) {
        targets.push(AgentLaunchTarget {
            id: if client == AgentClient::ClaudeDesktop {
                "app".to_string()
            } else {
                "cli".to_string()
            },
            label: match client {
                AgentClient::ClaudeDesktop => "Claude Desktop".to_string(),
                AgentClient::Codex => "Codex CLI".to_string(),
                _ => client.name().to_string(),
            },
            detail: path_to_string(&executable),
        });
    }
    targets
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn codex_app_target_detail(target: &CodexAppTarget) -> String {
    match target {
        CodexAppTarget::Application(path) => path_to_string(path),
        #[cfg(target_os = "windows")]
        CodexAppTarget::WindowsAppId(app_id) => format!("Microsoft Store · {app_id}"),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn launch_codex_app_via_cli(executable: &Path, home: &Path) -> Result<(), String> {
    let mut command = Command::new(executable);
    command
        .arg("app")
        .arg(home)
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("通过 Codex CLI 启动 Codex App 失败: {error}"))
}

fn find_codex_app_target(home: &Path) -> Option<CodexAppTarget> {
    #[cfg(target_os = "macos")]
    {
        return [PathBuf::from("/Applications"), home.join("Applications")]
            .into_iter()
            .flat_map(|directory| {
                [
                    "Codex.app",
                    "OpenAI Codex.app",
                    "OpenAI.Codex.app",
                    "ChatGPT.app",
                ]
                .into_iter()
                .map(move |name| directory.join(name))
            })
            .find(|path| path.is_dir())
            .map(CodexAppTarget::Application);
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(executable) = find_windows_codex_app_executable(home) {
            return Some(CodexAppTarget::Application(executable));
        }
        return find_windows_codex_app_id().map(CodexAppTarget::WindowsAppId);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = home;
        None
    }
}

#[cfg(target_os = "windows")]
fn find_windows_codex_app_executable(home: &Path) -> Option<PathBuf> {
    let local = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Local"));
    [
        local.join("OpenAI/Codex/bin"),
        local.join("OpenAI/Codex"),
        local.join("Programs/OpenAI/Codex"),
        local.join("Programs/Codex"),
    ]
    .into_iter()
    .flat_map(|directory| {
        ["Codex.exe", "ChatGPT.exe"]
            .into_iter()
            .map(move |name| directory.join(name))
    })
    .find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn find_windows_codex_app_id() -> Option<String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$app = Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex*!App' -or $_.AppID -like 'OpenAI.CodexBeta*!App' } | Select-Object -First 1 -ExpandProperty AppID; if ($app) { Write-Output $app }",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

#[cfg(target_os = "macos")]
fn launch_codex_app(target: &CodexAppTarget) -> Result<(), String> {
    let CodexAppTarget::Application(application) = target;
    Command::new("open")
        .arg(application)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动 Codex App 失败: {error}"))
}

#[cfg(target_os = "windows")]
fn launch_codex_app(target: &CodexAppTarget) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = match target {
        CodexAppTarget::Application(executable) => Command::new(executable),
        CodexAppTarget::WindowsAppId(app_id) => {
            let mut command = Command::new("explorer.exe");
            command.arg(format!("shell:AppsFolder\\{app_id}"));
            command
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动 Codex App 失败: {error}"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn launch_codex_app(_target: &CodexAppTarget) -> Result<(), String> {
    Err("当前平台不支持 Codex App".to_string())
}

fn find_agent_executable(client: AgentClient, home: &Path) -> Option<PathBuf> {
    if client == AgentClient::ClaudeDesktop {
        return find_claude_desktop_executable(home);
    }
    for directory in agent_executable_directories(home) {
        for name in client.executable_names() {
            #[cfg(target_os = "windows")]
            let candidates = [
                directory.join(format!("{name}.exe")),
                directory.join(format!("{name}.cmd")),
                directory.join(format!("{name}.bat")),
                directory.join(name),
            ];
            #[cfg(not(target_os = "windows"))]
            let candidates = [directory.join(name)];
            if let Some(candidate) = candidates.into_iter().find(|path| path.is_file()) {
                return Some(candidate);
            }
        }
    }
    None
}

fn agent_executable_directories(home: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut push = |path: PathBuf| {
        if !path.as_os_str().is_empty() && !directories.iter().any(|item| item == &path) {
            directories.push(path);
        }
    };

    if let Some(path) = env::var_os("PATH") {
        env::split_paths(&path).for_each(&mut push);
    }
    [
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
        home.join(".cargo/bin"),
        home.join("bin"),
    ]
    .into_iter()
    .for_each(&mut push);
    for variable in ["PNPM_HOME", "BUN_INSTALL", "NPM_CONFIG_PREFIX"] {
        if let Some(path) = env::var_os(variable) {
            let path = PathBuf::from(path);
            push(
                if variable == "BUN_INSTALL" || variable == "NPM_CONFIG_PREFIX" {
                    path.join("bin")
                } else {
                    path
                },
            );
        }
    }
    for root in [
        home.join(".nvm/versions/node"),
        home.join(".local/state/fnm_multishells"),
    ] {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                push(entry.path().join("bin"));
            }
        }
    }

    #[cfg(unix)]
    for path in ["/usr/local/bin", "/usr/bin", "/bin"] {
        push(PathBuf::from(path));
    }

    #[cfg(target_os = "macos")]
    push(PathBuf::from("/opt/homebrew/bin"));

    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = env::var_os("APPDATA") {
            push(PathBuf::from(app_data).join("npm"));
        }
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            push(PathBuf::from(local_app_data).join("Microsoft/WindowsApps"));
        }
    }

    directories
}

fn find_claude_desktop_executable(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return [
            PathBuf::from("/Applications/Claude.app/Contents/MacOS/Claude"),
            home.join("Applications/Claude.app/Contents/MacOS/Claude"),
        ]
        .into_iter()
        .find(|path| path.is_file());
    }
    #[cfg(target_os = "windows")]
    {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"));
        return [
            local.join("Programs/Claude/Claude.exe"),
            local.join("Claude/Claude.exe"),
        ]
        .into_iter()
        .find(|path| path.is_file());
    }
    #[cfg(target_os = "linux")]
    {
        let mut candidates = agent_executable_directories(home)
            .into_iter()
            .map(|directory| directory.join("claude-desktop"))
            .collect::<Vec<_>>();
        candidates.extend([
            PathBuf::from("/opt/Claude/claude-desktop"),
            PathBuf::from("/opt/Claude/claude"),
            PathBuf::from("/opt/claude-desktop/claude-desktop"),
        ]);
        candidates.into_iter().find(|path| path.is_file())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = home;
        None
    }
}

fn read_agent_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    let text = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr)
    } else {
        String::from_utf8_lossy(&output.stdout)
    };
    text.lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
}

fn launch_desktop_agent(executable: &Path, label: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let application = executable
            .ancestors()
            .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
            .unwrap_or(executable);
        let mut command = Command::new("open");
        command.arg(application);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = Command::new(executable);

    #[cfg(target_os = "linux")]
    let mut command = Command::new(executable);

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (executable, label);
        return Err("当前平台不支持桌面智能体".to_string());
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动 {label} 失败: {error}"))
}

#[cfg(target_os = "macos")]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "macos")]
fn launch_cli_agent(
    executable: &Path,
    label: &str,
    working_directory: &Path,
) -> Result<(), String> {
    let command_line = format!(
        "cd {} && exec {}",
        shell_single_quote(&path_to_string(working_directory)),
        shell_single_quote(&path_to_string(executable))
    );
    let apple_script_command = command_line.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{apple_script_command}\"\nend tell"
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("启动 {label} 终端失败: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "启动 {label} 终端失败{}",
        if message.is_empty() {
            String::new()
        } else {
            format!(": {message}")
        }
    ))
}

#[cfg(target_os = "linux")]
fn launch_cli_agent(
    executable: &Path,
    label: &str,
    working_directory: &Path,
) -> Result<(), String> {
    let terminals: &[(&str, &[&str])] = &[
        ("x-terminal-emulator", &["-e"]),
        ("gnome-terminal", &["--"]),
        ("konsole", &["-e"]),
        ("xfce4-terminal", &["-e"]),
        ("mate-terminal", &["--"]),
        ("kitty", &["-e"]),
        ("alacritty", &["-e"]),
        ("ghostty", &["-e"]),
        ("xterm", &["-e"]),
    ];
    let path = env::var_os("PATH").unwrap_or_default();
    let mut last_error = None;
    for (terminal, arguments) in terminals {
        let available = env::split_paths(&path).any(|directory| directory.join(terminal).is_file());
        if !available {
            continue;
        }
        match Command::new(terminal)
            .args(*arguments)
            .arg(executable)
            .current_dir(working_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    Err(match last_error {
        Some(error) => format!("启动 {label} 失败: {error}"),
        None => format!("启动 {label} 失败：未找到可用的终端程序"),
    })
}

#[cfg(target_os = "windows")]
fn launch_cli_agent(
    executable: &Path,
    label: &str,
    working_directory: &Path,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let command_line = format!("\"{}\"", path_to_string(executable).replace('"', "\"\""));
    Command::new("cmd")
        .args(["/D", "/K"])
        .arg(command_line)
        .current_dir(working_directory)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动 {label} 失败: {error}"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn launch_cli_agent(
    _executable: &Path,
    label: &str,
    _working_directory: &Path,
) -> Result<(), String> {
    Err(format!("当前平台不支持启动 {label}"))
}

fn inspect_claude_agent_config(path: &Path, port: u16) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(path).map_err(|error| format!("读取 Claude Code 配置失败: {error}"))?,
    )
    .map_err(|error| format!("解析 Claude Code 配置失败: {error}"))?;
    let env = root.get("env").and_then(serde_json::Value::as_object);
    let expected_base = format!("http://127.0.0.1:{port}");
    let configured = env
        .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        == Some(expected_base.as_str())
        && env
            .and_then(|env| env.get("ANTHROPIC_AUTH_TOKEN"))
            .and_then(serde_json::Value::as_str)
            == Some(DEFAULT_API_KEY);
    let model = env
        .and_then(|env| env.get("ANTHROPIC_MODEL"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| root.get("model").and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((configured, model))
}

fn inspect_claude_desktop_agent_config(
    paths: &[PathBuf],
    port: u16,
) -> Result<(bool, Option<String>), String> {
    if paths.len() != 4 || !paths.iter().any(|path| path.is_file()) {
        return Ok((false, None));
    }
    let normal = read_agent_json_or_empty(&paths[0], "Claude Desktop 主配置")?;
    let threep = read_agent_json_or_empty(&paths[1], "Claude Desktop 3P 配置")?;
    let profile = read_agent_json_or_empty(&paths[2], "Claude Desktop 网关配置")?;
    let meta = read_agent_json_or_empty(&paths[3], "Claude Desktop 配置索引")?;
    let expected_base = format!("http://127.0.0.1:{port}");
    let configured = normal
        .get("deploymentMode")
        .and_then(serde_json::Value::as_str)
        == Some("3p")
        && threep
            .get("deploymentMode")
            .and_then(serde_json::Value::as_str)
            == Some("3p")
        && profile
            .get("inferenceGatewayBaseUrl")
            .and_then(serde_json::Value::as_str)
            == Some(expected_base.as_str())
        && profile
            .get("inferenceGatewayApiKey")
            .and_then(serde_json::Value::as_str)
            == Some(DEFAULT_API_KEY)
        && meta.get("appliedId").and_then(serde_json::Value::as_str)
            == Some(CLAUDE_DESKTOP_PROFILE_ID);
    let model = profile
        .get("inferenceModels")
        .and_then(serde_json::Value::as_array)
        .and_then(|models| models.first())
        .and_then(|model| {
            model
                .as_str()
                .or_else(|| model.get("name").and_then(serde_json::Value::as_str))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((configured, model))
}

fn read_agent_json_or_empty(path: &Path, label: &str) -> Result<serde_json::Value, String> {
    if !path.is_file() {
        return Ok(serde_json::json!({}));
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取 {label} 失败: {error}"))?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| format!("解析 {label} 失败: {error}"))?;
    if !value.is_object() {
        return Err(format!("{label} 根节点必须是对象"));
    }
    Ok(value)
}

fn inspect_codex_agent_config(path: &Path, port: u16) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: toml::Value = toml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("读取 Codex 配置失败: {error}"))?,
    )
    .map_err(|error| format!("解析 Codex 配置失败: {error}"))?;
    let expected_base = format!("http://127.0.0.1:{port}/v1");
    let provider = root
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(toml::Value::as_table);
    let configured = root.get("model_provider").and_then(toml::Value::as_str)
        == Some(MANAGED_AGENT_PROVIDER_ID)
        && provider
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str)
            == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("experimental_bearer_token"))
            .and_then(toml::Value::as_str)
            == Some(DEFAULT_API_KEY)
        && provider
            .and_then(|provider| provider.get("wire_api"))
            .and_then(toml::Value::as_str)
            == Some("responses");
    let model = root
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((configured, model))
}

fn inspect_opencode_agent_config(path: &Path, port: u16) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(path).map_err(|error| format!("读取 OpenCode 配置失败: {error}"))?,
    )
    .map_err(|error| format!("解析 OpenCode 配置失败: {error}"))?;
    let provider = root
        .get("provider")
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID));
    let expected_base = format!("http://127.0.0.1:{port}/v1");
    let configured = provider
        .and_then(|provider| provider.get("options"))
        .and_then(|options| options.get("baseURL"))
        .and_then(serde_json::Value::as_str)
        == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("options"))
            .and_then(|options| options.get("apiKey"))
            .and_then(serde_json::Value::as_str)
            == Some(DEFAULT_API_KEY);
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let model = root
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.strip_prefix(&prefix).unwrap_or(value))
        .map(str::to_string);
    Ok((configured, model))
}

fn inspect_openclaw_agent_config(path: &Path, port: u16) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取 OpenClaw 配置失败: {error}"))?;
    let root: serde_json::Value = json5::from_str(&content)
        .map_err(|error| format!("解析 OpenClaw JSON5 配置失败: {error}"))?;
    let provider = root
        .get("models")
        .and_then(|models| models.get("providers"))
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID));
    let expected_base = format!("http://127.0.0.1:{port}/v1");
    let configured = provider
        .and_then(|provider| provider.get("baseUrl"))
        .and_then(serde_json::Value::as_str)
        == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("apiKey"))
            .and_then(serde_json::Value::as_str)
            == Some(DEFAULT_API_KEY);
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let model = root
        .get("agents")
        .and_then(|agents| agents.get("defaults"))
        .and_then(|defaults| defaults.get("model"))
        .and_then(|model| model.get("primary"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.strip_prefix(&prefix).unwrap_or(value))
        .map(str::to_string);
    Ok((configured, model))
}

fn inspect_hermes_agent_config(path: &Path, port: u16) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: serde_yaml::Value = serde_yaml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("读取 Hermes 配置失败: {error}"))?,
    )
    .map_err(|error| format!("解析 Hermes YAML 配置失败: {error}"))?;
    let provider = root
        .get("custom_providers")
        .and_then(serde_yaml::Value::as_sequence)
        .and_then(|providers| {
            providers.iter().find(|provider| {
                provider.get("name").and_then(serde_yaml::Value::as_str)
                    == Some(MANAGED_AGENT_PROVIDER_ID)
            })
        });
    let expected_base = format!("http://127.0.0.1:{port}/v1");
    let configured = provider
        .and_then(|provider| provider.get("base_url"))
        .and_then(serde_yaml::Value::as_str)
        == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("api_key"))
            .and_then(serde_yaml::Value::as_str)
            == Some(DEFAULT_API_KEY)
        && root
            .get("model")
            .and_then(|model| model.get("provider"))
            .and_then(serde_yaml::Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID);
    let model = root
        .get("model")
        .and_then(|model| model.get("default"))
        .and_then(serde_yaml::Value::as_str)
        .or_else(|| provider.and_then(|provider| provider.get("model")?.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((configured, model))
}

fn build_agent_updates(
    client: AgentClient,
    home: &Path,
    port: u16,
    model: &str,
    models: &[AgentModelOption],
    codex_models: Option<&[CodexModelCatalogSpec]>,
) -> Result<Vec<AgentFileUpdate>, String> {
    let paths = agent_config_paths(client, home);
    let root_base = format!("http://127.0.0.1:{port}");
    let openai_base = format!("{root_base}/v1");
    match client {
        AgentClient::ClaudeCode => {
            let before = read_optional_text(&paths[0])?;
            let after =
                build_claude_agent_config(before.as_deref(), &root_base, DEFAULT_API_KEY, model)?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::ClaudeDesktop => {
            if paths.len() != 4 {
                return Err("Claude Desktop 当前平台配置路径不可用".to_string());
            }
            let normal_before = read_optional_text(&paths[0])?;
            let threep_before = read_optional_text(&paths[1])?;
            let profile_before = read_optional_text(&paths[2])?;
            let meta_before = read_optional_text(&paths[3])?;
            Ok(vec![
                AgentFileUpdate {
                    path: paths[0].clone(),
                    after: build_claude_desktop_deployment_config(normal_before.as_deref())?,
                },
                AgentFileUpdate {
                    path: paths[1].clone(),
                    after: build_claude_desktop_deployment_config(threep_before.as_deref())?,
                },
                AgentFileUpdate {
                    path: paths[2].clone(),
                    after: build_claude_desktop_profile(
                        profile_before.as_deref(),
                        &root_base,
                        DEFAULT_API_KEY,
                        model,
                        models,
                    )?,
                },
                AgentFileUpdate {
                    path: paths[3].clone(),
                    after: build_claude_desktop_meta(meta_before.as_deref())?,
                },
            ])
        }
        AgentClient::Codex => {
            let before = read_optional_text(&paths[0])?;
            let after =
                build_codex_agent_config(before.as_deref(), &openai_base, DEFAULT_API_KEY, model)?;
            let mut updates = vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }];
            if let Some(models) = codex_models {
                updates.push(AgentFileUpdate {
                    path: codex_model_catalog_path(home),
                    after: build_codex_model_catalog(models)?,
                });
            }
            Ok(updates)
        }
        AgentClient::OpenCode => {
            let before = read_optional_text(&paths[0])?;
            let after = build_opencode_agent_config(
                before.as_deref(),
                &openai_base,
                DEFAULT_API_KEY,
                model,
                models,
            )?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::OpenClaw => {
            let before = read_optional_text(&paths[0])?;
            let after = build_openclaw_agent_config(
                before.as_deref(),
                &openai_base,
                DEFAULT_API_KEY,
                model,
                models,
            )?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::Hermes => {
            let before = read_optional_text(&paths[0])?;
            let after = build_hermes_agent_config(
                before.as_deref(),
                &openai_base,
                DEFAULT_API_KEY,
                model,
                models,
            )?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
    }
}

fn read_optional_text(path: &Path) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("读取配置失败 {}: {error}", path_to_string(path)))
}

fn build_claude_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<String, String> {
    let mut root = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_json::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("Claude Code settings.json 格式无效: {error}"))?,
        None => serde_json::json!({}),
    };
    let root = root
        .as_object_mut()
        .ok_or_else(|| "Claude Code settings.json 根节点必须是对象".to_string())?;
    let env = root
        .entry("env".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "Claude Code env 必须是对象".to_string())?;
    for (key, value) in [
        ("ANTHROPIC_BASE_URL", base_url),
        ("ANTHROPIC_API_KEY", api_key),
        ("ANTHROPIC_AUTH_TOKEN", api_key),
        ("ANTHROPIC_MODEL", model),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", model),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", model),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", model),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL", model),
    ] {
        env.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
    root.insert(
        "model".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    let mut rendered = serde_json::to_string_pretty(&serde_json::Value::Object(root.clone()))
        .map_err(|error| format!("生成 Claude Code 配置失败: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

fn parse_agent_json_object(
    existing: Option<&str>,
    label: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let value = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_json::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("{label} 格式无效: {error}"))?,
        None => serde_json::json!({}),
    };
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{label} 根节点必须是对象"))
}

fn render_agent_json(
    root: serde_json::Map<String, serde_json::Value>,
    label: &str,
) -> Result<String, String> {
    let mut rendered = serde_json::to_string_pretty(&serde_json::Value::Object(root))
        .map_err(|error| format!("生成 {label} 失败: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

fn ordered_agent_models(
    models: &[AgentModelOption],
    selected_model: &str,
) -> Vec<AgentModelOption> {
    let mut ordered = Vec::with_capacity(models.len().max(1));
    if let Some(selected) = models
        .iter()
        .find(|model| model.name.eq_ignore_ascii_case(selected_model))
    {
        ordered.push(selected.clone());
    } else {
        ordered.push(AgentModelOption {
            name: selected_model.to_string(),
            alias: None,
        });
    }
    for model in models {
        if ordered
            .iter()
            .any(|existing| existing.name.eq_ignore_ascii_case(&model.name))
        {
            continue;
        }
        ordered.push(model.clone());
    }
    ordered
}

fn build_claude_desktop_deployment_config(existing: Option<&str>) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "Claude Desktop 配置")?;
    root.insert("deploymentMode".to_string(), serde_json::json!("3p"));
    render_agent_json(root, "Claude Desktop 配置")
}

fn build_claude_desktop_profile(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "Claude Desktop 网关配置")?;
    root.insert(
        "coworkEgressAllowedHosts".to_string(),
        serde_json::json!(["*"]),
    );
    root.insert(
        "disableDeploymentModeChooser".to_string(),
        serde_json::json!(true),
    );
    root.insert(
        "inferenceGatewayApiKey".to_string(),
        serde_json::json!(api_key),
    );
    root.insert(
        "inferenceGatewayAuthScheme".to_string(),
        serde_json::json!("bearer"),
    );
    root.insert(
        "inferenceGatewayBaseUrl".to_string(),
        serde_json::json!(base_url),
    );
    root.insert(
        "inferenceProvider".to_string(),
        serde_json::json!("gateway"),
    );
    let inference_models = ordered_agent_models(available_models, model)
        .into_iter()
        .map(|model| match model.alias {
            Some(alias) => serde_json::json!({
                "name": model.name,
                "labelOverride": alias,
            }),
            None => serde_json::json!(model.name),
        })
        .collect::<Vec<_>>();
    root.insert(
        "inferenceModels".to_string(),
        serde_json::Value::Array(inference_models),
    );
    render_agent_json(root, "Claude Desktop 网关配置")
}

fn build_claude_desktop_meta(existing: Option<&str>) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "Claude Desktop 配置索引")?;
    let entries = root
        .entry("entries".to_string())
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| "Claude Desktop 配置索引 entries 必须是数组".to_string())?;
    entries.retain(|entry| {
        entry.get("id").and_then(serde_json::Value::as_str) != Some(CLAUDE_DESKTOP_PROFILE_ID)
    });
    entries.push(serde_json::json!({
        "id": CLAUDE_DESKTOP_PROFILE_ID,
        "name": "Easy CLIProxyAPI"
    }));
    root.insert(
        "appliedId".to_string(),
        serde_json::json!(CLAUDE_DESKTOP_PROFILE_ID),
    );
    render_agent_json(root, "Claude Desktop 配置索引")
}

fn build_codex_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<String, String> {
    use toml_edit::{value, Document, Item, Table};

    let mut document = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value
            .parse::<Document>()
            .map_err(|error| format!("Codex config.toml 格式无效: {error}"))?,
        None => Document::new(),
    };
    document["model_provider"] = value(MANAGED_AGENT_PROVIDER_ID);
    document["model"] = value(model);
    document["model_catalog_json"] = value(CODEX_MODEL_CATALOG_FILE);
    if !document.contains_key("model_providers") {
        document["model_providers"] = Item::Table(Table::new());
    }
    let providers = document["model_providers"]
        .as_table_mut()
        .ok_or_else(|| "Codex model_providers 必须是 TOML 表".to_string())?;
    let mut provider = providers
        .get(MANAGED_AGENT_PROVIDER_ID)
        .and_then(Item::as_table)
        .cloned()
        .unwrap_or_default();
    provider["name"] = value("Easy CLIProxyAPI");
    provider["base_url"] = value(base_url);
    provider["wire_api"] = value("responses");
    provider["experimental_bearer_token"] = value(api_key);
    providers.insert(MANAGED_AGENT_PROVIDER_ID, Item::Table(provider));
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("验证 Codex 配置失败: {error}"))?;
    Ok(rendered)
}

fn build_codex_model_catalog(models: &[CodexModelCatalogSpec]) -> Result<String, String> {
    if models.is_empty() {
        return Err("当前 CPA 没有可写入 Codex 的模型".to_string());
    }
    let entries = models
        .iter()
        .enumerate()
        .map(|(index, model)| {
            let reasoning_levels = if model.reasoning_levels.is_empty() {
                default_codex_reasoning_levels()
            } else {
                model.reasoning_levels.clone()
            };
            let default_reasoning_level = if reasoning_levels.iter().any(|level| level == "medium") {
                "medium".to_string()
            } else {
                reasoning_levels
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "medium".to_string())
            };
            let supported_reasoning_levels = reasoning_levels
                .iter()
                .map(|level| {
                    serde_json::json!({
                        "effort": level,
                        "description": codex_reasoning_level_description(level),
                    })
                })
                .collect::<Vec<_>>();
            serde_json::json!({
                "slug": model.id,
                "display_name": model.display_name,
                "description": model.description,
                "base_instructions": "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
                "default_reasoning_level": default_reasoning_level,
                "supported_reasoning_levels": supported_reasoning_levels,
                "shell_type": "shell_command",
                "visibility": "list",
                "supported_in_api": true,
                "priority": index + 1,
                "include_skills_usage_instructions": true,
                "supports_reasoning_summaries": true,
                "default_reasoning_summary": "none",
                "support_verbosity": false,
                "truncation_policy": {
                    "mode": "bytes",
                    "limit": 10_000,
                },
                "supports_parallel_tool_calls": model.supports_parallel_tool_calls,
                "supports_image_detail_original": false,
                "context_window": model.context_window,
                "max_context_window": model.context_window,
                "effective_context_window_percent": 95,
                "experimental_supported_tools": [],
                "input_modalities": ["text", "image"],
                "supports_search_tool": false,
            })
        })
        .collect::<Vec<_>>();
    let mut rendered = serde_json::to_string_pretty(&serde_json::json!({ "models": entries }))
        .map_err(|error| format!("生成 Codex 模型目录失败: {error}"))?;
    rendered.push('\n');
    serde_json::from_str::<serde_json::Value>(&rendered)
        .map_err(|error| format!("验证 Codex 模型目录失败: {error}"))?;
    Ok(rendered)
}

fn codex_reasoning_level_description(level: &str) -> &'static str {
    match level {
        "none" => "关闭推理",
        "minimal" => "最少推理",
        "low" => "较低推理强度",
        "medium" => "平衡速度与推理深度",
        "high" => "较高推理强度",
        "xhigh" => "超高推理强度",
        "max" => "最大推理强度",
        "ultra" => "最高推理与自动任务委派",
        _ => "模型支持的推理强度",
    }
}

fn build_opencode_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "OpenCode opencode.json")?;
    root.entry("$schema".to_string())
        .or_insert_with(|| serde_json::json!("https://opencode.ai/config.json"));
    let providers = root
        .entry("provider".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "OpenCode provider 必须是对象".to_string())?;
    let models = ordered_agent_models(available_models, model)
        .into_iter()
        .map(|model| {
            let display_name = model.alias.as_deref().unwrap_or(&model.name).to_string();
            (model.name, serde_json::json!({ "name": display_name }))
        })
        .collect::<serde_json::Map<_, _>>();
    providers.insert(
        MANAGED_AGENT_PROVIDER_ID.to_string(),
        serde_json::json!({
            "npm": "@ai-sdk/openai-compatible",
            "name": "Easy CLIProxyAPI",
            "options": {
                "baseURL": base_url,
                "apiKey": api_key
            },
            "models": models
        }),
    );
    root.insert(
        "model".to_string(),
        serde_json::json!(format!("{MANAGED_AGENT_PROVIDER_ID}/{model}")),
    );
    render_agent_json(root, "OpenCode 配置")
}

fn build_openclaw_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let mut root = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => json5::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("OpenClaw openclaw.json 格式无效: {error}"))?,
        None => serde_json::json!({}),
    };
    let root = root
        .as_object_mut()
        .ok_or_else(|| "OpenClaw openclaw.json 根节点必须是对象".to_string())?;
    let ordered_models = ordered_agent_models(available_models, model);
    let models = root
        .entry("models".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "OpenClaw models 必须是对象".to_string())?;
    models
        .entry("mode".to_string())
        .or_insert_with(|| serde_json::json!("merge"));
    let providers = models
        .entry("providers".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "OpenClaw models.providers 必须是对象".to_string())?;
    providers.insert(
        MANAGED_AGENT_PROVIDER_ID.to_string(),
        serde_json::json!({
            "baseUrl": base_url,
            "apiKey": api_key,
            "api": "openai-completions",
            "models": ordered_models.iter().map(|model| serde_json::json!({
                "id": model.name.clone(),
                "name": model.alias.as_deref().unwrap_or(&model.name),
            })).collect::<Vec<_>>()
        }),
    );
    let agents = root
        .entry("agents".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "OpenClaw agents 必须是对象".to_string())?;
    let defaults = agents
        .entry("defaults".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "OpenClaw agents.defaults 必须是对象".to_string())?;
    let default_model = defaults
        .entry("model".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "OpenClaw agents.defaults.model 必须是对象".to_string())?;
    default_model.insert(
        "primary".to_string(),
        serde_json::json!(format!("{MANAGED_AGENT_PROVIDER_ID}/{model}")),
    );
    let model_catalog = defaults
        .entry("models".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "OpenClaw agents.defaults.models 必须是对象".to_string())?;
    let managed_prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    model_catalog.retain(|name, _| !name.starts_with(&managed_prefix));
    for model in &ordered_models {
        let name = format!("{MANAGED_AGENT_PROVIDER_ID}/{}", model.name);
        let value = model
            .alias
            .as_deref()
            .map(|alias| serde_json::json!({ "alias": alias }))
            .unwrap_or_else(|| serde_json::json!({}));
        model_catalog.insert(name, value);
    }
    render_agent_json(root.clone(), "OpenClaw 配置")
}

fn build_hermes_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let mut root = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_yaml::from_str::<serde_yaml::Value>(value)
            .map_err(|error| format!("Hermes config.yaml 格式无效: {error}"))?,
        None => serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
    };
    let mapping = root
        .as_mapping_mut()
        .ok_or_else(|| "Hermes config.yaml 根节点必须是映射".to_string())?;
    let providers = mapping
        .entry(serde_yaml::Value::String("custom_providers".to_string()))
        .or_insert_with(|| serde_yaml::Value::Sequence(Vec::new()))
        .as_sequence_mut()
        .ok_or_else(|| "Hermes custom_providers 必须是数组".to_string())?;
    providers.retain(|provider| {
        provider.get("name").and_then(serde_yaml::Value::as_str) != Some(MANAGED_AGENT_PROVIDER_ID)
    });
    let provider_models = ordered_agent_models(available_models, model)
        .into_iter()
        .map(|model| (model.name, serde_json::json!({})))
        .collect::<serde_json::Map<_, _>>();
    providers.push(
        serde_yaml::to_value(serde_json::json!({
            "name": MANAGED_AGENT_PROVIDER_ID,
            "base_url": base_url,
            "api_key": api_key,
            "api_mode": "chat_completions",
            "model": model,
            "models": provider_models
        }))
        .map_err(|error| format!("生成 Hermes provider 失败: {error}"))?,
    );
    let model_config = mapping
        .entry(serde_yaml::Value::String("model".to_string()))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "Hermes model 必须是映射".to_string())?;
    model_config.insert(
        serde_yaml::Value::String("default".to_string()),
        serde_yaml::Value::String(model.to_string()),
    );
    model_config.insert(
        serde_yaml::Value::String("provider".to_string()),
        serde_yaml::Value::String(MANAGED_AGENT_PROVIDER_ID.to_string()),
    );
    let rendered =
        serde_yaml::to_string(&root).map_err(|error| format!("生成 Hermes 配置失败: {error}"))?;
    serde_yaml::from_str::<serde_yaml::Value>(&rendered)
        .map_err(|error| format!("验证 Hermes 配置失败: {error}"))?;
    Ok(rendered)
}

fn agent_backup_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("智能体配置文件名无效: {}", path_to_string(path)))?;
    Ok(path.with_file_name(format!("{file_name}.cpa-gui.backup")))
}

fn agent_state_path(paths: &[PathBuf]) -> Result<PathBuf, String> {
    let primary = paths
        .first()
        .ok_or_else(|| "当前平台没有可用的智能体配置路径".to_string())?;
    let file_name = primary
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("智能体配置文件名无效: {}", path_to_string(primary)))?;
    Ok(primary.with_file_name(format!("{file_name}.cpa-gui.state.json")))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_agent_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("读取智能体配置失败 {}: {error}", path_to_string(path)))
}

fn write_agent_state(path: &Path, record: &AgentModificationRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("创建智能体状态目录失败 {}: {error}", path_to_string(parent))
        })?;
    }
    let mut content = serde_json::to_string_pretty(record)
        .map_err(|error| format!("生成智能体备份状态失败: {error}"))?;
    content.push('\n');
    write_yaml_if_changed(path, &content).map(|_| ())
}

fn validate_agent_record(
    client: AgentClient,
    paths: &[PathBuf],
    record: &AgentModificationRecord,
) -> Result<(), String> {
    if record.version != AGENT_MODIFICATION_STATE_VERSION || record.client != client.id() {
        return Err("智能体备份状态版本或客户端不匹配".to_string());
    }
    if ![
        AGENT_PHASE_APPLYING,
        AGENT_PHASE_ACTIVE,
        AGENT_PHASE_RESTORING,
        AGENT_PHASE_RECOVERY,
    ]
    .contains(&record.phase.as_str())
    {
        return Err("智能体备份状态阶段无效".to_string());
    }
    let expected_paths = expected_agent_record_paths(client, paths);
    let record_paths = record
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let valid_paths = record_paths.as_slice() == paths
        || (client == AgentClient::Codex && record_paths == expected_paths);
    if !valid_paths {
        return Err("智能体备份状态文件数量或路径不匹配".to_string());
    }
    for file in &record.files {
        if file.backup_path != agent_backup_path(&file.path)? {
            return Err("智能体备份状态包含非预期路径".to_string());
        }
    }
    Ok(())
}

fn load_agent_record(
    client: AgentClient,
    paths: &[PathBuf],
) -> Result<Option<AgentModificationRecord>, String> {
    let state_path = agent_state_path(paths)?;
    if !state_path.is_file() {
        return Ok(None);
    }
    let record: AgentModificationRecord = serde_json::from_str(
        &fs::read_to_string(&state_path)
            .map_err(|error| format!("读取智能体备份状态失败: {error}"))?,
    )
    .map_err(|error| format!("解析智能体备份状态失败: {error}"))?;
    validate_agent_record(client, paths, &record)?;
    Ok(Some(record))
}

fn record_backup_available(record: &AgentModificationRecord) -> bool {
    record
        .files
        .iter()
        .all(|file| !file.existed_before || file.backup_path.is_file())
}

fn record_conflict_files(record: &AgentModificationRecord) -> Result<Vec<String>, String> {
    let mut conflicts = Vec::new();
    for file in &record.files {
        let current = read_agent_bytes(&file.path)?;
        let matches =
            current.as_deref().map(sha256_bytes).as_deref() == Some(file.managed_sha256.as_str());
        if !matches {
            conflicts.push(path_to_string(&file.path));
        }
    }
    Ok(conflicts)
}

fn record_restore_conflict_files(record: &AgentModificationRecord) -> Result<Vec<String>, String> {
    let mut conflicts = Vec::new();
    for file in &record.files {
        let current = read_agent_bytes(&file.path)?;
        let matches_managed =
            current.as_deref().map(sha256_bytes).as_deref() == Some(file.managed_sha256.as_str());
        let matches_original = if file.existed_before {
            current.as_deref().map(sha256_bytes) == file.original_sha256
        } else {
            current.is_none()
        };
        if !matches_managed && !matches_original {
            conflicts.push(path_to_string(&file.path));
        }
    }
    Ok(conflicts)
}

fn record_matches_original(record: &AgentModificationRecord) -> Result<bool, String> {
    for file in &record.files {
        let current = read_agent_bytes(&file.path)?;
        let matches = if file.existed_before {
            current.as_deref().map(sha256_bytes) == file.original_sha256
        } else {
            current.is_none()
        };
        if !matches {
            return Ok(false);
        }
    }
    Ok(true)
}

fn inspect_agent_modification(
    client: AgentClient,
    home: &Path,
    port: u16,
    configured: bool,
    current_model: Option<&str>,
) -> AgentModificationInspection {
    let paths = agent_config_paths(client, home);
    let state_path = match agent_state_path(&paths) {
        Ok(path) => path,
        Err(_) => {
            return AgentModificationInspection {
                enabled: false,
                state: "inactive".to_string(),
                backup_available: false,
                applied_model: current_model.map(str::to_string),
                warnings: Vec::new(),
            }
        }
    };

    if state_path.is_file() {
        return match load_agent_record(client, &paths) {
            Ok(Some(record)) => {
                let backup_available = record_backup_available(&record);
                let conflicts = record_conflict_files(&record);
                let state = if record.phase != AGENT_PHASE_ACTIVE {
                    "recovery"
                } else {
                    match conflicts {
                        Ok(conflicts) if conflicts.is_empty() => "active",
                        Ok(_) => AGENT_MODIFICATION_STATE_CONFLICT,
                        Err(_) => "recovery",
                    }
                };
                let mut warnings = Vec::new();
                if !backup_available {
                    warnings.push("原配置备份不完整，恢复前请勿删除剩余备份文件".to_string());
                }
                if state == AGENT_MODIFICATION_STATE_CONFLICT {
                    warnings.push("配置已被其他程序修改，关闭接管时需要确认强制恢复".to_string());
                } else if state == "recovery" {
                    warnings.push("上次配置操作未完整结束，可关闭开关恢复原配置".to_string());
                }
                AgentModificationInspection {
                    enabled: true,
                    state: state.to_string(),
                    backup_available,
                    applied_model: Some(record.model),
                    warnings,
                }
            }
            Ok(None) => AgentModificationInspection {
                enabled: false,
                state: "inactive".to_string(),
                backup_available: false,
                applied_model: current_model.map(str::to_string),
                warnings: Vec::new(),
            },
            Err(error) => AgentModificationInspection {
                enabled: true,
                state: "recovery".to_string(),
                backup_available: expected_agent_record_paths(client, &paths)
                    .iter()
                    .filter_map(|path| agent_backup_path(path).ok())
                    .any(|path| path.is_file()),
                applied_model: current_model.map(str::to_string),
                warnings: vec![error],
            },
        };
    }

    if configured {
        if let Some(model) = current_model {
            match build_legacy_agent_record(client, home, port, model) {
                Ok(Some(record)) => {
                    return AgentModificationInspection {
                        enabled: true,
                        state: "active".to_string(),
                        backup_available: true,
                        applied_model: Some(record.model),
                        warnings: vec![
                            "检测到旧版 CPA 配置和备份，可关闭开关恢复原配置".to_string()
                        ],
                    }
                }
                Ok(None) => {
                    return AgentModificationInspection {
                        enabled: false,
                        state: "inactive".to_string(),
                        backup_available: false,
                        applied_model: current_model.map(str::to_string),
                        warnings: vec!["检测到 CPA 配置，但缺少可安全恢复的原始备份".to_string()],
                    }
                }
                Err(error) => {
                    return AgentModificationInspection {
                        enabled: false,
                        state: "inactive".to_string(),
                        backup_available: false,
                        applied_model: current_model.map(str::to_string),
                        warnings: vec![error],
                    }
                }
            }
        }
    }

    AgentModificationInspection {
        enabled: false,
        state: "inactive".to_string(),
        backup_available: false,
        applied_model: current_model.map(str::to_string),
        warnings: Vec::new(),
    }
}

fn fresh_agent_contents(
    client: AgentClient,
    port: u16,
    model: &str,
) -> Result<Vec<String>, String> {
    let root_base = format!("http://127.0.0.1:{port}");
    let openai_base = format!("{root_base}/v1");
    let models = [AgentModelOption {
        name: model.to_string(),
        alias: None,
    }];
    match client {
        AgentClient::ClaudeCode => Ok(vec![build_claude_agent_config(
            None,
            &root_base,
            DEFAULT_API_KEY,
            model,
        )?]),
        AgentClient::ClaudeDesktop => Ok(vec![
            build_claude_desktop_deployment_config(None)?,
            build_claude_desktop_deployment_config(None)?,
            build_claude_desktop_profile(None, &root_base, DEFAULT_API_KEY, model, &models)?,
            build_claude_desktop_meta(None)?,
        ]),
        AgentClient::Codex => Ok(vec![build_codex_agent_config(
            None,
            &openai_base,
            DEFAULT_API_KEY,
            model,
        )?]),
        AgentClient::OpenCode => Ok(vec![build_opencode_agent_config(
            None,
            &openai_base,
            DEFAULT_API_KEY,
            model,
            &models,
        )?]),
        AgentClient::OpenClaw => Ok(vec![build_openclaw_agent_config(
            None,
            &openai_base,
            DEFAULT_API_KEY,
            model,
            &models,
        )?]),
        AgentClient::Hermes => Ok(vec![build_hermes_agent_config(
            None,
            &openai_base,
            DEFAULT_API_KEY,
            model,
            &models,
        )?]),
    }
}

fn agent_contents_equal(client: AgentClient, actual: &str, expected: &str) -> bool {
    match client {
        AgentClient::Codex => {
            normalize_codex_config_for_legacy_compare(actual)
                == normalize_codex_config_for_legacy_compare(expected)
        }
        AgentClient::OpenClaw => {
            json5::from_str::<serde_json::Value>(actual).ok()
                == json5::from_str::<serde_json::Value>(expected).ok()
        }
        AgentClient::Hermes => {
            serde_yaml::from_str::<serde_yaml::Value>(actual).ok()
                == serde_yaml::from_str::<serde_yaml::Value>(expected).ok()
        }
        _ => {
            serde_json::from_str::<serde_json::Value>(actual).ok()
                == serde_json::from_str::<serde_json::Value>(expected).ok()
        }
    }
}

fn normalize_codex_config_for_legacy_compare(content: &str) -> Option<toml::Value> {
    let mut value = toml::from_str::<toml::Value>(content).ok()?;
    if value
        .get("model_catalog_json")
        .and_then(toml::Value::as_str)
        == Some(CODEX_MODEL_CATALOG_FILE)
    {
        value.as_table_mut()?.remove("model_catalog_json");
    }
    Some(value)
}

fn build_legacy_agent_record(
    client: AgentClient,
    home: &Path,
    port: u16,
    model: &str,
) -> Result<Option<AgentModificationRecord>, String> {
    let paths = agent_config_paths(client, home);
    let generated = fresh_agent_contents(client, port, model)?;
    if generated.len() != paths.len() {
        return Ok(None);
    }
    let mut files = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let current = read_agent_bytes(path)?;
        let Some(current) = current else {
            return Ok(None);
        };
        let backup_path = agent_backup_path(path)?;
        let (existed_before, original_sha256) = if backup_path.is_file() {
            let backup = fs::read(&backup_path).map_err(|error| {
                format!(
                    "读取旧版智能体备份失败 {}: {error}",
                    path_to_string(&backup_path)
                )
            })?;
            (true, Some(sha256_bytes(&backup)))
        } else {
            let actual = String::from_utf8(current.clone())
                .map_err(|_| format!("智能体配置不是 UTF-8 文本: {}", path_to_string(path)))?;
            if !agent_contents_equal(client, &actual, &generated[index]) {
                return Ok(None);
            }
            (false, None)
        };
        files.push(AgentModificationFile {
            path: path.clone(),
            backup_path,
            existed_before,
            original_sha256,
            managed_sha256: sha256_bytes(&current),
        });
    }
    Ok(Some(AgentModificationRecord {
        version: AGENT_MODIFICATION_STATE_VERSION,
        client: client.id().to_string(),
        phase: AGENT_PHASE_ACTIVE.to_string(),
        model: model.to_string(),
        files,
    }))
}

fn prepare_agent_record(
    client: AgentClient,
    paths: &[PathBuf],
    model: &str,
    updates: &[AgentFileUpdate],
) -> Result<AgentModificationRecord, String> {
    if paths.len() != updates.len() {
        return Err("智能体配置更新文件数量不匹配".to_string());
    }
    let mut prepared = Vec::new();
    for (path, update) in paths.iter().zip(updates) {
        if path != &update.path {
            return Err("智能体配置更新路径不匹配".to_string());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("创建智能体配置目录失败 {}: {error}", path_to_string(parent))
            })?;
        }
        let backup_path = agent_backup_path(path)?;
        let current = read_agent_bytes(path)?;
        let previous_backup = if backup_path.exists() {
            if !backup_path.is_file() {
                return Err(format!(
                    "智能体备份路径不是文件: {}",
                    path_to_string(&backup_path)
                ));
            }
            Some(fs::read(&backup_path).map_err(|error| {
                format!(
                    "读取原有智能体备份失败 {}: {error}",
                    path_to_string(&backup_path)
                )
            })?)
        } else {
            None
        };

        prepared.push((
            path.clone(),
            backup_path,
            current,
            previous_backup,
            sha256_bytes(update.after.as_bytes()),
        ));
    }

    let backup_snapshots = prepared
        .iter()
        .map(|(_, backup_path, _, previous_backup, _)| {
            (backup_path.clone(), previous_backup.clone())
        })
        .collect::<Vec<_>>();
    let mut files = Vec::new();
    for (path, backup_path, current, _, managed_sha256) in prepared {
        let backup_result = if let Some(current) = current.as_deref() {
            write_bytes_atomically(&backup_path, current).and_then(|_| {
                let copied = fs::read(&backup_path).map_err(|error| {
                    format!(
                        "校验智能体备份失败 {}: {error}",
                        path_to_string(&backup_path)
                    )
                })?;
                if sha256_bytes(&copied) != sha256_bytes(current) {
                    return Err(format!("智能体备份校验失败: {}", path_to_string(&path)));
                }
                Ok(())
            })
        } else if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| {
                format!(
                    "清理旧智能体备份失败 {}: {error}",
                    path_to_string(&backup_path)
                )
            })
        } else {
            Ok(())
        };
        if let Err(error) = backup_result {
            let rollback = restore_snapshots(&backup_snapshots);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}；恢复原有备份失败: {rollback_error}"),
            });
        }

        let existed_before = current.is_some();
        let original_sha256 = current.as_deref().map(sha256_bytes);
        files.push(AgentModificationFile {
            path,
            backup_path,
            existed_before,
            original_sha256,
            managed_sha256,
        });
    }
    Ok(AgentModificationRecord {
        version: AGENT_MODIFICATION_STATE_VERSION,
        client: client.id().to_string(),
        phase: AGENT_PHASE_APPLYING.to_string(),
        model: model.to_string(),
        files,
    })
}

fn extend_agent_record_for_updates(
    record: &AgentModificationRecord,
    updates: &[AgentFileUpdate],
) -> Result<AgentRecordExtension, String> {
    if record.files.len() > updates.len() {
        return Err("智能体配置更新文件数量不匹配".to_string());
    }
    for (file, update) in record.files.iter().zip(updates) {
        if file.path != update.path {
            return Err("智能体配置更新路径不匹配".to_string());
        }
    }
    if record.files.len() == updates.len() {
        return Ok((record.clone(), Vec::new()));
    }

    let mut prepared = Vec::new();
    for update in updates.iter().skip(record.files.len()) {
        if let Some(parent) = update.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("创建智能体配置目录失败 {}: {error}", path_to_string(parent))
            })?;
        }
        let backup_path = agent_backup_path(&update.path)?;
        let previous_backup = if backup_path.exists() {
            if !backup_path.is_file() {
                return Err(format!(
                    "智能体备份路径不是文件: {}",
                    path_to_string(&backup_path)
                ));
            }
            Some(fs::read(&backup_path).map_err(|error| {
                format!(
                    "读取原有智能体备份失败 {}: {error}",
                    path_to_string(&backup_path)
                )
            })?)
        } else {
            None
        };
        let current = read_agent_bytes(&update.path)?;
        prepared.push((update, backup_path, previous_backup, current));
    }

    let backup_snapshots = prepared
        .iter()
        .map(|(_, backup_path, previous_backup, _)| (backup_path.clone(), previous_backup.clone()))
        .collect::<Vec<_>>();
    let mut next = record.clone();
    for (update, backup_path, _, current) in prepared {
        let backup_result = if let Some(current) = current.as_deref() {
            write_bytes_atomically(&backup_path, current).and_then(|_| {
                let copied = fs::read(&backup_path).map_err(|error| {
                    format!(
                        "校验智能体备份失败 {}: {error}",
                        path_to_string(&backup_path)
                    )
                })?;
                if sha256_bytes(&copied) != sha256_bytes(current) {
                    return Err(format!(
                        "智能体备份校验失败: {}",
                        path_to_string(&update.path)
                    ));
                }
                Ok(())
            })
        } else if backup_path.exists() {
            fs::remove_file(&backup_path).map_err(|error| {
                format!(
                    "清理旧智能体备份失败 {}: {error}",
                    path_to_string(&backup_path)
                )
            })
        } else {
            Ok(())
        };
        if let Err(error) = backup_result {
            let rollback = restore_snapshots(&backup_snapshots);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}；恢复原有备份失败: {rollback_error}"),
            });
        }
        next.files.push(AgentModificationFile {
            path: update.path.clone(),
            backup_path,
            existed_before: current.is_some(),
            original_sha256: current.as_deref().map(sha256_bytes),
            managed_sha256: sha256_bytes(update.after.as_bytes()),
        });
    }
    Ok((next, backup_snapshots))
}

fn restore_snapshots(snapshots: &[FileSnapshot]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (path, bytes) in snapshots.iter().rev() {
        let result = match bytes {
            Some(bytes) => write_bytes_atomically(path, bytes),
            None if path.exists() => fs::remove_file(path)
                .map_err(|error| format!("删除配置失败 {}: {error}", path_to_string(path))),
            None => Ok(()),
        };
        if let Err(error) = result {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

fn apply_agent_updates(updates: &[AgentFileUpdate]) -> Result<Vec<String>, String> {
    let snapshots = updates
        .iter()
        .map(|update| Ok((update.path.clone(), read_agent_bytes(&update.path)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let mut changed = Vec::new();
    for update in updates {
        let next = update.after.as_bytes();
        if read_agent_bytes(&update.path)?.as_deref() == Some(next) {
            continue;
        }
        if let Err(error) = write_bytes_atomically(&update.path, next) {
            let rollback = restore_snapshots(&snapshots);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}；回滚失败: {rollback_error}"),
            });
        }
        changed.push(path_to_string(&update.path));
    }
    Ok(changed)
}

fn restore_agent_record_files(record: &AgentModificationRecord) -> Result<Vec<String>, String> {
    let snapshots = record
        .files
        .iter()
        .map(|file| Ok((file.path.clone(), read_agent_bytes(&file.path)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let mut changed = Vec::new();
    for file in &record.files {
        let result = if file.existed_before {
            let backup = fs::read(&file.backup_path).map_err(|error| {
                format!(
                    "读取原配置备份失败 {}: {error}",
                    path_to_string(&file.backup_path)
                )
            })?;
            if Some(sha256_bytes(&backup)) != file.original_sha256 {
                return Err(format!(
                    "原配置备份校验失败: {}",
                    path_to_string(&file.backup_path)
                ));
            }
            if read_agent_bytes(&file.path)?.as_deref() == Some(backup.as_slice()) {
                Ok(())
            } else {
                changed.push(path_to_string(&file.path));
                write_bytes_atomically(&file.path, &backup)
            }
        } else if file.path.exists() {
            changed.push(path_to_string(&file.path));
            fs::remove_file(&file.path).map_err(|error| {
                format!("删除智能体配置失败 {}: {error}", path_to_string(&file.path))
            })
        } else {
            Ok(())
        };
        if let Err(error) = result {
            let rollback = restore_snapshots(&snapshots);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback_error) => format!("{error}；回滚失败: {rollback_error}"),
            });
        }
    }
    Ok(changed)
}

fn discard_prepared_agent_backups(record: &AgentModificationRecord) -> Result<(), String> {
    let mut errors = Vec::new();
    for file in &record.files {
        if file.backup_path.exists() {
            if let Err(error) = fs::remove_file(&file.backup_path) {
                errors.push(format!(
                    "删除未启用的智能体备份失败 {}: {error}",
                    path_to_string(&file.backup_path)
                ));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

fn cleanup_agent_record(state_path: &Path, record: &AgentModificationRecord) -> Result<(), String> {
    if state_path.exists() {
        fs::remove_file(state_path).map_err(|error| {
            format!(
                "删除智能体备份状态失败 {}: {error}",
                path_to_string(state_path)
            )
        })?;
    }
    for file in &record.files {
        if file.backup_path.exists() {
            if let Err(error) = fs::remove_file(&file.backup_path) {
                eprintln!(
                    "清理智能体备份失败 {}: {error}",
                    path_to_string(&file.backup_path)
                );
            }
        }
    }
    Ok(())
}

fn action_result(
    outcome: &str,
    enabled: bool,
    model: Option<String>,
    changed_files: Vec<String>,
    conflict_files: Vec<String>,
) -> AgentConfigActionResult {
    AgentConfigActionResult {
        outcome: outcome.to_string(),
        enabled,
        model,
        changed_files,
        conflict_files,
    }
}

fn enable_agent_modification(
    client: AgentClient,
    home: &Path,
    port: u16,
    model: &str,
    models: &[AgentModelOption],
    codex_models: Option<&[CodexModelCatalogSpec]>,
) -> Result<AgentConfigActionResult, String> {
    let paths = agent_config_paths(client, home);
    let state_path = agent_state_path(&paths)?;
    if let Some(record) = load_agent_record(client, &paths)? {
        return Ok(action_result(
            "enabled",
            true,
            Some(record.model),
            Vec::new(),
            Vec::new(),
        ));
    }
    let (_, current_model) = inspect_agent_managed_config(client, &paths, port)?;
    if agent_has_managed_marker(client, &paths)? {
        if let Some(current_model) = current_model.as_deref() {
            if let Some(record) = build_legacy_agent_record(client, home, port, current_model)? {
                write_agent_state(&state_path, &record)?;
                return Ok(action_result(
                    "enabled",
                    true,
                    Some(record.model),
                    Vec::new(),
                    Vec::new(),
                ));
            }
        }
        return Err(
            "检测到 CPA 配置，但缺少可安全恢复的原始备份；请先手动恢复客户端配置".to_string(),
        );
    }

    let updates = build_agent_updates(client, home, port, model, models, codex_models)?;
    let update_paths = updates
        .iter()
        .map(|update| update.path.clone())
        .collect::<Vec<_>>();
    let mut record = prepare_agent_record(client, &update_paths, model, &updates)?;
    if let Err(error) = write_agent_state(&state_path, &record) {
        let cleanup = discard_prepared_agent_backups(&record);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup_error) => format!("{error}；{cleanup_error}"),
        });
    }
    match apply_agent_updates(&updates) {
        Ok(changed) => {
            record.phase = AGENT_PHASE_ACTIVE.to_string();
            write_agent_state(&state_path, &record)?;
            Ok(action_result(
                "enabled",
                true,
                Some(model.to_string()),
                changed,
                Vec::new(),
            ))
        }
        Err(error) => match restore_agent_record_files(&record) {
            Ok(_) => {
                let _ = cleanup_agent_record(&state_path, &record);
                Err(error)
            }
            Err(restore_error) => {
                record.phase = AGENT_PHASE_RECOVERY.to_string();
                let _ = write_agent_state(&state_path, &record);
                Err(format!("{error}；恢复原配置失败: {restore_error}"))
            }
        },
    }
}

fn disable_agent_modification(
    client: AgentClient,
    home: &Path,
    port: u16,
    force_restore: bool,
) -> Result<AgentConfigActionResult, String> {
    let paths = agent_config_paths(client, home);
    let state_path = agent_state_path(&paths)?;
    let mut record = match load_agent_record(client, &paths)? {
        Some(record) => record,
        None => {
            let (_, model) = inspect_agent_managed_config(client, &paths, port)?;
            if !agent_has_managed_marker(client, &paths)? {
                return Ok(action_result(
                    "disabled",
                    false,
                    None,
                    Vec::new(),
                    Vec::new(),
                ));
            }
            let model = model.ok_or_else(|| "无法识别当前 CPA 模型".to_string())?;
            let record = build_legacy_agent_record(client, home, port, &model)?
                .ok_or_else(|| "检测到 CPA 配置，但缺少可安全恢复的原始备份".to_string())?;
            write_agent_state(&state_path, &record)?;
            record
        }
    };

    if record_matches_original(&record)? {
        cleanup_agent_record(&state_path, &record)?;
        return Ok(action_result(
            "disabled",
            false,
            None,
            Vec::new(),
            Vec::new(),
        ));
    }

    let conflicts = record_restore_conflict_files(&record)?;
    if !conflicts.is_empty() && !force_restore {
        return Ok(action_result(
            "restore-conflict",
            true,
            Some(record.model),
            Vec::new(),
            conflicts,
        ));
    }

    record.phase = AGENT_PHASE_RESTORING.to_string();
    write_agent_state(&state_path, &record)?;
    match restore_agent_record_files(&record) {
        Ok(changed) => {
            cleanup_agent_record(&state_path, &record)?;
            Ok(action_result("disabled", false, None, changed, Vec::new()))
        }
        Err(error) => {
            record.phase = AGENT_PHASE_RECOVERY.to_string();
            let _ = write_agent_state(&state_path, &record);
            Err(format!("恢复原配置失败: {error}"))
        }
    }
}

fn update_agent_modification(
    client: AgentClient,
    home: &Path,
    port: u16,
    model: &str,
    models: &[AgentModelOption],
    codex_models: Option<&[CodexModelCatalogSpec]>,
) -> Result<AgentConfigActionResult, String> {
    let paths = agent_config_paths(client, home);
    let state_path = agent_state_path(&paths)?;
    let record = match load_agent_record(client, &paths)? {
        Some(record) => record,
        None => {
            let (_, current_model) = inspect_agent_managed_config(client, &paths, port)?;
            if !agent_has_managed_marker(client, &paths)? {
                return Err("请先开启修改配置".to_string());
            }
            let current_model = current_model.ok_or_else(|| "无法识别当前 CPA 模型".to_string())?;
            let record = build_legacy_agent_record(client, home, port, &current_model)?
                .ok_or_else(|| "缺少原配置备份，无法安全更新".to_string())?;
            write_agent_state(&state_path, &record)?;
            record
        }
    };
    if record.phase != AGENT_PHASE_ACTIVE {
        return Err("上次配置操作尚未完整结束，请先关闭开关恢复原配置".to_string());
    }
    let conflicts = record_conflict_files(&record)?;
    if !conflicts.is_empty() {
        return Err(format!(
            "配置已被其他程序修改，无法更新: {}",
            conflicts.join("、")
        ));
    }

    let updates = build_agent_updates(client, home, port, model, models, codex_models)?;
    let (mut next, backup_snapshots) = extend_agent_record_for_updates(&record, &updates)?;
    next.phase = AGENT_PHASE_APPLYING.to_string();
    next.model = model.to_string();
    for (file, update) in next.files.iter_mut().zip(&updates) {
        if file.path != update.path {
            return Err("智能体配置更新路径不匹配".to_string());
        }
        file.managed_sha256 = sha256_bytes(update.after.as_bytes());
    }
    if let Err(error) = write_agent_state(&state_path, &next) {
        let rollback = restore_snapshots(&backup_snapshots);
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => format!("{error}；恢复模型目录备份失败: {rollback_error}"),
        });
    }
    match apply_agent_updates(&updates) {
        Ok(changed) => {
            next.phase = AGENT_PHASE_ACTIVE.to_string();
            write_agent_state(&state_path, &next)?;
            Ok(action_result(
                "updated",
                true,
                Some(model.to_string()),
                changed,
                Vec::new(),
            ))
        }
        Err(error) => {
            let state_rollback = write_agent_state(&state_path, &record).err();
            let backup_rollback = restore_snapshots(&backup_snapshots).err();
            let mut errors = vec![error];
            if let Some(rollback_error) = state_rollback {
                errors.push(format!("恢复原状态失败: {rollback_error}"));
            }
            if let Some(rollback_error) = backup_rollback {
                errors.push(format!("恢复模型目录备份失败: {rollback_error}"));
            }
            Err(errors.join("；"))
        }
    }
}

#[tauri::command]
fn get_lan_ipv4() -> Option<String> {
    detect_lan_ipv4().map(|address| address.to_string())
}

fn detect_lan_ipv4() -> Option<Ipv4Addr> {
    for target in ["192.0.2.1:80", "8.8.8.8:80"] {
        let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        let Ok(local_address) = socket.local_addr() else {
            continue;
        };
        let IpAddr::V4(address) = local_address.ip() else {
            continue;
        };
        if !address.is_unspecified() && !address.is_loopback() {
            return Some(address);
        }
    }
    None
}

#[tauri::command]
fn save_gui_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: GuiNetworkSettings,
) -> Result<GuiSettings, String> {
    if settings.port == 0 {
        return Err("端口必须在 1 到 65535 之间".to_string());
    }

    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.port = settings.port;
    next.allow_lan = settings.allow_lan;
    patch_core_network_settings(&next)?;
    let config = match gui_config_state.update_network(settings.port, settings.allow_lan) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_network_settings(&previous).err();
            return Err(match rollback_error {
                Some(rollback_error) => {
                    format!("{error}；回滚内核网络配置也失败: {rollback_error}")
                }
                None => error,
            });
        }
    };

    Ok(GuiSettings::from(&config))
}

#[tauri::command]
fn get_core_config_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreConfigView, String> {
    let settings = current_core_config_settings(gui_config_state.inner())?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    let api_keys = gui_api_key_values(&config.api_keys);
    if api_keys != settings.api_keys {
        patch_core_api_keys(&api_keys)?;
    }
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
fn add_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    api_key: String,
    remark: String,
) -> Result<CoreConfigView, String> {
    let api_key = api_key.trim().to_string();
    let remark = remark.trim().to_string();
    validate_core_api_key(&api_key)?;
    validate_api_key_remark(&remark)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    if api_key == DEFAULT_API_KEY
        || settings
            .api_keys
            .iter()
            .any(|existing| existing == &api_key)
    {
        return Err("该鉴权密钥已经存在".to_string());
    }
    if !settings.api_keys.iter().any(|key| key == DEFAULT_API_KEY) {
        settings.api_keys.insert(0, DEFAULT_API_KEY.to_string());
    }
    settings.api_keys.push(api_key);
    patch_core_api_keys(&settings.api_keys)?;
    let added_api_key = settings.api_keys.last().map(|key| GuiApiKeyEntry {
        key: key.clone(),
        remark,
    });
    let config = gui_config_state.sync_core_settings_with_api_key(&settings, added_api_key)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
fn delete_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    api_key: String,
) -> Result<CoreConfigView, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("要删除的鉴权密钥不能为空".to_string());
    }
    if api_key == DEFAULT_API_KEY {
        return Err("内置密钥不能删除".to_string());
    }
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    let index = settings
        .api_keys
        .iter()
        .position(|existing| existing == api_key)
        .ok_or_else(|| "要删除的鉴权密钥不存在，请刷新后重试".to_string())?;
    settings.api_keys.remove(index);
    patch_core_api_keys(&settings.api_keys)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
fn set_core_management_secret_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    secret_key: String,
) -> Result<CoreConfigView, String> {
    let secret_key = secret_key.trim().to_string();
    if secret_key != DEFAULT_MANAGEMENT_SECRET_KEY {
        return Err("管理密钥统一固定为 123456".to_string());
    }
    let config =
        gui_config_state.set_management_secret_key(DEFAULT_MANAGEMENT_SECRET_KEY.to_string())?;
    patch_core_management_secret_key(&config.management_secret_key)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
fn clear_core_management_secret_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreConfigView, String> {
    let config =
        gui_config_state.set_management_secret_key(DEFAULT_MANAGEMENT_SECRET_KEY.to_string())?;
    patch_core_management_secret_key(&config.management_secret_key)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
fn set_core_plugins_enabled(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    enabled: bool,
) -> Result<CoreConfigView, String> {
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    settings.plugins_enabled = enabled;
    patch_core_plugins_enabled(settings.plugins_enabled)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
fn set_core_routing_strategy(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    strategy: String,
) -> Result<CoreConfigView, String> {
    validate_routing_strategy(&strategy)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    settings.routing_strategy = strategy;
    patch_core_routing_strategy(&settings.routing_strategy)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthStartResult {
    url: String,
    state: Option<String>,
    opened: bool,
    open_error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthStatusResult {
    status: String,
    error: Option<String>,
}

#[derive(Deserialize)]
struct OAuthStartApiResponse {
    url: Option<String>,
    state: Option<String>,
    error: Option<String>,
    #[serde(rename = "error_message")]
    error_message: Option<String>,
}

#[derive(Deserialize)]
struct OAuthStatusApiResponse {
    status: Option<String>,
    error: Option<String>,
    #[serde(rename = "error_message")]
    error_message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagementRequest {
    method: String,
    path: String,
    query: Option<std::collections::HashMap<String, String>>,
    body: Option<serde_json::Value>,
}

#[tauri::command]
async fn management_request(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    request: ManagementRequest,
) -> Result<serde_json::Value, String> {
    let config = gui_config_state.snapshot()?;
    let method = match request.method.trim().to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("不支持的管理 API 请求方法".to_string()),
    };
    let path = request.path.trim();
    if path.is_empty() || path.contains("://") || path.contains("..") {
        return Err("无效的管理 API 路径".to_string());
    }

    let client = management_http_client()?;
    let mut builder = client
        .request(method, management_endpoint(&config, path)?)
        .header("Authorization", management_authorization(&config)?);
    if let Some(query) = request.query {
        builder = builder.query(&query);
    }
    if let Some(body) = request.body {
        builder = builder.json(&body);
    }

    let response = builder
        .send()
        .await
        .map_err(|err| format!("请求管理 API 失败: {err}"))?;
    read_management_value(response).await
}

#[tauri::command]
async fn upload_auth_file(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    name: String,
    data: Vec<u8>,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() || !name.to_ascii_lowercase().ends_with(".json") {
        return Err("认证文件名必须以 .json 结尾".to_string());
    }

    let config = gui_config_state.snapshot()?;
    let client = management_http_client()?;
    let mut query = std::collections::HashMap::new();
    query.insert("name".to_string(), name);
    let response = client
        .post(management_endpoint(&config, "auth-files")?)
        .header("Authorization", management_authorization(&config)?)
        .query(&query)
        .header("Content-Type", "application/json")
        .body(data)
        .send()
        .await
        .map_err(|err| format!("上传认证文件失败: {err}"))?;
    read_management_value(response).await
}

#[tauri::command]
async fn download_auth_file(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    name: String,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("认证文件名不能为空".to_string());
    }

    let config = gui_config_state.snapshot()?;
    let client = management_http_client()?;
    let mut query = std::collections::HashMap::new();
    query.insert("name".to_string(), name.to_string());
    let response = client
        .get(management_endpoint(&config, "auth-files/download")?)
        .header("Authorization", management_authorization(&config)?)
        .query(&query)
        .send()
        .await
        .map_err(|err| format!("下载认证文件失败: {err}"))?;
    read_management_text(response).await
}

#[tauri::command]
async fn start_oauth_login(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    provider: String,
) -> Result<OAuthStartResult, String> {
    let config = gui_config_state.snapshot()?;
    let provider_key = normalize_management_oauth_provider(&provider)?;
    let client = management_http_client()?;
    let mut request = client
        .get(management_endpoint(
            &config,
            &format!("{provider_key}-auth-url"),
        )?)
        .header("Authorization", management_authorization(&config)?);
    if management_oauth_uses_webui_callback(&provider_key) {
        request = request.query(&[("is_webui", "true")]);
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("请求 OAuth 登录链接失败: {err}"))?;
    let payload = read_management_json::<OAuthStartApiResponse>(response).await?;
    if let Some(error) = payload
        .error
        .or(payload.error_message)
        .filter(|value| !value.trim().is_empty())
    {
        return Err(error);
    }
    let url = payload
        .url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "内核未返回 OAuth 登录链接".to_string())?;
    let state = payload
        .state
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let (opened, open_error) = match open_external_url_inner(&url) {
        Ok(()) => (true, None),
        Err(error) => (false, Some(error)),
    };

    Ok(OAuthStartResult {
        url,
        state,
        opened,
        open_error,
    })
}

#[tauri::command]
async fn get_oauth_status(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    state: String,
) -> Result<OAuthStatusResult, String> {
    let state = state.trim().to_string();
    if state.is_empty() {
        return Err("OAuth state 不能为空".to_string());
    }
    let config = gui_config_state.snapshot()?;
    let client = management_http_client()?;
    let response = client
        .get(management_endpoint(&config, "get-auth-status")?)
        .header("Authorization", management_authorization(&config)?)
        .query(&[("state", state)])
        .send()
        .await
        .map_err(|err| format!("查询 OAuth 状态失败: {err}"))?;
    let payload = read_management_json::<OAuthStatusApiResponse>(response).await?;
    let status = payload
        .status
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "wait".to_string());
    Ok(OAuthStatusResult {
        status,
        error: payload
            .error
            .or(payload.error_message)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}

#[tauri::command]
async fn submit_oauth_callback(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    provider: String,
    redirect_url: String,
) -> Result<(), String> {
    let redirect_url = redirect_url.trim().to_string();
    if redirect_url.is_empty() {
        return Err("回调链接不能为空".to_string());
    }
    let config = gui_config_state.snapshot()?;
    let provider_key = normalize_management_oauth_provider(&provider)?;
    let client = management_http_client()?;
    let body = serde_json::json!({
        "provider": provider_key,
        "redirect_url": redirect_url,
    });
    let response = client
        .post(management_endpoint(&config, "oauth-callback")?)
        .header("Authorization", management_authorization(&config)?)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("提交 OAuth 回调失败: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取 OAuth 回调响应失败: {err}"))?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    open_external_url_inner(&url)
}

#[tauri::command]
async fn check_latest_core() -> Result<CoreLatest, String> {
    let platform = current_core_platform()?;
    let client = http_client()?;
    let release = fetch_release(&client, None).await?;
    let asset = select_release_asset(&release, &platform)?;

    Ok(CoreLatest {
        version: normalize_version(&release.tag_name),
        asset_name: asset.name.clone(),
    })
}

#[tauri::command]
fn detect_bundled_core() -> Result<Option<BundledCoreInfo>, String> {
    bundled_core_archive().map(|value| value.map(|(info, _)| info))
}

#[tauri::command]
fn install_bundled_core(
    window: tauri::Window,
    state: tauri::State<'_, CoreDownloadState>,
) -> Result<CoreInstallResult, String> {
    let (info, archive_path) = bundled_core_archive()?
        .ok_or_else(|| "当前发行包没有匹配此系统架构的内置内核".to_string())?;
    let token = CancellationToken::new();
    state.start(token, Some(info.version.clone()))?;
    let result = install_bundled_core_inner(&window, state.inner(), &info, &archive_path);
    if result.is_err() {
        let _ = cleanup_core_work_dirs();
    }
    state.finish(&window, result.clone());
    result
}

#[tauri::command]
fn cancel_core_install(state: tauri::State<'_, CoreDownloadState>) {
    state.cancel();
}

#[tauri::command]
fn get_core_install_task(state: tauri::State<'_, CoreDownloadState>) -> CoreInstallTask {
    state.snapshot()
}

#[tauri::command]
async fn install_core_version(
    window: tauri::Window,
    state: tauri::State<'_, CoreDownloadState>,
    version: Option<String>,
) -> Result<CoreInstallResult, String> {
    let token = CancellationToken::new();
    state.start(token.clone(), version.clone())?;
    let result = install_core_version_inner(&window, state.inner(), token, version).await;
    if result.is_err() {
        let _ = cleanup_core_work_dirs();
    }
    state.finish(&window, result.clone());

    result
}

#[tauri::command]
fn start_core_process(
    process_state: tauri::State<'_, CoreProcessState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreStatus, String> {
    let config = gui_config_state.snapshot()?;
    start_core_process_inner(process_state.inner(), &config)?;
    if let Err(error) = gui_config_state.set_run_on_startup(true) {
        let _ = stop_core_process_inner(process_state.inner());
        return Err(error);
    }
    current_core_status(Some(process_state.inner()), Some(config.port))
}

#[tauri::command]
fn stop_core_process(
    process_state: tauri::State<'_, CoreProcessState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreStatus, String> {
    stop_core_process_inner(process_state.inner())?;
    let config = gui_config_state.set_run_on_startup(false)?;
    current_core_status(Some(process_state.inner()), Some(config.port))
}

#[tauri::command]
fn restart_core_process(
    process_state: tauri::State<'_, CoreProcessState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreStatus, String> {
    let config = gui_config_state.snapshot()?;
    let _ = stop_core_process_inner(process_state.inner());
    start_core_process_inner(process_state.inner(), &config)?;
    if let Err(error) = gui_config_state.set_run_on_startup(true) {
        let _ = stop_core_process_inner(process_state.inner());
        return Err(error);
    }
    current_core_status(Some(process_state.inner()), Some(config.port))
}

async fn install_core_version_inner(
    window: &tauri::Window,
    state: &CoreDownloadState,
    token: CancellationToken,
    version: Option<String>,
) -> Result<CoreInstallResult, String> {
    let platform = current_core_platform()?;
    let client = http_client()?;
    state.progress(window, "检查版本", 0, None, true);
    let release = fetch_release_cancelable(&client, version.as_deref(), &token).await?;
    let asset = select_release_asset(&release, &platform)?;

    let install_dir = core_install_dir()?;
    let base_dir = core_base_dir()?;
    let staging_dir = base_dir.join("cpa-core.staging");
    let backup_dir = base_dir.join("cpa-core.backup");
    let download_dir = base_dir.join("cpa-core.download");

    if current_core_status(None, None)?.running {
        return Err("CPA 内核正在运行，请先停止后再安装或更新".to_string());
    }

    reset_dir(&staging_dir)?;
    reset_dir(&download_dir)?;

    let archive_file_name = Path::new(&asset.name)
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .ok_or_else(|| format!("非法 asset 文件名: {}", asset.name))?;
    let archive_path = download_dir.join(archive_file_name);

    let downloaded = download_asset(
        &client,
        &asset.browser_download_url,
        &archive_path,
        asset.size,
        asset.digest.as_deref(),
        window,
        state,
        &token,
    )
    .await?;
    validate_downloaded_asset(asset, &downloaded)?;

    ensure_not_cancelled(&token, Some(&archive_path))?;
    state.progress(
        window,
        "解压中",
        downloaded.size,
        Some(downloaded.size),
        false,
    );
    match platform.archive_kind.as_str() {
        "tar.gz" => extract_tar_gz(&archive_path, &staging_dir)?,
        "zip" => extract_zip(&archive_path, &staging_dir)?,
        other => return Err(format!("不支持的压缩包类型: {other}")),
    }
    ensure_not_cancelled(&token, Some(&archive_path))?;

    let binary_path = find_core_binary(&staging_dir)
        .ok_or_else(|| "解压后未找到 CPA 内核二进制文件".to_string())?;
    let binary_relative_path = binary_path
        .strip_prefix(&staging_dir)
        .map_err(|err| format!("计算内核二进制相对路径失败: {err}"))?
        .to_path_buf();
    preserve_core_runtime_files(&install_dir, &staging_dir)?;
    preserve_bundled_core_assets(&install_dir, &staging_dir)?;
    write_core_metadata(
        &staging_dir,
        &CoreMetadata {
            version: normalize_version(&release.tag_name),
            asset_name: asset.name.clone(),
            installed_at_unix: unix_now(),
        },
    )?;

    replace_install_dir(&install_dir, &staging_dir, &backup_dir)?;
    let _ = fs::remove_dir_all(&download_dir);

    Ok(CoreInstallResult {
        version: normalize_version(&release.tag_name),
        asset_name: asset.name.clone(),
        install_dir: path_to_string(&install_dir),
        binary_path: Some(path_to_string(&install_dir.join(binary_relative_path))),
    })
}

fn install_bundled_core_inner(
    window: &tauri::Window,
    state: &CoreDownloadState,
    info: &BundledCoreInfo,
    archive_path: &Path,
) -> Result<CoreInstallResult, String> {
    let platform = current_core_platform()?;
    let install_dir = core_install_dir()?;
    let base_dir = core_base_dir()?;
    let staging_dir = base_dir.join("cpa-core.staging");
    let backup_dir = base_dir.join("cpa-core.backup");

    if current_core_status(None, None)?.running {
        return Err("CPA 内核正在运行，请先停止后再使用内置内核".to_string());
    }

    let archive_size = fs::metadata(archive_path)
        .map_err(|error| format!("读取内置内核压缩包失败: {error}"))?
        .len();
    state.progress(window, "校验内置内核", 0, Some(archive_size), false);
    validate_bundled_core_checksum(archive_path)?;
    reset_dir(&staging_dir)?;
    state.progress(
        window,
        "解压内置内核",
        archive_size,
        Some(archive_size),
        false,
    );
    match platform.archive_kind.as_str() {
        "tar.gz" => extract_tar_gz(archive_path, &staging_dir)?,
        "zip" => extract_zip(archive_path, &staging_dir)?,
        other => return Err(format!("不支持的内置压缩包类型: {other}")),
    }

    let binary_path = find_core_binary(&staging_dir)
        .ok_or_else(|| "内置压缩包中没有 CPA 内核二进制文件".to_string())?;
    let binary_relative_path = binary_path
        .strip_prefix(&staging_dir)
        .map_err(|error| format!("计算内置内核二进制路径失败: {error}"))?
        .to_path_buf();
    preserve_core_runtime_files(&install_dir, &staging_dir)?;
    preserve_bundled_core_assets(&install_dir, &staging_dir)?;
    preserve_selected_bundled_core_asset(archive_path, &staging_dir)?;
    write_core_metadata(
        &staging_dir,
        &CoreMetadata {
            version: info.version.clone(),
            asset_name: info.asset_name.clone(),
            installed_at_unix: unix_now(),
        },
    )?;
    replace_install_dir(&install_dir, &staging_dir, &backup_dir)?;

    Ok(CoreInstallResult {
        version: info.version.clone(),
        asset_name: info.asset_name.clone(),
        install_dir: path_to_string(&install_dir),
        binary_path: Some(path_to_string(&install_dir.join(binary_relative_path))),
    })
}

async fn fetch_release(
    client: &reqwest::Client,
    version: Option<&str>,
) -> Result<GithubRelease, String> {
    if let Some(version) = version {
        return Ok(release_from_tag(version));
    }
    let atom_result = fetch_release_from_atom(client).await;
    match atom_result {
        Ok(release) => Ok(release),
        Err(atom_error) => fetch_release_from_page(client).await.map_err(|page_error| {
            format!("GitHub 发布源请求失败: {atom_error}；release 页面请求失败: {page_error}")
        }),
    }
}

async fn fetch_release_from_page(client: &reqwest::Client) -> Result<GithubRelease, String> {
    let response = client
        .get(RELEASE_PAGE_URL)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("GitHub release 页面请求失败: {err}"))?;
    let status = response.status();
    let final_url = response.url().clone();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .map_err(|err| format!("读取 GitHub release 页面失败: {err}"))?;
        return Err(format_github_error(status.as_u16(), &body));
    }

    let tag = release_tag_from_url(&final_url)
        .ok_or_else(|| "GitHub release 页面没有返回版本标签".to_string())?;
    Ok(release_from_tag(&tag))
}

async fn fetch_release_from_atom(client: &reqwest::Client) -> Result<GithubRelease, String> {
    let response = client
        .get(RELEASE_ATOM_URL)
        .header(
            reqwest::header::ACCEPT,
            "application/atom+xml,application/xml,text/xml",
        )
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("GitHub Atom feed 请求失败: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("读取 GitHub Atom feed 失败: {err}"))?;
    if !status.is_success() {
        return Err(format_github_error(status.as_u16(), &body));
    }
    let tag = release_tag_from_atom(&body)
        .ok_or_else(|| "GitHub Atom feed 没有返回版本标签".to_string())?;
    Ok(release_from_tag(&tag))
}

fn release_tag_from_atom(xml: &str) -> Option<String> {
    let entry = xml.split_once("<entry>")?.1;
    if let Some(tag_path) = entry.split_once("/releases/tag/").map(|(_, value)| value) {
        let tag = tag_path
            .split(['\"', '<', '?', '#'])
            .next()
            .unwrap_or_default()
            .trim_matches('/');
        if !tag.is_empty() {
            return Some(normalize_version(tag));
        }
    }
    let title = entry
        .split_once("<title>")?
        .1
        .split_once("</title>")?
        .0
        .trim();
    (!title.is_empty()).then(|| normalize_version(title))
}

fn release_from_tag(tag: &str) -> GithubRelease {
    let tag = normalize_version(tag);
    let version = tag.trim_start_matches('v');
    let assets = [
        ("linux", "amd64", "tar.gz"),
        ("linux", "aarch64", "tar.gz"),
        ("darwin", "amd64", "tar.gz"),
        ("darwin", "aarch64", "tar.gz"),
        ("windows", "amd64", "zip"),
        ("windows", "aarch64", "zip"),
    ]
    .into_iter()
    .map(|(os, arch, extension)| {
        let name = format!("CLIProxyAPI_{version}_{os}_{arch}.{extension}");
        GithubAsset {
            browser_download_url: format!("{RELEASE_DOWNLOAD_PREFIX}{tag}/{name}"),
            name,
            size: None,
            digest: None,
        }
    })
    .collect();
    GithubRelease {
        tag_name: tag,
        assets,
    }
}

fn release_tag_from_url(url: &reqwest::Url) -> Option<String> {
    let mut segments = url.path_segments()?;
    let tag = segments.next_back()?.trim();
    if tag.is_empty() || tag == "latest" {
        None
    } else {
        Some(tag.to_string())
    }
}

#[cfg(test)]
fn parse_release_assets(html: &str) -> Vec<GithubAsset> {
    let mut assets = Vec::new();
    let mut cursor = 0;

    while let Some(relative_start) = html[cursor..].find("releases/download/") {
        let download_start = cursor + relative_start;
        let Some(href_start) = html[..download_start].rfind("href=\"") else {
            cursor = download_start + "releases/download/".len();
            continue;
        };
        let href_start = href_start + "href=\"".len();
        let Some(relative_end) = html[download_start..].find('"') else {
            break;
        };
        let href_end = download_start + relative_end;
        let href = &html[href_start..href_end];
        let Some(name) = href.rsplit('/').next().filter(|name| !name.is_empty()) else {
            cursor = href_end + 1;
            continue;
        };
        let item_end = html[href_end..]
            .find("</li>")
            .map(|offset| href_end + offset)
            .unwrap_or(html.len());
        let item = &html[href_start..item_end];
        let digest = item.find("sha256:").and_then(|offset| {
            let value = &item[offset + "sha256:".len()..];
            let hash: String = value
                .chars()
                .take_while(|character| character.is_ascii_hexdigit())
                .collect();
            (hash.len() == 64).then(|| format!("sha256:{hash}"))
        });
        let browser_download_url = if href.starts_with("http://") || href.starts_with("https://") {
            href.to_string()
        } else {
            format!("https://github.com{href}")
        };

        if !assets.iter().any(|asset: &GithubAsset| asset.name == name) {
            assets.push(GithubAsset {
                name: name.to_string(),
                browser_download_url,
                size: None,
                digest,
            });
        }
        cursor = href_end + 1;
    }

    assets
}

fn format_github_error(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value.get("message").and_then(|item| item.as_str()) {
            return format!("GitHub 返回错误 ({status}): {}", message.trim());
        }
    }
    let body = body.trim();
    if body.is_empty() {
        format!("GitHub 返回错误 ({status})")
    } else {
        format!("GitHub 返回错误 ({status}): {}", truncate_for_error(body))
    }
}

async fn fetch_release_cancelable(
    client: &reqwest::Client,
    version: Option<&str>,
    token: &CancellationToken,
) -> Result<GithubRelease, String> {
    tokio::select! {
        result = fetch_release(client, version) => result,
        _ = token.cancelled() => Err("已取消下载".to_string()),
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|err| format!("创建 HTTP 客户端失败: {err}"))
}

fn select_release_asset<'a>(
    release: &'a GithubRelease,
    platform: &CorePlatform,
) -> Result<&'a GithubAsset, String> {
    let expected_name = core_release_asset_name(&release.tag_name, platform);
    let mut matches = release
        .assets
        .iter()
        .filter(|asset| asset.name == expected_name && !asset.name.contains("_no-plugin"));
    let asset = matches
        .next()
        .ok_or_else(|| format!("未找到匹配当前平台的 release asset: {expected_name}"))?;

    if matches.next().is_some() {
        return Err(format!("找到多个匹配的 release asset: {expected_name}"));
    }

    Ok(asset)
}

fn core_release_asset_name(version: &str, platform: &CorePlatform) -> String {
    let version = normalize_version(version);
    let version = version.trim_start_matches('v');
    format!(
        "CLIProxyAPI_{}_{}_{}.{}",
        version, platform.asset_os, platform.asset_arch, platform.archive_kind
    )
}

// Download progress and cancellation require the complete transfer context here.
#[allow(clippy::too_many_arguments)]
async fn download_asset(
    client: &reqwest::Client,
    url: &str,
    archive_path: &Path,
    expected_total: Option<u64>,
    expected_digest: Option<&str>,
    window: &tauri::Window,
    state: &CoreDownloadState,
    token: &CancellationToken,
) -> Result<DownloadedArchive, String> {
    let result = download_asset_inner(
        client,
        url,
        archive_path,
        expected_total,
        expected_digest,
        window,
        state,
        token,
    )
    .await;
    if result.is_err() {
        let _ = fs::remove_file(archive_path);
    }

    result
}

#[allow(clippy::too_many_arguments)]
async fn download_asset_inner(
    client: &reqwest::Client,
    url: &str,
    archive_path: &Path,
    expected_total: Option<u64>,
    expected_digest: Option<&str>,
    window: &tauri::Window,
    state: &CoreDownloadState,
    token: &CancellationToken,
) -> Result<DownloadedArchive, String> {
    state.progress(window, "准备下载", 0, expected_total, true);
    ensure_not_cancelled(token, Some(archive_path))?;

    let request = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send();
    let response = tokio::select! {
        response = request => response.map_err(|err| format!("下载内核压缩包失败: {err}"))?,
        _ = token.cancelled() => return Err("已取消下载".to_string()),
    }
    .error_for_status()
    .map_err(|err| format!("下载地址返回错误状态: {err}"))?;
    let total = expected_total.or_else(|| response.content_length());
    let mut stream = response.bytes_stream();
    let mut file =
        File::create(archive_path).map_err(|err| format!("创建内核压缩包失败: {err}"))?;
    let mut downloaded = 0_u64;
    let mut hasher = Sha256::new();

    while let Some(chunk) = tokio::select! {
        chunk = stream.next() => chunk,
        _ = token.cancelled() => return Err("已取消下载".to_string()),
    } {
        ensure_not_cancelled(token, Some(archive_path))?;

        let chunk = chunk.map_err(|err| format!("读取下载数据失败: {err}"))?;
        file.write_all(&chunk)
            .map_err(|err| format!("保存下载数据失败: {err}"))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        state.progress(window, "下载中", downloaded, total, true);
    }

    file.flush()
        .map_err(|err| format!("刷新内核压缩包失败: {err}"))?;
    ensure_not_cancelled(token, Some(archive_path))?;

    let sha256 = format!("{:x}", hasher.finalize());
    validate_download_metadata(downloaded, expected_total, &sha256, expected_digest)?;

    Ok(DownloadedArchive {
        size: downloaded,
        sha256,
    })
}

fn ensure_not_cancelled(
    token: &CancellationToken,
    archive_path: Option<&Path>,
) -> Result<(), String> {
    if token.is_cancelled() {
        if let Some(archive_path) = archive_path {
            let _ = fs::remove_file(archive_path);
        }

        return Err("已取消下载".to_string());
    }

    Ok(())
}

fn current_core_platform() -> Result<CorePlatform, String> {
    let os = env::consts::OS;
    let arch = env::consts::ARCH;

    let (asset_os, archive_kind) = match os {
        "linux" => ("linux", "tar.gz"),
        "macos" => ("darwin", "tar.gz"),
        "windows" => ("windows", "zip"),
        other => return Err(format!("不支持的操作系统: {other}")),
    };

    let asset_arch = match arch {
        "x86_64" => "amd64",
        "aarch64" => "aarch64",
        other => return Err(format!("不支持的 CPU 架构: {other}")),
    };

    Ok(CorePlatform {
        os: os.to_string(),
        arch: arch.to_string(),
        asset_os: asset_os.to_string(),
        asset_arch: asset_arch.to_string(),
        archive_kind: archive_kind.to_string(),
    })
}

fn current_core_status(
    process_state: Option<&CoreProcessState>,
    management_port: Option<u16>,
) -> Result<CoreStatus, String> {
    let install_dir = core_install_dir()?;
    let binary_path = find_core_binary(&install_dir);
    let installed = binary_path.is_some();
    let managed_pid = process_state.and_then(|state| state.managed_pid());
    let process_ids = binary_path
        .as_ref()
        .map(|path| find_core_process_ids(path))
        .unwrap_or_default();
    let process_id = managed_pid.or_else(|| process_ids.first().copied());
    let running =
        process_id.is_some() && management_port.map(is_management_port_open).unwrap_or(true);
    let current_version = read_core_metadata(&install_dir).map(|metadata| metadata.version);

    let message = if !installed {
        "未安装 CPA 内核，请先安装最新版".to_string()
    } else if running {
        "CPA 内核正在运行".to_string()
    } else {
        "CPA 内核已安装，当前未运行".to_string()
    };

    Ok(CoreStatus {
        installed,
        running,
        managed: managed_pid.is_some(),
        process_id,
        current_version,
        install_dir: path_to_string(&install_dir),
        binary_path: binary_path.map(|path| path_to_string(&path)),
        message,
    })
}

fn is_management_port_open(port: u16) -> bool {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok()
}

fn start_core_process_inner(
    process_state: &CoreProcessState,
    gui_config: &GuiConfigFile,
) -> Result<(), String> {
    ensure_fixed_oauth_dir()?;
    let install_dir = core_install_dir()?;
    let binary_path = find_core_binary(&install_dir)
        .ok_or_else(|| "未安装 CPA 内核，请先安装最新版".to_string())?;

    if process_state.managed_pid().is_some() || is_core_running(&binary_path) {
        return Err("CPA 内核已经在运行".to_string());
    }
    let management_address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), gui_config.port);
    if TcpStream::connect_timeout(&management_address, Duration::from_millis(250)).is_ok() {
        return Err(format!(
            "端口 {} 已被其他程序占用，请更换端口后重试",
            gui_config.port
        ));
    }

    let config_path = merge_core_config_for_start(&install_dir, gui_config)?;
    let config_path = path_to_string(&config_path);
    let mut command = Command::new(&binary_path);
    command
        .args(["-config", &config_path])
        .current_dir(&install_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_child_lifetime(&mut command);

    let mut child = command
        .spawn()
        .map_err(|err| format!("启动 CPA 内核失败: {err}"))?;

    if let Err(error) = wait_for_core_management_port(&mut child, management_address) {
        let _ = terminate_child(&mut child);
        return Err(error);
    }

    process_state.store_child(child)?;

    Ok(())
}

fn wait_for_core_management_port(child: &mut Child, address: SocketAddr) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("检查 CPA 内核启动状态失败: {err}"))?
        {
            return Err(format!("CPA 内核启动后立即退出: {status}"));
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "CPA 内核启动超时：10 秒内未监听管理端口 {}",
                address.port()
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn configure_child_lifetime(command: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;

        let parent_process_id = unsafe { libc::getpid() };
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                    return Err(io::Error::last_os_error());
                }

                if libc::getppid() != parent_process_id {
                    return Err(io::Error::other(
                        "CPA GUI exited before the core process started",
                    ));
                }

                Ok(())
            });
        }
    }

    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

fn merge_core_config_for_start(
    install_dir: &Path,
    gui_config: &GuiConfigFile,
) -> Result<PathBuf, String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = install_dir.join(CORE_CONFIG_FILE);
    let example_config_path = install_dir.join(CORE_EXAMPLE_CONFIG_FILE);
    if !example_config_path.is_file() {
        return Err(format!(
            "未找到内核配置模板: {}",
            path_to_string(&example_config_path)
        ));
    }

    let template = fs::read_to_string(&example_config_path).map_err(|err| {
        format!(
            "读取内核配置模板失败 {}: {err}",
            path_to_string(&example_config_path)
        )
    })?;
    let current = if config_path.is_file() {
        Some(fs::read_to_string(&config_path).map_err(|err| {
            format!(
                "读取现有内核配置失败 {}: {err}",
                path_to_string(&config_path)
            )
        })?)
    } else {
        None
    };
    let merged = merge_core_config_yaml(&template, current.as_deref(), gui_config)?;
    write_yaml_if_changed(&config_path, &merged)?;

    Ok(config_path)
}

fn patch_core_network_settings(config: &GuiConfigFile) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let install_dir = core_install_dir()?;
    let config_path = install_dir.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("读取内核配置失败 {}: {err}", path_to_string(&config_path)))?;
    let Some(updated) = patch_core_network_yaml(&content, config)? else {
        return Ok(());
    };
    write_yaml_if_changed(&config_path, &updated).map(|_| ())
}

fn patch_core_auth_dir(auth_dir: &str) -> Result<(), String> {
    let auth_dir = auth_dir.to_string();
    patch_existing_core_config(move |document| {
        set_core_yaml_top_level_value(document, "auth-dir", serde_norway::Value::String(auth_dir))
    })
}

fn lock_core_config_file() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    CORE_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "内核配置文件锁已损坏".to_string())
}

fn read_installed_core_config_settings() -> Result<CoreConfigSettings, String> {
    let _config_guard = lock_core_config_file()?;
    let (_, document) = read_core_config_document()?;
    core_config_settings_from_value(document.get())
}

fn current_core_config_settings(
    gui_config_state: &GuiConfigState,
) -> Result<CoreConfigSettings, String> {
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if config_path.is_file() {
        read_installed_core_config_settings()
    } else {
        let config = gui_config_state.snapshot()?;
        Ok(CoreConfigSettings::from(&config))
    }
}

fn patch_core_api_keys(api_keys: &[String]) -> Result<(), String> {
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("读取内核配置失败 {}: {err}", path_to_string(&config_path)))?;
    let updated = patch_core_api_keys_yaml(&content, api_keys)?;
    write_yaml_if_changed(&config_path, &updated)?;
    Ok(())
}

fn patch_core_management_secret_key(secret_key: &str) -> Result<(), String> {
    let _ = secret_key;
    let secret_key = DEFAULT_MANAGEMENT_SECRET_KEY.to_string();
    patch_existing_core_config(move |document| {
        set_core_yaml_nested_value(
            document,
            "remote-management",
            "secret-key",
            serde_norway::Value::String(secret_key),
        )
    })
}

fn patch_core_plugins_enabled(enabled: bool) -> Result<(), String> {
    patch_existing_core_config(|document| {
        set_core_yaml_nested_value(
            document,
            "plugins",
            "enabled",
            serde_norway::Value::Bool(enabled),
        )
    })
}

fn patch_core_routing_strategy(strategy: &str) -> Result<(), String> {
    let strategy = strategy.to_string();
    patch_existing_core_config(move |document| {
        set_core_yaml_nested_value(
            document,
            "routing",
            "strategy",
            serde_norway::Value::String(strategy),
        )
    })
}

fn patch_existing_core_config<F>(update: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_norway::Value) -> Result<bool, String>,
{
    let _config_guard = lock_core_config_file()?;
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Ok(());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("读取内核配置失败 {}: {err}", path_to_string(&config_path)))?;
    let Some(updated) = patch_core_yaml_document(&content, update)? else {
        return Ok(());
    };

    write_yaml_if_changed(&config_path, &updated)?;

    Ok(())
}

fn patch_core_yaml_document<F>(content: &str, update: F) -> Result<Option<String>, String>
where
    F: FnOnce(&mut serde_norway::Value) -> Result<bool, String>,
{
    let original = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|err| format!("解析内核配置失败: {err}"))?;
    let mut updated = original.clone();
    if !update(&mut updated)? {
        return Ok(None);
    }
    render_yaml_value_changes(content, &original, &updated).map(Some)
}

struct YamlValueChange {
    path: Vec<String>,
    value: serde_norway::Value,
}

fn render_yaml_value_changes(
    content: &str,
    original: &serde_norway::Value,
    updated: &serde_norway::Value,
) -> Result<String, String> {
    if original == updated {
        return Ok(content.to_string());
    }
    let editable_content = normalize_nested_yaml_comment_indentation(content);
    let file = editable_content
        .parse::<yaml_edit::YamlFile>()
        .map_err(|err| format!("解析可编辑内核配置失败: {err}"))?;
    let document = file
        .document()
        .ok_or_else(|| "内核配置没有 YAML 文档".to_string())?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let mut changes = Vec::new();
    collect_yaml_value_changes(original, updated, &mut Vec::new(), &mut changes)?;
    for change in changes {
        set_yaml_edit_mapping_path(&root, &change.path, &change.value)?;
    }
    let rendered = file.to_string();
    let validated = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .map_err(|err| format!("验证更新后的内核配置失败: {err}"))?;
    if validated != *updated {
        return Err("更新后的内核配置与预期值不一致，已拒绝写入".to_string());
    }
    Ok(rendered)
}

fn normalize_nested_yaml_comment_indentation(content: &str) -> String {
    let lines = content.split_inclusive('\n').collect::<Vec<_>>();
    let mut normalized = String::with_capacity(content.len());
    for (index, line) in lines.iter().enumerate() {
        let body = line.trim_end_matches(['\r', '\n']);
        let ending = &line[body.len()..];
        let trimmed = body.trim_start_matches([' ', '\t']);
        let current_indent = body.len().saturating_sub(trimmed.len());
        if !trimmed.starts_with('#') {
            normalized.push_str(line);
            continue;
        }
        let next = lines.iter().skip(index + 1).find_map(|candidate| {
            let candidate = candidate.trim_end_matches(['\r', '\n']);
            let trimmed = candidate.trim_start_matches([' ', '\t']);
            if trimmed.is_empty() || trimmed.starts_with('#') {
                None
            } else {
                Some((candidate.len().saturating_sub(trimmed.len()), trimmed))
            }
        });
        let Some((next_indent, _)) = next else {
            normalized.push_str(line);
            continue;
        };
        let belongs_to_nested_mapping = current_indent < next_indent
            && lines[..index].iter().rev().any(|candidate| {
                let candidate = candidate.trim_end_matches(['\r', '\n']);
                let trimmed = candidate.trim_start_matches([' ', '\t']);
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    return false;
                }
                let indent = candidate.len().saturating_sub(trimmed.len());
                indent < next_indent && trimmed.ends_with(':')
            });
        if belongs_to_nested_mapping {
            normalized.push_str(&" ".repeat(next_indent));
            normalized.push_str(trimmed);
            normalized.push_str(ending);
        } else {
            normalized.push_str(line);
        }
    }
    normalized
}

fn collect_yaml_value_changes(
    original: &serde_norway::Value,
    updated: &serde_norway::Value,
    path: &mut Vec<String>,
    changes: &mut Vec<YamlValueChange>,
) -> Result<(), String> {
    if original == updated {
        return Ok(());
    }
    match (original, updated) {
        (
            serde_norway::Value::Mapping(original_mapping),
            serde_norway::Value::Mapping(updated_mapping),
        ) => {
            for key in original_mapping.keys() {
                if !updated_mapping.contains_key(key) {
                    return Err("当前内核配置更新不支持删除任意 YAML 字段".to_string());
                }
            }
            for (key, updated_value) in updated_mapping {
                let key = key
                    .as_str()
                    .ok_or_else(|| "内核配置映射键必须是字符串".to_string())?;
                path.push(key.to_string());
                if let Some(original_value) = original_mapping.get(yaml_key(key)) {
                    collect_yaml_value_changes(original_value, updated_value, path, changes)?;
                } else {
                    changes.push(YamlValueChange {
                        path: path.clone(),
                        value: updated_value.clone(),
                    });
                }
                path.pop();
            }
            Ok(())
        }
        _ if path.is_empty() => Err("内核配置顶层必须保持为 YAML 映射".to_string()),
        _ => {
            changes.push(YamlValueChange {
                path: path.clone(),
                value: updated.clone(),
            });
            Ok(())
        }
    }
}

fn set_yaml_edit_mapping_path(
    mapping: &yaml_edit::Mapping,
    path: &[String],
    value: &serde_norway::Value,
) -> Result<(), String> {
    let Some((key, remaining)) = path.split_first() else {
        return Err("内核配置更新路径不能为空".to_string());
    };
    if remaining.is_empty() {
        return set_yaml_edit_mapping_value(mapping, key, value);
    }
    if let Some(child) = mapping.get(key.as_str()) {
        let child = child
            .as_mapping()
            .ok_or_else(|| format!("内核配置区段 {key} 必须是 YAML 映射"))?;
        return set_yaml_edit_mapping_path(child, remaining, value);
    }
    let nested_value = nested_yaml_value_for_path(remaining, value.clone());
    set_yaml_edit_mapping_value(mapping, key, &nested_value)
}

fn set_yaml_edit_mapping_value(
    mapping: &yaml_edit::Mapping,
    key: &str,
    value: &serde_norway::Value,
) -> Result<(), String> {
    match value {
        serde_norway::Value::String(value) => {
            mapping.set(key, value.as_str());
            return Ok(());
        }
        serde_norway::Value::Bool(value) => {
            mapping.set(key, *value);
            return Ok(());
        }
        serde_norway::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                mapping.set(key, value);
                return Ok(());
            }
            if let Some(value) = value.as_u64() {
                mapping.set(key, value);
                return Ok(());
            }
            if let Some(value) = value.as_f64() {
                mapping.set(key, value);
                return Ok(());
            }
        }
        _ => {}
    }
    if let serde_norway::Value::Sequence(values) = value {
        if let Some(node) = mapping.get(key) {
            if let Some(sequence) = node.as_sequence() {
                for (index, value) in values.iter().enumerate() {
                    let value = yaml_edit_node_from_value(value)?;
                    if index < sequence.len() {
                        if !sequence.set(index, value) {
                            return Err(format!("更新内核配置序列 {key}[{index}] 失败"));
                        }
                    } else {
                        sequence.push(value);
                    }
                }
                while sequence.len() > values.len() {
                    let last = sequence.len() - 1;
                    if sequence.remove(last).is_none() {
                        return Err(format!("删除内核配置序列 {key}[{last}] 失败"));
                    }
                }
                return Ok(());
            }
        }
    }
    match yaml_edit_node_from_value(value)? {
        yaml_edit::YamlNode::Scalar(node) => mapping.set(key, node),
        yaml_edit::YamlNode::Sequence(node) => mapping.set(key, node),
        yaml_edit::YamlNode::Mapping(node) => mapping.set(key, node),
        yaml_edit::YamlNode::Alias(node) => mapping.set(key, node),
        yaml_edit::YamlNode::TaggedNode(node) => mapping.set(key, node),
    }
    Ok(())
}

fn nested_yaml_value_for_path(path: &[String], value: serde_norway::Value) -> serde_norway::Value {
    path.iter().rev().fold(value, |nested, key| {
        let mut mapping = serde_norway::Mapping::new();
        mapping.insert(yaml_key(key), nested);
        serde_norway::Value::Mapping(mapping)
    })
}

fn yaml_edit_node_from_value(value: &serde_norway::Value) -> Result<yaml_edit::YamlNode, String> {
    const WRAPPER_KEY: &str = "__cpa_gui_value__";
    let value =
        serde_json::to_string(value).map_err(|err| format!("序列化内核配置值失败: {err}"))?;
    let serialized = format!("{WRAPPER_KEY}: {value}\n");
    let file = serialized
        .parse::<yaml_edit::YamlFile>()
        .map_err(|err| format!("解析内核配置值失败: {err}"))?;
    file.document()
        .and_then(|document| document.get(WRAPPER_KEY))
        .ok_or_else(|| "无法构造内核配置值".to_string())
}

fn set_core_yaml_top_level_value(
    document: &mut serde_norway::Value,
    key: &str,
    value: serde_norway::Value,
) -> Result<bool, String> {
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let key = yaml_key(key);
    if root.get(&key) == Some(&value) {
        return Ok(false);
    }
    root.insert(key, value);
    Ok(true)
}

fn set_core_yaml_nested_value(
    document: &mut serde_norway::Value,
    section: &str,
    key: &str,
    value: serde_norway::Value,
) -> Result<bool, String> {
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let section = root
        .entry(yaml_key(section))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "内核配置区段必须是 YAML 映射".to_string())?;
    let key = yaml_key(key);
    if section.get(&key) == Some(&value) {
        return Ok(false);
    }
    section.insert(key, value);
    Ok(true)
}

fn patch_core_api_keys_yaml(content: &str, api_keys: &[String]) -> Result<String, String> {
    let parsed = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|err| format!("解析内核配置失败: {err}"))?;
    let root = parsed
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let has_legacy_api_keys = nested_yaml_value(
        root,
        &["auth", "providers", "config-api-key", "api-key-entries"],
    )
    .is_some()
        || nested_yaml_value(root, &["auth", "providers", "config-api-key", "api-keys"]).is_some();
    let content = if has_legacy_api_keys {
        let file = content
            .parse::<yaml_edit::YamlFile>()
            .map_err(|err| format!("解析内核配置失败: {err}"))?;
        let document = file
            .document()
            .ok_or_else(|| "内核配置没有 YAML 文档".to_string())?;
        clear_legacy_api_key_paths(&document);
        file.to_string()
    } else {
        content.to_string()
    };
    let block = render_core_api_keys_yaml(api_keys)?;
    let updated = replace_top_level_yaml_block(&content, "api-keys", &block);
    serde_norway::from_str::<serde_norway::Value>(&updated)
        .map_err(|err| format!("验证更新后的内核配置失败: {err}"))?;
    Ok(updated)
}

fn render_core_api_keys_yaml(api_keys: &[String]) -> Result<String, String> {
    if api_keys.is_empty() {
        return Ok(String::new());
    }

    let sequence = serde_norway::Value::Sequence(
        api_keys
            .iter()
            .cloned()
            .map(serde_norway::Value::String)
            .collect(),
    );
    let serialized = serde_norway::to_string(&sequence)
        .map_err(|err| format!("生成内核鉴权密钥配置失败: {err}"))?;
    let mut block = String::from("api-keys:\n");
    for line in serialized.lines() {
        block.push_str("  ");
        block.push_str(line);
        block.push('\n');
    }
    Ok(block)
}

fn replace_top_level_yaml_block(content: &str, key: &str, block: &str) -> String {
    let lines = yaml_line_ranges(content);
    let key_prefix = format!("{key}:");

    if let Some((line_index, (start, end))) =
        lines.iter().copied().enumerate().find(|(_, range)| {
            let line = yaml_line_content(content, *range);
            !line.chars().next().is_some_and(char::is_whitespace) && line.starts_with(&key_prefix)
        })
    {
        let line = yaml_line_content(content, (start, end));
        let value = line[key_prefix.len()..].trim();
        let mut replace_end = end;
        if value.is_empty() || value.starts_with('#') {
            for (next_start, next_end) in lines.iter().copied().skip(line_index + 1) {
                let next = yaml_line_content(content, (next_start, next_end));
                if next.chars().next().is_some_and(char::is_whitespace)
                    || is_indentationless_yaml_sequence_item(next)
                {
                    replace_end = next_end;
                } else {
                    break;
                }
            }
        }
        return replace_yaml_range(content, start, replace_end, block);
    }

    let insertion = lines
        .iter()
        .copied()
        .find(|range| yaml_line_content(content, *range).trim() == "# API keys for authentication")
        .map(|(_, end)| end)
        .or_else(|| {
            lines
                .iter()
                .copied()
                .find(|range| {
                    let line = yaml_line_content(content, *range);
                    !line.chars().next().is_some_and(char::is_whitespace)
                        && line.starts_with("auth-dir:")
                })
                .map(|(_, end)| end)
        })
        .unwrap_or(0);
    replace_yaml_range(content, insertion, insertion, block)
}

fn is_indentationless_yaml_sequence_item(line: &str) -> bool {
    let Some(rest) = line.strip_prefix('-') else {
        return false;
    };
    rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace)
}

fn yaml_line_ranges(content: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;
    for (index, character) in content.char_indices() {
        if character == '\n' {
            ranges.push((start, index + 1));
            start = index + 1;
        }
    }
    if start < content.len() {
        ranges.push((start, content.len()));
    }
    ranges
}

fn yaml_line_content(content: &str, (start, end): (usize, usize)) -> &str {
    content[start..end].trim_end_matches(['\r', '\n'])
}

fn replace_yaml_range(content: &str, start: usize, end: usize, block: &str) -> String {
    let mut result = String::with_capacity(content.len() + block.len());
    result.push_str(&content[..start]);
    if !block.is_empty() {
        result.push_str(block);
        if !block.ends_with('\n') && (end < content.len() || content.ends_with('\n')) {
            result.push('\n');
        }
    }
    result.push_str(&content[end..]);
    result
}

fn clear_legacy_api_key_paths(document: &yaml_edit::Document) {
    use yaml_edit::path::YamlPath;

    document.remove_path("auth.providers.config-api-key.api-key-entries");
    document.remove_path("auth.providers.config-api-key.api-keys");
}

#[cfg(test)]
fn set_yaml_edit_nested_value(
    document: &yaml_edit::Document,
    section: &str,
    key: &str,
    value: impl yaml_edit::AsYaml,
) -> bool {
    if let Some(node) = document.get(section) {
        if let Some(mapping) = node.as_mapping() {
            mapping.set(key, value);
            return true;
        }
    }
    false
}

fn read_core_config_document() -> Result<(PathBuf, yaml_serde_edit::YamlValue), String> {
    let config_path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !config_path.is_file() {
        return Err("内核配置尚未生成，请先启动 CPA 内核".to_string());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("读取内核配置失败 {}: {err}", path_to_string(&config_path)))?;
    let document = yaml_serde_edit::YamlValue::parse(&content)
        .map_err(|err| format!("解析内核配置失败: {err}"))?;
    Ok((config_path, document))
}

fn core_config_settings_from_value(
    document: &serde_norway::Value,
) -> Result<CoreConfigSettings, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let api_keys = extract_core_api_keys(root)?
        .into_iter()
        .filter(|api_key| !is_example_core_api_key(api_key))
        .collect();
    let management_secret_key = extract_core_management_secret_key(root)?;
    let plugins_enabled = nested_yaml_value(root, &["plugins", "enabled"])
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "plugins.enabled 必须是布尔值".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let routing_strategy = nested_yaml_value(root, &["routing", "strategy"])
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "routing.strategy 必须是字符串".to_string())
        })
        .transpose()?
        .unwrap_or_else(|| "round-robin".to_string());

    Ok(CoreConfigSettings {
        api_keys,
        management_secret_configured: management_secret_key
            .as_deref()
            .is_some_and(|value| !value.is_empty()),
        plugins_enabled,
        routing_strategy,
        management_secret_key,
    })
}

fn extract_core_api_keys(root: &serde_norway::Mapping) -> Result<Vec<String>, String> {
    if let Some(value) = yaml_mapping_value(root, "api-keys") {
        return extract_api_key_sequence(value, "api-keys");
    }

    let legacy = nested_yaml_value(root, &["auth", "providers", "config-api-key"])
        .and_then(serde_norway::Value::as_mapping);
    let Some(legacy) = legacy else {
        return Ok(Vec::new());
    };
    let value = yaml_mapping_value(legacy, "api-key-entries")
        .or_else(|| yaml_mapping_value(legacy, "api-keys"));
    value
        .map(|value| extract_api_key_sequence(value, "auth.providers.config-api-key"))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn extract_api_key_sequence(
    value: &serde_norway::Value,
    field_name: &str,
) -> Result<Vec<String>, String> {
    if value.is_null() {
        return Ok(Vec::new());
    }

    let sequence = value
        .as_sequence()
        .ok_or_else(|| format!("{field_name} 必须是数组"))?;
    sequence
        .iter()
        .filter_map(extract_api_key_value)
        .collect::<Result<Vec<_>, _>>()
}

fn extract_api_key_value(value: &serde_norway::Value) -> Option<Result<String, String>> {
    if let Some(value) = value.as_str() {
        let value = value.trim();
        return (!value.is_empty()).then(|| Ok(value.to_string()));
    }

    let mapping = value.as_mapping()?;
    for key in ["api-key", "apiKey", "key", "Key"] {
        if let Some(value) = yaml_mapping_value(mapping, key).and_then(serde_norway::Value::as_str)
        {
            let value = value.trim();
            if !value.is_empty() {
                return Some(Ok(value.to_string()));
            }
        }
    }

    Some(Err(
        "鉴权密钥条目必须是字符串或包含 key 字段的映射".to_string()
    ))
}

fn extract_core_management_secret_key(
    root: &serde_norway::Mapping,
) -> Result<Option<String>, String> {
    let Some(value) = nested_yaml_value(root, &["remote-management", "secret-key"]) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| "remote-management.secret-key 必须是字符串".to_string())?
        .trim()
        .to_string();
    if value.is_empty() || is_hashed_management_secret_key(&value) {
        return Ok(None);
    }
    Ok(Some(value))
}

#[cfg(test)]
fn set_core_api_keys(
    document: &mut serde_norway::Value,
    api_keys: Vec<String>,
) -> Result<(), String> {
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    root.insert(
        yaml_key("api-keys"),
        serde_norway::Value::Sequence(
            api_keys
                .into_iter()
                .map(serde_norway::Value::String)
                .collect(),
        ),
    );
    remove_legacy_api_keys(root);
    Ok(())
}

#[cfg(test)]
fn remove_legacy_api_keys(root: &mut serde_norway::Mapping) {
    let Some(auth) =
        yaml_mapping_value_mut(root, "auth").and_then(serde_norway::Value::as_mapping_mut)
    else {
        return;
    };
    let Some(providers) =
        yaml_mapping_value_mut(auth, "providers").and_then(serde_norway::Value::as_mapping_mut)
    else {
        return;
    };
    let Some(provider) = yaml_mapping_value_mut(providers, "config-api-key")
        .and_then(serde_norway::Value::as_mapping_mut)
    else {
        return;
    };
    provider.remove(yaml_key("api-key-entries"));
    provider.remove(yaml_key("api-keys"));
}

#[cfg(test)]
fn set_nested_yaml_value<T>(
    document: &mut serde_norway::Value,
    path: &[&str],
    value: T,
) -> Result<(), String>
where
    T: Into<serde_norway::Value>,
{
    if path.len() != 2 {
        return Err("内核配置路径无效".to_string());
    }

    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let section = root
        .entry(yaml_key(path[0]))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()));
    let section = section
        .as_mapping_mut()
        .ok_or_else(|| format!("{} 必须是 YAML 映射", path[0]))?;
    section.insert(yaml_key(path[1]), value.into());
    Ok(())
}

fn nested_yaml_value<'a>(
    root: &'a serde_norway::Mapping,
    path: &[&str],
) -> Option<&'a serde_norway::Value> {
    let (first, rest) = path.split_first()?;
    let mut value = yaml_mapping_value(root, first)?;
    for key in rest {
        value = yaml_mapping_value(value.as_mapping()?, key)?;
    }
    Some(value)
}

fn yaml_mapping_value<'a>(
    mapping: &'a serde_norway::Mapping,
    key: &str,
) -> Option<&'a serde_norway::Value> {
    mapping.get(yaml_key(key))
}

fn yaml_mapping_value_mut<'a>(
    mapping: &'a mut serde_norway::Mapping,
    key: &str,
) -> Option<&'a mut serde_norway::Value> {
    mapping.get_mut(yaml_key(key))
}

fn yaml_key(key: &str) -> serde_norway::Value {
    serde_norway::Value::String(key.to_string())
}

fn validate_thinking_alias_model_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label}不能为空"));
    }
    if value.len() > 240
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(format!("{label}格式无效，不能包含空白字符"));
    }
    Ok(value.to_string())
}

fn validate_thinking_alias_effort(value: &str) -> Result<String, String> {
    let effort = value.trim().to_ascii_lowercase();
    if effort.is_empty() {
        return Err("思考强度不能为空".to_string());
    }
    if effort.chars().all(|character| character.is_ascii_digit()) {
        return Err("固定思考别名不支持纯数字预算，请输入思考等级名称".to_string());
    }
    if effort.len() > 64
        || !effort.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("思考强度格式无效，仅支持字母、数字、短横线、下划线和点".to_string());
    }
    Ok(effort)
}

async fn fetch_management_config_yaml(config: &GuiConfigFile) -> Result<String, String> {
    let client = management_http_client()?;
    let response = client
        .get(management_endpoint(config, "config.yaml")?)
        .header("Authorization", management_authorization(config)?)
        .header(
            reqwest::header::ACCEPT,
            "application/yaml,text/yaml,text/plain",
        )
        .send()
        .await
        .map_err(|error| format!("读取内核 YAML 配置失败: {error}"))?;
    read_management_text(response).await
}

async fn put_management_config_yaml(config: &GuiConfigFile, content: &str) -> Result<(), String> {
    let client = management_http_client()?;
    let response = client
        .put(management_endpoint(config, "config.yaml")?)
        .header("Authorization", management_authorization(config)?)
        .header(reqwest::header::CONTENT_TYPE, "application/yaml")
        .body(content.to_string())
        .send()
        .await
        .map_err(|error| format!("保存内核 YAML 配置失败: {error}"))?;
    read_management_value(response).await.map(|_| ())
}

async fn fetch_codex_model_definitions(
    config: &GuiConfigFile,
) -> Result<Vec<CodexModelDefinition>, String> {
    let client = management_http_client()?;
    let response = client
        .get(management_endpoint(config, "model-definitions/codex")?)
        .header("Authorization", management_authorization(config)?)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("读取 Codex OAuth 模型定义失败: {error}"))?;
    let payload = read_management_value(response).await?;
    parse_codex_model_definitions(&payload)
}

fn resolved_thinking_alias_sources(
    content: &str,
    definitions: &[CodexModelDefinition],
) -> Result<Vec<ResolvedThinkingAliasSource>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let mut sources = definitions
        .iter()
        .filter(|definition| !definition.reasoning_levels.is_empty())
        .map(|definition| ResolvedThinkingAliasSource {
            source: ThinkingAliasSource {
                id: format!("codex-oauth:{}", definition.id),
                model: definition.id.clone(),
                display_name: definition.display_name.clone(),
                provider: "Codex OAuth".to_string(),
                kind: "codex-oauth".to_string(),
                protocol: "codex".to_string(),
            },
            location: ThinkingAliasSourceLocation::CodexOauth,
        })
        .collect::<Vec<_>>();
    collect_config_thinking_alias_sources(
        root,
        "codex-api-key",
        "Codex API",
        "codex-api",
        "codex",
        &mut sources,
    )?;
    collect_config_thinking_alias_sources(
        root,
        "openai-compatibility",
        "OpenAI 兼容",
        "openai-compatible",
        "openai",
        &mut sources,
    )?;
    Ok(sources)
}

fn collect_config_thinking_alias_sources(
    root: &serde_norway::Mapping,
    section: &'static str,
    fallback_provider: &str,
    kind: &str,
    protocol: &str,
    sources: &mut Vec<ResolvedThinkingAliasSource>,
) -> Result<(), String> {
    let Some(providers) = yaml_mapping_value(root, section) else {
        return Ok(());
    };
    let providers = providers
        .as_sequence()
        .ok_or_else(|| format!("{section} 必须是数组"))?;
    for (provider_index, provider) in providers.iter().enumerate() {
        let Some(provider) = provider.as_mapping() else {
            continue;
        };
        if matches!(
            yaml_mapping_value(provider, "disabled"),
            Some(serde_norway::Value::Bool(true))
        ) {
            continue;
        }
        let provider_name =
            thinking_alias_provider_name(provider, fallback_provider, provider_index);
        let Some(models) = yaml_mapping_value(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence()
            .ok_or_else(|| format!("{section}.models 必须是数组"))?;
        for (model_index, model) in models.iter().enumerate() {
            let Some((upstream_model, client_model, display_name)) =
                configured_model_identity(model)
            else {
                continue;
            };
            if client_model != upstream_model
                && find_thinking_alias_effort(root, &client_model, protocol).is_some()
            {
                continue;
            }
            sources.push(ResolvedThinkingAliasSource {
                source: ThinkingAliasSource {
                    id: format!("{section}:{provider_index}:{model_index}"),
                    model: client_model,
                    display_name,
                    provider: provider_name.clone(),
                    kind: kind.to_string(),
                    protocol: protocol.to_string(),
                },
                location: ThinkingAliasSourceLocation::ConfigModel {
                    section,
                    provider_index,
                    model_index,
                },
            });
        }
    }
    Ok(())
}

fn thinking_alias_provider_name(
    provider: &serde_norway::Mapping,
    fallback: &str,
    index: usize,
) -> String {
    yaml_mapping_value(provider, "name")
        .or_else(|| yaml_mapping_value(provider, "base-url"))
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{fallback} {}", index + 1))
}

fn configured_model_identity(
    model: &serde_norway::Value,
) -> Option<(String, String, Option<String>)> {
    if let Some(name) = model
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return Some((name.to_string(), name.to_string(), None));
    }
    let model = model.as_mapping()?;
    let name = yaml_mapping_value(model, "name")
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    let alias = yaml_mapping_value(model, "alias")
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|alias| !alias.is_empty());
    let display_name = yaml_mapping_value(model, "display-name")
        .or_else(|| yaml_mapping_value(model, "display_name"))
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some((
        name.to_string(),
        alias.unwrap_or(name).to_string(),
        display_name,
    ))
}

fn thinking_aliases_from_yaml(content: &str) -> Result<Vec<ThinkingAliasEntry>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    thinking_aliases_from_value(&document)
}

fn thinking_aliases_from_value(
    document: &serde_norway::Value,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let mut entries = Vec::new();
    if let Some(oauth_aliases) = yaml_mapping_value(root, "oauth-model-alias") {
        let oauth_aliases = oauth_aliases
            .as_mapping()
            .ok_or_else(|| "oauth-model-alias 必须是 YAML 映射".to_string())?;
        if let Some(codex_aliases) = yaml_mapping_value(oauth_aliases, "codex") {
            let codex_aliases = codex_aliases
                .as_sequence()
                .ok_or_else(|| "oauth-model-alias.codex 必须是数组".to_string())?;
            for entry in codex_aliases {
                let Some(mapping) = entry.as_mapping() else {
                    continue;
                };
                if !matches!(
                    yaml_mapping_value(mapping, "fork"),
                    Some(serde_norway::Value::Bool(true))
                ) {
                    continue;
                }
                let Some(source_model) = yaml_mapping_value(mapping, "name")
                    .and_then(serde_norway::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let Some(alias) = yaml_mapping_value(mapping, "alias")
                    .and_then(serde_norway::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                entries.push(ThinkingAliasEntry {
                    source_model: source_model.to_string(),
                    alias: alias.to_string(),
                    effort: find_thinking_alias_effort(root, alias, "codex"),
                    provider: "Codex OAuth".to_string(),
                    kind: "codex-oauth".to_string(),
                });
            }
        }
    }
    collect_config_thinking_alias_entries(
        root,
        "codex-api-key",
        "Codex API",
        "codex-api",
        "codex",
        &mut entries,
    )?;
    collect_config_thinking_alias_entries(
        root,
        "openai-compatibility",
        "OpenAI 兼容",
        "openai-compatible",
        "openai",
        &mut entries,
    )?;
    entries.sort_by(|left, right| {
        left.provider
            .to_ascii_lowercase()
            .cmp(&right.provider.to_ascii_lowercase())
            .then_with(|| {
                left.alias
                    .to_ascii_lowercase()
                    .cmp(&right.alias.to_ascii_lowercase())
            })
    });
    Ok(entries)
}

fn collect_config_thinking_alias_entries(
    root: &serde_norway::Mapping,
    section: &str,
    fallback_provider: &str,
    kind: &str,
    protocol: &str,
    entries: &mut Vec<ThinkingAliasEntry>,
) -> Result<(), String> {
    let Some(providers) = yaml_mapping_value(root, section) else {
        return Ok(());
    };
    let providers = providers
        .as_sequence()
        .ok_or_else(|| format!("{section} 必须是数组"))?;
    for (provider_index, provider) in providers.iter().enumerate() {
        let Some(provider) = provider.as_mapping() else {
            continue;
        };
        let provider_name =
            thinking_alias_provider_name(provider, fallback_provider, provider_index);
        let Some(models) = yaml_mapping_value(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence()
            .ok_or_else(|| format!("{section}.models 必须是数组"))?;
        for model in models {
            let Some((source_model, alias, _)) = configured_model_identity(model) else {
                continue;
            };
            if source_model == alias {
                continue;
            }
            let Some(effort) = find_thinking_alias_effort(root, &alias, protocol) else {
                continue;
            };
            entries.push(ThinkingAliasEntry {
                source_model,
                alias,
                effort: Some(effort),
                provider: provider_name.clone(),
                kind: kind.to_string(),
            });
        }
    }
    Ok(())
}

fn find_thinking_alias_effort(
    root: &serde_norway::Mapping,
    alias: &str,
    protocol: &str,
) -> Option<String> {
    let rules = nested_yaml_value(root, &["payload", "override"])?.as_sequence()?;
    for rule in rules {
        let Some(rule) = rule.as_mapping() else {
            continue;
        };
        let effort = yaml_mapping_value(rule, "params")
            .and_then(serde_norway::Value::as_mapping)
            .and_then(|params| {
                if protocol.eq_ignore_ascii_case("openai") {
                    yaml_mapping_value(params, "reasoning_effort")
                        .or_else(|| yaml_mapping_value(params, "reasoning.effort"))
                } else {
                    yaml_mapping_value(params, "reasoning.effort")
                }
            })
            .and_then(serde_norway::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(effort) = effort else {
            continue;
        };
        let Some(models) =
            yaml_mapping_value(rule, "models").and_then(serde_norway::Value::as_sequence)
        else {
            continue;
        };
        if models
            .iter()
            .any(|model| thinking_payload_model_matches(model, alias, protocol))
        {
            return Some(effort.to_ascii_lowercase());
        }
    }
    None
}

fn thinking_payload_model_matches(
    model: &serde_norway::Value,
    alias: &str,
    protocol: &str,
) -> bool {
    let Some(model) = model.as_mapping() else {
        return false;
    };
    let name_matches = yaml_mapping_value(model, "name")
        .and_then(serde_norway::Value::as_str)
        .is_some_and(|name| name.trim().eq_ignore_ascii_case(alias));
    let protocol_matches = yaml_mapping_value(model, "protocol")
        .and_then(serde_norway::Value::as_str)
        .is_some_and(|value| value.trim().eq_ignore_ascii_case(protocol));
    name_matches && protocol_matches
}

fn add_thinking_alias_to_yaml(
    content: &str,
    source: &ResolvedThinkingAliasSource,
    alias: &str,
    effort: &str,
) -> Result<String, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;

    if configured_model_alias_exists(root, alias) {
        return Err(format!("别名模型 {alias} 已存在"));
    }

    match &source.location {
        ThinkingAliasSourceLocation::CodexOauth => {
            append_codex_oauth_thinking_alias(root, &source.source.model, alias)?;
        }
        ThinkingAliasSourceLocation::ConfigModel {
            section,
            provider_index,
            model_index,
        } => append_config_thinking_alias(
            root,
            section,
            *provider_index,
            *model_index,
            &source.source.model,
            alias,
            effort,
        )?,
    }

    remove_thinking_payload_model(root, alias)?;
    let payload = root
        .entry(yaml_key("payload"))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "payload 必须是 YAML 映射".to_string())?;
    let override_rules = payload
        .entry(yaml_key("override"))
        .or_insert_with(|| serde_norway::Value::Sequence(Vec::new()))
        .as_sequence_mut()
        .ok_or_else(|| "payload.override 必须是数组".to_string())?;

    let mut model_mapping = serde_norway::Mapping::new();
    model_mapping.insert(
        yaml_key("name"),
        serde_norway::Value::String(alias.to_string()),
    );
    model_mapping.insert(
        yaml_key("protocol"),
        serde_norway::Value::String(source.source.protocol.clone()),
    );
    let mut params_mapping = serde_norway::Mapping::new();
    params_mapping.insert(
        yaml_key(if source.source.protocol == "openai" {
            "reasoning_effort"
        } else {
            "reasoning.effort"
        }),
        serde_norway::Value::String(effort.to_string()),
    );
    if source.source.protocol == "openai"
        && source
            .source
            .model
            .to_ascii_lowercase()
            .starts_with("deepseek")
    {
        params_mapping.insert(
            yaml_key("thinking.type"),
            serde_norway::Value::String("enabled".to_string()),
        );
    }
    let mut rule_mapping = serde_norway::Mapping::new();
    rule_mapping.insert(
        yaml_key("models"),
        serde_norway::Value::Sequence(vec![serde_norway::Value::Mapping(model_mapping)]),
    );
    rule_mapping.insert(
        yaml_key("params"),
        serde_norway::Value::Mapping(params_mapping),
    );
    override_rules.push(serde_norway::Value::Mapping(rule_mapping));

    render_updated_core_yaml(&mut document, updated)
}

fn append_codex_oauth_thinking_alias(
    root: &mut serde_norway::Mapping,
    source_model: &str,
    alias: &str,
) -> Result<(), String> {
    let oauth_aliases = root
        .entry(yaml_key("oauth-model-alias"))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "oauth-model-alias 必须是 YAML 映射".to_string())?;
    let codex_aliases = oauth_aliases
        .entry(yaml_key("codex"))
        .or_insert_with(|| serde_norway::Value::Sequence(Vec::new()))
        .as_sequence_mut()
        .ok_or_else(|| "oauth-model-alias.codex 必须是数组".to_string())?;
    let mut alias_mapping = serde_norway::Mapping::new();
    alias_mapping.insert(
        yaml_key("name"),
        serde_norway::Value::String(source_model.to_string()),
    );
    alias_mapping.insert(
        yaml_key("alias"),
        serde_norway::Value::String(alias.to_string()),
    );
    alias_mapping.insert(yaml_key("fork"), serde_norway::Value::Bool(true));
    codex_aliases.push(serde_norway::Value::Mapping(alias_mapping));
    Ok(())
}

fn append_config_thinking_alias(
    root: &mut serde_norway::Mapping,
    section: &str,
    provider_index: usize,
    model_index: usize,
    expected_model: &str,
    alias: &str,
    effort: &str,
) -> Result<(), String> {
    let providers = yaml_mapping_value_mut(root, section)
        .and_then(serde_norway::Value::as_sequence_mut)
        .ok_or_else(|| format!("{section} 必须是数组"))?;
    let provider = providers
        .get_mut(provider_index)
        .and_then(serde_norway::Value::as_mapping_mut)
        .ok_or_else(|| "模型提供商已经变化，请刷新后重试".to_string())?;
    let models = yaml_mapping_value_mut(provider, "models")
        .and_then(serde_norway::Value::as_sequence_mut)
        .ok_or_else(|| format!("{section}.models 必须是数组"))?;
    let source = models
        .get(model_index)
        .cloned()
        .ok_or_else(|| "原模型已经变化，请刷新后重试".to_string())?;
    let (_, current_model, _) =
        configured_model_identity(&source).ok_or_else(|| "原模型配置格式无效".to_string())?;
    if !current_model.eq_ignore_ascii_case(expected_model) {
        return Err("原模型已经变化，请刷新后重试".to_string());
    }
    let mut alias_model = source.as_mapping().cloned().unwrap_or_else(|| {
        let mut mapping = serde_norway::Mapping::new();
        if let Some(name) = source.as_str() {
            mapping.insert(
                yaml_key("name"),
                serde_norway::Value::String(name.to_string()),
            );
        }
        mapping
    });
    alias_model.insert(
        yaml_key("alias"),
        serde_norway::Value::String(alias.to_string()),
    );
    if let Some(display_name) = yaml_mapping_value(&alias_model, "display-name")
        .and_then(serde_norway::Value::as_str)
        .map(str::to_string)
    {
        alias_model.insert(
            yaml_key("display-name"),
            serde_norway::Value::String(format!("{display_name} ({effort})")),
        );
    }
    let thinking = alias_model
        .entry(yaml_key("thinking"))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "模型 thinking 必须是映射".to_string())?;
    thinking.insert(
        yaml_key("levels"),
        serde_norway::Value::Sequence(vec![serde_norway::Value::String(effort.to_string())]),
    );
    models.push(serde_norway::Value::Mapping(alias_model));
    Ok(())
}

fn remove_thinking_alias_from_yaml(content: &str, alias: &str) -> Result<String, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("解析内核 YAML 配置失败: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;
    let mut removed = false;
    let mut remove_oauth_section = false;
    if let Some(oauth_aliases) = yaml_mapping_value_mut(root, "oauth-model-alias") {
        let oauth_aliases = oauth_aliases
            .as_mapping_mut()
            .ok_or_else(|| "oauth-model-alias 必须是 YAML 映射".to_string())?;
        if let Some(codex_aliases) = yaml_mapping_value_mut(oauth_aliases, "codex") {
            let codex_aliases = codex_aliases
                .as_sequence_mut()
                .ok_or_else(|| "oauth-model-alias.codex 必须是数组".to_string())?;
            codex_aliases.retain(|entry| {
                let matches = entry
                    .as_mapping()
                    .and_then(|mapping| yaml_mapping_value(mapping, "alias"))
                    .and_then(serde_norway::Value::as_str)
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case(alias));
                if matches {
                    removed = true;
                }
                !matches
            });
            if codex_aliases.is_empty() {
                oauth_aliases.remove(yaml_key("codex"));
            }
        }
        remove_oauth_section = oauth_aliases.is_empty();
    }
    removed |= remove_config_thinking_alias(root, "codex-api-key", "codex", alias)?;
    removed |= remove_config_thinking_alias(root, "openai-compatibility", "openai", alias)?;
    if !removed {
        return Err(format!("别名模型 {alias} 不存在，请刷新后重试"));
    }
    if remove_oauth_section {
        root.remove(yaml_key("oauth-model-alias"));
    }
    remove_thinking_payload_model(root, alias)?;
    render_updated_core_yaml(&mut document, updated)
}

fn configured_model_alias_exists(root: &serde_norway::Mapping, alias: &str) -> bool {
    let oauth_exists = yaml_mapping_value(root, "oauth-model-alias")
        .and_then(serde_norway::Value::as_mapping)
        .is_some_and(|channels| {
            channels.values().any(|entries| {
                entries.as_sequence().is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry
                            .as_mapping()
                            .and_then(|mapping| yaml_mapping_value(mapping, "alias"))
                            .and_then(serde_norway::Value::as_str)
                            .is_some_and(|value| value.trim().eq_ignore_ascii_case(alias))
                    })
                })
            })
        });
    oauth_exists
        || ["codex-api-key", "openai-compatibility"]
            .into_iter()
            .filter_map(|section| yaml_mapping_value(root, section))
            .filter_map(serde_norway::Value::as_sequence)
            .flatten()
            .filter_map(serde_norway::Value::as_mapping)
            .filter_map(|provider| yaml_mapping_value(provider, "models"))
            .filter_map(serde_norway::Value::as_sequence)
            .flatten()
            .filter_map(|model| configured_model_identity(model).map(|(_, alias, _)| alias))
            .any(|value| value.eq_ignore_ascii_case(alias))
}

fn remove_config_thinking_alias(
    root: &mut serde_norway::Mapping,
    section: &str,
    protocol: &str,
    alias: &str,
) -> Result<bool, String> {
    if find_thinking_alias_effort(root, alias, protocol).is_none() {
        return Ok(false);
    }
    let Some(providers) = yaml_mapping_value_mut(root, section) else {
        return Ok(false);
    };
    let providers = providers
        .as_sequence_mut()
        .ok_or_else(|| format!("{section} 必须是数组"))?;
    let mut removed = false;
    for provider in providers {
        let Some(provider) = provider.as_mapping_mut() else {
            continue;
        };
        let Some(models) = yaml_mapping_value_mut(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence_mut()
            .ok_or_else(|| format!("{section}.models 必须是数组"))?;
        models.retain(|model| {
            let matches = configured_model_identity(model)
                .map(|(source, model_alias, _)| {
                    source != model_alias && model_alias.eq_ignore_ascii_case(alias)
                })
                .unwrap_or(false);
            removed |= matches;
            !matches
        });
    }
    Ok(removed)
}

fn remove_thinking_payload_model(
    root: &mut serde_norway::Mapping,
    alias: &str,
) -> Result<(), String> {
    let mut remove_payload_section = false;
    if let Some(payload) = yaml_mapping_value_mut(root, "payload") {
        let payload = payload
            .as_mapping_mut()
            .ok_or_else(|| "payload 必须是 YAML 映射".to_string())?;
        if let Some(override_rules) = yaml_mapping_value_mut(payload, "override") {
            let override_rules = override_rules
                .as_sequence_mut()
                .ok_or_else(|| "payload.override 必须是数组".to_string())?;
            let mut next_rules = Vec::with_capacity(override_rules.len());
            for mut rule in std::mem::take(override_rules) {
                let mut removed_from_rule = false;
                let mut models_empty = false;
                if let Some(rule_mapping) = rule.as_mapping_mut() {
                    let has_effort = yaml_mapping_value(rule_mapping, "params")
                        .and_then(serde_norway::Value::as_mapping)
                        .is_some_and(|params| {
                            yaml_mapping_value(params, "reasoning.effort").is_some()
                                || yaml_mapping_value(params, "reasoning_effort").is_some()
                        });
                    if has_effort {
                        if let Some(models) = yaml_mapping_value_mut(rule_mapping, "models") {
                            let models = models
                                .as_sequence_mut()
                                .ok_or_else(|| "payload.override.models 必须是数组".to_string())?;
                            let before = models.len();
                            models.retain(|model| {
                                !thinking_payload_model_matches(model, alias, "codex")
                                    && !thinking_payload_model_matches(model, alias, "openai")
                            });
                            removed_from_rule = models.len() != before;
                            models_empty = models.is_empty();
                        }
                    }
                }
                if !(removed_from_rule && models_empty) {
                    next_rules.push(rule);
                }
            }
            *override_rules = next_rules;
            if override_rules.is_empty() {
                payload.remove(yaml_key("override"));
            }
        }
        remove_payload_section = payload.is_empty();
    }
    if remove_payload_section {
        root.remove(yaml_key("payload"));
    }
    Ok(())
}

fn render_updated_core_yaml(
    document: &mut yaml_serde_edit::YamlValue,
    updated: serde_norway::Value,
) -> Result<String, String> {
    document.set(updated);
    let rendered = document.get_string();
    serde_norway::from_str::<serde_norway::Value>(&rendered)
        .map_err(|error| format!("验证更新后的内核配置失败: {error}"))?;
    Ok(rendered)
}

fn management_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| format!("创建管理 API 客户端失败: {err}"))
}

fn management_authorization(config: &GuiConfigFile) -> Result<String, String> {
    let _ = config;
    Ok(format!("Bearer {DEFAULT_MANAGEMENT_SECRET_KEY}"))
}

fn management_endpoint(config: &GuiConfigFile, path: &str) -> Result<String, String> {
    if config.port == 0 {
        return Err("内核端口无效".to_string());
    }
    let path = path.trim_start_matches('/');
    Ok(format!(
        "http://127.0.0.1:{}/v0/management/{path}",
        config.port
    ))
}

fn normalize_management_oauth_provider(provider: &str) -> Result<String, String> {
    let key = provider.trim().to_ascii_lowercase().replace('_', "-");
    let key = match key.as_str() {
        "claude" | "anthropic" => "anthropic".to_string(),
        "anti-gravity" => "antigravity".to_string(),
        "grok" | "x-ai" | "x.ai" => "xai".to_string(),
        other => other.to_string(),
    };
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("无效的 OAuth 提供商".to_string());
    }
    Ok(key)
}

fn management_oauth_uses_webui_callback(provider_key: &str) -> bool {
    matches!(provider_key, "codex" | "anthropic" | "antigravity" | "xai")
}

async fn read_management_json<T>(response: reqwest::Response) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取管理 API 响应失败: {err}"))?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    if text.trim().is_empty() {
        return Err("管理 API 返回了空响应".to_string());
    }
    serde_json::from_str::<T>(&text).map_err(|err| {
        format!(
            "解析管理 API 响应失败: {err}; body={}",
            truncate_for_error(&text)
        )
    })
}

async fn read_management_value(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取管理 API 响应失败: {err}"))?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(value) => Ok(value),
        Err(_) => Ok(serde_json::Value::String(text)),
    }
}

async fn read_management_text(response: reqwest::Response) -> Result<String, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取管理 API 响应失败: {err}"))?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    Ok(text)
}

fn format_management_error(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value
            .get("error")
            .and_then(|item| item.as_str())
            .or_else(|| value.get("message").and_then(|item| item.as_str()))
        {
            let message = message.trim();
            if !message.is_empty() {
                return format!("管理 API 错误 ({status}): {message}");
            }
        }
    }
    let body = body.trim();
    if body.is_empty() {
        format!("管理 API 错误 ({status})")
    } else {
        format!("管理 API 错误 ({status}): {}", truncate_for_error(body))
    }
}

fn truncate_for_error(value: &str) -> String {
    const LIMIT: usize = 240;
    let trimmed = value.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }
    let shortened: String = trimmed.chars().take(LIMIT).collect();
    format!("{shortened}…")
}

fn open_external_url_inner(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("链接为空".to_string());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("只允许打开 http/https 链接".to_string());
    }

    let result = {
        #[cfg(target_os = "windows")]
        {
            Command::new("cmd")
                .args(["/C", "start", "", url])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
        }
        #[cfg(target_os = "macos")]
        {
            Command::new("open")
                .arg(url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            Command::new("xdg-open")
                .arg(url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
        }
    };

    result
        .map(|_| ())
        .map_err(|err| format!("打开浏览器失败: {err}"))
}

fn validate_core_api_key(api_key: &str) -> Result<(), String> {
    if api_key.is_empty() {
        return Err("鉴权密钥不能为空".to_string());
    }
    if !api_key.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err("鉴权密钥只能包含 ASCII 可见字符，且不能包含空格".to_string());
    }
    if is_example_core_api_key(api_key) {
        return Err("不能使用内核模板里的示例鉴权密钥".to_string());
    }
    Ok(())
}

fn validate_api_key_remark(remark: &str) -> Result<(), String> {
    if remark.chars().count() > 80 {
        return Err("密钥备注不能超过 80 个字符".to_string());
    }
    if remark.chars().any(char::is_control) {
        return Err("密钥备注不能包含换行或控制字符".to_string());
    }
    Ok(())
}

fn validate_management_secret_key(secret_key: &str) -> Result<(), String> {
    if secret_key != DEFAULT_MANAGEMENT_SECRET_KEY {
        return Err("管理密钥统一固定为 123456".to_string());
    }
    Ok(())
}

fn is_example_core_api_key(api_key: &str) -> bool {
    let value = api_key.trim();
    value == "your-api-key" || value.starts_with("your-api-key-")
}

fn is_hashed_management_secret_key(secret_key: &str) -> bool {
    let value = secret_key.trim();
    value.starts_with("$2a$")
        || value.starts_with("$2b$")
        || value.starts_with("$2y$")
        || value.starts_with("$argon2")
        || value.starts_with("$scrypt$")
        || value.starts_with("bcrypt:")
        || value.starts_with("argon2:")
        || value.starts_with("argon2id:")
        || value.starts_with("sha256:")
        || value.starts_with("sha512:")
}

fn validate_routing_strategy(strategy: &str) -> Result<(), String> {
    if matches!(strategy, "round-robin" | "fill-first") {
        return Ok(());
    }
    Err("路由策略只支持 round-robin 或 fill-first".to_string())
}

fn merge_core_config_yaml(
    template: &str,
    current: Option<&str>,
    config: &GuiConfigFile,
) -> Result<String, String> {
    let template_value = serde_norway::from_str::<serde_norway::Value>(template)
        .map_err(|err| format!("解析内核配置模板失败: {err}"))?;
    let mut merged = template_value.clone();

    if let Some(current) = current {
        let current = serde_norway::from_str::<serde_norway::Value>(current)
            .map_err(|err| format!("解析现有内核配置失败: {err}"))?;
        merge_yaml_values(&mut merged, current);
    }

    let merged = render_yaml_value_changes(template, &template_value, &merged)?;
    apply_gui_managed_settings(&merged, config)
}

fn patch_core_network_yaml(
    content: &str,
    config: &GuiConfigFile,
) -> Result<Option<String>, String> {
    patch_core_yaml_document(content, |document| {
        let original = document.clone();
        apply_network_settings(document, config)?;
        Ok(*document != original)
    })
}

fn merge_yaml_values(base: &mut serde_norway::Value, current: serde_norway::Value) {
    match (base, current) {
        (
            serde_norway::Value::Mapping(base_mapping),
            serde_norway::Value::Mapping(current_mapping),
        ) => {
            for (key, current_value) in current_mapping {
                if let Some(base_value) = base_mapping.get_mut(&key) {
                    merge_yaml_values(base_value, current_value);
                } else {
                    base_mapping.insert(key, current_value);
                }
            }
        }
        (base, current) => *base = current,
    }
}

fn apply_network_settings(
    document: &mut serde_norway::Value,
    config: &GuiConfigFile,
) -> Result<(), String> {
    let mapping = document
        .as_mapping_mut()
        .ok_or_else(|| "内核配置顶层必须是 YAML 映射".to_string())?;

    let host = if config.allow_lan {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    mapping.insert(
        serde_norway::Value::String("host".to_string()),
        serde_norway::Value::String(host.to_string()),
    );
    mapping.insert(
        serde_norway::Value::String("port".to_string()),
        serde_norway::to_value(config.port).map_err(|err| format!("序列化内核端口失败: {err}"))?,
    );
    Ok(())
}

fn apply_gui_managed_settings(content: &str, config: &GuiConfigFile) -> Result<String, String> {
    let host = if config.allow_lan {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let updated = patch_core_yaml_document(content, |document| {
        let mut changed = false;
        changed |= set_core_yaml_top_level_value(
            document,
            "host",
            serde_norway::Value::String(host.to_string()),
        )?;
        changed |= set_core_yaml_top_level_value(
            document,
            "port",
            serde_norway::to_value(config.port)
                .map_err(|err| format!("序列化内核端口失败: {err}"))?,
        )?;
        changed |= set_core_yaml_top_level_value(
            document,
            "auth-dir",
            serde_norway::Value::String(config.auth_dir.clone()),
        )?;
        changed |= set_core_yaml_top_level_value(
            document,
            "usage-statistics-enabled",
            serde_norway::Value::Bool(true),
        )?;
        changed |= set_core_yaml_nested_value(
            document,
            "remote-management",
            "secret-key",
            serde_norway::Value::String(DEFAULT_MANAGEMENT_SECRET_KEY.to_string()),
        )?;
        changed |= set_core_yaml_nested_value(
            document,
            "plugins",
            "enabled",
            serde_norway::Value::Bool(config.plugins_enabled),
        )?;
        changed |= set_core_yaml_nested_value(
            document,
            "routing",
            "strategy",
            serde_norway::Value::String(config.routing_strategy.clone()),
        )?;
        Ok(changed)
    })?
    .unwrap_or_else(|| content.to_string());

    let updated = patch_core_api_keys_yaml(&updated, &gui_api_key_values(&config.api_keys))?;
    serde_norway::from_str::<serde_norway::Value>(&updated)
        .map_err(|err| format!("验证启动内核配置失败: {err}"))?;
    Ok(updated)
}

fn write_bytes_atomically(path: &Path, content: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory)
        .map_err(|error| format!("创建配置目录失败 {}: {error}", path_to_string(directory)))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.yaml");
    let temporary_path = directory.join(format!(
        ".{file_name}.tmp.{}.{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));

    let write_result = (|| -> io::Result<()> {
        let mut file = File::create(&temporary_path)?;
        file.write_all(content)?;
        file.sync_all()?;
        replace_file_atomically(&temporary_path, path)
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "原子写入配置失败 {}: {error}",
            path_to_string(path)
        ));
    }

    Ok(())
}

fn write_yaml_if_changed(path: &Path, content: &str) -> Result<bool, String> {
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(false);
    }

    write_bytes_atomically(path, content.as_bytes())?;

    Ok(true)
}

#[cfg(not(windows))]
fn replace_file_atomically(temporary_path: &Path, destination_path: &Path) -> io::Result<()> {
    fs::rename(temporary_path, destination_path)
}

#[cfg(windows)]
fn replace_file_atomically(temporary_path: &Path, destination_path: &Path) -> io::Result<()> {
    if !destination_path.exists() {
        return fs::rename(temporary_path, destination_path);
    }

    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let destination = destination_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let replacement = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            replacement.as_ptr(),
            ptr::null(),
            0,
            ptr::null(),
            ptr::null(),
        )
    };

    if replaced == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(())
}

fn fixed_oauth_dir() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(OAUTH_DIR_NAME))
}

fn ensure_fixed_oauth_dir() -> Result<PathBuf, String> {
    let directory = fixed_oauth_dir()?;
    fs::create_dir_all(&directory)
        .map_err(|err| format!("创建固定凭证目录失败 {}: {err}", path_to_string(&directory)))?;
    Ok(directory)
}

fn load_or_create_gui_config() -> Result<GuiConfigFile, String> {
    ensure_fixed_oauth_dir()?;
    let config_path = gui_config_path()?;
    let legacy_config_path = legacy_gui_config_path()?;

    let (mut config, presence, mut changed) = if config_path.is_file() {
        let content = fs::read_to_string(&config_path)
            .map_err(|err| format!("读取 GUI 配置失败 {}: {err}", path_to_string(&config_path)))?;
        let config = toml::from_str::<GuiConfigFile>(&content)
            .map_err(|err| format!("解析 GUI 配置失败: {err}"))?;
        let presence = toml::from_str::<GuiConfigPresence>(&content)
            .map_err(|err| format!("解析 GUI 配置字段失败: {err}"))?;
        (config, presence, false)
    } else if legacy_config_path.is_file() {
        let content = fs::read_to_string(&legacy_config_path).map_err(|err| {
            format!(
                "读取旧 GUI 配置失败 {}: {err}",
                path_to_string(&legacy_config_path)
            )
        })?;
        let config = serde_yaml::from_str::<GuiConfigFile>(&content)
            .map_err(|err| format!("解析旧 GUI 配置失败: {err}"))?;
        let presence = serde_yaml::from_str::<GuiConfigPresence>(&content)
            .map_err(|err| format!("解析旧 GUI 配置字段失败: {err}"))?;
        (config, presence, true)
    } else {
        (GuiConfigFile::default(), GuiConfigPresence::default(), true)
    };

    let missing_core_settings = presence.api_keys.is_none()
        || presence.management_secret_key.is_none()
        || presence.plugins_enabled.is_none()
        || presence.routing_strategy.is_none();
    if missing_core_settings {
        if let Ok(core_settings) = read_installed_core_config_settings() {
            if presence.api_keys.is_none() {
                config.api_keys = merge_core_api_keys_with_gui_metadata(
                    &config.api_keys,
                    &core_settings.api_keys,
                    None,
                );
            }
            if presence.plugins_enabled.is_none() {
                config.plugins_enabled = core_settings.plugins_enabled;
            }
            if presence.routing_strategy.is_none() {
                config.routing_strategy = core_settings.routing_strategy;
            }
        }
        changed = true;
    }
    if presence.auth_dir.is_none() {
        changed = true;
    }
    changed |= sanitize_gui_config(&mut config)?;
    validate_gui_config(&config)?;
    if changed {
        write_gui_config(&config)?;
    }
    patch_core_auth_dir(&config.auth_dir)?;
    patch_core_api_keys(&gui_api_key_values(&config.api_keys))?;
    Ok(config)
}

#[cfg(test)]
fn apply_core_settings_to_gui_config(
    config: &mut GuiConfigFile,
    core_settings: &CoreConfigSettings,
) {
    config.api_keys =
        merge_core_api_keys_with_gui_metadata(&config.api_keys, &core_settings.api_keys, None);
    config.management_secret_key = DEFAULT_MANAGEMENT_SECRET_KEY.to_string();
    config.plugins_enabled = core_settings.plugins_enabled;
    config.routing_strategy = core_settings.routing_strategy.clone();
}

fn built_in_api_key_entry() -> GuiApiKeyEntry {
    GuiApiKeyEntry {
        key: DEFAULT_API_KEY.to_string(),
        remark: DEFAULT_API_KEY_REMARK.to_string(),
    }
}

fn gui_api_key_values(entries: &[GuiApiKeyEntry]) -> Vec<String> {
    entries.iter().map(|entry| entry.key.clone()).collect()
}

fn merge_core_api_keys_with_gui_metadata(
    existing: &[GuiApiKeyEntry],
    core_api_keys: &[String],
    added_api_key: Option<&GuiApiKeyEntry>,
) -> Vec<GuiApiKeyEntry> {
    let mut merged = vec![built_in_api_key_entry()];

    for api_key in core_api_keys {
        let api_key = api_key.trim();
        if api_key.is_empty() || api_key == DEFAULT_API_KEY || is_example_core_api_key(api_key) {
            continue;
        }
        if merged.iter().any(|entry| entry.key == api_key) {
            continue;
        }

        let remark = added_api_key
            .filter(|entry| entry.key == api_key)
            .map(|entry| entry.remark.clone())
            .or_else(|| {
                existing
                    .iter()
                    .find(|entry| entry.key == api_key)
                    .map(|entry| entry.remark.clone())
            })
            .unwrap_or_default();
        merged.push(GuiApiKeyEntry {
            key: api_key.to_string(),
            remark,
        });
    }

    merged
}

fn sanitize_gui_config(config: &mut GuiConfigFile) -> Result<bool, String> {
    let mut changed = false;
    let original_api_keys = config.api_keys.clone();
    let configured_keys = config
        .api_keys
        .iter()
        .map(|entry| entry.key.trim().to_string())
        .collect::<Vec<_>>();
    config.api_keys =
        merge_core_api_keys_with_gui_metadata(&config.api_keys, &configured_keys, None);
    for entry in &mut config.api_keys {
        entry.key = entry.key.trim().to_string();
        entry.remark = entry.remark.trim().to_string();
        if entry.key == DEFAULT_API_KEY {
            entry.remark = DEFAULT_API_KEY_REMARK.to_string();
        }
    }
    if config.api_keys != original_api_keys {
        changed = true;
    }
    if config.management_secret_key != DEFAULT_MANAGEMENT_SECRET_KEY {
        config.management_secret_key = DEFAULT_MANAGEMENT_SECRET_KEY.to_string();
        changed = true;
    }
    let auth_dir = path_to_string(&fixed_oauth_dir()?);
    if config.auth_dir != auth_dir {
        config.auth_dir = auth_dir;
        changed = true;
    }
    Ok(changed)
}

fn write_gui_config(config: &GuiConfigFile) -> Result<(), String> {
    validate_gui_config(config)?;
    let config_path = gui_config_path()?;
    let content =
        toml::to_string_pretty(config).map_err(|err| format!("序列化 GUI 配置失败: {err}"))?;
    write_yaml_if_changed(&config_path, &content).map(|_| ())
}

fn validate_gui_config(config: &GuiConfigFile) -> Result<(), String> {
    if config.port == 0 {
        return Err("GUI 配置端口必须在 1 到 65535 之间".to_string());
    }
    for entry in &config.api_keys {
        validate_core_api_key(&entry.key)?;
        validate_api_key_remark(&entry.remark)?;
    }
    if config.routing_strategy.trim().is_empty() {
        return Err("GUI 配置路由策略不能为空".to_string());
    }
    let expected_auth_dir = fixed_oauth_dir()?;
    if Path::new(&config.auth_dir) != expected_auth_dir.as_path() {
        return Err(format!(
            "凭证目录固定为 {}，不允许自定义",
            path_to_string(&expected_auth_dir)
        ));
    }
    validate_management_secret_key(&config.management_secret_key)?;

    Ok(())
}

fn gui_config_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(GUI_CONFIG_FILE))
}

fn legacy_gui_config_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join(LEGACY_GUI_CONFIG_FILE))
}

fn stop_core_process_inner(process_state: &CoreProcessState) -> Result<(), String> {
    if let Some(mut child) = process_state.take_child() {
        terminate_child(&mut child)?;
        process_state.clear_lifetime_guard();
        return Ok(());
    }

    let install_dir = core_install_dir()?;
    let binary_path = find_core_binary(&install_dir)
        .ok_or_else(|| "未安装 CPA 内核，请先安装最新版".to_string())?;
    let process_ids = find_core_process_ids(&binary_path);

    if process_ids.is_empty() {
        return Err("CPA 内核当前未运行".to_string());
    }

    for process_id in process_ids {
        terminate_process_id(process_id)?;
    }

    Ok(())
}

fn core_install_dir() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join("cpa-core"))
}

fn core_base_dir() -> Result<PathBuf, String> {
    let exe_path = env::current_exe().map_err(|err| format!("读取当前程序路径失败: {err}"))?;
    exe_path
        .parent()
        .map(|path| path.to_path_buf())
        .ok_or_else(|| format!("当前程序路径没有父目录: {}", path_to_string(&exe_path)))
}

fn bundled_core_archive() -> Result<Option<(BundledCoreInfo, PathBuf)>, String> {
    let platform = current_core_platform()?;
    let base_dir = core_base_dir()?;
    let mut locations = vec![(base_dir.join(CORE_VERSION_FILE), base_dir.join("cpa-core"))];
    if let Some(project_root) = source_project_root(&base_dir) {
        if project_root != base_dir {
            locations.push((
                project_root.join(CORE_VERSION_FILE),
                project_root.join("cpa-core"),
            ));
        }
    }

    let configured_version = locations.iter().find_map(|(version_path, _)| {
        fs::read_to_string(version_path)
            .ok()
            .map(|value| normalize_version(value.trim()))
            .filter(|value| value != "v")
    });
    if let Some(version) = configured_version {
        let asset_name = core_release_asset_name(&version, &platform);
        for (_, archive_dir) in &locations {
            let archive_path = archive_dir.join(&asset_name);
            if !archive_path.is_file() {
                continue;
            }
            let size_bytes = fs::metadata(&archive_path)
                .map_err(|error| format!("读取内置内核信息失败: {error}"))?
                .len();
            return Ok(Some((
                BundledCoreInfo {
                    version,
                    asset_name,
                    size_bytes,
                },
                archive_path,
            )));
        }
        return Ok(None);
    }

    let suffix = format!(
        "_{}_{}.{}",
        platform.asset_os, platform.asset_arch, platform.archive_kind
    );
    let mut matches = Vec::new();
    for (_, archive_dir) in &locations {
        if !archive_dir.is_dir() {
            continue;
        }
        for entry in fs::read_dir(archive_dir)
            .map_err(|error| format!("读取内置内核目录失败: {error}"))?
            .filter_map(Result::ok)
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.path().is_file()
                || !name.starts_with("CLIProxyAPI_")
                || !name.ends_with(&suffix)
                || name.contains("_no-plugin")
            {
                continue;
            }
            let Some(version) = name
                .strip_prefix("CLIProxyAPI_")
                .and_then(|value| value.strip_suffix(&suffix))
            else {
                continue;
            };
            let version = normalize_version(version);
            if matches.iter().any(|(existing, _, _)| existing == &version) {
                continue;
            }
            matches.push((version, name, entry.path()));
        }
    }
    matches.sort_by(|left, right| left.0.cmp(&right.0));
    if matches.len() > 1 {
        return Err(format!(
            "发现多个匹配当前平台的内置内核，请在 {} 中指定发行版本",
            CORE_VERSION_FILE
        ));
    }
    let Some((version, asset_name, archive_path)) = matches.pop() else {
        return Ok(None);
    };
    let size_bytes = fs::metadata(&archive_path)
        .map_err(|error| format!("读取内置内核信息失败: {error}"))?
        .len();
    Ok(Some((
        BundledCoreInfo {
            version,
            asset_name,
            size_bytes,
        },
        archive_path,
    )))
}

fn source_project_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|directory| {
        (directory.join("package.json").is_file() && directory.join("src-tauri").is_dir())
            .then(|| directory.to_path_buf())
    })
}

fn preserve_bundled_core_assets(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    if !source_dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source_dir)
        .map_err(|error| format!("读取内置内核文件失败: {error}"))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_archive = name.starts_with("CLIProxyAPI_")
            && (name.ends_with(".tar.gz") || name.ends_with(".zip"))
            && !name.contains("_no-plugin");
        if !is_archive && name != CORE_CHECKSUMS_FILE {
            continue;
        }
        fs::copy(&path, target_dir.join(&name))
            .map_err(|error| format!("保留内置内核文件 {name} 失败: {error}"))?;
    }
    Ok(())
}

fn preserve_selected_bundled_core_asset(
    archive_path: &Path,
    target_dir: &Path,
) -> Result<(), String> {
    let archive_name = archive_path
        .file_name()
        .ok_or_else(|| "内置内核压缩包文件名无效".to_string())?;
    fs::copy(archive_path, target_dir.join(archive_name))
        .map_err(|error| format!("保留所选内置内核压缩包失败: {error}"))?;
    if let Some(source_dir) = archive_path.parent() {
        let checksums = source_dir.join(CORE_CHECKSUMS_FILE);
        if checksums.is_file() {
            fs::copy(&checksums, target_dir.join(CORE_CHECKSUMS_FILE))
                .map_err(|error| format!("保留内置内核校验文件失败: {error}"))?;
        }
    }
    Ok(())
}

fn preserve_core_runtime_files(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    if !source_dir.is_dir() {
        return Ok(());
    }
    let source = source_dir.join(CORE_CONFIG_FILE);
    if source.is_file() {
        fs::copy(&source, target_dir.join(CORE_CONFIG_FILE))
            .map_err(|error| format!("保留内核配置文件失败: {error}"))?;
    }
    Ok(())
}

fn validate_bundled_core_checksum(archive_path: &Path) -> Result<(), String> {
    let Some(directory) = archive_path.parent() else {
        return Err("内置内核压缩包没有父目录".to_string());
    };
    let checksums_path = directory.join(CORE_CHECKSUMS_FILE);
    if !checksums_path.is_file() {
        return Ok(());
    }
    let archive_name = archive_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "内置内核压缩包文件名无效".to_string())?;
    let checksums = fs::read_to_string(&checksums_path)
        .map_err(|error| format!("读取内置内核校验文件失败: {error}"))?;
    let expected = checksums.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let digest = fields.next()?;
        let name = fields.next()?.trim_start_matches('*');
        (name == archive_name && digest.len() == 64).then(|| digest.to_ascii_lowercase())
    });
    let Some(expected) = expected else {
        return Err(format!("校验文件中没有 {archive_name} 的 SHA-256"));
    };
    let actual = sha256_file(archive_path)?;
    if actual != expected {
        return Err("内置内核压缩包 SHA-256 校验失败".to_string());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("打开校验文件失败: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取校验文件失败: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_core_metadata(install_dir: &Path) -> Option<CoreMetadata> {
    let metadata_path = install_dir.join(CORE_METADATA_FILE);
    let content = fs::read_to_string(metadata_path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_core_metadata(install_dir: &Path, metadata: &CoreMetadata) -> Result<(), String> {
    let metadata_path = install_dir.join(CORE_METADATA_FILE);
    let content = serde_json::to_string_pretty(metadata)
        .map_err(|err| format!("生成内核元数据失败: {err}"))?;
    fs::write(metadata_path, content).map_err(|err| format!("写入内核元数据失败: {err}"))
}

fn validate_downloaded_asset(
    asset: &GithubAsset,
    downloaded: &DownloadedArchive,
) -> Result<(), String> {
    validate_download_metadata(
        downloaded.size,
        asset.size,
        &downloaded.sha256,
        asset.digest.as_deref(),
    )
}

fn validate_download_metadata(
    downloaded: u64,
    expected_total: Option<u64>,
    sha256: &str,
    expected_digest: Option<&str>,
) -> Result<(), String> {
    if let Some(expected_total) = expected_total {
        if downloaded != expected_total {
            return Err(format!(
                "下载大小校验失败: 实际 {downloaded} 字节，期望 {expected_total} 字节"
            ));
        }
    }

    if let Some(expected_digest) = expected_digest {
        let expected = expected_digest
            .strip_prefix("sha256:")
            .unwrap_or(expected_digest)
            .to_ascii_lowercase();

        if !expected.is_empty() && sha256 != expected {
            return Err("下载文件 SHA-256 校验失败".to_string());
        }
    }

    Ok(())
}

fn cleanup_core_work_dirs() -> Result<(), String> {
    let base_dir = core_base_dir()?;
    let mut last_error = None;

    for name in ["cpa-core.staging", "cpa-core.download"] {
        let path = base_dir.join(name);
        if path.exists() {
            if let Err(err) = fs::remove_dir_all(&path) {
                last_error = Some(format!("清理临时目录失败 {}: {err}", path_to_string(&path)));
            }
        }
    }

    if let Some(error) = last_error {
        Err(error)
    } else {
        Ok(())
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn normalize_version(version: &str) -> String {
    let version = version.trim();

    if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    }
}

fn is_core_running(binary_path: &Path) -> bool {
    !find_core_process_ids(binary_path).is_empty()
}

fn find_core_process_ids(binary_path: &Path) -> Vec<u32> {
    #[cfg(target_os = "linux")]
    {
        find_core_process_ids_linux(binary_path)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = binary_path;
        find_core_process_ids_by_name()
    }
}

#[cfg(target_os = "linux")]
fn find_core_process_ids_linux(binary_path: &Path) -> Vec<u32> {
    let Ok(expected) = fs::canonicalize(binary_path) else {
        return Vec::new();
    };
    let output = Command::new("pgrep")
        .args(["-x", core_binary_name()])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .filter(|pid| {
            fs::read_link(format!("/proc/{pid}/exe"))
                .ok()
                .and_then(|path| fs::canonicalize(path).ok())
                .map(|path| path == expected)
                .unwrap_or(false)
        })
        .collect()
}

#[cfg(all(not(target_os = "linux"), target_os = "windows"))]
fn find_core_process_ids_by_name() -> Vec<u32> {
    let image_name = core_binary_name();
    let filter = format!("IMAGENAME eq {image_name}");
    let output = Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let columns = line
                .trim()
                .trim_matches('"')
                .split("\",\"")
                .collect::<Vec<_>>();
            let name = columns.first()?;
            let pid = columns.get(1)?;

            name.eq_ignore_ascii_case(image_name)
                .then(|| pid.parse::<u32>().ok())
                .flatten()
        })
        .collect()
}

#[cfg(all(not(target_os = "linux"), not(target_os = "windows")))]
fn find_core_process_ids_by_name() -> Vec<u32> {
    Command::new("pgrep")
        .args(["-x", core_binary_name()])
        .output()
        .ok()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn shutdown_managed_core(process_state: &CoreProcessState, gui_config_state: &GuiConfigState) {
    let was_running = process_state.managed_pid().is_some();
    let _ = gui_config_state.set_run_on_startup(was_running);

    if let Some(mut child) = process_state.take_child() {
        let _ = terminate_child(&mut child);
    }
    process_state.clear_lifetime_guard();
}

#[cfg(windows)]
fn attach_child_to_windows_job(child: &Child) -> Result<isize, String> {
    use std::{mem, os::windows::io::AsRawHandle, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    unsafe {
        let job = CreateJobObjectW(ptr::null(), ptr::null());
        if job.is_null() {
            return Err(format!(
                "创建 CPA 内核进程作业失败: {}",
                io::Error::last_os_error()
            ));
        }

        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &information as *const _ as *const _,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            let error = io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!("配置 CPA 内核进程作业失败: {error}"));
        }

        let process_handle = child.as_raw_handle() as HANDLE;
        if AssignProcessToJobObject(job, process_handle) == 0 {
            let error = io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!("托管 CPA 内核子进程失败: {error}"));
        }

        Ok(job as isize)
    }
}

#[cfg(windows)]
fn close_windows_handle(handle: isize) {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

    unsafe {
        CloseHandle(handle as HANDLE);
    }
}

fn terminate_child(child: &mut Child) -> Result<(), String> {
    #[cfg(windows)]
    {
        child
            .kill()
            .map_err(|err| format!("关闭 CPA 内核进程失败: {err}"))?;
        child
            .wait()
            .map_err(|err| format!("等待 CPA 内核进程退出失败: {err}"))?;
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let process_id = child.id();
        send_process_signal(process_id, "TERM")?;

        for _ in 0..20 {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(err) => return Err(format!("检查 CPA 内核进程状态失败: {err}")),
            }
        }

        child
            .kill()
            .map_err(|err| format!("强制关闭 CPA 内核进程失败: {err}"))?;
        child
            .wait()
            .map_err(|err| format!("等待 CPA 内核进程退出失败: {err}"))?;

        Ok(())
    }
}

fn terminate_process_id(process_id: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let process_id = process_id.to_string();
        let status = Command::new("taskkill")
            .args(["/PID", &process_id, "/T", "/F"])
            .status()
            .map_err(|err| format!("关闭 CPA 内核进程失败: {err}"))?;

        if status.success() {
            return Ok(());
        }

        return Err(format!("关闭 CPA 内核进程失败: PID {process_id}"));
    }

    #[cfg(not(windows))]
    {
        send_process_signal(process_id, "TERM")?;

        for _ in 0..20 {
            if !is_process_alive(process_id) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }

        send_process_signal(process_id, "KILL")
    }
}

#[cfg(not(windows))]
fn send_process_signal(process_id: u32, signal: &str) -> Result<(), String> {
    let status = Command::new("kill")
        .args([format!("-{signal}"), process_id.to_string()])
        .status()
        .map_err(|err| format!("发送进程信号失败: {err}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("发送进程信号失败: PID {process_id}"))
    }
}

#[cfg(not(windows))]
fn is_process_alive(process_id: u32) -> bool {
    let process_id = process_id.to_string();
    Command::new("kill")
        .args(["-0", &process_id])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn reset_dir(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|err| format!("清理目录失败 {}: {err}", path_to_string(path)))?;
    }

    fs::create_dir_all(path).map_err(|err| format!("创建目录失败 {}: {err}", path_to_string(path)))
}

fn replace_install_dir(
    install_dir: &Path,
    staging_dir: &Path,
    backup_dir: &Path,
) -> Result<(), String> {
    if backup_dir.exists() {
        fs::remove_dir_all(backup_dir).map_err(|err| format!("清理备份目录失败: {err}"))?;
    }

    if install_dir.exists() {
        fs::rename(install_dir, backup_dir)
            .map_err(|err| format!("备份旧内核目录失败，请确认 CPA 内核未运行: {err}"))?;
    }

    if let Err(err) = fs::rename(staging_dir, install_dir) {
        if backup_dir.exists() {
            let _ = fs::rename(backup_dir, install_dir);
        }

        return Err(format!("切换新内核目录失败: {err}"));
    }

    if backup_dir.exists() {
        fs::remove_dir_all(backup_dir).map_err(|err| format!("删除旧内核备份目录失败: {err}"))?;
    }

    Ok(())
}

fn extract_tar_gz(archive_path: &Path, install_dir: &Path) -> Result<(), String> {
    let archive_file =
        File::open(archive_path).map_err(|err| format!("打开 tar.gz 失败: {err}"))?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|err| format!("读取 tar.gz 条目失败: {err}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|err| format!("读取 tar.gz 条目失败: {err}"))?;
        let entry_path = entry
            .path()
            .map_err(|err| format!("读取 tar.gz 条目路径失败: {err}"))?;
        let out_path = checked_archive_path(install_dir, entry_path.as_ref())?;
        let entry_type = entry.header().entry_type();

        if entry_type.is_dir() {
            fs::create_dir_all(&out_path).map_err(|err| format!("创建目录失败: {err}"))?;
        } else if entry_type.is_file() {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
            }
            entry
                .unpack(&out_path)
                .map_err(|err| format!("解压 tar.gz 文件失败: {err}"))?;
        } else {
            return Err(format!(
                "tar.gz 包含不支持的条目类型: {}",
                path_to_string(&out_path)
            ));
        }
    }

    Ok(())
}

fn extract_zip(archive_path: &Path, install_dir: &Path) -> Result<(), String> {
    let archive_file = File::open(archive_path).map_err(|err| format!("打开 zip 失败: {err}"))?;
    let mut archive =
        ZipArchive::new(archive_file).map_err(|err| format!("读取 zip 失败: {err}"))?;

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("读取 zip 条目失败: {err}"))?;
        let enclosed_name = file
            .enclosed_name()
            .ok_or_else(|| format!("zip 条目路径不安全: {}", file.name()))?;
        let out_path = checked_archive_path(install_dir, &enclosed_name)?;

        if is_zip_symlink(&file) {
            return Err(format!("zip 包含不支持的符号链接条目: {}", file.name()));
        }

        if file.is_dir() {
            fs::create_dir_all(&out_path).map_err(|err| format!("创建目录失败: {err}"))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("创建目录失败: {err}"))?;
        }

        let mut out_file = File::create(&out_path).map_err(|err| format!("创建文件失败: {err}"))?;
        io::copy(&mut file, &mut out_file).map_err(|err| format!("写入文件失败: {err}"))?;

        #[cfg(unix)]
        if let Some(mode) = file.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&out_path, fs::Permissions::from_mode(mode))
                .map_err(|err| format!("设置文件权限失败: {err}"))?;
        }
    }

    Ok(())
}

fn checked_archive_path(base_dir: &Path, entry_path: &Path) -> Result<PathBuf, String> {
    if entry_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "压缩包条目路径不安全: {}",
            path_to_string(entry_path)
        ));
    }

    Ok(base_dir.join(entry_path))
}

fn is_zip_symlink(file: &zip::read::ZipFile<'_>) -> bool {
    file.unix_mode()
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
}

fn find_core_binary(install_dir: &Path) -> Option<PathBuf> {
    let binary_path = install_dir.join(core_binary_name());
    if binary_path.is_file() {
        return Some(binary_path);
    }

    let mut dirs = vec![install_dir.to_path_buf()];

    while let Some(dir) = dirs.pop() {
        let entries = fs::read_dir(dir).ok()?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else if path
                .file_name()
                .and_then(|file_name| file_name.to_str())
                .map(|file_name| file_name == core_binary_name())
                .unwrap_or(false)
            {
                return Some(path);
            }
        }
    }

    None
}

fn core_binary_name() -> &'static str {
    if env::consts::OS == "windows" {
        "cli-proxy-api.exe"
    } else {
        "cli-proxy-api"
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn main() {
    let gui_config = match load_or_create_gui_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            let mut config = GuiConfigFile::default();
            if let Err(sanitize_error) = sanitize_gui_config(&mut config) {
                eprintln!("初始化固定凭证目录失败: {sanitize_error}");
            }
            config
        }
    };

    let app = tauri::Builder::default()
        .manage(CoreDownloadState::default())
        .manage(CoreProcessState::default())
        .manage(usage::UsageCollectorState::default())
        .manage(GuiConfigState::new(gui_config))
        .setup(|app| {
            if let Err(error) = usage::initialize_usage_storage() {
                eprintln!("初始化使用记录目录失败: {error}");
            }
            usage::start_usage_collector(app.handle().clone());
            let gui_config_state = app.state::<GuiConfigState>();
            let process_state = app.state::<CoreProcessState>();
            let config = gui_config_state.snapshot().map_err(io::Error::other)?;

            if config.run_on_startup {
                if let Err(error) = start_core_process_inner(process_state.inner(), &config) {
                    eprintln!("自动启动 CPA 内核失败: {error}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            detect_core_platform,
            get_core_status,
            get_gui_settings,
            get_agent_config_statuses,
            get_agent_models,
            get_thinking_aliases,
            get_thinking_alias_sources,
            create_thinking_alias,
            delete_thinking_alias,
            set_agent_config_enabled,
            update_agent_config,
            launch_agent,
            get_lan_ipv4,
            save_gui_settings,
            get_core_config_settings,
            add_core_api_key,
            delete_core_api_key,
            set_core_management_secret_key,
            clear_core_management_secret_key,
            management_request,
            upload_auth_file,
            download_auth_file,
            set_core_plugins_enabled,
            set_core_routing_strategy,
            start_oauth_login,
            get_oauth_status,
            submit_oauth_callback,
            open_external_url,
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
            start_core_process,
            stop_core_process,
            restart_core_process
        ])
        .build(tauri::generate_context!())
        .expect("failed to build app");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            usage::stop_usage_collector(app_handle);
            let process_state = app_handle.state::<CoreProcessState>();
            let gui_config_state = app_handle.state::<GuiConfigState>();
            shutdown_managed_core(process_state.inner(), gui_config_state.inner());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_test_home(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "cpa-gui-agent-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn test_agent_models(names: &[&str]) -> Vec<AgentModelOption> {
        names
            .iter()
            .map(|name| AgentModelOption {
                name: (*name).to_string(),
                alias: None,
            })
            .collect()
    }

    fn test_codex_models(names: &[&str]) -> Vec<CodexModelCatalogSpec> {
        merge_codex_model_catalog_specs(&test_agent_models(names), &[])
    }

    fn test_codex_oauth_thinking_source(model: &str) -> ResolvedThinkingAliasSource {
        ResolvedThinkingAliasSource {
            source: ThinkingAliasSource {
                id: format!("codex-oauth:{model}"),
                model: model.to_string(),
                display_name: None,
                provider: "Codex OAuth".to_string(),
                kind: "codex-oauth".to_string(),
                protocol: "codex".to_string(),
            },
            location: ThinkingAliasSourceLocation::CodexOauth,
        }
    }

    #[test]
    fn gui_config_defaults_are_stable() {
        let config = GuiConfigFile::default();
        let content = toml::to_string_pretty(&config).unwrap();

        assert!(content.contains("port = 8317"));
        assert!(content.contains("allow-lan = false"));
        assert!(content.contains("run-on-startup = false"));
        assert!(content.contains("auth-dir = "));
        assert!(content.contains("[[api-keys]]"));
        assert!(content.contains("key = \"123456\""));
        assert!(content.contains("remark = \"内置密钥\""));
        assert!(content.contains("management-secret-key = \"123456\""));
        assert!(content.contains("plugins-enabled = false"));
        assert!(content.contains("routing-strategy = \"round-robin\""));
    }

    #[test]
    fn claude_agent_config_preserves_existing_fields() {
        let rendered = build_claude_agent_config(
            Some(r#"{"theme":"dark","env":{"KEEP":"yes"}}"#),
            "http://127.0.0.1:8317",
            DEFAULT_API_KEY,
            "claude-test",
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();

        assert_eq!(value["theme"], "dark");
        assert_eq!(value["env"]["KEEP"], "yes");
        assert_eq!(value["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:8317");
        assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], DEFAULT_API_KEY);
        assert_eq!(value["env"]["ANTHROPIC_MODEL"], "claude-test");
        assert_eq!(value["model"], "claude-test");
    }

    #[test]
    fn codex_agent_config_uses_managed_provider_without_losing_comments() {
        let rendered = build_codex_agent_config(
            Some("# keep this comment\napproval_policy = \"on-request\"\n"),
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "gpt-test",
        )
        .unwrap();
        let value: toml::Value = toml::from_str(&rendered).unwrap();

        assert!(rendered.contains("# keep this comment"));
        assert_eq!(value["approval_policy"].as_str(), Some("on-request"));
        assert_eq!(
            value["model_provider"].as_str(),
            Some(MANAGED_AGENT_PROVIDER_ID)
        );
        assert_eq!(value["model"].as_str(), Some("gpt-test"));
        assert_eq!(
            value["model_catalog_json"].as_str(),
            Some(CODEX_MODEL_CATALOG_FILE)
        );
        assert_eq!(
            value["model_providers"][MANAGED_AGENT_PROVIDER_ID]["base_url"].as_str(),
            Some("http://127.0.0.1:8317/v1")
        );
        assert_eq!(
            value["model_providers"][MANAGED_AGENT_PROVIDER_ID]["experimental_bearer_token"]
                .as_str(),
            Some(DEFAULT_API_KEY)
        );
    }

    #[test]
    fn claude_desktop_config_builds_gateway_profile_and_index() {
        let models = test_agent_models(&["claude-sonnet-test", "claude-opus-test"]);
        let profile = build_claude_desktop_profile(
            Some(r#"{"keep":true}"#),
            "http://127.0.0.1:8317",
            DEFAULT_API_KEY,
            "claude-sonnet-test",
            &models,
        )
        .unwrap();
        let meta =
            build_claude_desktop_meta(Some(r#"{"entries":[{"id":"other","name":"Other"}]}"#))
                .unwrap();
        let profile: serde_json::Value = serde_json::from_str(&profile).unwrap();
        let meta: serde_json::Value = serde_json::from_str(&meta).unwrap();

        assert_eq!(profile["keep"], true);
        assert_eq!(profile["inferenceGatewayApiKey"], DEFAULT_API_KEY);
        assert_eq!(profile["inferenceGatewayBaseUrl"], "http://127.0.0.1:8317");
        assert_eq!(profile["inferenceModels"][0], "claude-sonnet-test");
        assert_eq!(profile["inferenceModels"][1], "claude-opus-test");
        assert_eq!(meta["appliedId"], CLAUDE_DESKTOP_PROFILE_ID);
        assert_eq!(meta["entries"].as_array().unwrap().len(), 2);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn claude_desktop_uses_linux_beta_config_paths() {
        let home = agent_test_home("claude-desktop-linux-paths");
        let config_home = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        let paths = claude_desktop_config_paths(&home);

        assert!(AgentClient::ClaudeDesktop.supported_platform());
        assert_eq!(paths.len(), 4);
        assert_eq!(
            paths[0],
            config_home.join("Claude/claude_desktop_config.json")
        );
        assert_eq!(
            paths[1],
            config_home.join("Claude-3p/claude_desktop_config.json")
        );
        assert_eq!(
            paths[2],
            config_home
                .join("Claude-3p/configLibrary")
                .join(format!("{CLAUDE_DESKTOP_PROFILE_ID}.json"))
        );
        assert_eq!(
            paths[3],
            config_home.join("Claude-3p/configLibrary/_meta.json")
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn opencode_agent_config_preserves_other_providers() {
        let models = test_agent_models(&["gpt-test", "deepseek-test"]);
        let rendered = build_opencode_agent_config(
            Some(r#"{"theme":"dark","provider":{"other":{"npm":"other"}}}"#),
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "gpt-test",
            &models,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();

        assert_eq!(value["theme"], "dark");
        assert_eq!(value["provider"]["other"]["npm"], "other");
        assert_eq!(
            value["provider"][MANAGED_AGENT_PROVIDER_ID]["options"]["baseURL"],
            "http://127.0.0.1:8317/v1"
        );
        assert_eq!(value["model"], "cpa-gui/gpt-test");
        assert!(value["provider"][MANAGED_AGENT_PROVIDER_ID]["models"]["gpt-test"].is_object());
        assert!(
            value["provider"][MANAGED_AGENT_PROVIDER_ID]["models"]["deepseek-test"].is_object()
        );
    }

    #[test]
    fn openclaw_agent_config_accepts_json5_and_preserves_unknown_fields() {
        let models = test_agent_models(&["gpt-test", "deepseek-test"]);
        let rendered = build_openclaw_agent_config(
            Some("{ theme: 'dark', models: { mode: 'merge', providers: {} } }"),
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "gpt-test",
            &models,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();

        assert_eq!(value["theme"], "dark");
        assert_eq!(
            value["models"]["providers"][MANAGED_AGENT_PROVIDER_ID]["api"],
            "openai-completions"
        );
        assert_eq!(
            value["agents"]["defaults"]["model"]["primary"],
            "cpa-gui/gpt-test"
        );
        assert_eq!(
            value["models"]["providers"][MANAGED_AGENT_PROVIDER_ID]["models"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(value["agents"]["defaults"]["models"]["cpa-gui/gpt-test"].is_object());
        assert!(value["agents"]["defaults"]["models"]["cpa-gui/deepseek-test"].is_object());
    }

    #[test]
    fn hermes_agent_config_preserves_unknown_fields_and_uses_current_schema() {
        let models = test_agent_models(&["gpt-test", "deepseek-test"]);
        let rendered = build_hermes_agent_config(
            Some("theme: dark\ncustom_providers:\n  - name: other\n    base_url: https://example.com\n"),
            "http://127.0.0.1:8317/v1",
            DEFAULT_API_KEY,
            "gpt-test",
            &models,
        )
        .unwrap();
        let value: serde_yaml::Value = serde_yaml::from_str(&rendered).unwrap();
        let providers = value["custom_providers"].as_sequence().unwrap();
        let managed = providers
            .iter()
            .find(|provider| provider["name"].as_str() == Some(MANAGED_AGENT_PROVIDER_ID))
            .unwrap();

        assert_eq!(value["theme"].as_str(), Some("dark"));
        assert_eq!(managed["api_mode"].as_str(), Some("chat_completions"));
        assert_eq!(managed["model"].as_str(), Some("gpt-test"));
        assert!(managed["models"]["gpt-test"].is_mapping());
        assert!(managed["models"]["deepseek-test"].is_mapping());
        assert_eq!(
            value["model"]["provider"].as_str(),
            Some(MANAGED_AGENT_PROVIDER_ID)
        );
    }

    #[test]
    fn agent_model_list_parser_accepts_core_response_and_deduplicates_ids() {
        let models = parse_agent_model_options(&serde_json::json!({
            "object": "list",
            "data": [
                {"id": "gpt-5", "display_name": "GPT 5"},
                {"name": "claude-sonnet", "alias": "Sonnet"},
                "deepseek-chat",
                {"id": "GPT-5", "alias": "duplicate"},
                {"id": ""}
            ]
        }))
        .unwrap();

        assert_eq!(
            models,
            vec![
                AgentModelOption {
                    name: "gpt-5".to_string(),
                    alias: Some("GPT 5".to_string()),
                },
                AgentModelOption {
                    name: "claude-sonnet".to_string(),
                    alias: Some("Sonnet".to_string()),
                },
                AgentModelOption {
                    name: "deepseek-chat".to_string(),
                    alias: None,
                },
            ]
        );
    }

    #[test]
    fn agent_model_list_parser_rejects_unexpected_response_shape() {
        assert!(parse_agent_model_options(&serde_json::json!({"data": null})).is_err());
    }

    #[test]
    fn codex_model_catalog_uses_only_current_cpa_models_and_enriches_matches() {
        let models = vec![
            AgentModelOption {
                name: "deepseek-chat".to_string(),
                alias: None,
            },
            AgentModelOption {
                name: "gpt-5.4".to_string(),
                alias: None,
            },
        ];
        let definitions = parse_codex_model_definitions(&serde_json::json!({
            "models": [
                {
                    "id": "gpt-5.4",
                    "display_name": "GPT 5.4",
                    "description": "Stable GPT 5.4",
                    "context_length": 1_050_000,
                    "supported_parameters": ["tools"],
                    "thinking": { "levels": ["low", "medium", "high", "xhigh"] }
                },
                {
                    "id": "not-open-in-cpa",
                    "context_length": 999_999
                }
            ]
        }))
        .unwrap();
        let specs = merge_codex_model_catalog_specs(&models, &definitions);

        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].id, "deepseek-chat");
        assert_eq!(specs[0].context_window, DEFAULT_CODEX_CONTEXT_WINDOW);
        assert_eq!(specs[1].id, "gpt-5.4");
        assert_eq!(specs[1].display_name, "GPT 5.4");
        assert_eq!(specs[1].context_window, 1_050_000);
        assert!(!specs.iter().any(|model| model.id == "not-open-in-cpa"));
    }

    #[test]
    fn codex_model_catalog_renders_codex_supported_fields() {
        let rendered = build_codex_model_catalog(&test_codex_models(&["gpt-test"])).unwrap();
        let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();
        let model = &value["models"][0];

        assert_eq!(model["slug"], "gpt-test");
        assert_eq!(model["context_window"], DEFAULT_CODEX_CONTEXT_WINDOW);
        assert_eq!(model["default_reasoning_level"], "medium");
        assert_eq!(model["shell_type"], "shell_command");
        assert_eq!(model["include_skills_usage_instructions"], true);
        assert_eq!(
            model["supported_reasoning_levels"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn agent_model_validation_only_accepts_models_in_current_list() {
        let models = vec![AgentModelOption {
            name: "gpt-5.4".to_string(),
            alias: Some("GPT 5.4".to_string()),
        }];

        assert_eq!(
            resolve_available_agent_model(&models, "GPT-5.4").unwrap(),
            "gpt-5.4"
        );
        assert!(resolve_available_agent_model(&models, "removed-model").is_err());
        assert!(resolve_available_agent_model(&[], "gpt-5.4").is_err());
    }

    #[test]
    fn thinking_alias_adds_fork_and_matching_payload_rule() {
        let input = "# Keep this comment\ndebug: true\npayload:\n  override:\n    - models:\n        - name: existing-fast\n          protocol: codex\n      params:\n        service_tier: priority\n";
        let source = test_codex_oauth_thinking_source("gpt-5.5");
        let rendered =
            add_thinking_alias_to_yaml(input, &source, "gpt-5.5-xhigh", "xhigh").unwrap();
        let aliases = thinking_aliases_from_yaml(&rendered).unwrap();

        assert!(rendered.contains("# Keep this comment"), "{rendered}");
        assert!(rendered.contains("service_tier: priority"), "{rendered}");
        assert_eq!(
            aliases,
            vec![ThinkingAliasEntry {
                source_model: "gpt-5.5".to_string(),
                alias: "gpt-5.5-xhigh".to_string(),
                effort: Some("xhigh".to_string()),
                provider: "Codex OAuth".to_string(),
                kind: "codex-oauth".to_string(),
            }]
        );
    }

    #[test]
    fn thinking_alias_effort_accepts_provider_defined_levels() {
        assert_eq!(validate_thinking_alias_effort(" AUTO ").unwrap(), "auto");
        assert_eq!(validate_thinking_alias_effort("ultra").unwrap(), "ultra");
        assert_eq!(
            validate_thinking_alias_effort("vendor_level-2.1").unwrap(),
            "vendor_level-2.1"
        );
        assert!(validate_thinking_alias_effort("").is_err());
        assert!(validate_thinking_alias_effort("high value").is_err());
        assert!(validate_thinking_alias_effort("32768").is_err());
    }

    #[test]
    fn thinking_alias_removal_keeps_other_models_in_grouped_rule() {
        let input = "oauth-model-alias:\n  codex:\n    - name: gpt-5.5\n      alias: gpt-5.5-xhigh\n      fork: true\n    - name: gpt-5.4\n      alias: gpt-5.4-xhigh\n      fork: true\npayload:\n  override:\n    - models:\n        - name: gpt-5.5-xhigh\n          protocol: codex\n        - name: gpt-5.4-xhigh\n          protocol: codex\n      params:\n        reasoning.effort: xhigh\n";
        let rendered = remove_thinking_alias_from_yaml(input, "gpt-5.5-xhigh").unwrap();
        let aliases = thinking_aliases_from_yaml(&rendered).unwrap();

        assert_eq!(aliases.len(), 1);
        assert_eq!(aliases[0].alias, "gpt-5.4-xhigh");
        assert!(!rendered.contains("gpt-5.5-xhigh"), "{rendered}");
        assert!(rendered.contains("gpt-5.4-xhigh"), "{rendered}");
        assert!(rendered.contains("reasoning.effort: xhigh"), "{rendered}");
    }

    #[test]
    fn thinking_alias_rejects_duplicate_client_visible_name() {
        let input = "oauth-model-alias:\n  codex:\n    - name: gpt-5.5\n      alias: gpt-5.5-high\n      fork: true\n";
        let source = test_codex_oauth_thinking_source("gpt-5.4");
        assert!(
            add_thinking_alias_to_yaml(input, &source, "GPT-5.5-HIGH", "high")
                .unwrap_err()
                .contains("已存在")
        );
    }

    #[test]
    fn thinking_alias_supports_openai_compatible_model_entries() {
        let input = "openai-compatibility:\n  - name: DeepSeek\n    base-url: https://api.deepseek.com\n    api-key-entries:\n      - api-key: test\n    models:\n      - name: deepseek-chat\n        display-name: DeepSeek Chat\n        thinking:\n          levels: [low, medium, high]\n";
        let sources = resolved_thinking_alias_sources(input, &[]).unwrap();
        let source = sources
            .iter()
            .find(|source| source.source.model == "deepseek-chat")
            .unwrap();
        let rendered =
            add_thinking_alias_to_yaml(input, source, "deepseek-chat-high", "high").unwrap();
        let value: serde_norway::Value = serde_norway::from_str(&rendered).unwrap();
        let root = value.as_mapping().unwrap();
        let providers = yaml_mapping_value(root, "openai-compatibility")
            .and_then(serde_norway::Value::as_sequence)
            .unwrap();
        let models = yaml_mapping_value(providers[0].as_mapping().unwrap(), "models")
            .and_then(serde_norway::Value::as_sequence)
            .unwrap();
        let alias_model = models[1].as_mapping().unwrap();

        assert_eq!(models.len(), 2);
        assert_eq!(
            yaml_mapping_value(alias_model, "name").and_then(serde_norway::Value::as_str),
            Some("deepseek-chat")
        );
        assert_eq!(
            yaml_mapping_value(alias_model, "alias").and_then(serde_norway::Value::as_str),
            Some("deepseek-chat-high")
        );
        assert!(rendered.contains("protocol: openai"), "{rendered}");
        assert!(rendered.contains("reasoning_effort: high"), "{rendered}");
        assert!(rendered.contains("thinking.type: enabled"), "{rendered}");
        assert!(!rendered.contains("oauth-model-alias"), "{rendered}");

        let entries = thinking_aliases_from_yaml(&rendered).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].provider, "DeepSeek");
        assert_eq!(entries[0].kind, "openai-compatible");

        let restored = remove_thinking_alias_from_yaml(&rendered, "deepseek-chat-high").unwrap();
        assert!(!restored.contains("deepseek-chat-high"), "{restored}");
        assert!(!restored.contains("reasoning_effort"), "{restored}");
    }

    #[test]
    fn thinking_alias_supports_codex_api_model_entries() {
        let input = "codex-api-key:\n  - api-key: test\n    base-url: https://example.com/v1\n    models:\n      - name: gpt-custom\n";
        let sources = resolved_thinking_alias_sources(input, &[]).unwrap();
        let source = sources
            .iter()
            .find(|source| source.source.kind == "codex-api")
            .unwrap();
        let rendered =
            add_thinking_alias_to_yaml(input, source, "gpt-custom-xhigh", "xhigh").unwrap();

        assert!(rendered.contains("alias: gpt-custom-xhigh"), "{rendered}");
        assert!(rendered.contains("protocol: codex"), "{rendered}");
        assert!(rendered.contains("reasoning.effort: xhigh"), "{rendered}");
        assert!(!rendered.contains("oauth-model-alias"), "{rendered}");
        let entries = thinking_aliases_from_yaml(&rendered).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "codex-api");
    }

    #[test]
    fn agent_modification_backs_up_updates_conflicts_and_restores_exact_bytes() {
        let home = agent_test_home("codex-roundtrip");
        let path = home.join(".codex/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = b"# original comment\napproval_policy = \"on-request\"\n";
        fs::write(&path, original).unwrap();

        let available_models = test_agent_models(&["gpt-one", "gpt-two", "gpt-three"]);
        let codex_models = test_codex_models(&["gpt-one", "gpt-two", "gpt-three"]);
        let enabled = enable_agent_modification(
            AgentClient::Codex,
            &home,
            8317,
            "gpt-one",
            &available_models,
            Some(&codex_models),
        )
        .unwrap();
        assert_eq!(enabled.outcome, "enabled");
        let backup = agent_backup_path(&path).unwrap();
        let state = agent_state_path(std::slice::from_ref(&path)).unwrap();
        let catalog_path = codex_model_catalog_path(&home);
        assert_eq!(fs::read(&backup).unwrap(), original);
        assert!(state.is_file());
        assert!(catalog_path.is_file());

        let updated = update_agent_modification(
            AgentClient::Codex,
            &home,
            8317,
            "gpt-two",
            &available_models,
            Some(&codex_models),
        )
        .unwrap();
        assert_eq!(updated.outcome, "updated");
        assert_eq!(fs::read(&backup).unwrap(), original);
        assert!(fs::read_to_string(&path).unwrap().contains("gpt-two"));

        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"# external change\n")
            .unwrap();
        assert!(update_agent_modification(
            AgentClient::Codex,
            &home,
            8317,
            "gpt-three",
            &available_models,
            Some(&codex_models),
        )
        .unwrap_err()
        .contains("其他程序修改"));

        let conflict = disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
        assert_eq!(conflict.outcome, "restore-conflict");
        assert_eq!(conflict.conflict_files, vec![path_to_string(&path)]);
        assert!(state.is_file());

        let restored = disable_agent_modification(AgentClient::Codex, &home, 8317, true).unwrap();
        assert_eq!(restored.outcome, "disabled");
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(!catalog_path.exists());
        assert!(!backup.exists());
        assert!(!state.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn agent_modification_removes_files_that_did_not_exist_before_enable() {
        let home = agent_test_home("opencode-absent");
        let path = home.join(".config/opencode/opencode.json");

        let models = test_agent_models(&["gpt-test"]);
        enable_agent_modification(
            AgentClient::OpenCode,
            &home,
            8317,
            "gpt-test",
            &models,
            None,
        )
        .unwrap();
        assert!(path.is_file());
        assert!(!agent_backup_path(&path).unwrap().exists());

        disable_agent_modification(AgentClient::OpenCode, &home, 8317, false).unwrap();
        assert!(!path.exists());
        assert!(!agent_state_path(&[path]).unwrap().exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn agent_enable_discards_backup_when_state_cannot_be_written() {
        let home = agent_test_home("state-write-failure");
        let path = home.join(".codex/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"approval_policy = \"never\"\n").unwrap();
        let state_path = agent_state_path(std::slice::from_ref(&path)).unwrap();
        fs::create_dir(&state_path).unwrap();

        let available_models = test_agent_models(&["gpt-test"]);
        let codex_models = test_codex_models(&["gpt-test"]);
        assert!(enable_agent_modification(
            AgentClient::Codex,
            &home,
            8317,
            "gpt-test",
            &available_models,
            Some(&codex_models),
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"approval_policy = \"never\"\n");
        assert!(!agent_backup_path(&path).unwrap().exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn claude_code_keeps_using_the_path_that_owns_active_state() {
        let home = agent_test_home("claude-path-state");
        let directory = home.join(".claude");
        let settings = directory.join("settings.json");
        let legacy = directory.join("claude.json");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&settings, b"{}\n").unwrap();
        fs::write(&legacy, b"{}\n").unwrap();
        fs::write(
            agent_state_path(std::slice::from_ref(&legacy)).unwrap(),
            b"{}\n",
        )
        .unwrap();

        assert_eq!(
            agent_config_paths(AgentClient::ClaudeCode, &home),
            vec![legacy]
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn legacy_agent_backup_restores_even_when_gui_port_changed() {
        let home = agent_test_home("legacy-port");
        let path = home.join(".codex/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = b"approval_policy = \"never\"\n";
        fs::write(agent_backup_path(&path).unwrap(), original).unwrap();
        fs::write(
            &path,
            build_codex_agent_config(
                None,
                "http://127.0.0.1:9999/v1",
                DEFAULT_API_KEY,
                "gpt-legacy",
            )
            .unwrap(),
        )
        .unwrap();

        assert!(agent_has_managed_marker(AgentClient::Codex, std::slice::from_ref(&path)).unwrap());
        let result = disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
        assert_eq!(result.outcome, "disabled");
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn legacy_generated_only_agent_config_is_removed_without_backup() {
        let home = agent_test_home("legacy-generated");
        let path = home.join(".codex/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            build_codex_agent_config(
                None,
                "http://127.0.0.1:8317/v1",
                DEFAULT_API_KEY,
                "gpt-generated",
            )
            .unwrap(),
        )
        .unwrap();

        let result = disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
        assert_eq!(result.outcome, "disabled");
        assert!(!path.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn updating_legacy_codex_state_adds_catalog_without_replacing_original_backup() {
        let home = agent_test_home("legacy-catalog-upgrade");
        let path = home.join(".codex/config.toml");
        let catalog_path = codex_model_catalog_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original_config = b"approval_policy = \"never\"\n";
        let original_catalog = b"{\"models\":[{\"slug\":\"user-model\"}]}\n";
        fs::write(agent_backup_path(&path).unwrap(), original_config).unwrap();
        fs::write(
            &path,
            build_codex_agent_config(None, "http://127.0.0.1:8317/v1", DEFAULT_API_KEY, "gpt-old")
                .unwrap(),
        )
        .unwrap();
        fs::write(&catalog_path, original_catalog).unwrap();
        let record = build_legacy_agent_record(AgentClient::Codex, &home, 8317, "gpt-old")
            .unwrap()
            .unwrap();
        assert_eq!(record.files.len(), 1);
        write_agent_state(
            &agent_state_path(std::slice::from_ref(&path)).unwrap(),
            &record,
        )
        .unwrap();

        let available_models = test_agent_models(&["gpt-new"]);
        let codex_models = test_codex_models(&["gpt-new"]);
        update_agent_modification(
            AgentClient::Codex,
            &home,
            8317,
            "gpt-new",
            &available_models,
            Some(&codex_models),
        )
        .unwrap();
        let upgraded = load_agent_record(AgentClient::Codex, std::slice::from_ref(&path))
            .unwrap()
            .unwrap();
        assert_eq!(upgraded.files.len(), 2);
        assert_eq!(
            fs::read(agent_backup_path(&path).unwrap()).unwrap(),
            original_config
        );
        assert_eq!(
            fs::read(agent_backup_path(&catalog_path).unwrap()).unwrap(),
            original_catalog
        );

        disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original_config);
        assert_eq!(fs::read(&catalog_path).unwrap(), original_catalog);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn interrupted_agent_state_is_reported_as_recovery() {
        let home = agent_test_home("recovery-state");
        let path = home.join(".codex/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "approval_policy = \"never\"\n").unwrap();
        let available_models = test_agent_models(&["gpt-test"]);
        let codex_models = test_codex_models(&["gpt-test"]);
        enable_agent_modification(
            AgentClient::Codex,
            &home,
            8317,
            "gpt-test",
            &available_models,
            Some(&codex_models),
        )
        .unwrap();

        let state_path = agent_state_path(std::slice::from_ref(&path)).unwrap();
        let mut record = load_agent_record(AgentClient::Codex, &[path])
            .unwrap()
            .unwrap();
        record.phase = AGENT_PHASE_APPLYING.to_string();
        write_agent_state(&state_path, &record).unwrap();
        let inspection =
            inspect_agent_modification(AgentClient::Codex, &home, 8317, true, Some("gpt-test"));
        assert!(inspection.enabled);
        assert_eq!(inspection.state, "recovery");

        disable_agent_modification(AgentClient::Codex, &home, 8317, false).unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn agent_backup_protocol_restores_multiple_files_and_removes_created_files() {
        let home = agent_test_home("multi-file");
        let first = home.join("first.json");
        let second = home.join("second.json");
        fs::write(&first, b"{\"original\":true}\n").unwrap();
        let updates = vec![
            AgentFileUpdate {
                path: first.clone(),
                after: "{\"managed\":1}\n".to_string(),
            },
            AgentFileUpdate {
                path: second.clone(),
                after: "{\"managed\":2}\n".to_string(),
            },
        ];
        let record = prepare_agent_record(
            AgentClient::ClaudeDesktop,
            &[first.clone(), second.clone()],
            "claude-test",
            &updates,
        )
        .unwrap();

        apply_agent_updates(&updates).unwrap();
        assert!(first.is_file());
        assert!(second.is_file());
        restore_agent_record_files(&record).unwrap();
        assert_eq!(fs::read_to_string(&first).unwrap(), "{\"original\":true}\n");
        assert!(!second.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn interrupted_multi_file_apply_can_restore_without_false_conflict() {
        let home = agent_test_home("partial-recovery");
        let first = home.join("first.json");
        let second = home.join("second.json");
        fs::write(&first, b"{\"original\":1}\n").unwrap();
        fs::write(&second, b"{\"original\":2}\n").unwrap();
        let updates = vec![
            AgentFileUpdate {
                path: first.clone(),
                after: "{\"managed\":1}\n".to_string(),
            },
            AgentFileUpdate {
                path: second.clone(),
                after: "{\"managed\":2}\n".to_string(),
            },
        ];
        let record = prepare_agent_record(
            AgentClient::ClaudeDesktop,
            &[first.clone(), second.clone()],
            "claude-test",
            &updates,
        )
        .unwrap();

        write_bytes_atomically(&first, updates[0].after.as_bytes()).unwrap();
        assert_eq!(
            record_conflict_files(&record).unwrap(),
            vec![path_to_string(&second)]
        );
        assert!(record_restore_conflict_files(&record).unwrap().is_empty());

        fs::write(&second, b"{\"external\":true}\n").unwrap();
        assert_eq!(
            record_restore_conflict_files(&record).unwrap(),
            vec![path_to_string(&second)]
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn partial_agent_write_failure_rolls_back_previous_files() {
        let home = agent_test_home("partial-write");
        let first = home.join("first.txt");
        let blocked_parent = home.join("blocked");
        fs::write(&first, b"original\n").unwrap();
        fs::write(&blocked_parent, b"not a directory").unwrap();
        let updates = vec![
            AgentFileUpdate {
                path: first.clone(),
                after: "changed\n".to_string(),
            },
            AgentFileUpdate {
                path: blocked_parent.join("second.txt"),
                after: "never written\n".to_string(),
            },
        ];

        assert!(apply_agent_updates(&updates).is_err());
        assert_eq!(fs::read_to_string(&first).unwrap(), "original\n");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn legacy_string_api_keys_gain_remarks_and_keep_custom_keys() {
        let legacy = "port = 8317\nallow-lan = false\nrun-on-startup = false\nauth-dir = \"/tmp/oauth\"\napi-keys = [\"123456\", \"custom-key\"]\nmanagement-secret-key = \"123456\"\nplugins-enabled = false\nrouting-strategy = \"round-robin\"\n";
        let mut config = toml::from_str::<GuiConfigFile>(legacy).unwrap();

        assert!(sanitize_gui_config(&mut config).unwrap());
        assert_eq!(
            gui_api_key_values(&config.api_keys),
            vec!["123456", "custom-key"]
        );
        assert_eq!(config.api_keys[0].remark, DEFAULT_API_KEY_REMARK);
        assert!(config.api_keys[1].remark.is_empty());

        let serialized = toml::to_string_pretty(&config).unwrap();
        assert!(serialized.contains("[[api-keys]]"));
        assert!(serialized.contains("remark = \"内置密钥\""));
        let reparsed = toml::from_str::<GuiConfigFile>(&serialized).unwrap();
        assert_eq!(reparsed.api_keys, config.api_keys);
    }

    #[test]
    fn api_key_remarks_follow_matching_core_keys() {
        let existing = vec![
            built_in_api_key_entry(),
            GuiApiKeyEntry {
                key: "custom-key".to_string(),
                remark: "开发环境".to_string(),
            },
        ];
        let core_keys = vec!["custom-key".to_string(), "new-key".to_string()];

        let merged = merge_core_api_keys_with_gui_metadata(&existing, &core_keys, None);

        assert_eq!(
            gui_api_key_values(&merged),
            vec!["123456", "custom-key", "new-key"]
        );
        assert_eq!(merged[1].remark, "开发环境");
        assert!(merged[2].remark.is_empty());
    }

    #[test]
    fn core_config_view_exposes_api_key_metadata_for_the_webview() {
        let view = serde_json::to_value(CoreConfigView::from(&GuiConfigFile::default())).unwrap();

        assert_eq!(view["apiKeys"][0]["apiKey"], DEFAULT_API_KEY);
        assert_eq!(view["apiKeys"][0]["remark"], DEFAULT_API_KEY_REMARK);
        assert_eq!(view["apiKeys"][0]["builtIn"], true);
    }

    #[test]
    fn management_secret_key_is_normalized_to_fixed_value() {
        let mut config = GuiConfigFile {
            management_secret_key: "old-management-secret".to_string(),
            ..GuiConfigFile::default()
        };

        assert!(sanitize_gui_config(&mut config).unwrap());
        assert_eq!(config.management_secret_key, DEFAULT_MANAGEMENT_SECRET_KEY);

        let template = "remote-management:\n  secret-key: stale-secret\n";
        let merged = merge_core_config_yaml(template, None, &config).unwrap();
        let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
        assert_eq!(
            document["remote-management"]["secret-key"],
            DEFAULT_MANAGEMENT_SECRET_KEY
        );
    }

    #[test]
    fn auth_directory_is_fixed_and_written_to_core_config() {
        let mut config = GuiConfigFile {
            auth_dir: "/tmp/user-selected-auth".to_string(),
            ..GuiConfigFile::default()
        };

        assert!(validate_gui_config(&config).is_err());
        assert!(sanitize_gui_config(&mut config).unwrap());
        assert_eq!(config.auth_dir, path_to_string(&fixed_oauth_dir().unwrap()));

        let merged = merge_core_config_yaml("auth-dir: ~/.cli-proxy-api\n", None, &config).unwrap();
        let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
        assert_eq!(document["auth-dir"], config.auth_dir);
    }

    #[test]
    fn legacy_gui_config_can_seed_managed_core_settings() {
        let legacy = "port: 8317\nallow-lan: false\nrun-on-startup: true\n";
        let mut config = serde_yaml::from_str::<GuiConfigFile>(legacy).unwrap();
        let presence = serde_yaml::from_str::<GuiConfigPresence>(legacy).unwrap();
        let core_settings = CoreConfigSettings {
            api_keys: vec!["existing-key".to_string()],
            management_secret_configured: true,
            plugins_enabled: true,
            routing_strategy: "fill-first".to_string(),
            management_secret_key: Some("management-secret".to_string()),
        };

        assert!(presence.api_keys.is_none());
        assert!(presence.management_secret_key.is_none());
        assert!(presence.plugins_enabled.is_none());
        assert!(presence.routing_strategy.is_none());
        apply_core_settings_to_gui_config(&mut config, &core_settings);

        assert_eq!(
            gui_api_key_values(&config.api_keys),
            vec!["123456", "existing-key"]
        );
        assert_eq!(config.management_secret_key, DEFAULT_MANAGEMENT_SECRET_KEY);
        assert!(config.plugins_enabled);
        assert_eq!(config.routing_strategy, "fill-first");
        assert!(config.run_on_startup);
    }

    #[test]
    fn example_api_keys_are_not_persisted_as_gui_settings() {
        let input = "api-keys:\n  - your-api-key-1\n  - real-key\nremote-management:\n  secret-key: plain-management-secret\nplugins:\n  enabled: true\nrouting:\n  strategy: fill-first\n";
        let document = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
        let core_settings = core_config_settings_from_value(&document).unwrap();
        let mut config = GuiConfigFile::default();

        apply_core_settings_to_gui_config(&mut config, &core_settings);

        assert_eq!(core_settings.api_keys, vec!["real-key"]);
        assert_eq!(
            gui_api_key_values(&config.api_keys),
            vec!["123456", "real-key"]
        );
        assert_eq!(
            core_settings.management_secret_key.as_deref(),
            Some("plain-management-secret")
        );
        assert_eq!(config.management_secret_key, DEFAULT_MANAGEMENT_SECRET_KEY);
        assert!(validate_core_api_key("your-api-key-3").is_err());
    }

    #[test]
    fn hashed_management_secret_is_not_imported_as_gui_source() {
        let input = "remote-management:\n  secret-key: $2a$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuu\n";
        let document = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
        let core_settings = core_config_settings_from_value(&document).unwrap();

        assert!(core_settings.management_secret_key.is_none());
        assert!(!core_settings.management_secret_configured);
    }

    #[test]
    fn runtime_network_patch_preserves_comments_and_other_settings() {
        let config = GuiConfigFile {
            port: 9527,
            allow_lan: true,
            run_on_startup: false,
            ..GuiConfigFile::default()
        };
        let input = "# Bind address\nhost: 127.0.0.1 # local only\n\n# Service port\nport: 8317 # default\ndebug: true\n";
        let updated = patch_core_network_yaml(input, &config)
            .unwrap()
            .expect("network settings should change");

        assert_eq!(
            updated,
            "# Bind address\nhost: 0.0.0.0 # local only\n\n# Service port\nport: 9527 # default\ndebug: true\n"
        );
        assert!(updated.contains("# Bind address"));
        assert!(updated.contains("# local only"));
        assert!(updated.contains("# Service port"));
        assert!(updated.contains("# default"));
        assert!(updated.contains("debug: true"));

        let document = serde_norway::from_str::<serde_norway::Value>(&updated).unwrap();
        assert_eq!(
            document["host"],
            serde_norway::Value::String("0.0.0.0".to_string())
        );
        assert_eq!(document["port"], serde_norway::to_value(9527_u16).unwrap());
    }

    #[test]
    fn runtime_network_patch_skips_unchanged_yaml() {
        let config = GuiConfigFile::default();
        let input = "host: 127.0.0.1\nport: 8317\n";

        assert!(patch_core_network_yaml(input, &config).unwrap().is_none());
    }

    #[test]
    fn core_config_controls_preserve_comments_and_unrelated_values() {
        let input = "# Client authentication\napi-keys:\n  - old-key\n\n# Plugin runtime\nplugins:\n  enabled: false # global switch\n  dir: plugins\n\n# Credential routing\nrouting:\n  strategy: round-robin # current strategy\n  session-affinity: true\n\ndebug: true # untouched\n";
        let mut document = yaml_serde_edit::YamlValue::parse(input).unwrap();
        let mut updated = document.get().clone();

        set_core_api_keys(
            &mut updated,
            vec!["old-key".to_string(), "new-key".to_string()],
        )
        .unwrap();
        set_nested_yaml_value(&mut updated, &["plugins", "enabled"], true).unwrap();
        set_nested_yaml_value(
            &mut updated,
            &["routing", "strategy"],
            "fill-first".to_string(),
        )
        .unwrap();
        document.set(updated);

        let rendered = document.get_string();
        assert!(rendered.contains("# Client authentication"));
        assert!(rendered.contains("# Plugin runtime"));
        assert!(rendered.contains("# global switch"));
        assert!(rendered.contains("# Credential routing"));
        assert!(rendered.contains("# current strategy"));
        assert!(rendered.contains("debug: true # untouched"));

        let settings = core_config_settings_from_value(document.get()).unwrap();
        assert_eq!(settings.api_keys, vec!["old-key", "new-key"]);
        assert!(settings.plugins_enabled);
        assert_eq!(settings.routing_strategy, "fill-first");
        assert_eq!(document.get()["plugins"]["dir"], "plugins");
        assert_eq!(document.get()["routing"]["session-affinity"], true);
    }

    #[test]
    fn yaml_edit_runtime_patches_supported_fields_without_reflowing_yaml() {
        let input = "# Client authentication\napi-keys:\n  - old-key\n\n# Plugin runtime\nplugins:\n  enabled: false # global switch\n  dir: plugins\n\n# Credential routing\nrouting:\n  strategy: round-robin # current strategy\n  session-affinity: true\n\ndebug: true # untouched\n";
        let file = input.parse::<yaml_edit::YamlFile>().unwrap();
        let document = file.document().unwrap();

        assert!(set_yaml_edit_nested_value(
            &document, "plugins", "enabled", true
        ));
        assert!(set_yaml_edit_nested_value(
            &document,
            "routing",
            "strategy",
            "fill-first".to_string()
        ));

        let rendered = patch_core_api_keys_yaml(
            &file.to_string(),
            &["new-key".to_string(), "backup-key".to_string()],
        )
        .unwrap();
        assert!(rendered.contains("# Client authentication"));
        assert!(rendered.contains("# Plugin runtime"));
        assert!(rendered.contains("# global switch"));
        assert!(rendered.contains("# Credential routing"));
        assert!(rendered.contains("# current strategy"));
        assert!(rendered.contains("debug: true # untouched"));
        assert!(rendered.contains("dir: plugins"));
        assert!(rendered.contains("session-affinity: true"));

        let settings =
            core_config_settings_from_value(&serde_norway::from_str(&rendered).unwrap()).unwrap();
        assert_eq!(settings.api_keys, vec!["new-key", "backup-key"]);
        assert!(settings.plugins_enabled);
        assert_eq!(settings.routing_strategy, "fill-first");
    }

    #[test]
    fn runtime_yaml_ast_patch_handles_core_comments_around_nested_mapping() {
        let input = "host: 127.0.0.1\nremote-management:\n# Whether to allow remote access.\n  allow-remote: false\n# Management key.\n# All requests require this key.\n  secret-key: old\n# Disable panel.\n  disable-control-panel: false\nauth-dir: /tmp/old\napi-keys:\n  - old-key\n";
        let rendered = patch_core_yaml_document(input, |document| {
            let auth_changed = set_core_yaml_top_level_value(
                document,
                "auth-dir",
                serde_norway::Value::String("/tmp/new".to_string()),
            )?;
            let secret_changed = set_core_yaml_nested_value(
                document,
                "remote-management",
                "secret-key",
                serde_norway::Value::String("123456".to_string()),
            )?;
            Ok(auth_changed || secret_changed)
        })
        .unwrap()
        .unwrap();
        let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
            .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));

        assert_eq!(parsed["auth-dir"], "/tmp/new");
        assert_eq!(parsed["remote-management"]["secret-key"], "123456");
        assert!(rendered.contains("# All requests require this key."));
        assert!(rendered.contains("disable-control-panel: false"));
    }

    #[test]
    fn yaml_edit_runtime_patch_removes_empty_keys_and_skips_unsupported_sections() {
        let input = "# Client authentication\napi-keys:\n  - old-key\nplugins:\n  enabled: true\nrouting:\n  strategy: fill-first\n";
        let rendered = patch_core_api_keys_yaml(input, &[]).unwrap();
        let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered).unwrap();
        let root = parsed.as_mapping().unwrap();
        assert!(yaml_mapping_value(root, "api-keys").is_none(), "{rendered}");
        assert_eq!(
            core_config_settings_from_value(&parsed).unwrap().api_keys,
            Vec::<String>::new()
        );

        let missing_api_keys = "host: 127.0.0.1\nport: 8317\n";
        let rendered = patch_core_api_keys_yaml(
            missing_api_keys,
            &["new-key".to_string(), "backup-key".to_string()],
        )
        .unwrap();
        let settings =
            core_config_settings_from_value(&serde_norway::from_str(&rendered).unwrap()).unwrap();
        assert_eq!(settings.api_keys, vec!["new-key", "backup-key"]);
        assert!(rendered.contains("host: 127.0.0.1"));
        assert!(rendered.contains("port: 8317"));

        // Nested plugin/routing sections are still optional for comment-preserving
        // runtime patches; missing maps remain unsupported and stay untouched.
        let unsupported = "host: 127.0.0.1\nport: 8317\n";
        let file = unsupported.parse::<yaml_edit::YamlFile>().unwrap();
        let document = file.document().unwrap();
        assert!(!set_yaml_edit_nested_value(
            &document, "plugins", "enabled", true
        ));
        assert!(!set_yaml_edit_nested_value(
            &document,
            "routing",
            "strategy",
            "fill-first".to_string()
        ));
        assert_eq!(file.to_string(), unsupported);
    }

    #[test]
    fn yaml_edit_runtime_patch_recreates_api_keys_after_delete_all() {
        let input = "# Client authentication\napi-keys:\n  - old-key\nplugins:\n  enabled: true\n";
        let cleared = patch_core_api_keys_yaml(input, &[]).unwrap();
        let rendered = patch_core_api_keys_yaml(&cleared, &["restored-key".to_string()]).unwrap();
        assert!(rendered.contains("# Client authentication"), "{rendered}");
        let settings =
            core_config_settings_from_value(&serde_norway::from_str(&rendered).unwrap()).unwrap();
        assert_eq!(settings.api_keys, vec!["restored-key"]);
    }

    #[test]
    fn yaml_edit_runtime_patch_adds_api_keys_to_core_style_config() {
        let input = "host: 127.0.0.1\nremote-management:\n# nested setting comment\n  allow-remote: false\nauth-dir: /tmp/oauth\n# API keys for authentication\n# Enable debug logging\ndebug: false\n\n# Optional payload configuration\n# payload:\n#   filter:\n#     - models:\n#         - name: \"gemini-2.5-pro\"\n#       params:\n#         - \"generationConfig.responseJsonSchema\"\n";
        let rendered =
            patch_core_api_keys_yaml(input, &["new-key".to_string(), "backup-key".to_string()])
                .unwrap();
        let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
            .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));
        let settings = core_config_settings_from_value(&parsed).unwrap();
        assert_eq!(settings.api_keys, vec!["new-key", "backup-key"]);
        assert!(rendered.contains("# Optional payload configuration"));
        assert!(rendered.contains("generationConfig.responseJsonSchema"));
        assert!(
            rendered.find("auth-dir: /tmp/oauth").unwrap() < rendered.find("api-keys:").unwrap()
        );
        assert!(rendered.find("api-keys:").unwrap() < rendered.find("debug: false").unwrap());
    }

    #[test]
    fn yaml_edit_runtime_patch_updates_existing_real_core_config() {
        let input = "host: 0.0.0.0\nremote-management:\n# nested comment\n  allow-remote: false\nauth-dir: /tmp/oauth\n# API keys for authentication\napi-keys:\n  - '123456'\n# Enable debug logging\ndebug: false\n\n# payload:\n#   filter:\n#     - models:\n#         - name: gemini\n";
        let rendered =
            patch_core_api_keys_yaml(input, &[DEFAULT_API_KEY.to_string(), "new-key".to_string()])
                .unwrap();
        let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
            .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));
        assert_eq!(
            core_config_settings_from_value(&parsed).unwrap().api_keys,
            vec![DEFAULT_API_KEY, "new-key"]
        );
    }

    #[test]
    fn runtime_api_key_patch_replaces_indentationless_core_sequence() {
        let input = "host: 0.0.0.0\nport: 8317\nauth-dir: /tmp/oauth\napi-keys:\n- '123456'\ndebug: false\n";
        let rendered = patch_core_api_keys_yaml(input, &[DEFAULT_API_KEY.to_string()])
            .unwrap_or_else(|error| panic!("patch failed: {error}"));
        let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered)
            .unwrap_or_else(|error| panic!("invalid YAML: {error}\n{rendered}"));

        assert_eq!(
            core_config_settings_from_value(&parsed).unwrap().api_keys,
            vec![DEFAULT_API_KEY]
        );
        assert_eq!(rendered.matches("- '123456'").count(), 1, "{rendered}");
        assert!(rendered.contains("debug: false"), "{rendered}");
    }

    #[test]
    fn yaml_edit_runtime_patch_migrates_legacy_api_key_entries() {
        let input = "auth:\n  providers:\n    config-api-key:\n      api-key-entries:\n        - api-key: first-key\n        - key: second-key\nplugins:\n  enabled: false\n";
        let rendered = patch_core_api_keys_yaml(input, &["migrated-key".to_string()]).unwrap();
        let parsed = serde_norway::from_str::<serde_norway::Value>(&rendered).unwrap();
        let settings = core_config_settings_from_value(&parsed).unwrap();
        assert_eq!(settings.api_keys, vec!["migrated-key"]);
        assert!(
            nested_yaml_value(
                parsed.as_mapping().unwrap(),
                &["auth", "providers", "config-api-key", "api-key-entries"]
            )
            .is_none(),
            "{rendered}"
        );
    }

    #[test]
    fn core_config_reads_legacy_api_key_entries() {
        let input = "auth:\n  providers:\n    config-api-key:\n      api-key-entries:\n        - api-key: first-key\n        - key: second-key\nplugins:\n  enabled: false\nrouting:\n  strategy: round-robin\n";
        let document = serde_norway::from_str::<serde_norway::Value>(input).unwrap();
        let settings = core_config_settings_from_value(&document).unwrap();

        assert_eq!(settings.api_keys, vec!["first-key", "second-key"]);
        assert!(!settings.plugins_enabled);
        assert_eq!(settings.routing_strategy, "round-robin");
    }

    #[test]
    fn core_config_validates_keys_and_routing_strategy() {
        assert!(validate_core_api_key("sk-valid_123").is_ok());
        assert!(validate_core_api_key("").is_err());
        assert!(validate_core_api_key("contains space").is_err());
        assert!(validate_routing_strategy("round-robin").is_ok());
        assert!(validate_routing_strategy("fill-first").is_ok());
        assert!(validate_routing_strategy("random").is_err());
    }

    #[test]
    fn unchanged_yaml_is_not_written_again() {
        let path = std::env::temp_dir().join(format!(
            "cpa-gui-unchanged-yaml-{}-{}.yaml",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = "host: 127.0.0.1\nport: 8317\n";
        fs::write(&path, content).unwrap();

        assert!(!write_yaml_if_changed(&path, content).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), content);

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn startup_merge_uses_template_and_preserves_current_values() {
        let template = "# Current release template\nhost: \"\" # template bind address\nport: 8317\n\n# Client authentication\napi-keys:\n  - template-key\n\n# Plugin runtime\nplugins:\n  enabled: false # plugin switch\n\n# Credential routing\nrouting:\n  strategy: round-robin # routing switch\n\n# New release option\nnew-option: true\nnested:\n  # Nested template comment\n  keep: template\n  added: from-template\nlist:\n  - template-item\n";
        let current = "host: 127.0.0.1\nport: 9000\nnested:\n  keep: current\n  current-only: retained\nlist:\n  - current-a\n  - current-b\nextra: true\n";
        let config = GuiConfigFile {
            port: 9527,
            allow_lan: true,
            run_on_startup: false,
            auth_dir: path_to_string(&fixed_oauth_dir().unwrap()),
            api_keys: vec![
                built_in_api_key_entry(),
                GuiApiKeyEntry {
                    key: "gui-key".to_string(),
                    remark: "测试密钥".to_string(),
                },
            ],
            management_secret_key: String::new(),
            plugins_enabled: true,
            routing_strategy: "fill-first".to_string(),
        };
        let merged = merge_core_config_yaml(template, Some(current), &config).unwrap();

        assert!(merged.contains("# Current release template"));
        assert!(merged.contains("# template bind address"), "{merged}");
        assert!(merged.contains("# New release option"));
        assert!(merged.contains("# Nested template comment"));

        let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();
        assert_eq!(
            document["host"],
            serde_norway::Value::String("0.0.0.0".to_string())
        );
        assert_eq!(document["port"], serde_norway::to_value(9527_u16).unwrap());
        assert_eq!(document["api-keys"][0], DEFAULT_API_KEY);
        assert_eq!(document["api-keys"][1], "gui-key");
        assert_eq!(document["plugins"]["enabled"], true, "{merged}");
        assert_eq!(document["routing"]["strategy"], "fill-first");
        assert_eq!(document["usage-statistics-enabled"], true);
        assert_eq!(document["new-option"], serde_norway::Value::Bool(true));
        assert_eq!(
            document["nested"]["keep"],
            serde_norway::Value::String("current".to_string())
        );
        assert_eq!(
            document["nested"]["added"],
            serde_norway::Value::String("from-template".to_string())
        );
        assert_eq!(
            document["nested"]["current-only"],
            serde_norway::Value::String("retained".to_string())
        );
        assert_eq!(document["extra"], serde_norway::Value::Bool(true));
        assert_eq!(
            document["list"],
            serde_norway::Value::Sequence(vec![
                serde_norway::Value::String("current-a".to_string()),
                serde_norway::Value::String("current-b".to_string()),
            ])
        );
    }

    #[test]
    fn startup_merge_without_current_config_uses_gui_defaults() {
        let template = "# Template\nhost: \"\"\nport: 9000\napi-keys:\n  - template-key\nplugins:\n  enabled: true\nrouting:\n  strategy: fill-first\ndebug: false\n";
        let merged = merge_core_config_yaml(template, None, &GuiConfigFile::default()).unwrap();
        let document = serde_norway::from_str::<serde_norway::Value>(&merged).unwrap();

        assert!(merged.contains("# Template"));
        assert_eq!(
            document["host"],
            serde_norway::Value::String("127.0.0.1".to_string())
        );
        assert_eq!(document["port"], serde_norway::to_value(8317_u16).unwrap());
        assert_eq!(document["debug"], serde_norway::Value::Bool(false));
        assert_eq!(document["api-keys"][0], DEFAULT_API_KEY, "{merged}");
        assert_eq!(document["plugins"]["enabled"], false);
        assert_eq!(document["routing"]["strategy"], "round-robin");
        assert_eq!(document["usage-statistics-enabled"], true);
    }

    #[test]
    fn release_atom_parser_reads_first_release_tag() {
        let xml = r#"
          <feed>
            <entry>
              <link href="https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.80"/>
              <title>v7.2.80</title>
            </entry>
            <entry><title>v7.2.79</title></entry>
          </feed>
        "#;

        assert_eq!(release_tag_from_atom(xml).as_deref(), Some("v7.2.80"));
    }

    #[test]
    fn synthetic_release_uses_official_asset_names_and_urls() {
        let release = release_from_tag("7.2.80");
        let platform = CorePlatform {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
            asset_os: "linux".to_string(),
            asset_arch: "amd64".to_string(),
            archive_kind: "tar.gz".to_string(),
        };
        let asset = select_release_asset(&release, &platform).unwrap();

        assert_eq!(release.tag_name, "v7.2.80");
        assert_eq!(asset.name, "CLIProxyAPI_7.2.80_linux_amd64.tar.gz");
        assert_eq!(
            asset.browser_download_url,
            "https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.80/CLIProxyAPI_7.2.80_linux_amd64.tar.gz"
        );
    }

    #[test]
    fn release_asset_names_cover_the_six_supported_gui_targets() {
        let targets = [
            ("linux", "amd64", "tar.gz"),
            ("linux", "aarch64", "tar.gz"),
            ("darwin", "amd64", "tar.gz"),
            ("darwin", "aarch64", "tar.gz"),
            ("windows", "amd64", "zip"),
            ("windows", "aarch64", "zip"),
        ];
        for (os, arch, archive_kind) in targets {
            let platform = CorePlatform {
                os: os.to_string(),
                arch: arch.to_string(),
                asset_os: os.to_string(),
                asset_arch: arch.to_string(),
                archive_kind: archive_kind.to_string(),
            };
            assert_eq!(
                core_release_asset_name("v7.2.83", &platform),
                format!("CLIProxyAPI_7.2.83_{os}_{arch}.{archive_kind}")
            );
        }
    }

    #[test]
    fn agent_launch_requires_an_active_managed_configuration() {
        assert!(
            validate_agent_launch_modification(AgentClient::Codex, true, AGENT_PHASE_ACTIVE)
                .is_ok()
        );
        assert!(
            validate_agent_launch_modification(AgentClient::Codex, false, AGENT_PHASE_ACTIVE)
                .is_err()
        );
        assert!(validate_agent_launch_modification(
            AgentClient::Codex,
            true,
            AGENT_MODIFICATION_STATE_CONFLICT,
        )
        .is_err());
    }

    #[test]
    fn replacing_a_core_preserves_only_regular_bundled_assets() {
        let root = agent_test_home("bundled-assets");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(
            source.join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz"),
            b"archive",
        )
        .unwrap();
        fs::write(
            source.join("CLIProxyAPI_7.2.83_linux_amd64_no-plugin.tar.gz"),
            b"portable",
        )
        .unwrap();
        fs::write(source.join(CORE_CHECKSUMS_FILE), b"checksums").unwrap();

        preserve_bundled_core_assets(&source, &target).unwrap();

        assert!(target
            .join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz")
            .is_file());
        assert!(!target
            .join("CLIProxyAPI_7.2.83_linux_amd64_no-plugin.tar.gz")
            .exists());
        assert!(target.join(CORE_CHECKSUMS_FILE).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacing_a_core_preserves_the_existing_configuration_bytes() {
        let root = agent_test_home("core-config-preserve");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        let original = b"host: 127.0.0.1\n# keep this comment\ndebug: true\n";
        fs::write(source.join(CORE_CONFIG_FILE), original).unwrap();

        preserve_core_runtime_files(&source, &target).unwrap();

        assert_eq!(fs::read(target.join(CORE_CONFIG_FILE)).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_project_root_is_detected_from_the_portable_development_directory() {
        let root = agent_test_home("bundled-source-root");
        fs::create_dir_all(root.join("src-tauri")).unwrap();
        fs::create_dir_all(root.join("bin-work")).unwrap();
        fs::write(root.join("package.json"), b"{}").unwrap();

        assert_eq!(
            source_project_root(&root.join("bin-work")),
            Some(root.clone())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_source_archive_and_checksums_are_copied_into_the_installation() {
        let root = agent_test_home("selected-bundled-asset");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        let archive = source.join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz");
        fs::write(&archive, b"archive").unwrap();
        fs::write(source.join(CORE_CHECKSUMS_FILE), b"checksums").unwrap();

        preserve_selected_bundled_core_asset(&archive, &target).unwrap();

        assert_eq!(
            fs::read(target.join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz")).unwrap(),
            b"archive"
        );
        assert_eq!(
            fs::read(target.join(CORE_CHECKSUMS_FILE)).unwrap(),
            b"checksums"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn release_page_assets_parse_download_links_and_sha256() {
        let html = r#"
          <li><a href="/router-for-me/CLIProxyAPI/releases/download/v1.2.3/checksums.txt">checksums.txt</a></li>
          <li><a href="/router-for-me/CLIProxyAPI/releases/download/v1.2.3/CLIProxyAPI_1.2.3_linux_amd64.tar.gz">asset</a>
            <span>sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef</span>
          </li>
        "#;

        let assets = parse_release_assets(html);
        assert_eq!(assets.len(), 2);
        assert_eq!(assets[1].name, "CLIProxyAPI_1.2.3_linux_amd64.tar.gz");
        assert_eq!(
            assets[1].digest.as_deref(),
            Some("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        assert!(assets[1]
            .browser_download_url
            .ends_with("/releases/download/v1.2.3/CLIProxyAPI_1.2.3_linux_amd64.tar.gz"));
    }
}
