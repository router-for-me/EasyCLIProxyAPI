use super::*;
struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "cpa-history-{}-{}",
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
fn save(path: &Path, value: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}
fn restore_case(client: &str, originals: &[&str], currents: &[&str]) -> Vec<Value> {
    let home = Home::new();
    let paths = history_paths(client, &home.0).unwrap();
    for (p, v) in paths.iter().zip(originals) {
        save(p, v);
    }
    let version = make_version(
        client,
        &paths,
        &history_images(&paths).unwrap(),
        "update",
        None,
    );
    for (p, v) in paths.iter().zip(currents) {
        save(p, v);
    }
    let after =
        restored_images(client, &paths, &history_images(&paths).unwrap(), &version).unwrap();
    after
        .iter()
        .map(|(p, b)| parse(p, text(b.as_deref()).unwrap()).unwrap())
        .collect()
}
#[test]
fn codex_restore_keeps_new_custom_settings_and_does_not_resurrect_deleted_settings() {
    let result = restore_case("codex", &[
        "model = 'old'\nremoved_custom = true\n[model_providers.cpa-gui]\nbase_url = 'http://old'\ncustom_deleted = true\n",
        r#"{"models":[],"deleted_metadata":1}"#,
        r#"{"tokens":{"access_token":"old-secret"},"deleted_custom":true}"#,
    ], &[
        "# Keep comment\nmodel = 'new'\nnew_custom = 42\n[model_providers.cpa-gui]\nbase_url = 'http://new'\ncustom_added = true\n",
        r#"{"models":[{"slug":"new"}],"new_metadata":2}"#,
        r#"{"OPENAI_API_KEY":"new-secret","new_custom":42}"#,
    ]);
    assert_eq!(result[0]["model"], "old");
    assert_eq!(result[0]["new_custom"], 42);
    assert!(result[0].get("removed_custom").is_none());
    assert!(result[0]["model_providers"]["cpa-gui"]
        .get("custom_deleted")
        .is_none());
    assert_eq!(
        result[0]["model_providers"]["cpa-gui"]["custom_added"],
        true
    );
    assert_eq!(result[1]["new_metadata"], 2);
    assert!(result[1].get("deleted_metadata").is_none());
    assert_eq!(result[2]["tokens"]["access_token"], "old-secret");
    assert!(result[2].get("OPENAI_API_KEY").is_none());
    assert_eq!(result[2]["new_custom"], 42);
    assert!(result[2].get("deleted_custom").is_none());
}
#[test]
fn claude_restore_removes_absent_managed_fields_and_preserves_custom_env() {
    let result = restore_case(
        "claude-code",
        &[r#"{"env":{"ANTHROPIC_MODEL":"old","DELETED":"x"}}"#],
        &[
            r#"{"env":{"ANTHROPIC_MODEL":"new","ANTHROPIC_DEFAULT_SONNET_MODEL":"new","CLAUDE_CODE_SUBAGENT_MODEL":"new","CUSTOM":"keep"}}"#,
        ],
    );
    assert_eq!(result[0]["env"]["ANTHROPIC_MODEL"], "old");
    assert_eq!(result[0]["env"]["CUSTOM"], "keep");
    for key in [
        "DELETED",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        assert!(result[0]["env"].get(key).is_none());
    }
}
#[test]
fn hermes_restore_does_not_resurrect_deleted_unmanaged_provider() {
    let result = restore_case("hermes", &["custom_providers:\n  - name: personal\n    api_key: custom\n  - name: cpa-gui\n    api_key: old\n    custom_deleted: true\n"], &["theme: dark\n"]);
    assert_eq!(result[0]["theme"], "dark");
    let providers = result[0]["custom_providers"].as_array().unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0]["name"], "cpa-gui");
    assert!(providers[0].get("custom_deleted").is_none());
}
#[test]
fn pi_restore_leaves_packages_and_custom_values_untouched() {
    let result = restore_case(
        "pi",
        &[
            r#"{"apiKey":"old"}"#,
            r#"{"defaultModel":"old","packages":["old-package"]}"#,
        ],
        &[
            r#"{"apiKey":"new","custom":1}"#,
            r#"{"defaultModel":"new","packages":["new-package"],"theme":"dark"}"#,
        ],
    );
    assert_eq!(result[0]["apiKey"], "old");
    assert_eq!(result[0]["custom"], 1);
    assert_eq!(result[1]["defaultModel"], "old");
    assert_eq!(result[1]["packages"][0], "new-package");
}
#[test]
fn missing_files_restore_and_invalid_current_file_is_rejected() {
    let home = Home::new();
    let paths = history_paths("codex", &home.0).unwrap();
    let absent = history_images(&paths).unwrap();
    let missing = make_version("codex", &paths, &absent, "before-update", None);
    save(&paths[0], "model = 'new'\n");
    let after =
        restored_images("codex", &paths, &history_images(&paths).unwrap(), &missing).unwrap();
    assert!(after[0].1.is_none());
    let saved = make_version(
        "codex",
        &paths,
        &history_images(&paths).unwrap(),
        "update",
        None,
    );
    let after = restored_images("codex", &paths, &absent, &saved).unwrap();
    assert!(after[0].1.is_some());
    save(&paths[0], "{{invalid");
    assert!(restored_images("codex", &paths, &history_images(&paths).unwrap(), &saved).is_err());
}
#[test]
fn backup_failure_and_external_conflict_leave_current_files_untouched() {
    let home = Home::new();
    let paths = history_paths("codex", &home.0).unwrap();
    save(&paths[0], "model = 'old'\n");
    let before = history_images(&paths).unwrap();
    let mut after = before.clone();
    after[0].1 = Some(b"model = 'new'\n".to_vec());
    save(&paths[0], "model = 'external'\n");
    assert!(
        commit_history("codex", &paths, &before, &after, "update", None)
            .err()
            .unwrap()
            .contains("其他程序")
    );
    assert_eq!(
        fs::read_to_string(&paths[0]).unwrap(),
        "model = 'external'\n"
    );
    fs::write(&paths[0], before[0].1.as_ref().unwrap()).unwrap();
    let dir = history_directory("codex", &paths);
    fs::create_dir_all(dir.parent().unwrap()).unwrap();
    fs::write(&dir, "blocked").unwrap();
    assert!(commit_history("codex", &paths, &before, &after, "update", None).is_err());
    assert_eq!(history_images(&paths).unwrap(), before);
}
#[test]
fn partial_multi_file_write_rolls_back_and_keeps_recovery_snapshot() {
    let home = Home::new();
    let paths = history_paths("codex", &home.0).unwrap();
    save(&paths[0], "model = 'old'\n");
    let before = history_images(&paths).unwrap();
    let mut after = before.clone();
    after[0].1 = Some(b"model = 'new'\n".to_vec());
    after[1].1 = Some(b"{\"models\":[]}".to_vec());
    let mut first = true;
    let result = commit_history_with_writer(
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
                history_write_images(client, &vec![images[0].clone()])?;
                return Err("injected second-file failure".into());
            }
            history_write_images(client, images)
        },
    );
    assert!(result.is_err());
    assert_eq!(history_images(&paths).unwrap(), before);
    assert_eq!(versions("codex", &paths).unwrap().0.len(), 1);
}
#[test]
fn preview_masks_auth_and_revision_tracks_external_changes_and_versions_are_validated() {
    let home = Home::new();
    let paths = history_paths("codex", &home.0).unwrap();
    save(&paths[2], r#"{"OPENAI_API_KEY":"secret-old"}"#);
    let version = make_version(
        "codex",
        &paths,
        &history_images(&paths).unwrap(),
        "update",
        None,
    );
    write_version(&paths, &version).unwrap();
    save(&paths[2], r#"{"OPENAI_API_KEY":"secret-new"}"#);
    let first = preview("codex", &paths, &version.id).unwrap().0;
    assert_eq!(first.differences[0].before, "••••••");
    assert_eq!(first.differences[0].after, "••••••");
    save(&paths[0], "custom = true\n");
    assert_ne!(
        first.revision,
        preview("codex", &paths, &version.id).unwrap().0.revision
    );
    assert!(read_version("codex", &paths, "../escape").is_err());
    let mut tampered = version.clone();
    tampered.files[0].path = home.0.join("outside");
    fs::write(
        version_path("codex", &paths, &version.id).unwrap(),
        serde_json::to_vec(&tampered).unwrap(),
    )
    .unwrap();
    assert!(read_version("codex", &paths, &version.id).is_err());
}
#[test]
fn verified_legacy_import_is_deduplicated_and_keeps_original_backup() {
    let home = Home::new();
    let paths = history_paths("opencode", &home.0).unwrap();
    save(&paths[0], r#"{"model":"current"}"#);
    let backup = agent_backup_path(&paths[0]).unwrap();
    save(&backup, r#"{"model":"old"}"#);
    let record = AgentModificationRecord {
        version: AGENT_MODIFICATION_STATE_VERSION,
        client: "opencode".into(),
        phase: AGENT_PHASE_ACTIVE.into(),
        model: "current".into(),
        files: vec![AgentModificationFile {
            path: paths[0].clone(),
            backup_path: backup.clone(),
            existed_before: true,
            original_sha256: Some(sha256_bytes(&fs::read(&backup).unwrap())),
            managed_sha256: String::new(),
        }],
    };
    save(
        &agent_state_path(&paths).unwrap(),
        &serde_json::to_string(&record).unwrap(),
    );
    assert!(import_legacy_history("opencode", &home.0, &paths)
        .unwrap()
        .is_empty());
    assert!(import_legacy_history("opencode", &home.0, &paths)
        .unwrap()
        .is_empty());
    assert_eq!(versions("opencode", &paths).unwrap().0.len(), 1);
    assert!(backup.exists());
    let mut bad = record;
    bad.files[0].original_sha256 = Some("wrong".into());
    save(
        &agent_state_path(&paths).unwrap(),
        &serde_json::to_string(&bad).unwrap(),
    );
    assert!(!import_legacy_history("opencode", &home.0, &paths)
        .unwrap()
        .is_empty());
    assert!(backup.exists());
}
#[test]
fn semantic_noop_preserves_exact_comments_and_does_not_save_history() {
    let home = Home::new();
    let paths = history_paths("opencode", &home.0).unwrap();
    save(&paths[0], "// Keep this comment\n{model: 'old'}\n");
    let before = history_images(&paths).unwrap();
    let result = history_updates(
        "opencode",
        &home.0,
        &before,
        &[AgentFileUpdate {
            path: paths[0].clone(),
            after: r#"{"model":"old"}"#.into(),
        }],
        "update",
        None,
        None,
    )
    .unwrap();
    assert_eq!(result.outcome, "unchanged");
    assert_eq!(history_images(&paths).unwrap(), before);
    assert_eq!(versions("opencode", &paths).unwrap().0.len(), 0);
    let target = make_version("opencode", &paths, &before, "update", None);
    save(
        &paths[0],
        "// Current comment\n{model: 'new',custom: true}\n",
    );
    let after = restored_images(
        "opencode",
        &paths,
        &history_images(&paths).unwrap(),
        &target,
    )
    .unwrap();
    assert!(text(after[0].1.as_deref())
        .unwrap()
        .unwrap()
        .contains("// Current comment"));
}
#[test]
fn catalog_update_preserves_custom_metadata_and_rejects_invalid_existing_catalog() {
    let home = Home::new();
    let paths = history_paths("codex", &home.0).unwrap();
    save(&paths[1], r#"{"models":[],"custom":42}"#);
    let updates = vec![AgentFileUpdate {
        path: paths[1].clone(),
        after: r#"{"models":[{"slug":"new"}]}"#.into(),
    }];
    history_updates(
        "codex",
        &home.0,
        &history_images(&paths).unwrap(),
        &updates,
        "sync",
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        parse(&paths[1], Some(&fs::read_to_string(&paths[1]).unwrap())).unwrap()["custom"],
        42
    );
    save(&paths[1], "invalid");
    assert!(history_updates(
        "codex",
        &home.0,
        &history_images(&paths).unwrap(),
        &updates,
        "update",
        None,
        None
    )
    .is_err());
    assert_eq!(fs::read_to_string(&paths[1]).unwrap(), "invalid");
}
#[test]
fn pi_package_changes_are_backed_up_and_failures_roll_back_only_config_files() {
    let home = Home::new();
    let paths = history_paths("pi", &home.0).unwrap();
    save(&paths[1], r#"{"packages":[]}"#);
    history_package_operation(&home.0, "plugin-install", || {
        save(&paths[1], r#"{"packages":["installed"]}"#);
        Ok(())
    })
    .unwrap();
    assert_eq!(versions("pi", &paths).unwrap().0.len(), 2);
    let before = history_images(&paths).unwrap();
    let package = home.0.join("package-installed");
    assert!(history_package_operation(&home.0, "plugin-update", || {
        save(&paths[1], "{}");
        save(&package, "package is outside config history");
        Err("package failure".into())
    })
    .is_err());
    assert_eq!(history_images(&paths).unwrap(), before);
    assert!(package.exists());
}
#[test]
fn desktop_profile_index_restores_only_managed_entry_fields() {
    let home = Home::new();
    let paths = history_paths("claude-desktop", &home.0).unwrap();
    let old = serde_json::json!({"appliedId":CLAUDE_DESKTOP_PROFILE_ID,"entries":[{"id":CLAUDE_DESKTOP_PROFILE_ID,"name":"old","deleted_custom":true},{"id":"deleted-personal"}]});
    save(&paths[3], &old.to_string());
    let version = make_version(
        "claude-desktop",
        &paths,
        &history_images(&paths).unwrap(),
        "update",
        None,
    );
    let current = serde_json::json!({"entries":[{"id":CLAUDE_DESKTOP_PROFILE_ID,"name":"new","new_custom":42},{"id":"new-personal"}]});
    save(&paths[3], &current.to_string());
    let after = restored_images(
        "claude-desktop",
        &paths,
        &history_images(&paths).unwrap(),
        &version,
    )
    .unwrap();
    let value = parse(&paths[3], text(after[3].1.as_deref()).unwrap()).unwrap();
    let entries = value["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["id"], "new-personal");
    assert_eq!(entries[1]["name"], "old");
    assert_eq!(entries[1]["new_custom"], 42);
    assert!(entries[1].get("deleted_custom").is_none());
}
#[test]
fn directory_at_config_path_is_an_error() {
    let home = Home::new();
    let paths = history_paths("codex", &home.0).unwrap();
    fs::create_dir_all(&paths[0]).unwrap();
    assert!(history_images(&paths).is_err());
}

fn desktop_test_models() -> Vec<AgentModelOption> {
    ["model-a", "model-b"].into_iter().map(|name| AgentModelOption {
        name: name.into(), alias: None, is_alias: false, context_window: Some(200_000),
    }).collect()
}

fn apply_desktop_test_model(home: &Path, model: &str) -> AgentConfigActionResult {
    let mappings = ClaudeDesktopModelMappings::all(model);
    apply_agent_configuration_with_oauth(
        AgentClient::ClaudeDesktop, home, 8317, "test-key", model,
        AgentConfigurationOptions {
            models: &desktop_test_models(), codex_catalog: None, oauth_configuration: false,
            claude_code_model_mappings: None, claude_desktop_model_mappings: Some(&mappings),
        },
    ).unwrap()
}

#[test]
fn desktop_mapping_changes_are_saved_when_profile_bytes_are_identical() {
    let home = Home::new();
    let paths = history_paths("claude-desktop", &home.0).unwrap();
    let first = apply_desktop_test_model(&home.0, "model-a");
    let images = history_images(&paths).unwrap();
    let first_id = first.history_version.unwrap();
    let original_preview = preview("claude-desktop", &paths, &first_id).unwrap().0;
    let second = apply_desktop_test_model(&home.0, "model-b");
    assert_eq!(second.outcome, "updated");
    assert!(second.changed_files.is_empty());
    assert!(second.history_version.is_some());
    assert_eq!(images, history_images(&paths).unwrap());
    assert_eq!(versions("claude-desktop", &paths).unwrap().0.len(), 4);
    assert_eq!(current_desktop_history_mappings(&home.0).unwrap().opus, "model-b");
    let next_preview = preview("claude-desktop", &paths, &first_id).unwrap().0;
    assert_ne!(original_preview.revision, next_preview.revision);
    assert!(next_preview.differences.iter().any(|diff| diff.field == "modelMappings.opus"));
    let unchanged = apply_desktop_test_model(&home.0, "model-b");
    assert_eq!(unchanged.outcome, "unchanged");
    assert!(unchanged.history_version.is_none());
    assert_eq!(versions("claude-desktop", &paths).unwrap().0.len(), 4);
}
