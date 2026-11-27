use super::*;

pub(crate) fn find_deepseek_harness_desktop_application(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = agent_configuration_environment("LOCALAPPDATA")
            .unwrap_or_else(|| home.join("AppData/Local"));
        let roots = ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(agent_configuration_environment)
            .collect::<Vec<_>>();
        // Keep fixture homes isolated from applications installed on the test host.
        #[cfg(test)]
        let registrations = Vec::new();
        #[cfg(not(test))]
        let registrations = collect_windows_desktop_registrations(
            "DeepSeek Harness.exe",
            windows_display_name_matches_deepseek_harness,
        );
        find_windows_deepseek_harness_desktop(&local, &roots, &registrations)
    }
    #[cfg(target_os = "macos")]
    {
        find_macos_deepseek_harness_desktop(home)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = home;
        None
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_display_name_matches_deepseek_harness(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    name.strip_prefix("deepseek harness")
        .is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '(']))
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_deepseek_harness_desktop(
    local: &Path,
    program_files: &[PathBuf],
    registrations: &[WindowsZcodeRegistration],
) -> Option<PathBuf> {
    let registered = registrations.iter().filter_map(|entry| {
        parse_windows_desktop_registration(entry.kind, &entry.value, "DeepSeek Harness.exe")
    });
    let defaults = [
        local.join("Programs/DeepSeek Harness/DeepSeek Harness.exe"),
        local.join("DeepSeek Harness/DeepSeek Harness.exe"),
    ];
    registered
        .chain(defaults)
        .chain(
            program_files
                .iter()
                .map(|root| root.join("DeepSeek Harness/DeepSeek Harness.exe")),
        )
        .find(|path| path.is_file())
}

pub(crate) fn read_deepseek_harness_desktop_version(application: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // Electron's PE ProductVersion drops prerelease suffixes; package.json retains them.
        read_codex_asar_version(&application.parent()?.join("resources/app.asar"))
            .or_else(|| read_windows_executable_version(application))
    }
    #[cfg(target_os = "macos")]
    {
        read_macos_app_version(application)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = application;
        None
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn find_macos_deepseek_harness_desktop_in_roots(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join("DeepSeek Harness.app"))
        .find(|path| path.is_dir())
}

#[cfg(target_os = "macos")]
pub(crate) fn find_macos_deepseek_harness_desktop(home: &Path) -> Option<PathBuf> {
    let roots = [PathBuf::from("/Applications"), home.join("Applications")];
    find_macos_deepseek_harness_desktop_in_roots(&roots)
}
