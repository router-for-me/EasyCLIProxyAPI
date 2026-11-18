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
            &mut client(mode),
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
    pending.commit(None).unwrap();
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
