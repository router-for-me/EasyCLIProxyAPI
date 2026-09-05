use super::{
    agent_managed_paths, apply_gui_managed_settings, consume_software_write,
    core_config_settings_from_value, core_install_dir, gui_config_path, is_loopback_host,
    lock_core_config_file, normalized_config_path, path_to_string,
    refresh_agent_config_status_cache, refresh_applied_codex_model_catalog, validate_gui_config,
    write_yaml_if_changed, AgentClient, AgentConfigStatusCache, ConfigFilesChangedPayload,
    CoreConfigSettings, GuiConfigFile, GuiConfigState, CONFIG_FILES_CHANGED_EVENT,
    CORE_CONFIG_FILE,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager};

fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
    left == right || normalized_config_path(left) == normalized_config_path(right)
}

fn wait_for_config_file_stability(path: &Path) {
    if !path.is_file() {
        return;
    }
    let mut previous = None;
    let mut stable_samples = 0;
    for _ in 0..10 {
        let current = fs::metadata(path)
            .ok()
            .map(|metadata| (metadata.len(), metadata.modified().ok()));
        if current == previous {
            stable_samples += 1;
            if stable_samples >= 2 {
                return;
            }
        } else {
            stable_samples = 0;
            previous = current;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn patch_core_from_gui_config_if_valid(config: &GuiConfigFile) -> Result<(), String> {
    let _guard = lock_core_config_file()?;
    let path = core_install_dir()?.join(CORE_CONFIG_FILE);
    if !path.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("读取内核配置失败 {}: {error}", path_to_string(&path)))?;
    let updated = apply_gui_managed_settings(&content, config)?;
    write_yaml_if_changed(&path, &updated).map(|_| ())
}

fn tracked_configuration_paths(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法获取用户目录: {error}"))?;
    let mut paths = vec![
        gui_config_path()?,
        core_install_dir()?.join(CORE_CONFIG_FILE),
    ];
    for client in [
        AgentClient::ClaudeCode,
        AgentClient::ClaudeDesktop,
        AgentClient::Codex,
        AgentClient::OpenCode,
        AgentClient::OpenClaw,
        AgentClient::Hermes,
        AgentClient::DeepSeekHarness,
        AgentClient::ZCode,
        AgentClient::KimiCode,
        AgentClient::GrokBuild,
    ] {
        paths.extend(agent_managed_paths(client, &home));
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn handle_configuration_file_changes(
    app: &tauri::AppHandle,
    changed_paths: Vec<PathBuf>,
    tracked_paths: &[PathBuf],
) {
    let gui_path = gui_config_path().ok();
    let core_path = core_install_dir()
        .ok()
        .map(|path| path.join(CORE_CONFIG_FILE));
    let gui_state = app.state::<GuiConfigState>();
    let cache = app.state::<AgentConfigStatusCache>();
    let mut payload_paths = Vec::new();
    let mut errors = Vec::new();
    let mut refresh_agents = false;
    let mut tracked_changes: Vec<PathBuf> = Vec::new();

    for path in changed_paths {
        let Some(tracked_path) = tracked_paths
            .iter()
            .find(|tracked| paths_refer_to_same_file(&path, tracked))
            .cloned()
        else {
            continue;
        };
        if consume_software_write(&tracked_path) {
            continue;
        }
        wait_for_config_file_stability(&tracked_path);
        tracked_changes.retain(|existing| !paths_refer_to_same_file(existing, &tracked_path));
        tracked_changes.push(tracked_path);
    }

    payload_paths.extend(tracked_changes.iter().map(|path| path_to_string(path)));
    let is_gui_path = |path: &Path| {
        gui_path
            .as_deref()
            .is_some_and(|gui_path| paths_refer_to_same_file(path, gui_path))
    };
    let is_core_path = |path: &Path| {
        core_path
            .as_deref()
            .is_some_and(|core_path| paths_refer_to_same_file(path, core_path))
    };

    if tracked_changes
        .iter()
        .any(|path| is_gui_path(path) || is_core_path(path))
    {
        refresh_agents = true;
        let mut preserve_invalid_gui_file = false;
        let mut preserve_invalid_core_file = false;
        for tracked_path in tracked_changes.iter().rev() {
            if is_gui_path(tracked_path) {
                let parsed = (|| -> Result<GuiConfigFile, String> {
                    let content = fs::read_to_string(tracked_path).map_err(|error| {
                        format!(
                            "读取 GUI 配置失败 {}: {error}",
                            path_to_string(tracked_path)
                        )
                    })?;
                    let mut config = toml::from_str::<GuiConfigFile>(&content)
                        .map_err(|error| format!("解析 GUI 配置失败: {error}"))?;
                    config.allow_lan = !is_loopback_host(&config.host);
                    validate_gui_config(&config)?;
                    Ok(config)
                })();
                let config = match parsed {
                    Ok(config) => config,
                    Err(error) => {
                        errors.push(error);
                        preserve_invalid_gui_file = true;
                        continue;
                    }
                };
                let result = (|| -> Result<(), String> {
                    gui_state.replace_external(config.clone())?;
                    if !preserve_invalid_core_file {
                        patch_core_from_gui_config_if_valid(&config)?;
                    }
                    cache.clear()?;
                    Ok(())
                })();
                if let Err(error) = result {
                    errors.push(error);
                }
                break;
            }

            if is_core_path(tracked_path) {
                let parsed = (|| -> Result<CoreConfigSettings, String> {
                    let content = fs::read_to_string(tracked_path).map_err(|error| {
                        format!("读取内核配置失败 {}: {error}", path_to_string(tracked_path))
                    })?;
                    let document = serde_norway::from_str::<serde_norway::Value>(&content)
                        .map_err(|error| format!("解析内核配置失败: {error}"))?;
                    core_config_settings_from_value(&document)
                })();
                let settings = match parsed {
                    Ok(settings) => settings,
                    Err(error) => {
                        errors.push(error);
                        preserve_invalid_core_file = true;
                        continue;
                    }
                };
                let result = (|| -> Result<(), String> {
                    if preserve_invalid_gui_file {
                        gui_state.replace_core_settings_external(&settings)?;
                    } else {
                        gui_state.sync_core_settings(&settings)?;
                    }
                    cache.clear()?;
                    Ok(())
                })();
                if let Err(error) = result {
                    errors.push(error);
                }
                break;
            }
        }

        let catalog_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let config = match catalog_app.state::<GuiConfigState>().snapshot() {
                Ok(config) => config,
                Err(error) => {
                    eprintln!("读取配置以刷新 Codex 模型目录失败: {error}");
                    return;
                }
            };
            if let Err(error) = refresh_applied_codex_model_catalog(&catalog_app, &config).await {
                eprintln!("配置变化后刷新 Codex 模型目录失败: {error}");
            }
        });
    }

    refresh_agents |= tracked_changes
        .iter()
        .any(|path| !is_gui_path(path) && !is_core_path(path));

    if refresh_agents {
        if let Err(error) = refresh_agent_config_status_cache(app, gui_state.inner(), cache.inner())
        {
            errors.push(error);
        }
    }
    if !payload_paths.is_empty() || !errors.is_empty() {
        let _ = app.emit(
            CONFIG_FILES_CHANGED_EVENT,
            ConfigFilesChangedPayload {
                paths: payload_paths,
                errors,
            },
        );
    }
}

pub(crate) fn nearest_existing_watch_directory(path: &Path) -> Option<PathBuf> {
    let mut directory = path.parent();
    while let Some(candidate) = directory {
        if candidate.is_dir() {
            return Some(candidate.to_path_buf());
        }
        directory = candidate.parent();
    }
    None
}

fn ensure_configuration_watch_directories(
    watcher: &mut RecommendedWatcher,
    tracked_paths: &[PathBuf],
    watched_directories: &mut Vec<PathBuf>,
) -> Result<Vec<PathBuf>, String> {
    let mut newly_watched = Vec::new();
    for tracked_path in tracked_paths {
        let Some(directory) = nearest_existing_watch_directory(tracked_path) else {
            continue;
        };
        let directory = normalized_config_path(&directory);
        if watched_directories
            .iter()
            .any(|watched| watched == &directory)
        {
            continue;
        }
        watcher
            .watch(&directory, RecursiveMode::NonRecursive)
            .map_err(|error| format!("监控配置目录失败 {}: {error}", path_to_string(&directory)))?;
        watched_directories.push(directory.clone());
        newly_watched.push(directory);
    }
    Ok(newly_watched)
}

pub(crate) fn start_configuration_file_watcher(app: tauri::AppHandle) -> Result<(), String> {
    let tracked_paths = tracked_configuration_paths(&app)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(
        move |event: Result<notify::Event, notify::Error>| match event {
            Ok(event) if event.kind.is_access() => {}
            event => {
                let _ = sender.send(event);
            }
        },
    )
    .map_err(|error| format!("创建配置文件监控器失败: {error}"))?;
    let mut watched_directories = Vec::new();
    ensure_configuration_watch_directories(&mut watcher, &tracked_paths, &mut watched_directories)?;

    thread::spawn(move || {
        let mut watcher = watcher;
        loop {
            let first = match receiver.recv() {
                Ok(event) => event,
                Err(_) => return,
            };
            let mut paths = Vec::new();
            let mut append_paths = |event_paths: Vec<PathBuf>| {
                for path in event_paths {
                    paths.retain(|existing| existing != &path);
                    paths.push(path);
                }
            };
            match first {
                Ok(event) => append_paths(event.paths),
                Err(error) => eprintln!("配置文件监控错误: {error}"),
            }
            while let Ok(event) = receiver.recv_timeout(Duration::from_millis(500)) {
                match event {
                    Ok(event) => append_paths(event.paths),
                    Err(error) => eprintln!("配置文件监控错误: {error}"),
                }
            }
            match ensure_configuration_watch_directories(
                &mut watcher,
                &tracked_paths,
                &mut watched_directories,
            ) {
                Ok(new_directories) => {
                    for tracked_path in &tracked_paths {
                        let parent = tracked_path.parent().map(normalized_config_path);
                        if tracked_path.is_file()
                            && parent.as_ref().is_some_and(|parent| {
                                new_directories.iter().any(|directory| directory == parent)
                            })
                        {
                            append_paths(vec![tracked_path.clone()]);
                        }
                    }
                }
                Err(error) => eprintln!("配置目录监控更新失败: {error}"),
            }
            handle_configuration_file_changes(&app, paths, &tracked_paths);
        }
    });
    Ok(())
}
