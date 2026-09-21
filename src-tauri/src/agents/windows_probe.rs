use super::*;
use windows_sys::Win32::{
    Foundation::{ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
    System::{
        Environment::ExpandEnvironmentStringsW,
        Registry::{
            RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
            HKEY_LOCAL_MACHINE, KEY_READ, REG_EXPAND_SZ, REG_SZ,
        },
    },
};

const CURRENT_VERSION: &str = r"Software\Microsoft\Windows\CurrentVersion";
const CURRENT_VERSION_WOW: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion";
const APPX_PACKAGES: &str = r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";

#[derive(Clone, Copy)]
struct RegistryRoot {
    hive: HKEY,
    prefix: &'static str,
}

const HKCU_CURRENT_VERSION: RegistryRoot = RegistryRoot {
    hive: HKEY_CURRENT_USER,
    prefix: CURRENT_VERSION,
};
const HKCU_CURRENT_VERSION_WOW: RegistryRoot = RegistryRoot {
    hive: HKEY_CURRENT_USER,
    prefix: CURRENT_VERSION_WOW,
};
const HKLM_CURRENT_VERSION: RegistryRoot = RegistryRoot {
    hive: HKEY_LOCAL_MACHINE,
    prefix: CURRENT_VERSION,
};
const HKLM_CURRENT_VERSION_WOW: RegistryRoot = RegistryRoot {
    hive: HKEY_LOCAL_MACHINE,
    prefix: CURRENT_VERSION_WOW,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WindowsZcodeRegistration {
    pub(crate) kind: &'static str,
    pub(crate) value: String,
}

#[derive(Clone, Debug)]
pub(crate) struct WindowsAppxPackage {
    pub(crate) full_name: String,
    pub(crate) family_name: String,
    pub(crate) version: String,
    pub(crate) install_location: PathBuf,
}

struct RegistryKey {
    handle: HKEY,
}

impl RegistryKey {
    fn open(hive: HKEY, path: &str) -> Option<Self> {
        let mut handle = std::ptr::null_mut();
        let status =
            unsafe { RegOpenKeyExW(hive, to_wide(path).as_ptr(), 0, KEY_READ, &mut handle) };
        (status == ERROR_SUCCESS && !handle.is_null()).then_some(Self { handle })
    }

    fn string(&self, name: &str) -> Option<String> {
        let name = to_wide(name);
        let mut value_type = 0;
        let mut size = 0;
        let status = unsafe {
            RegQueryValueExW(
                self.handle,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut value_type,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS || size == 0 {
            return None;
        }
        let mut buffer = vec![0_u8; size as usize];
        let status = unsafe {
            RegQueryValueExW(
                self.handle,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut value_type,
                buffer.as_mut_ptr(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        buffer.truncate(size as usize);
        decode_registry_string(value_type, &buffer)
    }

    fn subkeys(&self) -> Vec<String> {
        let mut names = Vec::new();
        for index in 0.. {
            let mut name = vec![0_u16; 256];
            let mut name_len = name.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    self.handle,
                    index,
                    name.as_mut_ptr(),
                    &mut name_len,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            match status {
                ERROR_SUCCESS => {
                    name.truncate(name_len as usize);
                    names.push(from_wide(&name));
                }
                ERROR_MORE_DATA => {
                    name.resize(name_len.max(1) as usize, 0);
                    let mut retry_len = name.len() as u32;
                    let status = unsafe {
                        RegEnumKeyExW(
                            self.handle,
                            index,
                            name.as_mut_ptr(),
                            &mut retry_len,
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                        )
                    };
                    if status != ERROR_SUCCESS {
                        break;
                    }
                    name.truncate(retry_len as usize);
                    names.push(from_wide(&name));
                }
                ERROR_NO_MORE_ITEMS => break,
                _ => break,
            }
        }
        names
    }
}

impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.handle);
        }
    }
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

fn from_wide(value: &[u16]) -> String {
    let end = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end])
}

fn decode_registry_string(value_type: u32, buffer: &[u8]) -> Option<String> {
    if !matches!(value_type, REG_SZ | REG_EXPAND_SZ) {
        return None;
    }
    if buffer.len() < 2 {
        return None;
    }
    let units = buffer
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    let value = from_wide(&units);
    if value.is_empty() {
        return None;
    }
    Some(if value_type == REG_EXPAND_SZ {
        expand_environment_strings(&value).unwrap_or(value)
    } else {
        value
    })
}

fn expand_environment_strings(value: &str) -> Option<String> {
    let source = to_wide(value);
    let mut size = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), std::ptr::null_mut(), 0) };
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0_u16; size as usize];
    size = unsafe { ExpandEnvironmentStringsW(source.as_ptr(), buffer.as_mut_ptr(), size) };
    (size > 0).then(|| from_wide(&buffer[..size as usize]))
}

fn current_version_roots() -> [RegistryRoot; 4] {
    [
        HKCU_CURRENT_VERSION,
        HKCU_CURRENT_VERSION_WOW,
        HKLM_CURRENT_VERSION,
        HKLM_CURRENT_VERSION_WOW,
    ]
}

fn join_registry_path(prefix: &str, suffix: &str) -> String {
    format!("{prefix}\\{suffix}")
}

pub(crate) fn windows_app_path_executable(file_name: &str) -> Option<PathBuf> {
    for root in current_version_roots() {
        let Some(key) = RegistryKey::open(
            root.hive,
            &join_registry_path(root.prefix, &format!(r"App Paths\{file_name}")),
        ) else {
            continue;
        };
        if let Some(path) = key.string("") {
            let path = PathBuf::from(path.trim().trim_matches('"'));
            if path.is_absolute() && path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

pub(crate) fn collect_windows_zcode_registrations() -> Vec<WindowsZcodeRegistration> {
    collect_windows_desktop_registrations("ZCode.exe", windows_display_name_matches_zcode)
}

fn collect_windows_desktop_registrations(executable: &str, matches_name: fn(&str) -> bool) -> Vec<WindowsZcodeRegistration> {
    let mut registrations = Vec::new();
    for root in current_version_roots() {
        if let Some(path) = RegistryKey::open(
            root.hive,
            &join_registry_path(root.prefix, &format!(r"App Paths\{executable}")),
        )
        .and_then(|key| key.string(""))
        {
            registrations.push(WindowsZcodeRegistration {
                kind: "executable",
                value: path,
            });
        }
        let Some(uninstall) =
            RegistryKey::open(root.hive, &join_registry_path(root.prefix, "Uninstall"))
        else {
            continue;
        };
        for subkey in uninstall.subkeys() {
            let Some(entry) = RegistryKey::open(
                root.hive,
                &join_registry_path(root.prefix, &format!("Uninstall\\{subkey}")),
            ) else {
                continue;
            };
            let Some(display_name) = entry.string("DisplayName") else {
                continue;
            };
            if !matches_name(&display_name) {
                continue;
            }
            if let Some(value) = entry.string("InstallLocation") {
                registrations.push(WindowsZcodeRegistration {
                    kind: "directory",
                    value,
                });
            }
            if let Some(value) = entry.string("DisplayIcon") {
                registrations.push(WindowsZcodeRegistration {
                    kind: "icon",
                    value,
                });
            }
            if let Some(value) = entry.string("UninstallString") {
                registrations.push(WindowsZcodeRegistration {
                    kind: "uninstaller",
                    value,
                });
            }
        }
    }
    registrations
}

pub(crate) fn windows_display_name_matches_zcode(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("ZCode") else {
        return false;
    };
    rest.is_empty() || rest.starts_with([' ', '('])
}

pub(crate) fn parse_windows_zcode_registration(kind: &str, value: &str) -> Option<PathBuf> {
    parse_windows_desktop_registration(kind, value, "ZCode.exe")
}

pub(crate) fn parse_windows_desktop_registration(kind: &str, value: &str, executable_name: &str) -> Option<PathBuf> {
    let value = value.trim();
    let value =
        if let Some(quoted) = value.strip_prefix('"') {
            quoted.split_once('"')?.0
        } else if kind == "uninstaller" {
            let end = value.to_ascii_lowercase().match_indices(".exe").find_map(
                |(index, extension)| {
                    let end = index + extension.len();
                    (value[end..].is_empty() || value[end..].starts_with(char::is_whitespace))
                        .then_some(end)
                },
            )?;
            &value[..end]
        } else if kind == "icon" {
            value
                .rsplit_once(',')
                .filter(|(_, index)| index.trim().parse::<i32>().is_ok())
                .map(|(path, _)| path.trim())
                .unwrap_or(value)
        } else {
            value
        };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return None;
    }
    let executable = match kind {
        "executable" => path,
        "directory" => path.join(executable_name),
        "icon" | "uninstaller" => path.parent()?.join(executable_name),
        _ => return None,
    };
    (executable
        .file_name()?
        .to_str()?
        .eq_ignore_ascii_case(executable_name)
        && executable.is_file())
    .then_some(executable)
}

pub(crate) fn find_windows_registered_zcode_executable() -> Option<PathBuf> {
    collect_windows_zcode_registrations()
        .into_iter()
        .find_map(|registration| {
            parse_windows_zcode_registration(registration.kind, &registration.value)
        })
}

#[cfg(not(test))]
pub(crate) fn find_windows_registered_workbuddy_executable() -> Option<PathBuf> {
    for executable in ["WorkBuddyAI.exe", "WorkBuddy.exe"] {
        if let Some(path) = collect_windows_desktop_registrations(executable, |name| {
            ["WorkBuddyAI", "WorkBuddy AI", "WorkBuddy"].iter().any(|prefix| {
                name.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '(']))
            })
        }).into_iter().find_map(|r| parse_windows_desktop_registration(r.kind, &r.value, executable)) {
            return Some(path);
        }
    }
    None
}

pub(crate) fn read_windows_executable_version(path: &Path) -> Option<String> {
    let wide = to_wide(&path_to_string(path));
    let mut handle = 0;
    let size = unsafe { GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle) };
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0_u8; size as usize];
    if unsafe { GetFileVersionInfoW(wide.as_ptr(), 0, size, buffer.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    read_version_string(&buffer, r"\StringFileInfo\040904B0\ProductVersion")
        .or_else(|| read_version_string(&buffer, r"\StringFileInfo\000004B0\ProductVersion"))
        .or_else(|| {
            let translations = version_translations(&buffer)?;
            translations.into_iter().find_map(|(language, codepage)| {
                read_version_string(
                    &buffer,
                    &format!(r"\StringFileInfo\{language:04X}{codepage:04X}\ProductVersion"),
                )
            })
        })
        .and_then(|value| normalize_detected_agent_version(&value))
}

fn read_version_string(buffer: &[u8], path: &str) -> Option<String> {
    let mut value = std::ptr::null_mut();
    let mut length = 0;
    let query = to_wide(path);
    let found = unsafe {
        VerQueryValueW(
            buffer.as_ptr().cast(),
            query.as_ptr(),
            &mut value,
            &mut length,
        )
    };
    if found == 0 || value.is_null() || length == 0 {
        return None;
    }
    let units = unsafe { std::slice::from_raw_parts(value.cast::<u16>(), length as usize) };
    let value = from_wide(units);
    (!value.is_empty()).then_some(value)
}

fn version_translations(buffer: &[u8]) -> Option<Vec<(u16, u16)>> {
    let mut value = std::ptr::null_mut();
    let mut length = 0;
    let query = to_wide(r"\VarFileInfo\Translation");
    let found = unsafe {
        VerQueryValueW(
            buffer.as_ptr().cast(),
            query.as_ptr(),
            &mut value,
            &mut length,
        )
    };
    if found == 0 || value.is_null() || length < 4 {
        return None;
    }
    let units = unsafe { std::slice::from_raw_parts(value.cast::<u16>(), (length as usize) / 2) };
    Some(
        units
            .chunks_exact(2)
            .map(|chunk| (chunk[0], chunk[1]))
            .collect(),
    )
}

fn package_name_from_full_name(full_name: &str) -> Option<&str> {
    full_name
        .split('_')
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

fn publisher_id_from_full_name(full_name: &str) -> Option<&str> {
    full_name
        .rsplit('_')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn family_name_from_full_name(full_name: &str) -> Option<String> {
    let package_name = package_name_from_full_name(full_name)?;
    let publisher_id = publisher_id_from_full_name(full_name)?;
    if publisher_id == package_name {
        return None;
    }
    Some(format!("{package_name}_{publisher_id}"))
}

fn version_from_package_full_name(full_name: &str) -> Option<String> {
    let mut parts = full_name.split('_');
    let _name = parts.next()?;
    let version = parts.next()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

fn compare_dotted_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |value: &str| {
        value
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let left = parse(left);
    let right = parse(right);
    left.into_iter()
        .zip(right.iter().copied().chain(std::iter::repeat(0)))
        .find_map(|(left, right)| (left != right).then(|| left.cmp(&right)))
        .unwrap_or(std::cmp::Ordering::Equal)
}

fn list_appx_packages() -> Vec<WindowsAppxPackage> {
    let Some(key) = RegistryKey::open(HKEY_CURRENT_USER, APPX_PACKAGES) else {
        return Vec::new();
    };
    let mut packages = Vec::new();
    for full_name in key.subkeys() {
        let Some(family_name) = family_name_from_full_name(&full_name) else {
            continue;
        };
        let Some(package) =
            RegistryKey::open(HKEY_CURRENT_USER, &format!("{APPX_PACKAGES}\\{full_name}"))
        else {
            continue;
        };
        let install_location = package
            .string("PackageRootFolder")
            .or_else(|| package.string("InstallLocation"))
            .map(PathBuf::from)
            .filter(|path| path.is_absolute());
        let Some(install_location) = install_location else {
            continue;
        };
        packages.push(WindowsAppxPackage {
            version: version_from_package_full_name(&full_name).unwrap_or_default(),
            full_name,
            family_name,
            install_location,
        });
    }
    packages
}

fn package_matches_prefixes(full_name: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|prefix| {
        full_name == *prefix
            || full_name.starts_with(&format!("{prefix}_"))
            || family_name_from_full_name(full_name).is_some_and(|family| {
                family == *prefix || family.starts_with(&format!("{prefix}_"))
            })
    })
}

pub(crate) fn find_windows_appx_packages(prefixes: &[&str]) -> Vec<WindowsAppxPackage> {
    let mut packages = list_appx_packages()
        .into_iter()
        .filter(|package| package_matches_prefixes(&package.full_name, prefixes))
        .collect::<Vec<_>>();
    packages.sort_by(|left, right| compare_dotted_versions(&right.version, &left.version));
    packages
}

fn appx_manifest_path(package: &WindowsAppxPackage) -> PathBuf {
    package.install_location.join("AppxManifest.xml")
}

fn xml_attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn first_xml_tag<'a>(content: &'a str, local_name: &str) -> Option<&'a str> {
    let mut search = content;
    while let Some(start) = search.find('<') {
        let rest = &search[start + 1..];
        if rest.starts_with('/') || rest.starts_with('!') || rest.starts_with('?') {
            search = rest;
            continue;
        }
        let name_end = rest
            .find(|character: char| {
                character.is_whitespace() || character == '>' || character == '/'
            })
            .unwrap_or(rest.len());
        let tag_name = &rest[..name_end];
        let local = tag_name
            .rsplit_once(':')
            .map(|(_, name)| name)
            .unwrap_or(tag_name);
        if local.eq_ignore_ascii_case(local_name) {
            let close = rest.find('>')?;
            return Some(&rest[..close]);
        }
        search = rest;
    }
    None
}

fn appx_application_id_from_manifest(content: &str) -> Option<String> {
    xml_attr(first_xml_tag(content, "Application")?, "Id")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn appx_executable_from_manifest(content: &str, application_id: Option<&str>) -> Option<String> {
    let mut search = content;
    while let Some(start) = search.find('<') {
        let rest = &search[start + 1..];
        if rest.starts_with('/') || rest.starts_with('!') || rest.starts_with('?') {
            search = rest;
            continue;
        }
        let name_end = rest
            .find(|character: char| {
                character.is_whitespace() || character == '>' || character == '/'
            })
            .unwrap_or(rest.len());
        let tag_name = &rest[..name_end];
        let local = tag_name
            .rsplit_once(':')
            .map(|(_, name)| name)
            .unwrap_or(tag_name);
        if local.eq_ignore_ascii_case("Application") {
            let close = rest.find('>')?;
            let tag = &rest[..close];
            let id = xml_attr(tag, "Id")?;
            if application_id.is_none_or(|expected| expected == id) {
                return xml_attr(tag, "Executable")
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
            }
            search = &rest[close..];
            continue;
        }
        search = rest;
    }
    None
}

pub(crate) fn windows_appx_app_id(package: &WindowsAppxPackage) -> Option<String> {
    let content = fs::read_to_string(appx_manifest_path(package)).ok();
    let application_id = content
        .as_deref()
        .and_then(appx_application_id_from_manifest)
        .unwrap_or_else(|| "App".to_string());
    (!application_id.is_empty()).then(|| format!("{}!{application_id}", package.family_name))
}

pub(crate) fn windows_appx_executable(
    package: &WindowsAppxPackage,
    application_id: Option<&str>,
) -> Option<PathBuf> {
    let content = fs::read_to_string(appx_manifest_path(package)).ok()?;
    let relative = appx_executable_from_manifest(&content, application_id)?;
    let path = package.install_location.join(relative.replace('/', "\\"));
    path.is_file().then_some(path)
}

pub(crate) fn find_windows_appx_app_id(prefixes: &[&str]) -> Option<String> {
    find_windows_appx_packages(prefixes)
        .into_iter()
        .find_map(|package| windows_appx_app_id(&package))
}

pub(crate) fn find_windows_claude_app_id() -> Option<String> {
    find_windows_appx_app_id(&["Claude", "Anthropic.Claude"])
}

pub(crate) fn read_windows_claude_desktop_store_version() -> Option<String> {
    find_windows_appx_packages(&["Claude", "Anthropic.Claude"])
        .into_iter()
        .find_map(|package| normalize_detected_agent_version(&package.version))
}

pub(crate) fn find_windows_codex_app_id_via_registry() -> Option<String> {
    find_windows_appx_app_id(&["OpenAI.Codex", "OpenAI.CodexBeta", "OpenAI.ChatGPT"])
}

pub(crate) fn windows_codex_store_app_id_parts(app_id: &str) -> Option<(&str, &str)> {
    let (family, application) = app_id.split_once('!')?;
    (!family.is_empty() && !application.is_empty()).then_some((family, application))
}

pub(crate) fn find_windows_codex_store_executable(app_id: &str) -> Option<PathBuf> {
    let (family, application) = windows_codex_store_app_id_parts(app_id)?;
    find_windows_appx_packages(&["OpenAI.Codex", "OpenAI.CodexBeta", "OpenAI.ChatGPT"])
        .into_iter()
        .find(|package| package.family_name.eq_ignore_ascii_case(family))
        .and_then(|package| windows_appx_executable(&package, Some(application)))
}

pub(crate) fn find_windows_registered_codex_app_installation() -> Option<DesktopAppTarget> {
    if let Some(app_id) = find_windows_codex_app_id_via_registry() {
        return Some(DesktopAppTarget::WindowsAppId(app_id));
    }
    for name in ["ChatGPT.exe", "Codex.exe"] {
        if let Some(path) = windows_app_path_executable(name) {
            let lowered = path_to_string(&path).to_ascii_lowercase();
            if name.eq_ignore_ascii_case("Codex.exe")
                && ["\\bin\\", "\\node_modules\\", "\\.vscode\\extensions\\"]
                    .iter()
                    .any(|marker| lowered.contains(marker))
            {
                continue;
            }
            return Some(DesktopAppTarget::Application(path));
        }
    }
    None
}

pub(crate) fn windows_path_key(path: &Path) -> String {
    path_to_string(path)
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_ascii_lowercase()
}

pub(crate) fn windows_process_matches_stop_target(
    process_path: &Path,
    executable: Option<&Path>,
    install_root: Option<&Path>,
    image_names: &[&str],
) -> bool {
    if !image_names.is_empty() {
        let file_name = process_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if !image_names
            .iter()
            .any(|name| file_name.eq_ignore_ascii_case(name))
        {
            return false;
        }
    }
    let process_key = windows_path_key(process_path);
    if let Some(executable) = executable {
        if process_key == windows_path_key(executable) {
            return true;
        }
    }
    if let Some(root) = install_root {
        let root_key = windows_path_key(root);
        if !root_key.is_empty()
            && (process_key == root_key || process_key.starts_with(&format!("{root_key}\\")))
        {
            return true;
        }
    }
    false
}

pub(crate) fn windows_desktop_stop_target(
    target: &DesktopAppTarget,
) -> Result<(Option<PathBuf>, Option<PathBuf>), String> {
    match target {
        DesktopAppTarget::Application(path) => Ok((Some(path.clone()), None)),
        DesktopAppTarget::WindowsAppId(app_id) => {
            let family = app_id.split('!').next().unwrap_or(app_id);
            find_windows_appx_packages(&[family])
                .into_iter()
                .find(|package| package.family_name.eq_ignore_ascii_case(family))
                .map(|package| (None, Some(package.install_location)))
                .ok_or_else(|| "Application package directory was not found".to_string())
        }
    }
}

pub(crate) fn find_windows_matching_process_ids(
    executable: Option<&Path>,
    install_root: Option<&Path>,
    image_names: &[&str],
) -> Vec<u32> {
    find_windows_process_snapshot()
        .into_iter()
        .filter(|(_, path)| {
            windows_process_matches_stop_target(path, executable, install_root, image_names)
        })
        .map(|(process_id, _)| process_id)
        .collect()
}

fn find_windows_process_snapshot() -> Vec<(u32, PathBuf)> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let mut entry = unsafe { std::mem::zeroed::<PROCESSENTRY32W>() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut processes = Vec::new();
    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            if entry.th32ProcessID != 0 {
                if let Some(path) = process_executable_path(entry.th32ProcessID) {
                    processes.push((entry.th32ProcessID, path));
                }
            }
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(snapshot);
    }
    processes
}

fn terminate_windows_process(process_id: u32) {
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, process_id) };
    if handle.is_null() {
        return;
    }
    unsafe {
        TerminateProcess(handle, 1);
        windows_sys::Win32::Foundation::CloseHandle(handle);
    }
}

pub(crate) fn stop_windows_matching_processes(
    executable: Option<&Path>,
    install_root: Option<&Path>,
    image_names: &[&str],
    label: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = find_windows_matching_process_ids(executable, install_root, image_names);
        if remaining.is_empty() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let ids = remaining
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "{label} 未能完全关闭; remaining process IDs: {ids}"
            ));
        }
        for process_id in remaining {
            terminate_windows_process(process_id);
        }
        thread::sleep(Duration::from_millis(100));
    }
}
