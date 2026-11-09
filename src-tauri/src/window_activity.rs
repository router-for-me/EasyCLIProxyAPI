use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ActivityState {
    active: Option<bool>,
    webview_visible: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ActivityTransition {
    previous: ActivityState,
    active: bool,
    active_changed: bool,
    webview_visible: Option<bool>,
}

impl ActivityState {
    fn update(&mut self, visible: bool, minimized: bool) -> Option<ActivityTransition> {
        let active = visible && !minimized;
        let active_changed = self.active != Some(active);
        // Keep the main WebView visible while the window is minimized to the taskbar
        // so DWM animations and restore frames do not flash a black background while
        // waiting for SetIsVisible(true) to recreate the compositor surface. Only
        // hide the WebView controller when the native window itself is hidden.
        let webview_changed = self.webview_visible != Some(visible);
        if !active_changed && !webview_changed {
            return None;
        }
        let previous = *self;
        self.active = Some(active);
        self.webview_visible = Some(visible);
        Some(ActivityTransition {
            previous,
            active,
            active_changed,
            webview_visible: webview_changed.then_some(visible),
        })
    }
}

#[derive(Default)]
pub(crate) struct WindowActivity(Mutex<ActivityState>);

pub(crate) fn is_active(app: &tauri::AppHandle) -> bool {
    app.try_state::<WindowActivity>()
        .is_some_and(|state| state.0.lock().unwrap().active == Some(true))
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
        let state = handle.state::<WindowActivity>();
        // Publish the transition to native observers before touching the WebView:
        // controller visibility may itself trigger focus callbacks and re-enter sync.
        let Some(transition) = state.0.lock().unwrap().update(visible, minimized) else {
            return;
        };
        if let (Some(webview_visible), Some(webview)) =
            (transition.webview_visible, handle.get_webview("main"))
        {
            let result = if webview_visible {
                webview.show()
            } else {
                webview.hide()
            };
            if let Err(error) = result {
                *state.0.lock().unwrap() = transition.previous;
                eprintln!("Failed to synchronize main webview visibility: {error}");
                return;
            }
        }
        if transition.active_changed {
            let _ = handle.emit_to("main", "main-window-activity", transition.active);
        }
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
    if let Some(webview) = window.app_handle().get_webview("main") {
        let _ = webview.show();
    }
    window.show()?;
    sync(window.app_handle());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimizing_pauses_activity_without_hiding_main_webview() {
        let mut state = ActivityState::default();

        let initial = state.update(true, false).expect("initial shown state");
        assert!(initial.active);
        assert!(initial.active_changed);
        assert_eq!(initial.webview_visible, Some(true));

        let minimized = state.update(true, true).expect("minimized transition");
        assert!(!minimized.active);
        assert!(minimized.active_changed);
        assert_eq!(
            minimized.webview_visible, None,
            "minimizing to taskbar must keep the main WebView surface visible"
        );

        let restored = state.update(true, false).expect("restored transition");
        assert!(restored.active);
        assert!(restored.active_changed);
        assert_eq!(
            restored.webview_visible, None,
            "restoring from taskbar does not need to re-show an already visible WebView"
        );
    }

    #[test]
    fn hiding_to_tray_toggles_webview_visibility_and_activity() {
        let mut state = ActivityState::default();
        state.update(true, false);

        let hidden = state.update(false, false).expect("hidden to tray");
        assert!(!hidden.active);
        assert!(hidden.active_changed);
        assert_eq!(hidden.webview_visible, Some(false));

        let hidden_while_minimized = state.update(false, true);
        assert_eq!(hidden_while_minimized, None);

        let shown = state.update(true, false).expect("shown from tray");
        assert!(shown.active);
        assert!(shown.active_changed);
        assert_eq!(shown.webview_visible, Some(true));
    }
}
