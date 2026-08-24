use super::*;

#[tauri::command]
pub(crate) async fn check_latest_core(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreLatest, String> {
    let platform = current_core_platform()?;
    let config = gui_config_state.snapshot()?;
    let proxy_url = config.proxy_url;
    let client = http_client(&proxy_url)?;
    let release = fetch_release(&client, None, config.prefer_gitcode_downloads).await?;
    let asset = select_release_asset(&release, &platform)?;

    Ok(CoreLatest {
        version: normalize_version(&release.tag_name),
        asset_name: asset.name.clone(),
    })
}

#[tauri::command]
pub(crate) fn detect_bundled_core() -> Result<Option<BundledCoreInfo>, String> {
    bundled_core_archive().map(|value| value.map(|(info, _)| info))
}

#[tauri::command]
pub(crate) fn install_bundled_core(
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

pub(crate) fn core_needs_bundled_bootstrap(install_dir: &Path) -> bool {
    find_core_binary(install_dir).is_none()
}

pub(crate) fn auto_install_bundled_core_if_missing(app: &tauri::AppHandle) -> Result<bool, String> {
    let install_dir = core_install_dir()?;
    if !core_needs_bundled_bootstrap(&install_dir) {
        return Ok(false);
    }

    let (info, archive_path) = bundled_core_archive()?
        .ok_or_else(|| "未检测到 CPA 内核，且当前发行包没有匹配的离线内核".to_string())?;
    let window = app
        .get_webview_window("main")
        .map(|webview| webview.as_ref().window())
        .ok_or_else(|| "无法获取主窗口，不能自动安装离线内核".to_string())?;
    let state = app.state::<CoreDownloadState>();
    state.start(CancellationToken::new(), Some(info.version.clone()))?;
    let result = install_bundled_core_inner(&window, state.inner(), &info, &archive_path);
    if result.is_err() {
        let _ = cleanup_core_work_dirs();
    }
    state.finish(&window, result.clone());
    result?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn cancel_core_install(state: tauri::State<'_, CoreDownloadState>) {
    state.cancel();
}

#[tauri::command]
pub(crate) fn get_core_install_task(state: tauri::State<'_, CoreDownloadState>) -> CoreInstallTask {
    state.snapshot()
}

#[tauri::command]
pub(crate) async fn install_core_version(
    window: tauri::Window,
    state: tauri::State<'_, CoreDownloadState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    version: Option<String>,
) -> Result<CoreInstallResult, String> {
    let config = gui_config_state.snapshot()?;
    let proxy_url = config.proxy_url;
    let token = CancellationToken::new();
    state.start(token.clone(), version.clone())?;
    let result = install_core_version_inner(
        &window,
        state.inner(),
        token,
        version,
        &proxy_url,
        config.prefer_gitcode_downloads,
    )
    .await;
    if result.is_err() {
        let _ = cleanup_core_work_dirs();
    }
    state.finish(&window, result.clone());

    result
}

#[tauri::command]
pub(crate) fn start_core_process(
    app: tauri::AppHandle,
    process_state: tauri::State<'_, CoreProcessState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreStatus, String> {
    let status = start_core_process_with_state(process_state.inner(), gui_config_state.inner())?;
    emit_core_status(&app, &status);
    Ok(status)
}

pub(crate) fn start_core_process_with_state(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) -> Result<CoreStatus, String> {
    let config = gui_config_state.snapshot()?;
    start_core_process_inner(process_state, &config)?;
    if let Err(error) = gui_config_state.set_run_on_startup(true) {
        let _ = stop_core_process_inner(process_state);
        return Err(error);
    }
    current_core_status(Some(process_state), Some(config.port))
}

#[tauri::command]
pub(crate) fn stop_core_process(
    app: tauri::AppHandle,
    process_state: tauri::State<'_, CoreProcessState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreStatus, String> {
    let status = stop_core_process_with_state(process_state.inner(), gui_config_state.inner())?;
    emit_core_status(&app, &status);
    Ok(status)
}

pub(crate) fn stop_core_process_with_state(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) -> Result<CoreStatus, String> {
    stop_core_process_inner(process_state)?;
    let config = gui_config_state.set_run_on_startup(false)?;
    current_core_status(Some(process_state), Some(config.port))
}

#[tauri::command]
pub(crate) fn restart_core_process(
    app: tauri::AppHandle,
    process_state: tauri::State<'_, CoreProcessState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreStatus, String> {
    let status = restart_core_process_with_state(process_state.inner(), gui_config_state.inner())?;
    emit_core_status(&app, &status);
    Ok(status)
}

pub(crate) fn restart_core_process_with_state(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) -> Result<CoreStatus, String> {
    let config = gui_config_state.snapshot()?;
    let _ = stop_core_process_inner(process_state);
    start_core_process_inner(process_state, &config)?;
    if let Err(error) = gui_config_state.set_run_on_startup(true) {
        let _ = stop_core_process_inner(process_state);
        return Err(error);
    }
    current_core_status(Some(process_state), Some(config.port))
}

pub(crate) async fn install_core_version_inner(
    window: &tauri::Window,
    state: &CoreDownloadState,
    token: CancellationToken,
    version: Option<String>,
    proxy_url: &str,
    prefer_gitcode: bool,
) -> Result<CoreInstallResult, String> {
    let platform = current_core_platform()?;
    let client = http_client(proxy_url)?;
    state.progress(window, "检查版本", 0, None, true);
    let release =
        fetch_release_cancelable(&client, version.as_deref(), &token, prefer_gitcode).await?;
    let asset = select_release_asset(&release, &platform)?;

    let install_dir = core_install_dir()?;
    let base_dir = core_base_dir()?;
    let staging_dir = base_dir.join("cpa-core.staging");
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

    let downloaded = download_asset(&client, asset, &archive_path, window, state, &token).await?;
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
    migrate_core_config_for_update(&install_dir, &staging_dir)?;
    preserve_bundled_core_assets(&install_dir, &staging_dir)?;
    write_core_metadata(
        &staging_dir,
        &CoreMetadata {
            version: normalize_version(&release.tag_name),
            asset_name: asset.name.clone(),
            installed_at_unix: unix_now(),
        },
    )?;

    overlay_install_dir(&install_dir, &staging_dir)?;
    let _ = fs::remove_dir_all(&download_dir);

    Ok(CoreInstallResult {
        version: normalize_version(&release.tag_name),
        asset_name: asset.name.clone(),
        install_dir: path_to_string(&install_dir),
        binary_path: Some(path_to_string(&install_dir.join(binary_relative_path))),
    })
}

pub(crate) fn install_bundled_core_inner(
    window: &tauri::Window,
    state: &CoreDownloadState,
    info: &BundledCoreInfo,
    archive_path: &Path,
) -> Result<CoreInstallResult, String> {
    let platform = current_core_platform()?;
    let install_dir = core_install_dir()?;
    let base_dir = core_base_dir()?;
    let staging_dir = base_dir.join("cpa-core.staging");

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
    migrate_core_config_for_update(&install_dir, &staging_dir)?;
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
    overlay_install_dir(&install_dir, &staging_dir)?;

    Ok(CoreInstallResult {
        version: info.version.clone(),
        asset_name: info.asset_name.clone(),
        install_dir: path_to_string(&install_dir),
        binary_path: Some(path_to_string(&install_dir.join(binary_relative_path))),
    })
}

pub(crate) async fn fetch_release(
    client: &reqwest::Client,
    version: Option<&str>,
    prefer_gitcode: bool,
) -> Result<GithubRelease, String> {
    if let Some(version) = version {
        return Ok(release_from_tag_for_repositories(
            version,
            configured_gitcode_core_repository(),
            prefer_gitcode,
        ));
    }
    if prefer_gitcode {
        if let Some(repository) = configured_gitcode_core_repository() {
            return match fetch_release_from_gitcode(client, repository).await {
                Ok(release) => Ok(release),
                Err(gitcode_error) => fetch_release_from_github(client)
                    .await
                    .map_err(|github_error| {
                        format!(
                            "GitCode 内核发布源失败: {gitcode_error}；GitHub 回退源失败: {github_error}"
                        )
                    }),
            };
        }
    }
    let github_result = fetch_release_from_github(client).await;
    match github_result {
        Ok(release) => Ok(release),
        Err(github_error) => {
            let Some(repository) = configured_gitcode_core_repository() else {
                return Err(github_error);
            };
            fetch_release_from_gitcode(client, repository)
                .await
                .map_err(|gitcode_error| {
                    format!(
                        "GitHub 内核发布源失败: {github_error}；GitCode 回退源失败: {gitcode_error}"
                    )
                })
        }
    }
}

pub(crate) async fn fetch_release_from_github(
    client: &reqwest::Client,
) -> Result<GithubRelease, String> {
    let atom_result = fetch_release_from_atom(client).await;
    match atom_result {
        Ok(release) => Ok(release),
        Err(atom_error) => fetch_release_from_page(client).await.map_err(|page_error| {
            format!("GitHub 发布源请求失败: {atom_error}；release 页面请求失败: {page_error}")
        }),
    }
}

pub(crate) async fn fetch_release_from_gitcode(
    client: &reqwest::Client,
    repository: &str,
) -> Result<GithubRelease, String> {
    let release_url = format!("https://api.gitcode.com/api/v5/repos/{repository}/releases/latest");
    let release = client
        .get(release_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("查询 GitCode 最新内核发行版失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("读取 GitCode 最新内核发行版失败: {error}"))?
        .json::<GitcodeRelease>()
        .await
        .map_err(|error| format!("解析 GitCode 最新内核发行版失败: {error}"))?;
    validate_release_tag(&release.tag_name)?;
    Ok(release_from_gitcode_tag(&release.tag_name, repository))
}

pub(crate) async fn fetch_release_from_page(
    client: &reqwest::Client,
) -> Result<GithubRelease, String> {
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

pub(crate) async fn fetch_release_from_atom(
    client: &reqwest::Client,
) -> Result<GithubRelease, String> {
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

pub(crate) fn release_tag_from_atom(xml: &str) -> Option<String> {
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

pub(crate) fn release_from_tag(tag: &str) -> GithubRelease {
    release_from_tag_for_repositories(tag, configured_gitcode_core_repository(), false)
}

pub(crate) fn release_from_gitcode_tag(tag: &str, repository: &str) -> GithubRelease {
    release_from_tag_for_repositories(tag, Some(repository), true)
}

pub(crate) fn release_from_tag_for_repositories(
    tag: &str,
    gitcode_repository: Option<&str>,
    prefer_gitcode: bool,
) -> GithubRelease {
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
        let github_url = format!("{RELEASE_DOWNLOAD_PREFIX}{tag}/{name}");
        let gitcode_url = gitcode_repository
            .map(|repository| gitcode_release_attachment_url(repository, &tag, &name));
        let (browser_download_url, fallback_download_urls) = if prefer_gitcode {
            match gitcode_url {
                Some(gitcode_url) => (gitcode_url, vec![github_url]),
                None => (github_url, Vec::new()),
            }
        } else {
            (github_url, gitcode_url.into_iter().collect())
        };
        GithubAsset {
            browser_download_url,
            fallback_download_urls,
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

pub(crate) fn release_tag_from_url(url: &reqwest::Url) -> Option<String> {
    let mut segments = url.path_segments()?;
    let tag = segments.next_back()?.trim();
    if tag.is_empty() || tag == "latest" {
        None
    } else {
        Some(tag.to_string())
    }
}

pub(crate) fn is_app_update_available(current: &str, latest: &str) -> Result<bool, String> {
    let parse = |value: &str| {
        semver::Version::parse(value.trim().trim_start_matches('v'))
            .map_err(|error| format!("无法解析版本号 {value}: {error}"))
    };
    Ok(parse(latest)? > parse(current)?)
}

#[cfg(test)]
pub(crate) fn parse_release_assets(html: &str) -> Vec<GithubAsset> {
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
                fallback_download_urls: Vec::new(),
                size: None,
                digest,
            });
        }
        cursor = href_end + 1;
    }

    assets
}

pub(crate) fn format_github_error(status: u16, body: &str) -> String {
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

pub(crate) async fn fetch_release_cancelable(
    client: &reqwest::Client,
    version: Option<&str>,
    token: &CancellationToken,
    prefer_gitcode: bool,
) -> Result<GithubRelease, String> {
    tokio::select! {
        result = fetch_release(client, version, prefer_gitcode) => result,
        _ = token.cancelled() => Err("已取消下载".to_string()),
    }
}

pub(crate) fn apply_configured_proxy(
    builder: reqwest::ClientBuilder,
    proxy_url: &str,
) -> Result<reqwest::ClientBuilder, String> {
    let proxy_url = proxy_url.trim();
    if proxy_url.is_empty() {
        return Ok(builder);
    }
    let proxy =
        reqwest::Proxy::all(proxy_url).map_err(|error| format!("代理 URL 无效: {error}"))?;
    Ok(builder.proxy(proxy))
}

pub(crate) fn build_http_client_with_proxy(
    builder: reqwest::ClientBuilder,
    proxy_url: &str,
    error_prefix: &str,
) -> Result<reqwest::Client, String> {
    apply_configured_proxy(builder, proxy_url)
        .map_err(|error| format!("{error_prefix}: {error}"))?
        .build()
        .map_err(|error| format!("{error_prefix}: {error}"))
}

pub(crate) fn http_client(proxy_url: &str) -> Result<reqwest::Client, String> {
    build_http_client_with_proxy(
        reqwest::Client::builder()
            .redirect(release_https_redirect_policy())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(600)),
        proxy_url,
        "创建 HTTP 客户端失败",
    )
}

pub(crate) fn select_release_asset<'a>(
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

pub(crate) fn core_release_asset_name(version: &str, platform: &CorePlatform) -> String {
    let version = normalize_version(version);
    let version = version.trim_start_matches('v');
    format!(
        "CLIProxyAPI_{}_{}_{}.{}",
        version, platform.asset_os, platform.asset_arch, platform.archive_kind
    )
}

// Download progress and cancellation require the complete transfer context here.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_asset(
    client: &reqwest::Client,
    asset: &GithubAsset,
    archive_path: &Path,
    window: &tauri::Window,
    state: &CoreDownloadState,
    token: &CancellationToken,
) -> Result<DownloadedArchive, String> {
    let urls =
        std::iter::once(&asset.browser_download_url).chain(asset.fallback_download_urls.iter());
    let mut failures = Vec::new();
    for (index, url) in urls.enumerate() {
        if index > 0 {
            state.progress(
                window,
                &format!("下载失败，正在切换到 {}", core_download_source_name(url)),
                0,
                asset.size,
                true,
            );
        }
        let result = download_asset_inner(
            client,
            url,
            archive_path,
            asset.size,
            asset.digest.as_deref(),
            window,
            state,
            token,
        )
        .await;
        match result {
            Ok(downloaded) => return Ok(downloaded),
            Err(error) if token.is_cancelled() => {
                let _ = fs::remove_file(archive_path);
                return Err(error);
            }
            Err(error) => {
                let _ = fs::remove_file(archive_path);
                failures.push(error);
            }
        }
    }
    if failures.is_empty() {
        let _ = fs::remove_file(archive_path);
        return Err("内核发行版没有可用的下载地址".to_string());
    }
    Err(format!("所有内核下载源均失败: {}", failures.join("；")))
}

pub(crate) fn core_download_source_name(url: &str) -> &'static str {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .filter(|host| host == "api.gitcode.com" || host.ends_with(".gitcode.com"))
        .map(|_| "GitCode")
        .unwrap_or("GitHub")
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_asset_inner(
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

pub(crate) fn ensure_not_cancelled(
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

pub(crate) fn current_core_platform() -> Result<CorePlatform, String> {
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

pub(crate) fn current_core_status(
    process_state: Option<&CoreProcessState>,
    management_port: Option<u16>,
) -> Result<CoreStatus, String> {
    let install_dir = core_install_dir()?;
    let binary_path = find_core_binary(&install_dir);
    let installed = binary_path.is_some();
    let starting = process_state.is_some_and(CoreProcessState::is_starting);
    let managed_pid = process_state.and_then(|state| state.managed_pid());
    let management_port_open = management_port.map(is_management_port_open);
    let process_id = match managed_pid {
        Some(process_id) => Some(process_id),
        None if management_port_open.unwrap_or(true) => binary_path
            .as_ref()
            .and_then(|path| find_core_process_ids(path).first().copied()),
        None => None,
    };
    let running = process_id.is_some() && management_port_open.unwrap_or(true);
    let current_version = read_core_metadata(&install_dir).map(|metadata| metadata.version);

    let message = if starting {
        "CPA 内核正在启动".to_string()
    } else if !installed {
        "未安装 CPA 内核，请先安装最新版".to_string()
    } else if running {
        "CPA 内核正在运行".to_string()
    } else {
        "CPA 内核已安装，当前未运行".to_string()
    };

    Ok(CoreStatus {
        installed,
        running,
        starting,
        managed: managed_pid.is_some(),
        process_id,
        current_version,
        install_dir: path_to_string(&install_dir),
        binary_path: binary_path.map(|path| path_to_string(&path)),
        message,
    })
}

pub(crate) fn is_management_port_open(port: u16) -> bool {
    let listen_host = read_installed_core_config_settings()
        .map(|settings| settings.host)
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    let Ok(address) = core_management_address(&listen_host, port) else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok()
}

fn core_management_address(listen_host: &str, port: u16) -> Result<SocketAddr, String> {
    let host = core_connect_host(listen_host);
    let ip = host
        .parse::<IpAddr>()
        .map_err(|_| format!("Invalid core listen IP: {listen_host}"))?;
    Ok(SocketAddr::new(ip, port))
}

pub(crate) fn start_core_process_inner(
    process_state: &CoreProcessState,
    gui_config: &GuiConfigFile,
) -> Result<(), String> {
    let install_dir = core_install_dir()?;
    if !gui_config.auth_dir.trim().is_empty() {
        let auth_dir = auth_dir_path_for_core(&gui_config.auth_dir, &install_dir);
        fs::create_dir_all(&auth_dir)
            .map_err(|error| format!("创建凭证目录失败 {}: {error}", path_to_string(&auth_dir)))?;
    }
    let binary_path = find_core_binary(&install_dir)
        .ok_or_else(|| "未安装 CPA 内核，请先安装最新版".to_string())?;

    if process_state.managed_pid().is_some() || is_core_running(&binary_path) {
        return Err("CPA 内核已经在运行".to_string());
    }
    let management_address = core_management_address(&gui_config.host, gui_config.port)?;
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
    configure_background_command(&mut command);
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

pub(crate) fn wait_for_core_management_port(
    child: &mut Child,
    address: SocketAddr,
) -> Result<(), String> {
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

pub(crate) fn configure_child_lifetime(command: &mut Command) {
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
                        "EasyCLIProxyAPI exited before the core process started",
                    ));
                }

                Ok(())
            });
        }
    }

    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

pub(crate) fn configure_background_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

pub(crate) fn configure_networked_command(command: &mut Command, proxy_url: &str) {
    let proxy_url = proxy_url.trim();
    if proxy_url.is_empty() {
        return;
    }

    for variable in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        command.env(variable, proxy_url);
    }
}

pub(crate) fn stop_core_process_inner(process_state: &CoreProcessState) -> Result<(), String> {
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

pub(crate) fn core_install_dir() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join("cpa-core"))
}

pub(crate) fn executable_dir() -> Result<PathBuf, String> {
    let exe_path = env::current_exe().map_err(|err| format!("读取当前程序路径失败: {err}"))?;
    exe_path
        .parent()
        .map(|path| path.to_path_buf())
        .ok_or_else(|| format!("当前程序路径没有父目录: {}", path_to_string(&exe_path)))
}

pub(crate) fn macos_app_resources_dir(executable_dir: &Path) -> Option<PathBuf> {
    if executable_dir.file_name().and_then(|name| name.to_str()) != Some("MacOS") {
        return None;
    }
    let contents_dir = executable_dir.parent()?;
    if contents_dir.file_name().and_then(|name| name.to_str()) != Some("Contents") {
        return None;
    }
    let app_dir = contents_dir.parent()?;
    if app_dir.extension().and_then(|extension| extension.to_str()) != Some("app") {
        return None;
    }
    Some(contents_dir.join("Resources"))
}

pub(crate) fn core_base_dir() -> Result<PathBuf, String> {
    let executable_dir = executable_dir()?;
    #[cfg(target_os = "macos")]
    if macos_app_resources_dir(&executable_dir).is_some() {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "无法确定 macOS 用户目录".to_string())?;
        return Ok(home_dir
            .join("Library")
            .join("Application Support")
            .join("com.cpa.gui"));
    }
    Ok(executable_dir)
}

pub(crate) fn bundled_core_locations(
    base_dir: &Path,
    executable_dir: &Path,
) -> Vec<(PathBuf, PathBuf)> {
    let mut locations = vec![(base_dir.join(CORE_VERSION_FILE), base_dir.join("cpa-core"))];
    if let Some(resources_dir) = macos_app_resources_dir(executable_dir) {
        locations.push((
            resources_dir.join(CORE_VERSION_FILE),
            resources_dir.join("cpa-core"),
        ));
    }
    if let Some(project_root) = source_project_root(executable_dir) {
        if project_root != base_dir {
            locations.push((
                project_root.join(CORE_VERSION_FILE),
                project_root.join("cpa-core"),
            ));
        }
    }
    locations
}

pub(crate) fn bundled_core_archive() -> Result<Option<(BundledCoreInfo, PathBuf)>, String> {
    let platform = current_core_platform()?;
    let base_dir = core_base_dir()?;
    let executable_dir = executable_dir()?;
    let locations = bundled_core_locations(&base_dir, &executable_dir);

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

pub(crate) fn source_project_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|directory| {
        (directory.join("package.json").is_file() && directory.join("src-tauri").is_dir())
            .then(|| directory.to_path_buf())
    })
}

pub(crate) fn preserve_bundled_core_assets(
    source_dir: &Path,
    target_dir: &Path,
) -> Result<(), String> {
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

pub(crate) fn preserve_selected_bundled_core_asset(
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

pub(crate) fn migrate_core_config_for_update(
    source_dir: &Path,
    target_dir: &Path,
) -> Result<(), String> {
    if !source_dir.is_dir() {
        return Ok(());
    }
    let old_config_path = source_dir.join(CORE_CONFIG_FILE);
    if !old_config_path.is_file() {
        return Ok(());
    }

    let template_path = target_dir.join(CORE_EXAMPLE_CONFIG_FILE);
    if !template_path.is_file() {
        return Err(format!(
            "新版内核缺少配置模板，已取消更新: {}",
            path_to_string(&template_path)
        ));
    }
    let old_config = match fs::read(&old_config_path) {
        Ok(content) => String::from_utf8_lossy(&content).into_owned(),
        Err(error) => {
            eprintln!(
                "读取旧版内核配置失败，将使用新版默认配置继续更新 {}: {error}",
                path_to_string(&old_config_path)
            );
            String::new()
        }
    };
    let template = fs::read_to_string(&template_path).map_err(|error| {
        format!(
            "读取新版内核配置模板失败 {}: {error}",
            path_to_string(&template_path)
        )
    })?;
    let migrated = merge_core_config_fields_tolerant(&template, &old_config)?;
    let config_path = target_dir.join(CORE_CONFIG_FILE);
    fs::write(&config_path, migrated).map_err(|error| {
        format!(
            "写入迁移后的新版内核配置失败 {}: {error}",
            path_to_string(&config_path)
        )
    })?;
    Ok(())
}

pub(crate) fn validate_bundled_core_checksum(archive_path: &Path) -> Result<(), String> {
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

pub(crate) fn sha256_file(path: &Path) -> Result<String, String> {
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

pub(crate) fn read_core_metadata(install_dir: &Path) -> Option<CoreMetadata> {
    let metadata_path = install_dir.join(CORE_METADATA_FILE);
    let content = fs::read_to_string(metadata_path).ok()?;
    serde_json::from_str(&content).ok()
}

pub(crate) fn write_core_metadata(
    install_dir: &Path,
    metadata: &CoreMetadata,
) -> Result<(), String> {
    let metadata_path = install_dir.join(CORE_METADATA_FILE);
    let content = serde_json::to_string_pretty(metadata)
        .map_err(|err| format!("生成内核元数据失败: {err}"))?;
    fs::write(metadata_path, content).map_err(|err| format!("写入内核元数据失败: {err}"))
}

pub(crate) fn validate_downloaded_asset(
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

pub(crate) fn validate_download_metadata(
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

pub(crate) fn cleanup_core_work_dirs() -> Result<(), String> {
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

pub(crate) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(crate) fn normalize_version(version: &str) -> String {
    let version = version.trim();

    if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    }
}

pub(crate) fn is_core_running(binary_path: &Path) -> bool {
    !find_core_process_ids(binary_path).is_empty()
}

pub(crate) fn find_core_process_ids(binary_path: &Path) -> Vec<u32> {
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
pub(crate) fn find_core_process_ids_linux(binary_path: &Path) -> Vec<u32> {
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
pub(crate) fn find_core_process_ids_by_name() -> Vec<u32> {
    let image_name = core_binary_name();
    let filter = format!("IMAGENAME eq {image_name}");
    let mut command = Command::new("tasklist");
    command.args(["/FI", &filter, "/FO", "CSV", "/NH"]);
    configure_background_command(&mut command);
    let output = command.output();
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
pub(crate) fn find_core_process_ids_by_name() -> Vec<u32> {
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

pub(crate) fn shutdown_managed_core(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) {
    let was_running = process_state.managed_pid().is_some();
    let _ = gui_config_state.set_run_on_startup(was_running);

    if let Some(mut child) = process_state.take_child() {
        let _ = terminate_child(&mut child);
    }
    process_state.clear_lifetime_guard();
}

#[cfg(windows)]
pub(crate) fn attach_child_to_windows_job(child: &Child) -> Result<isize, String> {
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
pub(crate) fn close_windows_handle(handle: isize) {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

    unsafe {
        CloseHandle(handle as HANDLE);
    }
}

pub(crate) fn terminate_child(child: &mut Child) -> Result<(), String> {
    #[cfg(windows)]
    {
        child
            .kill()
            .map_err(|err| format!("关闭 CPA 内核进程失败: {err}"))?;
        child
            .wait()
            .map_err(|err| format!("等待 CPA 内核进程退出失败: {err}"))?;
        Ok(())
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

pub(crate) fn terminate_process_id(process_id: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let process_id = process_id.to_string();
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &process_id, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut command);
        let status = command
            .status()
            .map_err(|err| format!("关闭 CPA 内核进程失败: {err}"))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("关闭 CPA 内核进程失败: PID {process_id}"))
        }
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
pub(crate) fn send_process_signal(process_id: u32, signal: &str) -> Result<(), String> {
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
pub(crate) fn is_process_alive(process_id: u32) -> bool {
    let process_id = process_id.to_string();
    Command::new("kill")
        .args(["-0", &process_id])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(crate) fn reset_dir(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|err| format!("清理目录失败 {}: {err}", path_to_string(path)))?;
    }

    fs::create_dir_all(path).map_err(|err| format!("创建目录失败 {}: {err}", path_to_string(path)))
}

pub(crate) fn overlay_install_dir(install_dir: &Path, staging_dir: &Path) -> Result<(), String> {
    if !staging_dir.is_dir() {
        return Err(format!(
            "内核暂存目录不存在: {}",
            path_to_string(staging_dir)
        ));
    }

    if !install_dir.exists() {
        return fs::rename(staging_dir, install_dir)
            .map_err(|err| format!("安装新内核目录失败: {err}"));
    }
    if !install_dir.is_dir() {
        return Err(format!(
            "内核安装路径不是目录: {}",
            path_to_string(install_dir)
        ));
    }

    overlay_directory(staging_dir, install_dir)?;
    fs::remove_dir_all(staging_dir).map_err(|err| format!("清理内核暂存目录失败: {err}"))
}

fn overlay_directory(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source_dir)
        .map_err(|err| format!("读取内核暂存目录失败 {}: {err}", path_to_string(source_dir)))?
    {
        let entry = entry.map_err(|err| format!("读取内核暂存条目失败: {err}"))?;
        let source_path = entry.path();
        let target_path = target_dir.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|err| format!("读取内核暂存条目类型失败: {err}"))?;

        if file_type.is_dir() {
            if target_path.exists() && !target_path.is_dir() {
                return Err(format!(
                    "无法用内核目录覆盖同名文件: {}",
                    path_to_string(&target_path)
                ));
            }
            fs::create_dir_all(&target_path).map_err(|err| {
                format!(
                    "创建内核安装子目录失败 {}: {err}",
                    path_to_string(&target_path)
                )
            })?;
            overlay_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            if target_path.exists() && !target_path.is_file() {
                return Err(format!(
                    "无法用内核文件覆盖同名目录: {}",
                    path_to_string(&target_path)
                ));
            }
            fs::copy(&source_path, &target_path).map_err(|err| {
                format!("覆盖内核文件失败 {}: {err}", path_to_string(&target_path))
            })?;
        } else {
            return Err(format!(
                "内核暂存目录包含不支持的条目: {}",
                path_to_string(&source_path)
            ));
        }
    }

    Ok(())
}

pub(crate) fn extract_tar_gz(archive_path: &Path, install_dir: &Path) -> Result<(), String> {
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

pub(crate) fn extract_zip(archive_path: &Path, install_dir: &Path) -> Result<(), String> {
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

pub(crate) fn checked_archive_path(base_dir: &Path, entry_path: &Path) -> Result<PathBuf, String> {
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

pub(crate) fn is_zip_symlink(file: &zip::read::ZipFile<'_>) -> bool {
    file.unix_mode()
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
}

pub(crate) fn find_core_binary(install_dir: &Path) -> Option<PathBuf> {
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

pub(crate) fn core_binary_name() -> &'static str {
    if env::consts::OS == "windows" {
        "cli-proxy-api.exe"
    } else {
        "cli-proxy-api"
    }
}

pub(crate) fn should_start_hidden(config: &GuiConfigFile) -> bool {
    config.silent_start && cfg!(any(target_os = "windows", target_os = "macos"))
}

pub(crate) fn should_start_core_on_launch(config: &GuiConfigFile) -> bool {
    config.start_core_on_launch
}

pub(crate) fn configure_initial_main_window(
    app_handle: &tauri::AppHandle,
    start_hidden: bool,
) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;

    #[cfg(target_os = "macos")]
    set_macos_dock_visible(app_handle, !start_hidden);

    if start_hidden {
        return window
            .hide()
            .map_err(|error| format!("静默启动时隐藏主窗口失败: {error}"));
    }

    window
        .show()
        .map_err(|error| format!("显示主窗口失败: {error}"))?;
    if window.is_minimized().unwrap_or(false) {
        window
            .unminimize()
            .map_err(|error| format!("恢复主窗口失败: {error}"))?;
    }
    window
        .set_focus()
        .map_err(|error| format!("聚焦主窗口失败: {error}"))
}

pub(crate) fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
