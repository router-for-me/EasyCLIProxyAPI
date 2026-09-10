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
        let paths = history_paths(client, &home).unwrap();
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
