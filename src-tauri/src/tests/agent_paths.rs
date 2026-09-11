use super::support::*;
use super::*;

#[test]
fn configuration_paths_ignore_inherited_environment() {
    let home = agent_test_home("isolated-paths");
    for client in [
        "claude-code",
        "claude-desktop",
        "codex",
        "opencode",
        "openclaw",
        "hermes",
        "deepseek-harness",
        "zcode",
        "kimi-code",
        "grok-build",
        "pi",
    ] {
        let paths = config_paths(client, &home).unwrap();
        assert!(!paths.is_empty(), "{client}");
        assert!(
            paths.iter().all(|path| path.starts_with(&home)),
            "{client}: {paths:?}"
        );
    }
    if env::var_os("CPA_PATH_ISOLATION_CHILD").is_none() {
        let outside = home.join("inherited-environment");
        let mut command = Command::new(env::current_exe().unwrap());
        command.args([
            "--exact",
            "tests::agent_paths::configuration_paths_ignore_inherited_environment",
            "--nocapture",
        ]);
        command.env("CPA_PATH_ISOLATION_CHILD", "1");
        for variable in [
            "LOCALAPPDATA",
            "XDG_CONFIG_HOME",
            "CODEX_HOME",
            "HERMES_HOME",
            "OPENCODE_CONFIG",
            "KIMI_CODE_HOME",
            "GROK_HOME",
            "DSH_HOME",
            "PI_CODING_AGENT_DIR",
        ] {
            command.env(variable, &outside);
        }
        configure_background_command(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!outside.exists());
    }
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn zcode_installation_does_not_require_version_metadata() {
    assert!(agent_installation_detected(
        AgentClient::ZCode,
        None,
        true,
        false,
    ));
    assert!(!agent_installation_detected(
        AgentClient::ZCode,
        None,
        false,
        false,
    ));
    let targets = agent_launch_targets(
        AgentClient::ZCode,
        Some(Path::new("ZCode.exe")),
        None,
        false,
    );
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].id, "app");
}

#[cfg(target_os = "windows")]
#[test]
fn zcode_windows_finds_custom_installations_from_registered_paths() {
    let home = agent_test_home("zcode-custom-installation");
    let directory = home.join("自定义应用 [桌面]/ZCode's directory");
    let executable = directory.join("ZCode.exe");
    fs::create_dir_all(&directory).unwrap();
    fs::write(&executable, []).unwrap();
    let icon = directory.join("uninstallerIcon.ico");
    let uninstaller = directory.join("Uninstall ZCode.exe");
    for (kind, value) in [
        ("executable", path_to_string(&executable)),
        ("executable", format!("\"{}\"", executable.display())),
        ("directory", path_to_string(&directory)),
        ("icon", path_to_string(&icon)),
        ("icon", format!("{},0", executable.display())),
        ("icon", format!("\"{}\",-123", executable.display())),
        (
            "uninstaller",
            format!("\"{}\" /currentuser", uninstaller.display()),
        ),
        (
            "uninstaller",
            format!("{} /allusers", uninstaller.display()),
        ),
    ] {
        let output = serde_json::json!([{ "kind": kind, "value": value }]).to_string();
        assert_eq!(
            parse_windows_zcode_discovery_output(&output),
            Some(executable.clone()),
            "{output}",
        );
    }
    fs::remove_dir_all(home).unwrap();
}

#[cfg(target_os = "windows")]
#[test]
fn zcode_windows_skips_stale_and_unrelated_registration_entries() {
    let home = agent_test_home("zcode-stale-registration");
    let unrelated = home.join("Uninstall ZCode.exe");
    fs::write(&unrelated, []).unwrap();
    let executable = home.join("valid/ZCode.exe");
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(&executable, []).unwrap();
    let mut candidates = vec![
        serde_json::json!({ "kind": "directory", "value": home }),
        serde_json::json!({ "kind": "executable", "value": unrelated }),
        serde_json::json!({ "kind": "executable", "value": home.join("missing/ZCode.exe") }),
        serde_json::json!({ "kind": "executable", "value": "ZCode.exe" }),
        serde_json::json!({ "kind": "executable", "value": "\"unterminated" }),
        serde_json::json!({ "kind": "unknown", "value": executable }),
        serde_json::json!({ "kind": "executable", "value": null }),
    ];
    assert_eq!(
        parse_windows_zcode_discovery_output(&serde_json::to_string(&candidates).unwrap()),
        None,
    );
    candidates.push(serde_json::json!({ "kind": "executable", "value": executable }));
    assert_eq!(
        parse_windows_zcode_discovery_output(&serde_json::to_string(&candidates).unwrap()),
        Some(executable),
    );
    assert_eq!(parse_windows_zcode_discovery_output("[]"), None);
    assert_eq!(parse_windows_zcode_discovery_output("invalid JSON"), None);
    fs::remove_dir_all(home).unwrap();
}

#[cfg(target_os = "windows")]
#[test]
fn zcode_windows_version_discovery_does_not_launch_the_application() {
    let home = agent_test_home("zcode-version-no-launch");
    let executable = home.join("zcode.cmd");
    let marker = home.join("launched.txt");
    fs::write(
        &executable,
        format!(
            "@echo off\r\necho launched > \"{}\"\r\necho 1.0.0\r\n",
            marker.display()
        ),
    )
    .unwrap();
    assert_eq!(read_zcode_app_version(&executable), None);
    assert!(
        !marker.exists(),
        "version discovery launched the application"
    );
    fs::remove_dir_all(home).unwrap();
}
