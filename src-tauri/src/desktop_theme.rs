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

fn valid_theme_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

impl ThemeSelection {
    fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || !valid_theme_id(&self.selected_id)
            || [self.last_light_id.as_deref(), self.last_dark_id.as_deref()]
                .into_iter()
                .flatten()
                .any(|id| id == "system" || !valid_theme_id(id))
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
const CUSTOM_THEME_IMPORT_MAX_BYTES: u64 = 20 * 1024 * 1024;
const CUSTOM_THEME_IMPORT_MAX_FILES: usize = 128;
const CUSTOM_THEME_IMPORT_MAX_ENTRIES: usize = 256;
const CUSTOM_THEME_IMPORT_MAX_DEPTH: usize = 8;
const BUILTIN_THEME_IDS: &[&str] = &[
    "light",
    "dark",
    "warm-sand-light",
    "graphite-dark",
    "midnight-dark",
    "sakura-light",
    "anime-light",
];

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCustomThemeResult {
    imported_ids: Vec<String>,
    existing_ids: Vec<String>,
}

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

struct ImportStagingDir(std::path::PathBuf);

impl ImportStagingDir {
    fn new(parent: &std::path::Path) -> Result<Self, String> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = parent.join(format!(".import-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).map_err(|_| "import-failed".to_string())?;
        Ok(Self(path))
    }
}

impl Drop for ImportStagingDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct ImportBudget {
    bytes: u64,
    files: usize,
}

impl ImportBudget {
    fn copy_reader<R: std::io::Read>(
        &mut self,
        reader: R,
        dest: &std::path::Path,
    ) -> Result<(), String> {
        if self.files >= CUSTOM_THEME_IMPORT_MAX_FILES {
            return Err("too-large".to_string());
        }
        self.files += 1;
        let remaining = CUSTOM_THEME_IMPORT_MAX_BYTES.saturating_sub(self.bytes);
        let mut output = std::fs::File::create(dest).map_err(|_| "import-failed".to_string())?;
        let written = std::io::copy(&mut reader.take(remaining + 1), &mut output)
            .map_err(|_| "import-failed".to_string())?;
        if written > remaining {
            return Err("too-large".to_string());
        }
        self.bytes += written;
        Ok(())
    }
}

fn is_ignored_import_name(name: &std::ffi::OsStr) -> bool {
    name == "__MACOSX" || name == ".DS_Store"
}

fn extract_theme_zip(
    archive_path: &std::path::Path,
    staging: &std::path::Path,
    budget: &mut ImportBudget,
) -> Result<(), String> {
    use std::path::Component;
    let file = std::fs::File::open(archive_path).map_err(|_| "not-found".to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|_| "unsupported-format".to_string())?;
    if archive.len() > CUSTOM_THEME_IMPORT_MAX_ENTRIES {
        return Err("too-large".to_string());
    }
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "unsupported-format".to_string())?;
        if super::core_runtime::is_zip_symlink(&entry) {
            return Err("unsafe-archive".to_string());
        }
        let Some(rel_path) = entry.enclosed_name() else {
            return Err("unsafe-archive".to_string());
        };
        if rel_path.as_os_str().is_empty()
            || rel_path.components().any(|component| {
                matches!(component, Component::Normal(name) if is_ignored_import_name(name))
            })
        {
            continue;
        }
        if rel_path.components().count() > CUSTOM_THEME_IMPORT_MAX_DEPTH {
            return Err("too-large".to_string());
        }
        let dest = staging.join(&rel_path);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|_| "import-failed".to_string())?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|_| "import-failed".to_string())?;
            }
            budget.copy_reader(entry, &dest)?;
        }
    }
    Ok(())
}

fn copy_theme_dir(
    src: &std::path::Path,
    dst: &std::path::Path,
    depth: usize,
    budget: &mut ImportBudget,
) -> Result<(), String> {
    if depth > CUSTOM_THEME_IMPORT_MAX_DEPTH {
        return Err("too-large".to_string());
    }
    std::fs::create_dir_all(dst).map_err(|_| "import-failed".to_string())?;
    let entries = std::fs::read_dir(src).map_err(|_| "import-failed".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "import-failed".to_string())?;
        let name = entry.file_name();
        if is_ignored_import_name(&name) {
            continue;
        }
        let path = entry.path();
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|_| "import-failed".to_string())?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let dest = dst.join(&name);
        if metadata.is_dir() {
            copy_theme_dir(&path, &dest, depth + 1, budget)?;
        } else if metadata.is_file() {
            let file = std::fs::File::open(&path).map_err(|_| "import-failed".to_string())?;
            budget.copy_reader(file, &dest)?;
        }
    }
    Ok(())
}

fn collect_theme_roots(dir: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    if theme_file_in(dir).is_some() {
        return Ok(vec![dir.to_path_buf()]);
    }
    let entries = std::fs::read_dir(dir).map_err(|_| "import-failed".to_string())?;
    let mut roots = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let name = entry.file_name();
        if is_ignored_import_name(&name) || name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if theme_file_in(&path).is_some() {
            roots.push(path);
        }
    }
    roots.sort();
    if roots.is_empty() {
        return Err("no-theme-found".to_string());
    }
    if roots.len() > CUSTOM_THEME_LIMIT {
        return Err("too-large".to_string());
    }
    Ok(roots)
}

const ALLOWED_THEME_KEYS: &[&str] = &[
    "$schema",
    "schemaVersion",
    "id",
    "name",
    "description",
    "appearance",
    "windowBackground",
    "windowMaterial",
    "icon",
    "assets",
    "tokens",
    "backdrop",
];
const THEME_LABEL_LOCALES: &[&str] = &["zh-CN", "zh-TW", "ja", "en", "ru"];

fn is_valid_theme_label(value: &serde_json::Value) -> bool {
    let valid_text = |text: &str| !text.trim().is_empty() && text.chars().count() <= 80;
    match value {
        serde_json::Value::String(text) => valid_text(text),
        serde_json::Value::Object(map) => {
            !map.is_empty()
                && map.iter().all(|(locale, entry)| {
                    THEME_LABEL_LOCALES.contains(&locale.as_str())
                        && entry.as_str().is_some_and(valid_text)
                })
        }
        _ => false,
    }
}

fn validate_theme_manifest(folder: &std::path::Path) -> Result<String, String> {
    let Some(content) = read_custom_theme(&folder.join("theme.json")) else {
        return Err("invalid-theme".to_string());
    };
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|_| "invalid-theme".to_string())?;
    let Some(object) = value.as_object() else {
        return Err("invalid-theme".to_string());
    };
    if object
        .keys()
        .any(|key| !ALLOWED_THEME_KEYS.contains(&key.as_str()))
    {
        return Err("invalid-theme".to_string());
    }
    if let Some(schema) = object.get("$schema") {
        if !schema.is_string() {
            return Err("invalid-theme".to_string());
        }
    }
    if let Some(version) = object.get("schemaVersion") {
        if version.as_u64() != Some(1) {
            return Err("invalid-theme".to_string());
        }
    }
    if let Some(material) = object.get("windowMaterial") {
        if !matches!(material.as_str(), Some("solid" | "translucent")) {
            return Err("invalid-theme".to_string());
        }
    }
    let Some(id) = object.get("id").and_then(|v| v.as_str()) else {
        return Err("invalid-theme".to_string());
    };
    if !valid_theme_id(id) || id == "system" {
        return Err("invalid-theme".to_string());
    }
    if BUILTIN_THEME_IDS.contains(&id) {
        return Err("duplicate-id".to_string());
    }
    let valid_name = object.get("name").is_some_and(is_valid_theme_label);
    let valid_description = object
        .get("description")
        .is_none_or(is_valid_theme_label);
    let valid_appearance = matches!(
        object.get("appearance").and_then(|v| v.as_str()),
        Some("light" | "dark")
    );
    let valid_background = object
        .get("windowBackground")
        .and_then(|v| v.as_str())
        .is_some_and(|bg| {
            let bytes = bg.as_bytes();
            bytes.len() == 7
                && bytes[0] == b'#'
                && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
        });
    let valid_tokens = object.get("tokens").is_some_and(|v| v.is_object());
    let valid_backdrop = object.get("backdrop").is_none_or(|v| v.is_object());
    if !valid_name
        || !valid_description
        || !valid_appearance
        || !valid_background
        || !valid_tokens
        || !valid_backdrop
    {
        return Err("invalid-theme".to_string());
    }
    Ok(id.to_string())
}

fn import_theme_from_path(
    source: &std::path::Path,
    themes_dir: &std::path::Path,
    overwrite: bool,
) -> Result<ImportCustomThemeResult, String> {
    let metadata = std::fs::metadata(source).map_err(|_| "not-found".to_string())?;
    std::fs::create_dir_all(themes_dir).map_err(|_| "import-failed".to_string())?;
    let staging = ImportStagingDir::new(themes_dir)?;
    let mut budget = ImportBudget::default();
    let mut seen = std::collections::HashSet::new();
    let mut prepared: Vec<(String, Option<std::path::PathBuf>)> = Vec::new();

    if metadata.is_file() {
        let is_zip = source
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
        if !is_zip {
            return Err("unsupported-format".to_string());
        }
        if metadata.len() > CUSTOM_THEME_IMPORT_MAX_BYTES {
            return Err("too-large".to_string());
        }
        let extract_dir = staging.0.join("extract");
        std::fs::create_dir_all(&extract_dir).map_err(|_| "import-failed".to_string())?;
        extract_theme_zip(source, &extract_dir, &mut budget)?;
        for root in collect_theme_roots(&extract_dir)? {
            let id = validate_theme_manifest(&root)?;
            if !seen.insert(id.clone()) {
                return Err("invalid-theme".to_string());
            }
            prepared.push((id, Some(root)));
        }
    } else if metadata.is_dir() {
        let ready_dir = staging.0.join("ready");
        for root in collect_theme_roots(source)? {
            let id = validate_theme_manifest(&root)?;
            if !seen.insert(id.clone()) {
                return Err("invalid-theme".to_string());
            }
            let target = themes_dir.join(&id);
            let same_folder = target.exists()
                && std::fs::canonicalize(&root).ok() == std::fs::canonicalize(&target).ok();
            if same_folder {
                prepared.push((id, None));
            } else {
                let staged = ready_dir.join(&id);
                copy_theme_dir(&root, &staged, 0, &mut budget)?;
                prepared.push((id, Some(staged)));
            }
        }
    } else {
        return Err("unsupported-format".to_string());
    }

    if !overwrite {
        let existing_ids: Vec<String> = prepared
            .iter()
            .filter_map(|(id, staged)| (staged.is_some() && themes_dir.join(id).exists()).then(|| id.clone()))
            .collect();
        if !existing_ids.is_empty() {
            return Ok(ImportCustomThemeResult {
                imported_ids: Vec::new(),
                existing_ids,
            });
        }
    }

    let mut imported_ids = Vec::with_capacity(prepared.len());
    for (id, staged) in prepared {
        if let Some(staged_path) = staged {
            let target = themes_dir.join(&id);
            if target.exists() {
                let backup = staging.0.join(format!("backup-{id}"));
                std::fs::rename(&target, &backup).map_err(|_| "import-failed".to_string())?;
                if std::fs::rename(&staged_path, &target).is_err() {
                    let _ = std::fs::rename(&backup, &target);
                    return Err("import-failed".to_string());
                }
            } else {
                std::fs::rename(&staged_path, &target).map_err(|_| "import-failed".to_string())?;
            }
        }
        imported_ids.push(id);
    }

    Ok(ImportCustomThemeResult {
        imported_ids,
        existing_ids: Vec::new(),
    })
}

#[tauri::command]
pub(crate) async fn import_custom_theme(
    path: String,
    overwrite: Option<bool>,
) -> Result<ImportCustomThemeResult, String> {
    let themes_dir = custom_themes_dir()?;
    let overwrite = overwrite.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        import_theme_from_path(std::path::Path::new(&path), &themes_dir, overwrite)
    })
    .await
    .map_err(|_| "import-failed".to_string())?
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

    fn write_test_zip(path: &std::path::Path, entries: &[(&str, &[u8], Option<u32>)]) {
        use std::io::Write;
        let file = std::fs::File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        for (name, bytes, mode) in entries {
            let mut options = zip::write::SimpleFileOptions::default();
            if let Some(unix_mode) = mode {
                options = options.unix_permissions(*unix_mode);
            }
            if name.ends_with('/') {
                archive.add_directory(*name, options).unwrap();
            } else {
                archive.start_file(*name, options).unwrap();
                archive.write_all(bytes).unwrap();
            }
        }
        archive.finish().unwrap();
    }

    fn sample_theme_json(id: &str, name: &str) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "id": id,
            "name": name,
            "appearance": "dark",
            "windowBackground": "#0E1A1F",
            "assets": { "backdropImage": "assets/bg.png" },
            "tokens": { "accent": "#6FD3C1" }
        })
        .to_string()
    }

    #[test]
    fn imports_theme_from_folder_and_handles_reimport_and_self_import() {
        let root = std::env::temp_dir().join(format!(
            "ezcpa-theme-import-dir-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let themes_dir = root.join("themes");
        let source = root.join("custom-folder");
        std::fs::create_dir_all(source.join("assets")).unwrap();
        std::fs::write(source.join("theme.json"), sample_theme_json("ocean-dark", "Ocean")).unwrap();
        std::fs::write(source.join("assets/bg.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(source.join(".DS_Store"), b"junk").unwrap();

        let result = import_theme_from_path(&source, &themes_dir, false).unwrap();
        assert_eq!(result.imported_ids, vec!["ocean-dark"]);
        assert!(result.existing_ids.is_empty());
        assert!(!themes_dir.join("ocean-dark/.DS_Store").exists());
        let list = list_theme_files(&themes_dir).unwrap();
        assert_eq!(list.files.len(), 1);
        assert_eq!(list.files[0].folder, "ocean-dark");
        assert!(list.files[0].backdrop_image.is_some());

        std::fs::write(source.join("theme.json"), sample_theme_json("ocean-dark", "Ocean v2")).unwrap();
        let needs_confirm = import_theme_from_path(&source, &themes_dir, false).unwrap();
        assert!(needs_confirm.imported_ids.is_empty());
        assert_eq!(needs_confirm.existing_ids, vec!["ocean-dark"]);
        assert!(!std::fs::read_to_string(themes_dir.join("ocean-dark/theme.json"))
            .unwrap()
            .contains("Ocean v2"));

        let updated = import_theme_from_path(&source, &themes_dir, true).unwrap();
        assert_eq!(updated.imported_ids, vec!["ocean-dark"]);
        assert!(updated.existing_ids.is_empty());
        assert!(std::fs::read_to_string(themes_dir.join("ocean-dark/theme.json"))
            .unwrap()
            .contains("Ocean v2"));

        std::fs::write(
            source.join("theme.json"),
            r##"{"schemaVersion":1,"id":"ocean-dark","name":{"en":42},"appearance":"dark","windowBackground":"#0E1A1F","tokens":{}}"##,
        )
        .unwrap();
        assert_eq!(
            import_theme_from_path(&source, &themes_dir, true).unwrap_err(),
            "invalid-theme"
        );
        assert!(std::fs::read_to_string(themes_dir.join("ocean-dark/theme.json"))
            .unwrap()
            .contains("Ocean v2"));

        let same = import_theme_from_path(&themes_dir.join("ocean-dark"), &themes_dir, false).unwrap();
        assert_eq!(same.imported_ids, vec!["ocean-dark"]);
        assert!(same.existing_ids.is_empty());
        assert!(themes_dir.join("ocean-dark/theme.json").exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_theme_from_zip_variants_and_rejects_invalid_or_unsafe_sources() {
        let root = std::env::temp_dir().join(format!(
            "ezcpa-theme-import-zip-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let themes_dir = root.join("themes");
        std::fs::create_dir_all(&root).unwrap();

        let wrapped_zip = root.join("wrapped.zip");
        write_test_zip(
            &wrapped_zip,
            &[
                ("__MACOSX/._my-theme", b"meta", None),
                ("my-theme/theme.json", sample_theme_json("forest-dark", "Forest").as_bytes(), None),
                ("my-theme/assets/bg.png", b"\x89PNG\r\n\x1a\n", None),
                ("my-theme/.DS_Store", b"junk", None),
            ],
        );
        let result = import_theme_from_path(&wrapped_zip, &themes_dir, false).unwrap();
        assert_eq!(result.imported_ids, vec!["forest-dark"]);
        assert!(themes_dir.join("forest-dark/assets/bg.png").exists());
        assert!(!themes_dir.join("forest-dark/.DS_Store").exists());

        let flat_zip = root.join("flat.zip");
        write_test_zip(
            &flat_zip,
            &[("theme.json", sample_theme_json("amber-light", "Amber").as_bytes(), None)],
        );
        let result = import_theme_from_path(&flat_zip, &themes_dir, false).unwrap();
        assert_eq!(result.imported_ids, vec!["amber-light"]);

        let multi_zip = root.join("pack.zip");
        write_test_zip(
            &multi_zip,
            &[
                ("a/theme.json", sample_theme_json("pack-one", "One").as_bytes(), None),
                ("b/theme.json", sample_theme_json("pack-two", "Two").as_bytes(), None),
            ],
        );
        let result = import_theme_from_path(&multi_zip, &themes_dir, false).unwrap();
        assert_eq!(result.imported_ids, vec!["pack-one", "pack-two"]);

        assert_eq!(
            import_theme_from_path(&root.join("missing.zip"), &themes_dir, false).unwrap_err(),
            "not-found"
        );

        let txt = root.join("theme.txt");
        std::fs::write(&txt, "plain").unwrap();
        assert_eq!(
            import_theme_from_path(&txt, &themes_dir, false).unwrap_err(),
            "unsupported-format"
        );

        let empty_zip = root.join("empty.zip");
        write_test_zip(&empty_zip, &[("readme.txt", b"hello", None)]);
        assert_eq!(
            import_theme_from_path(&empty_zip, &themes_dir, false).unwrap_err(),
            "no-theme-found"
        );

        let invalid_zip = root.join("invalid.zip");
        write_test_zip(&invalid_zip, &[("theme.json", br#"{"id":"Bad_ID"}"#, None)]);
        assert_eq!(
            import_theme_from_path(&invalid_zip, &themes_dir, false).unwrap_err(),
            "invalid-theme"
        );

        let builtin_zip = root.join("builtin.zip");
        write_test_zip(
            &builtin_zip,
            &[("theme.json", sample_theme_json("dark", "Dark").as_bytes(), None)],
        );
        assert_eq!(
            import_theme_from_path(&builtin_zip, &themes_dir, false).unwrap_err(),
            "duplicate-id"
        );

        let bad_bg_zip = root.join("bad-bg.zip");
        write_test_zip(
            &bad_bg_zip,
            &[(
                "theme.json",
                br#"{"schemaVersion":1,"id":"bad-bg","name":"Bad","appearance":"dark","windowBackground":"red","tokens":{}}"#,
                None,
            )],
        );
        assert_eq!(
            import_theme_from_path(&bad_bg_zip, &themes_dir, false).unwrap_err(),
            "invalid-theme"
        );

        let traversal_zip = root.join("traversal.zip");
        write_test_zip(&traversal_zip, &[("../escape.txt", b"bad", None)]);
        assert_eq!(
            import_theme_from_path(&traversal_zip, &themes_dir, false).unwrap_err(),
            "unsafe-archive"
        );

        let symlink_zip = root.join("symlink.zip");
        {
            let file = std::fs::File::create(&symlink_zip).unwrap();
            let mut archive = zip::ZipWriter::new(file);
            archive
                .add_symlink(
                    "link",
                    "/etc/passwd",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            archive.finish().unwrap();
        }
        assert_eq!(
            import_theme_from_path(&symlink_zip, &themes_dir, false).unwrap_err(),
            "unsafe-archive"
        );

        let staging_leftovers: Vec<_> = std::fs::read_dir(&themes_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".import-"))
            .collect();
        assert!(staging_leftovers.is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }
}
