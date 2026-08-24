use super::support::*;
use super::*;

#[test]
fn core_process_starting_state_tracks_automatic_launch() {
    let state = CoreProcessState::new(true);
    assert!(state.is_starting());
    state.set_starting(false);
    assert!(!state.is_starting());
}

#[test]
fn executable_path_matching_keeps_core_instances_directory_scoped() {
    let root = agent_test_home("core-process-path-scope");
    let first_dir = root.join("first").join("cpa-core");
    let second_dir = root.join("second").join("cpa-core");
    fs::create_dir_all(&first_dir).unwrap();
    fs::create_dir_all(&second_dir).unwrap();
    let first_binary = first_dir.join(core_binary_name());
    let second_binary = second_dir.join(core_binary_name());
    fs::write(&first_binary, b"first").unwrap();
    fs::write(&second_binary, b"second").unwrap();

    assert!(executable_paths_match(&first_binary, &first_binary));
    assert!(!executable_paths_match(&first_binary, &second_binary));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn core_process_discovery_sleep_helper() {
    if env::var_os("EASYCLIPROXYAPI_PROCESS_DISCOVERY_TEST_HELPER").is_some() {
        thread::sleep(Duration::from_secs(10));
    }
}

#[test]
fn running_core_process_discovery_ignores_the_same_binary_name_in_another_directory() {
    let root = agent_test_home("running-core-process-scope");
    let first_dir = root.join("first").join("cpa-core");
    let second_dir = root.join("second").join("cpa-core");
    fs::create_dir_all(&first_dir).unwrap();
    fs::create_dir_all(&second_dir).unwrap();
    let first_binary = first_dir.join(core_binary_name());
    let second_binary = second_dir.join(core_binary_name());

    let source_binary = env::current_exe().unwrap();
    fs::copy(&source_binary, &first_binary).unwrap();
    fs::copy(&source_binary, &second_binary).unwrap();
    let arguments = [
        "--exact",
        "tests::core_runtime::core_process_discovery_sleep_helper",
        "--nocapture",
    ];
    let mut first = Command::new(&first_binary)
        .args(&arguments)
        .env("EASYCLIPROXYAPI_PROCESS_DISCOVERY_TEST_HELPER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut second = Command::new(&second_binary)
        .args(&arguments)
        .env("EASYCLIPROXYAPI_PROCESS_DISCOVERY_TEST_HELPER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_millis(200));

    let first_running = first.try_wait().unwrap().is_none();
    let second_running = second.try_wait().unwrap().is_none();
    let candidate_process_ids = find_candidate_core_process_ids();
    let first_actual_path = process_executable_path(first.id());
    let second_actual_path = process_executable_path(second.id());
    let first_matches = find_core_process_ids(&first_binary);
    let second_matches = find_core_process_ids(&second_binary);

    let _ = first.kill();
    let _ = second.kill();
    let _ = first.wait();
    let _ = second.wait();
    assert_eq!(
        first_matches,
        vec![first.id()],
        "running={first_running}, candidate={}, actual={first_actual_path:?}, expected={first_binary:?}",
        candidate_process_ids.contains(&first.id())
    );
    assert_eq!(
        second_matches,
        vec![second.id()],
        "running={second_running}, candidate={}, actual={second_actual_path:?}, expected={second_binary:?}",
        candidate_process_ids.contains(&second.id())
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn current_process_executable_path_can_be_resolved() {
    let expected = env::current_exe().unwrap();
    let actual = process_executable_path(std::process::id()).unwrap();
    assert!(executable_paths_match(&expected, &actual));
}

#[test]
fn core_process_state_tracks_and_releases_adopted_processes() {
    let state = CoreProcessState::new(false);
    let binary_path = env::current_exe().unwrap();
    state
        .adopt_process_ids(&binary_path, vec![std::process::id(), std::process::id()])
        .unwrap();

    assert_eq!(state.managed_pid(), Some(std::process::id()));
    assert_eq!(
        state
            .take_adopted_processes()
            .into_iter()
            .map(|process| process.process_id)
            .collect::<Vec<_>>(),
        vec![std::process::id()]
    );
    assert_eq!(state.managed_pid(), None);
}

#[test]
fn successful_core_install_remains_successful_when_restart_succeeds() {
    let result = combine_install_and_restart_results(Ok("installed"), Ok(()));
    assert_eq!(result.unwrap(), "installed");
}

#[test]
fn successful_core_install_reports_automatic_restart_failure() {
    let result = combine_install_and_restart_results(Ok("installed"), Err("port busy".into()));
    assert_eq!(
        result.unwrap_err(),
        "内核已安装，但自动恢复运行失败: port busy"
    );
}

#[test]
fn failed_core_install_keeps_the_install_error_after_runtime_is_restored() {
    let result =
        combine_install_and_restart_results::<()>(Err("download cancelled".into()), Ok(()));
    assert_eq!(result.unwrap_err(), "download cancelled");
}

#[test]
fn failed_core_install_reports_restart_failure_too() {
    let result = combine_install_and_restart_results::<()>(
        Err("checksum mismatch".into()),
        Err("port busy".into()),
    );
    assert_eq!(
        result.unwrap_err(),
        "checksum mismatch；自动恢复原内核运行状态也失败: port busy"
    );
}

#[test]
fn replacing_a_core_preserves_only_regular_bundled_assets() {
    let root = agent_test_home("bundled-assets");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(
        source.join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz"),
        b"archive",
    )
    .unwrap();
    fs::write(
        source.join("CLIProxyAPI_7.2.83_linux_amd64_no-plugin.tar.gz"),
        b"portable",
    )
    .unwrap();
    fs::write(source.join(CORE_CHECKSUMS_FILE), b"checksums").unwrap();

    preserve_bundled_core_assets(&source, &target).unwrap();

    assert!(target
        .join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz")
        .is_file());
    assert!(!target
        .join("CLIProxyAPI_7.2.83_linux_amd64_no-plugin.tar.gz")
        .exists());
    assert!(target.join(CORE_CHECKSUMS_FILE).is_file());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn overlaying_a_core_updates_packaged_files_and_preserves_plugins() {
    let root = agent_test_home("core-overlay-preserves-plugins");
    let install_dir = root.join("cpa-core");
    let staging_dir = root.join("cpa-core.staging");
    fs::create_dir_all(install_dir.join("plugins/custom-router")).unwrap();
    fs::create_dir_all(staging_dir.join("plugins/bundled-router")).unwrap();
    fs::create_dir_all(staging_dir.join("runtime")).unwrap();
    fs::write(install_dir.join(core_binary_name()), b"old core").unwrap();
    fs::write(install_dir.join("README.md"), b"old readme").unwrap();
    fs::write(install_dir.join("user-data.json"), b"user data").unwrap();
    fs::write(
        install_dir.join("plugins/custom-router/plugin.js"),
        b"custom plugin",
    )
    .unwrap();
    fs::write(staging_dir.join(core_binary_name()), b"new core").unwrap();
    fs::write(staging_dir.join("README.md"), b"new readme").unwrap();
    fs::write(
        staging_dir.join("plugins/bundled-router/plugin.js"),
        b"bundled plugin",
    )
    .unwrap();
    fs::write(staging_dir.join("runtime/default.json"), b"new runtime").unwrap();

    overlay_install_dir(&install_dir, &staging_dir).unwrap();

    assert_eq!(
        fs::read(install_dir.join(core_binary_name())).unwrap(),
        b"new core"
    );
    assert_eq!(
        fs::read(install_dir.join("README.md")).unwrap(),
        b"new readme"
    );
    assert_eq!(
        fs::read(install_dir.join("runtime/default.json")).unwrap(),
        b"new runtime"
    );
    assert_eq!(
        fs::read(install_dir.join("plugins/custom-router/plugin.js")).unwrap(),
        b"custom plugin"
    );
    assert_eq!(
        fs::read(install_dir.join("plugins/bundled-router/plugin.js")).unwrap(),
        b"bundled plugin"
    );
    assert_eq!(
        fs::read(install_dir.join("user-data.json")).unwrap(),
        b"user data"
    );
    assert!(!staging_dir.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn installing_a_core_into_a_missing_directory_moves_the_complete_staging_tree() {
    let root = agent_test_home("core-overlay-first-install");
    let install_dir = root.join("cpa-core");
    let staging_dir = root.join("cpa-core.staging");
    fs::create_dir_all(&staging_dir).unwrap();
    fs::write(staging_dir.join(core_binary_name()), b"new core").unwrap();
    fs::write(staging_dir.join(CORE_EXAMPLE_CONFIG_FILE), b"port: 8317\n").unwrap();

    overlay_install_dir(&install_dir, &staging_dir).unwrap();

    assert_eq!(
        fs::read(install_dir.join(core_binary_name())).unwrap(),
        b"new core"
    );
    assert!(install_dir.join(CORE_EXAMPLE_CONFIG_FILE).is_file());
    assert!(!staging_dir.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn replacing_a_core_migrates_old_fields_into_the_new_template() {
    let root = agent_test_home("core-config-migrate");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    let old_config = "# Old comment\nhost: 127.0.0.1\nport: 9527\nnested:\n  keep: old\n  old-only: retained\nlist:\n  - old-a\n  - old-b\nextra: true\n";
    let new_template = "# New template\nhost: \"\"\nport: 8317\nnested:\n  keep: new-default\n  added: new-field\nlist:\n  - new-default\nnew-option: true\n";
    fs::write(source.join(CORE_CONFIG_FILE), old_config).unwrap();
    fs::write(target.join(CORE_EXAMPLE_CONFIG_FILE), new_template).unwrap();

    migrate_core_config_for_update(&source, &target).unwrap();

    let migrated = fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&migrated).unwrap();
    assert!(migrated.contains("# New template"));
    assert_eq!(document["host"], "127.0.0.1");
    assert_eq!(document["port"], 9527);
    assert_eq!(document["nested"]["keep"], "old");
    assert_eq!(document["nested"]["added"], "new-field");
    assert_eq!(document["nested"]["old-only"], "retained");
    assert_eq!(document["list"][0], "old-a");
    assert_eq!(document["list"][1], "old-b");
    assert_eq!(document["new-option"], true);
    assert_eq!(document["extra"], true);
    assert_eq!(
        fs::read_to_string(target.join(CORE_EXAMPLE_CONFIG_FILE)).unwrap(),
        new_template
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn replacing_a_core_discards_invalid_fields_and_continues_migration() {
    let root = agent_test_home("core-config-migrate-invalid");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    fs::write(
        source.join(CORE_CONFIG_FILE),
        "host: 127.0.0.1\nbroken: [invalid\nport: 9527\napi-keys:\n- old-a\n- old-b\n",
    )
    .unwrap();
    fs::write(
            target.join(CORE_EXAMPLE_CONFIG_FILE),
            "host: \"\"\nbroken: new-default\nport: 8317\napi-keys:\n  - new-default\nnew-option: true\n",
        )
        .unwrap();
    fs::write(target.join(CORE_CONFIG_FILE), "staged: untouched\n").unwrap();

    migrate_core_config_for_update(&source, &target).unwrap();

    let migrated = fs::read_to_string(target.join(CORE_CONFIG_FILE)).unwrap();
    let document = serde_norway::from_str::<serde_norway::Value>(&migrated).unwrap();
    assert_eq!(document["host"], "127.0.0.1");
    assert_eq!(document["broken"], "new-default");
    assert_eq!(document["port"], 9527);
    assert_eq!(document["api-keys"][0], "old-a");
    assert_eq!(document["api-keys"][1], "old-b");
    assert_eq!(document["new-option"], true);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn bundled_core_bootstrap_runs_only_when_no_core_binary_exists() {
    let root = agent_test_home("bundled-bootstrap-detection");
    let install_dir = root.join("cpa-core");

    assert!(core_needs_bundled_bootstrap(&install_dir));

    let existing_version = install_dir.join("existing-version");
    fs::create_dir_all(&existing_version).unwrap();
    fs::write(existing_version.join(core_binary_name()), b"existing core").unwrap();

    assert!(!core_needs_bundled_bootstrap(&install_dir));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn bundled_core_locations_include_macos_app_resources() {
    let contents_dir = agent_test_home("bundled-macos-resources")
        .join("EasyCLIProxyAPI.app")
        .join("Contents");
    let executable_dir = contents_dir.join("MacOS");
    let base_dir = agent_test_home("bundled-macos-data");
    let resource_location = (
        contents_dir.join("Resources").join(CORE_VERSION_FILE),
        contents_dir.join("Resources").join("cpa-core"),
    );

    assert_eq!(
        macos_app_resources_dir(&executable_dir),
        Some(contents_dir.join("Resources"))
    );
    assert!(bundled_core_locations(&base_dir, &executable_dir).contains(&resource_location));
}

#[test]
fn source_project_root_is_detected_from_the_portable_development_directory() {
    let root = agent_test_home("bundled-source-root");
    fs::create_dir_all(root.join("src-tauri")).unwrap();
    fs::create_dir_all(root.join("bin-work")).unwrap();
    fs::write(root.join("package.json"), b"{}").unwrap();

    assert_eq!(
        source_project_root(&root.join("bin-work")),
        Some(root.clone())
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn selected_source_archive_and_checksums_are_copied_into_the_installation() {
    let root = agent_test_home("selected-bundled-asset");
    let source = root.join("source");
    let target = root.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    let archive = source.join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz");
    fs::write(&archive, b"archive").unwrap();
    fs::write(source.join(CORE_CHECKSUMS_FILE), b"checksums").unwrap();

    preserve_selected_bundled_core_asset(&archive, &target).unwrap();

    assert_eq!(
        fs::read(target.join("CLIProxyAPI_7.2.83_linux_amd64.tar.gz")).unwrap(),
        b"archive"
    );
    assert_eq!(
        fs::read(target.join(CORE_CHECKSUMS_FILE)).unwrap(),
        b"checksums"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn release_page_assets_parse_download_links_and_sha256() {
    let html = r#"
          <li><a href="/router-for-me/CLIProxyAPI/releases/download/v1.2.3/checksums.txt">checksums.txt</a></li>
          <li><a href="/router-for-me/CLIProxyAPI/releases/download/v1.2.3/CLIProxyAPI_1.2.3_linux_amd64.tar.gz">asset</a>
            <span>sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef</span>
          </li>
        "#;

    let assets = parse_release_assets(html);
    assert_eq!(assets.len(), 2);
    assert_eq!(assets[1].name, "CLIProxyAPI_1.2.3_linux_amd64.tar.gz");
    assert_eq!(
        assets[1].digest.as_deref(),
        Some("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
    );
    assert!(assets[1]
        .browser_download_url
        .ends_with("/releases/download/v1.2.3/CLIProxyAPI_1.2.3_linux_amd64.tar.gz"));
}
