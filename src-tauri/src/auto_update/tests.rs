use super::*;

#[test]
fn defaults_are_off_and_old_configs_remain_off() {
    let config: GuiConfigFile = toml::from_str("").unwrap();
    assert!(!config.auto_update.enabled);
    assert!(!config.auto_update.update_app && !config.auto_update.update_core);
    config.auto_update.validate().unwrap();
}

#[test]
fn automatic_updates_never_reinstall_or_downgrade() {
    assert!(!newer("v1.2.3", "1.2.3"));
    assert!(!newer("1.2.3", "1.2.2"));
    assert!(!newer("dev", "1.2.3"));
    assert!(!newer("1.2.3", "unknown"));
    assert!(!newer("1.2.3+one", "1.2.3+two"));
    assert!(newer("1.2.3-preview.1", "1.2.3-preview.2"));
    assert!(newer("1.2.3-preview.2", "1.2.3"));
}

#[test]
fn saved_policy_round_trips_and_preserves_unrelated_fields() {
    let root = unique_test_temp_path("automatic-update-config");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("config.toml");
    std::fs::write(&path, "# user comment\ncustom-setting = 42\n").unwrap();
    let mut config = GuiConfigFile::default();
    config.auto_update.enabled = true;
    config.auto_update.update_core = true;
    crate::write_gui_config_to_path(&config, &path).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("# user comment") && text.contains("custom-setting = 42"));
    let restored: GuiConfigFile = toml::from_str(&text).unwrap();
    assert_eq!(restored.auto_update, config.auto_update);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn saving_canonicalizes_accepted_config_aliases_without_duplicate_fields() {
    let mut document: toml_edit::Document =
        "[auto-update]\nenabled = true\nupdateApp = true\nwindow-enabled = true\nstartTime = \"02:00\"\nend-time = \"05:00\"\ninstall-on-startup = false\nidleMinutes = 45\ncustom-option = 7\n"
            .parse()
            .unwrap();
    let config: GuiConfigFile = toml::from_str(&document.to_string()).unwrap();
    write_settings(document.as_table_mut(), &config.auto_update).unwrap();
    let saved = document.to_string();
    let restored: GuiConfigFile = toml::from_str(&saved).unwrap();
    assert_eq!(restored.auto_update, config.auto_update);
    assert!(saved.contains("custom-option = 7"));
    for key in [
        "updateApp",
        "idleMinutes",
        "window-enabled",
        "startTime",
        "end-time",
        "install-on-startup",
    ] {
        assert!(!saved.contains(key), "{key}");
    }
}

#[test]
fn configuration_edits_made_after_staging_are_preserved_when_refreshed() {
    let root = unique_test_temp_path("automatic-update-refresh");
    let source = root.join("installed");
    let staged = root.join("staged");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&staged).unwrap();
    fs::write(
        source.join(CORE_CONFIG_FILE),
        "port: 19531\napi-keys: [first-key]\n",
    )
    .unwrap();
    fs::write(
        staged.join(CORE_EXAMPLE_CONFIG_FILE),
        "port: 19532\napi-keys: []\n",
    )
    .unwrap();
    core_runtime::migrate_core_config_for_update(&source, &staged).unwrap();
    fs::write(
        source.join(CORE_CONFIG_FILE),
        "port: 19533\napi-keys: [latest-key]\n",
    )
    .unwrap();
    core_runtime::migrate_core_config_for_update(&source, &staged).unwrap();
    let document: serde_norway::Value =
        serde_norway::from_str(&fs::read_to_string(staged.join(CORE_CONFIG_FILE)).unwrap())
            .unwrap();
    assert_eq!(document["port"], 19533);
    assert_eq!(document["api-keys"][0], "latest-key");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn manual_and_automatic_updates_share_one_operation_slot() {
    let state = AutoUpdateState::default();
    let operation = state.try_operation().unwrap();
    assert!(state.try_operation().is_err());
    drop(operation);
    assert!(state.try_operation().is_ok());
}

fn prepared_core(root: &Path, config: &GuiConfigFile) -> PreparedUpdate {
    let staging = root.join("payloads").join("core-test");
    fs::create_dir_all(&staging).unwrap();
    let binary = staging.join(core_binary_name());
    fs::write(&binary, b"verified fake core, never executed").unwrap();
    PreparedUpdate {
        version: "8.0.99".into(),
        origin: prepared::origin(config, "core"),
        executable: env::current_exe().unwrap(),
        payload: Payload::Core {
            staging_dir: staging,
            binary_relative_path: core_binary_name().into(),
            asset_name: "test.zip".into(),
            binary_sha256: sha256_file(&binary).unwrap(),
        },
    }
}

#[test]
fn downloaded_payload_round_trips_across_restart_without_credentials() {
    let root = unique_test_temp_path("automatic-update-persistent-payload");
    let mut config = GuiConfigFile::default();
    config.auto_update.enabled = true;
    config.auto_update.update_core = true;
    config.proxy_url = "http://user:private-proxy-password@127.0.0.1:19871".into();
    config.management_secret_key = "private-management-secret".into();
    let prepared = prepared_core(&root, &config);
    prepared.save_at(&root).unwrap();
    drop(prepared);
    let loaded = PreparedUpdate::load_at(&root, "core").unwrap().unwrap();
    assert!(loaded.matches(&config));
    loaded
        .validate_files_at(&env::current_exe().unwrap(), &root.join("payloads"))
        .unwrap();
    let record = fs::read_to_string(root.join("automatic-update-core.json")).unwrap();
    assert!(!record.contains("private-proxy-password"));
    assert!(!record.contains("private-management-secret"));
    config.auto_update.enabled = false;
    assert!(!loaded.matches(&config));
    config.auto_update.enabled = true;
    config.proxy_url.clear();
    assert!(!loaded.matches(&config));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cached_payload_rejects_tampering_missing_files_and_path_escape() {
    let root = unique_test_temp_path("automatic-update-payload-validation");
    let mut cached = prepared_core(&root, &GuiConfigFile::default());
    let executable = env::current_exe().unwrap();
    let payloads = root.join("payloads");
    cached.validate_files_at(&executable, &payloads).unwrap();
    let binary = payloads.join("core-test").join(core_binary_name());
    fs::write(&binary, b"tampered").unwrap();
    assert!(cached
        .validate_files_at(&executable, &payloads)
        .unwrap_err()
        .contains("checksum"));
    fs::remove_file(&binary).unwrap();
    assert!(cached.validate_files_at(&executable, &payloads).is_err());
    if let Payload::Core {
        binary_relative_path,
        ..
    } = &mut cached.payload
    {
        *binary_relative_path = "../outside.exe".into();
    }
    assert!(cached
        .validate_files_at(&executable, &payloads)
        .unwrap_err()
        .contains("bounds"));
    cached.executable = root.join("missing.exe");
    assert!(cached
        .validate_files_at(&root.join("also-missing.exe"), &payloads)
        .is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_or_mismatched_cache_records_are_not_accepted() {
    let root = unique_test_temp_path("automatic-update-cache-record");
    let cached = prepared_core(&root, &GuiConfigFile::default());
    cached.save_at(&root).unwrap();
    fs::copy(
        root.join("automatic-update-core.json"),
        root.join("automatic-update-app.json"),
    )
    .unwrap();
    assert!(PreparedUpdate::load_at(&root, "app").is_err());
    fs::write(root.join("automatic-update-core.json"), b"{truncated").unwrap();
    assert!(PreparedUpdate::load_at(&root, "core").is_err());
    assert!(PreparedUpdate::load_at(&root, "../outside").is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn download_identity_tracks_source_channel_and_proxy_only() {
    let config = GuiConfigFile::default();
    let original = prepared::origin(&config, "app");
    let mut changed = config.clone();
    changed.download_source = VersionDownloadSource::GhFast;
    assert_ne!(original, prepared::origin(&changed, "app"));
    changed = config.clone();
    changed.update_channel = "preview".into();
    assert_ne!(original, prepared::origin(&changed, "app"));
    changed = config.clone();
    changed.auto_update.enabled = true;
    assert_eq!(original, prepared::origin(&changed, "app"));
}

#[test]
fn failed_install_blocks_only_the_same_target_and_version_after_restart() {
    let attempts = Attempts::from([("core".into(), "v8.0.99".into())]);
    let persisted = serde_json::to_vec(&attempts).unwrap();
    let reopened = serde_json::from_slice(&persisted).unwrap();
    assert!(blocked(&reopened, "core", "8.0.99"));
    assert!(!blocked(&reopened, "core", "8.0.100"));
    assert!(!blocked(&reopened, "app", "8.0.99"));
}

#[test]
fn enabling_without_a_target_is_normalized_without_erasing_the_record() {
    let mut config: GuiConfigFile =
        toml::from_str("[auto-update]\nenabled = true\nupdate-app = false\n").unwrap();
    assert!(config.auto_update.validate().is_err());
    let dir = unique_test_temp_path("automatic-update-normalize");
    let auth = dir.join("auth");
    fs::create_dir_all(&auth).unwrap();
    let install = dir.join("install");
    fs::create_dir_all(&install).unwrap();

    let changed = sanitize_gui_config_at(&mut config, &install, &auth).unwrap();
    assert!(changed, "an unreachable selection is reported as normalized");
    assert!(!config.auto_update.enabled);
    assert!(!config.auto_update.update_app && !config.auto_update.update_core);

    // Sanitizing a coherent record stays a no-op, so the loader does not
    // rewrite the file on every launch.
    config.auto_update.enabled = true;
    config.auto_update.update_core = true;
    assert!(!sanitize_gui_config_at(&mut config, &install, &auth).unwrap());
    assert_eq!(
        config.auto_update,
        AutoUpdateSettings {
            enabled: true,
            update_app: false,
            update_core: true,
        }
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_selection_without_a_target_downloads_nothing() {
    let inert = AutoUpdateSettings {
        enabled: true,
        update_app: false,
        update_core: false,
    };
    for target in TARGETS {
        assert!(!inert.includes(target), "{target} must not be downloaded");
    }
}

#[test]
fn saving_settings_never_panics_on_a_hand_edited_section() {
    let mut document: toml_edit::Document = "auto-update = 5\nport = 8317\n".parse().unwrap();
    let settings = AutoUpdateSettings {
        enabled: true,
        update_app: true,
        update_core: false,
    };
    write_settings(document.as_table_mut(), &settings).unwrap();
    let restored: GuiConfigFile = toml::from_str(&document.to_string()).unwrap();
    assert_eq!(restored.auto_update, settings);
    assert_eq!(restored.port, 8317);
}

#[test]
fn automatic_app_update_compares_only_the_configured_series() {
    let mut config = GuiConfigFile::default();
    assert!(target_newer(&config, "app", "1.2.9", "1.2.10"));
    assert!(!target_newer(
        &config,
        "app",
        "1.2.9-preview.20261103-1929",
        "1.2.10"
    ));
    config.update_channel = "preview".into();
    assert!(!target_newer(
        &config,
        "app",
        "1.2.9",
        "8.2.10-preview.20261104-1929"
    ));
    assert!(target_newer(
        &config,
        "app",
        "8.2.10-preview.20261103-1929",
        "1.2.9-preview.20261104-1929"
    ));
    assert!(!target_newer(
        &config,
        "app",
        "1.2.9-preview.20261104-1929",
        "8.2.10-preview.20261103-1929"
    ));
    assert!(target_newer(&config, "core", "1.2.9", "1.2.10"));
}

#[test]
fn automatic_update_cannot_use_the_uninstalled_family_reference_or_a_pin() {
    use crate::app_version_series::AppVersionBaselines;
    for (family, package, selected) in [
        ("stable", "1.2.10", "preview"),
        ("preview", "8.1.0-preview.20261103-1929", "stable"),
    ] {
        let baselines = AppVersionBaselines::from_local(
            Some(family),
            Some("1.2.10"),
            Some("20261103-1929"),
            package,
            None,
        );
        assert!(automatic_app_baseline(&baselines, family).is_some());
        assert!(automatic_app_baseline(&baselines, selected).is_none());
        assert!(automatic_app_baseline(&baselines, "preview-20261104-1929").is_none());
    }
}
