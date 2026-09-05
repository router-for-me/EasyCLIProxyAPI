use super::{
    agent_managed_paths, apply_gui_managed_settings, consume_software_write,
    core_config_settings_from_value, core_install_dir, gui_config_path, is_loopback_host,
    lock_core_config_file, normalized_config_path, path_to_string,
    refresh_agent_config_status_cache, request_codex_model_catalog_refresh, validate_gui_config,
    write_yaml_if_changed, AgentClient, AgentConfigStatusCache, ConfigFilesChangedPayload,
    CoreConfigSettings, GuiConfigFile, GuiConfigState, CONFIG_FILES_CHANGED_EVENT,
    CORE_CONFIG_FILE,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
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

        request_codex_model_catalog_refresh();
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

#[derive(Default)]
struct PendingConfigurationChanges {
    paths: Vec<PathBuf>,
    error: Option<String>,
}

fn configuration_watch_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| {
        nearest_existing_watch_directory(path)
            .and_then(|parent| {
                path.strip_prefix(&parent)
                    .ok()
                    .map(|suffix| normalized_config_path(&parent).join(suffix))
            })
            .unwrap_or_else(|| path.to_path_buf())
    })
}

impl PendingConfigurationChanges {
    fn insert(&mut self, path: PathBuf) {
        self.paths.retain(|existing| existing != &path);
        self.paths.push(path);
    }

    fn record(&mut self, event: notify::Event, tracked_paths: &[(PathBuf, PathBuf)]) -> bool {
        if event.kind.is_access() {
            return false;
        }
        if event.need_rescan() {
            for (tracked, _) in tracked_paths {
                self.insert(tracked.clone());
            }
            return true;
        }
        let mut relevant = false;
        for path in &event.paths {
            let normalized = configuration_watch_path(path);
            for (tracked, canonical) in tracked_paths {
                if tracked.starts_with(path) || canonical.starts_with(&normalized) {
                    self.insert(tracked.clone());
                    relevant = true;
                }
            }
        }
        relevant
    }
}

pub(crate) fn start_configuration_file_watcher(app: tauri::AppHandle) -> Result<(), String> {
    let tracked_paths = tracked_configuration_paths(&app)?;
    let callback_paths: Vec<_> = tracked_paths
        .iter()
        .map(|path| (path.clone(), configuration_watch_path(path)))
        .collect();
    let pending = Arc::new(Mutex::new(PendingConfigurationChanges::default()));
    let callback_pending = pending.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            let Ok(mut pending) = callback_pending.lock() else {
                return;
            };
            let relevant = match event {
                Ok(event) => pending.record(event, &callback_paths),
                Err(error) => {
                    pending.error = Some(error.to_string());
                    for (path, _) in &callback_paths {
                        pending.insert(path.clone());
                    }
                    true
                }
            };
            if relevant {
                let _ = sender.try_send(());
            }
        })
        .map_err(|error| format!("创建配置文件监控器失败: {error}"))?;
    let mut watched_directories = Vec::new();
    ensure_configuration_watch_directories(&mut watcher, &tracked_paths, &mut watched_directories)?;

    thread::spawn(move || {
        let mut watcher = watcher;
        loop {
            if receiver.recv().is_err() {
                return;
            }
            let deadline = Instant::now() + Duration::from_secs(2);
            while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                if receiver
                    .recv_timeout(remaining.min(Duration::from_millis(500)))
                    .is_err()
                {
                    break;
                }
            }
            let mut changes = match pending.lock() {
                Ok(mut pending) => std::mem::take(&mut *pending),
                Err(_) => return,
            };
            if let Some(error) = changes.error.take() {
                eprintln!("配置文件监控错误: {error}");
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
                            changes.insert(tracked_path.clone());
                        }
                    }
                }
                Err(error) => eprintln!("配置目录监控更新失败: {error}"),
            }
            handle_configuration_file_changes(&app, changes.paths, &tracked_paths);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_paths_match_canonical_events_after_the_directory_is_created() {
        let root = std::env::temp_dir();
        let relative = Path::new("cpa-nonexistent-watch-unit-test/agent/config.toml");
        let tracked = root.join(relative);
        let canonical = fs::canonicalize(&root).unwrap().join(relative);
        let mut pending = PendingConfigurationChanges::default();
        let event = notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File))
            .add_path(canonical);
        assert!(pending.record(
            event,
            &[(tracked.clone(), configuration_watch_path(&tracked))]
        ));
        assert_eq!(pending.paths, vec![tracked]);
    }

    #[test]
    fn pending_changes_ignore_noise_and_remain_bounded_in_last_write_order() {
        let root = std::env::temp_dir().join("cpa-watcher-unit-test");
        let gui = root.join("gui.toml");
        let core = root.join("core.yaml");
        let tracked = vec![(gui.clone(), gui.clone()), (core.clone(), core.clone())];
        let mut pending = PendingConfigurationChanges::default();
        let event = |path: PathBuf| {
            notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any))
                .add_path(path)
        };
        for index in 0..1000 {
            assert!(!pending.record(event(root.join(format!("noise-{index}"))), &tracked));
        }
        assert!(pending.paths.is_empty());
        for _ in 0..1000 {
            pending.record(event(gui.clone()), &tracked);
            pending.record(event(core.clone()), &tracked);
        }
        pending.record(event(gui.clone()), &tracked);
        assert_eq!(pending.paths, vec![core, gui]);
    }

    #[test]
    fn parent_directory_events_keep_new_configuration_directories_discoverable() {
        let directory = std::env::temp_dir().join("cpa-watch-missing-parent");
        let path = directory.join("agent/config.toml");
        let mut pending = PendingConfigurationChanges::default();
        let event =
            notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::Folder))
                .add_path(directory);
        assert!(pending.record(event, &[(path.clone(), path.clone())]));
        assert_eq!(pending.paths, vec![path]);
    }
}
