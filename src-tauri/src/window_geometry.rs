use crate::tray::*;
use ecpa_core::{
    normalized_saved_window_size, GuiConfigFile, GuiConfigState, SavedWindowSize,
    MIN_MAIN_WINDOW_HEIGHT, MIN_MAIN_WINDOW_WIDTH,
};
use std::sync::{
    atomic::AtomicBool,
    Mutex,
};
use tauri::{LogicalSize, Manager};

pub(crate) struct MainWindowState {
    inner: Mutex<Option<SavedWindowSize>>,
    position: Mutex<Option<tauri::PhysicalPosition<i32>>>,
    pub(crate) position_tracking: AtomicBool,
}

impl MainWindowState {
    pub(crate) fn new(
        size: Option<SavedWindowSize>,
        position: Option<tauri::PhysicalPosition<i32>>,
    ) -> Self {
        Self {
            inner: Mutex::new(size),
            position: Mutex::new(position),
            position_tracking: AtomicBool::new(false),
        }
    }

    pub(crate) fn position(&self) -> Result<Option<tauri::PhysicalPosition<i32>>, String> {
        self.position
            .lock()
            .map(|position| *position)
            .map_err(|_| "Main window position status lock is poisoned".to_string())
    }

    pub(crate) fn replace_position(&self, position: tauri::PhysicalPosition<i32>) -> Result<(), String> {
        *self
            .position
            .lock()
            .map_err(|_| "Main window position status lock is poisoned".to_string())? =
            Some(position);
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> Result<Option<SavedWindowSize>, String> {
        self.inner
            .lock()
            .map(|size| *size)
            .map_err(|_| "Main window size status lock is poisoned".to_string())
    }

    pub(crate) fn replace(&self, size: SavedWindowSize) -> Result<(), String> {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "Main window size status lock is poisoned".to_string())?;
        *current = Some(size);
        Ok(())
    }
}

pub(crate) fn configured_window_position(
    config: &GuiConfigFile,
) -> Option<tauri::PhysicalPosition<i32>> {
    config
        .window_x
        .zip(config.window_y)
        .map(|(x, y)| tauri::PhysicalPosition::new(x, y))
}

// Use physical coordinates for monitor layouts, including displays left of the primary.
pub(crate) fn fit_window_position_to_work_area(
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    work_area: &tauri::PhysicalRect<i32, u32>,
) -> tauri::PhysicalPosition<i32> {
    let clamp = |coordinate: i32, origin: i32, available: u32, length: u32| {
        let min = i64::from(origin);
        let max = (min + i64::from(available) - i64::from(length)).max(min);
        i64::from(coordinate).clamp(min, max) as i32
    };
    tauri::PhysicalPosition::new(
        clamp(
            position.x,
            work_area.position.x,
            work_area.size.width,
            size.width,
        ),
        clamp(
            position.y,
            work_area.position.y,
            work_area.size.height,
            size.height,
        ),
    )
}

pub(crate) fn restore_window_position_for_monitor(
    saved_position: tauri::PhysicalPosition<i32>,
    window_size: tauri::PhysicalSize<u32>,
    work_area: &tauri::PhysicalRect<i32, u32>,
    _scale_factor: f64,
) -> (tauri::PhysicalPosition<i32>, tauri::Position) {
    let fitted_physical = fit_window_position_to_work_area(saved_position, window_size, work_area);
    #[cfg(target_os = "macos")]
    let target_position = if _scale_factor.is_finite() && _scale_factor > 0.0 {
        tauri::Position::Logical(tauri::LogicalPosition::new(
            f64::from(fitted_physical.x) / _scale_factor,
            f64::from(fitted_physical.y) / _scale_factor,
        ))
    } else {
        tauri::Position::Physical(fitted_physical)
    };
    #[cfg(not(target_os = "macos"))]
    let target_position = tauri::Position::Physical(fitted_physical);

    (fitted_physical, target_position)
}

#[cfg(target_os = "macos")]
pub(crate) fn window_outer_size_for_monitor<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    monitor: &tauri::Monitor,
    expected_logical_size: Option<SavedWindowSize>,
) -> tauri::PhysicalSize<u32> {
    let target_scale = monitor.scale_factor();
    if let (Ok(outer), Ok(window_scale)) = (window.outer_size(), window.scale_factor()) {
        if window_scale.is_finite()
            && window_scale > 0.0
            && target_scale.is_finite()
            && target_scale > 0.0
        {
            let logical_w = f64::from(outer.width) / window_scale;
            let logical_h = f64::from(outer.height) / window_scale;
            return tauri::PhysicalSize::new(
                (logical_w * target_scale).round() as u32,
                (logical_h * target_scale).round() as u32,
            );
        }
    }
    expected_logical_size
        .map(|size| {
            tauri::PhysicalSize::new(
                (f64::from(size.width) * target_scale).round() as u32,
                (f64::from(size.height) * target_scale).round() as u32,
            )
        })
        .unwrap_or_else(|| window.outer_size().unwrap_or_default())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn window_outer_size_for_monitor<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    _monitor: &tauri::Monitor,
    _expected_logical_size: Option<SavedWindowSize>,
) -> tauri::PhysicalSize<u32> {
    window.outer_size().unwrap_or_default()
}

pub(crate) fn sync_main_webview_bounds(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if let (Some(window), Some(webview)) = (main_window(app), app.get_webview("main")) {
        let inner_size = window
            .inner_size()
            .map_err(|error| format!("Failed to read main window inner size: {error}"))?;
        let scale_factor = window
            .scale_factor()
            .map_err(|error| format!("Failed to read main window scale factor: {error}"))?;
        if scale_factor.is_finite() && scale_factor > 0.0 {
            let logical_size = inner_size.to_logical::<f64>(scale_factor);
            let bounds = tauri::Rect {
                position: tauri::LogicalPosition::new(0.0, 0.0).into(),
                size: tauri::LogicalSize::new(logical_size.width, logical_size.height).into(),
            };
            webview
                .set_bounds(bounds)
                .map_err(|error| format!("Failed to update main webview bounds: {error}"))?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

pub(crate) fn logical_window_size_from_physical(
    physical_size: &tauri::PhysicalSize<u32>,
    scale_factor: f64,
) -> Option<SavedWindowSize> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return None;
    }

    let width = (f64::from(physical_size.width) / scale_factor).round() as u32;
    let height = (f64::from(physical_size.height) / scale_factor).round() as u32;
    if width < MIN_MAIN_WINDOW_WIDTH || height < MIN_MAIN_WINDOW_HEIGHT {
        return None;
    }

    Some(normalized_saved_window_size(width, height))
}

pub(crate) fn fit_window_size_to_monitor<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    saved_size: SavedWindowSize,
    monitor: Option<&tauri::Monitor>,
) -> SavedWindowSize {
    let Some(monitor) = monitor else {
        return saved_size;
    };

    let scale_factor = monitor.scale_factor();
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return saved_size;
    }

    let (frame_width, frame_height) = window
        .outer_size()
        .ok()
        .zip(window.inner_size().ok())
        .map(|(outer, inner)| {
            (
                outer.width.saturating_sub(inner.width),
                outer.height.saturating_sub(inner.height),
            )
        })
        .unwrap_or_default();
    let work_area = monitor.work_area();
    let max_width =
        (f64::from(work_area.size.width.saturating_sub(frame_width)) / scale_factor).floor() as u32;
    let max_height = (f64::from(work_area.size.height.saturating_sub(frame_height)) / scale_factor)
        .floor() as u32;

    SavedWindowSize {
        width: saved_size.width.min(max_width.max(MIN_MAIN_WINDOW_WIDTH)),
        height: saved_size
            .height
            .min(max_height.max(MIN_MAIN_WINDOW_HEIGHT)),
    }
}

pub(crate) fn restore_main_window_geometry(app: &tauri::AppHandle) -> Result<(), String> {
    let window_size_state = app.state::<MainWindowState>();
    let saved_position = window_size_state.position()?;
    let window = main_window(app)
        .ok_or_else(|| "Main window does not exist; cannot restore window geometry".to_string())?;
    let monitor = saved_position
        .and_then(|position| {
            window
                .monitor_from_point(f64::from(position.x), f64::from(position.y))
                .ok()
                .flatten()
        })
        .or_else(|| {
            if saved_position.is_some() {
                window.primary_monitor().ok().flatten()
            } else {
                window.current_monitor().ok().flatten()
            }
        })
        .or_else(|| window.primary_monitor().ok().flatten());

    let restored_size = if let Some(saved_size) = window_size_state.snapshot()? {
        let size = fit_window_size_to_monitor(&window, saved_size, monitor.as_ref());
        window_size_state.replace(size)?;
        Some(size)
    } else {
        None
    };

    if let (Some(position), Some(monitor)) = (saved_position, monitor.as_ref()) {
        let scale_factor = monitor.scale_factor();
        let outer_size = window_outer_size_for_monitor(&window, monitor, restored_size);
        let (fitted_position, target_position) = restore_window_position_for_monitor(
            position,
            outer_size,
            monitor.work_area(),
            scale_factor,
        );
        window
            .set_position(target_position)
            .map_err(|e| format!("Failed to restore main window position: {e}"))?;
        window_size_state.replace_position(fitted_position)?;
    }

    if let Some(restored_size) = restored_size {
        window
            .set_size(LogicalSize::new(
                f64::from(restored_size.width),
                f64::from(restored_size.height),
            ))
            .map_err(|error| format!("Failed to restore main window size: {error}"))?;
    }
    if let (Some(position), Some(monitor)) = (saved_position, monitor.as_ref()) {
        let scale_factor = monitor.scale_factor();
        let outer_size = window_outer_size_for_monitor(&window, monitor, restored_size);
        let (fitted_position, target_position) = restore_window_position_for_monitor(
            position,
            outer_size,
            monitor.work_area(),
            scale_factor,
        );
        window
            .set_position(target_position)
            .map_err(|e| format!("Failed to restore main window position: {e}"))?;
        window_size_state.replace_position(fitted_position)?;
    }
    if let Ok(position) = window.outer_position() {
        window_size_state.replace_position(position)?;
    }
    sync_main_webview_bounds(app)?;
    Ok(())
}

pub(crate) fn persist_main_window_geometry(app: &tauri::AppHandle) -> Result<(), String> {
    let window_size_state = app.state::<MainWindowState>();
    let window = main_window(app);
    let position = match window.as_ref() {
        Some(window)
            if !window.is_minimized().unwrap_or(true) && !window.is_maximized().unwrap_or(true) =>
        {
            window
                .outer_position()
                .ok()
                .or(window_size_state.position()?)
        }
        _ => window_size_state.position()?,
    };
    let saved_size = match window_size_state.snapshot()? {
        Some(size) => size,
        None => {
            let window = main_window(app)
                .ok_or_else(|| "Main window does not exist; cannot save window size".to_string())?;
            let physical_size = window
                .inner_size()
                .map_err(|error| format!("Failed to read main window size: {error}"))?;
            let scale_factor = window
                .scale_factor()
                .map_err(|error| format!("Failed to read main window scale factor: {error}"))?;
            logical_window_size_from_physical(&physical_size, scale_factor)
                .ok_or_else(|| "Invalid main window size; save skipped".to_string())?
        }
    };

    let core_app = app.state::<ecpa_core::AppHandle>();
    core_app
        .state::<GuiConfigState>()
        .set_window_geometry(saved_size, position.map(|p| (p.x, p.y)))
        .map(|_| ())
}

pub(crate) fn configure_initial_main_window(
    app_handle: &tauri::AppHandle,
    start_hidden: bool,
) -> Result<(), String> {
    let window = main_window(app_handle).ok_or_else(|| "Main window does not exist".to_string())?;

    #[cfg(target_os = "macos")]
    set_macos_dock_visible(app_handle, !start_hidden);

    #[cfg(target_os = "linux")]
    let start_hidden = if start_hidden && !linux_tray_available(app_handle) {
        eprintln!(
            "System tray is unavailable; showing the main window instead of starting hidden"
        );
        false
    } else {
        start_hidden
    };

    if start_hidden {
        return crate::window_activity::hide(&window)
            .map_err(|error| format!("Failed to hide main window during silent startup: {error}"));
    }

    crate::window_activity::show(&window)
        .map_err(|error| format!("Failed to show main window: {error}"))?;
    if window.is_minimized().unwrap_or(false) {
        window
            .unminimize()
            .map_err(|error| format!("Failed to restore main window: {error}"))?;
    }
    if let Err(error) = sync_main_webview_bounds(app_handle) {
        eprintln!("Failed to synchronize the main webview bounds: {error}");
    }
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus main window: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ecpa_core::CoreStatus;

    #[test]
    fn saved_window_position_preserves_negative_monitor_coordinates_and_uses_work_area() {
        let work_area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(-2560, -200),
            size: tauri::PhysicalSize::new(2560, 1400),
        };
        let size = tauri::PhysicalSize::new(1600, 1000);
        for (saved, expected) in [
            ((-2400, -100), (-2400, -100)),
            ((-500, 800), (-1600, 200)),
            ((-3000, -400), (-2560, -200)),
        ] {
            assert_eq!(
                fit_window_position_to_work_area(
                    tauri::PhysicalPosition::new(saved.0, saved.1),
                    size,
                    &work_area
                ),
                tauri::PhysicalPosition::new(expected.0, expected.1)
            );
        }
    }

    #[test]
    fn saved_window_position_recovers_from_disconnected_displays_and_oversized_windows() {
        let work_area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(0, 40),
            size: tauri::PhysicalSize::new(1920, 1040),
        };
        assert_eq!(
            fit_window_position_to_work_area(
                tauri::PhysicalPosition::new(4000, 3000),
                tauri::PhysicalSize::new(1280, 800),
                &work_area,
            ),
            tauri::PhysicalPosition::new(640, 280)
        );
        assert_eq!(
            fit_window_position_to_work_area(
                tauri::PhysicalPosition::new(i32::MIN, i32::MAX),
                tauri::PhysicalSize::new(u32::MAX, u32::MAX),
                &work_area,
            ),
            work_area.position
        );
    }

    #[test]
    fn restore_window_position_uses_target_display_scale_factor_on_mixed_dpi_displays() {
        let external_work_area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(1512, -458),
            size: tauri::PhysicalSize::new(2560, 1440),
        };
        let external_window_size = tauri::PhysicalSize::new(2081, 1170);
        let (fitted, target) = restore_window_position_for_monitor(
            tauri::PhysicalPosition::new(1688, -330),
            external_window_size,
            &external_work_area,
            1.0,
        );
        assert_eq!(fitted, tauri::PhysicalPosition::new(1688, -330));
        #[cfg(target_os = "macos")]
        assert_eq!(
            target,
            tauri::Position::Logical(tauri::LogicalPosition::new(1688.0, -330.0))
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(
            target,
            tauri::Position::Physical(tauri::PhysicalPosition::new(1688, -330))
        );
    }

    #[test]
    fn physical_window_size_uses_display_scale_and_ignores_minimized_sizes() {
        let physical_size = tauri::PhysicalSize::new(1500, 1000);
        assert_eq!(
            logical_window_size_from_physical(&physical_size, 1.25),
            Some(SavedWindowSize {
                width: 1200,
                height: 800,
            })
        );
        assert!(logical_window_size_from_physical(&tauri::PhysicalSize::new(0, 0), 1.0).is_none());
        assert!(logical_window_size_from_physical(&physical_size, 0.0).is_none());
    }

    #[test]
    fn main_window_is_found_after_a_child_webview_is_added() {
        let app = tauri::test::mock_app();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        window
            .as_ref()
            .window()
            .add_child(
                tauri::webview::WebviewBuilder::new("plugin", Default::default()),
                tauri::LogicalPosition::new(0.0, 0.0),
                tauri::LogicalSize::new(1.0, 1.0),
            )
            .unwrap();

        assert!(app.get_webview_window("main").is_none());
        assert_eq!(main_window(&app).unwrap().label(), "main");
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn windows_tray_presentation_tracks_core_state_and_busy_actions() {
        let mut status = CoreStatus {
            installed: false,
            running: false,
            ready: false,
            starting: false,
            managed: false,
            process_id: None,
            current_version: None,
            install_dir: String::new(),
            binary_path: None,
            message: String::new(),
            recovery: None,
        };
        let missing = windows_tray_presentation(&status, false, "zh-CN");
        assert_eq!(missing.status_text, "内核状态：未安装");
        assert!(!missing.toggle_enabled);
        assert!(!missing.restart_enabled);

        status.installed = true;
        status.running = true;
        let running = windows_tray_presentation(&status, false, "en-US");
        assert_eq!(running.status_text, "Core status: Running");
        assert_eq!(running.toggle_text, "Stop Core");
    }
}
