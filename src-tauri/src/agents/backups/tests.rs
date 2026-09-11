use super::*;

struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "cpa-backups-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn save(path: &Path, content: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}
fn models() -> Vec<AgentModelOption> {
    ["gpt-one", "gpt-two"]
        .into_iter()
        .map(|name| AgentModelOption {
            input_modalities: None,
            harness_metadata: None,
            name: name.into(),
            alias: None,
            is_alias: false,
            context_window: Some(200_000),
        })
        .collect()
}
fn catalog(model: &str) -> String {
    let payload = serde_json::json!({"models":[{"id":model}]});
    let runtime = codex_catalog::parse_runtime_models(&payload).unwrap();
    codex_catalog::prepare_catalog(&runtime).unwrap().json
}
fn apply(home: &Path, client: AgentClient, model: &str) -> Result<AgentConfigActionResult, String> {
    let catalog = catalog(model);
    let mappings = ClaudeDesktopModelMappings::all(model);
    apply_agent_configuration_with_oauth(
        client,
        home,
        8317,
        "test-secret",
        model,
        AgentConfigurationOptions {
            models: &models(),
            codex_catalog: Some(&catalog),
            oauth_configuration: false,
            claude_code_model_mappings: Some(&mappings),
            claude_desktop_model_mappings: (client == AgentClient::ClaudeDesktop)
                .then_some(&mappings),
        },
    )
}
fn template(home: &Path, client: AgentClient) -> Result<AgentConfigActionResult, String> {
    let catalog = catalog("gpt-one");
    let mappings = ClaudeDesktopModelMappings::all("gpt-one");
    reset_agent_configuration_to_default_with_oauth(AgentDefaultConfiguration {
        client,
        home,
        port: 8317,
        api_key: "test-secret",
        model: "gpt-one",
        models: &models(),
        codex_catalog: Some(&catalog),
        oauth_configuration: false,
        claude_code_model_mappings: Some(&mappings),
        claude_desktop_model_mappings: (client == AgentClient::ClaudeDesktop).then_some(&mappings),
    })
}
fn clients() -> Vec<AgentClient> {
    [
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
    ]
    .into_iter()
    .map(|id| AgentClient::parse(id).unwrap())
    .filter(|c| c.supported_platform())
    .collect()
}

#[test]
fn all_client_updates_preserve_custom_settings_and_create_no_backups() {
    for client in clients() {
        let home = Home::new();
        apply(&home.0, client, "gpt-one")
            .unwrap_or_else(|e| panic!("{} initial: {e}", client.id()));
        let paths = config_paths(client.id(), &home.0).unwrap();
        for path in &paths {
            let raw = read_agent_bytes(path).unwrap();
            let mut root = parse(path, text(raw.as_deref()).unwrap()).unwrap();
            root["custom"] =
                serde_json::json!({"nested": {"array": [1, "two", false], "secret": "keep-me"}});
            save(path, render(path, &root).unwrap());
        }
        apply(&home.0, client, "gpt-two").unwrap_or_else(|e| panic!("{} update: {e}", client.id()));
        for path in &paths {
            let raw = read_agent_bytes(path).unwrap();
            let root = parse(path, text(raw.as_deref()).unwrap()).unwrap();
            assert_eq!(
                root["custom"]["nested"]["secret"],
                "keep-me",
                "{}",
                client.id()
            );
        }
        let before = config_images(&paths).unwrap();
        assert_eq!(
            apply(&home.0, client, "gpt-two").unwrap().outcome,
            "unchanged",
            "{}",
            client.id()
        );
        assert_eq!(before, config_images(&paths).unwrap());
        assert!(!agent_data_directory(&paths)
            .unwrap()
            .join("backups")
            .exists());
    }
}

#[test]
fn codex_catalog_reset_removes_managed_fields_and_preserves_extensions_on_disk() {
    for sync in [false, true] {
        let home = Home::new();
        apply(&home.0, AgentClient::Codex, "gpt-6-astra").unwrap();
        let paths = config_paths("codex", &home.0).unwrap();
        let catalog_path = codex_model_catalog_path(&home.0);
        let runtime = codex_catalog::parse_runtime_models(
            &serde_json::json!({"models": [{"id": "gpt-6-astra"}]}),
        )
        .unwrap();
        let defaults = codex_catalog::prepare_catalog(&runtime).unwrap();
        let mut expected: Value = serde_json::from_str(&defaults.json).unwrap();
        // The editor restores 95% by dropping its override on this official model.
        assert!(expected["models"][0]
            .get("effective_context_window_percent")
            .is_none());
        expected["custom"] = serde_json::json!({"keep": true});
        expected["models"][0]["extensions"] =
            serde_json::json!({"headers": {"custom": "keep"}, "options": [1, 2]});
        let mut customized = expected.clone();
        customized["models"][0]["effective_context_window_percent"] = serde_json::json!(80);
        save(&catalog_path, serde_json::to_vec(&customized).unwrap());
        let before = config_images(&paths).unwrap();
        let update = || {
            if sync {
                sync_codex_model_catalog_if_configured(
                    &home.0,
                    8317,
                    "test-secret",
                    &defaults.models,
                    &defaults.json,
                )
                .unwrap()
            } else {
                apply(&home.0, AgentClient::Codex, "gpt-6-astra")
                    .unwrap()
                    .outcome
                    == "updated"
            }
        };

        assert!(update(), "sync={sync}");
        let actual: Value = serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        assert_eq!(actual, expected, "sync={sync}");
        for (path, bytes) in before {
            if path != catalog_path {
                assert_eq!(read_agent_bytes(&path).unwrap(), bytes);
            }
        }
        let restored = config_images(&paths).unwrap();
        assert!(!update(), "a repeated reset must be a no-op, sync={sync}");
        assert_eq!(config_images(&paths).unwrap(), restored);
        assert_eq!(test_backup_count(AgentClient::Codex, &home.0), 0);
    }
}

#[test]
fn all_templates_repair_corrupt_files_and_restore_exact_manual_backup() {
    for client in clients() {
        let home = Home::new();
        template(&home.0, client).unwrap_or_else(|e| panic!("{}: {e}", client.id()));
        let paths = config_paths(client.id(), &home.0).unwrap();
        for path in &paths {
            let raw = read_agent_bytes(path).unwrap();
            let mut root = parse(path, text(raw.as_deref()).unwrap()).unwrap();
            root["custom"] = serde_json::json!({"keep":true});
            save(path, render(path, &root).unwrap());
        }
        let original = config_images(&paths).unwrap();
        let version = create_backup(client.id(), &home.0).unwrap();
        assert!(version.restorable, "{}: {:?}", client.id(), version.error);
        for path in &paths {
            save(path, b"{{broken test-secret");
        }
        let broken = config_images(&paths).unwrap();
        let error = apply(&home.0, client, "gpt-two").unwrap_err();
        assert!(!error.contains("test-secret"));
        assert_eq!(config_images(&paths).unwrap(), broken);
        template(&home.0, client).unwrap();
        for path in &paths {
            let raw = read_agent_bytes(path).unwrap();
            assert!(parse(path, text(raw.as_deref()).unwrap())
                .unwrap()
                .get("custom")
                .is_none());
        }
        test_restore_backup(client, &home.0, &version.id);
        assert_eq!(original, config_images(&paths).unwrap());
        assert_eq!(test_backup_count(client, &home.0), 1);
    }
}

#[test]
fn backup_restores_absence_and_does_not_touch_other_files_or_versions() {
    for client in clients() {
        let home = Home::new();
        let paths = config_paths(client.id(), &home.0).unwrap();
        save(
            &paths[0],
            render(&paths[0], &serde_json::json!({"custom":"original"})).unwrap(),
        );
        let original = config_images(&paths).unwrap();
        let first = create_backup(client.id(), &home.0).unwrap();
        let second = create_backup(client.id(), &home.0).unwrap();
        assert_ne!(first.id, second.id);
        let unrelated = paths[0].parent().unwrap().join("unmanaged.txt");
        save(&unrelated, "untouched");
        template(&home.0, client).unwrap();
        test_restore_backup(client, &home.0, &first.id);
        assert_eq!(original, config_images(&paths).unwrap());
        delete_backup(client.id(), &home.0, &first.id).unwrap();
        assert_eq!(original, config_images(&paths).unwrap());
        assert_eq!(fs::read_to_string(&unrelated).unwrap(), "untouched");
        assert_eq!(
            list_backups(client.id(), &home.0).unwrap().versions[0].id,
            second.id
        );
    }
}

#[test]
fn corrupt_raw_and_non_utf8_backups_are_saved_but_not_restorable() {
    let home = Home::new();
    let paths = config_paths("codex", &home.0).unwrap();
    for raw in [b"invalid test-secret".to_vec(), vec![0xff, 0xfe, 0x00]] {
        save(&paths[0], &raw);
        let backup = create_backup("codex", &home.0).unwrap();
        assert!(!backup.restorable);
        assert!(!backup.error.as_ref().unwrap().contains("test-secret"));
        assert_eq!(
            read_version("codex", &paths, &backup.id).unwrap().files[0].bytes,
            Some(raw)
        );
        assert!(preview("codex", &paths, &backup.id).is_err());
        delete_backup("codex", &home.0, &backup.id).unwrap();
    }
}

#[test]
fn restore_validation_uses_the_clients_actual_json_format() {
    for (client, restorable) in [
        ("claude-code", false),
        ("opencode", true),
        ("openclaw", true),
        ("pi", false),
    ] {
        let home = Home::new();
        let paths = config_paths(client, &home.0).unwrap();
        save(&paths[0], "// JSON5\n{custom:'keep'}\n");
        let backup = create_backup(client, &home.0).unwrap();
        assert_eq!(backup.restorable, restorable, "{client}");
        assert_eq!(
            read_version(client, &paths, &backup.id).unwrap().files[0].bytes,
            Some(b"// JSON5\n{custom:'keep'}\n".to_vec())
        );
    }
}

#[test]
fn damaged_packages_and_traversal_are_rejected_and_deletable() {
    let home = Home::new();
    let paths = config_paths("codex", &home.0).unwrap();
    let backup = create_backup("codex", &home.0).unwrap();
    let path = version_path("codex", &paths, &backup.id).unwrap();
    let original = fs::read(&path).unwrap();
    let package: BackupPackage = serde_json::from_slice(&original).unwrap();
    for tampering in ["checksum", "path", "missing", "hash", "mapping"] {
        let mut changed = package.payload.clone();
        match tampering {
            "path" => changed.files[0].path = home.0.join("outside"),
            "missing" => {
                changed.files.pop();
            }
            "hash" => changed.files[0].bytes = Some(b"secret".to_vec()),
            "mapping" => changed.mappings = Some(ClaudeDesktopModelMappings::all("other")),
            _ => {}
        }
        let checksum = if tampering == "path" || tampering == "missing" || tampering == "hash" {
            sha256_bytes(&serde_json::to_vec(&changed).unwrap())
        } else {
            "wrong".into()
        };
        save(
            &path,
            serde_json::to_vec(&BackupPackage {
                payload: changed,
                checksum,
            })
            .unwrap(),
        );
        assert!(preview("codex", &paths, &backup.id).is_err());
        assert!(!list_backups("codex", &home.0).unwrap().versions[0].restorable);
    }
    save(&path, "not a package");
    assert_eq!(list_backups("codex", &home.0).unwrap().versions.len(), 1);
    for id in ["../escape", "..\\escape", "C:/escape", "", "1/2"] {
        assert!(delete_backup("codex", &home.0, id).is_err());
        assert!(read_version("codex", &paths, id).is_err());
    }
    delete_backup("codex", &home.0, &backup.id).unwrap();
}

#[test]
fn previews_track_configuration_backup_and_mapping_changes_without_exposing_values() {
    let home = Home::new();
    let paths = config_paths("codex", &home.0).unwrap();
    apply(&home.0, AgentClient::Codex, "gpt-one").unwrap();
    let backup = create_backup("codex", &home.0).unwrap();
    apply(&home.0, AgentClient::Codex, "gpt-two").unwrap();
    let first = preview("codex", &paths, &backup.id).unwrap().0;
    assert!(!serde_json::to_string(&first)
        .unwrap()
        .contains("test-secret"));
    save(&paths[0], "invalid test-secret");
    let next = preview("codex", &paths, &backup.id).unwrap().0;
    assert_ne!(first.revision, next.revision);
    let mut version = read_version("codex", &paths, &backup.id).unwrap();
    version.created_at = "2020-01-01T00:00:00Z".into();
    let path = version_path("codex", &paths, &backup.id).unwrap();
    save(
        &path,
        serde_json::to_vec(&BackupPackage {
            checksum: sha256_bytes(&serde_json::to_vec(&version).unwrap()),
            payload: version,
        })
        .unwrap(),
    );
    assert_ne!(
        next.revision,
        preview("codex", &paths, &backup.id).unwrap().0.revision
    );
}

#[test]
fn unwritable_backup_directory_does_not_block_updates_sync_clear_or_templates() {
    let home = Home::new();
    let paths = config_paths("codex", &home.0).unwrap();
    let data = agent_data_directory(&paths).unwrap();
    save(&data.join("backups"), "blocked");
    apply(&home.0, AgentClient::Codex, "gpt-one").unwrap();
    assert!(create_backup("codex", &home.0).is_err());
    apply(&home.0, AgentClient::Codex, "gpt-two").unwrap();
    sync_codex_model_catalog_if_configured(
        &home.0,
        8317,
        "test-secret",
        &models(),
        &catalog("gpt-two"),
    )
    .unwrap();
    clear_codex_config_files(&home.0).unwrap();
    template(&home.0, AgentClient::Codex).unwrap();
    assert_eq!(fs::read_to_string(data.join("backups")).unwrap(), "blocked");
}

#[test]
fn partial_writes_and_failed_verification_roll_back_without_persistent_snapshots() {
    let home = Home::new();
    let paths = config_paths("codex", &home.0).unwrap();
    save(&paths[0], "model = 'old'\n");
    let before = config_images(&paths).unwrap();
    let mut after = before.clone();
    after[0].1 = Some(b"model = 'new'\n".to_vec());
    after[1].1 = Some(b"{}".to_vec());
    for silent in [false, true] {
        let mut first = true;
        let error = commit_config_with_writer(
            "codex",
            &paths,
            &before,
            &after,
            "update",
            None,
            None,
            &mut |client, images| {
                if first {
                    first = false;
                    write_config_images(client, &vec![images[0].clone()])?;
                    return if silent {
                        Ok(())
                    } else {
                        Err("failure secret-token".into())
                    };
                }
                write_config_images(client, images)
            },
        )
        .unwrap_err();
        assert!(error.contains("已回滚"));
        assert!(!error.contains("secret-token"));
        assert_eq!(before, config_images(&paths).unwrap());
    }
    let error = commit_config_with_writer(
        "codex",
        &paths,
        &before,
        &after,
        "update",
        None,
        None,
        &mut |_, _| Err("secret-token".into()),
    )
    .unwrap_err();
    assert!(error.contains("回滚失败"));
    assert!(!error.contains("secret-token"));
    assert!(list_backups("codex", &home.0).unwrap().versions.is_empty());
    save(&paths[0], "external = true");
    assert!(
        commit_config("codex", &paths, &before, &after, "update", None)
            .unwrap_err()
            .contains("其他程序")
    );
    assert_eq!(fs::read_to_string(&paths[0]).unwrap(), "external = true");
}

#[test]
fn old_backups_remain_untouched_and_are_not_listed() {
    let home = Home::new();
    let paths = config_paths("opencode", &home.0).unwrap();
    let old = paths[0]
        .parent()
        .unwrap()
        .join(".cpa-config-history/opencode/old/1.json");
    save(&old, "old history");
    let legacy = agent_backup_path(&paths[0]).unwrap();
    save(&legacy, "old backup");
    assert!(list_backups("opencode", &home.0)
        .unwrap()
        .versions
        .is_empty());
    apply(&home.0, AgentClient::OpenCode, "gpt-one").unwrap();
    assert_eq!(fs::read_to_string(old).unwrap(), "old history");
    assert_eq!(fs::read_to_string(legacy).unwrap(), "old backup");
}

#[test]
fn pi_template_only_writes_configuration_and_package_references() {
    let home = Home::new();
    let paths = config_paths("pi", &home.0).unwrap();
    save(&paths[0], "invalid");
    save(&paths[1], "invalid");
    let package = home.0.join("installed-package");
    save(&package, "package contents");
    let updates = build_pi_template_updates(&home.0, 8317, "secret", "gpt-one").unwrap();
    config_updates(
        "pi",
        &home.0,
        &config_images(&paths).unwrap(),
        &updates,
        "template",
        None,
        None,
    )
    .unwrap();
    assert!(pi_provider_package_installed(&home.0).unwrap());
    let first = create_backup("pi", &home.0).unwrap();
    let original = config_images(&paths).unwrap();
    repair_pi_provider_inner(&home.0, 8318, "other-secret", "gpt-two").unwrap();
    let (_, before, after) = preview("pi", &paths, &first.id).unwrap();
    commit_config("pi", &paths, &before, &after, "restore", None).unwrap();
    assert_eq!(original, config_images(&paths).unwrap());
    assert_eq!(fs::read_to_string(package).unwrap(), "package contents");
    assert_eq!(list_backups("pi", &home.0).unwrap().versions.len(), 1);
}

#[test]
fn desktop_current_mapping_survives_backup_deletion_and_rejects_unreliable_profile() {
    if !AgentClient::ClaudeDesktop.supported_platform() {
        return;
    }
    let home = Home::new();
    let paths = config_paths("claude-desktop", &home.0).unwrap();
    apply(&home.0, AgentClient::ClaudeDesktop, "gpt-one").unwrap();
    let original = config_images(&paths).unwrap();
    let backup = create_backup("claude-desktop", &home.0).unwrap();
    let revision = preview("claude-desktop", &paths, &backup.id)
        .unwrap()
        .0
        .revision;
    apply(&home.0, AgentClient::ClaudeDesktop, "gpt-two").unwrap();
    assert_eq!(original, config_images(&paths).unwrap());
    assert_ne!(
        revision,
        preview("claude-desktop", &paths, &backup.id)
            .unwrap()
            .0
            .revision
    );
    delete_backup("claude-desktop", &home.0, &backup.id).unwrap();
    assert_eq!(current_desktop_mappings(&home.0).unwrap().opus, "gpt-two");
    let persisted: DesktopMappingState =
        serde_json::from_slice(&fs::read(desktop_mapping_path(&paths).unwrap()).unwrap()).unwrap();
    assert_eq!(persisted.mappings.opus, "gpt-two");
    save(&paths[2], "{\"inferenceModels\":[]}");
    assert!(current_desktop_mappings(&home.0).is_none());
}

#[test]
fn desktop_model_extensions_do_not_resurrect_disabled_one_million_context_flags() {
    if !AgentClient::ClaudeDesktop.supported_platform() {
        return;
    }
    let home = Home::new();
    let paths = config_paths("claude-desktop", &home.0).unwrap();
    let mut mappings = ClaudeDesktopModelMappings::all("gpt-one");
    mappings.opus_1m = true;
    let options = |m| AgentConfigurationOptions {
        models: &[],
        codex_catalog: None,
        oauth_configuration: false,
        claude_code_model_mappings: None,
        claude_desktop_model_mappings: Some(m),
    };
    apply_agent_configuration_with_oauth(
        AgentClient::ClaudeDesktop,
        &home.0,
        8317,
        "secret",
        "gpt-one",
        options(&mappings),
    )
    .unwrap();
    let mut value: Value = serde_json::from_slice(&fs::read(&paths[2]).unwrap()).unwrap();
    value["inferenceModels"][0]["custom"] = serde_json::json!({"keep":true});
    save(&paths[2], value.to_string());
    let next_mappings = ClaudeDesktopModelMappings::all("gpt-one");
    apply_agent_configuration_with_oauth(
        AgentClient::ClaudeDesktop,
        &home.0,
        8317,
        "secret",
        "gpt-one",
        options(&next_mappings),
    )
    .unwrap();
    let value: Value = serde_json::from_slice(&fs::read(&paths[2]).unwrap()).unwrap();
    assert_eq!(value["inferenceModels"][0]["custom"]["keep"], true);
    assert!(value["inferenceModels"][0].get("supports1m").is_none());
    assert!(value["inferenceModels"][0].get("prefer1m").is_none());
}

#[test]
fn semantic_noop_keeps_original_comments_and_guard_rejects_dropped_custom_values() {
    let home = Home::new();
    let paths = config_paths("opencode", &home.0).unwrap();
    save(
        &paths[0],
        "// comment\n{model:'old', custom:{nested:true}}\n",
    );
    let before = config_images(&paths).unwrap();
    let update = AgentFileUpdate {
        path: paths[0].clone(),
        after: "{\"model\":\"old\",\"custom\":{\"nested\":true}}".into(),
    };
    assert_eq!(
        config_updates(
            "opencode",
            &home.0,
            &before,
            &[update],
            "update",
            None,
            None
        )
        .unwrap()
        .outcome,
        "unchanged"
    );
    assert_eq!(before, config_images(&paths).unwrap());
    let update = AgentFileUpdate {
        path: paths[0].clone(),
        after: "{}".into(),
    };
    assert!(config_updates(
        "opencode",
        &home.0,
        &before,
        &[update],
        "update",
        None,
        None
    )
    .is_err());
}

#[cfg(windows)]
#[test]
fn occupied_file_rejects_write_and_preserves_original() {
    use std::os::windows::fs::OpenOptionsExt;
    let home = Home::new();
    let paths = config_paths("codex", &home.0).unwrap();
    save(&paths[0], "model='old'");
    let before = config_images(&paths).unwrap();
    let mut after = before.clone();
    after[0].1 = Some(b"model='new'".to_vec());
    let _occupied = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&paths[0])
        .unwrap();
    assert!(commit_config("codex", &paths, &before, &after, "update", None).is_err());
    assert_eq!(before, config_images(&paths).unwrap());
}

#[test]
fn directory_at_file_path_is_rejected() {
    let home = Home::new();
    let paths = config_paths("codex", &home.0).unwrap();
    fs::create_dir_all(&paths[0]).unwrap();
    assert!(config_images(&paths).is_err());
}

fn link_directory(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output = Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "temporary junction creation failed"
        );
    }
}

#[test]
fn linked_configuration_and_backup_directories_are_rejected() {
    let home = Home::new();
    let outside = Home::new();
    let paths = config_paths("codex", &home.0).unwrap();
    save(&outside.0.join("config.toml"), "custom='outside'");
    let link = paths[0].parent().unwrap();
    link_directory(&outside.0, link);
    assert!(create_backup("codex", &home.0).is_err());
    assert!(template(&home.0, AgentClient::Codex).is_err());
    assert_eq!(
        fs::read_to_string(outside.0.join("config.toml")).unwrap(),
        "custom='outside'"
    );
    fs::remove_dir(link).unwrap();
    let data = agent_data_directory(&paths).unwrap();
    fs::create_dir_all(&data).unwrap();
    link_directory(&outside.0, &data.join("backups"));
    assert!(create_backup("codex", &home.0).is_err());
    assert!(list_backups("codex", &home.0).is_err());
    assert!(delete_backup("codex", &home.0, "1").is_err());
    fs::remove_dir(data.join("backups")).unwrap();
}

#[tokio::test]
async fn restore_rejects_configuration_or_backup_changes_since_confirmation() {
    let home = Home::new();
    let paths = config_paths("codex", &home.0).unwrap();
    let config = GuiConfigFile::default();
    template(&home.0, AgentClient::Codex).unwrap();
    let backup = create_backup("codex", &home.0).unwrap();
    let plan = prepare_restore_plan(&config, "codex", &home.0, &backup.id)
        .await
        .unwrap();
    let revision = plan.preview.revision.clone();
    save(&paths[0], "external='keep'");
    let current = config_images(&paths).unwrap();
    assert!(execute_restore_plan(&config, plan, &revision)
        .await
        .is_err());
    assert_eq!(current, config_images(&paths).unwrap());
    let plan = prepare_restore_plan(&config, "codex", &home.0, &backup.id)
        .await
        .unwrap();
    let revision = plan.preview.revision.clone();
    let mut version = read_version("codex", &paths, &backup.id).unwrap();
    version.created_at = "2021-01-01T00:00:00Z".into();
    save(
        &version_path("codex", &paths, &backup.id).unwrap(),
        serde_json::to_vec(&BackupPackage {
            checksum: sha256_bytes(&serde_json::to_vec(&version).unwrap()),
            payload: version,
        })
        .unwrap(),
    );
    assert!(execute_restore_plan(&config, plan, &revision)
        .await
        .is_err());
    assert_eq!(current, config_images(&paths).unwrap());
}

#[test]
fn nested_model_options_and_third_party_providers_survive_all_updates() {
    for client in clients() {
        let home = Home::new();
        apply(&home.0, client, "gpt-one").unwrap();
        let paths = config_paths(client.id(), &home.0).unwrap();
        let mut touched = Vec::new();
        for path in &paths {
            let raw = read_agent_bytes(path).unwrap();
            let mut root = parse(path, text(raw.as_deref()).unwrap()).unwrap();
            let container = match client {
                AgentClient::Codex if path == &paths[0] => Some("/model_providers"),
                AgentClient::OpenCode | AgentClient::ZCode => Some("/provider"),
                AgentClient::OpenClaw => Some("/models/providers"),
                AgentClient::DeepSeekHarness if path == &paths[0] => Some("/llm-pi-ai/providers"),
                AgentClient::KimiCode => Some("/providers"),
                _ => None,
            };
            if let Some(pointer) = container {
                root.pointer_mut(pointer)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .insert(
                        "third-party".into(),
                        serde_json::json!({"key":"keep-secret","nested":{"enabled":true}}),
                    );
                touched.push((
                    path.clone(),
                    format!("{pointer}/third-party"),
                    serde_json::json!({"key":"keep-secret","nested":{"enabled":true}}),
                ));
            }
            let inventory = match client {
                AgentClient::ClaudeDesktop if path == &paths[2] => {
                    Some("/inferenceModels/0".to_string())
                }
                AgentClient::OpenCode | AgentClient::ZCode => {
                    Some("/provider/cpa-gui/models/gpt-one".into())
                }
                AgentClient::OpenClaw => Some("/models/providers/cpa-gui/models/0".into()),
                AgentClient::Hermes => Some("/custom_providers/0/models/gpt-one".into()),
                AgentClient::DeepSeekHarness if path == &paths[0] => Some(format!(
                    "/llm-pi-ai/providers/{DEEPSEEK_HARNESS_PROVIDER_ID}/models/0"
                )),
                AgentClient::KimiCode => Some("/models/cpa-gui~1gpt-one".into()),
                AgentClient::GrokBuild => Some("/model/cpa-gui~1gpt-one".into()),
                _ => None,
            };
            if let Some(pointer) = inventory {
                let extensions = serde_json::json!({"headers":{"custom":"keep"},"array":[1,2]});
                root.pointer_mut(&pointer)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .insert("extensions".into(), extensions.clone());
                touched.push((path.clone(), format!("{pointer}/extensions"), extensions));
            }
            save(path, render(path, &root).unwrap());
        }
        // Change credentials without reordering the selected model inventory.
        let catalog = catalog("gpt-one");
        let mappings = ClaudeDesktopModelMappings::all("gpt-one");
        apply_agent_configuration_with_oauth(
            client,
            &home.0,
            8318,
            "new-secret",
            "gpt-one",
            AgentConfigurationOptions {
                models: &models(),
                codex_catalog: Some(&catalog),
                oauth_configuration: false,
                claude_code_model_mappings: Some(&mappings),
                claude_desktop_model_mappings: (client == AgentClient::ClaudeDesktop)
                    .then_some(&mappings),
            },
        )
        .unwrap_or_else(|e| panic!("{}: {e}", client.id()));
        for (path, pointer, expected) in touched {
            let raw = read_agent_bytes(&path).unwrap();
            let actual = parse(&path, text(raw.as_deref()).unwrap()).unwrap();
            assert_eq!(
                actual.pointer(&pointer),
                Some(&expected),
                "{} {pointer}",
                client.id()
            );
        }
        assert!(list_backups(client.id(), &home.0)
            .unwrap()
            .versions
            .is_empty());
    }
}
