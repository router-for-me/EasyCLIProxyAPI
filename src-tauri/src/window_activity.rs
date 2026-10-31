use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Default)]
pub(crate) struct WindowActivity(Mutex<Option<bool>>);

pub(crate) fn is_active(app: &tauri::AppHandle) -> bool {
    app.try_state::<WindowActivity>()
        .is_some_and(|state| *state.0.lock().unwrap() == Some(true))
}

#[tauri::command]
pub(crate) async fn main_window_active(app: tauri::AppHandle) -> Result<bool, String> {
    let window = app.get_window("main").ok_or("Main window is unavailable")?;
    Ok(window.is_visible().map_err(|e| e.to_string())?
        && !window.is_minimized().map_err(|e| e.to_string())?)
}

// #493: hiding the native window alone does not hide the WebView2 controller.
// Run after native show/hide/minimize operations; focus loss alone is not inactivity.
pub(crate) fn sync(app: &tauri::AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(window) = handle.get_window("main") else {
            return;
        };
        let (Ok(visible), Ok(minimized)) = (window.is_visible(), window.is_minimized()) else {
            return;
        };
        let active = visible && !minimized;
        let state = handle.state::<WindowActivity>();
        // Publish the transition to native observers before touching the WebView:
        // controller visibility may itself trigger focus callbacks and re-enter sync.
        let previous = {
            let mut current = state.0.lock().unwrap();
            if *current == Some(active) {
                return;
            }
            current.replace(active)
        };
        if let Some(webview) = handle.get_webview("main") {
            let result = if active {
                webview.show()
            } else {
                webview.hide()
            };
            if let Err(error) = result {
                *state.0.lock().unwrap() = previous;
                eprintln!("Failed to synchronize main webview visibility: {error}");
                return;
            }
        }
        let _ = handle.emit_to("main", "main-window-activity", active);
        // Plugin commands may hold their mutex while waiting on the GUI thread.
        // Never acquire that mutex here: synchronize on a worker instead, using
        // current window state so rapid hide/show transitions cannot replay stale visibility.
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = crate::plugin_webview::sync_window_activity(&handle) {
                eprintln!("Failed to synchronize plugin visibility: {error}");
            }
        });
    }) {
        eprintln!("Failed to schedule window visibility update: {error}");
    }
}

pub(crate) fn hide(window: &tauri::Window) -> tauri::Result<()> {
    window.hide()?;
    sync(window.app_handle());
    Ok(())
}

pub(crate) fn show(window: &tauri::Window) -> tauri::Result<()> {
    window.show()?;
    sync(window.app_handle());
    Ok(())
}
