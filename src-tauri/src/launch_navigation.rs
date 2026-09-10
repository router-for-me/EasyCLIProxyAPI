//! `--page <id>` launch argument: open the app on a given page (for example
//! `--page quota` for OAuth → Quota Lookup). When an instance is already running
//! the request is handed to it through a small file next to the instance lock,
//! so launchers and tray helpers can deep-link without a second window.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::Duration,
};

use tauri::{Emitter, Manager};

use crate::instance_lock::app_instance_key;

pub(crate) const LAUNCH_PAGE_EVENT: &str = "navigate-page";
const REQUEST_FILE_PREFIX: &str = "EasyCLIProxyAPI-navigate";
const REQUEST_POLL_INTERVAL: Duration = Duration::from_millis(500);
const MAX_PAGE_LEN: usize = 64;

pub(crate) struct LaunchPageState(Mutex<Option<String>>);

impl LaunchPageState {
    pub(crate) fn new(page: Option<String>) -> Self {
        Self(Mutex::new(page))
    }
}

/// Extract `--page <id>` or `--page=<id>` from the process arguments.
pub(crate) fn launch_page_argument() -> Option<String> {
    parse_launch_page_argument(std::env::args_os())
}

pub(crate) fn parse_launch_page_argument<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut args = args.into_iter();
    while let Some(argument) = args.next() {
        let argument = argument.to_string_lossy();
        let value = if argument == "--page" {
            args.next().map(|v| v.to_string_lossy().to_string())
        } else {
            argument.strip_prefix("--page=").map(str::to_string)
        };
        if let Some(value) = value {
            return sanitize_page(&value);
        }
    }
    None
}

/// Keep only `a-z A-Z 0-9 - /`, which covers every page and subpage id; the
/// frontend validates the actual target and ignores anything unknown.
pub(crate) fn sanitize_page(value: &str) -> Option<String> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value.len() <= MAX_PAGE_LEN
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '/');
    valid.then(|| value.to_string())
}

pub(crate) fn request_file_path(executable_dir: &Path) -> PathBuf {
    std::env::temp_dir().join(format!(
        "{REQUEST_FILE_PREFIX}-{}.txt",
        app_instance_key(executable_dir)
    ))
}

/// Called by a second launch: leave the page request for the running instance.
pub(crate) fn forward_to_running_instance(executable_dir: &Path, page: &str) -> Result<(), String> {
    let path = request_file_path(executable_dir);
    fs::write(&path, page)
        .map_err(|error| format!("写入页面导航请求失败 {}: {error}", path.display()))
}

/// Take (and clear) the request left by another launch, if any.
pub(crate) fn take_forwarded_request(executable_dir: &Path) -> Option<String> {
    let path = request_file_path(executable_dir);
    let content = fs::read_to_string(&path).ok()?;
    let _ = fs::remove_file(&path);
    sanitize_page(&content)
}

#[tauri::command]
pub(crate) fn take_launch_page(state: tauri::State<'_, LaunchPageState>) -> Option<String> {
    state.0.lock().ok().and_then(|mut page| page.take())
}

/// Bring the main window back (it may be hidden in the tray or minimised).
fn reveal_main_window(app: &tauri::AppHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        crate::tray::show_main_window(app);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            if window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
            }
            let _ = window.set_focus();
        }
    }
}

/// Watch for page requests from later launches and forward them to the webview.
pub(crate) fn start_navigation_request_watcher(app: tauri::AppHandle) {
    let Ok(executable_dir) = crate::core_runtime::executable_dir() else {
        return;
    };
    let _ = fs::remove_file(request_file_path(&executable_dir)); // stale request from a previous run
    thread::spawn(move || loop {
        thread::sleep(REQUEST_POLL_INTERVAL);
        if let Some(page) = take_forwarded_request(&executable_dir) {
            reveal_main_window(&app);
            if let Err(error) = app.emit(LAUNCH_PAGE_EVENT, page) {
                eprintln!("发送页面导航事件失败: {error}");
            }
        }
    });
}
