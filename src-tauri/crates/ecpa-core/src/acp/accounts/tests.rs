use super::*;

fn fixture() -> PathBuf {
    let root = crate::unique_test_temp_path("acp-accounts-lifecycle");
    prepare_profile(&root).unwrap();
    root
}
fn add(root: &Path, label: &str) -> String {
    let mut pending = PendingAccount::new(root, label).unwrap();
    pending
        .commit(Some(format!("{}@example.test", label.to_lowercase())))
        .unwrap();
    pending.id.clone()
}
fn saved_default(root: &Path) {
    mark_saved(root).unwrap();
    set_active_email(root, Some("legacy@example.test".into())).unwrap();
    std::fs::create_dir_all(root.join(".gemini")).unwrap();
    std::fs::write(root.join(".gemini/test-login"), "legacy-only").unwrap();
}

#[test]
fn legacy_metadata_migrates_without_claiming_empty_default_is_saved() {
    let root = fixture();
    assert!(!read(&root).unwrap().accounts[0].saved);
    std::fs::write(root.join("accounts.json"), br#"{"active":"default","accounts":[{"id":"default","label":"Default","email":"legacy@example.test"}]}"#).unwrap();
    assert!(read(&root).unwrap().accounts[0].saved);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn notes_validate_unicode_trim_and_show_errors() {
    let root = fixture();
    for bad in ["", "   ", "a\nb", "hello\u{0}", &"字".repeat(81)] {
        assert!(rename(&root, "default", bad).is_err());
        assert!(PendingAccount::new(&root, bad).is_err());
    }
    rename(&root, "default", &format!("  {}  ", "字".repeat(80))).unwrap();
    assert_eq!(read(&root).unwrap().accounts[0].label, "字".repeat(80));
    assert!(rename(&root, "unknown", "Valid").is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_and_cancelled_provisional_accounts_never_consume_slots_or_selection() {
    let root = fixture();
    saved_default(&root);
    for _ in 0..35 {
        let mut pending = PendingAccount::new(&root, "Cancelled").unwrap();
        std::fs::write(
            pending.directory().unwrap().join("auth-result"),
            "uncertain-private-data",
        )
        .unwrap();
        assert_eq!(read(&root).unwrap().active, "default");
        assert_eq!(read(&root).unwrap().accounts.len(), 1);
        let source = pending.directory().unwrap();
        pending.rollback().unwrap();
        assert!(!source.exists());
        assert!(root.join(".gemini/test-login").exists());
    }
    assert_eq!(
        std::fs::read_dir(root.join("removed-accounts"))
            .unwrap()
            .count(),
        35
    );
    let id;
    {
        let pending = PendingAccount::new(&root, "Dropped").unwrap();
        id = pending.id.clone();
    }
    assert!(!directory(&root, &id).unwrap().exists());
    assert_eq!(read(&root).unwrap().accounts.len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn successful_pending_commit_survives_drop_and_replaces_only_empty_placeholder() {
    let root = fixture();
    let id = add(&root, "Work");
    assert_eq!(read(&root).unwrap().accounts.len(), 1);
    assert_eq!(read(&root).unwrap().active, id);
    assert!(read(&root).unwrap().accounts[0].saved);
    assert!(directory(&root, &id).unwrap().exists());
    assert!(!root.join("removed-accounts").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn remove_default_is_recoverable_and_preserves_other_accounts_and_bridge() {
    let root = fixture();
    saved_default(&root);
    std::fs::write(root.join("bridge.json"), r#"{"enabled":true,"port":19999}"#).unwrap();
    std::fs::write(root.join("bridge-key.txt"), "test-internal-key").unwrap();
    std::fs::write(root.join("unknown-infrastructure"), "preserve-root").unwrap();
    std::fs::write(selected_path(&root), br#""legacy-model""#).unwrap();
    let work = add(&root, "Work");
    let work_dir = directory(&root, &work).unwrap();
    std::fs::write(work_dir.join("private-marker"), "work-only").unwrap();
    select(&root, "default").unwrap();
    let recovery = remove(&root, "default").unwrap();
    assert_eq!(read(&root).unwrap().active, work);
    assert_eq!(read(&root).unwrap().accounts.len(), 1);
    assert_eq!(
        std::fs::read_to_string(recovery.join(".gemini/test-login")).unwrap(),
        "legacy-only"
    );
    assert!(recovery.join("workspace").is_dir());
    assert!(recovery.join("selected-model.json").is_file());
    assert!(!root.join(".gemini").exists());
    assert_eq!(
        std::fs::read_to_string(work_dir.join("private-marker")).unwrap(),
        "work-only"
    );
    assert!(super::super::bridge::upstream_enabled(&root).unwrap());
    assert_eq!(
        std::fs::read_to_string(root.join("unknown-infrastructure")).unwrap(),
        "preserve-root"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("bridge-key.txt")).unwrap(),
        "test-internal-key"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn remove_inactive_active_and_last_have_deterministic_landing() {
    let root = fixture();
    let personal = add(&root, "Personal");
    let work = add(&root, "Work");
    let third = add(&root, "Third");
    let removed = remove(&root, &work).unwrap();
    assert!(removed.join(&work).is_dir());
    assert_eq!(read(&root).unwrap().active, third);
    remove(&root, &third).unwrap();
    assert_eq!(read(&root).unwrap().active, personal);
    remove(&root, &personal).unwrap();
    let registry = read(&root).unwrap();
    assert_eq!(registry.active, "default");
    assert_eq!(registry.accounts.len(), 1);
    assert!(!registry.accounts[0].saved);
    assert!(registry.accounts[0].email.is_none());
    remove(&root, "default").unwrap();
    assert_eq!(read(&root).unwrap().active, "default");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn account_selection_model_and_email_stay_isolated() {
    let root = fixture();
    saved_default(&root);
    std::fs::write(selected_path(&root), br#""personal-model""#).unwrap();
    let work = add(&root, "Work");
    let second = active(&root).unwrap();
    assert!(!second.join(".gemini/test-login").exists());
    std::fs::write(selected_path(&second), br#""work-model""#).unwrap();
    set_active_email(&root, None).unwrap();
    select(&root, "default").unwrap();
    assert_eq!(
        read_selected(&active(&root).unwrap()).unwrap(),
        "personal-model"
    );
    assert_eq!(
        read(&root).unwrap().accounts[0].email.as_deref(),
        Some("legacy@example.test")
    );
    select(&root, &work).unwrap();
    assert_eq!(
        read_selected(&active(&root).unwrap()).unwrap(),
        "work-model"
    );
    assert!(read(&root).unwrap().accounts[1].email.is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn rejects_traversal_unknown_ids_and_invalid_registries() {
    let root = fixture();
    for id in ["../outside", "", "/tmp", "default/..", "a", "../../default"] {
        assert!(directory(&root, id).is_err());
        assert!(remove(&root, id).is_err());
        assert!(select(&root, id).is_err());
    }
    std::fs::write(
        root.join("accounts.json"),
        br#"{"active":"default","accounts":[{"id":"../outside","label":"bad"}]}"#,
    )
    .unwrap();
    assert!(read(&root).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn rejects_symlink_root_account_parent_account_and_default_login() {
    use std::os::unix::fs::symlink;
    let root = fixture();
    let outside = crate::unique_test_temp_path("acp-accounts-outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("never-touch"), "safe").unwrap();
    let link = root.join("linked-root");
    symlink(&outside, &link).unwrap();
    assert!(read(&link).is_err());
    std::fs::remove_file(link).unwrap();
    symlink(&outside, root.join("accounts")).unwrap();
    assert!(PendingAccount::new(&root, "Work").is_err());
    std::fs::remove_file(root.join("accounts")).unwrap();
    let id = add(&root, "Work");
    let account = directory(&root, &id).unwrap();
    std::fs::rename(&account, root.join("preserved-account")).unwrap();
    symlink(&outside, &account).unwrap();
    assert!(remove(&root, &id).is_err());
    assert!(select(&root, &id).is_err());
    std::fs::remove_file(account).unwrap();
    symlink(&outside, root.join(".gemini")).unwrap();
    mark_saved(&root).unwrap();
    // Include a default record explicitly; it must never follow the link.
    let mut registry = read(&root).unwrap();
    registry
        .accounts
        .push(Accounts::default().accounts.remove(0));
    write(&root, &registry).unwrap();
    assert!(remove(&root, "default").is_err());
    assert_eq!(
        std::fs::read_to_string(outside.join("never-touch")).unwrap(),
        "safe"
    );
    assert_eq!(read(&root).unwrap().accounts.len(), 2);
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

#[test]
fn registry_write_failure_does_not_discard_officially_authorized_profile() {
    let root = fixture();
    let mut pending = PendingAccount::new(&root, "Authorized").unwrap();
    let account = pending.directory().unwrap();
    std::fs::create_dir(root.join("accounts.json")).unwrap();
    assert!(pending.commit(None).is_err());
    pending.rollback().unwrap();
    drop(pending);
    assert!(account.is_dir());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn removal_rolls_back_moves_when_registry_cannot_be_replaced() {
    let root = fixture();
    saved_default(&root);
    let registry = read(&root).unwrap();
    std::fs::remove_file(root.join("accounts.json")).unwrap();
    std::fs::create_dir(root.join("accounts.json")).unwrap();
    assert!(quarantine(&root, "default", Some(&registry)).is_err());
    assert!(root.join(".gemini/test-login").exists());
    assert!(root.join("workspace").is_dir());
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn registry_and_recovery_data_are_private_and_registry_link_is_refused() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = fixture();
    saved_default(&root);
    assert_eq!(
        std::fs::metadata(root.join("accounts.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let recovery = remove(&root, "default").unwrap();
    for directory in [recovery, recoveries_path(&root)] {
        assert_eq!(
            std::fs::metadata(directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let outside = crate::unique_test_temp_path("acp-registry-outside");
    std::fs::write(&outside, b"never-modify").unwrap();
    std::fs::remove_file(root.join("accounts.json")).unwrap();
    symlink(&outside, root.join("accounts.json")).unwrap();
    assert!(rename(&root, "default", "New").is_err());
    assert_eq!(std::fs::read(&outside).unwrap(), b"never-modify");
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_file(outside).unwrap();
}

#[test]
fn empty_placeholder_does_not_reduce_capacity_and_unsuccessful_add_is_not_saved() {
    let root = fixture();
    for index in 0..MAX_ACCOUNTS {
        add(&root, &format!("Account{index}"));
    }
    assert_eq!(read(&root).unwrap().accounts.len(), MAX_ACCOUNTS);
    assert!(PendingAccount::new(&root, "Overflow").is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_default_without_email_survives_new_authorization_and_new_account_removal() {
    let root = fixture();
    std::fs::write(
        root.join("accounts.json"),
        br#"{"active":"default","accounts":[{"id":"default","label":"Legacy personal note"}]}"#,
    )
    .unwrap();
    std::fs::write(selected_path(&root), br#""historical-model""#).unwrap();
    std::fs::create_dir_all(root.join(".gemini")).unwrap();
    std::fs::write(
        root.join(".gemini/history-marker"),
        "fixture-not-a-credential",
    )
    .unwrap();
    assert!(read(&root).unwrap().accounts[0].saved);
    let mut pending = PendingAccount::new(&root, "Unverified").unwrap();
    assert_eq!(
        pending.commit(Some("new@example.test".into())).unwrap_err(),
        IDENTITY_UNKNOWN
    );
    pending.rollback().unwrap();
    assert_eq!(read(&root).unwrap().accounts.len(), 1);
    // A successful official connection can subsequently supply identity.
    set_active_email(&root, Some("legacy@example.test".into())).unwrap();
    let new = add(&root, "New");
    let registry = read(&root).unwrap();
    assert_eq!(registry.accounts.len(), 2);
    assert_eq!(registry.accounts[0].label, "Legacy personal note");
    assert_eq!(
        registry.accounts[0].email.as_deref(),
        Some("legacy@example.test")
    );
    select(&root, "default").unwrap();
    assert_eq!(
        read_selected(&active(&root).unwrap()).unwrap(),
        "historical-model"
    );
    select(&root, &new).unwrap();
    remove(&root, &new).unwrap();
    let registry = read(&root).unwrap();
    assert_eq!(registry.active, "default");
    assert_eq!(registry.accounts.len(), 1);
    assert_eq!(registry.accounts[0].label, "Legacy personal note");
    assert!(registry.accounts[0].saved);
    assert!(root.join(".gemini/history-marker").is_file());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_registry_with_legacy_profile_or_selected_model_preserves_default_across_add_remove() {
    for history in ["selected-model", "official-profile", "workspace"] {
        let root = fixture();
        match history {
            "selected-model" => {
                std::fs::write(selected_path(&root), br#""historical-model""#).unwrap()
            }
            "official-profile" => {
                let directory = root.join(".gemini/antigravity-cli");
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(
                    directory.join("history-fixture"),
                    "fixture-only-not-a-credential",
                )
                .unwrap();
            }
            _ => std::fs::write(
                root.join("workspace/history-fixture"),
                "historical workspace fixture",
            )
            .unwrap(),
        }
        assert!(!root.join("accounts.json").exists());
        let legacy = read(&root).unwrap();
        assert_eq!(legacy.active, "default");
        assert!(legacy.accounts[0].saved, "{history}");
        assert!(legacy.accounts[0].email.is_none());
        // Reading migration state is side-effect free and does not invent email.
        assert!(!root.join("accounts.json").exists());
        let mut pending = PendingAccount::new(&root, "Unverified").unwrap();
        assert_eq!(
            pending.commit(Some("new@example.test".into())).unwrap_err(),
            IDENTITY_UNKNOWN
        );
        pending.rollback().unwrap();
        assert!(!root.join("accounts.json").exists());
        set_active_email(&root, Some("legacy@example.test".into())).unwrap();
        let new = add(&root, "New");
        assert_eq!(read(&root).unwrap().accounts.len(), 2, "{history}");
        select(&root, "default").unwrap();
        assert_eq!(active(&root).unwrap(), root);
        if history == "selected-model" {
            assert_eq!(read_selected(&root).unwrap(), "historical-model");
        }
        select(&root, &new).unwrap();
        remove(&root, &new).unwrap();
        let registry = read(&root).unwrap();
        assert_eq!(registry.active, "default");
        assert_eq!(registry.accounts.len(), 1);
        assert!(registry.accounts[0].saved);
        assert_eq!(registry.accounts[0].label, "Default");
        assert_eq!(
            registry.accounts[0].email.as_deref(),
            Some("legacy@example.test")
        );
        if history == "official-profile" {
            assert!(root
                .join(".gemini/antigravity-cli/history-fixture")
                .is_file());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn absent_or_new_empty_profile_and_nonaccount_infrastructure_do_not_save_default() {
    let root = crate::unique_test_temp_path("acp-empty-default-migration");
    assert!(!root.exists());
    assert!(!read(&root).unwrap().accounts[0].saved);
    assert!(!root.exists(), "status reads must not create the profile");
    prepare_profile(&root).unwrap();
    assert!(!read(&root).unwrap().accounts[0].saved);
    // Even nested empty CLI/workspace directories contain no historical data.
    std::fs::create_dir_all(root.join(".gemini/antigravity-cli/empty")).unwrap();
    std::fs::create_dir_all(root.join("workspace/empty/nested")).unwrap();
    std::fs::write(root.join("bridge.json"), r#"{"enabled":false}"#).unwrap();
    std::fs::write(root.join("bridge-key.txt"), "fixture-infrastructure").unwrap();
    std::fs::create_dir_all(root.join("removed-accounts/fixture")).unwrap();
    std::fs::write(
        root.join("removed-accounts/fixture/history"),
        "other-isolated-account",
    )
    .unwrap();
    assert!(!read(&root).unwrap().accounts[0].saved);
    let mut pending = PendingAccount::new(&root, "New").unwrap();
    std::fs::write(
        pending.directory().unwrap().join("pending-history"),
        "not-default-history",
    )
    .unwrap();
    assert!(!read(&root).unwrap().accounts[0].saved);
    pending.commit(None).unwrap();
    assert_eq!(read(&root).unwrap().accounts.len(), 1);
    assert_eq!(read(&root).unwrap().active, pending.id);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn explicit_unsaved_placeholder_stays_unsaved_even_with_old_profile_artifacts() {
    let root = fixture();
    std::fs::write(
        root.join("accounts.json"),
        br#"{"active":"default","accounts":[{"id":"default","label":"Default","saved":false}]}"#,
    )
    .unwrap();
    std::fs::write(selected_path(&root), br#""unverified-model-preference""#).unwrap();
    std::fs::create_dir_all(root.join(".gemini")).unwrap();
    std::fs::write(
        root.join(".gemini/history-fixture"),
        "explicitly-unsaved-fixture",
    )
    .unwrap();
    assert!(!read(&root).unwrap().accounts[0].saved);
    let new = add(&root, "New");
    assert_eq!(read(&root).unwrap().accounts.len(), 1);
    assert_eq!(read(&root).unwrap().active, new);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn missing_registry_history_probe_never_follows_a_profile_symlink() {
    use std::os::unix::fs::symlink;
    let root = fixture();
    let outside = crate::unique_test_temp_path("acp-legacy-history-outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("marker"), "not-read").unwrap();
    symlink(&outside, root.join(".gemini")).unwrap();
    assert!(read(&root).is_err());
    assert!(!root.join("accounts.json").exists());
    assert!(outside.join("marker").is_file());
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

#[cfg(unix)]
#[test]
fn isolated_accounts_restore_and_read_separate_files_across_fresh_processes() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::process::Stdio;
    let root = fixture();
    mark_saved(&root).unwrap(); // Legacy account with no recorded email.
    let first = PendingAccount::new_isolated(&root, "A", false).unwrap();
    let second = PendingAccount::new_isolated(&root, "B", false).unwrap();
    let executable = root.join("agy-fixture");
    std::fs::write(&executable, "#!/bin/sh\n[ \"$HOME\" = \"$GEMINI_CLI_HOME\" ] || exit 4\n[ \"$SSH_CONNECTION\" = '127.0.0.1 0 127.0.0.1 0' ] || exit 5\np=\"$HOME/.gemini/antigravity-cli/antigravity-oauth-token\"\nif [ \"$FIXTURE_LOGOUT\" = yes ]; then /bin/rm \"$p\"; else /bin/cat \"$p\"; fi\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut ids = Vec::new();
    for (mut account, value, email) in [
        (first, "fixture-a", "first@example.test"),
        (second, "fixture-b", "second@example.test"),
    ] {
        let token = isolated_token(&account.directory().unwrap());
        std::fs::create_dir_all(token.parent().unwrap()).unwrap();
        std::fs::write(token, value).unwrap();
        account.commit(Some(email.into())).unwrap();
        ids.push(account.id.clone());
    }
    let launch = |id: &str, logout| {
        select(&root, id).unwrap();
        let registry = read(&root).unwrap(); // Reopen persisted registry for every launch.
        assert_eq!(registry.active, id);
        assert!(registry
            .accounts
            .iter()
            .any(|account| account.id == id && account.isolated));
        let home = active(&root).unwrap();
        rpc::command(&executable, &home, "")
            .unwrap()
            .env("FIXTURE_LOGOUT", if logout { "yes" } else { "no" })
            .stderr(Stdio::null())
            .output()
            .unwrap()
    };
    for (id, expected) in [
        (&ids[0], b"fixture-a"),
        (&ids[1], b"fixture-b"),
        (&ids[0], b"fixture-a"),
    ] {
        let out = launch(id, false);
        assert!(out.status.success());
        assert_eq!(&out.stdout, expected);
    }
    let home = active(&root).unwrap();
    let negative = rpc::command(&executable, &home, "")
        .unwrap()
        .env_remove("SSH_CONNECTION")
        .output()
        .unwrap();
    assert_eq!(negative.status.code(), Some(5));
    assert!(launch(&ids[1], true).status.success());
    assert!(!isolated_token(&active(&root).unwrap()).exists());
    assert_eq!(launch(&ids[0], false).stdout, b"fixture-a");
    let token = isolated_token(&active(&root).unwrap());
    let elsewhere = root.join("unrelated");
    std::fs::write(&elsewhere, b"unrelated").unwrap();
    std::fs::remove_file(&token).unwrap();
    symlink(&elsewhere, &token).unwrap();
    assert!(rpc::command(&executable, &active(&root).unwrap(), "").is_err());
    assert_eq!(directory(&root, "default").unwrap(), root);
    let legacy = rpc::command(&executable, &root, "").unwrap();
    assert!(!legacy
        .get_envs()
        .any(|(name, _)| name == "HOME" || name == "SSH_CONNECTION"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn per_account_settings_validate_persist_and_survive_reauthorization() {
    let root = fixture();
    // Legacy accounts.json without new fields deserializes with safe defaults.
    std::fs::write(
        root.join("accounts.json"),
        br#"{"active":"default","accounts":[{"id":"default","label":"Default","saved":true,"email":"a@example.test"}]}"#,
    )
    .unwrap();
    let legacy = read(&root).unwrap();
    assert!(legacy.accounts[0].enabled);
    assert_eq!(legacy.accounts[0].priority, 0);
    assert_eq!(legacy.accounts[0].weight, 1);
    assert_eq!(legacy.accounts[0].max_concurrency, 1);
    assert_eq!(legacy.accounts[0].proxy_url, None);

    // Invalid weights, concurrencies, and proxies are rejected cleanly.
    for bad in [
        AccountSettingsPatch { weight: Some(0), ..Default::default() },
        AccountSettingsPatch { weight: Some(101), ..Default::default() },
        AccountSettingsPatch { max_concurrency: Some(0), ..Default::default() },
        AccountSettingsPatch { max_concurrency: Some(17), ..Default::default() },
        AccountSettingsPatch { proxy_url: Some("ftp://bad.example".into()), ..Default::default() },
        AccountSettingsPatch { proxy_url: Some("http://bad proxy".into()), ..Default::default() },
    ] {
        assert!(update_settings(&root, "default", &bad).is_err());
    }

    let updated = update_settings(
        &root,
        "default",
        &AccountSettingsPatch {
            label: Some("  Primary Pool  ".into()),
            enabled: Some(false),
            priority: Some(2),
            weight: Some(5),
            max_concurrency: Some(4),
            proxy_url: Some("http://127.0.0.1:7890".into()),
        },
    )
    .unwrap();
    assert_eq!(updated.label, "Primary Pool");
    assert!(!updated.enabled);
    assert_eq!(updated.priority, 2);
    assert_eq!(updated.weight, 5);
    assert_eq!(updated.max_concurrency, 4);
    assert_eq!(updated.proxy_url.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(resolve_proxy(updated.proxy_url.as_deref(), "http://global:1080"), "http://127.0.0.1:7890");
    assert_eq!(resolve_proxy(Some("direct"), "http://global:1080"), "");
    assert_eq!(resolve_proxy(None, "http://global:1080"), "http://global:1080");
    // Disabled account must not yield a pool route.
    assert!(route_profile(&root, &updated).is_none());

    // Isolated account reauthorization preserves its routing settings.
    let mut iso = PendingAccount::new_isolated(&root, "Work", false).unwrap();
    let token = isolated_token(&iso.directory().unwrap());
    std::fs::create_dir_all(token.parent().unwrap()).unwrap();
    std::fs::write(&token, b"synthetic").unwrap();
    iso.commit_replacing(Some("work@example.test".into()), None, false).unwrap();
    let iso_id = iso.id.clone();
    update_settings(
        &root,
        &iso_id,
        &AccountSettingsPatch {
            priority: Some(1),
            weight: Some(7),
            max_concurrency: Some(3),
            proxy_url: Some("direct".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let iso_account = get(&root, &iso_id).unwrap();
    assert!(route_profile(&root, &iso_account).is_some());

    let mut replacement = PendingAccount::new_isolated(&root, "Work", true).unwrap();
    let rtoken = isolated_token(&replacement.directory().unwrap());
    std::fs::create_dir_all(rtoken.parent().unwrap()).unwrap();
    std::fs::write(&rtoken, b"synthetic-v2").unwrap();
    replacement
        .commit_replacing(Some("work@example.test".into()), Some(&iso_id), false)
        .unwrap();
    let replaced = get(&root, &replacement.id).unwrap();
    assert_eq!(replaced.priority, 1);
    assert_eq!(replaced.weight, 7);
    assert_eq!(replaced.max_concurrency, 3);
    assert_eq!(replaced.proxy_url.as_deref(), Some("direct"));
    std::fs::remove_dir_all(root).unwrap();
}
