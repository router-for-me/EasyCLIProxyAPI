use sha2::{Digest, Sha256};
use std::{fs, path::Path};

const APP_INSTANCE_LOCK_PREFIX: &str = "EasyCLIProxyAPI-instance";

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
fn app_instance_lock_path(executable_dir: &Path) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "{APP_INSTANCE_LOCK_PREFIX}-{}.lock",
        app_instance_key(executable_dir)
    ))
}

#[cfg(unix)]
pub(crate) fn acquire_app_instance_guard_for(
    executable_dir: &Path,
) -> Result<AppInstanceGuard, String> {
    use std::{fs::OpenOptions, os::fd::AsRawFd};

    let lock_path = app_instance_lock_path(executable_dir);
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

// Launching the app again from the menu or a shortcut only finds the lock above.
// Linux has no Dock reopen event, so the running copy listens on a socket next to
// its lock and shows the main window when a later launch asks it to.
#[cfg(target_os = "linux")]
const APP_ACTIVATION_REQUEST: &[u8] = b"show\n";
#[cfg(target_os = "linux")]
const APP_ACTIVATION_CONNECT_ATTEMPTS: u32 = 10;

#[cfg(target_os = "linux")]
pub(crate) fn app_activation_socket_path(executable_dir: &Path) -> std::path::PathBuf {
    app_instance_lock_path(executable_dir).with_extension("sock")
}

#[cfg(target_os = "linux")]
pub(crate) fn start_app_activation_listener<F>(on_activate: F) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    let executable_dir = super::executable_dir()?;
    start_app_activation_listener_for(&executable_dir, on_activate)
}

#[cfg(target_os = "linux")]
pub(crate) fn start_app_activation_listener_for<F>(
    executable_dir: &Path,
    on_activate: F,
) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    use std::{
        io::Read,
        os::unix::{fs::PermissionsExt, net::UnixListener},
    };

    let socket_path = app_activation_socket_path(executable_dir);
    // Only the lock holder gets here, so a socket left on disk belongs to a copy that has exited.
    match fs::remove_file(&socket_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to remove the stale application activation socket: {error}"
            ))
        }
    }
    let listener = UnixListener::bind(&socket_path).map_err(|error| {
        format!("Failed to listen for application activation requests: {error}")
    })?;
    if let Err(error) = fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600)) {
        eprintln!("Failed to restrict the application activation socket: {error}");
    }

    std::thread::Builder::new()
        .name("app-activation".to_string())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    continue;
                };
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(1)));
                let mut request = Vec::new();
                if stream
                    .take(APP_ACTIVATION_REQUEST.len() as u64 + 1)
                    .read_to_end(&mut request)
                    .is_ok()
                    && request == APP_ACTIVATION_REQUEST
                {
                    on_activate();
                }
            }
        })
        .map_err(|error| format!("Failed to start the application activation listener: {error}"))?;
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn request_running_app_activation() -> bool {
    super::executable_dir().is_ok_and(|executable_dir| {
        request_running_app_activation_for(&executable_dir, APP_ACTIVATION_CONNECT_ATTEMPTS)
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn request_running_app_activation_for(executable_dir: &Path, attempts: u32) -> bool {
    use std::{io::Write, os::unix::net::UnixStream};

    let socket_path = app_activation_socket_path(executable_dir);
    for attempt in 1..=attempts {
        match UnixStream::connect(&socket_path) {
            Ok(mut stream) => return stream.write_all(APP_ACTIVATION_REQUEST).is_ok(),
            // The running copy starts listening during setup; a launch made while it is
            // still starting can briefly find no listener.
            Err(_) if attempt < attempts => {
                std::thread::sleep(std::time::Duration::from_millis(200))
            }
            Err(_) => {}
        }
    }
    false
}

#[cfg(windows)]
impl Drop for AppInstanceGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

        unsafe { CloseHandle(self.handle as HANDLE) };
    }
}
