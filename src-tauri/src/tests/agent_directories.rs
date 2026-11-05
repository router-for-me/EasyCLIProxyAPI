use super::support::*;
use super::*;

#[test]
fn custom_directories_resolve_files_and_restore_defaults_for_every_client() {
    let home = agent_test_home("custom-directories");
    for client in [
        AgentClient::ClaudeCode,
        AgentClient::ClaudeDesktop,
        AgentClient::Codex,
        AgentClient::OpenCode,
        AgentClient::OpenClaw,
        AgentClient::Hermes,
        AgentClient::DeepSeekHarness,
        AgentClient::WorkBuddy,
        AgentClient::AntigravityCli,
        AgentClient::CopilotCli,
        AgentClient::VscodeCopilot,
        AgentClient::ZCode,
        AgentClient::KimiCode,
        AgentClient::GrokBuild,
        AgentClient::Omp,
    ] {
        let original = agent_config_paths(client, &home);
        let directory = home.join("custom").join(client.id());
        let directories = [(client.id().to_string(), path_to_string(&directory))]
            .into_iter()
            .collect();
        AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
            let paths = agent_config_paths(client, &home);
            assert!(!paths.is_empty());
            assert!(
                paths.iter().all(|path| path.starts_with(&directory)),
                "{}: {paths:?}",
                client.id()
            );
            if client.supported_platform() {
                assert!(config_paths(client.id(), &home)
                    .unwrap()
                    .iter()
                    .all(|path| path.starts_with(&directory)));
            }
        });
        assert_eq!(agent_config_paths(client, &home), original);
    }
    let directory = home.join("pi-custom");
    AGENT_CONFIG_DIRECTORIES.sync_scope(
        [("pi".into(), path_to_string(&directory))]
            .into_iter()
            .collect(),
        || {
            assert_eq!(
                pi_provider_config_path(&home),
                directory.join(PI_AGENT_CONFIG_FILE)
            );
            assert_eq!(
                pi_provider_settings_path(&home),
                directory.join(PI_AGENT_SETTINGS_FILE)
            );
            assert!(pi_provider_models_cache_path(&home).starts_with(&directory));
        },
    );
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn custom_directory_preserves_legacy_and_jsonc_selection() {
    let home = agent_test_home("custom-directory-formats");
    let directory = home.join("custom");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("claude.json"), "{}").unwrap();
    fs::write(directory.join("opencode.jsonc"), "{ /* keep */ }").unwrap();
    let directories = ["claude-code", "opencode"]
        .into_iter()
        .map(|client| (client.to_string(), path_to_string(&directory)))
        .collect();
    AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
        assert_eq!(
            agent_config_paths(AgentClient::ClaudeCode, &home),
            vec![directory.join("claude.json")]
        );
        assert_eq!(
            opencode_config_path(&home),
            directory.join("opencode.jsonc")
        );
    });
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn custom_directory_apply_backup_and_clear_leave_host_configuration_untouched() {
    let home = agent_test_home("custom-directory-transaction");
    let directory = home.join("wsl-home/.claude");
    fs::create_dir_all(&directory).unwrap();
    let custom_path = directory.join("settings.json");
    let original = r#"{"env":{"KEEP":"yes"},"permissions":{"allow":[]}}"#;
    fs::write(&custom_path, original).unwrap();
    let host_path = home.join(".claude/settings.json");
    fs::create_dir_all(host_path.parent().unwrap()).unwrap();
    fs::write(&host_path, "host configuration").unwrap();
    let directories = [("claude-code".into(), path_to_string(&directory))]
        .into_iter()
        .collect();
    AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
        let backup = create_backup("claude-code", &home).unwrap();
        apply_agent_configuration(
            AgentClient::ClaudeCode,
            &home,
            8317,
            "test-key",
            "test-model",
            &test_agent_models(&["test-model"]),
            None,
        )
        .unwrap();
        let rendered = fs::read_to_string(&custom_path).unwrap();
        assert!(rendered.contains("test-key"));
        assert!(rendered.contains("KEEP"));
        test_restore_backup(AgentClient::ClaudeCode, &home, &backup.id);
        let restored: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&custom_path).unwrap()).unwrap();
        assert_eq!(
            restored,
            serde_json::from_str::<serde_json::Value>(original).unwrap()
        );
        apply_agent_configuration(
            AgentClient::ClaudeCode,
            &home,
            8317,
            "test-key",
            "test-model",
            &test_agent_models(&["test-model"]),
            None,
        )
        .unwrap();
        create_backup("claude-code", &home).unwrap();
        assert!(test_backup_count(AgentClient::ClaudeCode, &home) > 0);
        clear_agent_managed_configuration(AgentClient::ClaudeCode, &home, 8317).unwrap();
        let restored: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&custom_path).unwrap()).unwrap();
        assert_eq!(
            restored,
            serde_json::from_str::<serde_json::Value>(original).unwrap()
        );
    });
    assert_eq!(fs::read_to_string(host_path).unwrap(), "host configuration");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn directory_validation_rejects_relative_parent_and_file_paths() {
    let home = agent_test_home("directory-validation");
    let file = home.join("file");
    fs::write(&file, "{}").unwrap();
    for path in [
        "relative".to_string(),
        path_to_string(&home.join("../escape")),
        path_to_string(&file),
    ] {
        assert!(validate_agent_config_directories(Some(
            [("codex".into(), path)].into_iter().collect()
        ))
        .is_err());
    }
    let valid = validate_agent_config_directories(Some(
        [
            ("codex".into(), format!(" {} ", home.display())),
            ("pi".into(), " ".into()),
        ]
        .into_iter()
        .collect(),
    ))
    .unwrap();
    assert_eq!(valid.len(), 1);
    assert_eq!(valid["codex"], path_to_string(&home));
    fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn directory_overrides_are_isolated_between_concurrent_requests() {
    let first = [("codex".into(), "first".into())].into_iter().collect();
    let second = [("codex".into(), "second".into())].into_iter().collect();
    tokio::join!(
        AGENT_CONFIG_DIRECTORIES.scope(first, async {
            tokio::task::yield_now().await;
            assert_eq!(
                agent_config_directory("codex"),
                Some(PathBuf::from("first"))
            );
        }),
        AGENT_CONFIG_DIRECTORIES.scope(second, async {
            tokio::task::yield_now().await;
            assert_eq!(
                agent_config_directory("codex"),
                Some(PathBuf::from("second"))
            );
        }),
    );
    assert_eq!(agent_config_directory("codex"), None);
}

#[test]
fn wsl_unc_detection_matches_only_wsl_servers() {
    for path in [
        r"\\wsl$\Ubuntu\home\user\.claude",
        r"\\WSL.LOCALHOST\Debian\home\user",
        r"\\?\UNC\wsl$\Ubuntu\home\user",
        "//wsl.localhost/Ubuntu/home/user",
    ] {
        assert!(is_wsl_path(Path::new(path)), "{path}");
    }
    for path in [
        r"C:\Users\user",
        r"\\server\share",
        r"\\wsl$.example\share",
        r"\\wsl$\",
        "/home/user",
    ] {
        assert!(!is_wsl_path(Path::new(path)), "{path}");
    }
}

#[test]
fn atomic_configuration_write_replaces_existing_contents() {
    let home = agent_test_home("directory-atomic-write");
    let path = home.join("custom/settings.json");
    write_bytes_atomically(&path, b"old").unwrap();
    write_bytes_atomically(&path, b"new").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    fs::remove_dir_all(home).unwrap();
}

#[cfg(windows)]
#[test]
#[ignore = "Requires a writable WSL UNC directory in ECPA_TEST_WSL_CONFIG_ROOT"]
fn atomic_configuration_write_replaces_existing_wsl_unc_file() {
    let root = PathBuf::from(env::var_os("ECPA_TEST_WSL_CONFIG_ROOT").unwrap());
    assert!(is_wsl_path(&root));
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = root.join(format!("ecpa-write-test-{}-{unique}", std::process::id()));
    let path = directory.join("settings.json");
    write_bytes_atomically(&path, b"old").unwrap();
    write_bytes_atomically(&path, b"new").unwrap();
    assert_eq!(fs::read(path).unwrap(), b"new");
    fs::remove_dir_all(directory).unwrap();
}
