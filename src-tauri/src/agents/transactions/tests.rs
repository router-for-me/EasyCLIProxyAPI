use super::*;

#[test]
fn codex_model_merge_does_not_resurrect_removed_schema_fields() {
    let before = serde_json::json!({"models": [{
        "slug": "third-party-model",
        "minimal_client_version": "999.0.0",
        "model_messages": {"instructions_template": "old", "retired": "old"},
        "extensions": {"nested": [1, 2]}
    }]});
    let mut after = serde_json::json!({"models": [{
        "slug": "third-party-model",
        "model_messages": {"instructions_template": "new"}
    }]});
    let mut expected = after.clone();
    expected["models"][0]["extensions"] = before["models"][0]["extensions"].clone();
    preserve_model_extensions(
        "codex",
        Path::new(CODEX_MODEL_CATALOG_FILE),
        &before,
        &mut after,
    );
    assert_eq!(after, expected);
}

#[test]
fn mid_transaction_external_edit_is_preserved_while_earlier_writes_are_rolled_back() {
    let home = std::env::temp_dir().join(format!("cpa-transaction-race-{}", std::process::id()));
    fs::create_dir_all(&home).unwrap();
    let paths = vec![home.join("first.json"), home.join("second.json")];
    for path in &paths {
        fs::write(path, "{}").unwrap();
    }
    let before = config_images(&paths).unwrap();
    let after = paths
        .iter()
        .map(|p| (p.clone(), Some(b"{\"next\":true}".to_vec())))
        .collect();
    let mut writes = 0;
    let result = commit_config_transaction(
        "pi",
        &paths,
        &before,
        &after,
        "update",
        None,
        None,
        &mut |client, images| {
            write_config_images(client, images)?;
            writes += 1;
            if writes == 1 {
                fs::write(&paths[1], "{\"external\":true}").unwrap();
            }
            Ok(())
        },
        true,
    );
    assert!(result.is_err());
    assert_eq!(fs::read_to_string(&paths[0]).unwrap(), "{}");
    assert_eq!(
        fs::read_to_string(&paths[1]).unwrap(),
        "{\"external\":true}"
    );
    fs::remove_dir_all(home).unwrap();
}
