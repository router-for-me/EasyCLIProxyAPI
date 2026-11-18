//! Download while running; install verified payloads only before startup services.
mod prepared;
use crate::*;
use prepared::{Payload, PreparedUpdate};
use std::{collections::BTreeMap, future::Future, sync::Arc};

const CHECK_INTERVAL: Duration = Duration::from_secs(3600);
const TARGETS: [&str; 2] = ["core", "app"];
type Attempts = BTreeMap<String, String>;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AutoUpdateSettings {
    pub enabled: bool,
    #[serde(alias = "update-app")]
    pub update_app: bool,
    #[serde(alias = "update-core")]
    pub update_core: bool,
}

impl AutoUpdateSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.enabled && !self.update_app && !self.update_core {
            return Err("Select at least one automatic update target".into());
        }
        Ok(())
    }

    /// Disarms a selection that can never approve anything: updating is on but
    /// no target is chosen, so `includes()` is false everywhere.
    ///
    /// The load path used to reset such a record wholesale to defaults. That
    /// erased which targets the user had considered and, because the loader
    /// writes the sanitized config back, made the reset permanent. Reporting
    /// the disarm as a normalization keeps the record self-describing.
    pub(crate) fn without_unreachable_target(&self) -> Option<Self> {
        if !self.enabled || self.update_app || self.update_core {
            return None;
        }
        Some(Self {
            enabled: false,
            ..self.clone()
        })
    }

    fn includes(&self, target: &str) -> bool {
        self.enabled
            && if target == "core" {
                self.update_core
            } else {
                self.update_app
            }
    }
}

pub(crate) fn write_settings(
    root: &mut toml_edit::Table,
    settings: &AutoUpdateSettings,
) -> Result<(), String> {
    use toml_edit::{value, Item, Table};
    let section = root
        .entry("auto-update")
        .or_insert(Item::Table(Table::new()));
    if !section.is_table() {
        *section = Item::Table(Table::new());
    }
    // Only a hand-edited document could produce a value that reports as a
    // table yet holds no table body. Replacing it keeps an unrelated settings
    // save from failing on input that proves nothing about the settings.
    let section = match section.as_table_mut() {
        Some(section) => section,
        None => {
            *section = Item::Table(Table::new());
            section
                .as_table_mut()
                .ok_or("Automatic update settings could not be written")?
        }
    };
    for key in [
        "updateApp",
        "updateCore",
        "window-enabled",
        "windowEnabled",
        "start-time",
        "startTime",
        "end-time",
        "endTime",
        "install-on-startup",
        "installOnStartup",
        "idle-enabled",
        "idleEnabled",
        "idle-minutes",
        "idleMinutes",
    ] {
        section.remove(key);
    }
    section.insert("enabled", value(settings.enabled));
    section.insert("update-app", value(settings.update_app));
    section.insert("update-core", value(settings.update_core));
    Ok(())
}

pub(crate) fn newer(current: &str, candidate: &str) -> bool {
    let parse = |version: &str| semver::Version::parse(version.trim().trim_start_matches('v')).ok();
    match (parse(current), parse(candidate)) {
        (Some(current), Some(candidate)) => candidate.cmp_precedence(&current).is_gt(),
        _ => false,
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    settings: AutoUpdateSettings,
    phase: &'static str,
    target: Option<&'static str>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
struct Control {
    status: Status,
    download: Option<CancellationToken>,
}

#[derive(Default)]
pub(crate) struct AutoUpdateState {
    operation: Arc<tokio::sync::Mutex<()>>,
    control: Mutex<Control>,
    wake: tokio::sync::Notify,
}

impl AutoUpdateState {
    pub fn try_operation(&self) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        self.operation
            .clone()
            .try_lock_owned()
            .map_err(|_| "Another update is in progress".into())
    }

    fn control(&self) -> Result<std::sync::MutexGuard<'_, Control>, String> {
        self.control
            .lock()
            .map_err(|_| "Automatic update state lock is poisoned".into())
    }

    fn report(
        &self,
        phase: &'static str,
        target: &'static str,
        version: &str,
        error: Option<String>,
    ) {
        if let Ok(mut control) = self.control() {
            control.status = Status {
                phase,
                target: Some(target),
                version: (!version.is_empty()).then(|| version.into()),
                error,
                ..Status::default()
            };
        }
    }

    pub fn shutdown(&self) {
        if let Ok(control) = self.control() {
            if let Some(token) = &control.download {
                token.cancel();
            }
        }
        self.wake.notify_one();
    }
}

#[tauri::command]
pub(crate) fn get_auto_update_status(app: tauri::AppHandle) -> Result<Status, String> {
    let settings = app.state::<GuiConfigState>().snapshot()?.auto_update;
    let mut status = app.state::<AutoUpdateState>().control()?.status.clone();
    if !settings.enabled {
        status = Status {
            phase: "disabled",
            ..Status::default()
        };
    } else if status.phase.is_empty() {
        status.phase = "waiting-update";
    }
    status.settings = settings;
    Ok(status)
}

#[tauri::command]
pub(crate) fn set_auto_update_settings(
    app: tauri::AppHandle,
    settings: AutoUpdateSettings,
) -> Result<Status, String> {
    settings.validate()?;
    let state = app.state::<AutoUpdateState>();
    let mut control = state.control()?;
    if control.status.phase == "installing" {
        return Err("An update is being installed; settings cannot change yet".into());
    }
    app.state::<GuiConfigState>().update(|config| {
        config.auto_update = settings;
        Ok(())
    })?;
    if let Some(token) = &control.download {
        token.cancel();
    }
    control.status = Status::default();
    drop(control);
    state.wake.notify_one();
    get_auto_update_status(app.clone())
}

#[tauri::command]
pub(crate) fn retry_auto_update(app: tauri::AppHandle) -> Result<Status, String> {
    let state = app.state::<AutoUpdateState>();
    let _operation = state.try_operation()?;
    save_attempts(&Attempts::new())?;
    state.control()?.status = Status::default();
    state.wake.notify_one();
    drop(_operation);
    get_auto_update_status(app.clone())
}

fn attempts_path() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join("automatic-update-attempts.json"))
}

fn blocked(attempts: &Attempts, target: &str, version: &str) -> bool {
    attempts
        .get(target)
        .is_some_and(|attempt| normalize_version(attempt) == normalize_version(version))
}

fn load_attempts() -> Result<Attempts, String> {
    match fs::read(attempts_path()?) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid automatic update history: {e}")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Attempts::new()),
        Err(error) => Err(format!("Cannot read automatic update history: {error}")),
    }
}

fn save_attempts(attempts: &Attempts) -> Result<(), String> {
    write_bytes_atomically(
        &attempts_path()?,
        &serde_json::to_vec(attempts).map_err(|e| e.to_string())?,
    )
}

fn current_version(target: &str) -> Result<Option<String>, String> {
    if target == "app" {
        Ok(Some(env!("CARGO_PKG_VERSION").into()))
    } else {
        Ok(read_core_metadata(&core_install_dir()?).map(|meta| meta.version))
    }
}

fn matching_download(
    app: &tauri::AppHandle,
    config: &GuiConfigFile,
    token: &CancellationToken,
) -> Result<(), String> {
    let current = app.state::<GuiConfigState>().snapshot()?;
    if token.is_cancelled()
        || current.auto_update != config.auto_update
        || prepared::origin(&current) != prepared::origin(config)
    {
        token.cancel();
        return Err("Automatic update canceled".into());
    }
    Ok(())
}

fn store_prepared(prepared: &PreparedUpdate) -> Result<(), String> {
    let previous = PreparedUpdate::load(prepared.target()).ok().flatten();
    if let Err(error) = prepared.save() {
        prepared.cleanup_payload();
        return Err(error);
    }
    if let Some(previous) = previous {
        previous.cleanup_payload();
    }
    Ok(())
}

pub(crate) fn cache_application(
    app: &tauri::AppHandle,
    descriptor: &app_update::UpdateDescriptor,
    config: &GuiConfigFile,
    token: &CancellationToken,
) -> Result<(), String> {
    matching_download(app, config, token)?;
    store_prepared(&prepared::capture_app(config, descriptor)?)
}

fn present_cache(
    target: &str,
    config: &GuiConfigFile,
    current: Option<&str>,
) -> Result<Option<PreparedUpdate>, String> {
    let cached = match PreparedUpdate::load(target) {
        Ok(cached) => cached,
        Err(_) => {
            PreparedUpdate::remove_record(target)?;
            return Ok(None);
        }
    };
    if let Some(cached) = cached {
        if cached.matches(config) && current.is_some_and(|version| newer(version, &cached.version))
        {
            return Ok(Some(cached));
        }
        cached.discard()?;
    }
    Ok(None)
}

async fn apply_cached(app: &tauri::AppHandle, prepared: &PreparedUpdate) -> Result<bool, String> {
    match &prepared.payload {
        Payload::Core {
            staging_dir,
            binary_relative_path,
            asset_name,
            ..
        } => {
            core_runtime::install_prepared_core(
                app.clone(),
                core_runtime::StagedCoreInstall {
                    version: prepared.version.clone(),
                    asset_name: asset_name.clone(),
                    install_dir: core_install_dir()?,
                    staging_dir: staging_dir.clone(),
                    binary_relative_path: binary_relative_path.clone(),
                },
            )
            .await?;
            Ok(false)
        }
        Payload::App { descriptor, .. } => {
            let mut descriptor = descriptor.as_ref().clone();
            descriptor.refresh();
            app_update::launch_prepared_portable_update(app, &descriptor).await?;
            Ok(true)
        }
    }
}

pub(crate) async fn startup(app: &tauri::AppHandle) -> bool {
    // This is the only caller of apply_cached. Run before starting local services.
    let state = app.state::<AutoUpdateState>();
    let Ok(_operation) = state.try_operation() else {
        return false;
    };
    for target in TARGETS {
        let mut version = String::new();
        let result: Result<bool, String> = async {
            let config = app.state::<GuiConfigState>().snapshot()?;
            if !config.auto_update.includes(target) {
                return Ok(false);
            }
            let current = current_version(target)?;
            let Some(cached) = present_cache(target, &config, current.as_deref())? else {
                return Ok(false);
            };
            version.clone_from(&cached.version);
            let mut attempts = load_attempts()?;
            if blocked(&attempts, target, &version) {
                return Err(
                    "The previous installation did not complete. Clear the failure to retry".into(),
                );
            }
            if let Err(error) = cached.validate_files() {
                cached.discard()?;
                return Err(error);
            }
            {
                let mut control = state.control()?;
                matching_download(app, &config, &CancellationToken::new())?;
                if app.state::<CoreProcessState>().is_shutting_down() {
                    return Ok(false);
                }
                // Persist before installation; a crash or rollback must not restart a loop.
                attempts.insert(target.into(), version.clone());
                save_attempts(&attempts)?;
                control.status = Status {
                    phase: "installing",
                    target: Some(target),
                    version: Some(version.clone()),
                    ..Status::default()
                };
            }
            let installed = apply_cached(app, &cached).await;
            if installed == Ok(true) {
                return installed;
            }
            let cleanup = cached.discard();
            installed?;
            cleanup?;
            state.report("completed", target, &version, None);
            Ok(false)
        }
        .await;
        match result {
            Ok(true) => return true,
            Ok(false) => {}
            Err(error) => state.report("failed", target, &version, Some(error)),
        }
    }
    false
}

async fn metadata<T>(
    token: &CancellationToken,
    request: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        _ = token.cancelled() => Err("Automatic update canceled".into()),
        result = tokio::time::timeout(Duration::from_secs(60), request) =>
            result.unwrap_or_else(|_| Err("Automatic update metadata check timed out".into())),
    }
}

async fn download_target(
    app: &tauri::AppHandle,
    config: &GuiConfigFile,
    token: &CancellationToken,
    target: &'static str,
    version: &mut String,
) -> Result<Option<String>, String> {
    let current = current_version(target)?;
    let cached = present_cache(target, config, current.as_deref())?;
    let cached_version = cached.map(|p| p.version);
    let Some(current) = current.filter(|_| config.auto_update.includes(target)) else {
        return Ok(None);
    };
    let attempts = load_attempts()?;
    let source = config.selected_download_candidate();
    let should_download = |version: &str| -> Result<bool, String> {
        if !newer(&current, version) {
            return Ok(false);
        }
        if blocked(
            &attempts,
            target,
            cached_version
                .as_deref()
                .filter(|cached| !newer(cached, version))
                .unwrap_or(version),
        ) {
            return Err(
                "The previous installation did not complete. Clear the failure to retry".into(),
            );
        }
        Ok(cached_version
            .as_ref()
            .is_none_or(|cached| newer(cached, version)))
    };
    let state = app.state::<AutoUpdateState>();
    if target == "core" {
        let client = core_runtime::http_client(&config.proxy_url, &config.custom_download_mirrors)?;
        let (release, source) =
            metadata(token, core_runtime::fetch_release(&client, None, source)).await?;
        *version = normalize_version(&release.tag_name);
        if !should_download(version)? {
            return Ok(cached_version);
        }
        matching_download(app, config, token)?;
        state.report("downloading", target, version, None);
        let result = async {
            let staged = core_runtime::prepare_core_automatically(
                app.clone(),
                client,
                release,
                source,
                token.clone(),
            )
            .await?;
            matching_download(app, config, token)?;
            store_prepared(&prepared::capture_core(config, staged)?)
        }
        .await;
        if result.is_err() {
            let _ = core_runtime::cleanup_core_work_dirs();
        }
        result?;
    } else {
        let (info, pending) = metadata(token, app_update::resolve_app_update(config)).await?;
        *version = info.latest_version;
        if !info.auto_update_supported || !should_download(version)? {
            return Ok(cached_version);
        }
        matching_download(app, config, token)?;
        let pending = pending.ok_or("No installable application package")?;
        state.report("downloading", target, version, None);
        let updates = app.state::<AppUpdateState>();
        let preserve_core = cfg!(any(windows, target_os = "macos"));
        updates.start(token.clone())?;
        updates.update_task(|task| {
            task.automatic = true;
            task.preserve_core = preserve_core;
        });
        let result = async {
            updates.start_download(&pending)?;
            app_update::download_and_stage_portable_app_update(
                app,
                &pending,
                token,
                &config.proxy_url,
                source,
                preserve_core,
                Some(config),
            )
            .await
        }
        .await;
        updates.finish(
            if result.is_ok() {
                "downloaded"
            } else {
                "failed"
            },
            result.as_ref().err().cloned(),
        );
        result?;
    }
    Ok(Some(version.clone()))
}

pub(crate) async fn run(app: tauri::AppHandle) {
    let state = app.state::<AutoUpdateState>();
    loop {
        if app.state::<CoreProcessState>().is_shutting_down() {
            return;
        }
        let delay = if let Ok(_operation) = state.try_operation() {
            if let Ok(config) = app.state::<GuiConfigState>().snapshot() {
                let token = CancellationToken::new();
                {
                    let Ok(mut control) = state.control() else {
                        return;
                    };
                    control.download = Some(token.clone());
                }
                for target in TARGETS {
                    if token.is_cancelled() {
                        break;
                    }
                    let mut version = String::new();
                    let result = download_target(&app, &config, &token, target, &mut version).await;
                    if token.is_cancelled() {
                        break;
                    }
                    match result {
                        Ok(Some(version)) => {
                            state.report("waiting-startup", target, &version, None)
                        }
                        Ok(None) => {}
                        Err(error) => {
                            if let Ok(control) = state.control() {
                                if control.status.phase == "failed"
                                    && control.status.target == Some(target)
                                    && control.status.version.as_deref() == Some(&version)
                                {
                                    continue;
                                }
                            }
                            state.report("failed", target, &version, Some(error));
                        }
                    }
                }
                if let Ok(mut control) = state.control() {
                    control.download = None;
                }
            }
            CHECK_INTERVAL
        } else {
            Duration::from_secs(15)
        };
        tokio::select! { _ = state.wake.notified() => {}, _ = tokio::time::sleep(delay) => {} }
    }
}

#[cfg(test)]
mod tests;
