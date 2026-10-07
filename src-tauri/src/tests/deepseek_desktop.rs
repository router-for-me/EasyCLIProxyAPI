#[cfg(target_os = "windows")]
use super::support::agent_test_home;
use super::*;

#[test]
fn deepseek_desktop_launch_targets_are_independent_of_cli_and_version() {
    let client = AgentClient::DeepSeekHarness;
    assert!(agent_installation_detected(client, None, false, true));
    let desktop = agent_launch_targets(client, None, None, true);
    assert_eq!(desktop.len(), 1);
    assert_eq!(desktop[0].id, "app");
    let both = agent_launch_targets(client, Some(Path::new("dsh")), None, true);
    assert_eq!(
        both.iter()
            .map(|target| target.id.as_str())
            .collect::<Vec<_>>(),
        ["cli", "app"]
    );
    // An installed profile alone must not create a Desktop launch target.
    assert!(agent_launch_targets(client, None, Some("0.2.0"), false).is_empty());
    assert!(!agent_installation_detected(client, None, false, false));
}

#[cfg(target_os = "windows")]
#[test]
fn deepseek_desktop_windows_finds_custom_and_default_installations() {
    let home = agent_test_home("deepseek-desktop-discovery");
    let local = home.join("local");
    let custom = home.join("custom/DeepSeek Harness.exe");
    let default = local.join("Programs/DeepSeek Harness/DeepSeek Harness.exe");
    fs::create_dir_all(custom.parent().unwrap()).unwrap();
    fs::create_dir_all(default.parent().unwrap()).unwrap();
    fs::write(&custom, []).unwrap();
    for (kind, value) in [
        ("directory", path_to_string(custom.parent().unwrap())),
        ("icon", format!("\"{}\",0", path_to_string(&custom))),
        (
            "uninstaller",
            format!(
                "\"{}\" /S",
                path_to_string(
                    &custom
                        .parent()
                        .unwrap()
                        .join("Uninstall DeepSeek Harness.exe")
                )
            ),
        ),
    ] {
        let entries = [WindowsZcodeRegistration { kind, value }];
        assert_eq!(
            find_windows_deepseek_harness_desktop(&local, &[], &entries),
            Some(custom.clone())
        );
    }
    fs::remove_file(&custom).unwrap();
    let stale = [WindowsZcodeRegistration {
        kind: "executable",
        value: path_to_string(&custom),
    }];
    assert_eq!(
        find_windows_deepseek_harness_desktop(&local, &[], &stale),
        None
    );
    fs::write(&default, []).unwrap();
    assert_eq!(
        find_windows_deepseek_harness_desktop(&local, &[], &stale),
        Some(default)
    );
    fs::remove_dir_all(home).unwrap();
}

#[cfg(target_os = "windows")]
#[test]
fn deepseek_desktop_windows_registration_name_is_specific() {
    for name in [
        "DeepSeek Harness",
        "DeepSeek Harness 0.2.0-rc.2",
        "deepseek harness (user)",
    ] {
        assert!(windows_display_name_matches_deepseek_harness(name));
    }
    for name in [
        "DeepSeek",
        "DeepSeek HarnessHelper",
        "Other DeepSeek Harness",
    ] {
        assert!(!windows_display_name_matches_deepseek_harness(name));
    }
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "Requires DeepSeek Harness Desktop installed on the host"]
fn deepseek_desktop_installed_host_probe() {
    let registrations = collect_windows_desktop_registrations(
        "DeepSeek Harness.exe",
        windows_display_name_matches_deepseek_harness,
    );
    let local = PathBuf::from(env::var_os("LOCALAPPDATA").unwrap());
    let app = find_windows_deepseek_harness_desktop(&local, &[], &registrations)
        .expect("installed Desktop should be detected");
    let version = read_deepseek_harness_desktop_version(&app).expect("Desktop version");
    println!("DeepSeek Harness Desktop: {} ({version})", app.display());
}
