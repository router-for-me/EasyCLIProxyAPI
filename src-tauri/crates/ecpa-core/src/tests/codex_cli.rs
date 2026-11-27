use super::support::*;
use super::*;

#[test]
fn codex_cli_windows_batch_arguments_preserve_spaces_and_shell_mode() {
    assert_eq!(windows_batch_command_arguments(false), ["/D", "/C", "call"]);
    assert_eq!(windows_batch_command_arguments(true), ["/D", "/K", "call"]);
    assert_eq!(
        windows_batch_executable_argument(Path::new(r"C:\CLI tools\codex.cmd")),
        r#""C:\CLI tools\codex.cmd""#,
    );
    assert_eq!(
        windows_batch_executable_argument(Path::new(r"C:\CLI tools\codex.bat")),
        r#""C:\CLI tools\codex.bat""#,
    );
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture(directory: &Path, name: &str, body: &str) -> PathBuf {
        fs::create_dir_all(directory).unwrap();
        let path = directory.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn counted_fixture(directory: &Path, version: &str) -> PathBuf {
        fixture(directory, "codex", &format!(
            "printf '%s\\n' \"$*\" >> \"$0.calls\"\nif [ \"$1\" = --version ]; then printf '{version}\\n'; else printf 'launched:%s\\n' \"$0\"; fi"
        ))
    }

    fn calls(path: &Path) -> Vec<String> {
        fs::read_to_string(format!("{}.calls", path.display()))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn isolated_test(name: &str, environment_override: &str, test: impl FnOnce(&Path)) {
        if let Some(home) = env::var_os("CPA_CODEX_CLI_TEST_HOME") {
            test(Path::new(&home));
            return;
        }
        let home = agent_test_home("codex-cli-isolated");
        let output = Command::new(env::current_exe().unwrap())
            .args(["--exact", &format!("tests::codex_cli::unix::{name}"), "--nocapture"])
            .env_clear()
            .env("CPA_CODEX_CLI_TEST_HOME", &home)
            .env("HOME", &home)
            .env("CODEX_HOME", home.join(".codex"))
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("PATH", home.join("path"))
            .env("CODEX_CLI_PATH", environment_override)
            .current_dir(&home)
            .output()
            .unwrap();
        fs::remove_dir_all(home).unwrap();
        assert!(output.status.success(), "{}\n{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        print!("{}", String::from_utf8_lossy(&output.stdout));
    }

    #[test]
    fn codex_cli_whitespace_environment_override_uses_path() {
        isolated_test("codex_cli_whitespace_environment_override_uses_path", " \t\n ", |home| {
            let cli = counted_fixture(&home.join("path"), "codex-cli 1.2.3");
            let (status, executable) = inspect_agent_config_and_executable(
                AgentClient::Codex, home, 8317, "fixture-key", None, None,
            );
            let plan = prepare_codex_cli_launch(home, &status, executable, &[]).unwrap();
            assert_eq!(plan.executable, cli);
            assert!(plan.arguments.is_empty());
            assert_eq!(calls(&cli), ["--version"]);
        });
    }

    #[test]
    fn codex_cli_environment_override_prepares_launch_without_probing_path_installation() {
        isolated_test("codex_cli_environment_override_prepares_launch_without_probing_path_installation", "environment/codex", |home| {
            let cli = counted_fixture(&home.join("environment"), "codex-cli 2.0.0");
            let fallback = counted_fixture(&home.join("path"), "codex-cli 1.0.0");
            let (status, executable) = inspect_agent_config_and_executable(
                AgentClient::Codex, home, 8317, "fixture-key", None, None,
            );
            let plan = prepare_codex_cli_launch(home, &status, executable, &[]).unwrap();
            assert_eq!(status.cli_version.as_deref(), Some("codex-cli 2.0.0"));
            assert_eq!(plan.executable, cli);
            assert!(plan.arguments.is_empty());
            assert_eq!(env::split_paths(&plan.environment_path).next().unwrap(), home.join("environment"));
            assert_eq!(calls(&cli), ["--version"]);
            assert!(calls(&fallback).is_empty());
        });
    }

    #[test]
    fn codex_cli_failed_overrides_cannot_prepare_another_installation() {
        isolated_test("codex_cli_failed_overrides_cannot_prepare_another_installation", "broken/codex", |home| {
            let fallback = counted_fixture(&home.join("path"), "codex-cli 1.0.0");
            let broken = fixture(&home.join("broken"), "codex",
                "printf '%s\\n' \"$*\" >> \"$0.calls\"\nexit 1");
            let missing = home.join("missing");
            for manual in [Some(missing.as_path()), Some(broken.as_path()), None] {
                let (status, executable) = inspect_agent_config_and_executable(
                    AgentClient::Codex, home, 8317, "fixture-key", manual, None,
                );
                let error = prepare_codex_cli_launch(home, &status, executable, &[]).unwrap_err();
                assert!(error.contains("configured CLI path"), "{error}");
                assert!(calls(&fallback).is_empty());
            }
            assert_eq!(calls(&broken), ["--version", "--version"]);
        });
    }

    #[test]
    fn codex_cli_path_wins_and_private_desktop_bins_are_not_scanned() {
        let home = agent_test_home("codex-cli-private");
        let desktop_directory = home.join("AppData/Local/OpenAI/Codex/bin/private-version");
        let desktop = counted_fixture(&desktop_directory, "codex-cli 9.9.9");
        fixture(
            &desktop_directory,
            "codex.exe",
            "printf 'codex-cli 9.9.9\\n'",
        );
        let path_directory = home.join("terminal bin");
        let cli = counted_fixture(&path_directory, "codex-cli 1.2.3");
        let path = env::join_paths([&path_directory]).unwrap();
        let directories = agent_executable_directories_from_environment(
            &home,
            |name| (name == "PATH").then(|| path.clone()),
            &[],
        );
        let resolved = resolve_codex_cli_in_directories(&home, None, None, &directories)
            .unwrap()
            .unwrap();
        assert_eq!(resolved.path, cli);
        assert_eq!(resolved.version, "codex-cli 1.2.3");
        assert!(calls(&desktop).is_empty());
        fs::remove_file(&cli).unwrap();
        assert!(
            resolve_codex_cli_in_directories(&home, None, None, &directories)
                .unwrap()
                .is_none()
        );
        let explicit_path =
            resolve_codex_cli_in_directories(&home, None, None, &[desktop_directory])
                .unwrap()
                .unwrap();
        assert_eq!(explicit_path.path, desktop);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_cli_manual_then_environment_then_path_and_invalid_overrides_are_errors() {
        let home = agent_test_home("codex-cli-priority");
        let manual = counted_fixture(&home.join("manual bin"), "codex-cli 3.0.0");
        let environment = counted_fixture(&home.join("environment"), "codex-cli 2.0.0");
        let path = counted_fixture(&home.join("path"), "codex-cli 1.0.0");
        let directories = [path.parent().unwrap().to_path_buf()];
        let resolve = |manual: Option<&Path>, environment: Option<&Path>| {
            resolve_codex_cli_in_directories(&home, manual, environment, &directories)
        };
        assert_eq!(
            resolve(Some(&manual), Some(&environment))
                .unwrap()
                .unwrap()
                .path,
            manual
        );
        assert!(calls(&environment).is_empty());
        assert_eq!(
            resolve(None, Some(&environment)).unwrap().unwrap().path,
            environment
        );
        let broken = fixture(
            &home.join("broken"),
            "codex",
            "printf 'codex-cli 0.0.0\\n' >&2; exit 1",
        );
        assert!(resolve(Some(&broken), Some(&environment)).is_err());
        assert!(resolve(None, Some(&broken)).is_err());
        assert!(resolve(Some(&home.join("missing")), None).is_err());
        assert!(calls(&path).is_empty());
        assert_eq!(resolve(None, None).unwrap().unwrap().path, path);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_cli_skips_broken_shims_and_stops_at_first_valid_path_candidate() {
        let home = agent_test_home("codex-cli-shims");
        let broken = fixture(
            &home.join("broken"),
            "codex",
            "printf 'codex-cli 0.0.0\\n'; exit 1",
        );
        let first = counted_fixture(&home.join("first"), "codex-cli 1.0.0");
        let later = counted_fixture(&home.join("later"), "codex-cli 2.0.0");
        let directories =
            [&broken, &first, &later].map(|path| path.parent().unwrap().to_path_buf());
        let resolved = resolve_codex_cli_in_directories(&home, None, None, &directories)
            .unwrap()
            .unwrap();
        assert_eq!(resolved.path, first);
        assert_eq!(calls(&first), ["--version"]);
        assert!(calls(&later).is_empty());
        assert!(
            resolve_codex_cli_in_directories(&home, None, None, &directories[..1])
                .unwrap()
                .is_none()
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_cli_status_and_launch_preparation_share_one_probe_and_target() {
        isolated_test("codex_cli_status_and_launch_preparation_share_one_probe_and_target", "environment/codex", |home| {
            let cli = fixture(&home.join("CLI with spaces"), "codex",
                "printf '%s\\n' \"$*\" >> \"$0.calls\"\nnode \"$0\" \"$@\"");
            let node = fixture(&home.join(".nvm/versions/node/fixture/bin"), "node",
                "if [ \"$2\" = --version ]; then printf 'codex-cli 1.2.3\\n'; else printf 'launched:%s\\n' \"$1\"; shift; printf 'PATH:%s\\n' \"$PATH\"; printf 'arg:%s\\n' \"$@\"; fi");
            let environment = counted_fixture(&home.join("environment"), "codex-cli 2.0.0");
            let fallback = counted_fixture(&home.join("path"), "codex-cli 1.0.0");
            let (status, executable) = inspect_agent_config_and_executable(
                AgentClient::Codex, home, 8317, "fixture-key", Some(&cli), None,
            );
            assert_eq!(status.cli_version.as_deref(), Some("codex-cli 1.2.3"));
            assert!(status.launch_targets.iter().any(|target| target.id == "cli"));
            let arguments = vec!["fixture-launch".into(), "two words".into(), "&literal".into(), "\"quoted\"".into(), String::new()];
            let plan = prepare_codex_cli_launch(home, &status, executable, &arguments).unwrap();
            assert_eq!(plan.executable, cli);
            assert_eq!(plan.arguments, arguments);
            let directories = env::split_paths(&plan.environment_path).collect::<Vec<_>>();
            assert_eq!(directories[0], cli.parent().unwrap());
            assert_eq!(directories.iter().filter(|directory| *directory == cli.parent().unwrap()).count(), 1);
            assert!(directories.contains(&node.parent().unwrap().to_path_buf()));
            assert!(directories.contains(&home.join("path")));
            assert_eq!(calls(&cli), ["--version"]);
            let output = Command::new(&plan.executable)
                .args(&plan.arguments)
                .env_clear()
                .env("PATH", &plan.environment_path)
                .current_dir(home)
                .output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let mut expected = vec![format!("launched:{}", cli.display()), format!("PATH:{}", plan.environment_path.to_string_lossy())];
            expected.extend(arguments.iter().map(|argument| format!("arg:{argument}")));
            assert_eq!(String::from_utf8_lossy(&output.stdout).lines().collect::<Vec<_>>(), expected);
            assert_eq!(calls(&cli), ["--version", &arguments.join(" ")]);
            assert!(calls(&environment).is_empty());
            assert!(calls(&fallback).is_empty());
            println!("Shared production launch plan: one version probe, same executable, helper PATH and literal arguments verified by safe subprocess");
            print!("{}", String::from_utf8_lossy(&output.stdout));
        });
    }

    #[test]
    fn codex_cli_invalid_manual_path_is_visible_in_status_without_cli_target() {
        let home = agent_test_home("codex-cli-invalid-status");
        let (status, executable) = inspect_agent_config_and_executable(
            AgentClient::Codex,
            &home,
            8317,
            "fixture-key",
            Some(&home.join("missing")),
            None,
        );
        assert!(executable.is_none());
        assert!(status.cli_version.is_none());
        assert!(!status
            .launch_targets
            .iter()
            .any(|target| target.id == "cli"));
        assert!(status.error.unwrap().contains("configured CLI path"));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_cli_each_status_call_rechecks_file_and_each_resolution_rechecks_overrides() {
        let home = agent_test_home("codex-cli-refresh");
        let directory = home.join("bin");
        let cli = counted_fixture(&directory, "codex-cli 1.0.0");
        let status = || {
            inspect_agent_config_with_executables(
                AgentClient::Codex,
                &home,
                8317,
                "fixture-key",
                Some(&cli),
                None,
            )
        };
        assert_eq!(status().cli_version.as_deref(), Some("codex-cli 1.0.0"));
        counted_fixture(&directory, "codex-cli 2.0.0");
        assert_eq!(status().cli_version.as_deref(), Some("codex-cli 2.0.0"));
        assert_eq!(calls(&cli), ["--version", "--version"]);
        let other = counted_fixture(&home.join("other"), "codex-cli 3.0.0");
        assert_eq!(
            resolve_codex_cli_in_directories(&home, None, Some(&other), &[])
                .unwrap()
                .unwrap()
                .path,
            other
        );
        assert_eq!(
            resolve_codex_cli_in_directories(
                &home,
                None,
                None,
                &[other.parent().unwrap().into(), directory]
            )
            .unwrap()
            .unwrap()
            .path,
            other
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_cli_concurrent_calls_have_no_shared_or_stale_cache() {
        let home = agent_test_home("codex-cli-concurrent");
        let cli = counted_fixture(&home.join("bin"), "codex-cli 1.0.0");
        thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    let result = resolve_codex_cli_in_directories(&home, Some(&cli), None, &[])
                        .unwrap()
                        .unwrap();
                    assert_eq!(result.path, cli);
                    assert_eq!(result.version, "codex-cli 1.0.0");
                });
            }
        });
        assert_eq!(calls(&cli), vec!["--version"; 4]);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_cli_probes_accept_stdout_or_stderr_and_close_stdin() {
        let home = agent_test_home("codex-cli-output");
        for (name, stream) in [("stdout", ""), ("stderr", ">&2")] {
            let cli = fixture(
                &home.join(name),
                "codex",
                &format!("if read input; then exit 9; fi\nprintf 'codex-cli 1.2.3\\n' {stream}"),
            );
            assert_eq!(
                read_agent_version(&cli, &home).as_deref(),
                Some("codex-cli 1.2.3")
            );
        }
        let empty = fixture(&home.join("empty"), "codex", "exit 0");
        assert!(resolve_codex_cli_in_directories(&home, Some(&empty), None, &[]).is_err());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codex_cli_probe_keeps_five_second_timeout_and_skips_timed_out_candidate() {
        let home = agent_test_home("codex-cli-timeout");
        let slow = fixture(&home.join("slow"), "codex", "/bin/sleep 15");
        let valid = counted_fixture(&home.join("valid"), "codex-cli 1.0.0");
        let started = Instant::now();
        let result = resolve_codex_cli_in_directories(
            &home,
            None,
            None,
            &[
                slow.parent().unwrap().into(),
                valid.parent().unwrap().into(),
            ],
        )
        .unwrap()
        .unwrap();
        assert_eq!(result.path, valid);
        assert!(started.elapsed() >= Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(8));
        fs::remove_dir_all(home).unwrap();
    }
}
