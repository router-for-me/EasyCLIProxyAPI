//! Best-effort FreeDesktop integration for the Linux portable binary.
//!
//! Users extract a tarball and run the app; they should not need a separate
//! install script. On startup we silently refresh a user-level `.desktop`
//! entry whose `Icon=` points at an absolute path under `$XDG_DATA_HOME`.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

const DESKTOP_FILE_NAME: &str = "easycliproxyapi.desktop";
const ICON_FILE_NAME: &str = "easycliproxyapi.png";
/// Existing Tauri 256×256 asset (128@2x). Absolute Icon paths need only one size.
const EMBEDDED_ICON_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");

/// Refresh the user application menu entry so portable installs show the real
/// app icon instead of a generic settings fallback.
///
/// No-ops when the process is not a portable install (`portable-app.json`
/// missing next to the executable). Errors are returned for the caller to log;
/// startup must not fail because of desktop integration.
pub(crate) fn ensure_linux_desktop_integration() -> Result<(), String> {
    let current_exe = env::current_exe().map_err(|error| format!("读取当前程序路径失败: {error}"))?;
    let current_exe = fs::canonicalize(&current_exe).unwrap_or(current_exe);
    let app_dir = current_exe
        .parent()
        .ok_or_else(|| "无法解析程序目录".to_string())?;

    if !app_dir.join(super::PORTABLE_APP_MANIFEST_FILE).is_file() {
        return Ok(());
    }

    let data_home = xdg_data_home()?;
    let applications_dir = data_home.join("applications");
    let icon_path = data_home
        .join("icons")
        .join("hicolor")
        .join("256x256")
        .join("apps")
        .join(ICON_FILE_NAME);
    let desktop_path = applications_dir.join(DESKTOP_FILE_NAME);

    write_bytes_if_changed(&icon_path, EMBEDDED_ICON_PNG)?;
    let desktop = desktop_entry_contents(&current_exe, &icon_path);
    write_text_if_changed(&desktop_path, &desktop)?;

    // Refresh caches when available; ignore failures (headless CI, minimal DEs).
    let _ = std::process::Command::new("update-desktop-database")
        .arg(&applications_dir)
        .status();
    let icon_theme_root = data_home.join("icons").join("hicolor");
    let _ = std::process::Command::new("gtk-update-icon-cache")
        .args(["-f", "-t"])
        .arg(&icon_theme_root)
        .status();

    Ok(())
}

fn xdg_data_home() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("XDG_DATA_HOME") {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    let home = env::var_os("HOME").ok_or_else(|| "缺少 HOME 环境变量".to_string())?;
    Ok(PathBuf::from(home).join(".local").join("share"))
}

pub(crate) fn desktop_entry_contents(exec: &Path, icon: &Path) -> String {
    format!(
        "\
[Desktop Entry]
Type=Application
Version=1.0
Name=EasyCLIProxyAPI
Comment=CLIProxyAPI desktop management console
Exec={exec}
Icon={icon}
Terminal=false
Categories=Development;Network;
StartupNotify=true
StartupWMClass=EasyCLIProxyAPI
",
        exec = shell_escape_desktop_path(exec),
        icon = icon.display(),
    )
}

/// Paths in Desktop Entry files must be absolute; escape spaces for Exec.
fn shell_escape_desktop_path(path: &Path) -> String {
    let raw = path.display().to_string();
    if raw.chars().any(|c| c.is_whitespace()) {
        format!("\"{raw}\"")
    } else {
        raw
    }
}

fn write_bytes_if_changed(path: &Path, contents: &[u8]) -> Result<(), String> {
    if path.is_file() {
        if let Ok(existing) = fs::read(path) {
            if existing == contents {
                return Ok(());
            }
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败 {}: {error}", parent.display()))?;
    }
    fs::write(path, contents).map_err(|error| format!("写入 {} 失败: {error}", path.display()))
}

fn write_text_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    if path.is_file() {
        if let Ok(existing) = fs::read_to_string(path) {
            if existing == contents {
                return Ok(());
            }
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败 {}: {error}", parent.display()))?;
    }
    fs::write(path, contents).map_err(|error| format!("写入 {} 失败: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = env::temp_dir().join(format!("easycli-linux-desktop-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn desktop_entry_uses_absolute_icon_and_exec() {
        let exec = PathBuf::from("/opt/EasyCLIProxyAPI/EasyCLIProxyAPI");
        let icon = PathBuf::from(
            "/home/user/.local/share/icons/hicolor/256x256/apps/easycliproxyapi.png",
        );
        let contents = desktop_entry_contents(&exec, &icon);
        assert!(contents.contains("Exec=/opt/EasyCLIProxyAPI/EasyCLIProxyAPI\n"));
        assert!(contents.contains(
            "Icon=/home/user/.local/share/icons/hicolor/256x256/apps/easycliproxyapi.png\n"
        ));
        assert!(contents.contains("StartupWMClass=EasyCLIProxyAPI\n"));
        assert!(contents.contains("Name=EasyCLIProxyAPI\n"));
    }

    #[test]
    fn desktop_entry_quotes_exec_with_spaces() {
        let exec = PathBuf::from("/home/user/My Apps/EasyCLIProxyAPI");
        let icon = PathBuf::from("/tmp/icon.png");
        let contents = desktop_entry_contents(&exec, &icon);
        assert!(contents.contains("Exec=\"/home/user/My Apps/EasyCLIProxyAPI\"\n"));
    }

    #[test]
    fn write_helpers_are_idempotent() {
        let root = temp_dir("idempotent");
        let path = root.join("nested").join("icon.png");
        write_bytes_if_changed(&path, b"abc").unwrap();
        write_bytes_if_changed(&path, b"abc").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"abc");
        write_bytes_if_changed(&path, b"abcd").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"abcd");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn embedded_icon_is_non_empty_png() {
        assert!(EMBEDDED_ICON_PNG.len() > 100);
        assert_eq!(&EMBEDDED_ICON_PNG[..8], b"\x89PNG\r\n\x1a\n");
    }
}
