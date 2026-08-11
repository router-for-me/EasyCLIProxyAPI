use super::support::*;
use super::*;

#[test]
fn core_restart_backoff_increases_and_caps_at_thirty_seconds() {
    assert_eq!(core_restart_delay(1), Duration::from_secs(1));
    assert_eq!(core_restart_delay(2), Duration::from_secs(2));
    assert_eq!(core_restart_delay(3), Duration::from_secs(5));
    assert_eq!(core_restart_delay(4), Duration::from_secs(10));
    assert_eq!(core_restart_delay(5), Duration::from_secs(30));
    assert_eq!(core_restart_delay(20), Duration::from_secs(30));
}

#[test]
fn core_restart_requires_persistent_intent_and_a_fully_stopped_core() {
    assert!(should_auto_restart_core(true, false, false));
    assert!(!should_auto_restart_core(false, false, false));
    assert!(!should_auto_restart_core(true, true, false));
    assert!(!should_auto_restart_core(true, false, true));
}

#[test]
fn core_restart_intent_can_be_disabled_before_an_intentional_stop() {
    let state = CoreProcessState::default();
    assert!(!state.auto_restart_enabled());

    state.set_auto_restart_enabled(true);
    assert!(state.auto_restart_enabled());

    state.set_auto_restart_enabled(false);
    assert!(!state.auto_restart_enabled());
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
