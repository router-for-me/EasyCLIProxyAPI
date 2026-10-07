use sha2::{Digest, Sha256};
use std::{fs, path::Path};

const APP_INSTANCE_LOCK_PREFIX: &str = "EasyCLIProxyAPI-instance";

#[cfg(windows)]
fn reopen_event_name(directory: &Path) -> Vec<u16> {
    format!("Local\\EasyCLIProxyAPI-reopen-{}", app_instance_key(directory))
        .encode_utf16().chain(Some(0)).collect()
}

#[cfg(windows)]
pub(crate) fn notify_existing_app(directory: &Path) -> bool {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE}};
    let name = reopen_event_name(directory);
    // The first instance may still be constructing its window: wait up to 10s (slow
    // disk, antivirus scan on a cold launch) before giving up on bringing it forward.
    for _ in 0..100 {
        let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
        if !event.is_null() {
            let sent = unsafe { SetEvent(event) } != 0;
            unsafe { CloseHandle(event) };
            return sent;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

#[cfg(windows)]
pub(crate) fn listen_for_app_reopen(app: &tauri::AppHandle) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::{CloseHandle, WAIT_OBJECT_0}, System::Threading::{CreateEventW, WaitForSingleObject, INFINITE}};
    let name = reopen_event_name(&super::executable_dir()?);
    let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
    if event.is_null() { return Err(format!("Could not create app reopen signal: {}", std::io::Error::last_os_error())); }
    let event = event as usize;
    let app = app.clone();
    std::thread::spawn(move || {
        let event = event as windows_sys::Win32::Foundation::HANDLE;
        while unsafe { WaitForSingleObject(event, INFINITE) } == WAIT_OBJECT_0 {
            let target = app.clone();
            if app.run_on_main_thread(move || super::show_windows_main_window(&target)).is_err() { break; }
        }
        unsafe { CloseHandle(event) };
    });
    Ok(())
}

pub(crate) struct AppInstanceGuard {
    #[cfg(windows)]
    handle: isize,
    #[cfg(unix)]
    _file: fs::File,
}

pub(crate) fn acquire_app_instance_guard() -> Result<AppInstanceGuard, String> {
    let executable_dir = super::executable_dir()?;
    acquire_app_instance_guard_for(&executable_dir)
}

pub(crate) fn app_instance_key(executable_dir: &Path) -> String {
    let resolved = fs::canonicalize(executable_dir)
        .unwrap_or_else(|_| executable_dir.to_path_buf())
        .to_string_lossy()
        .to_string();
    #[cfg(windows)]
    let resolved = resolved.to_lowercase();
    let digest = Sha256::digest(resolved.as_bytes());
    format!("{digest:x}")
}

#[cfg(windows)]
pub(crate) fn acquire_app_instance_guard_for(
    executable_dir: &Path,
) -> Result<AppInstanceGuard, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS},
        System::Threading::CreateMutexW,
    };

    let name = format!(
        "Local\\{APP_INSTANCE_LOCK_PREFIX}-{}",
        app_instance_key(executable_dir)
    );
    let wide_name = std::ffi::OsStr::new(&name)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide_name.as_ptr()) };
    if handle.is_null() {
        return Err(format!(
            "Failed to create application instance lock for the current directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle) };
        return Err("An application instance is already running in the current EasyCLIProxyAPI directory".to_string());
    }

    Ok(AppInstanceGuard {
        handle: handle as isize,
    })
}

#[cfg(unix)]
pub(crate) fn acquire_app_instance_guard_for(
    executable_dir: &Path,
) -> Result<AppInstanceGuard, String> {
    use std::{fs::OpenOptions, os::fd::AsRawFd};

    let lock_path = std::env::temp_dir().join(format!(
        "{APP_INSTANCE_LOCK_PREFIX}-{}.lock",
        app_instance_key(executable_dir)
    ));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
        .map_err(|error| format!("Failed to open application instance lock for the current directory: {error}"))?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        let raw_error = error.raw_os_error();
        if raw_error == Some(libc::EWOULDBLOCK) || raw_error == Some(libc::EAGAIN) {
            return Err("An application instance is already running in the current EasyCLIProxyAPI directory".to_string());
        }
        return Err(format!("Failed to lock the current EasyCLIProxyAPI directory: {error}"));
    }

    Ok(AppInstanceGuard { _file: file })
}

#[cfg(windows)]
impl Drop for AppInstanceGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

        unsafe { CloseHandle(self.handle as HANDLE) };
    }
}

#[cfg(all(test, windows))]
mod reopen_tests {
    use super::*;
    #[test]
    fn reopen_signal_targets_only_its_installation_and_resets() {
        use windows_sys::Win32::{Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT}, System::Threading::{CreateEventW, WaitForSingleObject}};
        let root = std::env::temp_dir().join(format!("reopen-test-{}", std::process::id()));
        let other = root.join("other");
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, reopen_event_name(&root).as_ptr()) };
        let other_event = unsafe { CreateEventW(std::ptr::null(), 0, 0, reopen_event_name(&other).as_ptr()) };
        assert!(!event.is_null() && !other_event.is_null());
        assert!(notify_existing_app(&root));
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_OBJECT_0);
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_TIMEOUT);
        assert_eq!(unsafe { WaitForSingleObject(other_event, 0) }, WAIT_TIMEOUT);
        unsafe { CloseHandle(event); CloseHandle(other_event); }
    }
}
