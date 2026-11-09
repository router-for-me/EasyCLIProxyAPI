use super::support::*;
use super::*;

#[test]
fn image_generation_preference_round_trips_without_leaking_into_kernel_yaml() {
    let home = agent_test_home("image-generation-preference");
    let path = home.join("config.toml");
    let mut config: GuiConfigFile = toml::from_str("").unwrap();
    assert!(!config.image_generation_user_selected);
    write_gui_config_to_path(&config, &path).unwrap();
    assert!(!fs::read_to_string(&path).unwrap().contains("image-generation-user-selected"));
    config.image_generation_user_selected = true;
    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.contains("image-generation-user-selected = true"));
    let restored: GuiConfigFile = toml::from_str(&content).unwrap();
    assert!(restored.image_generation_user_selected);
    let template = "config-version: 8\nmultimedia: {disable-image-generation: false}\napi-keys: {codex: [{keys: [{api-key: test-key}]}]}\n";
    let merged = merge_core_config_yaml(template, Some(template), &restored).unwrap();
    let document: serde_norway::Value = serde_norway::from_str(&merged).unwrap();
    assert_eq!(document["multimedia"]["disable-image-generation"], false);
    assert!(!merged.contains("image-generation-user-selected"));
    config.image_generation_user_selected = false;
    write_gui_config_to_path(&config, &path).unwrap();
    assert!(!fs::read_to_string(&path).unwrap().contains("image-generation-user-selected"));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn usage_statistics_opt_out_is_removed_when_reenabled() {
    let home = agent_test_home("usage-opt-out");
    let path = home.join("config.toml");
    let mut config = GuiConfigFile::default();
    config.usage_statistics_disabled = Some(true);
    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.contains("usage_statistics_disabled = true"));
    let restored: GuiConfigFile = toml::from_str(&content).unwrap();
    assert_eq!(restored.usage_statistics_disabled, Some(true));
    config.usage_statistics_disabled = None;
    write_gui_config_to_path(&config, &path).unwrap();
    assert!(!fs::read_to_string(&path).unwrap().contains("usage_statistics_disabled"));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn usage_statistics_startup_repairs_stale_values_unless_explicitly_disabled() {
    for preference in ["", "usage_statistics_disabled = false\n", "usage_statistics_disabled = true\n"] {
        let config: GuiConfigFile = toml::from_str(&format!("usage-statistics-enabled = false\n{preference}")).unwrap();
        for template in ["usage-statistics-enabled: false\n", "config-version: 8\nobservability: {usage: {usage-statistics-enabled: false}}\n"] {
            for current in [None, Some("usage-statistics-enabled: false\n"), Some(template)] {
                let merged = merge_core_config_yaml(template, current, &config).unwrap();
                let document = serde_norway::from_str(&merged).unwrap();
                let settings = core_config_settings_from_value(&document).unwrap();
                assert_eq!(settings.usage_statistics_enabled, config.usage_statistics_disabled != Some(true));
                assert!(!merged.contains("usage_statistics_disabled"));
            }
        }
    }
}

#[test]
fn gui_field_edit_preserves_comments_and_unknown_configuration() {
    let home = agent_test_home("gui-field-edit");
    let path = home.join("config.toml");
    fs::write(
            &path,
            "# keep this comment\ncustom-option = \"keep\"\ncodex-session-repair-on-launch = true\nclaude-code-working-directory = \"legacy\"\nclaude-code-working-directory-prompt-disabled = true\nport = 7000\n\n[third-party]\nenabled = true\n",
        )
        .unwrap();
    let config = GuiConfigFile {
        port: 9527,
        host: "0.0.0.0".to_string(),
        allow_lan: true,
        silent_start: true,
        auth_dir: path_to_string(&home.join("custom-auth")),
        management_secret_key: "custom-secret".to_string(),
        usage_statistics_enabled: false,
        disable_cooling: true,
        download_source: VersionDownloadSource::Gitcode,
        prefer_gitcode_downloads: true,
        ..GuiConfigFile::default()
    };

    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.contains("# keep this comment"));
    assert!(content.contains("custom-option = \"keep\""));
    assert!(content.contains("[third-party]"));
    assert!(content.contains("port = 9527"));
    assert!(content.contains("host = \"0.0.0.0\""));
    assert!(content.contains("silent-start = true"));
    assert!(content.contains("management-secret-key = \"custom-secret\""));
    assert!(content.contains("usage-statistics-enabled = false"));
    assert!(content.contains("disable-cooling = true"));
    assert!(content.contains("download-source = \"gitcode\""));
    assert!(content.contains("prefer-gitcode-downloads = true"));
    assert!(!content.contains("codex-session-repair-on-launch"));
    assert!(!content.contains("claude-code-working-directory"));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn software_write_hash_suppresses_only_the_matching_file_content() {
    let home = agent_test_home("write-hash");
    let path = home.join("config.toml");
    write_bytes_directly(&path, b"port = 8317\n").unwrap();
    assert!(consume_software_write(&path));
    assert!(!consume_software_write(&path));
    write_bytes_directly(&path, b"port = 8317\n").unwrap();
    fs::write(&path, b"port = 9000\n").unwrap();
    assert!(!consume_software_write(&path));
    fs::write(&path, b"port = 8317\n").unwrap();
    assert!(!consume_software_write(&path));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn configuration_watcher_uses_the_nearest_existing_parent() {
    let home = agent_test_home("watch-parent");
    let target = home.join("nested/client/config.json");

    assert_eq!(
        nearest_existing_watch_directory(&target),
        Some(home.clone())
    );
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    assert_eq!(
        nearest_existing_watch_directory(&target),
        target.parent().map(Path::to_path_buf)
    );

    fs::remove_dir_all(home).unwrap();
}

#[test]
fn gui_config_defaults_are_stable() {
    let config = GuiConfigFile::default();
    let content = toml::to_string_pretty(&config).unwrap();

    assert!(content.contains("port = 8317"));
    assert!(content.contains("allow-lan = false"));
    assert!(content.contains("run-on-startup = false"));
    assert!(content.contains("start-core-on-launch = true"));
    assert!(content.contains("silent-start = false"));
    assert!(content.contains("close-behavior = \"ask\""));
    assert!(content.contains("default-terminal = \"auto\""));
    assert_eq!(config.default_terminal, DEFAULT_AGENT_TERMINAL);
    assert!(content.contains("window-width = 1280"));
    assert!(content.contains("window-height = 800"));
    assert!(content.contains("auth-dir = \"../oauth\""));
    assert!(content.contains("[[api-keys]]"));
    assert!(content.contains("key = \"123456\""));
    assert!(content.contains("remark = \"Default key\""));
    assert!(content.contains(&format!("management-secret-key = \"{LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY}\"")));
    assert!(content.contains("plugins-enabled = true"));
    assert!(content.contains("routing-strategy = \"round-robin\""));
    assert!(content.contains("download-source = \"github\""));
    assert!(content.contains("prefer-gitcode-downloads = false"));
    assert!(content.contains("request-retry = 3"));
    assert!(content.contains("max-retry-credentials = 0"));
    assert!(content.contains("max-retry-interval = 30"));
    assert!(content.contains("transient-error-cooldown-seconds = -1"));
    assert_eq!(
        config.transient_error_cooldown_seconds,
        DEFAULT_TRANSIENT_ERROR_COOLDOWN_SECONDS
    );
    assert!(content.contains("streaming-bootstrap-retries = 0"));
}

#[test]
fn gui_window_size_round_trips_through_portable_config() {
    let config = GuiConfigFile {
        window_width: Some(1440),
        window_height: Some(900),
        ..GuiConfigFile::default()
    };

    let content = toml::to_string_pretty(&config).unwrap();
    let restored = toml::from_str::<GuiConfigFile>(&content).unwrap();

    assert!(content.contains("window-width = 1440"));
    assert!(content.contains("window-height = 900"));
    assert_eq!(
        configured_window_size(&restored),
        Some(SavedWindowSize {
            width: 1440,
            height: 900,
        })
    );
}

#[test]
fn silent_start_defaults_off_and_requires_tray_support() {
    let legacy = toml::from_str::<GuiConfigFile>("port = 8317\n").unwrap();
    assert!(legacy.start_core_on_launch);
    assert!(!legacy.silent_start);
    assert!(!should_start_hidden(&legacy));

    let enabled = GuiConfigFile {
        silent_start: true,
        ..GuiConfigFile::default()
    };
    let desktop = cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    ));
    assert_eq!(should_start_hidden_for_launch(&enabled, true), desktop);
    assert_eq!(
        should_start_hidden_for_launch(&enabled, false),
        desktop && !cfg!(target_os = "linux"),
        "on Linux a launch from the app menu or a shortcut must show the window"
    );
    assert!(!should_start_hidden_for_launch(&legacy, true));
}

#[test]
fn gui_window_position_round_trips_and_can_be_cleared_in_portable_config() {
    let home = agent_test_home("window-position");
    let path = home.join("config.toml");
    fs::write(&path, "# retained\ncustom-option = 'keep'\n").unwrap();
    let mut config = GuiConfigFile {
        window_x: Some(-1800),
        window_y: Some(120),
        ..GuiConfigFile::default()
    };
    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.contains("window-x = -1800"));
    assert!(content.contains("window-y = 120"));
    assert!(content.contains("# retained"));
    assert!(content.contains("custom-option = 'keep'"));
    let restored: GuiConfigFile = toml::from_str(&content).unwrap();
    assert_eq!(
        configured_window_position(&restored),
        Some(tauri::PhysicalPosition::new(-1800, 120))
    );

    config.window_x = None;
    config.window_y = None;
    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(!content.contains("window-x"));
    assert!(!content.contains("window-y"));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn gui_window_position_is_optional_and_requires_both_coordinates() {
    let mut config: GuiConfigFile = toml::from_str("port = 8317\n").unwrap();
    assert_eq!(configured_window_position(&config), None);
    for (x, y) in [(Some(0), None), (None, Some(-100))] {
        config.window_x = x;
        config.window_y = y;
        assert_eq!(configured_window_position(&config), None);
        assert!(sanitize_gui_config(&mut config).unwrap());
        assert_eq!((config.window_x, config.window_y), (None, None));
    }
    config.window_x = Some(0);
    config.window_y = Some(0);
    assert_eq!(
        configured_window_position(&config),
        Some(tauri::PhysicalPosition::new(0, 0))
    );
}

#[test]
fn saved_window_position_preserves_negative_monitor_coordinates_and_uses_work_area() {
    let work_area = tauri::PhysicalRect {
        position: tauri::PhysicalPosition::new(-2560, -200),
        size: tauri::PhysicalSize::new(2560, 1400),
    };
    // Physical dimensions also cover a window on a display with fractional DPI scaling.
    let size = tauri::PhysicalSize::new(1600, 1000);
    for (saved, expected) in [
        ((-2400, -100), (-2400, -100)),
        ((-500, 800), (-1600, 200)),
        ((-3000, -400), (-2560, -200)),
    ] {
        assert_eq!(
            fit_window_position_to_work_area(tauri::PhysicalPosition::new(saved.0, saved.1), size, &work_area),
            tauri::PhysicalPosition::new(expected.0, expected.1)
        );
    }
}

#[test]
fn saved_window_position_recovers_from_disconnected_displays_and_oversized_windows() {
    let work_area = tauri::PhysicalRect {
        position: tauri::PhysicalPosition::new(0, 40),
        size: tauri::PhysicalSize::new(1920, 1040),
    };
    assert_eq!(
        fit_window_position_to_work_area(
            tauri::PhysicalPosition::new(4000, 3000),
            tauri::PhysicalSize::new(1280, 800),
            &work_area,
        ),
        tauri::PhysicalPosition::new(640, 280)
    );
    assert_eq!(
        fit_window_position_to_work_area(
            tauri::PhysicalPosition::new(i32::MIN, i32::MAX),
            tauri::PhysicalSize::new(u32::MAX, u32::MAX),
            &work_area,
        ),
        work_area.position
    );
}

#[test]
fn restore_window_position_uses_target_display_scale_factor_on_mixed_dpi_displays() {
    let external_work_area = tauri::PhysicalRect {
        position: tauri::PhysicalPosition::new(1512, -458),
        size: tauri::PhysicalSize::new(2560, 1440),
    };
    let external_window_size = tauri::PhysicalSize::new(2081, 1170);
    let (fitted, target) = restore_window_position_for_monitor(
        tauri::PhysicalPosition::new(1688, -330),
        external_window_size,
        &external_work_area,
        1.0,
    );
    assert_eq!(fitted, tauri::PhysicalPosition::new(1688, -330));
    #[cfg(target_os = "macos")]
    assert_eq!(
        target,
        tauri::Position::Logical(tauri::LogicalPosition::new(1688.0, -330.0))
    );
    #[cfg(not(target_os = "macos"))]
    assert_eq!(
        target,
        tauri::Position::Physical(tauri::PhysicalPosition::new(1688, -330))
    );

    let retina_work_area = tauri::PhysicalRect {
        position: tauri::PhysicalPosition::new(0, 0),
        size: tauri::PhysicalSize::new(3024, 1964),
    };
    let retina_window_size = tauri::PhysicalSize::new(2400, 1600);
    let (fitted_retina, target_retina) = restore_window_position_for_monitor(
        tauri::PhysicalPosition::new(300, 160),
        retina_window_size,
        &retina_work_area,
        2.0,
    );
    assert_eq!(fitted_retina, tauri::PhysicalPosition::new(300, 160));
    #[cfg(target_os = "macos")]
    assert_eq!(
        target_retina,
        tauri::Position::Logical(tauri::LogicalPosition::new(150.0, 80.0))
    );
    #[cfg(not(target_os = "macos"))]
    assert_eq!(
        target_retina,
        tauri::Position::Physical(tauri::PhysicalPosition::new(300, 160))
    );
}

#[test]
fn core_start_on_launch_defaults_on_and_can_be_disabled() {
    let legacy = toml::from_str::<GuiConfigFile>("port = 8317\n").unwrap();
    assert!(should_start_core_on_launch(&legacy));

    let disabled = GuiConfigFile {
        start_core_on_launch: false,
        run_on_startup: false,
        ..GuiConfigFile::default()
    };
    assert!(!should_start_core_on_launch(&disabled));
}

#[test]
fn core_start_on_launch_restores_previous_running_state() {
    for start_core_on_launch in [false, true] {
        for run_on_startup in [false, true] {
            let config = GuiConfigFile {
                start_core_on_launch,
                run_on_startup,
                ..GuiConfigFile::default()
            };
            assert_eq!(
                should_start_core_on_launch(&config),
                start_core_on_launch || run_on_startup
            );
        }
    }
}

#[test]
fn gui_window_size_is_clamped_and_requires_both_dimensions() {
    let mut config = GuiConfigFile {
        window_width: Some(320),
        window_height: Some(30_000),
        ..GuiConfigFile::default()
    };

    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.window_width, Some(MIN_MAIN_WINDOW_WIDTH));
    assert_eq!(config.window_height, Some(MAX_SAVED_WINDOW_DIMENSION));

    config.window_height = None;
    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.window_width, None);
    assert_eq!(config.window_height, None);
}

#[test]
fn legacy_default_window_size_migrates_to_current_default() {
    let mut config = GuiConfigFile {
        window_width: Some(LEGACY_DEFAULT_MAIN_WINDOW_WIDTH),
        window_height: Some(LEGACY_DEFAULT_MAIN_WINDOW_HEIGHT),
        ..GuiConfigFile::default()
    };

    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.window_width, Some(DEFAULT_MAIN_WINDOW_WIDTH));
    assert_eq!(config.window_height, Some(DEFAULT_MAIN_WINDOW_HEIGHT));
}

#[test]
fn physical_window_size_uses_display_scale_and_ignores_minimized_sizes() {
    let physical_size = tauri::PhysicalSize::new(1500, 1000);
    assert_eq!(
        logical_window_size_from_physical(&physical_size, 1.25),
        Some(SavedWindowSize {
            width: 1200,
            height: 800,
        })
    );
    assert!(logical_window_size_from_physical(&tauri::PhysicalSize::new(0, 0), 1.0).is_none());
    assert!(logical_window_size_from_physical(&physical_size, 0.0).is_none());
}

#[test]
fn external_core_startup_errors_latch_ownership_and_preserve_the_file() {
    let home = agent_test_home("external-core-invalid-config");
    let path = home.join("config.toml");
    for content in [
        "external-core = true\nbroken = [\n",
        "external-core=true # retained\nclose-behavior = 'unknown'\n",
        "external-core = true\nport = 999999\n",
        "external-core = true\nport = 0\nauth-dir = '/external/oauth'\n",
    ] {
        fs::write(&path, content).unwrap();
        assert!(external_core_requested_at(&path));
        assert!(load_external_gui_config_at(&path, &home.join("core")).is_err());
        let fallback = gui_config_startup_fallback(external_core_requested_at(&path));
        assert!(fallback.external_core);
        assert!(!should_start_core_on_launch(&fallback));
        assert!(CoreProcessState::from_config(&fallback).ensure_managed().is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        // Window/settings saves must not destroy a broken external-mode file.
        assert!(write_gui_config_to_path(&fallback, &path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
    }
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(external_core_requested_at(&path), "unreadable configuration must fail closed");
    assert!(load_external_gui_config_at(&path, &home).is_err());
    assert!(gui_config_startup_fallback(external_core_requested_at(&path)).external_core);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn external_core_writer_persists_true_and_only_retains_an_explicit_false() {
    let home = agent_test_home("external-core-config-write");
    let path = home.join("config.toml");
    let mut config = GuiConfigFile::default();
    write_gui_config_to_path(&config, &path).unwrap();
    assert!(!fs::read_to_string(&path).unwrap().contains("external-core"));
    fs::remove_file(&path).unwrap();
    config.external_core = true;
    write_gui_config_to_path(&config, &path).unwrap();
    assert!(external_core_requested_at(&path));
    fs::write(home.join(CORE_CONFIG_FILE), "port: 8317\n").unwrap();
    let loaded = load_external_gui_config_at(&path, &home).unwrap();
    assert!(loaded.external_core);
    config.external_core = false;
    write_gui_config_to_path(&config, &path).unwrap();
    assert!(fs::read_to_string(&path).unwrap().contains("external-core = false"));
    fs::remove_dir_all(home).unwrap();
}

#[cfg(unix)]
#[test]
fn external_core_startup_and_sanitize_preserve_server_secret_and_auth_directory() {
    let home = agent_test_home("external-core-config-readonly");
    let real = home.join("service/core");
    fs::create_dir_all(&real).unwrap();
    let link = home.join("cpa-core");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let yaml = "host: 127.0.0.1\nport: 8317\nauth-dir: ../oauth\nremote-management:\n  secret-key: '$2a$fixture-hash'\n";
    fs::write(real.join(CORE_CONFIG_FILE), yaml).unwrap();
    let path = home.join("config.toml");
    let content = "external-core = true\n";
    fs::write(&path, content).unwrap();
    let mut config = load_external_gui_config_at(&path, &link).unwrap();
    assert!(config.management_secret_key.is_empty(), "must not invent a cleartext service key");
    assert_eq!(PathBuf::from(&config.auth_dir), home.join("service/oauth"));
    config.auth_dir_user_selected = false;
    sanitize_gui_config_at(&mut config, &link, &home.join("gui-oauth")).unwrap();
    assert_eq!(fs::read_to_string(real.join(CORE_CONFIG_FILE)).unwrap(), yaml);
    assert_eq!(fs::read_to_string(&path).unwrap(), content);
    assert!(!home.join("gui-oauth").exists());
    assert!(!home.join("service/oauth").exists());
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn external_core_reload_keeps_startup_ownership_in_both_directions() {
    for external_core in [false, true] {
        let config = GuiConfigFile { external_core, ..GuiConfigFile::default() };
        let process = CoreProcessState::from_config(&config);
        let state = GuiConfigState::new(config.clone());
        let changed = GuiConfigFile { external_core: !external_core, port: 12345, ..config };
        state.replace_external(changed).unwrap();
        let loaded = state.snapshot().unwrap();
        assert_eq!(loaded.external_core, external_core);
        assert_eq!(loaded.external_core, process.external_core);
        assert_eq!(loaded.port, 12345);
        assert_eq!(should_start_core_on_launch(&loaded), !external_core);
    }
}

#[test]
fn external_core_startup_imports_service_connection_without_writes_in_both_layouts() {
    let home = agent_test_home("external-core-readonly-import");
    let gui_path = home.join(GUI_CONFIG_FILE);
    let core_path = home.join(CORE_CONFIG_FILE);
    let gui = "external-core = true\nmanagement-secret-key = 'gui-credential'\n";
    fs::write(&gui_path, gui).unwrap();
    for core in [
        "host: 127.0.0.2\nport: 9527\nauth-dir: ../oauth\napi-keys: [service-client-key]\nproxy-url: http://127.0.0.1:9000\n",
        "config-version: 8\nserver: {host: 127.0.0.2, port: 9527}\noauth: {auth-dir: ../oauth}\naccess: {api-keys: [service-client-key]}\nrequests: {proxy-url: http://127.0.0.1:9000}\n",
    ] {
        fs::write(&core_path, core).unwrap();
        let config = load_external_gui_config_at(&gui_path, &home).unwrap();
        assert_eq!(config.host, "127.0.0.2");
        assert_eq!(config.port, 9527);
        assert_eq!(effective_agent_api_key(&config), "service-client-key");
        assert_eq!(config.management_secret_key, "gui-credential");
        assert_eq!(config.proxy_url, "http://127.0.0.1:9000");
        assert!(config.proxy_override);
        assert!(Path::new(&config.auth_dir).is_absolute());
        assert_eq!(fs::read_to_string(&core_path).unwrap(), core);
        assert_eq!(fs::read_to_string(&gui_path).unwrap(), gui);
    }
    fs::write(&core_path, "port: 9527\n").unwrap();
    assert_eq!(effective_agent_api_key(&load_external_gui_config_at(&gui_path, &home).unwrap()), "");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn external_core_settings_reads_preserve_auth_directory_and_both_configuration_files() {
    let home = agent_test_home("external-core-settings-read");
    let gui_path = home.join(GUI_CONFIG_FILE);
    let core_path = home.join(CORE_CONFIG_FILE);
    let gui = "external-core = true\nauth-dir = '/explicit/oauth'\n";
    let core = "port: 9527\nauth-dir: ../relative-oauth\napi-keys: [' client-key ', client-key]\n";
    fs::write(&gui_path, gui).unwrap();
    fs::write(&core_path, core).unwrap();
    let config = load_external_gui_config_at(&gui_path, &home).unwrap();
    let state = GuiConfigState::new(config);
    let settings = core_config_settings_from_value(&serde_norway::from_str(core).unwrap()).unwrap();
    let mut patched = false;
    sync_core_config_view(&state, &settings, |_| {
        patched = true;
        fs::write(&core_path, "read path must not normalize keys").unwrap();
        Ok(())
    }).unwrap();
    assert!(!patched);
    state.sync_core_settings_external(&settings).unwrap();
    state.replace_core_settings_external(&settings).unwrap();
    let synced = state.snapshot().unwrap();
    assert_eq!(synced.auth_dir, "/explicit/oauth");
    assert_eq!(effective_agent_api_key(&synced), "client-key");
    assert_eq!(fs::read_to_string(&core_path).unwrap(), core);
    assert_eq!(fs::read_to_string(&gui_path).unwrap(), gui);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn external_core_startup_fallback_is_valid_and_never_invents_a_client_key() {
    let config = gui_config_startup_fallback(true);
    assert!(!config.auth_dir.trim().is_empty());
    validate_gui_config(&config).unwrap();
    assert_eq!(effective_agent_api_key(&config), "");
    let state = GuiConfigState::new(config);
    let mut settings = CoreConfigSettings::from(&state.snapshot().unwrap());
    settings.auth_dir.clear();
    state.sync_core_settings_external(&settings).unwrap();
    validate_gui_config(&state.snapshot().unwrap()).unwrap();
    let managed = gui_config_startup_fallback(false);
    assert_eq!(managed.auth_dir, DEFAULT_AUTH_DIR);
    assert_eq!(effective_agent_api_key(&managed), DEFAULT_API_KEY);
}
