use super::*;

#[test]
fn core_failure_messages_expose_outcomes_without_secret_source_text() {
    for detail in [
        "YAML source: key: secret-token",
        "Original configuration restored secret-token",
        "Automatic restoration failed secret-token",
        "Configuration changed secret-token",
    ] {
        let rendered = agent_core_error(detail.into());
        assert!(!rendered.contains("secret-token"));
        if detail.contains("Automatic restoration failed") {
            assert!(rendered.contains("rollback also failed"));
        }
    }
}

#[test]
fn core_failure_messages_distinguish_alias_and_configuration_failures() {
    for (detail, expected) in [
        (
            "Already used by another model: claude-sonnet-5 secret-token",
            "Choose a different alias",
        ),
        (
            "Unable to determine model private-model CPA configuration source; cannot create Claude Desktop alias secret-token",
            "valid access source",
        ),
        (
            "Updated kernel configuration does not match the expected value (path: secret-token); write rejected",
            "format compatibility check failed",
        ),
        (
            "Failed to validate updated kernel configuration: secret-token",
            "original configuration was not written",
        ),
        (
            "Failed to parse kernel YAML configuration: secret-token",
            "Invalid kernel YAML configuration format",
        ),
        ("Management API error (401): secret-token", "authentication failed"),
        ("Management API error (403): secret-token", "authentication failed"),
    ] {
        let rendered = agent_core_error(detail.into());
        assert!(rendered.contains(expected), "{rendered}");
        assert!(!rendered.contains("secret-token"));
        assert!(!rendered.contains("private-model"));
    }
}

#[tokio::test]
async fn template_confirmation_is_bound_to_files_and_generated_content() {
    let home = std::env::temp_dir().join(format!(
        "cpa-template-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&home).unwrap();
    let paths = config_paths("pi", &home).unwrap();
    let before = config_images(&paths).unwrap();
    let updates = build_pi_template_updates(&home, 8317, "secret", "model").unwrap();
    let after = prepare_config_updates("pi", &paths, &before, &updates, true).unwrap();
    let plan = || TemplatePlan {
        client: "pi".into(),
        paths: paths.clone(),
        before: before.clone(),
        after: after.clone(),
        mappings: None,
        mapping_revision: String::new(),
        model: "model".into(),
        core: None,
        preview: TemplatePreview {
            revision: "reviewed".into(),
            files: Vec::new(),
        },
    };
    assert!(
        execute_template_plan(&GuiConfigFile::default(), plan(), "outdated")
            .await
            .is_err()
    );
    assert_eq!(before, config_images(&paths).unwrap());
    fs::create_dir_all(paths[0].parent().unwrap()).unwrap();
    fs::write(&paths[0], "external edit").unwrap();
    assert!(
        execute_template_plan(&GuiConfigFile::default(), plan(), "reviewed")
            .await
            .is_err()
    );
    assert_eq!(fs::read_to_string(&paths[0]).unwrap(), "external edit");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn incomplete_or_invalid_template_never_writes_any_file() {
    let home = std::env::temp_dir().join(format!("cpa-template-invalid-{}", std::process::id()));
    let paths = config_paths("pi", &home).unwrap();
    let before = config_images(&paths).unwrap();
    let mut updates = build_pi_template_updates(&home, 8317, "secret", "model").unwrap();
    assert!(prepare_config_updates("pi", &paths, &before, &updates[..1], true).is_err());
    updates[1].after = "invalid".into();
    assert!(prepare_config_updates("pi", &paths, &before, &updates, true).is_err());
    assert_eq!(before, config_images(&paths).unwrap());
}

#[test]
fn desktop_missing_source_names_row_without_leaking_raw_error() {
    let mappings: ClaudeDesktopModelMappings = serde_json::from_value(serde_json::json!({
        "desktopModels": [
            {"model":"claude-sonnet-5", "alias":""},
            {"model":"kimi-k3", "alias":"claude-custom-7"}
        ]
    })).unwrap();
    let error = desktop_mapping_error("Unable to determine the CPA configuration source for model kimi-k3; cannot create Claude Desktop alias secret-token".into(), &mappings);
    assert!(error.contains("Row 2"));
    assert!(error.contains("kimi-k3"));
    assert!(error.contains("Nothing was applied"));
    assert!(!error.contains("secret-token"));
    assert!(!desktop_mapping_error("YAML key: secret-token".into(), &mappings).contains("secret-token"));
}

#[test]
fn desktop_missing_source_skips_unmapped_rows_sharing_the_same_source_model() {
    // Row 1 has no alias, so entry.has_mapping() is false and the real builder
    // (ensure_claude_desktop_model_aliases_with_oauth_definitions_and_routes_in_yaml)
    // never processes it or produces this error for it, even though its model matches
    // the row that actually failed. Row 1 is also skipped a second time further down
    // with a model==alias row, which has_mapping() excludes for the same reason. Only
    // row 3, the one actually processed and failing, may be named.
    let mappings: ClaudeDesktopModelMappings = serde_json::from_value(serde_json::json!({
        "desktopModels": [
            {"model":"kimi-k3", "alias":""},
            {"model":"kimi-k3", "alias":"kimi-k3"},
            {"model":"kimi-k3", "alias":"claude-custom-2"}
        ]
    })).unwrap();
    let error = desktop_mapping_error("Unable to determine the CPA configuration source for model kimi-k3; cannot create Claude Desktop alias secret-token".into(), &mappings);
    assert!(error.contains("Row 3"), "expected the real failing row, got: {error}");
    assert!(!error.contains("Row 1"));
    assert!(!error.contains("Row 2"));
}
