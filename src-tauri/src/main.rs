#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(any(target_os = "linux", test))]
mod linux_graphics;
mod linux_theme;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod native_i18n;
mod plugin_webview;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod tray;
#[cfg(any(windows, test))]
mod webview_recovery;
mod window_activity;
mod window_geometry;
mod window_material;
#[cfg(target_os = "windows")]
mod windows_frame;

use ecpa_core::{
    acquire_app_instance_guard, bootstrap_core_states, configured_window_size, core_base_dir,
    current_core_status, emit_core_status, lock_core_operation, normalize_app_locale,
    open_directory_in_file_manager, path_to_string, restart_core_process_with_state,
    should_start_hidden, shutdown_core_services, start_core_process_with_state,
    start_local_background_services, stop_core_process_with_state, try_run_helper_subcommand,
    AppHandle as CoreAppHandle, CoreProcessState, CoreStatus, GuiConfigState, HostPlatform,
    OpenUrlOutcome, RuntimeCapabilities, WindowsCloseAction, WindowsCloseBehavior,
};
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSEvent;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tauri::menu::PredefinedMenuItem;
#[cfg(target_os = "macos")]
use tauri::tray::{MouseButtonState, TrayIcon};
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_opener::OpenerExt;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use tray::*;
use window_geometry::*;

#[cfg(any(target_os = "linux", target_os = "windows"))]
const WINDOWS_CLOSE_REQUEST_EVENT: &str = "windows-close-requested";
const AUTOSTART_ARGUMENT: &str = "--autostart";

struct DesktopHostPlatform {
    tauri_app: OnceLock<tauri::AppHandle>,
    data_dir: String,
}

impl DesktopHostPlatform {
    fn new(data_dir: String) -> Self {
        Self {
            tauri_app: OnceLock::new(),
            data_dir,
        }
    }

    fn attach(&self, app: tauri::AppHandle) {
        let _ = self.tauri_app.set(app);
    }

    fn tauri_handle(&self) -> Option<&tauri::AppHandle> {
        self.tauri_app.get()
    }
}

impl HostPlatform for DesktopHostPlatform {
    fn capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities::desktop(self.data_dir.clone())
    }

    fn exit(&self, code: i32) {
        if let Some(app) = self.tauri_handle() {
            app.exit(code);
        }
    }

    fn request_restart(&self) {
        if let Some(app) = self.tauri_handle() {
            app.request_restart();
        }
    }

    fn app_data_dir(&self) -> Result<PathBuf, String> {
        if let Some(app) = self.tauri_handle() {
            app.path().app_data_dir().map_err(|error| error.to_string())
        } else {
            ecpa_core::runtime::default_app_data_dir()
        }
    }

    fn is_ui_active(&self) -> bool {
        self.tauri_handle()
            .is_some_and(window_activity::is_active)
    }

    fn on_core_status_changed(&self, status: &CoreStatus) {
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        if let Some(app) = self.tauri_handle() {
            update_windows_tray_status(app, status);
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        let _ = status;
    }

    fn on_locale_changed(&self, locale: &str, status: &CoreStatus) {
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        if let Some(app) = self.tauri_handle() {
            update_windows_tray_locale(app, locale, status);
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        let _ = (locale, status);
    }

    fn autostart_enabled(&self) -> Result<bool, String> {
        let app = self
            .tauri_handle()
            .ok_or_else(|| "Desktop host is unavailable".to_string())?;
        app.autolaunch()
            .is_enabled()
            .map_err(|error| format!("Failed to read system startup status: {error}"))
    }

    fn set_autostart_enabled(&self, enabled: bool) -> Result<(), String> {
        let app = self
            .tauri_handle()
            .ok_or_else(|| "Desktop host is unavailable".to_string())?;
        let manager = app.autolaunch();
        if enabled {
            manager
                .enable()
                .map_err(|error| format!("Failed to enable launch at startup: {error}"))
        } else {
            manager
                .disable()
                .map_err(|error| format!("Failed to disable launch at startup: {error}"))
        }
    }

    fn open_url(&self, url: &str, program: Option<&str>) -> Result<OpenUrlOutcome, String> {
        let app = self
            .tauri_handle()
            .ok_or_else(|| "Desktop host is unavailable".to_string())?;
        app.opener()
            .open_url(url, program)
            .map_err(|error| format!("Failed to open browser: {error}"))?;
        Ok(OpenUrlOutcome::Opened)
    }

    fn open_path(&self, path: &Path) -> Result<(), String> {
        if path.is_dir() {
            open_directory_in_file_manager(path)
        } else {
            tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| error.to_string())
        }
    }
}

#[tauri::command]
fn resolve_windows_close_request(
    app: tauri::AppHandle,
    core_app: tauri::State<'_, CoreAppHandle>,
    action: WindowsCloseAction,
    remember: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if action == WindowsCloseAction::MinimizeToTray && !linux_tray_available(&app) {
        return Err(
            "System tray is unavailable; keep the main window open or exit the app".to_string(),
        );
    }

    if remember.unwrap_or(false) {
        let close_behavior = match action {
            WindowsCloseAction::Exit => WindowsCloseBehavior::Exit,
            WindowsCloseAction::MinimizeToTray => WindowsCloseBehavior::MinimizeToTray,
        };
        core_app
            .state::<GuiConfigState>()
            .set_close_behavior(close_behavior)?;
    }

    match action {
        WindowsCloseAction::Exit => app.exit(0),
        WindowsCloseAction::MinimizeToTray => {
            let window =
                main_window(&app).ok_or_else(|| "Main window does not exist".to_string())?;
            crate::window_activity::hide(&window)
                .map_err(|error| format!("Failed to hide main window: {error}"))?;
        }
    }

    Ok(())
}

#[tauri::command]
async fn add_acp_account(
    core_app: tauri::State<'_, CoreAppHandle>,
    label: String,
    replace: Option<String>,
    on_link: tauri::ipc::Channel<ecpa_core::acp::manual_auth::ManualLink>,
) -> Result<ecpa_core::acp::AcpStatus, String> {
    ecpa_core::acp::add_acp_account_with_callback(
        core_app.inner().clone(),
        label,
        replace,
        move |link| {
            on_link
                .send(link)
                .map_err(|_| "Antigravity terminal sign-in did not complete".to_string())
        },
    )
    .await
}

fn start_linux_activation_for_main_window(_app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    {
        let activation_app = _app.clone();
        if let Err(error) = ecpa_core::start_app_activation_listener(move || {
            let app_handle = activation_app.clone();
            if let Err(error) = activation_app
                .run_on_main_thread(move || show_windows_main_window(&app_handle))
            {
                eprintln!("Failed to schedule showing the main window: {error}");
            }
        }) {
            eprintln!("{error}");
        }
    }
}

fn spawn_event_bridge(core_app: &CoreAppHandle, tauri_app: tauri::AppHandle) {
    let mut rx = core_app.subscribe_events();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if let Some(target) = event.target.as_deref() {
                        let _ = tauri_app.emit_to(target, &event.event, event.payload);
                    } else {
                        let _ = tauri_app.emit(&event.event, event.payload);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn main() {
    if let Some(code) = try_run_helper_subcommand() {
        if code != 0 {
            std::process::exit(code);
        }
        return;
    }

    // SAFETY: no worker threads or GTK/WebKit runtime have started yet.
    #[cfg(target_os = "linux")]
    unsafe {
        linux_graphics::configure();
    }

    let instance_guard = match acquire_app_instance_guard() {
        Ok(guard) => guard,
        Err(error) => {
            #[cfg(target_os = "linux")]
            if ecpa_core::portable_update_ack_argument().is_none()
                && ecpa_core::request_running_app_activation()
            {
                return;
            }
            eprintln!("{error}");
            return;
        }
    };

    let data_dir = core_base_dir()
        .map(|p| path_to_string(&p))
        .unwrap_or_default();
    let host = Arc::new(DesktopHostPlatform::new(data_dir));
    let core_app = CoreAppHandle::new(host.clone());
    let bootstrap = match bootstrap_core_states(&core_app, instance_guard) {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };

    let remote_launch = bootstrap.remote_launch;
    let switch_start = bootstrap.switch_start;
    let portable_update_ack = bootstrap.portable_update_ack;
    let initial_window_size = configured_window_size(&bootstrap.gui_config);
    let initial_window_position = configured_window_position(&bootstrap.gui_config);
    let start_hidden =
        !switch_start && !remote_launch && should_start_hidden(&bootstrap.gui_config);

    let context = tauri::generate_context!();
    #[cfg(target_os = "linux")]
    let context = {
        let mut context = context;
        linux_graphics::configure_main_window(context.config_mut());
        context
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARGUMENT]),
        ))
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(core_app.clone())
        .manage(window_activity::WindowActivity::default())
        .manage(plugin_webview::PluginWebviewState::default())
        .manage(MainWindowState::new(
            initial_window_size,
            initial_window_position,
        ));

    let app = app.on_window_event(|window, event| {
        if window.label() != "main" {
            return;
        }

        #[cfg(windows)]
        if matches!(
            event,
            tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }
                | tauri::WindowEvent::Focused(true)
        ) {
            webview_recovery::request(window.app_handle());
        }

        if matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)
        ) {
            window_activity::sync(window.app_handle());
        }

        if let tauri::WindowEvent::Moved(position) = event {
            let state = window.state::<MainWindowState>();
            if state.position_tracking.load(Ordering::Acquire)
                && !window.is_minimized().unwrap_or(true)
                && !window.is_maximized().unwrap_or(true)
            {
                if let Err(error) = state.replace_position(*position) {
                    eprintln!("Failed to record main window position: {error}");
                }
            }
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
            let window_size_state = window.state::<MainWindowState>();
            if let Err(error) = window_size_state.replace(observed_size) {
                eprintln!("Failed to record main window size: {error}");
            }
        }
    });

    #[cfg(target_os = "macos")]
    let app = app.on_window_event(move |window, event| {
        let remote_selected = window
            .state::<CoreAppHandle>()
            .state::<CoreProcessState>()
            .remote_selected
            .load(Ordering::Acquire);
        if !remote_launch && !remote_selected && window.label() == "main" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                set_macos_dock_visible(window.app_handle(), false);
                if let Err(error) = window_activity::hide(window) {
                    eprintln!("Failed to hide main window: {error}");
                    set_macos_dock_visible(window.app_handle(), true);
                }
            }
        }
    });

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let app = app.on_window_event(move |window, event| {
        let remote_selected = window
            .state::<CoreAppHandle>()
            .state::<CoreProcessState>()
            .remote_selected
            .load(Ordering::Acquire);
        if !remote_launch && !remote_selected && window.label() == "main" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.emit(WINDOWS_CLOSE_REQUEST_EVENT, ()) {
                    eprintln!("Failed to show desktop close confirmation: {error}");
                }
            }
        }
    });

    let setup_core = core_app.clone();
    let setup_host = host.clone();
    let app = app.setup(move |app| {
        setup_host.attach(app.handle().clone());
        if let Ok(rt_handle) = tokio::runtime::Handle::try_current() {
            ecpa_core::runtime::async_runtime::set_handle(rt_handle);
        }
        spawn_event_bridge(&setup_core, app.handle().clone());

        #[cfg(target_os = "windows")]
        if let Some(window) = app.get_webview_window("main") {
            windows_frame::install(&window)?;
            window.set_decorations(false)?;
            webview_recovery::install(&window)?;
        }
        if let Some(window) = app.get_webview_window("main") {
            window.set_background_color(Some(tauri::window::Color(255, 255, 255, 255)))?;
        }
        if remote_launch {
            ecpa_core::usage::start_usage_collector(setup_core.clone());
            start_linux_activation_for_main_window(app.handle());
            configure_initial_main_window(app.handle(), false)?;
            if let Some(ack_path) = portable_update_ack.as_ref() {
                ecpa_core::app_update::acknowledge_update_runtime_with_probe(
                    ack_path,
                    false,
                    || Err("Unexpected core acceptance in Remote mode".into()),
                )?;
            }
            return Ok(());
        }

        if let Err(error) = restore_main_window_geometry(app.handle()) {
            eprintln!("{error}");
        }
        app.state::<MainWindowState>()
            .position_tracking
            .store(true, Ordering::Release);

        #[cfg(target_os = "macos")]
        setup_macos_tray(app)?;
        #[cfg(target_os = "linux")]
        if let Err(error) = setup_windows_tray(app) {
            eprintln!(
                "Failed to set up Linux tray; keeping the main window available: {error}"
            );
        }
        #[cfg(target_os = "windows")]
        setup_windows_tray(app)?;

        if let Err(error) = configure_initial_main_window(app.handle(), start_hidden) {
            eprintln!("Failed to configure startup window state: {error}");
        }

        start_linux_activation_for_main_window(app.handle());
        start_local_background_services(&setup_core, switch_start, portable_update_ack);

        Ok(())
    });

    let desktop_local_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
        tauri::generate_handler![
            add_acp_account,
            resolve_windows_close_request,
            plugin_webview::show_plugin_webview,
            plugin_webview::set_plugin_webview_bounds,
            plugin_webview::hide_plugin_webview,
            plugin_webview::close_plugin_webview,
            window_material::detect_window_material,
            window_material::set_window_material,
            window_activity::main_window_active,
            linux_theme::get_linux_system_theme,
        ];
    let desktop_remote_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
        tauri::generate_handler![
            plugin_webview::close_plugin_webview,
            plugin_webview::hide_plugin_webview,
            window_material::detect_window_material,
            window_material::set_window_material,
            window_activity::main_window_active,
            linux_theme::get_linux_system_theme,
        ];

    let app = app.invoke_handler(move |invoke| {
        let command = invoke.message.command().to_string();
        let core_app = invoke
            .message
            .webview()
            .state::<CoreAppHandle>()
            .inner()
            .clone();
        let remote = core_app
            .state::<ecpa_core::remote_cpa::RemoteCpaState>()
            .uses_external_dispatch();

        let is_desktop_cmd = matches!(
            command.as_str(),
            "add_acp_account"
                | "resolve_windows_close_request"
                | "show_plugin_webview"
                | "set_plugin_webview_bounds"
                | "hide_plugin_webview"
                | "close_plugin_webview"
                | "detect_window_material"
                | "set_window_material"
                | "main_window_active"
                | "get_linux_system_theme"
        );
        if is_desktop_cmd {
            if remote {
                let allowed_remote_desktop = matches!(
                    command.as_str(),
                    "close_plugin_webview"
                        | "hide_plugin_webview"
                        | "detect_window_material"
                        | "set_window_material"
                        | "main_window_active"
                        | "get_linux_system_theme"
                );
                if allowed_remote_desktop {
                    return desktop_remote_handler(invoke);
                }
                invoke.resolver.reject(format!(
                    "Built-in CPA operation unavailable for the selected external instance: {command}"
                ));
                return true;
            }
            return desktop_local_handler(invoke);
        }

        let payload = match invoke.message.payload() {
            tauri::ipc::InvokeBody::Json(value) => value.clone(),
            tauri::ipc::InvokeBody::Raw(_) => serde_json::Value::Null,
        };
        let resolver = invoke.resolver;
        tauri::async_runtime::spawn(async move {
            match ecpa_core::rpc::dispatch(core_app, &command, payload).await {
                Ok(value) => resolver.resolve(value),
                Err(error) => resolver.reject(error),
            }
        });
        true
    });

    let app = app.build(context).expect("failed to build app");

    app.run(move |app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_main_window(app_handle),
        tauri::RunEvent::ExitRequested { .. } if remote_launch => {
            #[cfg(windows)]
            webview_recovery::stop(app_handle);
        }
        tauri::RunEvent::Exit if remote_launch => {
            #[cfg(windows)]
            webview_recovery::stop(app_handle);
            let core_app = app_handle.state::<CoreAppHandle>();
            shutdown_core_services(core_app.inner(), true);
        }
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            #[cfg(windows)]
            webview_recovery::stop(app_handle);
            let core_app = app_handle.state::<CoreAppHandle>().inner().clone();
            let process_state = core_app.state::<CoreProcessState>();
            if process_state.shutdown_complete.load(Ordering::Acquire) {
                return;
            }
            api.prevent_exit();
            if process_state.shutting_down.swap(true, Ordering::AcqRel) {
                return;
            }
            if let Err(error) = persist_main_window_geometry(app_handle) {
                eprintln!("Failed to save main window geometry: {error}");
            }
            let app_handle = app_handle.clone();
            tauri::async_runtime::spawn_blocking(move || {
                shutdown_core_services(&core_app, false);
                app_handle.exit(code.unwrap_or(0));
            });
        }
        tauri::RunEvent::Exit => {
            #[cfg(windows)]
            webview_recovery::stop(app_handle);
            let core_app = app_handle.state::<CoreAppHandle>();
            shutdown_core_services(core_app.inner(), false);
        }
        _ => {}
    });
}
