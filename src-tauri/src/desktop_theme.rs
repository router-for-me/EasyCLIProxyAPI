#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ThemePreference {
    Light,
    Dark,
    System,
}

fn read_preference(path: &std::path::Path) -> Result<Option<ThemePreference>, String> {
    match std::fs::read(path) {
        Ok(content) => serde_json::from_slice(&content)
            .map(Some)
            .map_err(|_| "Failed to parse theme preference".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Failed to read theme preference".to_string()),
    }
}

fn write_preference(path: &std::path::Path, preference: ThemePreference) -> Result<(), String> {
    let content = serde_json::to_vec(&preference).map_err(|error| error.to_string())?;
    super::write_bytes_atomically(path, &content)
}

#[tauri::command]
pub(crate) fn get_theme_preference() -> Result<Option<ThemePreference>, String> {
    read_preference(&super::core_base_dir()?.join("theme-preference.json"))
}

#[tauri::command]
pub(crate) fn save_theme_preference(preference: ThemePreference) -> Result<(), String> {
    write_preference(&super::core_base_dir()?.join("theme-preference.json"), preference)
}

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
    fn theme_preference_survives_restart_and_rejects_invalid_values() {
        let directory = std::env::temp_dir().join(format!(
            "ezcpa-theme-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("theme-preference.json");
        assert_eq!(read_preference(&path).unwrap(), None);
        for preference in [ThemePreference::Light, ThemePreference::Dark, ThemePreference::System] {
            write_preference(&path, preference).unwrap();
            assert_eq!(read_preference(&path).unwrap(), Some(preference));
        }
        std::fs::write(&path, b"\"invalid\"").unwrap();
        assert!(read_preference(&path).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn follows_the_freedesktop_color_scheme_values() {
        assert_eq!(portal_color_scheme(1), Some(tauri::Theme::Dark));
        assert_eq!(portal_color_scheme(2), Some(tauri::Theme::Light));
        assert_eq!(portal_color_scheme(0), None);
        assert_eq!(portal_color_scheme(3), None);
    }
}
