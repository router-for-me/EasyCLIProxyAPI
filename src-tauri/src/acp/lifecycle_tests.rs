use super::*;
use std::io::{BufRead, Write};
use std::process::{Command, Stdio};

#[test]
fn lifecycle_rpc_helper() {
    let Ok(mode) = std::env::var("ECPA_ACP_LIFECYCLE_HELPER") else {
        return;
    };
    for line in std::io::stdin().lock().lines() {
        let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let method = value["method"].as_str().unwrap_or("");
        if let Some(path) = std::env::var_os("ECPA_ACP_LIFECYCLE_CALLS") {
            let mut log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .unwrap();
            writeln!(log, "{method}").unwrap();
        }
        if method == "authenticate" {
            assert_eq!(value["params"], json!({"methodId":"oauth-personal"}));
        }
        let late_identity = matches!(
            mode.as_str(),
            "late-distinct" | "late-duplicate" | "identity-conflict"
        );
        if (method == "authenticate" && !late_identity && mode != "auth-fails")
            || (method == "session/new" && late_identity)
        {
            if let Some(profile) = std::env::var_os("ECPA_ACP_LIFECYCLE_PROFILE") {
                let path = PathBuf::from(profile).join(".gemini/antigravity-cli/log");
                std::fs::create_dir_all(&path).unwrap();
                let email = if matches!(mode.as_str(), "duplicate" | "late-duplicate") {
                    "OLD@example.test"
                } else {
                    "new@example.test"
                };
                std::fs::write(
                    path.join(format!("acp-server-fixture-{}.log", std::process::id())),
                    format!(
                        "I server_oauth.go:9] applyAuthResult: email={email}, authenticated=true\n"
                    ),
                )
                .unwrap();
            }
        }
        if mode == "cancel-after-auth" && method == "session/new" {
            std::thread::sleep(std::time::Duration::from_secs(10));
            return;
        }
        let result = match method {
            "initialize" if mode == "no-logout" => {
                json!({"protocolVersion":1,"agentCapabilities":{}})
            }
            "initialize" => json!({"protocolVersion":1,"agentCapabilities":{"auth":{"logout":{}}}}),
            "logout" if mode == "logout-fails" => {
                println!(
                    "{}",
                    json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-1,"message":"official logout failed"}})
                );
                std::io::stdout().flush().unwrap();
                continue;
            }
            "authenticate" if mode == "auth-fails" => {
                println!(
                    "{}",
                    json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-1,"message":"offline authorization failed"}})
                );
                std::io::stdout().flush().unwrap();
                continue;
            }
            "session/new" if mode == "models-fail" => {
                json!({"sessionId":"empty","models":{"availableModels":[]}})
            }
            "session/new" => {
                json!({"sessionId":"offline","models":{"availableModels":[{"modelId":"offline-test","name":"Offline test"}]}})
            }
            _ => json!({}),
        };
        println!(
            "{}",
            json!({"jsonrpc":"2.0","id":value["id"],"result":result})
        );
        std::io::stdout().flush().unwrap();
    }
}

pub(super) fn client(mode: &str) -> rpc::Client {
    tracked_client(mode, None)
}

pub(super) fn tracked_client(mode: &str, calls: Option<&Path>) -> rpc::Client {
    fixture_client(mode, calls, None)
}

fn fixture_client(mode: &str, calls: Option<&Path>, profile: Option<&Path>) -> rpc::Client {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "acp::lifecycle_tests::lifecycle_rpc_helper",
            "--nocapture",
        ])
        .env("ECPA_ACP_LIFECYCLE_HELPER", mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(calls) = calls {
        command.env("ECPA_ACP_LIFECYCLE_CALLS", calls);
    }
    if let Some(profile) = profile {
        command.env("ECPA_ACP_LIFECYCLE_PROFILE", profile);
    }
    crate::configure_background_command(&mut command);
    rpc::Client::spawn_command(command).unwrap()
}

fn fixture() -> (PathBuf, AcpState) {
    let root = crate::unique_test_temp_path("acp-lifecycle");
    prepare_profile(&root).unwrap();
    accounts::mark_saved(&root).unwrap();
    accounts::set_active_email(&root, Some("old@example.test".into())).unwrap();
    let state = AcpState::default();
    mark_session(
        &state,
        &json!({"models":{"availableModels":[{"modelId":"old-model"}]}}),
        &root,
    )
    .unwrap();
    (root, state)
}

#[test]
fn failed_or_precancelled_add_restores_old_account_and_capabilities() {
    for mode in ["auth-fails", "precancelled"] {
        let (root, state) = fixture();
        let mut pending = accounts::PendingAccount::new(&root, "New").unwrap();
        let new_profile = pending.directory().unwrap();
        let cancel = Arc::new(AtomicBool::new(mode == "precancelled"));
        assert!(connect_profile(
            &state,
            &root,
            &new_profile,
            true,
            false,
            &cancel,
            &mut client(mode),
            Some(&mut pending)
        )
        .is_err());
        pending.rollback().unwrap();
        assert_eq!(accounts::read(&root).unwrap().active, "default");
        assert_eq!(accounts::read(&root).unwrap().accounts.len(), 1);
        assert!(!new_profile.exists());
        assert!(state.snapshot().unwrap().authenticated);
        assert_eq!(state.snapshot().unwrap().models[0].id, "old-model");
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn successful_auth_is_committed_before_failed_or_cancelled_model_verification() {
    for mode in ["models-fail", "cancel-after-auth"] {
        let (root, state) = fixture();
        let mut pending = accounts::PendingAccount::new(&root, "Authorized").unwrap();
        let directory = pending.directory().unwrap();
        let id = pending.id.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = if mode == "cancel-after-auth" {
            let signal = cancel.clone();
            Some(std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(350));
                signal.store(true, Ordering::Release);
            }))
        } else {
            None
        };
        assert!(connect_profile(
            &state,
            &root,
            &directory,
            true,
            false,
            &cancel,
            &mut fixture_client(mode, None, Some(&directory)),
            Some(&mut pending)
        )
        .is_err());
        if let Some(trigger) = trigger {
            trigger.join().unwrap();
        }
        pending.rollback().unwrap();
        assert_eq!(accounts::read(&root).unwrap().active, id);
        assert_eq!(accounts::read(&root).unwrap().accounts.len(), 2);
        assert!(directory.exists());
        assert!(!state.snapshot().unwrap().authenticated);
        assert!(state.snapshot().unwrap().models.is_empty());
        assert!(!state.snapshot().unwrap().upstream_enabled);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn known_duplicate_preserves_previous_registration_models_and_api() {
    let (root, state) = fixture();
    let mut pending = accounts::PendingAccount::new(&root, "Duplicate").unwrap();
    let directory = pending.directory().unwrap();
    let registry_path = root.join("accounts.json");
    let registry = std::fs::read(&registry_path).unwrap();
    let api_path = root.join("bridge.json");
    std::fs::write(&api_path, br#"{"enabled":true}"#).unwrap();
    state.status.lock().unwrap().upstream_enabled = true;
    let calls = root.join("methods");
    let error = connect_profile(
        &state,
        &root,
        &directory,
        true,
        false,
        &Arc::new(AtomicBool::new(false)),
        &mut fixture_client("duplicate", Some(&calls), Some(&directory)),
        Some(&mut pending),
    )
    .unwrap_err();
    assert_eq!(error, accounts::DUPLICATE_EMAIL);
    pending.rollback().unwrap();
    assert!(!directory.exists());
    assert_eq!(std::fs::read(&registry_path).unwrap(), registry);
    assert_eq!(
        std::fs::read_to_string(&calls).unwrap(),
        "initialize\nauthenticate\n"
    );
    assert!(bridge::upstream_enabled(&root).unwrap());
    let status = state.snapshot().unwrap();
    assert!(status.authenticated && status.upstream_enabled);
    assert_eq!(status.models[0].id, "old-model");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn distinct_identity_is_saved_and_becomes_active() {
    let (root, state) = fixture();
    let mut pending = accounts::PendingAccount::new(&root, "New identity").unwrap();
    let directory = pending.directory().unwrap();
    connect_profile(
        &state,
        &root,
        &directory,
        true,
        false,
        &Arc::new(AtomicBool::new(false)),
        &mut fixture_client("ok", None, Some(&directory)),
        Some(&mut pending),
    )
    .unwrap();
    let registry = accounts::read(&root).unwrap();
    assert_eq!(registry.active, pending.id);
    assert_eq!(
        registry.accounts[1].email.as_deref(),
        Some("new@example.test")
    );
    assert_eq!(state.snapshot().unwrap().models[0].id, "offline-test");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn identity_exposed_during_session_discovery_is_checked_before_any_switch() {
    for mode in ["late-distinct", "late-duplicate"] {
        let (root, state) = fixture();
        let mut pending = accounts::PendingAccount::new(&root, "Second account").unwrap();
        let directory = pending.directory().unwrap();
        let calls = root.join("methods");
        let result = connect_profile(
            &state,
            &root,
            &directory,
            true,
            false,
            &Arc::new(AtomicBool::new(false)),
            &mut fixture_client(mode, Some(&calls), Some(&directory)),
            Some(&mut pending),
        );
        let registry = accounts::read(&root).unwrap();
        let status = state.snapshot().unwrap();
        if mode == "late-distinct" {
            result.unwrap();
            assert_eq!(registry.accounts.len(), 2);
            assert_eq!(registry.active, pending.id);
            assert_eq!(status.models[0].id, "offline-test");
        } else {
            assert_eq!(result.unwrap_err(), accounts::DUPLICATE_EMAIL);
            pending.rollback().unwrap();
            assert!(!directory.exists());
            assert_eq!(registry.accounts.len(), 1);
            assert_eq!(registry.active, "default");
            assert_eq!(status.models[0].id, "old-model");
        }
        assert_eq!(
            std::fs::read_to_string(&calls).unwrap(),
            "initialize\nauthenticate\nsession/new\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn ordinary_reauthorization_records_identity_even_if_models_are_unavailable() {
    let (root, state) = fixture();
    let result = connect_session(
        &state,
        &root,
        true,
        true,
        &Arc::new(AtomicBool::new(false)),
        &mut fixture_client("models-fail", None, Some(&root)),
    );
    assert!(result.is_err());
    assert_eq!(
        accounts::read(&root).unwrap().accounts[0].email.as_deref(),
        Some("new@example.test")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn incomparable_authorization_is_quarantined_without_registering_or_switching() {
    for (previous_email, report_new) in [
        (None, true),
        (Some("invalid"), true),
        (Some("old@example.test"), false),
    ] {
        let (root, state) = fixture();
        accounts::set_active_email(&root, previous_email.map(str::to_owned)).unwrap();
        let registry_path = root.join("accounts.json");
        let registry = std::fs::read(&registry_path).unwrap();
        let api_path = root.join("bridge.json");
        std::fs::write(&api_path, br#"{"enabled":true}"#).unwrap();
        state.status.lock().unwrap().upstream_enabled = true;
        let mut pending = accounts::PendingAccount::new(&root, "Identity recovery").unwrap();
        let directory = pending.directory().unwrap();
        std::fs::write(directory.join("fake-authorization"), "fixture").unwrap();
        let calls = root.join("methods");
        let error = connect_profile(
            &state,
            &root,
            &directory,
            true,
            false,
            &Arc::new(AtomicBool::new(false)),
            &mut fixture_client(
                "ok",
                Some(&calls),
                report_new.then_some(directory.as_path()),
            ),
            Some(&mut pending),
        )
        .unwrap_err();
        assert_eq!(error, accounts::IDENTITY_UNKNOWN);
        pending.rollback().unwrap();
        assert!(!directory.exists());
        let recovery = accounts::recoveries_path(&root)
            .read_dir()
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            std::fs::read_to_string(recovery.join(&pending.id).join("fake-authorization")).unwrap(),
            "fixture"
        );
        assert_eq!(std::fs::read(&registry_path).unwrap(), registry);
        assert_eq!(
            std::fs::read_to_string(&calls).unwrap(),
            if report_new {
                "initialize\nauthenticate\n"
            } else {
                "initialize\nauthenticate\nsession/new\n"
            }
        );
        assert!(bridge::upstream_enabled(&root).unwrap());
        let status = state.snapshot().unwrap();
        assert!(status.authenticated && status.upstream_enabled);
        assert_eq!(status.models[0].id, "old-model");
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn terminal_authorized_profile_refresh_persists_distinct_account_but_not_duplicate() {
    for mode in [
        "late-distinct",
        "late-duplicate",
        "no-identity",
        "terminal-identity",
        "identity-conflict",
    ] {
        let (root, state) = fixture();
        let mut pending = accounts::PendingAccount::new(&root, "Second").unwrap();
        let directory = pending.directory().unwrap();
        let calls = root.join("methods");
        let result = finish_manual_add(
            &state,
            &root,
            &directory,
            &Arc::new(AtomicBool::new(false)),
            &mut fixture_client(
                mode,
                Some(&calls),
                matches!(
                    mode,
                    "late-distinct" | "late-duplicate" | "identity-conflict"
                )
                .then_some(directory.as_path()),
            ),
            &mut pending,
            match mode {
                "terminal-identity" => Some("new@example.test".into()),
                "identity-conflict" => Some("other@example.test".into()),
                _ => None,
            },
            None,
        );
        let registry = accounts::read(&root).unwrap();
        if matches!(mode, "late-distinct" | "terminal-identity") {
            result.unwrap();
            assert_eq!(registry.accounts.len(), 2);
            assert_eq!(registry.active, pending.id);
        } else {
            assert_eq!(
                result.unwrap_err(),
                if mode == "late-duplicate" {
                    accounts::DUPLICATE_EMAIL
                } else {
                    accounts::IDENTITY_UNKNOWN
                }
            );
            pending.rollback().unwrap();
            assert_eq!(registry.accounts.len(), 1);
            assert_eq!(registry.active, "default");
            assert_eq!(state.snapshot().unwrap().models[0].id, "old-model");
        }
        assert_eq!(
            std::fs::read_to_string(calls).unwrap(),
            "initialize\nsession/new\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn isolated_reauthorization_does_not_replace_active_profile_until_identity_and_models_match() {
    let (root, state) = fixture();
    let mut existing = accounts::PendingAccount::new_isolated(&root, "Saved", false).unwrap();
    existing.commit(Some("new@example.test".into())).unwrap();
    let old = existing.directory().unwrap();
    for (mode, identity) in [
        ("models-fail", "new@example.test"),
        ("ok", "other@example.test"),
        ("ok", "new@example.test"),
    ] {
        let mut pending = accounts::PendingAccount::new_isolated(&root, "Saved", true).unwrap();
        let directory = pending.directory().unwrap();
        let result = finish_manual_add(
            &state,
            &root,
            &directory,
            &Arc::new(AtomicBool::new(false)),
            &mut client(mode),
            &mut pending,
            Some(identity.into()),
            Some(&existing.id),
        );
        if mode == "ok" && identity == "new@example.test" {
            result.unwrap();
            assert_eq!(accounts::active(&root).unwrap(), directory);
            assert!(!old.exists());
            assert_eq!(accounts::read(&root).unwrap().accounts.len(), 2);
        } else {
            assert!(result.is_err());
            pending.rollback().unwrap();
            assert_eq!(accounts::active(&root).unwrap(), old);
            assert!(old.is_dir());
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn ordinary_sign_in_relogin_and_refresh_keep_the_existing_contract() {
    let (root, state) = fixture();
    let calls = root.join("methods");
    for (login, relogin) in [(true, false), (true, true), (false, false)] {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut client = fixture_client("ok", Some(&calls), None);
        connect_session(&state, &root, login, relogin, &cancel, &mut client).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(calls).unwrap(),
        "initialize\nauthenticate\nsession/new\ninitialize\nlogout\nauthenticate\nsession/new\ninitialize\nsession/new\n"
    );
    assert_eq!(accounts::read(&root).unwrap().active, "default");
    assert!(state.snapshot().unwrap().authenticated);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn independent_logout_keeps_record_clears_runtime_and_never_enables_api() {
    for enabled in [false, true] {
        let (root, state) = fixture();
        state.status.lock().unwrap().upstream_enabled = enabled;
        std::fs::write(
            root.join("bridge.json"),
            format!("{{\"enabled\":{enabled}}}"),
        )
        .unwrap();
        logout_session(
            &state,
            &root,
            &Arc::new(AtomicBool::new(false)),
            &mut client("ok"),
        )
        .unwrap();
        let status = state.snapshot().unwrap();
        assert!(!status.authenticated);
        assert!(status.models.is_empty());
        assert!(status.selected_model.is_empty());
        assert_eq!(status.upstream_enabled, enabled);
        assert_eq!(bridge::upstream_enabled(&root).unwrap(), enabled);
        let registry = accounts::read(&root).unwrap();
        assert_eq!(registry.accounts.len(), 1);
        assert!(registry.accounts[0].saved);
        assert!(registry.accounts[0].email.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn missing_official_logout_is_explicit_and_does_not_destroy_saved_identity() {
    let (root, state) = fixture();
    let error = logout_session(
        &state,
        &root,
        &Arc::new(AtomicBool::new(false)),
        &mut client("no-logout"),
    )
    .unwrap_err();
    assert!(error.contains("does not support ACP logout"), "{error}");
    assert!(
        error.contains("remove this app's local account record"),
        "{error}"
    );
    assert_eq!(
        accounts::read(&root).unwrap().accounts[0].email.as_deref(),
        Some("old@example.test")
    );
    assert!(!state.snapshot().unwrap().authenticated);
    assert!(state.snapshot().unwrap().models.is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn all_account_operations_share_the_request_busy_slot_and_cancel_handle() {
    let app = tauri::test::mock_app();
    app.manage(AcpState::default());
    let guard = begin(app.handle(), "request").unwrap();
    for operation in ["login", "refresh", "rename", "remove", "logout"] {
        assert!(begin(app.handle(), operation).is_err());
    }
    app.state::<AcpState>().cancel();
    assert!(guard.cancel.load(Ordering::Acquire));
    drop(guard);
    assert!(!app.state::<AcpState>().snapshot().unwrap().busy);
    let next = begin(app.handle(), "remove").unwrap();
    assert!(!next.cancel.load(Ordering::Acquire));
    drop(next);
    assert!(app.state::<AcpState>().cancel.lock().unwrap().is_none());
}

#[test]
fn reset_account_retires_models_probe_and_preserves_explicit_global_switch() {
    let (root, state) = fixture();
    for enabled in [true, false] {
        let mut status = state.status.lock().unwrap();
        status.upstream_enabled = enabled;
        status.upstream_url = Some("http://127.0.0.1:1/v1".into());
        drop(status);
        reset_account(&state).unwrap();
        let status = state.snapshot().unwrap();
        assert_eq!(status.upstream_enabled, enabled);
        assert_eq!(
            status.upstream_url.as_deref(),
            Some("http://127.0.0.1:1/v1")
        );
        assert!(status.models.is_empty());
        assert!(status.selected_model.is_empty());
        assert!(status.latest_probe.is_none());
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_switch_stays_selected_and_never_revives_old_capabilities() {
    let (root, state) = fixture();
    let mut pending = accounts::PendingAccount::new(&root, "New").unwrap();
    pending.commit(Some("second@example.test".into())).unwrap();
    let id = pending.id.clone();
    accounts::select(&root, "default").unwrap();
    reset_account(&state).unwrap();
    accounts::select(&root, &id).unwrap();
    assert!(connect_session(
        &state,
        &root,
        false,
        false,
        &Arc::new(AtomicBool::new(false)),
        &mut client("models-fail")
    )
    .is_err());
    assert_eq!(accounts::read(&root).unwrap().active, id);
    assert!(!state.snapshot().unwrap().authenticated);
    assert!(state.snapshot().unwrap().models.is_empty());
    assert!(!state.snapshot().unwrap().upstream_enabled);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn suspend_for_remote_and_prepare_for_local_reset_runtime_without_losing_accounts() {
    let (root, state) = fixture();
    {
        let mut status = state.status.lock().unwrap();
        status.upstream_enabled = true;
        status.upstream_url = Some("http://127.0.0.1:43210/v1".into());
        status.error = Some("stale error".into());
    }
    *state.request_pool.root.lock().unwrap() = Some(root.clone());

    state.suspend_for_remote();
    let suspended = state.snapshot().unwrap();
    assert!(suspended.upstream_url.is_none());
    assert!(suspended.error.is_none());
    assert!(state.request_pool.root.lock().unwrap().is_none());
    assert!(suspended.authenticated);

    {
        let mut status = state.status.lock().unwrap();
        status.error = Some("Built-in CPA operation unavailable".into());
    }
    state.prepare_for_local();
    let ready = state.snapshot().unwrap();
    assert!(ready.error.is_none());
    assert!(ready.authenticated);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn relogin_non_active_default_account_preserves_active_account_and_updates_runtime() {
    let (root, state) = fixture();
    let mut pending = accounts::PendingAccount::new_isolated(&root, "Work", false).unwrap();
    let isolated_dir = pending.directory().unwrap();
    let token = accounts::isolated_token(&isolated_dir);
    std::fs::create_dir_all(token.parent().unwrap()).unwrap();
    std::fs::write(&token, "synthetic-token").unwrap();
    let work_id = pending.id.clone();
    pending
        .commit_replacing(Some("work@example.test".into()), None, true)
        .unwrap();
    refresh_account_identity(&state, &root).unwrap();
    mark_session(
        &state,
        &json!({"models":{"availableModels":[{"modelId":"work-model"}]}}),
        &isolated_dir,
    )
    .unwrap();

    let calls = root.join("relogin-methods");
    relogin_profile_for(
        &state,
        &root,
        "default",
        &root,
        &Arc::new(AtomicBool::new(false)),
        &mut fixture_client("ok", Some(&calls), Some(&root)),
    )
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(&calls).unwrap(),
        "initialize\nlogout\nauthenticate\nsession/new\n"
    );
    let registry = accounts::read(&root).unwrap();
    assert_eq!(registry.active, work_id);
    assert_eq!(
        registry
            .accounts
            .iter()
            .find(|a| a.id == "default")
            .and_then(|a| a.email.as_deref()),
        Some("new@example.test")
    );
    let snapshot = state.snapshot().unwrap();
    assert_eq!(snapshot.active_account, work_id);
    assert!(snapshot.authenticated);
    assert_eq!(snapshot.models[0].id, "work-model");
    assert_eq!(
        snapshot
            .account_runtime
            .get("default")
            .map(|rt| (rt.auth_state, rt.model_count)),
        Some((AccountAuthState::Ready, 1))
    );
    std::fs::remove_dir_all(root).unwrap();
}
