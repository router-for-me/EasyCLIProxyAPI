use super::*;

const AGENT_VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const AGENT_VERSION_PROBE_POLL_INTERVAL: Duration = Duration::from_millis(20);

pub(crate) fn agent_config_paths(client: AgentClient, home: &Path) -> Vec<PathBuf> {
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
        AgentClient::Codex => vec![codex_configuration_directory(home).join("config.toml")],
        AgentClient::OpenCode => vec![opencode_config_path(home)],
        AgentClient::OpenClaw => vec![home.join(".openclaw/openclaw.json")],
        AgentClient::Hermes => vec![hermes_agent_config_path(home)],
        AgentClient::DeepSeekHarness => {
            let directory = deepseek_harness_home(home);
            vec![
                directory.join(DEEPSEEK_HARNESS_SETTINGS_FILE),
                directory.join(DEEPSEEK_HARNESS_CREDENTIALS_FILE),
            ]
        }
        AgentClient::ZCode => vec![
            home.join(".zcode/v2").join(ZCODE_CONFIG_FILE),
            home.join(".zcode/cli").join(ZCODE_CONFIG_FILE),
        ],
        AgentClient::KimiCode => vec![kimi_code_home(home).join(KIMI_CODE_CONFIG_FILE)],
        AgentClient::GrokBuild => vec![grok_build_home(home).join(GROK_BUILD_CONFIG_FILE)],
    }
}

pub(crate) fn opencode_config_path(home: &Path) -> PathBuf {
    #[cfg(test)]
    let (custom_config, xdg_config_home): (Option<PathBuf>, Option<PathBuf>) = (None, None);
    #[cfg(not(test))]
    let custom_config = env::var_os("OPENCODE_CONFIG").map(PathBuf::from);
    #[cfg(not(test))]
    let xdg_config_home = env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    opencode_config_path_from_environment(
        home,
        custom_config.as_deref(),
        xdg_config_home.as_deref(),
    )
}

pub(crate) fn opencode_config_path_from_environment(
    home: &Path,
    custom_config: Option<&Path>,
    xdg_config_home: Option<&Path>,
) -> PathBuf {
    if let Some(path) = custom_config.filter(|path| !path.as_os_str().is_empty()) {
        return path.to_path_buf();
    }

    let config_directory = xdg_config_home
        .filter(|path| path.is_absolute())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".config"))
        .join("opencode");
    let json = config_directory.join("opencode.json");
    let jsonc = config_directory.join("opencode.jsonc");
    let candidates = [json.clone(), jsonc];

    candidates
        .iter()
        .find(|path| {
            agent_state_path(std::slice::from_ref(*path))
                .map(|state| state.exists())
                .unwrap_or(false)
        })
        .or_else(|| candidates.iter().find(|path| path.is_file()))
        .cloned()
        .unwrap_or(json)
}

pub(crate) fn kimi_code_home(home: &Path) -> PathBuf {
    env::var_os("KIMI_CODE_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".kimi-code"))
}

pub(crate) fn grok_build_home(home: &Path) -> PathBuf {
    env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".grok"))
}

pub(crate) fn deepseek_harness_home(home: &Path) -> PathBuf {
    env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".dsh"))
}

pub(crate) fn read_deepseek_harness_profile_version(home: &Path) -> Option<String> {
    let directory = deepseek_harness_home(home);
    [
        directory.join("profiles/node_modules/@deepseek-ai/dsh/package.json"),
        directory.join("node_modules/@deepseek-ai/dsh/package.json"),
    ]
    .into_iter()
    .find_map(|path| read_package_json_version(&path))
}

pub(crate) fn read_package_json_version(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let package = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    package
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_string)
}

pub(crate) fn pi_agent_directory(home: &Path) -> PathBuf {
    env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".pi/agent"))
}

pub(crate) fn pi_provider_config_path(home: &Path) -> PathBuf {
    pi_agent_directory(home).join(PI_AGENT_CONFIG_FILE)
}

pub(crate) fn pi_provider_settings_path(home: &Path) -> PathBuf {
    pi_agent_directory(home).join(PI_AGENT_SETTINGS_FILE)
}

pub(crate) fn pi_provider_package_json_path(home: &Path) -> PathBuf {
    pi_agent_directory(home)
        .join("npm/node_modules/@router-for-me/pi-cliproxyapi-provider/package.json")
}

pub(crate) fn read_pi_provider_version(home: &Path) -> Result<Option<String>, String> {
    let path = pi_provider_package_json_path(home);
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "读取 Pi provider package.json 失败 {}: {error}",
            path_to_string(&path)
        )
    })?;
    let package = serde_json::from_str::<serde_json::Value>(&content).map_err(|error| {
        format!(
            "解析 Pi provider package.json 失败 {}: {error}",
            path_to_string(&path)
        )
    })?;
    Ok(package
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

pub(crate) fn parse_pi_provider_latest_version(
    payload: &serde_json::Value,
) -> Result<String, String> {
    payload
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "npm registry 返回的 Pi provider 版本无效".to_string())
}

pub(crate) async fn fetch_pi_provider_latest_version(proxy_url: &str) -> Result<String, String> {
    let client = build_http_client_with_proxy(
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12)),
        proxy_url,
        "创建 Pi provider 更新检测客户端失败",
    )?;
    let response = client
        .get(PI_CLIPROXYAPI_NPM_LATEST_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("查询 Pi provider 最新版本失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "查询 Pi provider 最新版本失败: HTTP {}",
            status.as_u16()
        ));
    }
    let payload = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("解析 Pi provider 最新版本失败: {error}"))?;
    parse_pi_provider_latest_version(&payload)
}

pub(crate) fn pi_provider_update_available(installed: &str, latest: &str) -> Result<bool, String> {
    let parse = |value: &str| {
        semver::Version::parse(value.trim().trim_start_matches('v'))
            .map_err(|error| format!("无法解析 Pi provider 版本号 {value}: {error}"))
    };
    Ok(parse(latest)? > parse(installed)?)
}

pub(crate) fn pi_package_source_matches(value: &str) -> bool {
    let value = value.trim();
    value == PI_CLIPROXYAPI_PACKAGE || value.starts_with(&format!("{PI_CLIPROXYAPI_PACKAGE}@"))
}

pub(crate) fn read_pi_settings(home: &Path) -> Result<Option<serde_json::Value>, String> {
    let path = pi_provider_settings_path(home);
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "读取 Pi settings.json 失败 {}: {error}",
            path_to_string(&path)
        )
    })?;
    serde_json::from_str::<serde_json::Value>(&content)
        .map(Some)
        .map_err(|error| {
            format!(
                "解析 Pi settings.json 失败 {}: {error}",
                path_to_string(&path)
            )
        })
}

pub(crate) fn pi_settings_contains_provider(settings: &serde_json::Value) -> bool {
    settings
        .get("packages")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|packages| {
            packages.iter().any(|package| {
                package.as_str().is_some_and(pi_package_source_matches)
                    || package
                        .get("source")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(pi_package_source_matches)
            })
        })
}

pub(crate) fn pi_provider_package_installed(home: &Path) -> Result<bool, String> {
    Ok(read_pi_settings(home)?
        .as_ref()
        .is_some_and(pi_settings_contains_provider))
}

pub(crate) fn build_pi_provider_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
) -> Result<String, String> {
    let mut root = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_json::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("解析 Pi CLIProxyAPI 配置失败: {error}"))?,
        None => serde_json::json!({}),
    };
    let object = root
        .as_object_mut()
        .ok_or_else(|| "Pi CLIProxyAPI 配置根节点必须是 JSON 对象".to_string())?;
    object.insert("baseUrl".to_string(), serde_json::json!(base_url));
    object.insert("apiKey".to_string(), serde_json::json!(api_key));
    let mut rendered = serde_json::to_string_pretty(&root)
        .map_err(|error| format!("生成 Pi CLIProxyAPI 配置失败: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

pub(crate) fn build_pi_provider_settings(
    existing: &str,
    default_model: &str,
) -> Result<String, String> {
    let default_model = default_model.trim();
    if default_model.is_empty() {
        return Err("Pi 默认模型不能为空".to_string());
    }
    let mut root = serde_json::from_str::<serde_json::Value>(existing)
        .map_err(|error| format!("解析 Pi settings.json 失败: {error}"))?;
    let object = root
        .as_object_mut()
        .ok_or_else(|| "Pi settings.json 根节点必须是 JSON 对象".to_string())?;
    object.insert(
        "defaultProvider".to_string(),
        serde_json::json!(PI_CLIPROXYAPI_PROVIDER_ID),
    );
    object.insert("defaultModel".to_string(), serde_json::json!(default_model));
    let mut rendered = serde_json::to_string_pretty(&root)
        .map_err(|error| format!("生成 Pi settings.json 失败: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

pub(crate) fn inspect_pi_provider_status(
    home: &Path,
    port: u16,
    api_key: &str,
) -> AgentConfigStatus {
    let config_path = pi_provider_config_path(home);
    let settings_path = pi_provider_settings_path(home);
    let executable = find_pi_executable(home);
    let mut errors = Vec::new();
    let (plugin_installed, default_provider_matches, current_model) = match read_pi_settings(home) {
        Ok(Some(settings)) => {
            let plugin_installed = pi_settings_contains_provider(&settings);
            let default_provider_matches = settings
                .get("defaultProvider")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| value.trim() == PI_CLIPROXYAPI_PROVIDER_ID);
            let current_model = settings
                .get("defaultModel")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            (plugin_installed, default_provider_matches, current_model)
        }
        Ok(None) => (false, false, None),
        Err(error) => {
            errors.push(error);
            (false, false, None)
        }
    };
    let mut credentials_match = false;
    if config_path.is_file() {
        match fs::read_to_string(&config_path)
            .map_err(|error| format!("读取 Pi CLIProxyAPI 配置失败: {error}"))
            .and_then(|content| {
                let root = serde_json::from_str::<serde_json::Value>(&content)
                    .map_err(|error| format!("解析 Pi CLIProxyAPI 配置失败: {error}"))?;
                let object = root
                    .as_object()
                    .ok_or_else(|| "Pi CLIProxyAPI 配置根节点必须是 JSON 对象".to_string())?;
                let expected_base_url = managed_core_loopback_origin(port);
                credentials_match = object
                    .get("baseUrl")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| value.trim() == expected_base_url)
                    && object.get("apiKey").and_then(serde_json::Value::as_str) == Some(api_key);
                Ok(())
            }) {
            Ok(()) => {}
            Err(error) => errors.push(error),
        }
    }
    let config_exists = config_path.is_file() || settings_path.is_file();
    let config_valid = errors.is_empty();
    let configured = plugin_installed
        && credentials_match
        && default_provider_matches
        && current_model.is_some()
        && config_valid;
    let mut warnings = Vec::new();
    if executable.is_some() && !plugin_installed && config_valid {
        warnings.push("Pi CLIProxyAPI provider 插件尚未安装".to_string());
    } else if plugin_installed
        && (!credentials_match || !default_provider_matches || current_model.is_none())
        && config_valid
        && config_exists
    {
        warnings.push(
            "Pi 插件配置不完整，请使用“应用配置”重新写入凭据、默认 provider 和默认模型".to_string(),
        );
    }
    if executable.is_none() && plugin_installed {
        warnings.push("已找到 Pi 插件配置，但未检测到 Pi CLI 命令".to_string());
    }
    let modification_state = if configured {
        "applied"
    } else {
        "unconfigured"
    };
    let error = errors.into_iter().next();
    let cli_version = executable
        .as_deref()
        .and_then(|path| read_agent_version(path, home));
    let plugin_version = read_pi_provider_version(home).ok().flatten();
    AgentConfigStatus {
        id: PI_AGENT_ID.to_string(),
        name: PI_AGENT_NAME.to_string(),
        supported_platform: true,
        installed: executable.is_some(),
        plugin_installed,
        launch_targets: executable
            .as_ref()
            .map(|path| {
                vec![AgentLaunchTarget {
                    id: "cli".to_string(),
                    label: PI_AGENT_NAME.to_string(),
                    detail: path_to_string(path),
                }]
            })
            .unwrap_or_default(),
        version: cli_version.clone(),
        cli_version,
        app_version: None,
        plugin_version,
        config_paths: vec![path_to_string(&config_path), path_to_string(&settings_path)],
        config_exists,
        config_valid,
        configured,
        configuration_synchronized: configured,
        current_model: current_model.clone(),
        oauth_configuration: false,
        modification_enabled: configured,
        modification_state: modification_state.to_string(),
        backup_available: false,
        applied_model: current_model,
        claude_code_model_mappings: None,
        claude_desktop_model_mappings: None,
        warnings,
        error,
    }
}

pub(crate) fn install_pi_provider_inner(
    home: &Path,
    executable: &Path,
    port: u16,
    api_key: &str,
    default_model: &str,
    proxy_url: &str,
) -> Result<AgentConfigActionResult, String> {
    if port == 0 {
        return Err("内核端口无效".to_string());
    }
    if api_key.trim().is_empty() {
        return Err("EasyCLIProxyAPI 没有可用的 API key".to_string());
    }
    let settings_path = pi_provider_settings_path(home);
    let mut changed_files = Vec::new();
    if !pi_provider_package_installed(home)? {
        install_pi_package(executable, home, proxy_url)?;
        changed_files.push(path_to_string(&settings_path));
    }

    let mut result = repair_pi_provider_inner(home, port, api_key, default_model)?;
    changed_files.extend(result.changed_files);
    result.changed_files = changed_files;
    Ok(result)
}

pub(crate) fn repair_pi_provider_inner(
    home: &Path,
    port: u16,
    api_key: &str,
    default_model: &str,
) -> Result<AgentConfigActionResult, String> {
    if port == 0 {
        return Err("Core port is invalid".to_string());
    }
    if api_key.trim().is_empty() {
        return Err("EasyCLIProxyAPI has no usable API key".to_string());
    }
    let config_path = pi_provider_config_path(home);
    let settings_path = pi_provider_settings_path(home);
    let mut changed_files = Vec::new();
    if !pi_provider_package_installed(home)? {
        return Err("Pi CLIProxyAPI provider is not installed".to_string());
    }
    let existing = if config_path.is_file() {
        Some(fs::read_to_string(&config_path).map_err(|error| {
            format!(
                "读取 Pi CLIProxyAPI 配置失败 {}: {error}",
                path_to_string(&config_path)
            )
        })?)
    } else {
        None
    };
    let base_url = managed_core_loopback_origin(port);
    let rendered = build_pi_provider_config(existing.as_deref(), &base_url, api_key)?;
    if existing.as_deref() != Some(rendered.as_str()) {
        write_bytes_atomically(&config_path, rendered.as_bytes())?;
        changed_files.push(path_to_string(&config_path));
    }

    let settings = fs::read_to_string(&settings_path).map_err(|error| {
        format!(
            "读取 Pi settings.json 失败 {}: {error}",
            path_to_string(&settings_path)
        )
    })?;
    let rendered_settings = build_pi_provider_settings(&settings, default_model)?;
    if settings != rendered_settings {
        write_bytes_atomically(&settings_path, rendered_settings.as_bytes())?;
        changed_files.push(path_to_string(&settings_path));
    }

    Ok(action_result(
        "applied",
        true,
        Some(default_model.trim().to_string()),
        changed_files,
        Vec::new(),
    ))
}

pub(crate) fn update_pi_provider_inner(
    home: &Path,
    executable: &Path,
    port: u16,
    api_key: &str,
    default_model: &str,
    proxy_url: &str,
) -> Result<AgentConfigActionResult, String> {
    if !pi_provider_package_installed(home)? {
        return Err("Pi CLIProxyAPI provider 插件尚未安装".to_string());
    }
    update_pi_package(executable, home, proxy_url)?;
    let mut result = repair_pi_provider_inner(home, port, api_key, default_model)?;
    result.outcome = "updated".to_string();
    Ok(result)
}

pub(crate) fn uninstall_pi_provider_inner(
    home: &Path,
    executable: &Path,
) -> Result<AgentConfigActionResult, String> {
    if !pi_provider_package_installed(home)? {
        return Ok(action_result(
            "not-installed",
            false,
            None,
            Vec::new(),
            Vec::new(),
        ));
    }
    remove_pi_package(executable, home)?;
    Ok(action_result(
        "removed",
        false,
        None,
        vec![path_to_string(&pi_provider_settings_path(home))],
        Vec::new(),
    ))
}

pub(crate) fn agent_command_path(
    home: &Path,
    executable: &Path,
) -> Result<std::ffi::OsString, String> {
    let mut directories = agent_executable_directories(home);
    if let Some(executable_directory) = executable
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        directories.retain(|directory| directory != executable_directory);
        directories.insert(0, executable_directory.to_path_buf());
    }

    env::join_paths(directories).map_err(|error| format!("构造智能体命令 PATH 失败: {error}"))
}

pub(crate) fn configure_agent_command_environment(
    command: &mut Command,
    home: &Path,
    executable: &Path,
) -> Result<(), String> {
    command.env("PATH", agent_command_path(home, executable)?);
    Ok(())
}

pub(crate) fn install_pi_package(
    executable: &Path,
    home: &Path,
    proxy_url: &str,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = windows_command_for_executable(executable, false);
    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(executable);

    command
        .arg("install")
        .arg(PI_CLIPROXYAPI_PACKAGE)
        .current_dir(home)
        .stdin(Stdio::null());
    configure_background_command(&mut command);
    configure_networked_command(&mut command, proxy_url);
    configure_agent_command_environment(&mut command, home, executable)?;
    let output = command
        .output()
        .map_err(|error| format!("执行 Pi 插件安装失败: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(format!(
        "Pi CLIProxyAPI provider 插件安装失败{}",
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    ))
}

pub(crate) fn update_pi_package(
    executable: &Path,
    home: &Path,
    proxy_url: &str,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = windows_command_for_executable(executable, false);
    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(executable);

    command
        .arg("update")
        .arg("--extension")
        .arg(PI_CLIPROXYAPI_PACKAGE)
        .current_dir(home)
        .stdin(Stdio::null());
    configure_background_command(&mut command);
    configure_networked_command(&mut command, proxy_url);
    configure_agent_command_environment(&mut command, home, executable)?;
    let output = command
        .output()
        .map_err(|error| format!("执行 Pi 插件更新失败: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(format!(
        "Pi CLIProxyAPI provider 插件更新失败{}",
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    ))
}

pub(crate) fn remove_pi_package(executable: &Path, home: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = windows_command_for_executable(executable, false);
    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(executable);

    command
        .arg("remove")
        .arg(PI_CLIPROXYAPI_PACKAGE)
        .current_dir(home)
        .stdin(Stdio::null());
    configure_background_command(&mut command);
    configure_agent_command_environment(&mut command, home, executable)?;
    let output = command
        .output()
        .map_err(|error| format!("鎵ц Pi 鎻掍欢鍗歌浇澶辫触: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(format!(
        "Pi CLIProxyAPI provider 鎻掍欢鍗歌浇澶辫触{}",
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    ))
}

pub(crate) fn codex_configuration_directory(home: &Path) -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".codex"))
}

pub(crate) fn codex_auth_file_has_oauth_tokens(path: &Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    root.get("tokens")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|tokens| {
            tokens
                .values()
                .any(|value| value.as_str().is_some_and(|token| !token.trim().is_empty()))
        })
}

pub(crate) fn codex_auth_file_has_api_key(path: &Path, api_key: &str) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    let api_key_matches = root
        .get("OPENAI_API_KEY")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value == api_key);
    let mode_matches = root
        .get("auth_mode")
        .is_none_or(|value| value.as_str() == Some("apikey"));
    api_key_matches && mode_matches
}

pub(crate) fn validate_codex_oauth_login(home: &Path) -> Result<(), String> {
    validate_codex_oauth_login_at(&codex_configuration_directory(home).join("auth.json"))
}

pub(crate) fn validate_codex_oauth_login_at(auth_path: &Path) -> Result<(), String> {
    if codex_auth_file_has_oauth_tokens(auth_path) {
        Ok(())
    } else {
        Err(CODEX_OAUTH_LOGIN_REQUIRED_ERROR.to_string())
    }
}

pub(crate) fn remove_codex_config_file(path: &Path) -> Result<bool, String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "删除 Codex 配置文件失败 {}: {error}",
            path_to_string(path)
        )),
    }
}

pub(crate) fn clear_codex_config_files(home: &Path) -> Result<Vec<String>, String> {
    let codex_dir = codex_configuration_directory(home);
    let config_path = codex_dir.join("config.toml");
    let targets = [codex_dir.join("auth.json"), config_path.clone()];
    let mut deleted = Vec::new();

    for path in targets {
        if remove_codex_config_file(&path)? {
            deleted.push(path_to_string(&path));
        }
    }

    let state_path = agent_state_path(std::slice::from_ref(&config_path))?;
    clear_codex_applied_state(&state_path)?;
    // Clean up state files left by older releases. New Codex applications keep
    // this short-lived restore metadata in memory instead.
    remove_codex_config_file(&state_path)?;

    Ok(deleted)
}

pub(crate) fn codex_model_catalog_path(home: &Path) -> PathBuf {
    codex_configuration_directory(home).join(CODEX_MODEL_CATALOG_FILE)
}

pub(crate) fn expected_agent_record_paths(client: AgentClient, paths: &[PathBuf]) -> Vec<PathBuf> {
    if client == AgentClient::Codex && paths.len() == 1 {
        let mut expected = paths.to_vec();
        expected.push(paths[0].with_file_name(CODEX_MODEL_CATALOG_FILE));
        expected.push(paths[0].with_file_name("auth.json"));
        expected
    } else {
        paths.to_vec()
    }
}

pub(crate) fn claude_desktop_config_paths(_home: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    let (normal, threep) = {
        let support = _home.join("Library/Application Support");
        (support.join("Claude"), support.join("Claude-3p"))
    };
    #[cfg(target_os = "windows")]
    {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| _home.join("AppData/Local"));
        claude_desktop_config_paths_from_local_app_data(&local)
    }
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

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        claude_desktop_config_paths_from_directories(normal, threep)
    }
}

pub(crate) fn claude_desktop_config_paths_from_directories(
    normal: PathBuf,
    threep: PathBuf,
) -> Vec<PathBuf> {
    let library = threep.join("configLibrary");
    vec![
        normal.join("claude_desktop_config.json"),
        threep.join("claude_desktop_config.json"),
        library.join(format!("{CLAUDE_DESKTOP_PROFILE_ID}.json")),
        library.join("_meta.json"),
    ]
}

#[cfg(target_os = "windows")]
pub(crate) fn claude_desktop_config_paths_from_local_app_data(
    local_app_data: &Path,
) -> Vec<PathBuf> {
    // Claude Desktop may add a channel or version suffix to these directories.
    // Match cc-switch's resolver so status detection and configuration writes use
    // the same files as the installed Desktop client rather than only the legacy
    // fixed `Claude` / `Claude-3p` locations.
    let normal = find_windows_claude_data_directory(local_app_data, false)
        .unwrap_or_else(|| local_app_data.join("Claude"));
    let threep = find_windows_claude_data_directory(local_app_data, true)
        .unwrap_or_else(|| local_app_data.join("Claude-3p"));
    claude_desktop_config_paths_from_directories(normal, threep)
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_claude_data_directory(
    local_app_data: &Path,
    threep: bool,
) -> Option<PathBuf> {
    let exact_name = if threep { "Claude-3p" } else { "Claude" };
    let exact = local_app_data.join(exact_name);
    if exact.is_dir() {
        return Some(exact);
    }

    let mut candidates = fs::read_dir(local_app_data)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                return false;
            };
            let normalized = name.to_ascii_lowercase();
            normalized.starts_with("claude") && normalized.contains("-3p") == threep
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().next()
}

pub(crate) fn hermes_agent_config_path(home: &Path) -> PathBuf {
    if let Some(directory) = env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
    {
        return directory.join("config.yaml");
    }
    #[cfg(target_os = "windows")]
    {
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("hermes/config.yaml")
    }
    #[cfg(not(target_os = "windows"))]
    home.join(".hermes/config.yaml")
}

pub(crate) fn inspect_agent_config(
    client: AgentClient,
    home: &Path,
    port: u16,
    api_key: &str,
) -> AgentConfigStatus {
    let paths = agent_config_paths(client, home);
    let config_exists = paths.iter().any(|path| path.is_file());
    let result = inspect_agent_managed_config(client, &paths, port, api_key).and_then(
        |(configured, model, oauth_configuration)| {
            if client == AgentClient::Codex && configured {
                let model = model
                    .as_deref()
                    .ok_or_else(|| "Codex 配置缺少默认模型".to_string())?;
                validate_codex_catalog_file(&paths[0], model)?;
            }
            Ok((configured, model, oauth_configuration))
        },
    );
    let (configured, current_model, oauth_configuration, config_valid, error) = match result {
        Ok((configured, model, oauth_configuration)) => {
            (configured, model, oauth_configuration, true, None)
        }
        Err(error) => (false, None, false, false, Some(error)),
    };
    let executable = find_agent_executable(client, home);
    // Desktop application executables are not CLIs. Invoking them with
    // --version can start their GUI and block discovery, so never probe them
    // directly. ZCode may still expose a separate command-line entry point.
    let cli_version = if client == AgentClient::ZCode {
        find_named_agent_executable(home, &["zcode"])
            .filter(|path| executable.as_ref() != Some(path))
            .as_deref()
            .and_then(|path| read_agent_version(path, home))
    } else if should_probe_primary_agent_executable_version(client) {
        executable
            .as_deref()
            .and_then(|path| read_agent_version(path, home))
    } else {
        None
    };
    let codex_app_installation = (client == AgentClient::Codex)
        .then(|| find_codex_app_installation(home))
        .flatten();
    let opencode_desktop_application = (client == AgentClient::OpenCode)
        .then(|| find_opencode_desktop_application(home))
        .flatten();
    let app_version = match client {
        AgentClient::ClaudeDesktop => read_claude_desktop_version(home),
        AgentClient::Codex => codex_app_installation
            .as_ref()
            .and_then(|installation| read_codex_app_installation_version(installation, home)),
        AgentClient::OpenCode => opencode_desktop_application
            .as_deref()
            .and_then(read_opencode_desktop_version),
        AgentClient::DeepSeekHarness => read_deepseek_harness_profile_version(home),
        AgentClient::ZCode => read_zcode_app_version(home),
        _ => None,
    };
    let version = cli_version.clone().or_else(|| app_version.clone());
    let app_installed = codex_app_installation.is_some() || opencode_desktop_application.is_some();
    let installed = agent_installation_detected(
        client,
        version.as_deref(),
        executable.is_some(),
        app_installed,
    );
    let launch_targets = agent_launch_targets(
        client,
        executable.as_deref(),
        app_version.as_deref(),
        app_installed,
    );
    let mut warnings = Vec::new();
    if !client.supported_platform() {
        warnings.push("当前平台不支持 Claude Desktop 3P 配置".to_string());
    } else if !installed && config_exists {
        warnings.push("只检测到配置文件，未检测到客户端".to_string());
    }
    if let Some(message) = error.as_ref() {
        warnings.push(message.clone());
    }
    let modification = inspect_agent_application(client, home);
    let configuration_synchronized = agent_configuration_is_synchronized(client, home, configured);
    warnings.extend(modification.warnings.iter().cloned());

    AgentConfigStatus {
        id: client.id().to_string(),
        name: client.name().to_string(),
        supported_platform: client.supported_platform(),
        installed,
        plugin_installed: true,
        launch_targets,
        version,
        cli_version,
        app_version,
        plugin_version: None,
        config_paths: paths.iter().map(|path| path_to_string(path)).collect(),
        config_exists,
        config_valid,
        configured,
        configuration_synchronized,
        current_model,
        oauth_configuration,
        modification_enabled: modification.enabled,
        modification_state: modification.state,
        backup_available: modification.backup_available,
        applied_model: modification.applied_model,
        claude_code_model_mappings: (client == AgentClient::ClaudeCode)
            .then(|| inspect_claude_code_model_mappings(&paths[0]).ok().flatten())
            .flatten(),
        claude_desktop_model_mappings: modification.claude_desktop_model_mappings,
        warnings,
        error,
    }
}

pub(crate) fn agent_installation_detected(
    client: AgentClient,
    version: Option<&str>,
    executable_found: bool,
    app_installed: bool,
) -> bool {
    version.is_some()
        || (matches!(
            client,
            AgentClient::ClaudeDesktop | AgentClient::OpenCode | AgentClient::ZCode
        ) && executable_found)
        || app_installed
}

pub(crate) fn should_probe_primary_agent_executable_version(client: AgentClient) -> bool {
    !matches!(client, AgentClient::ClaudeDesktop | AgentClient::ZCode)
}

pub(crate) fn agent_launch_targets(
    client: AgentClient,
    executable: Option<&Path>,
    app_version: Option<&str>,
    app_installed: bool,
) -> Vec<AgentLaunchTarget> {
    let mut targets = Vec::new();
    match client {
        AgentClient::ClaudeDesktop => {
            if executable.is_some() || app_version.is_some() {
                targets.push(AgentLaunchTarget {
                    id: "app".to_string(),
                    label: "Claude Desktop".to_string(),
                    detail: executable
                        .map(path_to_string)
                        .unwrap_or_else(|| "Claude Desktop application".to_string()),
                });
            }
        }
        AgentClient::Codex => {
            if app_installed {
                targets.push(AgentLaunchTarget {
                    id: "app".to_string(),
                    label: "Codex App".to_string(),
                    detail: "Codex desktop application".to_string(),
                });
            }
            if let Some(executable) = executable {
                targets.push(AgentLaunchTarget {
                    id: "cli".to_string(),
                    label: "Codex CLI".to_string(),
                    detail: path_to_string(executable),
                });
            }
        }
        AgentClient::OpenCode => {
            if let Some(executable) = executable {
                targets.push(AgentLaunchTarget {
                    id: "cli".to_string(),
                    label: "OpenCode CLI".to_string(),
                    detail: path_to_string(executable),
                });
            }
            if app_installed {
                targets.push(AgentLaunchTarget {
                    id: "app".to_string(),
                    label: "OpenCode Desktop".to_string(),
                    detail: "OpenCode Desktop".to_string(),
                });
            }
        }
        AgentClient::ZCode => {
            if let Some(executable) = executable {
                targets.push(AgentLaunchTarget {
                    id: "app".to_string(),
                    label: "ZCode".to_string(),
                    detail: path_to_string(executable),
                });
            }
        }
        _ => {
            if let Some(executable) = executable {
                targets.push(AgentLaunchTarget {
                    id: "cli".to_string(),
                    label: client.name().to_string(),
                    detail: path_to_string(executable),
                });
            }
        }
    }
    targets
}

pub(crate) fn agent_configuration_is_synchronized(
    client: AgentClient,
    home: &Path,
    configured: bool,
) -> bool {
    if !configured {
        return false;
    }
    if !matches!(client, AgentClient::KimiCode | AgentClient::GrokBuild) {
        return true;
    }
    load_agent_applied_state(client, home)
        .ok()
        .flatten()
        .is_some_and(|state| state.configuration_revision >= AGENT_CONFIGURATION_REVISION)
}

pub(crate) fn inspect_agent_application(
    client: AgentClient,
    home: &Path,
) -> AgentModificationInspection {
    match load_agent_applied_state(client, home) {
        Ok(Some(state)) => {
            let paths = agent_config_paths(client, home);
            let backup_available = !state.backup_files.is_empty()
                && state
                    .backup_files
                    .iter()
                    .all(|file| !file.existed_before || file.backup_path.is_file());
            if state.backup_files.is_empty() {
                match agent_has_managed_marker(client, &paths) {
                    Ok(false) => {
                        return AgentModificationInspection {
                            enabled: false,
                            state: "unconfigured".to_string(),
                            backup_available: false,
                            applied_model: None,
                            claude_desktop_model_mappings: None,
                            warnings: Vec::new(),
                        };
                    }
                    Err(error) => {
                        return AgentModificationInspection {
                            enabled: false,
                            state: "invalid".to_string(),
                            backup_available: false,
                            applied_model: None,
                            claude_desktop_model_mappings: None,
                            warnings: vec![error],
                        };
                    }
                    Ok(true) => {}
                }
            }
            let mut warnings = Vec::new();
            if state.backup_files.is_empty() {
                warnings.push("检测到旧版应用状态；关闭时将只移除 CPA 管理的配置字段".to_string());
            } else if !backup_available {
                warnings.push("原配置会话备份不完整，暂时无法安全恢复".to_string());
            }
            AgentModificationInspection {
                enabled: true,
                state: "applied".to_string(),
                backup_available,
                applied_model: Some(state.model),
                claude_desktop_model_mappings: state.claude_desktop_model_mappings,
                warnings,
            }
        }
        Ok(None) => AgentModificationInspection {
            enabled: false,
            state: "unconfigured".to_string(),
            backup_available: false,
            applied_model: None,
            claude_desktop_model_mappings: None,
            warnings: Vec::new(),
        },
        Err(error) => AgentModificationInspection {
            enabled: false,
            state: "invalid".to_string(),
            backup_available: false,
            applied_model: None,
            claude_desktop_model_mappings: None,
            warnings: vec![error],
        },
    }
}

pub(crate) fn inspect_agent_managed_config(
    client: AgentClient,
    paths: &[PathBuf],
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>, bool), String> {
    match client {
        AgentClient::ClaudeCode => inspect_claude_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::ClaudeDesktop if client.supported_platform() => {
            inspect_claude_desktop_agent_config(paths, port, api_key)
                .map(|(configured, model)| (configured, model, false))
        }
        AgentClient::ClaudeDesktop => Ok((false, None, false)),
        AgentClient::Codex => inspect_codex_agent_config(&paths[0], port, api_key),
        AgentClient::OpenCode => inspect_opencode_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::OpenClaw => inspect_openclaw_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::Hermes => inspect_hermes_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::DeepSeekHarness => inspect_deepseek_harness_config(paths, port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::ZCode => {
            if paths.len() != 2 {
                return Err("ZCode 配置路径数量无效".to_string());
            }
            let (app_configured, app_model) = inspect_zcode_agent_config(&paths[0], port, api_key)?;
            let (cli_configured, cli_model) = inspect_zcode_agent_config(&paths[1], port, api_key)?;
            let models_match = app_model.is_some() && app_model == cli_model;
            Ok((
                app_configured && cli_configured && models_match,
                cli_model.or(app_model),
                false,
            ))
        }
        AgentClient::KimiCode => inspect_kimi_code_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::GrokBuild => inspect_grok_build_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
    }
}

pub(crate) fn agent_has_managed_marker(
    client: AgentClient,
    paths: &[PathBuf],
) -> Result<bool, String> {
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
                .is_some_and(is_managed_agent_base_url))
        }
        AgentClient::ClaudeDesktop => {
            if paths.len() != 4 {
                return Ok(false);
            }
            let meta = read_agent_json_or_empty(&paths[3], "Claude Desktop 配置索引")?;
            let profile = read_agent_json_or_empty(&paths[2], "Claude Desktop 网关配置")?;
            Ok(meta.get("appliedId").and_then(serde_json::Value::as_str)
                == Some(CLAUDE_DESKTOP_PROFILE_ID)
                || meta
                    .get("entries")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|entries| {
                        entries.iter().any(|entry| {
                            entry.get("id").and_then(serde_json::Value::as_str)
                                == Some(CLAUDE_DESKTOP_PROFILE_ID)
                        })
                    })
                || profile
                    .get("inferenceGatewayBaseUrl")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(is_managed_agent_base_url))
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
            let root = read_agent_json5_or_empty(&paths[0], "OpenCode 配置")?;
            let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
            let provider_exists = root
                .get("provider")
                .and_then(|value| value.get(MANAGED_AGENT_PROVIDER_ID))
                .is_some();
            let model_selected = root
                .get("model")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|model| model.starts_with(&prefix));
            Ok(provider_exists && model_selected)
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
            let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
            let provider_exists = root
                .get("models")
                .and_then(|value| value.get("providers"))
                .and_then(|value| value.get(MANAGED_AGENT_PROVIDER_ID))
                .is_some();
            let model_selected = root
                .get("agents")
                .and_then(|value| value.get("defaults"))
                .and_then(|value| value.get("model"))
                .and_then(|value| value.get("primary"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|model| model.starts_with(&prefix));
            Ok(provider_exists && model_selected)
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
            let provider_exists = root
                .get("custom_providers")
                .and_then(serde_yaml::Value::as_sequence)
                .is_some_and(|providers| {
                    providers.iter().any(|provider| {
                        provider.get("name").and_then(serde_yaml::Value::as_str)
                            == Some(MANAGED_AGENT_PROVIDER_ID)
                    })
                });
            let model_selected = root
                .get("model")
                .and_then(|value| value.get("provider"))
                .and_then(serde_yaml::Value::as_str)
                == Some(MANAGED_AGENT_PROVIDER_ID);
            Ok(provider_exists && model_selected)
        }
        AgentClient::DeepSeekHarness => deepseek_harness_has_managed_marker(paths),
        AgentClient::ZCode => {
            let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
            for path in paths {
                if !path.is_file() {
                    continue;
                }
                let root = read_agent_json_or_empty(path, "ZCode 配置")?;
                let provider_exists = root
                    .get("provider")
                    .and_then(|value| value.get(MANAGED_AGENT_PROVIDER_ID))
                    .is_some();
                let model_selected = root
                    .get("model")
                    .and_then(|model| {
                        model
                            .as_str()
                            .or_else(|| model.get("main").and_then(serde_json::Value::as_str))
                    })
                    .is_some_and(|model| model.starts_with(&prefix));
                if provider_exists && model_selected {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        AgentClient::KimiCode => inspect_managed_toml_model_marker(
            &paths[0],
            "Kimi Code 配置",
            Some("providers"),
            "models",
            None,
            "default_model",
        ),
        AgentClient::GrokBuild => inspect_managed_toml_model_marker(
            &paths[0],
            "Grok Build 配置",
            None,
            "model",
            Some("models"),
            "default",
        ),
    }
}

pub(crate) fn is_managed_agent_base_url(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    if value.starts_with("http://127.0.0.1:")
        || value.starts_with("http://localhost:")
        || value.starts_with("https://127.0.0.1:")
        || value.starts_with("https://localhost:")
    {
        return true;
    }
    #[cfg(not(test))]
    {
        let Ok(settings) = read_installed_core_config_settings() else {
            return false;
        };
        let host = core_connect_host(&settings.host);
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host
        };
        value.starts_with(&format!("http://{host}:"))
            || value.starts_with(&format!("https://{host}:"))
    }
    #[cfg(test)]
    {
        false
    }
}

pub(crate) fn inspect_managed_toml_model_marker(
    path: &Path,
    label: &str,
    provider_section: Option<&str>,
    model_entry_section: &str,
    default_section: Option<&str>,
    default_key: &str,
) -> Result<bool, String> {
    if !path.is_file() {
        return Ok(false);
    }
    let root: toml::Value = toml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("读取 {label} 失败: {error}"))?,
    )
    .map_err(|error| format!("解析 {label} 失败: {error}"))?;
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let selected = (if let Some(section) = default_section {
        root.get(section)
            .and_then(toml::Value::as_table)
            .and_then(|section| section.get(default_key))
    } else {
        root.get(default_key)
    })
    .and_then(toml::Value::as_str)
    .filter(|model| model.starts_with(&prefix));
    let catalog_has_selected = selected.is_some_and(|model| {
        root.get(model_entry_section)
            .and_then(toml::Value::as_table)
            .is_some_and(|catalog| catalog.contains_key(model))
    });
    let provider_exists = provider_section.is_none_or(|section| {
        root.get(section)
            .and_then(toml::Value::as_table)
            .is_some_and(|providers| providers.contains_key(MANAGED_AGENT_PROVIDER_ID))
    });
    Ok(provider_exists && catalog_has_selected)
}

pub(crate) fn find_codex_app_installation(home: &Path) -> Option<CodexAppTarget> {
    #[cfg(target_os = "macos")]
    {
        [PathBuf::from("/Applications"), home.join("Applications")]
            .into_iter()
            .flat_map(|directory| {
                [
                    "ChatGPT.app",
                    "Codex.app",
                    "OpenAI Codex.app",
                    "OpenAI.Codex.app",
                ]
                .into_iter()
                .map(move |name| directory.join(name))
            })
            .find(|path| path.is_dir())
            .map(CodexAppTarget::Application)
    }

    #[cfg(target_os = "windows")]
    {
        find_windows_codex_app_installation(home)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = home;
        None
    }
}

pub(crate) fn find_opencode_desktop_application(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        [
            PathBuf::from("/Applications/OpenCode.app"),
            home.join("Applications/OpenCode.app"),
        ]
        .into_iter()
        .find(|path| path.is_dir())
    }

    #[cfg(target_os = "windows")]
    {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| home.join("AppData/Local"));
        let program_files_roots = ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(env::var_os)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .collect::<Vec<_>>();
        find_windows_opencode_desktop_application_in_roots(&local, &program_files_roots)
    }

    #[cfg(target_os = "linux")]
    {
        let mut executable_directories = agent_executable_directories(home);
        for directory in ["/opt/OpenCode", "/opt/opencode-desktop"] {
            let directory = PathBuf::from(directory);
            if !executable_directories.contains(&directory) {
                executable_directories.push(directory);
            }
        }

        let data_home = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"));
        let mut data_directories = vec![data_home];
        let system_data_directories = env::var_os("XDG_DATA_DIRS")
            .map(|value| env::split_paths(&value).collect::<Vec<_>>())
            .filter(|directories| !directories.is_empty())
            .unwrap_or_else(|| {
                vec![
                    PathBuf::from("/usr/local/share"),
                    PathBuf::from("/usr/share"),
                ]
            });
        for directory in system_data_directories {
            if directory.is_absolute() && !data_directories.contains(&directory) {
                data_directories.push(directory);
            }
        }

        let appimage_directories = [
            home.join("Applications"),
            home.join(".local/Applications"),
            home.join("Downloads"),
            home.join("Desktop"),
        ];
        find_linux_opencode_desktop_application_in_roots(
            home,
            &executable_directories,
            &data_directories,
            &appimage_directories,
        )
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = home;
        None
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_opencode_desktop_application_in_roots(
    local_app_data: &Path,
    program_files_roots: &[PathBuf],
) -> Option<PathBuf> {
    let mut candidates = vec![
        local_app_data.join("Programs/@opencode-aidesktop/OpenCode.exe"),
        local_app_data.join("Programs/OpenCode/OpenCode.exe"),
        local_app_data.join("Programs/opencode/OpenCode.exe"),
        local_app_data.join("OpenCode/OpenCode.exe"),
        local_app_data.join("opencode/OpenCode.exe"),
    ];
    for root in program_files_roots {
        candidates.extend([
            root.join("@opencode-aidesktop/OpenCode.exe"),
            root.join("OpenCode/OpenCode.exe"),
            root.join("opencode/OpenCode.exe"),
        ]);
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn find_linux_opencode_desktop_application_in_roots(
    home: &Path,
    executable_directories: &[PathBuf],
    data_directories: &[PathBuf],
    appimage_directories: &[PathBuf],
) -> Option<PathBuf> {
    const EXECUTABLE_NAMES: &[&str] = &[
        "ai.opencode.desktop",
        "ai.opencode.desktop.beta",
        "ai.opencode.desktop.dev",
        "opencode-desktop",
        "@opencode-aidesktop",
        "OpenCode",
        "OpenCode Desktop",
    ];

    for directory in executable_directories {
        for name in EXECUTABLE_NAMES {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    find_linux_opencode_application_from_desktop_entries(
        home,
        executable_directories,
        data_directories,
    )
    .or_else(|| {
        appimage_directories.iter().find_map(|directory| {
            let mut candidates = fs::read_dir(directory)
                .ok()?
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_file() && is_opencode_desktop_appimage(path))
                .collect::<Vec<_>>();
            candidates.sort();
            candidates.into_iter().next()
        })
    })
}

#[cfg(any(target_os = "linux", test))]
fn find_linux_opencode_application_from_desktop_entries(
    home: &Path,
    executable_directories: &[PathBuf],
    data_directories: &[PathBuf],
) -> Option<PathBuf> {
    for data_directory in data_directories {
        let applications = data_directory.join("applications");
        let mut entries = fs::read_dir(applications)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("desktop"))
            })
            .collect::<Vec<_>>();
        entries.sort();

        for entry in entries {
            let Ok(content) = fs::read_to_string(&entry) else {
                continue;
            };
            if !is_opencode_desktop_entry(&entry, &content) {
                continue;
            }
            let Some(command) = linux_desktop_entry_command(&content) else {
                continue;
            };
            if let Some(application) =
                resolve_linux_desktop_command(home, executable_directories, command.as_str())
            {
                return Some(application);
            }
        }
    }
    None
}

#[cfg(any(target_os = "linux", test))]
fn is_opencode_desktop_entry(path: &Path, content: &str) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name.contains("opencode") {
        return true;
    }

    let mut in_desktop_entry = false;
    content.lines().any(|line| {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line.eq_ignore_ascii_case("[Desktop Entry]");
            return false;
        }
        if !in_desktop_entry {
            return false;
        }
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        let value = value.trim().to_ascii_lowercase();
        match key.trim() {
            "Name" => {
                value == "opencode"
                    || value.starts_with("opencode beta")
                    || value.starts_with("opencode dev")
            }
            "Icon" | "StartupWMClass" => {
                value.starts_with("ai.opencode.desktop")
                    || value == "@opencode-aidesktop"
                    || value == "opencode"
            }
            _ => false,
        }
    })
}

#[cfg(any(target_os = "linux", test))]
fn linux_desktop_entry_command(content: &str) -> Option<String> {
    let mut in_desktop_entry = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line.eq_ignore_ascii_case("[Desktop Entry]");
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("Exec") {
            continue;
        }
        let tokens = tokenize_linux_desktop_exec(value.trim());
        let mut index = 0;
        if tokens.first().is_some_and(|token| {
            Path::new(token)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "env")
        }) {
            index += 1;
            while tokens.get(index).is_some_and(|token| token.contains('=')) {
                index += 1;
            }
        }
        let command = tokens.get(index)?.trim();
        if command.is_empty()
            || command.starts_with('%')
            || ["flatpak", "snap", "gtk-launch", "sh", "bash"]
                .iter()
                .any(|wrapper| {
                    Path::new(command)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name == *wrapper)
                })
        {
            return None;
        }
        return Some(command.to_string());
    }
    None
}

#[cfg(any(target_os = "linux", test))]
fn tokenize_linux_desktop_exec(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;

    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(delimiter) = quote {
            if character == delimiter {
                quote = None;
            } else {
                current.push(character);
            }
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
        } else if character.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(any(target_os = "linux", test))]
fn resolve_linux_desktop_command(
    home: &Path,
    executable_directories: &[PathBuf],
    command: &str,
) -> Option<PathBuf> {
    let candidate = if let Some(relative) = command.strip_prefix("~/") {
        home.join(relative)
    } else {
        PathBuf::from(command)
    };
    if candidate.is_absolute() || command.contains('/') {
        return candidate.is_file().then_some(candidate);
    }
    executable_directories
        .iter()
        .map(|directory| directory.join(&candidate))
        .find(|path| path.is_file())
}

#[cfg(any(target_os = "linux", test))]
fn is_opencode_desktop_appimage(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let file_name = file_name.to_ascii_lowercase();
    file_name.ends_with(".appimage")
        && (file_name.starts_with("opencode-desktop") || file_name.starts_with("opencode_"))
}

pub(crate) fn read_opencode_desktop_version(application: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        read_windows_executable_version(application)
    }

    #[cfg(target_os = "macos")]
    {
        read_macos_app_version(application)
    }

    #[cfg(target_os = "linux")]
    {
        read_linux_opencode_desktop_version(application)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = application;
        None
    }
}

#[cfg(target_os = "linux")]
fn read_linux_opencode_desktop_version(application: &Path) -> Option<String> {
    let path_version = linux_opencode_desktop_version_from_path(application);
    if application
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("appimage"))
    {
        path_version
    } else {
        path_version.or_else(read_linux_opencode_package_version)
    }
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_opencode_desktop_version_from_path(application: &Path) -> Option<String> {
    application
        .components()
        .rev()
        .filter_map(|component| component.as_os_str().to_str())
        .find_map(|component| {
            let lower = component.to_ascii_lowercase();
            if !lower.contains("opencode") {
                return None;
            }
            let component = lower
                .strip_suffix(".appimage")
                .map(|_| &component[..component.len() - ".appimage".len()])
                .unwrap_or(component);
            component.split(['-', '_']).find_map(|token| {
                let version = token.strip_prefix('v').unwrap_or(token);
                (version.starts_with(|character: char| character.is_ascii_digit())
                    && version.contains('.')
                    && version.chars().all(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '.' | '+' | '~')
                    }))
                .then(|| version.to_string())
            })
        })
}

#[cfg(target_os = "linux")]
fn read_linux_opencode_package_version() -> Option<String> {
    const PACKAGE_NAMES: &[&str] = &[
        "opencode",
        "opencode-desktop",
        "opencode-ai-desktop",
        "opencode-aidesktop",
    ];

    let mut dpkg = Command::new("dpkg-query");
    dpkg.args(["--show", "--showformat=${Package}\\t${Version}\\n"])
        .args(PACKAGE_NAMES);
    if let Some(version) = linux_package_version_from_output(&mut dpkg, '\t') {
        return Some(version);
    }

    let mut rpm = Command::new("rpm");
    rpm.args(["--query", "--queryformat", "%{NAME}\\t%{VERSION}\\n"])
        .args(PACKAGE_NAMES);
    if let Some(version) = linux_package_version_from_output(&mut rpm, '\t') {
        return Some(version);
    }

    let mut pacman = Command::new("pacman");
    pacman.arg("--query").args(PACKAGE_NAMES);
    linux_package_version_from_output(&mut pacman, ' ')
}

#[cfg(target_os = "linux")]
fn linux_package_version_from_output(command: &mut Command, separator: char) -> Option<String> {
    configure_background_command(command);
    let output = command_output_with_timeout(command, AGENT_VERSION_PROBE_TIMEOUT).ok()??;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let (package, version) = line.trim().split_once(separator)?;
            let package = package.trim();
            let version = version.trim();
            ([
                "opencode",
                "opencode-desktop",
                "opencode-ai-desktop",
                "opencode-aidesktop",
            ]
            .contains(&package))
            .then(|| normalize_detected_agent_version(version))
            .flatten()
        })
}

pub(crate) fn read_claude_desktop_version(home: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        read_windows_claude_desktop_store_version().or_else(|| {
            find_claude_desktop_executable(home)
                .and_then(|path| read_windows_executable_version(&path))
        })
    }
    #[cfg(target_os = "macos")]
    {
        find_claude_desktop_executable(home).and_then(|path| {
            let application = path.ancestors().find(|candidate| {
                candidate.extension().and_then(|value| value.to_str()) == Some("app")
            })?;
            read_macos_app_version(application)
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = home;
        None
    }
}

pub(crate) fn read_codex_app_installation_version(
    installation: &CodexAppTarget,
    _home: &Path,
) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        match installation {
            CodexAppTarget::WindowsAppId(app_id) => {
                let _ = app_id;
                read_windows_codex_store_version()
            }
            CodexAppTarget::Application(path) => {
                read_windows_executable_version(path).or_else(|| read_agent_version(path, _home))
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let CodexAppTarget::Application(path) = installation;
        read_macos_app_version(path)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = installation;
        None
    }
}

pub(crate) fn read_zcode_app_version(home: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        find_zcode_desktop_executable(home).and_then(|path| {
            read_windows_executable_version(&path).or_else(|| read_agent_version(&path, home))
        })
    }
    #[cfg(target_os = "macos")]
    {
        [
            PathBuf::from("/Applications/ZCode.app"),
            home.join("Applications/ZCode.app"),
        ]
        .into_iter()
        .find(|path| path.is_dir())
        .and_then(|path| read_macos_app_version(&path))
        .or_else(|| {
            find_named_agent_executable(home, &["zcode"])
                .and_then(|path| read_agent_version(&path, home))
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = home;
        None
    }
}

pub(crate) fn find_zcode_desktop_executable(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"));
        let mut candidates = vec![
            local.join("Programs/ZCode/ZCode.exe"),
            local.join("ZCode/ZCode.exe"),
        ];
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = env::var_os(variable)
                .map(PathBuf::from)
                .filter(|path| !path.as_os_str().is_empty())
            {
                candidates.push(root.join("ZCode/ZCode.exe"));
            }
        }
        candidates
            .into_iter()
            .find(|path| path.is_file())
            .or_else(|| find_named_agent_executable(home, &["zcode"]))
    }
    #[cfg(target_os = "macos")]
    {
        [
            PathBuf::from("/Applications/ZCode.app/Contents/MacOS/ZCode"),
            home.join("Applications/ZCode.app/Contents/MacOS/ZCode"),
        ]
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| find_named_agent_executable(home, &["zcode"]))
    }
    #[cfg(target_os = "linux")]
    {
        let mut candidates = agent_executable_directories(home)
            .into_iter()
            .flat_map(|directory| [directory.join("zcode"), directory.join("ZCode")])
            .collect::<Vec<_>>();
        candidates.extend([
            PathBuf::from("/opt/ZCode/zcode"),
            PathBuf::from("/opt/ZCode/ZCode"),
            PathBuf::from("/opt/zcode/zcode"),
        ]);
        candidates.into_iter().find(|path| path.is_file())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        find_named_agent_executable(home, &["zcode"])
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn read_macos_app_version(application: &Path) -> Option<String> {
    let info_plist = application.join("Contents/Info.plist");
    for key in ["CFBundleShortVersionString", "CFBundleVersion"] {
        let mut command = Command::new("/usr/bin/plutil");
        command
            .args(["-extract", key, "raw", "-o", "-"])
            .arg(&info_plist);
        let output =
            command_output_with_timeout(&mut command, AGENT_VERSION_PROBE_TIMEOUT).ok()??;
        if !output.status.success() {
            continue;
        }
        if let Some(version) =
            normalize_detected_agent_version(&String::from_utf8_lossy(&output.stdout))
        {
            return Some(version);
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_system_root() -> PathBuf {
    env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_powershell_executable() -> PathBuf {
    let executable = windows_system_root().join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if executable.is_file() {
        executable
    } else {
        PathBuf::from("powershell.exe")
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_explorer_executable() -> PathBuf {
    let executable = windows_system_root().join("explorer.exe");
    if executable.is_file() {
        executable
    } else {
        PathBuf::from("explorer.exe")
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_registry_executable() -> PathBuf {
    let executable = windows_system_root().join("System32/reg.exe");
    if executable.is_file() {
        executable
    } else {
        PathBuf::from("reg.exe")
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_command_processor() -> PathBuf {
    env::var_os("ComSpec")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| windows_system_root().join("System32/cmd.exe"))
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_codex_app_installation(home: &Path) -> Option<CodexAppTarget> {
    find_windows_registered_codex_app_installation()
        .or_else(|| find_windows_codex_app_id_via_registry().map(CodexAppTarget::WindowsAppId))
        .or_else(|| find_windows_codex_app_executable(home).map(CodexAppTarget::Application))
}

#[cfg(target_os = "windows")]
pub(crate) fn read_windows_claude_desktop_store_version() -> Option<String> {
    const VERSION_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$package = @(Get-AppxPackage) |
    Where-Object {
        $_.Name -eq 'Claude' -or
        $_.Name -like 'Anthropic.Claude*' -or
        $_.PackageFamilyName -match '^(Claude|Anthropic\.Claude)_'
    } |
    Select-Object -First 1
if ($package -and $package.Version) {
    Write-Output "VERSION:$($package.Version)"
}
"#;

    let encoded_command = windows_powershell_encoded_command(VERSION_SCRIPT);
    let mut command = Command::new(windows_powershell_executable());
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded_command,
    ]);
    configure_background_command(&mut command);
    let output = command_output_with_timeout(&mut command, AGENT_VERSION_PROBE_TIMEOUT).ok()??;
    if !output.status.success() {
        return None;
    }
    parse_windows_claude_desktop_version_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "windows")]
pub(crate) fn read_windows_codex_store_version() -> Option<String> {
    const VERSION_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$package = @(Get-AppxPackage) |
    Where-Object {
        $_.Name -in @('OpenAI.Codex', 'OpenAI.CodexBeta', 'OpenAI.ChatGPT') -or
        $_.PackageFamilyName -match '^OpenAI\.(Codex|CodexBeta|ChatGPT)_'
    } |
    Sort-Object { [version]$_.Version } -Descending |
    Select-Object -First 1
if ($package -and $package.Version) {
    Write-Output "VERSION:$($package.Version)"
}
"#;

    let encoded_command = windows_powershell_encoded_command(VERSION_SCRIPT);
    let mut command = Command::new(windows_powershell_executable());
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded_command,
    ]);
    configure_background_command(&mut command);
    let output = command_output_with_timeout(&mut command, AGENT_VERSION_PROBE_TIMEOUT).ok()??;
    if !output.status.success() {
        return None;
    }
    parse_windows_codex_version_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_registered_codex_app_installation() -> Option<CodexAppTarget> {
    const DISCOVERY_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$startApps = @(Get-StartApps)
$appId = $startApps |
    Where-Object {
        $_.AppID -like 'OpenAI.Codex_*!*' -or
        $_.AppID -like 'OpenAI.CodexBeta_*!*' -or
        $_.AppID -like 'OpenAI.ChatGPT_*!*'
    } |
    Select-Object -First 1 -ExpandProperty AppID
if ($appId) {
    Write-Output "APPID:$appId"
    exit 0
}

$packages = @(Get-AppxPackage) |
    Where-Object {
        $_.Name -in @('OpenAI.Codex', 'OpenAI.CodexBeta', 'OpenAI.ChatGPT') -or
        $_.PackageFamilyName -match '^OpenAI\.(Codex|CodexBeta|ChatGPT)_'
    }
foreach ($package in $packages) {
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    $application = @($manifest.Package.Applications.Application) |
        Where-Object { $_.Id } |
        Select-Object -First 1
    if ($application -and $package.PackageFamilyName) {
        Write-Output "APPID:$($package.PackageFamilyName)!$($application.Id)"
        exit 0
    }
}

$appPathKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\ChatGPT.exe',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\ChatGPT.exe',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\ChatGPT.exe'
)
foreach ($key in $appPathKeys) {
    if (-not (Test-Path -LiteralPath $key)) { continue }
    $candidate = (Get-Item -LiteralPath $key).GetValue('')
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        Write-Output "EXE:$candidate"
        exit 0
    }
}

$shortcutRoots = @(
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
)
$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutFile in (Get-ChildItem -LiteralPath $shortcutRoots -Filter '*.lnk' -Recurse)) {
    $shortcut = $shell.CreateShortcut($shortcutFile.FullName)
    $target = $shortcut.TargetPath
    if (-not $target -or -not (Test-Path -LiteralPath $target -PathType Leaf)) { continue }
    $fileName = [System.IO.Path]::GetFileName($target)
    if ($fileName -ieq 'Codex.exe' -and $target -match '(?i)\\(bin|node_modules|\.vscode\\extensions)\\') {
        continue
    }
    if ($fileName -ieq 'ChatGPT.exe' -or $fileName -ieq 'Codex.exe') {
        Write-Output "EXE:$target"
        exit 0
    }
}
"#;

    let encoded_command = windows_powershell_encoded_command(DISCOVERY_SCRIPT);
    let mut command = Command::new(windows_powershell_executable());
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded_command,
    ]);
    configure_background_command(&mut command);
    let output = command_output_with_timeout(&mut command, AGENT_VERSION_PROBE_TIMEOUT).ok()??;
    if !output.status.success() {
        return None;
    }
    parse_windows_codex_app_discovery_output(&String::from_utf8_lossy(&output.stdout)).and_then(
        |target| match &target {
            CodexAppTarget::Application(path) if !path.is_file() => None,
            _ => Some(target),
        },
    )
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_powershell_encoded_command(script: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let bytes = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect::<Vec<_>>();
    STANDARD.encode(bytes)
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_powershell_single_quoted_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "windows")]
pub(crate) fn read_windows_executable_version(path: &Path) -> Option<String> {
    let path = windows_powershell_single_quoted_literal(&path_to_string(path));
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$item = Get-Item -LiteralPath {path}
$version = $item.VersionInfo.ProductVersion
if ($version) {{
    Write-Output "VERSION:$version"
}}
"#
    );
    let encoded_command = windows_powershell_encoded_command(&script);
    let mut command = Command::new(windows_powershell_executable());
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded_command,
    ]);
    configure_background_command(&mut command);
    let output = command_output_with_timeout(&mut command, AGENT_VERSION_PROBE_TIMEOUT).ok()??;
    if !output.status.success() {
        return None;
    }
    parse_windows_codex_version_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "windows")]
pub(crate) fn parse_windows_codex_app_discovery_output(output: &str) -> Option<CodexAppTarget> {
    output.lines().find_map(|line| {
        let line = line.trim();
        if let Some(app_id) = line.strip_prefix("APPID:").map(str::trim) {
            return (!app_id.is_empty()).then(|| CodexAppTarget::WindowsAppId(app_id.to_string()));
        }
        line.strip_prefix("EXE:")
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(|path| CodexAppTarget::Application(PathBuf::from(path)))
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn parse_windows_claude_desktop_version_output(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("VERSION:")
            .and_then(normalize_detected_agent_version)
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn parse_windows_codex_version_output(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("VERSION:")
            .and_then(normalize_detected_agent_version)
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_codex_app_id_via_registry() -> Option<String> {
    const PACKAGES_KEY: &str = r"HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";
    for package_name in ["OpenAI.Codex_", "OpenAI.CodexBeta_", "OpenAI.ChatGPT_"] {
        let mut command = Command::new(windows_registry_executable());
        command.args(["query", PACKAGES_KEY, "/f", package_name, "/k", "/s"]);
        configure_background_command(&mut command);
        let Ok(Some(output)) =
            command_output_with_timeout(&mut command, AGENT_VERSION_PROBE_TIMEOUT)
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        if let Some(app_id) =
            parse_windows_codex_app_id_from_registry(&String::from_utf8_lossy(&output.stdout))
        {
            return Some(app_id);
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub(crate) fn parse_windows_codex_app_id_from_registry(output: &str) -> Option<String> {
    const PACKAGE_MARKER: &str = "\\AppModel\\Repository\\Packages\\";
    output.lines().find_map(|line| {
        let line = line.trim();
        let (_, package_full_name) = line.split_once(PACKAGE_MARKER)?;
        if package_full_name.contains('\\') {
            return None;
        }
        windows_codex_app_id_from_package_full_name(package_full_name)
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_codex_app_id_from_package_full_name(
    package_full_name: &str,
) -> Option<String> {
    let package_name = package_full_name.split('_').next()?.trim();
    if !matches!(
        package_name,
        "OpenAI.Codex" | "OpenAI.CodexBeta" | "OpenAI.ChatGPT"
    ) {
        return None;
    }
    let publisher_id = package_full_name.rsplit('_').next()?.trim();
    if publisher_id.is_empty() || publisher_id == package_name {
        return None;
    }
    Some(format!("{package_name}_{publisher_id}!App"))
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_codex_app_executable(home: &Path) -> Option<PathBuf> {
    let local = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Local"));
    let mut candidates = vec![
        local.join("Programs/OpenAI/ChatGPT/ChatGPT.exe"),
        local.join("Programs/ChatGPT/ChatGPT.exe"),
        local.join("OpenAI/ChatGPT/ChatGPT.exe"),
        local.join("OpenAI/Codex/Codex.exe"),
        local.join("Programs/OpenAI/Codex/Codex.exe"),
        local.join("Programs/Codex/Codex.exe"),
        local.join("Microsoft/WindowsApps/ChatGPT.exe"),
    ];
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Some(root) = env::var_os(variable)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
        else {
            continue;
        };
        candidates.extend([
            root.join("OpenAI/ChatGPT/ChatGPT.exe"),
            root.join("ChatGPT/ChatGPT.exe"),
            root.join("OpenAI/Codex/Codex.exe"),
            root.join("Codex/Codex.exe"),
        ]);
    }
    candidates.into_iter().find(|path| path.is_file())
}

pub(crate) fn find_agent_executable(client: AgentClient, home: &Path) -> Option<PathBuf> {
    if client == AgentClient::ClaudeDesktop {
        return find_claude_desktop_executable(home);
    }
    if client == AgentClient::ZCode {
        return find_zcode_desktop_executable(home);
    }
    if client == AgentClient::KimiCode {
        return find_kimi_code_executable(home);
    }
    if client == AgentClient::GrokBuild {
        return find_grok_build_executable(home);
    }
    if client == AgentClient::OpenCode {
        return find_opencode_executable(home);
    }
    find_named_agent_executable(home, client.executable_names())
}

pub(crate) fn find_opencode_executable(home: &Path) -> Option<PathBuf> {
    find_named_agent_executable(home, &["opencode"])
        .or_else(|| find_opencode_managed_executable(home))
        .or_else(|| find_named_agent_executable(home, &["opencode-cli"]))
}

pub(crate) fn find_opencode_managed_executable(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        [
            home.join(".opencode/bin/opencode"),
            PathBuf::from("/Applications/OpenCode.app/Contents/MacOS/opencode-cli"),
            home.join("Applications/OpenCode.app/Contents/MacOS/opencode-cli"),
        ]
        .into_iter()
        .find(|path| path.is_file())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let path = home.join(".opencode/bin/opencode");
        path.is_file().then_some(path)
    }
}

pub(crate) fn find_kimi_code_executable(home: &Path) -> Option<PathBuf> {
    let directory = kimi_code_home(home).join("bin");
    #[cfg(target_os = "windows")]
    let managed = [directory.join("kimi.exe"), directory.join("kimi.cmd")];
    #[cfg(not(target_os = "windows"))]
    let managed = [directory.join("kimi")];
    managed
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| find_named_agent_executable(home, &["kimi"]))
}

pub(crate) fn find_grok_build_executable(home: &Path) -> Option<PathBuf> {
    let directory = grok_build_home(home).join("bin");
    #[cfg(target_os = "windows")]
    let managed = [directory.join("grok.exe"), directory.join("grok.cmd")];
    #[cfg(not(target_os = "windows"))]
    let managed = [directory.join("grok")];
    managed
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| find_named_agent_executable(home, &["grok"]))
}

pub(crate) fn find_pi_executable(home: &Path) -> Option<PathBuf> {
    find_named_agent_executable(home, &["pi"])
}

pub(crate) fn find_named_agent_executable(home: &Path, names: &[&str]) -> Option<PathBuf> {
    for directory in agent_executable_directories(home) {
        for name in names {
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

pub(crate) fn agent_executable_directories(home: &Path) -> Vec<PathBuf> {
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

pub(crate) fn find_claude_desktop_executable(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        [
            PathBuf::from("/Applications/Claude.app/Contents/MacOS/Claude"),
            home.join("Applications/Claude.app/Contents/MacOS/Claude"),
        ]
        .into_iter()
        .find(|path| path.is_file())
    }
    #[cfg(target_os = "windows")]
    {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"));
        [
            local.join("Programs/Claude/Claude.exe"),
            local.join("Claude/Claude.exe"),
        ]
        .into_iter()
        .find(|path| path.is_file())
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

#[cfg(target_os = "windows")]
pub(crate) fn windows_command_for_executable(executable: &Path, keep_shell_open: bool) -> Command {
    use std::os::windows::process::CommandExt;

    let is_batch_script = executable
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });
    if !is_batch_script {
        return Command::new(executable);
    }

    let mut command = Command::new(windows_command_processor());
    command.args(["/D", if keep_shell_open { "/K" } else { "/C" }, "call"]);
    command.raw_arg(windows_batch_executable_argument(executable));
    command
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_batch_executable_argument(executable: &Path) -> String {
    format!("\"{}\"", path_to_string(executable))
}

pub(crate) fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> io::Result<Option<std::process::Output>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("无法读取智能体探测标准输出"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("无法读取智能体探测错误输出"))?;
    thread::scope(|scope| {
        let stdout_reader = scope.spawn(move || {
            let mut output = Vec::new();
            stdout.read_to_end(&mut output).map(|_| output)
        });
        let stderr_reader = scope.spawn(move || {
            let mut output = Vec::new();
            stderr.read_to_end(&mut output).map(|_| output)
        });
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break Some(status);
            }
            if Instant::now() >= deadline {
                terminate_agent_probe_process(&mut child);
                break None;
            }
            thread::sleep(AGENT_VERSION_PROBE_POLL_INTERVAL);
        };
        let stdout = stdout_reader
            .join()
            .map_err(|_| io::Error::other("智能体探测输出线程异常退出"))??;
        let stderr = stderr_reader
            .join()
            .map_err(|_| io::Error::other("智能体探测错误线程异常退出"))??;
        Ok(status.map(|status| std::process::Output {
            status,
            stdout,
            stderr,
        }))
    })
}

fn terminate_agent_probe_process(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let process_id = child.id().to_string();
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &process_id, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut command);
        let _ = command.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub(crate) fn read_agent_version(path: &Path, home: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    let mut command = windows_command_for_executable(path, false);

    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(path);

    command.arg("--version");
    configure_background_command(&mut command);
    configure_agent_command_environment(&mut command, home, path).ok()?;
    let output = command_output_with_timeout(&mut command, AGENT_VERSION_PROBE_TIMEOUT).ok()??;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .find_map(normalize_detected_agent_version)
}

pub(crate) fn normalize_detected_agent_version(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= 256
        && value.chars().any(|character| character.is_ascii_digit())
        && !value.chars().any(char::is_control))
    .then(|| value.to_string())
}

pub(crate) fn inspect_claude_agent_config(
    path: &Path,
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(path).map_err(|error| format!("读取 Claude Code 配置失败: {error}"))?,
    )
    .map_err(|error| format!("解析 Claude Code 配置失败: {error}"))?;
    let env = root.get("env").and_then(serde_json::Value::as_object);
    let expected_base = managed_core_loopback_origin(port);
    let configured = env
        .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        == Some(expected_base.as_str())
        && env
            .and_then(|env| env.get("ANTHROPIC_AUTH_TOKEN"))
            .and_then(serde_json::Value::as_str)
            == Some(api_key)
        && env
            .and_then(|env| env.get(CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV))
            .and_then(serde_json::Value::as_str)
            == Some("1");
    let model = env
        .and_then(|env| env.get("ANTHROPIC_MODEL"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| root.get("model").and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(strip_claude_code_context_suffix)
        .map(str::to_string);
    Ok((configured, model))
}

pub(crate) fn inspect_claude_code_model_mappings(
    path: &Path,
) -> Result<Option<ClaudeDesktopModelMappings>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let root: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(path)
            .map_err(|error| format!("Failed to read Claude Code configuration: {error}"))?,
    )
    .map_err(|error| format!("Failed to parse Claude Code configuration: {error}"))?;
    let Some(env) = root.get("env").and_then(serde_json::Value::as_object) else {
        return Ok(None);
    };
    let fallback = env
        .get("ANTHROPIC_MODEL")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let read_model = |key: &str| {
        let value = env
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or(fallback)?;
        let normalized = strip_claude_code_context_suffix(value);
        Some((normalized.to_string(), normalized.len() != value.len()))
    };
    let Some((opus, opus_had_1m)) = read_model("ANTHROPIC_DEFAULT_OPUS_MODEL") else {
        return Ok(None);
    };
    let Some((sonnet, sonnet_had_1m)) = read_model("ANTHROPIC_DEFAULT_SONNET_MODEL") else {
        return Ok(None);
    };
    let Some((haiku, haiku_had_1m)) = read_model("ANTHROPIC_DEFAULT_HAIKU_MODEL") else {
        return Ok(None);
    };
    let legacy_1m = opus_had_1m || sonnet_had_1m || haiku_had_1m;
    let max_context_tokens = env
        .get(CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV)
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or_else(|| {
            if legacy_1m {
                CLAUDE_DESKTOP_EXTENDED_CONTEXT_WINDOW
            } else {
                default_claude_code_max_context_tokens()
            }
        });
    let auto_compact_pct = env
        .get(CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV)
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.trim().parse::<u8>().ok())
        .unwrap_or_else(default_claude_auto_compact_pct);
    let disable_auto_compact = env
        .get(DISABLE_AUTO_COMPACT_ENV)
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
    Ok(Some(ClaudeDesktopModelMappings {
        opus,
        sonnet,
        haiku,
        opus_1m: opus_had_1m,
        sonnet_1m: sonnet_had_1m,
        haiku_1m: haiku_had_1m,
        max_context_tokens,
        auto_compact_pct,
        disable_auto_compact,
    }))
}

pub(crate) fn strip_claude_code_context_suffix(value: &str) -> &str {
    let mut value = value.trim();
    loop {
        let Some(suffix_start) = value.len().checked_sub(4) else {
            return value;
        };
        if !value[suffix_start..].eq_ignore_ascii_case("[1m]") {
            return value;
        }
        value = value[..suffix_start].trim_end();
    }
}

pub(crate) fn agent_model_source_name<'a>(
    models: &'a [AgentModelOption],
    model_name: &'a str,
) -> &'a str {
    let model_name = strip_claude_code_context_suffix(model_name);
    let Some(model) = models
        .iter()
        .find(|model| model.name.eq_ignore_ascii_case(model_name))
    else {
        return model_name;
    };
    if model.is_alias {
        model.alias.as_deref().unwrap_or(model.name.as_str())
    } else {
        model.name.as_str()
    }
}

pub(crate) fn agent_model_context_window(
    models: &[AgentModelOption],
    model_name: &str,
) -> Option<u64> {
    let model_name = strip_claude_code_context_suffix(model_name);
    let selected = models
        .iter()
        .find(|model| model.name.eq_ignore_ascii_case(model_name))?;
    if !selected.is_alias {
        return Some(
            selected
                .context_window
                .unwrap_or(DEFAULT_CLAUDE_CONTEXT_WINDOW),
        );
    }
    selected
        .alias
        .as_deref()
        .and_then(|source| {
            models
                .iter()
                .find(|model| model.name.eq_ignore_ascii_case(source))
        })
        .and_then(|model| model.context_window)
        .or(selected.context_window)
        .or(Some(DEFAULT_CLAUDE_CONTEXT_WINDOW))
}

pub(crate) fn claude_effective_context_window(
    models: &[AgentModelOption],
    model_name: &str,
    enable_1m: bool,
) -> Option<u64> {
    let context_window = agent_model_context_window(models, model_name);
    if enable_1m {
        return Some(
            context_window
                .unwrap_or(DEFAULT_CLAUDE_CONTEXT_WINDOW)
                .max(CLAUDE_DESKTOP_EXTENDED_CONTEXT_WINDOW),
        );
    }
    context_window
}

#[allow(dead_code)]
pub(crate) fn claude_code_max_context_tokens(
    mappings: &ClaudeDesktopModelMappings,
    models: &[AgentModelOption],
) -> Result<u64, String> {
    let model = mappings.sonnet.as_str();
    let context_window = claude_effective_context_window(models, model, mappings.sonnet_1m)
        .ok_or_else(|| format!("CPA 模型 API 未返回 Claude Code 主模型 {model} 的上下文窗口"))?;
    Ok(context_window)
}

pub(crate) fn agent_model_display_name<'a>(
    models: &'a [AgentModelOption],
    model_name: &'a str,
) -> &'a str {
    let model_name = strip_claude_code_context_suffix(model_name);
    let Some(model) = models
        .iter()
        .find(|model| model.name.eq_ignore_ascii_case(model_name))
    else {
        return model_name;
    };
    if model.is_alias {
        model.name.as_str()
    } else {
        model.alias.as_deref().unwrap_or(model.name.as_str())
    }
}

pub(crate) fn claude_code_model_effort_level(
    models: &[AgentModelOption],
    model_name: &str,
) -> Result<Option<String>, String> {
    claude_catalog::claude_code_effort_level_for(agent_model_source_name(models, model_name))
}

pub(crate) fn claude_code_model_setting(model_name: &str, enable_1m_variant: bool) -> String {
    let model_name = strip_claude_code_context_suffix(model_name);
    if enable_1m_variant {
        format!("{model_name}[1m]")
    } else {
        model_name.to_string()
    }
}

pub(crate) fn claude_code_model_settings(
    mappings: &ClaudeDesktopModelMappings,
) -> ClaudeDesktopModelMappings {
    ClaudeDesktopModelMappings {
        opus: claude_code_model_setting(&mappings.opus, mappings.opus_1m),
        sonnet: claude_code_model_setting(&mappings.sonnet, mappings.sonnet_1m),
        haiku: claude_code_model_setting(&mappings.haiku, mappings.haiku_1m),
        opus_1m: mappings.opus_1m,
        sonnet_1m: mappings.sonnet_1m,
        haiku_1m: mappings.haiku_1m,
        max_context_tokens: mappings.max_context_tokens,
        auto_compact_pct: mappings.auto_compact_pct,
        disable_auto_compact: mappings.disable_auto_compact,
    }
}

pub(crate) fn format_context_window(context_window: u64) -> String {
    if context_window.is_multiple_of(1_000_000) {
        format!("{}M", context_window / 1_000_000)
    } else if context_window.is_multiple_of(1_000) {
        format!("{}K", context_window / 1_000)
    } else {
        context_window.to_string()
    }
}

pub(crate) fn claude_code_model_presentation(
    models: &[AgentModelOption],
    model_name: &str,
    enable_1m: bool,
    context_window_override: Option<u64>,
    role: Option<&str>,
) -> (String, String) {
    let display_name = agent_model_display_name(models, model_name);
    let context_window = context_window_override
        .or_else(|| claude_effective_context_window(models, model_name, enable_1m))
        .unwrap_or(DEFAULT_CLAUDE_CONTEXT_WINDOW);
    let context_label = format_context_window(context_window);
    let name = match role {
        Some(role) => format!("{display_name} ({role}, {context_label} context)"),
        None => format!("{display_name} ({context_label} context)"),
    };
    let description = format!("CPA model {model_name} - {context_label} context window");
    (name, description)
}

pub(crate) fn claude_code_model_presentation_environment(
    mappings: &ClaudeDesktopModelMappings,
    models: &[AgentModelOption],
) -> Result<Vec<(String, String)>, String> {
    let opus = claude_code_model_presentation(
        models,
        &mappings.opus,
        mappings.opus_1m,
        Some(mappings.max_context_tokens),
        Some("Opus mapping"),
    );
    let sonnet = claude_code_model_presentation(
        models,
        &mappings.sonnet,
        mappings.sonnet_1m,
        Some(mappings.max_context_tokens),
        Some("Sonnet mapping"),
    );
    let haiku = claude_code_model_presentation(
        models,
        &mappings.haiku,
        mappings.haiku_1m,
        Some(mappings.max_context_tokens),
        Some("Haiku mapping"),
    );
    let fable = claude_code_model_presentation(
        models,
        &mappings.sonnet,
        mappings.sonnet_1m,
        Some(mappings.max_context_tokens),
        Some("Fable mapping"),
    );
    let custom = claude_code_model_presentation(
        models,
        &mappings.sonnet,
        mappings.sonnet_1m,
        Some(mappings.max_context_tokens),
        None,
    );
    let custom_model = claude_code_model_setting(&mappings.sonnet, mappings.sonnet_1m);
    Ok([
        ("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", opus.0),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION", opus.1),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", sonnet.0),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION", sonnet.1),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", haiku.0),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION", haiku.1),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", fable.0),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION", fable.1),
        ("ANTHROPIC_CUSTOM_MODEL_OPTION", custom_model),
        ("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", custom.0),
        ("ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION", custom.1),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value))
    .collect())
}

pub(crate) fn inspect_claude_desktop_agent_config(
    paths: &[PathBuf],
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if paths.len() != 4 || !paths.iter().any(|path| path.is_file()) {
        return Ok((false, None));
    }
    let normal = read_agent_json_or_empty(&paths[0], "Claude Desktop 主配置")?;
    let threep = read_agent_json_or_empty(&paths[1], "Claude Desktop 3P 配置")?;
    let profile = read_agent_json_or_empty(&paths[2], "Claude Desktop 网关配置")?;
    let meta = read_agent_json_or_empty(&paths[3], "Claude Desktop 配置索引")?;
    let expected_base = managed_core_loopback_origin(port);
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
            == Some(api_key)
        && meta.get("appliedId").and_then(serde_json::Value::as_str)
            == Some(CLAUDE_DESKTOP_PROFILE_ID);
    let model = profile
        .get("inferenceModels")
        .and_then(serde_json::Value::as_array)
        .and_then(|models| models.first())
        .and_then(|model| {
            model
                .as_str()
                .or_else(|| {
                    model
                        .get("labelOverride")
                        .and_then(serde_json::Value::as_str)
                })
                .or_else(|| model.get("name").and_then(serde_json::Value::as_str))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((configured, model))
}

pub(crate) fn read_agent_json_or_empty(
    path: &Path,
    label: &str,
) -> Result<serde_json::Value, String> {
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

pub(crate) fn read_agent_json5_or_empty(
    path: &Path,
    label: &str,
) -> Result<serde_json::Value, String> {
    if !path.is_file() {
        return Ok(serde_json::json!({}));
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取 {label} 失败: {error}"))?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    let value: serde_json::Value =
        json5::from_str(&content).map_err(|error| format!("解析 {label} 失败: {error}"))?;
    if !value.is_object() {
        return Err(format!("{label} 根节点必须是对象"));
    }
    Ok(value)
}

pub(crate) fn inspect_codex_agent_config(
    path: &Path,
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>, bool), String> {
    if !path.is_file() {
        return Ok((false, None, false));
    }
    let root: toml::Value = toml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("读取 Codex 配置失败: {error}"))?,
    )
    .map_err(|error| format!("解析 Codex 配置失败: {error}"))?;
    let expected_base = format!("{}/v1", managed_core_loopback_origin(port));
    let provider = root
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(toml::Value::as_table);
    let uses_api_key = provider
        .and_then(|provider| provider.get("experimental_bearer_token"))
        .and_then(toml::Value::as_str)
        == Some(api_key);
    let oauth_configuration = provider
        .and_then(|provider| provider.get("requires_openai_auth"))
        .and_then(toml::Value::as_bool)
        == Some(true);
    let auth_path = path.with_file_name("auth.json");
    let auth_configured = if oauth_configuration {
        codex_auth_file_has_oauth_tokens(&auth_path)
    } else {
        codex_auth_file_has_api_key(&auth_path, api_key)
    };
    let configured_without_auth = root.get("model_provider").and_then(toml::Value::as_str)
        == Some(MANAGED_AGENT_PROVIDER_ID)
        && root.get("model_catalog_json").and_then(toml::Value::as_str)
            == Some(CODEX_MODEL_CATALOG_FILE)
        && provider
            .and_then(|provider| provider.get("name"))
            .and_then(toml::Value::as_str)
            .is_some_and(|name| {
                name == CODEX_MANAGED_PROVIDER_NAME
                    || name == LEGACY_CODEX_MANAGED_PROVIDER_NAME
            })
        && provider
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str)
            == Some(expected_base.as_str())
        && uses_api_key
        && provider
            .and_then(|provider| provider.get("wire_api"))
            .and_then(toml::Value::as_str)
            == Some("responses");
    let configured = configured_without_auth && auth_configured;
    let model = root
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((configured, model, oauth_configuration))
}

pub(crate) fn validate_codex_catalog_file(config_path: &Path, model: &str) -> Result<(), String> {
    let catalog_path = config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(CODEX_MODEL_CATALOG_FILE);
    let catalog = fs::read_to_string(&catalog_path).map_err(|error| {
        format!(
            "读取 Codex 模型目录失败 {}: {error}",
            path_to_string(&catalog_path)
        )
    })?;
    validate_codex_catalog(&catalog, model)
}

pub(crate) fn inspect_opencode_agent_config(
    path: &Path,
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root = read_agent_json5_or_empty(path, "OpenCode 配置")?;
    let provider = root
        .get("provider")
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID));
    let expected_base = format!("{}/v1", managed_core_loopback_origin(port));
    let configured = provider
        .and_then(|provider| provider.get("options"))
        .and_then(|options| options.get("baseURL"))
        .and_then(serde_json::Value::as_str)
        == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("options"))
            .and_then(|options| options.get("apiKey"))
            .and_then(serde_json::Value::as_str)
            == Some(api_key);
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

pub(crate) fn inspect_zcode_agent_config(
    path: &Path,
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(path).map_err(|error| format!("读取 ZCode 配置失败: {error}"))?,
    )
    .map_err(|error| format!("解析 ZCode 配置失败: {error}"))?;
    let provider = root
        .get("provider")
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID));
    let expected_base = managed_core_loopback_origin(port);
    let api_format_matches = provider
        .and_then(|provider| provider.get("apiFormat"))
        .and_then(serde_json::Value::as_str)
        .is_none_or(|api_format| api_format == "anthropic-messages");
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let model = root
        .get("model")
        .and_then(|model| {
            model
                .as_str()
                .or_else(|| model.get("main").and_then(serde_json::Value::as_str))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.strip_prefix(&prefix))
        .map(str::to_string);
    let selected_model_exists = model.as_deref().is_some_and(|selected_model| {
        provider
            .and_then(|provider| provider.get("models"))
            .and_then(serde_json::Value::as_object)
            .is_some_and(|models| {
                models
                    .keys()
                    .any(|model| model.eq_ignore_ascii_case(selected_model))
            })
    });
    let configured = selected_model_exists
        && api_format_matches
        && provider
            .and_then(|provider| provider.get("enabled"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        && provider
            .and_then(|provider| provider.get("kind"))
            .and_then(serde_json::Value::as_str)
            == Some("anthropic")
        && provider
            .and_then(|provider| provider.get("options"))
            .and_then(|options| options.get("baseURL"))
            .and_then(serde_json::Value::as_str)
            == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("options"))
            .and_then(|options| options.get("apiKey"))
            .and_then(serde_json::Value::as_str)
            == Some(api_key);
    Ok((configured, model))
}

pub(crate) fn inspect_kimi_code_agent_config(
    path: &Path,
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: toml::Value = toml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("读取 Kimi Code 配置失败: {error}"))?,
    )
    .map_err(|error| format!("解析 Kimi Code 配置失败: {error}"))?;
    let expected_base = format!("{}/v1", managed_core_loopback_origin(port));
    let provider = root
        .get("providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(toml::Value::as_table);
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let selected = root
        .get("default_model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| value.starts_with(&prefix));
    let model_entry = selected.and_then(|alias| {
        root.get("models")
            .and_then(toml::Value::as_table)
            .and_then(|models| models.get(alias))
            .and_then(toml::Value::as_table)
    });
    let model = model_entry
        .and_then(|entry| entry.get("model"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let configured = selected.is_some()
        && model.is_some()
        && provider
            .and_then(|provider| provider.get("type"))
            .and_then(toml::Value::as_str)
            == Some("openai")
        && provider
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str)
            == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("api_key"))
            .and_then(toml::Value::as_str)
            == Some(api_key)
        && model_entry
            .and_then(|entry| entry.get("provider"))
            .and_then(toml::Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID);
    Ok((configured, model))
}

pub(crate) fn inspect_grok_build_agent_config(
    path: &Path,
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: toml::Value = toml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("读取 Grok Build 配置失败: {error}"))?,
    )
    .map_err(|error| format!("解析 Grok Build 配置失败: {error}"))?;
    let expected_base = format!("{}/v1", managed_core_loopback_origin(port));
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let selected = root
        .get("models")
        .and_then(toml::Value::as_table)
        .and_then(|models| models.get("default"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| value.starts_with(&prefix));
    let model_entry = selected.and_then(|alias| {
        root.get("model")
            .and_then(toml::Value::as_table)
            .and_then(|models| models.get(alias))
            .and_then(toml::Value::as_table)
    });
    let model = model_entry
        .and_then(|entry| entry.get("model"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let configured = selected.is_some()
        && model.is_some()
        && model_entry
            .and_then(|entry| entry.get("base_url"))
            .and_then(toml::Value::as_str)
            == Some(expected_base.as_str())
        && model_entry
            .and_then(|entry| entry.get("api_key"))
            .and_then(toml::Value::as_str)
            == Some(api_key)
        && model_entry
            .and_then(|entry| entry.get("api_backend"))
            .and_then(toml::Value::as_str)
            == Some("chat_completions");
    Ok((configured, model))
}

pub(crate) fn inspect_openclaw_agent_config(
    path: &Path,
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
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
    let expected_base = format!("{}/v1", managed_core_loopback_origin(port));
    let configured = provider
        .and_then(|provider| provider.get("baseUrl"))
        .and_then(serde_json::Value::as_str)
        == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("apiKey"))
            .and_then(serde_json::Value::as_str)
            == Some(api_key);
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

pub(crate) fn inspect_hermes_agent_config(
    path: &Path,
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
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
    let expected_base = format!("{}/v1", managed_core_loopback_origin(port));
    let configured = provider
        .and_then(|provider| provider.get("base_url"))
        .and_then(serde_yaml::Value::as_str)
        == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("api_key"))
            .and_then(serde_yaml::Value::as_str)
            == Some(api_key)
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

pub(crate) fn inspect_deepseek_harness_config(
    paths: &[PathBuf],
    port: u16,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if paths.len() != 2 {
        return Err("DeepSeek Harness 配置路径数量无效".to_string());
    }
    let settings = read_agent_yaml_mapping_or_empty(&paths[0], "DeepSeek Harness settings")?;
    let credentials = read_agent_yaml_mapping_or_empty(&paths[1], "DeepSeek Harness credentials")?;
    let provider = yaml_mapping_value(&settings, "llm-pi-ai")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|section| yaml_mapping_value(section, "providers"))
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|providers| yaml_mapping_value(providers, DEEPSEEK_HARNESS_PROVIDER_ID))
        .and_then(serde_norway::Value::as_mapping);
    let selection = yaml_mapping_value(&settings, "agent-default-model")
        .and_then(serde_norway::Value::as_mapping);
    let selected_provider = selection
        .and_then(|selection| yaml_mapping_value(selection, "provider"))
        .and_then(serde_norway::Value::as_str);
    let model = (selected_provider == Some(DEEPSEEK_HARNESS_PROVIDER_ID))
        .then(|| {
            selection
                .and_then(|selection| yaml_mapping_value(selection, "model"))
                .and_then(serde_norway::Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_string)
        })
        .flatten();
    let expected_base = format!("{}/v1", managed_core_loopback_origin(port));
    let credential = yaml_mapping_value(&credentials, DEEPSEEK_HARNESS_CREDENTIAL)
        .and_then(serde_norway::Value::as_str);
    let model_is_published = model.as_deref().is_some_and(|selected| {
        provider
            .and_then(|provider| yaml_mapping_value(provider, "models"))
            .and_then(serde_norway::Value::as_sequence)
            .is_some_and(|models| {
                models.iter().any(|model| {
                    model
                        .as_mapping()
                        .and_then(|model| yaml_mapping_value(model, "id"))
                        .and_then(serde_norway::Value::as_str)
                        .is_some_and(|id| id.eq_ignore_ascii_case(selected))
                })
            })
    });
    let configured = provider
        .and_then(|provider| yaml_mapping_value(provider, "apiKeyEnv"))
        .and_then(serde_norway::Value::as_str)
        == Some(DEEPSEEK_HARNESS_CREDENTIAL)
        && provider
            .and_then(|provider| yaml_mapping_value(provider, "api"))
            .and_then(serde_norway::Value::as_str)
            == Some("openai-completions")
        && provider
            .and_then(|provider| yaml_mapping_value(provider, "baseURL"))
            .and_then(serde_norway::Value::as_str)
            == Some(expected_base.as_str())
        && selected_provider == Some(DEEPSEEK_HARNESS_PROVIDER_ID)
        && model_is_published
        && credential == Some(api_key);
    Ok((configured, model))
}

pub(crate) fn deepseek_harness_has_managed_marker(paths: &[PathBuf]) -> Result<bool, String> {
    if paths.len() != 2 {
        return Err("DeepSeek Harness 配置路径数量无效".to_string());
    }
    let settings = read_agent_yaml_mapping_or_empty(&paths[0], "DeepSeek Harness settings")?;
    let credentials = read_agent_yaml_mapping_or_empty(&paths[1], "DeepSeek Harness credentials")?;
    let provider_exists = yaml_mapping_value(&settings, "llm-pi-ai")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|section| yaml_mapping_value(section, "providers"))
        .and_then(serde_norway::Value::as_mapping)
        .is_some_and(|providers| {
            yaml_mapping_value(providers, DEEPSEEK_HARNESS_PROVIDER_ID).is_some()
        });
    let default_selected = yaml_mapping_value(&settings, "agent-default-model")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|selection| yaml_mapping_value(selection, "provider"))
        .and_then(serde_norway::Value::as_str)
        == Some(DEEPSEEK_HARNESS_PROVIDER_ID);
    let credential_exists = yaml_mapping_value(&credentials, DEEPSEEK_HARNESS_CREDENTIAL).is_some();
    Ok(provider_exists || default_selected || credential_exists)
}
