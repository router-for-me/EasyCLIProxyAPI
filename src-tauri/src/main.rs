#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    fs::File,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tar::Archive;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;
use zip::ZipArchive;

const RELEASE_API_URL: &str =
    "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";
const CORE_INSTALL_PROGRESS_EVENT: &str = "core-install-progress";
const CORE_METADATA_FILE: &str = "cpa-gui-meta.json";
const CORE_CONFIG_FILE: &str = "config.yaml";
const CORE_EXAMPLE_CONFIG_FILE: &str = "config.example.yaml";
const USER_AGENT: &str = "CPA-GUI";

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

        let Some(process) = child.as_mut() else {
            return None;
        };

        match process.try_wait() {
            Ok(None) => Some(process.id()),
            Ok(Some(_)) | Err(_) => {
                *child = None;
                None
            }
        }
    }

    fn take_child(&self) -> Option<Child> {
        self.child.lock().ok().and_then(|mut child| child.take())
    }

    fn store_child(&self, child: Child) -> Result<u32, String> {
        let pid = child.id();
        let mut managed_child = self
            .child
            .lock()
            .map_err(|_| "内核进程状态锁已损坏".to_string())?;
        *managed_child = Some(child);

        Ok(pid)
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
) -> Result<CoreStatus, String> {
    current_core_status(Some(process_state.inner()))
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
) -> Result<CoreStatus, String> {
    start_core_process_inner(process_state.inner())?;
    current_core_status(Some(process_state.inner()))
}

#[tauri::command]
fn stop_core_process(
    process_state: tauri::State<'_, CoreProcessState>,
) -> Result<CoreStatus, String> {
    stop_core_process_inner(process_state.inner())?;
    current_core_status(Some(process_state.inner()))
}

#[tauri::command]
fn restart_core_process(
    process_state: tauri::State<'_, CoreProcessState>,
) -> Result<CoreStatus, String> {
    let _ = stop_core_process_inner(process_state.inner());
    start_core_process_inner(process_state.inner())?;
    current_core_status(Some(process_state.inner()))
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

    if current_core_status(None)?.running {
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

async fn fetch_release(
    client: &reqwest::Client,
    version: Option<&str>,
) -> Result<GithubRelease, String> {
    let url = version.map_or_else(
        || RELEASE_API_URL.to_string(),
        |version| {
            format!(
                "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/tags/{}",
                normalize_version(version)
            )
        },
    );

    client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("GitHub 请求失败: {err}"))?
        .error_for_status()
        .map_err(|err| format!("GitHub 返回错误状态: {err}"))?
        .json::<GithubRelease>()
        .await
        .map_err(|err| format!("解析 GitHub release 失败: {err}"))
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
    let version = normalize_version(&release.tag_name);
    let version = version.trim_start_matches('v');
    let expected_name = format!(
        "CLIProxyAPI_{}_{}_{}.{}",
        version, platform.asset_os, platform.asset_arch, platform.archive_kind
    );
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

fn current_core_status(process_state: Option<&CoreProcessState>) -> Result<CoreStatus, String> {
    let install_dir = core_install_dir()?;
    let binary_path = find_core_binary(&install_dir);
    let installed = binary_path.is_some();
    let managed_pid = process_state.and_then(|state| state.managed_pid());
    let process_ids = binary_path
        .as_ref()
        .map(|path| find_core_process_ids(path))
        .unwrap_or_default();
    let process_id = managed_pid.or_else(|| process_ids.first().copied());
    let running = process_id.is_some();
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

fn start_core_process_inner(process_state: &CoreProcessState) -> Result<(), String> {
    let install_dir = core_install_dir()?;
    let binary_path = find_core_binary(&install_dir)
        .ok_or_else(|| "未安装 CPA 内核，请先安装最新版".to_string())?;
    let config_path = ensure_core_config(&install_dir)?;

    if process_state.managed_pid().is_some() || is_core_running(&binary_path) {
        return Err("CPA 内核已经在运行".to_string());
    }

    let config_path = path_to_string(&config_path);
    let mut child = Command::new(&binary_path)
        .args(["-config", &config_path])
        .current_dir(&install_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("启动 CPA 内核失败: {err}"))?;

    thread::sleep(Duration::from_millis(200));
    if let Some(status) = child
        .try_wait()
        .map_err(|err| format!("检查 CPA 内核启动状态失败: {err}"))?
    {
        return Err(format!("CPA 内核启动后立即退出: {status}"));
    }

    process_state.store_child(child)?;

    Ok(())
}

fn ensure_core_config(install_dir: &Path) -> Result<PathBuf, String> {
    let config_path = install_dir.join(CORE_CONFIG_FILE);
    if config_path.is_file() {
        return Ok(config_path);
    }

    let example_config_path = install_dir.join(CORE_EXAMPLE_CONFIG_FILE);
    if !example_config_path.is_file() {
        return Err(format!(
            "未找到内核配置模板: {}",
            path_to_string(&example_config_path)
        ));
    }

    fs::copy(&example_config_path, &config_path).map_err(|err| {
        format!(
            "初始化内核配置失败 {} -> {}: {err}",
            path_to_string(&example_config_path),
            path_to_string(&config_path)
        )
    })?;

    Ok(config_path)
}

fn stop_core_process_inner(process_state: &CoreProcessState) -> Result<(), String> {
    if let Some(mut child) = process_state.take_child() {
        terminate_child(&mut child)?;
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

fn terminate_child(child: &mut Child) -> Result<(), String> {
    let process_id = child.id();

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
    tauri::Builder::default()
        .manage(CoreDownloadState::default())
        .manage(CoreProcessState::default())
        .invoke_handler(tauri::generate_handler![
            health_check,
            detect_core_platform,
            get_core_status,
            check_latest_core,
            install_core_version,
            cancel_core_install,
            get_core_install_task,
            start_core_process,
            stop_core_process,
            restart_core_process
        ])
        .run(tauri::generate_context!())
        .expect("failed to run app");
}
