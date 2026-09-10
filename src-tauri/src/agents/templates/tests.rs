use super::*;

#[test]
fn core_failure_messages_expose_outcomes_without_secret_source_text() {
    for detail in [
        "YAML source: key: secret-token",
        "已恢复原配置 secret-token",
        "自动恢复失败 secret-token",
        "配置已变化 secret-token",
    ] {
        let rendered = agent_core_error(detail.into());
        assert!(!rendered.contains("secret-token"));
        if detail.contains("自动恢复失败") {
            assert!(rendered.contains("回滚失败"));
        }
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
