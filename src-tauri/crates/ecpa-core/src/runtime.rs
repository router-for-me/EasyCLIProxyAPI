//! Runtime host abstractions shared by the desktop (`cpa-gui`) and headless
//! WebUI (`ecpa-web`) shells without depending on Tauri, GTK, WebKit, or DBus.

use serde::Serialize;
use std::{
    any::{Any, TypeId},
    collections::HashMap,
    future::Future,
    ops::Deref,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, OnceLock, RwLock},
};
use tokio::sync::broadcast;

pub type RpcResult = Result<serde_json::Value, serde_json::Value>;
pub type RpcFuture = Pin<Box<dyn Future<Output = RpcResult> + Send>>;

/// Describes host-level capabilities so the shared frontend can adapt between
/// desktop Tauri mode and headless Linux WebUI mode.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub mode: &'static str,
    pub can_open_local_browser: bool,
    pub can_open_file_manager: bool,
    pub can_launch_desktop_apps: bool,
    pub can_self_update: bool,
    pub supports_native_plugin_webview: bool,
    pub supports_native_dialog: bool,
    pub supports_tray: bool,
    pub supports_autostart: bool,
    pub supports_window_material: bool,
    pub app_version: String,
    pub data_dir: String,
}

impl RuntimeCapabilities {
    pub fn desktop(data_dir: String) -> Self {
        Self {
            mode: "desktop",
            can_open_local_browser: true,
            can_open_file_manager: true,
            can_launch_desktop_apps: true,
            can_self_update: true,
            supports_native_plugin_webview: true,
            supports_native_dialog: true,
            supports_tray: true,
            supports_autostart: true,
            supports_window_material: cfg!(any(target_os = "windows", target_os = "macos")),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            data_dir,
        }
    }

    pub fn webui(data_dir: String) -> Self {
        Self {
            mode: "webui",
            can_open_local_browser: false,
            can_open_file_manager: false,
            can_launch_desktop_apps: false,
            can_self_update: false,
            supports_native_plugin_webview: false,
            supports_native_dialog: false,
            supports_tray: false,
            supports_autostart: false,
            supports_window_material: false,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            data_dir,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub event: String,
    pub payload: serde_json::Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenUrlOutcome {
    Opened,
    /// Headless hosts cannot open a local browser on the server; callers return
    /// the URL to the frontend so the user's browser opens it instead.
    ClientOpenRequired,
}

pub trait HostPlatform: Send + Sync + 'static {
    fn capabilities(&self) -> RuntimeCapabilities;

    fn exit(&self, _code: i32) {}

    fn request_restart(&self) {
        self.exit(0);
    }

    fn app_data_dir(&self) -> Result<PathBuf, String> {
        default_app_data_dir()
    }

    fn is_ui_active(&self) -> bool {
        true
    }

    fn on_core_status_changed(&self, _status: &crate::CoreStatus) {}

    fn on_locale_changed(&self, _locale: &str, _status: &crate::CoreStatus) {}

    fn autostart_enabled(&self) -> Result<bool, String> {
        Ok(false)
    }

    fn set_autostart_enabled(&self, _enabled: bool) -> Result<(), String> {
        Ok(())
    }

    fn open_url(&self, _url: &str, _program: Option<&str>) -> Result<OpenUrlOutcome, String> {
        Ok(OpenUrlOutcome::ClientOpenRequired)
    }

    fn open_path(&self, _path: &Path) -> Result<(), String> {
        Err("Opening local paths on the server is unavailable in headless WebUI mode".to_string())
    }
}

pub struct NullHostPlatform {
    capabilities: RuntimeCapabilities,
}

impl Default for NullHostPlatform {
    fn default() -> Self {
        Self {
            capabilities: RuntimeCapabilities::webui(String::new()),
        }
    }
}

impl HostPlatform for NullHostPlatform {
    fn capabilities(&self) -> RuntimeCapabilities {
        self.capabilities.clone()
    }
}

/// Managed state handle matching the ergonomics and type signature of `tauri::State<'a, T>`.
pub struct State<'a, T: Send + Sync + 'static>(Arc<T>, std::marker::PhantomData<&'a T>);

impl<T: Send + Sync + 'static> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0), std::marker::PhantomData)
    }
}

impl<T: Send + Sync + 'static> State<'_, T> {
    pub fn inner(&self) -> &T {
        self.0.as_ref()
    }

    pub fn arc(&self) -> Arc<T> {
        Arc::clone(&self.0)
    }
}

impl<T: Send + Sync + 'static> Deref for State<'_, T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref()
    }
}

pub struct AppPaths<'a> {
    host: &'a dyn HostPlatform,
}

impl AppPaths<'_> {
    pub fn home_dir(&self) -> Result<PathBuf, String> {
        resolve_home_dir()
    }

    pub fn app_data_dir(&self) -> Result<PathBuf, String> {
        self.host.app_data_dir()
    }
}

pub fn default_app_data_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
            return Ok(PathBuf::from(appdata).join("com.cpa.gui"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let home = resolve_home_dir()?;
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("com.cpa.gui"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
            return Ok(PathBuf::from(xdg).join("com.cpa.gui"));
        }
        let home = resolve_home_dir()?;
        return Ok(home.join(".local").join("share").join("com.cpa.gui"));
    }
    #[allow(unreachable_code)]
    Ok(resolve_home_dir()?.join(".com.cpa.gui"))
}

pub fn resolve_home_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            return Ok(PathBuf::from(profile));
        }
        if let (Some(drive), Some(path)) = (
            std::env::var_os("HOMEDRIVE").filter(|v| !v.is_empty()),
            std::env::var_os("HOMEPATH").filter(|v| !v.is_empty()),
        ) {
            let mut combined = drive;
            combined.push(path);
            return Ok(PathBuf::from(combined));
        }
    }
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    Err("Unable to resolve user home directory".to_string())
}

struct AppInner {
    states: RwLock<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>,
    events: broadcast::Sender<AppEvent>,
    host: Arc<dyn HostPlatform>,
}

/// Shared runtime handle passed across `ecpa-core` services and commands.
#[derive(Clone)]
pub struct AppHandle {
    inner: Arc<AppInner>,
}

impl AppHandle {
    pub fn new(host: Arc<dyn HostPlatform>) -> Self {
        let (events, _) = broadcast::channel(512);
        Self {
            inner: Arc::new(AppInner {
                states: RwLock::new(HashMap::new()),
                events,
                host,
            }),
        }
    }

    pub fn mock() -> Self {
        Self::new(Arc::new(NullHostPlatform::default()))
    }

    pub fn handle(&self) -> &Self {
        self
    }

    pub fn manage<T: Send + Sync + 'static>(&self, state: T) -> bool {
        let mut states = self
            .inner
            .states
            .write()
            .unwrap_or_else(|err| err.into_inner());
        let id = TypeId::of::<T>();
        if states.contains_key(&id) {
            return false;
        }
        states.insert(id, Arc::new(state));
        true
    }

    pub fn manage_arc<T: Send + Sync + 'static>(&self, state: Arc<T>) -> bool {
        let mut states = self
            .inner
            .states
            .write()
            .unwrap_or_else(|err| err.into_inner());
        let id = TypeId::of::<T>();
        if states.contains_key(&id) {
            return false;
        }
        states.insert(id, state);
        true
    }

    pub fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        let states = self
            .inner
            .states
            .read()
            .unwrap_or_else(|err| err.into_inner());
        let any = states.get(&TypeId::of::<T>())?;
        Arc::clone(any)
            .downcast::<T>()
            .ok()
            .map(|arc| State(arc, std::marker::PhantomData))
    }

    pub fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        self.try_state::<T>().unwrap_or_else(|| {
            panic!(
                "state() called before manage() for {}",
                std::any::type_name::<T>()
            )
        })
    }

    pub fn emit<S: Serialize>(&self, event: &str, payload: S) -> Result<(), String> {
        let payload = serde_json::to_value(payload).map_err(|error| error.to_string())?;
        let _ = self.inner.events.send(AppEvent {
            target: None,
            event: event.to_string(),
            payload,
        });
        Ok(())
    }

    pub fn emit_to<S: Serialize>(
        &self,
        target: &str,
        event: &str,
        payload: S,
    ) -> Result<(), String> {
        let payload = serde_json::to_value(payload).map_err(|error| error.to_string())?;
        let _ = self.inner.events.send(AppEvent {
            target: Some(target.to_string()),
            event: event.to_string(),
            payload,
        });
        Ok(())
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<AppEvent> {
        self.inner.events.subscribe()
    }

    pub fn path(&self) -> AppPaths<'_> {
        AppPaths {
            host: self.inner.host.as_ref(),
        }
    }

    pub fn host(&self) -> &dyn HostPlatform {
        self.inner.host.as_ref()
    }

    pub fn exit(&self, code: i32) {
        self.inner.host.exit(code);
    }

    pub fn request_restart(&self) {
        self.inner.host.request_restart();
    }

    pub fn capabilities(&self) -> RuntimeCapabilities {
        self.inner.host.capabilities()
    }
}

#[ecpa_macros::ecpa_command]
pub fn get_runtime_capabilities(app: AppHandle) -> RuntimeCapabilities {
    app.capabilities()
}

/// Tokio runtime helpers replacing `tauri::async_runtime`.
pub mod async_runtime {
    use super::*;

    static RUNTIME_HANDLE: OnceLock<tokio::runtime::Handle> = OnceLock::new();
    static FALLBACK_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

    /// Registers the host's Tokio runtime handle once at startup so background
    /// OS threads can spawn tasks or call `block_on` safely.
    pub fn set_handle(handle: tokio::runtime::Handle) {
        let _ = RUNTIME_HANDLE.set(handle);
    }

    fn handle() -> tokio::runtime::Handle {
        if let Ok(current) = tokio::runtime::Handle::try_current() {
            return current;
        }
        if let Some(registered) = RUNTIME_HANDLE.get() {
            return registered.clone();
        }
        FALLBACK_RUNTIME
            .get_or_init(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("failed to build fallback tokio runtime")
            })
            .handle()
            .clone()
    }

    pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        handle().spawn(future)
    }

    pub fn spawn_blocking<F, R>(func: F) -> tokio::task::JoinHandle<R>
    where
        F: FnOnce() -> R + Send + 'static,
        R: Send + 'static,
    {
        handle().spawn_blocking(func)
    }

    pub fn block_on<F: Future>(future: F) -> F::Output {
        handle().block_on(future)
    }
}
