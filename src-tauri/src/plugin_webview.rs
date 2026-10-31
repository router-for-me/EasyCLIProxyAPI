use super::{management_plaintext_key, open_external_url_inner, GuiConfigState};
use crate::plugins::resolve_plugin_entry_url;
use std::sync::Mutex;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Manager, Rect, State, Url, Webview, WebviewUrl};

const MAIN_WINDOW: &str = "main";
const PLUGIN_WEBVIEW: &str = "plugin-page";

const SUPERSEDED: &str = "Plugin page request was superseded";

#[derive(Default)]
pub(crate) struct PluginWebviewState(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    latest: u64,
    owner: Option<u64>,
    placed: Option<PlacedBounds>,
    session: Option<Session>,
}

impl Inner {
    fn begin(&mut self, token: u64, placed: Option<PlacedBounds>) -> bool {
        if token <= self.latest {
            return false;
        }
        self.latest = token;
        self.owner = Some(token);
        self.placed = placed;
        true
    }

    fn place(&mut self, token: u64, placed: Option<PlacedBounds>) -> bool {
        let owned = self.owns(token);
        if owned {
            self.placed = placed;
        }
        owned
    }

    fn owns(&self, token: u64) -> bool {
        self.owner == Some(token)
    }

    fn release(&mut self, token: u64) -> bool {
        if token < self.latest {
            return false;
        }
        self.latest = token;
        self.owner = None;
        true
    }

    fn clear(&mut self) {
        self.owner = None;
        self.session = None;
    }
}

impl PluginWebviewState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
        self.0
            .lock()
            .map_err(|_| "Plugin page state is unavailable".to_string())
    }
}

#[derive(Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Labels {
    back: String,
    reload: String,
    open_external: String,
    #[serde(rename = "move")]
    grip: String,
}

struct Session {
    origin: String,
    key: String,
    labels: Labels,
    url: String,
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PlacedBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, PartialEq)]
enum EntryAction {
    Keep,
    Navigate,
    Reload,
}

// `main` is the actual webview client rectangle in physical pixels, relative to
// the window. CSS pixels can differ from OS logical pixels (zoom/DPI changes).
fn place_bounds(bounds: Bounds, main: PlacedBounds) -> Result<Option<PlacedBounds>, String> {
    let values = [
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        bounds.viewport_height,
        main.x,
        main.y,
        main.width,
        main.height,
    ];
    if values.iter().any(|value| !value.is_finite()) {
        return Err("Plugin page bounds must be finite numbers".to_string());
    }
    if bounds.width <= 0.0
        || bounds.height <= 0.0
        || bounds.viewport_height <= 0.0
        || main.width <= 0.0
        || main.height <= 0.0
    {
        return Ok(None);
    }
    // Browser zoom is uniform. Derive its physical scale from the webview,
    // never infer a titlebar inset from a difference in differently scaled heights.
    let scale = main.height / bounds.viewport_height;
    let left = (bounds.x.max(0.0) * scale).round().min(main.width);
    let top = (bounds.y.max(0.0) * scale).round().min(main.height);
    let right = ((bounds.x.max(0.0) + bounds.width) * scale)
        .round()
        .min(main.width);
    let bottom = ((bounds.y.max(0.0) + bounds.height) * scale)
        .round()
        .min(main.height);
    Ok((right > left && bottom > top).then_some(PlacedBounds {
        x: main.x + left,
        y: main.y + top,
        width: right - left,
        height: bottom - top,
    }))
}

fn main_webview_bounds(app: &AppHandle) -> Result<PlacedBounds, String> {
    let webview = app
        .get_webview(MAIN_WINDOW)
        .ok_or_else(|| "Main webview is unavailable".to_string())?;
    let scale = webview
        .window()
        .scale_factor()
        .map_err(|error| error.to_string())?;
    let rect = webview.bounds().map_err(|error| error.to_string())?;
    let position = rect.position.to_physical::<i32>(scale);
    let size = rect.size.to_physical::<u32>(scale);
    Ok(PlacedBounds {
        x: position.x as f64,
        y: position.y as f64,
        width: size.width as f64,
        height: size.height as f64,
    })
}

fn to_rect(placed: PlacedBounds) -> Rect {
    Rect {
        position: tauri::PhysicalPosition::new(placed.x as i32, placed.y as i32).into(),
        size: tauri::PhysicalSize::new(placed.width as u32, placed.height as u32).into(),
    }
}

fn url_origin(url: &str) -> Result<String, String> {
    let url = Url::parse(url).map_err(|_| "Invalid plugin page URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Plugin pages must use http or https".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

fn js_string(value: &str) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "\"\"".to_string())
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

const PAGE_SCRIPT: &str = include_str!("plugin_webview_script.js");

fn plugin_page_script(origin: &str, key: &str, labels: &Labels) -> String {
    format!(
        "(function(){{var O={},K={},L={{back:{},reload:{},open:{},move:{}}};{}}})();",
        js_string(origin),
        js_string(key),
        js_string(&labels.back),
        js_string(&labels.reload),
        js_string(&labels.open_external),
        js_string(&labels.grip),
        PAGE_SCRIPT
    )
}

fn entry_action(
    url_changed: bool,
    reload: bool,
    current_origin: Option<&str>,
    core_origin: &str,
) -> EntryAction {
    if url_changed {
        EntryAction::Navigate
    } else if !reload {
        EntryAction::Keep
    } else if current_origin == Some(core_origin) {
        EntryAction::Reload
    } else {
        EntryAction::Navigate
    }
}

fn main_window_browser_args(windows: &[tauri::utils::config::WindowConfig]) -> Option<&str> {
    windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .and_then(|window| window.additional_browser_args.as_deref())
}

fn plugin_webview(app: &AppHandle) -> Option<Webview> {
    app.get_webview(PLUGIN_WEBVIEW)
}

pub(crate) fn sync_window_activity(app: &AppHandle) -> Result<(), String> {
    // Called on a worker, like the plugin commands. Serialize with navigation
    // and read current placement; apply_bounds checks current native visibility.
    let state = app.state::<PluginWebviewState>();
    let inner = state.lock()?;
    let placed = if inner.owner.is_some() { inner.placed } else { None };
    if let Some(webview) = plugin_webview(app) {
        apply_bounds(&webview, placed)?;
    }
    Ok(())
}

fn apply_bounds(webview: &Webview, placed: Option<PlacedBounds>) -> Result<(), String> {
    // Pending layout requests must not reshow a plugin while its window is hidden.
    let window = webview.window();
    let active = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true);
    match placed.filter(|_| active) {
        Some(placed) => {
            webview
                .set_bounds(to_rect(placed))
                .map_err(|error| error.to_string())?;
            webview.show().map_err(|error| error.to_string())
        }
        None => webview.hide().map_err(|error| error.to_string()),
    }
}

fn build_webview(
    app: &AppHandle,
    url: &str,
    script: String,
    placed: Option<PlacedBounds>,
) -> Result<Webview, String> {
    let window = app
        .get_window(MAIN_WINDOW)
        .ok_or_else(|| "Main window is unavailable".to_string())?;
    let parsed = Url::parse(url).map_err(|_| "Invalid plugin page URL".to_string())?;
    let new_window_app = app.clone();
    let mut builder = WebviewBuilder::new(PLUGIN_WEBVIEW, WebviewUrl::External(parsed))
        .initialization_script(script)
        .on_new_window(move |target, _| {
            if matches!(target.scheme(), "http" | "https") {
                let _ = open_external_url_inner(&new_window_app, target.as_str());
            }
            NewWindowResponse::Deny
        });
    if let Some(args) = main_window_browser_args(&app.config().app.windows) {
        builder = builder.additional_browser_args(args);
    }
    let initial = placed.unwrap_or(PlacedBounds {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    });
    let webview = window
        .add_child(
            builder,
            tauri::PhysicalPosition::new(initial.x as i32, initial.y as i32),
            tauri::PhysicalSize::new(initial.width as u32, initial.height as u32),
        )
        .map_err(|error| error.to_string())?;
    apply_bounds(&webview, placed)?;
    Ok(webview)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn show_plugin_webview(
    app: AppHandle,
    gui_config_state: State<'_, GuiConfigState>,
    state: State<'_, PluginWebviewState>,
    plugin_id: String,
    menu_index: usize,
    bounds: Bounds,
    labels: Labels,
    reload: bool,
    token: u64,
) -> Result<String, String> {
    let placed = main_webview_bounds(&app).and_then(|main| place_bounds(bounds, main));
    if !state.lock()?.begin(token, placed.clone().unwrap_or(None)) {
        return Err(SUPERSEDED.to_string());
    }
    let result = match placed {
        Ok(_) => {
            open_plugin_page(
                &app,
                &gui_config_state,
                &state,
                plugin_id,
                menu_index,
                labels,
                reload,
                token,
            )
            .await
        }
        Err(error) => Err(error),
    };
    if result.is_err() && state.lock()?.release(token) {
        if let Some(webview) = plugin_webview(&app) {
            let _ = webview.hide();
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn open_plugin_page(
    app: &AppHandle,
    gui_config_state: &GuiConfigState,
    state: &PluginWebviewState,
    plugin_id: String,
    menu_index: usize,
    labels: Labels,
    reload: bool,
    token: u64,
) -> Result<String, String> {
    let config = gui_config_state.snapshot()?;
    let url = resolve_plugin_entry_url(&config, &plugin_id, menu_index).await?;
    let key = management_plaintext_key(&config)?.to_string();
    let origin = url_origin(&url)?;
    let mut inner = state.lock()?;
    if !inner.owns(token) {
        return Err(SUPERSEDED.to_string());
    }
    let placed = inner.placed;
    let existing = plugin_webview(app);
    let reusable = existing
        .as_ref()
        .filter(|_| {
            inner.session.as_ref().is_some_and(|current| {
                current.origin == origin && current.key == key && current.labels == labels
            })
        })
        .cloned();
    match reusable {
        Some(webview) => {
            let url_changed = inner
                .session
                .as_ref()
                .is_some_and(|current| current.url != url);
            let current_origin = webview
                .url()
                .ok()
                .map(|current| current.origin().ascii_serialization());
            match entry_action(url_changed, reload, current_origin.as_deref(), &origin) {
                EntryAction::Keep => {}
                EntryAction::Reload => webview.reload().map_err(|error| error.to_string())?,
                EntryAction::Navigate => {
                    let parsed =
                        Url::parse(&url).map_err(|_| "Invalid plugin page URL".to_string())?;
                    webview
                        .navigate(parsed)
                        .map_err(|error| error.to_string())?;
                }
            }
            apply_bounds(&webview, placed)?;
        }
        None => {
            inner.session = None;
            if let Some(webview) = existing {
                webview.close().map_err(|error| error.to_string())?;
            }
            let script = plugin_page_script(&origin, &key, &labels);
            build_webview(app, &url, script, placed)?;
        }
    }
    inner.session = Some(Session {
        origin,
        key,
        labels,
        url: url.clone(),
    });
    Ok(url)
}

#[tauri::command]
pub(crate) async fn set_plugin_webview_bounds(
    app: AppHandle,
    state: State<'_, PluginWebviewState>,
    bounds: Bounds,
    token: u64,
) -> Result<(), String> {
    let placed = place_bounds(bounds, main_webview_bounds(&app)?)?;
    let mut inner = state.lock()?;
    if !inner.place(token, placed) {
        return Ok(());
    }
    match plugin_webview(&app) {
        Some(webview) => apply_bounds(&webview, placed),
        None => Ok(()),
    }
}

#[tauri::command]
pub(crate) async fn hide_plugin_webview(
    app: AppHandle,
    state: State<'_, PluginWebviewState>,
    token: u64,
) -> Result<(), String> {
    let mut inner = state.lock()?;
    if !inner.release(token) {
        return Ok(());
    }
    match plugin_webview(&app) {
        Some(webview) => webview.hide().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub(crate) async fn close_plugin_webview(
    app: AppHandle,
    state: State<'_, PluginWebviewState>,
) -> Result<(), String> {
    let mut inner = state.lock()?;
    inner.clear();
    match plugin_webview(&app) {
        Some(webview) => webview.close().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(x: f64, y: f64, width: f64, height: f64) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
            viewport_height: 768.0,
        }
    }

    fn main_bounds(height: f64) -> PlacedBounds {
        PlacedBounds {
            x: 0.0,
            y: 0.0,
            width: 1280.0,
            height,
        }
    }

    #[test]
    fn zoom_and_dpi_scale_the_entire_rectangle_without_a_fake_titlebar() {
        for scale in [0.8_f64, 1.0, 1.2, 1.25, 1.5, 2.0] {
            let main = PlacedBounds {
                x: 0.0,
                y: 0.0,
                width: (1280.0 * scale).round(),
                height: (768.0 * scale).round(),
            };
            let placed = place_bounds(bounds(264.0, 0.0, 1016.0, 768.0), main)
                .unwrap()
                .unwrap();
            assert_eq!(placed.x, (264.0 * scale).round());
            assert_eq!(placed.y, 0.0, "zoom must not create top whitespace");
            // Integer viewport/physical dimensions can differ by one rounded pixel.
            assert!((placed.x + placed.width - main.width).abs() <= 1.0);
            assert_eq!(placed.y + placed.height, main.height);
        }
    }

    #[test]
    fn actual_main_webview_offset_is_added_once_and_content_is_clipped() {
        let main = PlacedBounds {
            x: 12.0,
            y: 32.0,
            width: 1600.0,
            height: 960.0,
        };
        assert_eq!(
            place_bounds(bounds(264.0, 48.0, 1016.0, 720.0), main).unwrap(),
            Some(PlacedBounds {
                x: 342.0,
                y: 92.0,
                width: 1270.0,
                height: 900.0
            })
        );
        assert_eq!(
            place_bounds(bounds(1200.0, 700.0, 300.0, 200.0), main).unwrap(),
            Some(PlacedBounds {
                x: 1512.0,
                y: 907.0,
                width: 100.0,
                height: 85.0
            })
        );
        assert_eq!(
            place_bounds(bounds(1400.0, 0.0, 10.0, 10.0), main).unwrap(),
            None
        );
        let mut unmeasured = bounds(10.0, 20.0, 30.0, 40.0);
        unmeasured.viewport_height = 0.0;
        assert_eq!(place_bounds(unmeasured, main).unwrap(), None);
        assert_eq!(
            place_bounds(bounds(0.0, 0.0, 10.0, 10.0), main_bounds(0.0)).unwrap(),
            None
        );
        assert!(place_bounds(bounds(10.0, 20.0, 30.0, 40.0), main_bounds(f64::NAN)).is_err());
    }

    #[test]
    fn only_the_current_owner_may_place_or_hide_the_webview() {
        let placed = |x: f64| {
            Some(PlacedBounds {
                x,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            })
        };
        let mut inner = Inner::default();
        assert!(inner.begin(1, placed(1.0)));
        assert!(inner.owns(1));
        assert!(inner.begin(2, placed(2.0)));
        assert!(!inner.owns(1), "a superseded show must not act");
        assert!(
            !inner.place(1, None),
            "bounds from the old page are ignored"
        );
        assert!(!inner.release(1), "hide from the old page is ignored");
        assert_eq!(inner.placed, placed(2.0));
        assert!(inner.place(2, None), "a pending show takes later bounds");
        assert_eq!(inner.placed, None);
        assert!(inner.owns(2));
        assert!(inner.release(2));
        assert!(!inner.owns(2), "late bounds after hide must not re-show");
        assert!(!inner.place(2, placed(3.0)));
        assert!(inner.begin(4, None));
        assert!(
            !inner.begin(3, None),
            "an older show that starts late cannot take over"
        );
        assert!(inner.owns(4));
        assert!(!inner.begin(4, None));
        assert!(
            inner.release(7),
            "a hide that overtakes its show hides the view"
        );
        assert!(!inner.owns(4));
        assert!(!inner.begin(7, None), "the overtaken show is cancelled");
        assert!(inner.begin(8, None));
        inner.session = Some(Session {
            origin: "http://127.0.0.1:8317".to_string(),
            key: "k".to_string(),
            labels: labels(),
            url: "http://127.0.0.1:8317/a".to_string(),
        });
        inner.clear();
        assert!(!inner.owns(8));
        assert!(!inner.begin(8, None), "tokens stay monotonic after close");
        assert!(inner.session.is_none());
    }

    #[test]
    fn entry_reload_stays_on_core_pages_and_returns_from_external_ones() {
        let core = "http://127.0.0.1:8317";
        assert_eq!(
            entry_action(true, false, Some(core), core),
            EntryAction::Navigate
        );
        assert_eq!(
            entry_action(false, false, Some("https://example.com"), core),
            EntryAction::Keep
        );
        assert_eq!(
            entry_action(false, true, Some(core), core),
            EntryAction::Reload
        );
        assert_eq!(
            entry_action(false, true, Some("https://example.com"), core),
            EntryAction::Navigate
        );
        assert_eq!(entry_action(false, true, None, core), EntryAction::Navigate);
    }

    #[test]
    fn child_webview_reuses_the_main_window_browser_args() {
        let window = |label: &str, args: Option<&str>| tauri::utils::config::WindowConfig {
            label: label.to_string(),
            additional_browser_args: args.map(str::to_string),
            ..Default::default()
        };
        let windows = [
            window("other", Some("--other")),
            window("main", Some("--disable-features=x --flag")),
        ];
        assert_eq!(
            main_window_browser_args(&windows),
            Some("--disable-features=x --flag")
        );
        assert_eq!(main_window_browser_args(&[window("main", None)]), None);
        assert_eq!(main_window_browser_args(&[]), None);
    }

    #[test]
    fn bounds_are_rounded_clamped_and_empty_means_hidden() {
        assert_eq!(
            place_bounds(bounds(10.4, 20.6, 300.5, 200.2), main_bounds(768.0)).unwrap(),
            Some(PlacedBounds {
                x: 10.0,
                y: 21.0,
                width: 301.0,
                height: 200.0
            })
        );
        assert_eq!(
            place_bounds(bounds(-5.0, -0.4, 100.0, 50.0), main_bounds(768.0)).unwrap(),
            Some(PlacedBounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 50.0
            })
        );
        for hidden in [
            bounds(0.0, 0.0, 0.0, 50.0),
            bounds(0.0, 0.0, 50.0, 0.0),
            bounds(0.0, 0.0, 0.4, 50.0),
            bounds(0.0, 0.0, -10.0, 50.0),
        ] {
            assert_eq!(place_bounds(hidden, main_bounds(768.0)).unwrap(), None);
        }
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(place_bounds(bounds(invalid, 0.0, 10.0, 10.0), main_bounds(768.0)).is_err());
            assert!(place_bounds(bounds(0.0, invalid, 10.0, 10.0), main_bounds(768.0)).is_err());
            assert!(place_bounds(bounds(0.0, 0.0, invalid, 10.0), main_bounds(768.0)).is_err());
            assert!(place_bounds(bounds(0.0, 0.0, 10.0, invalid), main_bounds(768.0)).is_err());
        }
    }

    #[test]
    fn origins_match_location_origin_serialization() {
        for (url, expected) in [
            (
                "http://127.0.0.1:8317/v0/resource/a?x=1#y",
                "http://127.0.0.1:8317",
            ),
            ("http://127.0.0.1:80/a", "http://127.0.0.1"),
            ("https://localhost:443/a", "https://localhost"),
            ("https://[::1]:8443/a", "https://[::1]:8443"),
            ("http://[::1]:80/a", "http://[::1]"),
        ] {
            assert_eq!(url_origin(url).unwrap(), expected);
        }
        for url in [
            "file:///tmp/a",
            "javascript:alert(1)",
            "data:text/html,a",
            "nope",
        ] {
            assert!(url_origin(url).is_err());
        }
    }

    fn labels() -> Labels {
        Labels {
            back: "Back".to_string(),
            reload: "Reload".to_string(),
            open_external: "Open in browser".to_string(),
            grip: "Move".to_string(),
        }
    }

    fn first_literal(script: &str, marker: &str) -> String {
        let rest = script.split(marker).nth(1).unwrap();
        serde_json::Deserializer::from_str(rest)
            .into_iter::<String>()
            .next()
            .unwrap()
            .unwrap()
    }

    #[test]
    fn page_script_writes_the_key_only_for_the_core_origin_and_escapes_it() {
        let script = plugin_page_script("http://127.0.0.1:8317", "secret", &labels());
        assert!(script.starts_with("(function(){var O=\"http://127.0.0.1:8317\",K=\"secret\","));
        let origin_check = script.find("location.origin === O").unwrap();
        let key_write = script.find("auth.state.managementKey = K").unwrap();
        assert!(origin_check < key_write);
        assert!(script.contains("localStorage.setItem('cli-proxy-auth'"));
        assert!(script.contains("JSON.parse(localStorage.getItem('cli-proxy-auth'))"));

        let hostile = "a\"b\\c\nd</script><img src=x onerror=alert(1)>\u{2028}\u{2029}'";
        let script = plugin_page_script("http://127.0.0.1:8317", hostile, &labels());
        let prefix = &script[..script.find(PAGE_SCRIPT).unwrap()];
        assert!(!prefix.contains("</script>"));
        assert!(!prefix.contains('<'));
        assert!(!prefix.contains('\n'));
        assert!(!prefix.contains('\u{2028}'));
        assert!(!prefix.contains('\u{2029}'));
        assert_eq!(first_literal(&script, ",K="), hostile);

        let script = plugin_page_script("http://x\"+alert(1)+\"", "k", &labels());
        assert_eq!(first_literal(&script, "var O="), "http://x\"+alert(1)+\"");
    }

    #[test]
    fn page_script_adds_corner_controls_only_to_top_level_http_pages() {
        let script = plugin_page_script("http://127.0.0.1:8317", "k", &labels());
        let top_frame = script.find("window.top !== window").unwrap();
        let protocol = script.find("/^https?:$/.test(location.protocol)").unwrap();
        let mount = script.find("attachShadow({ mode: 'closed' })").unwrap();
        assert!(top_frame < mount && protocol < mount);
        assert!(script.contains("cpa-plugin-controls"));
        assert!(script.contains("history.back()"));
        assert!(script.contains("location.reload()"));
        assert!(script.contains("window.open(location.href, '_blank')"));
        assert!(!script.contains("<style"));
        assert!(!script.contains("setAttribute('style'"));
        assert!(script.contains("setPointerCapture"));
        assert!(script.contains("var STORE = 'cpa-gui.plugin-controls'"));
        assert_eq!(script.matches("localStorage.setItem(").count(), 2);
        assert_eq!(
            script
                .matches("localStorage.setItem('cli-proxy-auth'")
                .count(),
            1
        );
        assert_eq!(script.matches("localStorage.setItem(STORE,").count(), 1);
        assert_eq!(script.matches("localStorage.removeItem(").count(), 1);
        assert_eq!(script.matches("localStorage.removeItem(STORE)").count(), 1);

        let hostile = Labels {
            back: "\"</script><b>\u{2028}".to_string(),
            reload: "'+alert(1)+'".to_string(),
            open_external: "a\\\nb".to_string(),
            grip: "\"</script>".to_string(),
        };
        let script = plugin_page_script("http://127.0.0.1:8317", "k", &hostile);
        let prefix = &script[..script.find(PAGE_SCRIPT).unwrap()];
        assert!(!prefix.contains('<') && !prefix.contains('\n') && !prefix.contains('\u{2028}'));
        assert_eq!(first_literal(&script, ",L={back:"), hostile.back);
        assert_eq!(first_literal(&script, ",reload:"), hostile.reload);
        assert_eq!(first_literal(&script, ",open:"), hostile.open_external);
        assert_eq!(first_literal(&script, ",move:"), hostile.grip);
    }
}
