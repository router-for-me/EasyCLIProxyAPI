use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentEnvironmentOptions {
    supported: bool,
    default_directory: String,
    distributions: Vec<WslDistribution>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WslDistribution {
    name: String,
    users: Vec<WslUserDirectory>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WslUserDirectory {
    name: String,
    directory: String,
    exists: bool,
}

fn linux_config_suffix(client: &str) -> Result<&'static str, String> {
    match client {
        "claude-code" => Ok(".claude"),
        "claude-desktop" => Ok(".config/Claude"),
        "codex" => Ok(".codex"),
        "opencode" => Ok(".config/opencode"),
        "openclaw" => Ok(".openclaw"),
        "hermes" => Ok(".hermes"),
        "deepseek-harness" => Ok(".dsh"),
        "pi" => Ok(".pi/agent"),
        "omp" => Ok(".omp/agent"),
        "zcode" => Ok(".zcode/v2"),
        "workbuddy" => Ok(".workbuddy-ai"),
        "antigravity-cli" => Ok(".gemini/antigravity-cli"),
        "copilot-cli" => Ok(".copilot"),
        "vscode-copilot" => Ok(".config/Code/User"),
        "kimi-code" => Ok(".kimi-code"),
        "grok-build" => Ok(".grok"),
        _ => Err("Unsupported configuration client".into()),
    }
}

#[cfg(any(target_os = "windows", test))]
fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.ends_with(['.', ' '])
        && !value.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
        && !value.chars().any(char::is_control)
}

#[cfg(any(target_os = "windows", test))]
fn parse_distribution_names(bytes: &[u8]) -> Vec<String> {
    let text = if bytes.contains(&0) {
        let words: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&words)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .map(|line| line.trim().trim_start_matches('\u{feff}'))
        .filter(|name| safe_component(name))
        .map(str::to_owned)
        .collect()
}

#[cfg(target_os = "windows")]
fn distribution_names() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut names = Vec::new();
    if let Ok(mut child) = Command::new("wsl.exe")
        .args(["--list", "--quiet"])
        .creation_flags(0x08000000)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => {
                    if let Ok(output) = child.wait_with_output() {
                        if !output.status.success() {
                            break;
                        }
                        names.extend(parse_distribution_names(&output.stdout));
                    }
                    break;
                }
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(40));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
    }
    for share in [r"\\wsl.localhost", r"\\wsl$"] {
        if let Ok(entries) = fs::read_dir(share) {
            names.extend(entries.flatten().filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                safe_component(&name).then_some(name)
            }));
        }
    }
    names.sort();
    names.dedup();
    names
}

#[cfg(target_os = "windows")]
fn detect_distributions(suffix: &str) -> Vec<WslDistribution> {
    let suffix = suffix.replace('/', "\\");
    distribution_names()
        .into_iter()
        .map(|name| {
            let roots = [
                format!(r"\\wsl.localhost\{name}"),
                format!(r"\\wsl$\{name}"),
            ];
            let root = roots
                .iter()
                .find(|root| Path::new(root).is_dir())
                .unwrap_or(&roots[0]);
            let mut users = Vec::new();
            if let Ok(entries) = fs::read_dir(Path::new(root).join("home")) {
                for entry in entries.flatten() {
                    let user = entry.file_name().to_string_lossy().into_owned();
                    if safe_component(&user) && entry.path().is_dir() {
                        let directory = entry.path().join(&suffix);
                        users.push(WslUserDirectory {
                            name: user,
                            exists: directory.is_dir(),
                            directory: directory.to_string_lossy().into_owned(),
                        });
                    }
                }
            }
            users.sort_by(|left, right| left.name.cmp(&right.name));
            let root_home = Path::new(root).join("root");
            if root_home.is_dir() {
                let directory = root_home.join(&suffix);
                users.push(WslUserDirectory {
                    name: "root".into(),
                    exists: directory.is_dir(),
                    directory: directory.to_string_lossy().into_owned(),
                });
            }
            WslDistribution { name, users }
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn get_agent_environment_options(
    app: tauri::AppHandle,
    client: String,
) -> Result<AgentEnvironmentOptions, String> {
    let suffix = linux_config_suffix(&client)?;
    let task = tauri::async_runtime::spawn_blocking(move || {
        let home = app.path().home_dir().map_err(|error| error.to_string())?;
        let directory = if client == "pi" {
            pi_agent_directory(&home)
        } else if client == "deepseek-harness" {
            deepseek_harness_home(&home)
        } else {
            agent_config_paths(AgentClient::parse(&client)?, &home)
                .first()
                .and_then(|path| path.parent())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| home.join(suffix))
        };
        #[cfg(target_os = "windows")]
        let distributions = detect_distributions(suffix);
        #[cfg(not(target_os = "windows"))]
        let distributions = Vec::new();
        Ok(AgentEnvironmentOptions {
            supported: cfg!(target_os = "windows"),
            default_directory: directory.to_string_lossy().into_owned(),
            distributions,
        })
    });
    tokio::time::timeout(Duration::from_secs(15), task)
        .await
        .map_err(|_| "Environment detection timed out".to_string())?
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_defaults_include_nested_configuration_directories() {
        assert_eq!(linux_config_suffix("claude-code").unwrap(), ".claude");
        assert_eq!(linux_config_suffix("opencode").unwrap(), ".config/opencode");
        assert_eq!(linux_config_suffix("pi").unwrap(), ".pi/agent");
        assert_eq!(
            linux_config_suffix("vscode-copilot").unwrap(),
            ".config/Code/User"
        );
        assert!(linux_config_suffix("../other").is_err());
    }

    #[test]
    fn distribution_listing_supports_utf16_and_utf8() {
        let expected = vec!["Ubuntu-24.04", "Debian"];
        assert_eq!(
            parse_distribution_names(b"Ubuntu-24.04\r\nDebian\r\n"),
            expected
        );
        let utf16: Vec<u8> = "\u{feff}Ubuntu-24.04\r\nDebian\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(parse_distribution_names(&utf16), expected);
        assert!(parse_distribution_names(b"\r\n../invalid\r\n").is_empty());
    }

    #[test]
    fn share_components_cannot_escape_the_distribution() {
        for value in [
            "",
            ".",
            "..",
            "../Ubuntu",
            r"Ubuntu\root",
            "C:",
            "bad\0name",
        ] {
            assert!(!safe_component(value));
        }
        assert!(safe_component("Ubuntu-24.04"));
        assert!(safe_component("my user"));
    }
}
