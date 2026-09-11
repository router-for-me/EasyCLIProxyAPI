#[tauri::command]
pub(crate) async fn get_linux_system_theme() -> Option<tauri::Theme> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(read_portal_theme)
            .await
            .ok()
            .flatten()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
fn read_portal_theme() -> Option<tauri::Theme> {
    use dbus::{arg::Variant, blocking::Connection};
    use std::time::Duration;

    let connection = Connection::new_session().ok()?;
    let proxy = connection.with_proxy(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        Duration::from_secs(1),
    );
    let (value,): (Variant<Variant<u32>>,) = proxy
        .method_call(
            "org.freedesktop.portal.Settings",
            "Read",
            ("org.freedesktop.appearance", "color-scheme"),
        )
        .ok()?;
    portal_color_scheme(value.0 .0)
}

#[cfg(any(target_os = "linux", test))]
fn portal_color_scheme(value: u32) -> Option<tauri::Theme> {
    match value {
        1 => Some(tauri::Theme::Dark),
        2 => Some(tauri::Theme::Light),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_the_freedesktop_color_scheme_values() {
        assert_eq!(portal_color_scheme(1), Some(tauri::Theme::Dark));
        assert_eq!(portal_color_scheme(2), Some(tauri::Theme::Light));
        assert_eq!(portal_color_scheme(0), None);
        assert_eq!(portal_color_scheme(3), None);
    }
}
