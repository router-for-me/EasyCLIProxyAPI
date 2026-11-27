//! Server-side filesystem browsing for the headless WebUI path picker.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseServerPathRequest {
    pub path: Option<String>,
    #[serde(default)]
    pub directories_only: bool,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub show_hidden: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPathEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseServerPathResult {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<ServerPathEntry>,
    pub roots: Vec<String>,
}

const MAX_BROWSE_ENTRIES: usize = 500;

fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    raw.into_owned()
}

fn default_roots() -> Vec<String> {
    let mut roots = Vec::new();
    if let Ok(home) = crate::runtime::resolve_home_dir() {
        roots.push(home.to_string_lossy().into_owned());
    }
    if let Ok(base) = crate::core_runtime::core_base_dir() {
        let s = base.to_string_lossy().into_owned();
        if !roots.contains(&s) {
            roots.push(s);
        }
    }
    #[cfg(unix)]
    {
        for p in ["/", "/etc", "/opt", "/var"] {
            if Path::new(p).is_dir() && !roots.iter().any(|r| r == p) {
                roots.push(p.to_string());
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
        // Avoid probing disconnected network/optical drives (`is_dir()` can block for 30s+).
        const DRIVE_FIXED: u32 = 3;
        let mask = unsafe { GetLogicalDrives() };
        for i in 0..26u32 {
            if (mask & (1 << i)) == 0 {
                continue;
            }
            let drive = format!("{}:\\", (b'A' + i as u8) as char);
            let wide: Vec<u16> = std::ffi::OsStr::new(&drive)
                .encode_wide()
                .chain(Some(0))
                .collect();
            if unsafe { GetDriveTypeW(wide.as_ptr()) } == DRIVE_FIXED
                && !roots.iter().any(|r| r.eq_ignore_ascii_case(&drive))
            {
                roots.push(drive);
            }
        }
    }
    roots
}

fn expand_start_path(raw: Option<&str>) -> Result<PathBuf, String> {
    let trimmed = raw.map(str::trim).filter(|s| !s.is_empty());
    let candidate = match trimmed {
        None => crate::runtime::resolve_home_dir()
            .or_else(|_| crate::core_runtime::core_base_dir())?,
        Some("~") => crate::runtime::resolve_home_dir()?,
        Some(path) if path.starts_with("~/") || path.starts_with("~\\") => {
            crate::runtime::resolve_home_dir()?.join(&path[2..])
        }
        Some(path) => PathBuf::from(path),
    };

    if candidate.is_file() {
        if let Some(parent) = candidate.parent() {
            return Ok(parent.to_path_buf());
        }
    }
    if candidate.is_dir() {
        return Ok(candidate);
    }
    // Walk upward to nearest existing parent so typing a partial/new path still opens cleanly.
    let mut cursor = candidate.as_path();
    while let Some(parent) = cursor.parent() {
        if parent.is_dir() {
            return Ok(parent.to_path_buf());
        }
        cursor = parent;
    }
    crate::runtime::resolve_home_dir().or_else(|_| crate::core_runtime::core_base_dir())
}

fn extension_matches(path: &Path, normalized_exts: &[String]) -> bool {
    if normalized_exts.is_empty() {
        return true;
    }
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim_start_matches('.').to_ascii_lowercase())
        .is_some_and(|ext| normalized_exts.iter().any(|allowed| allowed == &ext))
}

#[ecpa_macros::ecpa_command]
pub fn browse_server_path(
    path: Option<String>,
    directories_only: Option<bool>,
    extensions: Option<Vec<String>>,
    show_hidden: Option<bool>,
) -> Result<BrowseServerPathResult, String> {
    browse_server_path_inner(BrowseServerPathRequest {
        path,
        directories_only: directories_only.unwrap_or(false),
        extensions: extensions.unwrap_or_default(),
        show_hidden: show_hidden.unwrap_or(true),
    })
}

pub fn browse_server_path_inner(
    req: BrowseServerPathRequest,
) -> Result<BrowseServerPathResult, String> {
    let dir = expand_start_path(req.path.as_deref())?;
    let current = fs::canonicalize(&dir).unwrap_or(dir);
    let parent_path = current
        .parent()
        .filter(|p| *p != current.as_path())
        .map(display_path);

    let normalized_exts: Vec<String> = req
        .extensions
        .iter()
        .map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
        .collect();

    let read_dir = fs::read_dir(&current).map_err(|error| {
        format!(
            "Failed to list directory {}: {error}",
            display_path(&current)
        )
    })?;

    let mut entries = Vec::new();
    for entry_res in read_dir {
        let Ok(entry) = entry_res else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !req.show_hidden && name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let is_dir = metadata.is_dir();
        if req.directories_only && !is_dir {
            continue;
        }
        if !is_dir && !extension_matches(&path, &normalized_exts) {
            continue;
        }
        entries.push(ServerPathEntry {
            name,
            path: display_path(&path),
            is_dir,
            size: (!is_dir).then_some(metadata.len()),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    entries.truncate(MAX_BROWSE_ENTRIES);

    Ok(BrowseServerPathResult {
        current_path: display_path(&current),
        parent_path,
        entries,
        roots: default_roots(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browse_server_path_lists_directories_before_files_and_filters_extensions() {
        let root = crate::unique_test_temp_path("ecpa-browse-test");
        fs::create_dir_all(root.join("sub_dir")).unwrap();
        fs::write(root.join("cert.pem"), "pem").unwrap();
        fs::write(root.join("notes.txt"), "txt").unwrap();

        let all = browse_server_path(
            Some(root.to_string_lossy().into_owned()),
            Some(false),
            Some(vec!["pem".to_string()]),
            Some(true),
        )
        .unwrap();

        assert!(!all.current_path.starts_with(r"\\?\"));
        assert_eq!(all.entries.len(), 2);
        assert!(all.entries[0].is_dir);
        assert_eq!(all.entries[0].name, "sub_dir");
        assert!(!all.entries[1].is_dir);
        assert_eq!(all.entries[1].name, "cert.pem");

        let dirs = browse_server_path(
            Some(root.to_string_lossy().into_owned()),
            Some(true),
            Some(vec![]),
            Some(true),
        )
        .unwrap();
        assert_eq!(dirs.entries.len(), 1);
        assert_eq!(dirs.entries[0].name, "sub_dir");

        let _ = fs::remove_dir_all(&root);
    }
}
