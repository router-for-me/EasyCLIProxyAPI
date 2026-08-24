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
            "创建当前目录的软件实例锁失败: {}",
            std::io::Error::last_os_error()
        ));
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle) };
        return Err("当前 EasyCLIProxyAPI 目录已经有一个软件实例在运行".to_string());
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
        .map_err(|error| format!("打开当前目录的软件实例锁失败: {error}"))?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        let raw_error = error.raw_os_error();
        if raw_error == Some(libc::EWOULDBLOCK) || raw_error == Some(libc::EAGAIN) {
            return Err("当前 EasyCLIProxyAPI 目录已经有一个软件实例在运行".to_string());
        }
        return Err(format!("锁定当前 EasyCLIProxyAPI 目录失败: {error}"));
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
