use super::types::SwitchPlatformId;
use std::path::Path;
use std::time::Duration;
use sysinfo::{ProcessesToUpdate, System};

fn process_name_patterns(platform: SwitchPlatformId) -> &'static [&'static str] {
    match platform {
        SwitchPlatformId::Codex => &["codex", "chatgpt"],
        SwitchPlatformId::Antigravity => &["antigravity"],
        SwitchPlatformId::GithubCopilot => &["code", "code.exe", "visual studio code"],
        SwitchPlatformId::WindsurfDevin => &["windsurf", "devin"],
        SwitchPlatformId::Workbuddy => &["workbuddy"],
        SwitchPlatformId::WorkbuddyAi => &["workbuddy ai", "workbuddy-ai"],
        SwitchPlatformId::Zcode => &["zcode"],
        SwitchPlatformId::ClaudeDesktop => &["claude"],
        SwitchPlatformId::ClaudeCode | SwitchPlatformId::Grok | SwitchPlatformId::Kimi => &[],
    }
}

fn matches_platform_process(platform: SwitchPlatformId, name: &str, exe: Option<&Path>) -> bool {
    let lower_name = name.to_ascii_lowercase();
    let lower_exe = exe
        .map(|p| p.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    // Never match ourselves.
    if lower_name.contains("easycliproxyapi") || lower_name.contains("cpa-gui") {
        return false;
    }

    match platform {
        SwitchPlatformId::Codex => {
            lower_name == "codex.exe"
                || lower_name == "codex"
                || (lower_name == "chatgpt.exe" && lower_exe.contains("openai.codex"))
        }
        SwitchPlatformId::Antigravity => {
            lower_name == "antigravity.exe"
                || lower_name == "antigravity"
                || (lower_exe.contains("antigravity") && !lower_name.contains("helper"))
        }
        SwitchPlatformId::GithubCopilot => {
            lower_name == "code.exe"
                || lower_name == "code"
                || lower_exe.ends_with("/electron") && lower_exe.contains("visual studio code")
        }
        SwitchPlatformId::WindsurfDevin => {
            lower_name == "windsurf.exe"
                || lower_name == "windsurf"
                || lower_name == "devin.exe"
                || lower_name == "devin"
        }
        SwitchPlatformId::Workbuddy => {
            (lower_name == "workbuddy.exe" || lower_name == "workbuddy")
                && !lower_exe.contains("workbuddy ai")
                && !lower_exe.contains("workbuddy-ai")
        }
        SwitchPlatformId::WorkbuddyAi => {
            lower_name.contains("workbuddy")
                && (lower_exe.contains("workbuddy ai") || lower_exe.contains("workbuddy-ai"))
        }
        SwitchPlatformId::Zcode => lower_name == "zcode.exe" || lower_name == "zcode",
        SwitchPlatformId::ClaudeDesktop => {
            (lower_name == "claude.exe" || lower_name == "claude")
                && !lower_exe.contains("claude-code")
        }
        _ => {
            let patterns = process_name_patterns(platform);
            patterns.iter().any(|pat| lower_name == *pat)
        }
    }
}

pub(crate) fn detect_running_pids(platform: SwitchPlatformId) -> Vec<u32> {
    if !platform.supports_client_restart() {
        return Vec::new();
    }
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let mut pids = Vec::new();
    for (pid, process) in system.processes() {
        let name = process.name().to_string_lossy();
        if matches_platform_process(platform, &name, process.exe()) {
            pids.push(pid.as_u32());
        }
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}

pub(crate) fn stop_client_processes(platform: SwitchPlatformId) -> Result<usize, String> {
    if !platform.supports_client_restart() {
        return Ok(0);
    }
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let mut stopped = 0usize;
    for process in system.processes().values() {
        let name = process.name().to_string_lossy();
        if matches_platform_process(platform, &name, process.exe()) {
            if process.kill() {
                stopped += 1;
            }
        }
    }
    if stopped > 0 {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if detect_running_pids(platform).is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(120));
        }
    }
    Ok(stopped)
}

pub(crate) fn restart_platform_client(
    app: &crate::runtime::AppHandle,
    platform: SwitchPlatformId,
) -> Result<bool, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to resolve user home directory: {error}"))?;

    // Capture executable before stopping so we can relaunch cleanly.
    let mut captured_exe = None;
    {
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);
        for process in system.processes().values() {
            let name = process.name().to_string_lossy();
            if matches_platform_process(platform, &name, process.exe()) {
                if let Some(exe) = process.exe() {
                    if exe.is_file() {
                        captured_exe = Some(exe.to_path_buf());
                        break;
                    }
                }
            }
        }
    }

    let was_running = !detect_running_pids(platform).is_empty();
    let _ = stop_client_processes(platform)?;

    let launch_exe = captured_exe.or_else(|| find_default_desktop_executable(platform, &home));
    let Some(exe) = launch_exe else {
        return Ok(was_running);
    };

    #[cfg(target_os = "macos")]
    {
        if exe.extension().and_then(|v| v.to_str()) == Some("app") {
            std::process::Command::new("open")
                .arg("-a")
                .arg(&exe)
                .spawn()
                .map_err(|error| format!("Failed to launch {}: {error}", exe.display()))?;
            return Ok(true);
        }
    }

    let mut command = std::process::Command::new(&exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008); // DETACHED_PROCESS
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("Failed to restart {}: {error}", exe.display()))?;
    Ok(true)
}

fn find_default_desktop_executable(
    platform: SwitchPlatformId,
    home: &Path,
) -> Option<std::path::PathBuf> {
    match platform {
        SwitchPlatformId::Workbuddy | SwitchPlatformId::WorkbuddyAi => {
            crate::agents::find_workbuddy_desktop_executable(home)
        }
        SwitchPlatformId::Zcode => crate::agents::find_zcode_desktop_executable(home),
        SwitchPlatformId::GithubCopilot => {
            crate::agents::find_agent_executable(crate::AgentClient::VscodeCopilot, home)
        }
        #[cfg(target_os = "windows")]
        SwitchPlatformId::WindsurfDevin => {
            let local_app = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)?;
            [
                local_app.join("Programs").join("Devin").join("Devin.exe"),
                local_app
                    .join("Programs")
                    .join("Windsurf")
                    .join("Windsurf.exe"),
            ]
            .into_iter()
            .find(|p| p.is_file())
        }
        #[cfg(target_os = "windows")]
        SwitchPlatformId::Antigravity => {
            let local_app = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)?;
            [local_app
                .join("Programs")
                .join("Antigravity")
                .join("Antigravity.exe")]
            .into_iter()
            .find(|p| p.is_file())
        }
        #[cfg(target_os = "macos")]
        SwitchPlatformId::WindsurfDevin => ["/Applications/Devin.app", "/Applications/Windsurf.app"]
            .into_iter()
            .map(std::path::PathBuf::from)
            .find(|p| p.exists()),
        #[cfg(target_os = "macos")]
        SwitchPlatformId::Antigravity => [std::path::PathBuf::from("/Applications/Antigravity.app")]
            .into_iter()
            .find(|p| p.exists()),
        _ => None,
    }
}
