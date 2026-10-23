#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThemeSelection {
    version: u8,
    selected_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_light_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_dark_id: Option<String>,
}

impl ThemeSelection {
    fn validate(&self) -> Result<(), String> {
        let valid_id = |id: &str| {
            let bytes = id.as_bytes();
            !bytes.is_empty()
                && bytes.len() <= 64
                && bytes[0].is_ascii_lowercase()
                && bytes
                    .iter()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        };
        if self.version != 1
            || !valid_id(&self.selected_id)
            || [self.last_light_id.as_deref(), self.last_dark_id.as_deref()]
                .into_iter()
                .flatten()
                .any(|id| id == "system" || !valid_id(id))
        {
            return Err("Invalid theme selection".to_string());
        }
        Ok(())
    }
}

fn read_selection(path: &std::path::Path) -> Result<Option<ThemeSelection>, String> {
    match std::fs::read(path) {
        Ok(content) => {
            let selection: ThemeSelection = serde_json::from_slice(&content)
                .map_err(|_| "Failed to parse theme selection".to_string())?;
            selection.validate()?;
            Ok(Some(selection))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Failed to read theme selection".to_string()),
    }
}

fn write_selection(path: &std::path::Path, selection: &ThemeSelection) -> Result<(), String> {
    selection.validate()?;
    let content = serde_json::to_vec(selection).map_err(|error| error.to_string())?;
    super::write_bytes_atomically(path, &content)
}

fn read_legacy_preference(path: &std::path::Path) -> Option<ThemeSelection> {
    let content = std::fs::read(path).ok()?;
    let preference: String = serde_json::from_slice(&content).ok()?;
    matches!(preference.as_str(), "light" | "dark" | "system").then(|| ThemeSelection {
        version: 1,
        selected_id: preference,
        last_light_id: None,
        last_dark_id: None,
    })
}

fn load_selection(directory: &std::path::Path) -> Result<Option<ThemeSelection>, String> {
    Ok(read_selection(&directory.join("theme-selection.json"))?
        .or_else(|| read_legacy_preference(&directory.join("theme-preference.json"))))
}

#[tauri::command]
pub(crate) fn get_theme_selection() -> Result<Option<ThemeSelection>, String> {
    load_selection(&super::core_base_dir()?)
}

#[tauri::command]
pub(crate) fn save_theme_selection(selection: ThemeSelection) -> Result<(), String> {
    write_selection(
        &super::core_base_dir()?.join("theme-selection.json"),
        &selection,
    )
}

const CUSTOM_THEME_LIMIT: usize = 64;
const CUSTOM_THEME_MAX_BYTES: u64 = 64 * 1024;
const CUSTOM_THEME_IMAGE_MAX_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomThemeFile {
    folder: String,
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backdrop_image: Option<String>,
}

#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomThemeList {
    files: Vec<CustomThemeFile>,
    omitted: usize,
}

fn read_custom_theme(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut content = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(CUSTOM_THEME_MAX_BYTES + 1)
        .read_to_string(&mut content)
        .ok()?;
    (content.len() as u64 <= CUSTOM_THEME_MAX_BYTES).then_some(content)
}

fn theme_file_in(folder: &std::path::Path) -> Option<std::path::PathBuf> {
    let path = folder.join("theme.json");
    std::fs::symlink_metadata(&path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|_| path)
}

fn read_backdrop_image(folder: &std::path::Path, content: &str) -> Option<String> {
    use base64::Engine;
    use std::io::Read;
    use std::path::Component;

    let theme: serde_json::Value = serde_json::from_str(content).ok()?;
    let asset = theme.get("assets")?.get("backdropImage")?.as_str()?;
    if asset.is_empty() || asset.contains(['\\', ':']) {
        return None;
    }
    let relative = std::path::Path::new(asset);
    let mime = match relative
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => return None,
    };
    let mut path = folder.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        path.push(name);
        if std::fs::symlink_metadata(&path)
            .ok()?
            .file_type()
            .is_symlink()
        {
            return None;
        }
    }
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > CUSTOM_THEME_IMAGE_MAX_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(CUSTOM_THEME_IMAGE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > CUSTOM_THEME_IMAGE_MAX_BYTES {
        return None;
    }
    let valid = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "image/avif" => {
            let size = bytes
                .get(..4)
                .and_then(|value| value.try_into().ok())
                .map(u32::from_be_bytes)
                .unwrap_or(0) as usize;
            size >= 16
                && size <= bytes.len()
                && bytes.get(4..8) == Some(b"ftyp")
                && (bytes
                    .get(8..12)
                    .is_some_and(|brand| matches!(brand, b"avif" | b"avis"))
                    || bytes[16..size]
                        .chunks_exact(4)
                        .any(|brand| matches!(brand, b"avif" | b"avis")))
        }
        _ => false,
    };
    valid.then(|| {
        format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    })
}

fn list_theme_files(directory: &std::path::Path) -> Result<CustomThemeList, String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CustomThemeList::default())
        }
        Err(_) => return Err("Failed to read custom themes directory".to_string()),
    };
    let mut files = std::collections::BinaryHeap::with_capacity(CUSTOM_THEME_LIMIT + 1);
    let mut omitted = 0;
    for entry in entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
    {
        let Ok(folder) = entry.file_name().into_string() else {
            continue;
        };
        let Some(path) = theme_file_in(&entry.path()) else {
            continue;
        };
        files.push((folder, path));
        if files.len() > CUSTOM_THEME_LIMIT {
            files.pop();
            omitted += 1;
        }
    }
    Ok(CustomThemeList {
        files: files
            .into_sorted_vec()
            .into_iter()
            .map(|(folder, path)| {
                let content = read_custom_theme(&path);
                let backdrop_image = content
                    .as_deref()
                    .and_then(|content| read_backdrop_image(path.parent()?, content));
                CustomThemeFile {
                    content,
                    folder,
                    backdrop_image,
                }
            })
            .collect(),
        omitted,
    })
}

fn custom_themes_dir() -> Result<std::path::PathBuf, String> {
    Ok(super::core_base_dir()?.join("themes"))
}

#[tauri::command]
pub(crate) fn list_custom_themes() -> Result<CustomThemeList, String> {
    list_theme_files(&custom_themes_dir()?)
}

#[tauri::command]
pub(crate) fn open_custom_themes_directory() -> Result<(), String> {
    let directory = custom_themes_dir()?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create custom themes directory: {error}"))?;
    super::management_api::open_directory_in_file_manager(&directory)
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
    fn theme_selection_preserves_ids_and_rejects_invalid_records() {
        let directory = std::env::temp_dir().join(format!(
            "ezcpa-theme-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("theme-selection.json");
        assert_eq!(read_selection(&path).unwrap(), None);
        for id in ["light", "dark", "system", "theme1-dark", "removed-theme"] {
            let selection = ThemeSelection {
                version: 1,
                selected_id: id.to_string(),
                last_light_id: None,
                last_dark_id: None,
            };
            write_selection(&path, &selection).unwrap();
            assert_eq!(read_selection(&path).unwrap(), Some(selection));
        }
        for data in [
            r#""dark""#,
            r#"{"version":2,"selectedId":"light"}"#,
            r#"{"version":1,"selectedId":"../bad"}"#,
            r#"{"version":1,"selectedId":"system","lastLightId":"../bad"}"#,
            r#"{"version":1,"selectedId":"system","lastDarkId":"system"}"#,
            "{",
        ] {
            std::fs::write(&path, data).unwrap();
            assert!(read_selection(&path).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), data);
        }
        let invalid = ThemeSelection {
            version: 1,
            selected_id: String::new(),
            last_light_id: None,
            last_dark_id: None,
        };
        assert!(write_selection(&path, &invalid).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn theme_selection_round_trips_history_and_accepts_missing_history() {
        for data in [
            r#"{"version":1,"selectedId":"rose-paper-light"}"#,
            r#"{"version":1,"selectedId":"system","lastLightId":"rose-paper-light"}"#,
            r#"{"version":1,"selectedId":"system","lastLightId":"rose-paper-light","lastDarkId":"pine-dark"}"#,
            r#"{"version":1,"selectedId":"system","lastDarkId":"removed-theme"}"#,
        ] {
            let selection: ThemeSelection = serde_json::from_str(data).unwrap();
            selection.validate().unwrap();
            let restored: ThemeSelection =
                serde_json::from_slice(&serde_json::to_vec(&selection).unwrap()).unwrap();
            assert_eq!(restored, selection);
        }
        for (light, dark) in [("system", "dark"), ("light", "../bad"), ("", "dark")] {
            let invalid = ThemeSelection {
                version: 1,
                selected_id: "system".to_string(),
                last_light_id: Some(light.to_string()),
                last_dark_id: Some(dark.to_string()),
            };
            assert!(invalid.validate().is_err());
        }
    }

    #[test]
    fn migrates_the_previous_theme_preference_until_a_selection_is_saved() {
        let directory = std::env::temp_dir().join(format!(
            "ezcpa-theme-legacy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let legacy = directory.join("theme-preference.json");
        assert_eq!(load_selection(&directory).unwrap(), None);
        for preference in ["light", "dark", "system"] {
            std::fs::write(&legacy, format!("\"{preference}\"")).unwrap();
            assert_eq!(
                load_selection(&directory).unwrap(),
                Some(ThemeSelection {
                    version: 1,
                    selected_id: preference.to_string(),
                    last_light_id: None,
                    last_dark_id: None,
                })
            );
        }
        for data in ["\"sepia\"", "{"] {
            std::fs::write(&legacy, data).unwrap();
            assert_eq!(load_selection(&directory).unwrap(), None);
        }
        std::fs::write(&legacy, b"\"dark\"").unwrap();
        let selection = ThemeSelection {
            version: 1,
            selected_id: "sakura-light".to_string(),
            last_light_id: None,
            last_dark_id: Some("graphite-dark".to_string()),
        };
        write_selection(&directory.join("theme-selection.json"), &selection).unwrap();
        assert_eq!(load_selection(&directory).unwrap(), Some(selection));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn lists_theme_folders_sorted_with_limits() {
        let directory = std::env::temp_dir().join(format!(
            "ezcpa-custom-themes-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert_eq!(
            list_theme_files(&directory).unwrap(),
            CustomThemeList::default()
        );
        std::fs::create_dir_all(directory.join("b")).unwrap();
        std::fs::write(directory.join("b/theme.json"), "{\"id\":\"b\"}").unwrap();
        std::fs::create_dir_all(directory.join("A")).unwrap();
        std::fs::write(directory.join("A/theme.json"), "{}").unwrap();
        std::fs::create_dir_all(directory.join("empty")).unwrap();
        std::fs::create_dir_all(directory.join("nested/themes")).unwrap();
        std::fs::write(directory.join("nested/themes/theme.json"), "{}").unwrap();
        std::fs::write(directory.join("stray.json"), "{}").unwrap();
        std::fs::write(directory.join("b/notes.txt"), "ignored").unwrap();
        std::fs::create_dir_all(directory.join("c-large")).unwrap();
        std::fs::write(
            directory.join("c-large/theme.json"),
            vec![b' '; CUSTOM_THEME_MAX_BYTES as usize + 1],
        )
        .unwrap();
        std::fs::create_dir_all(directory.join("d-binary")).unwrap();
        std::fs::write(directory.join("d-binary/theme.json"), [0xff, 0xfe]).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(directory.join("b"), directory.join("link-folder")).unwrap();
            std::fs::create_dir_all(directory.join("link-file")).unwrap();
            std::os::unix::fs::symlink(
                directory.join("b/theme.json"),
                directory.join("link-file/theme.json"),
            )
            .unwrap();
        }
        let list = list_theme_files(&directory).unwrap();
        assert_eq!(list.omitted, 0);
        assert_eq!(
            list.files,
            vec![
                CustomThemeFile {
                    folder: "A".to_string(),
                    content: Some("{}".to_string()),
                    backdrop_image: None,
                },
                CustomThemeFile {
                    folder: "b".to_string(),
                    content: Some("{\"id\":\"b\"}".to_string()),
                    backdrop_image: None,
                },
                CustomThemeFile {
                    folder: "c-large".to_string(),
                    content: None,
                    backdrop_image: None,
                },
                CustomThemeFile {
                    folder: "d-binary".to_string(),
                    content: None,
                    backdrop_image: None,
                },
            ]
        );
        std::fs::remove_dir_all(&directory).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        for index in (0..CUSTOM_THEME_LIMIT + 2).rev() {
            let folder = directory.join(format!("theme-{index:03}"));
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("theme.json"), "{}").unwrap();
        }
        let first = directory.join("0-first");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::write(first.join("theme.json"), "{}").unwrap();
        std::fs::write(directory.join("notes.txt"), "ignored").unwrap();
        let list = list_theme_files(&directory).unwrap();
        let mut expected = vec!["0-first".to_string()];
        expected.extend((0..CUSTOM_THEME_LIMIT - 1).map(|index| format!("theme-{index:03}")));
        assert_eq!(list.omitted, 3);
        assert_eq!(
            list.files
                .iter()
                .map(|file| file.folder.clone())
                .collect::<Vec<_>>(),
            expected
        );
        assert!(list.files.iter().all(|file| file.content.is_some()));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn custom_theme_backdrops_load_supported_images_and_preserve_invalid_themes() {
        use base64::Engine;

        let directory = std::env::temp_dir().join(format!(
            "ezcpa-theme-images-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let folder = directory.join("mountain");
        std::fs::create_dir_all(folder.join("assets")).unwrap();
        let theme =
            |asset: &str| serde_json::json!({ "assets": { "backdropImage": asset } }).to_string();
        for (name, bytes, mime) in [
            ("snow.png", b"\x89PNG\r\n\x1a\n".as_slice(), "image/png"),
            ("snow.jpg", &[0xff, 0xd8, 0xff], "image/jpeg"),
            ("snow.jpeg", &[0xff, 0xd8, 0xff], "image/jpeg"),
            ("snow.webp", b"RIFF\x04\0\0\0WEBP", "image/webp"),
            ("snow.avif", b"\0\0\0\x10ftypavif\0\0\0\0", "image/avif"),
        ] {
            std::fs::write(folder.join("assets").join(name), bytes).unwrap();
            let content = theme(&format!("assets/{name}"));
            std::fs::write(folder.join("theme.json"), &content).unwrap();
            let list = list_theme_files(&directory).unwrap();
            assert_eq!(list.files.len(), 1);
            assert_eq!(list.files[0].content.as_deref(), Some(content.as_str()));
            assert_eq!(
                list.files[0].backdrop_image,
                Some(format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ))
            );
            assert!(serde_json::to_value(&list.files[0]).unwrap()["backdropImage"].is_string());
        }
        std::fs::write(folder.join("assets/invalid.png"), "not an image").unwrap();
        std::fs::write(folder.join("assets/wrong.jpg"), b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(folder.join("assets/snow.svg"), "<svg/>").unwrap();
        std::fs::write(directory.join("outside.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        let oversized = std::fs::File::create(folder.join("assets/large.png")).unwrap();
        oversized.set_len(CUSTOM_THEME_IMAGE_MAX_BYTES + 1).unwrap();
        for asset in [
            "assets/missing.png",
            "assets/invalid.png",
            "assets/wrong.jpg",
            "assets/snow.svg",
            "assets/large.png",
            "../outside.png",
            "assets/../../outside.png",
            "assets\\snow.png",
            "/outside.png",
            "C:/outside.png",
            "",
        ] {
            let content = theme(asset);
            std::fs::write(folder.join("theme.json"), &content).unwrap();
            let list = list_theme_files(&directory).unwrap();
            assert_eq!(list.files.len(), 1);
            assert_eq!(list.files[0].content.as_deref(), Some(content.as_str()));
            assert_eq!(list.files[0].backdrop_image, None, "{asset}");
            assert!(serde_json::to_value(&list.files[0])
                .unwrap()
                .get("backdropImage")
                .is_none());
        }
        for content in ["{", "{}", r#"{"assets":{"backdropImage":1}}"#] {
            assert_eq!(read_backdrop_image(&folder, content), None);
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                directory.join("outside.png"),
                folder.join("assets/link.png"),
            )
            .unwrap();
            std::os::unix::fs::symlink(folder.join("assets"), folder.join("linked")).unwrap();
            for asset in ["assets/link.png", "linked/snow.png"] {
                assert_eq!(read_backdrop_image(&folder, &theme(asset)), None);
            }
        }
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
