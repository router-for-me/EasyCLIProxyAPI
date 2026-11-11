use std::time::Duration;

#[derive(Default)]
struct Decision {
    generation: u64,
    dead: bool,
    queued: bool,
    stopped: bool,
    plugin_exit_pid: Option<u32>,
    attempts: Vec<Duration>,
}

impl Decision {
    fn queue(&mut self) -> bool {
        if self.stopped || self.queued {
            return false;
        }
        self.queued = true;
        true
    }

    fn exited(&mut self, generation: u64, pid: u32) -> bool {
        if self.stopped || self.dead || generation != self.generation {
            return false;
        }
        self.dead = true;
        self.plugin_exit_pid = Some(pid);
        true
    }

    fn begin(&mut self, now: Duration) -> bool {
        if self.stopped || !self.dead {
            return false;
        }
        self.attempts
            .retain(|time| now.saturating_sub(*time) < Duration::from_secs(60));
        if self.attempts.len() >= 3
            || self
                .attempts
                .last()
                .is_some_and(|time| now.saturating_sub(*time) < Duration::from_secs(5))
        {
            return false;
        }
        self.attempts.push(now);
        self.generation += 1;
        true
    }
}

fn client_size(width: i32, height: i32, minimized: bool) -> Option<tauri::PhysicalSize<u32>> {
    (width > 0 && height > 0 && !minimized)
        .then(|| tauri::PhysicalSize::new(width as u32, height as u32))
}

// windows_sys is a cfg(windows) dependency, so these paths must not be expanded
// on other targets; the predicate itself stays target-independent and testable.
#[cfg(windows)]
fn is_minimized_resize_message(message: u32, wparam: usize) -> bool {
    message == windows_sys::Win32::UI::WindowsAndMessaging::WM_SIZE
        && wparam == windows_sys::Win32::UI::WindowsAndMessaging::SIZE_MINIMIZED as usize
}

fn is_minimized_resize_codes(message: u32, wparam: usize, size: u32, minimized: u32) -> bool {
    message == size && wparam == minimized as usize
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        io,
        panic::{catch_unwind, AssertUnwindSafe},
        sync::Mutex,
        time::Instant,
    };
    use tauri::Manager;
    use webview2_com::{
        BrowserProcessExitedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2Environment5,
    };
    use windows::core::Interface;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::RemoteDesktop::{
            WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
            NOTIFY_FOR_THIS_SESSION,
        },
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                DestroyWindow, GetClientRect, GetParent, IsWindow, SetWindowPos, HWND_BOTTOM,
                SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WM_DISPLAYCHANGE, WM_DPICHANGED,
                WM_NCDESTROY, WM_SETTINGCHANGE, WM_WTSSESSION_CHANGE,
            },
        },
    };

    const ID: usize = 0x557;

    macro_rules! diagnostic {
        ($($argument:tt)*) => { write_diagnostic(format_args!($($argument)*)) };
    }

    fn write_diagnostic(message: std::fmt::Arguments<'_>) {
        eprintln!("{message}");
        let wide: Vec<u16> = format!("[WebView recovery] {message}\n\0")
            .encode_utf16()
            .collect();
        unsafe {
            windows_sys::Win32::System::Diagnostics::Debug::OutputDebugStringW(wide.as_ptr());
        }
    }

    struct State {
        decision: Mutex<Decision>,
        started: Instant,
        token: Mutex<Option<i64>>,
        initial_host: Mutex<Option<usize>>,
    }

    pub(crate) fn install(window: &tauri::WebviewWindow) -> io::Result<()> {
        let app = window.app_handle();
        app.manage(State {
            decision: Mutex::new(Decision::default()),
            started: Instant::now(),
            token: Mutex::new(None),
            initial_host: Mutex::new(None),
        });
        let hwnd = window.hwnd().map_err(io::Error::other)?.0 as HWND;
        let data = Box::into_raw(Box::new(app.clone()));
        unsafe {
            if SetWindowSubclass(hwnd, Some(events), ID, data as usize) == 0 {
                drop(Box::from_raw(data));
                return Err(io::Error::other(
                    "Failed to install main WebView session observer",
                ));
            }
            if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
                diagnostic!(
                    "Main WebView session registration failed: {}",
                    io::Error::last_os_error()
                );
            }
        }
        observe(app);
        request(app);
        Ok(())
    }

    unsafe extern "system" fn events(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        data: usize,
    ) -> LRESULT {
        let handled = catch_unwind(AssertUnwindSafe(|| -> Option<LRESULT> {
            let app = &*(data as *const tauri::AppHandle);
            if message == WM_NCDESTROY {
                stop(app);
                WTSUnRegisterSessionNotification(hwnd);
                RemoveWindowSubclass(hwnd, Some(events), ID);
                drop(Box::from_raw(data as *mut tauri::AppHandle));
            } else if is_minimized_resize_message(message, wparam) {
                // Tao's undecorated WM_NCCALCSIZE leaves a non-zero iconic client rect at
                // (-32000, -32000), and tauri-runtime-wry resizes child WebViews on every
                // Resized event without filtering SIZE_MINIMIZED. Handled here and not
                // forwarded, so the iconic dimensions never reach Tao and the main WebView
                // keeps its real bounds across minimize/restore.
                crate::window_activity::sync(app);
                return Some(0);
            } else if matches!(
                message,
                WM_WTSSESSION_CHANGE | WM_DISPLAYCHANGE | WM_DPICHANGED | WM_SETTINGCHANGE
            ) {
                request(app);
            }
            None
        }))
        .ok()
        .flatten();
        if let Some(result) = handled {
            return result;
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    pub(crate) fn stop(app: &tauri::AppHandle) {
        if let Some(state) = app.try_state::<State>() {
            state
                .decision
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .stopped = true;
        }
    }

    fn observe(app: &tauri::AppHandle) {
        let Some(view) = app.get_webview("main") else {
            return;
        };
        let generation = app.state::<State>().decision.lock().unwrap().generation;
        let handle = app.clone();
        if let Err(error) = view.with_webview(move |native| {
            let result = (|| -> windows::core::Result<()> {
                let environment = native.environment().cast::<ICoreWebView2Environment5>()?;
                let mut pid = 0;
                unsafe { native.controller().CoreWebView2()?.BrowserProcessId(&mut pid)?; }
                if generation == 0 {
                    let mut host = windows::Win32::Foundation::HWND::default();
                    unsafe { native.controller().ParentWindow(&mut host)?; }
                    *handle.state::<State>().initial_host.lock().unwrap() = Some(host.0 as usize);
                }
                let callback_app = handle.clone();
                let callback = BrowserProcessExitedEventHandler::create(Box::new(move |_, args| {
                    let _ = catch_unwind(AssertUnwindSafe(|| {
                        let Some(args) = args else { return };
                        let mut exited_pid = 0;
                        if unsafe { args.BrowserProcessId(&mut exited_pid) }.is_err() || exited_pid != pid { return; }
                        let state = callback_app.state::<State>();
                        let accepted = state.decision.lock().unwrap().exited(generation, pid);
                        if accepted {
                            let mut kind = Default::default();
                            let exit_kind = unsafe { args.BrowserProcessExitKind(&mut kind) }.map(|_| kind);
                            diagnostic!("Main WebView browser exited: pid={pid}, generation={generation}, kind={exit_kind:?}; scheduling controller replacement");
                            request(&callback_app);
                        }
                    }));
                    Ok(())
                }));
                let mut token = 0;
                unsafe { environment.add_BrowserProcessExited(&callback, &mut token)?; }
                *handle.state::<State>().token.lock().unwrap() = Some(token);
                Ok(())
            })();
            if let Err(error) = result { diagnostic!("Main WebView browser-exit observer installation failed (generation={generation}): {error}"); }
        }) { diagnostic!("Main WebView observer dispatch failed: {error}"); }
    }

    pub(crate) fn request(app: &tauri::AppHandle) {
        let Some(state) = app.try_state::<State>() else {
            return;
        };
        {
            let mut decision = state.decision.lock().unwrap();
            if !decision.queue() {
                return;
            }
        }
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            // The recovery nudge waits for the WebView environment to settle.
            tokio::time::sleep(Duration::from_millis(250)).await;
            let app = handle.clone();
            if let Err(error) = handle.run_on_main_thread(move || refresh(&app)) {
                handle.state::<State>().decision.lock().unwrap().queued = false;
                diagnostic!("Main WebView recovery dispatch failed: {error}");
            }
        });
    }

    fn refresh(app: &tauri::AppHandle) {
        let state = app.state::<State>();
        {
            let mut decision = state.decision.lock().unwrap();
            decision.queued = false;
            if decision.stopped {
                return;
            }
        }
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let exited_pid = state.decision.lock().unwrap().plugin_exit_pid;
            if let Some(pid) = exited_pid {
                if !crate::plugin_webview::recover_main_frontend(app, pid)? {
                    request(app);
                    return Ok(());
                }
                state.decision.lock().unwrap().plugin_exit_pid = None;
            }
            let window = app
                .get_window("main")
                .ok_or("Main native window unavailable")?;
            let mut rect = windows_sys::Win32::Foundation::RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if unsafe { GetClientRect(window.hwnd()?.0 as HWND, &mut rect) } == 0 {
                return Err(io::Error::last_os_error().into());
            }
            let Some(size) = client_size(
                rect.right - rect.left,
                rect.bottom - rect.top,
                window.is_minimized()?,
            ) else {
                return Ok(());
            };
            let replace = state
                .decision
                .lock()
                .unwrap()
                .begin(state.started.elapsed());
            if replace {
                if let Some(view) = app.get_webview("main") {
                    let token = state.token.lock().unwrap().take();
                    view.with_webview(move |native| {
                        if let Some(token) = token {
                            let result = native
                                .environment()
                                .cast::<ICoreWebView2Environment5>()
                                .and_then(|environment| unsafe {
                                    environment.remove_BrowserProcessExited(token)
                                });
                            if let Err(error) = result {
                                diagnostic!("Main WebView observer removal failed: {error}");
                            }
                        }
                    })?;
                    if state.decision.lock().unwrap().stopped {
                        return Ok(());
                    }
                    view.close()?;
                }
                if state.decision.lock().unwrap().stopped {
                    return Ok(());
                }
                let initial_host = *state.initial_host.lock().unwrap();
                if let Some(host) = initial_host {
                    let host = host as HWND;
                    let parent = window.hwnd()?.0 as HWND;
                    unsafe {
                        if IsWindow(host) != 0 {
                            if host == parent || GetParent(host) != parent {
                                return Err(
                                    "Refusing to remove main WebView host with unexpected parent"
                                        .into(),
                                );
                            }
                            if DestroyWindow(host) == 0 {
                                return Err(io::Error::last_os_error().into());
                            }
                        }
                    }
                    *state.initial_host.lock().unwrap() = None;
                }
                if state.decision.lock().unwrap().stopped {
                    return Ok(());
                }
                let config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|config| config.label == "main")
                    .ok_or("Main WebView configuration unavailable")?;
                let view = window.add_child(
                    tauri::webview::WebviewBuilder::from_config(config)
                        .auto_resize()
                        .focused(false),
                    tauri::PhysicalPosition::new(0, 0),
                    size,
                )?;
                state.decision.lock().unwrap().dead = false;
                if state.decision.lock().unwrap().stopped {
                    return Ok(());
                }
                observe(app);
                if !window.is_visible()? {
                    view.hide()?;
                }
                diagnostic!(
                    "Main WebView replaced: generation={}, client={}x{}",
                    state.decision.lock().unwrap().generation,
                    size.width,
                    size.height
                );
            } else if state.decision.lock().unwrap().dead {
                diagnostic!("Main WebView recovery rate-limited; retry via restore/session change after cooldown (maximum 3 attempts/minute)");
            }
            if let Some(view) = app.get_webview("main") {
                view.set_bounds(tauri::Rect {
                    position: tauri::PhysicalPosition::new(0, 0).into(),
                    size: size.into(),
                })?;
                view.with_webview(move |native| {
                    let result = (|| -> windows::core::Result<()> {
                        let controller = native.controller();
                        unsafe {
                            controller.NotifyParentWindowPositionChanged()?;
                            if replace {
                                let mut host = windows::Win32::Foundation::HWND::default();
                                controller.ParentWindow(&mut host)?;
                                if SetWindowPos(
                                    host.0 as HWND,
                                    HWND_BOTTOM,
                                    0,
                                    0,
                                    0,
                                    0,
                                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                                ) == 0
                                {
                                    diagnostic!(
                                        "Main WebView stacking refresh failed: {}",
                                        io::Error::last_os_error()
                                    );
                                }
                            }
                        }
                        Ok(())
                    })();
                    if let Err(error) = result {
                        diagnostic!("Main WebView monitor notification failed: {error}");
                    }
                })?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            diagnostic!("Main WebView recovery/bounds refresh failed: {error}; restore window to retry (rate limited)");
        }
    }
}

#[cfg(windows)]
pub(crate) use native::{install, request, stop};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_requires_teardown_and_rejects_stale_callbacks() {
        let mut state = Decision::default();
        assert!(!state.begin(Duration::ZERO));
        assert!(state.exited(0, 42));
        assert!(!state.exited(0, 99));
        assert_eq!(state.plugin_exit_pid, Some(42));
        assert!(state.begin(Duration::ZERO));
        state.dead = false;
        state.plugin_exit_pid = None;
        assert!(!state.exited(0, 42));
        assert_eq!(state.plugin_exit_pid, None);
        assert!(!state.begin(Duration::from_secs(10)));
    }

    #[test]
    fn recovery_coalesces_requests_and_shutdown_blocks_queued_work() {
        let mut state = Decision::default();
        assert!(state.queue());
        assert!(!state.queue());
        state.exited(0, 42);
        state.stopped = true;
        state.plugin_exit_pid = None;
        assert!(!state.exited(state.generation, 99));
        assert_eq!(state.plugin_exit_pid, None);
        state.queued = false;
        assert!(!state.queue());
        assert!(!state.begin(Duration::ZERO));
    }

    #[test]
    fn geometry_uses_current_physical_client_without_stale_rdp_scaling() {
        assert_eq!(
            client_size(2400, 1290, false),
            Some(tauri::PhysicalSize::new(2400, 1290))
        );
        assert_eq!(
            client_size(1920, 1032, false),
            Some(tauri::PhysicalSize::new(1920, 1032))
        );
        assert_eq!(client_size(0, 1032, false), None);
        assert_eq!(client_size(1920, -1, false), None);
        assert_eq!(client_size(1920, 1032, true), None);
    }

    #[test]
    fn iconic_minimized_client_rect_is_rejected() {
        // GetClientRect reports the iconic client rect (e.g. 175x19) right after
        // WM_SIZE(SIZE_MINIMIZED); it must never become the WebView bounds.
        assert_eq!(client_size(175, 19, true), None);
        assert_eq!(
            client_size(175, 19, false),
            Some(tauri::PhysicalSize::new(175, 19))
        );
    }

    #[test]
    fn minimized_resize_is_handled_without_forwarding() {
        // Values from the Win32 headers; windows_sys is a Windows-only dependency.
        const WM_SIZE: u32 = 0x0005;
        const WM_DPICHANGED: u32 = 0x02E0;
        const SIZE_RESTORED: u32 = 0;
        const SIZE_MINIMIZED: u32 = 1;

        assert!(is_minimized_resize_codes(
            WM_SIZE,
            SIZE_MINIMIZED as usize,
            WM_SIZE,
            SIZE_MINIMIZED
        ));
        assert!(!is_minimized_resize_codes(
            WM_SIZE,
            SIZE_RESTORED as usize,
            WM_SIZE,
            SIZE_MINIMIZED
        ));
        assert!(!is_minimized_resize_codes(
            WM_DPICHANGED,
            0,
            WM_SIZE,
            SIZE_MINIMIZED
        ));
    }

    #[test]
    fn minimized_resize_filter_matches_only_size_minimized_messages() {
        // Values from the Win32 headers; windows_sys is a Windows-only dependency.
        const WM_SIZE: u32 = 0x0005;
        const WM_DPICHANGED: u32 = 0x02E0;
        const SIZE_RESTORED: u32 = 0;
        const SIZE_MINIMIZED: u32 = 1;
        const SIZE_MAXIMIZED: u32 = 2;

        let matches = |message, wparam| {
            is_minimized_resize_codes(message, wparam, WM_SIZE, SIZE_MINIMIZED)
        };
        assert!(matches(WM_SIZE, SIZE_MINIMIZED as usize));
        assert!(!matches(WM_SIZE, SIZE_RESTORED as usize));
        assert!(!matches(WM_SIZE, SIZE_MAXIMIZED as usize));
        assert!(!matches(WM_DPICHANGED, SIZE_MINIMIZED as usize));
    }

    #[test]
    fn recovery_limits_retries_and_respects_shutdown() {
        let mut state = Decision::default();
        state.exited(0, 42);
        assert!(state.begin(Duration::ZERO));
        assert!(!state.begin(Duration::from_secs(1)));
        for seconds in [5, 10] {
            assert!(state.begin(Duration::from_secs(seconds)));
        }
        assert!(!state.begin(Duration::from_secs(11)));
        assert!(!state.begin(Duration::from_secs(59)));
        assert!(state.begin(Duration::from_secs(60)));
        state.stopped = true;
        assert!(!state.exited(state.generation, 42));
        assert!(!state.begin(Duration::from_secs(120)));
    }
}
