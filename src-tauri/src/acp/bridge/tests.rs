use super::*;
use std::io::{BufRead, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

fn models() -> Vec<AcpModel> {
    model_list(&fake_session())
}
fn fake_session() -> Value {
    json!({"sessionId":"isolated-session","models":{"currentModelId":"other","availableModels":[
        {"modelId":"test-model","name":"Test model"},
        {"modelId":"test-model-low","name":"Test model (High)"},
        {"modelId":"test-model-medium"},
        {"modelId":"test-model-high","name":"Test model (Low)"},
        {"modelId":"test-model-xhigh"},
        {"modelId":"plain-model"},
        {"modelId":"gemini-4-argon-high","name":"Gemini 4 Argon"},
        {"modelId":"gemini-4-argon-max"}
    ]}})
}
fn request(stream: bool) -> Value {
    json!({"model":"acp/test-model","messages":[{"role":"user","content":"ping"}],"stream":stream})
}

fn chat_stream(body: &str, finish: &str) -> Vec<Value> {
    let mut frames = body.split("\n\n").filter(|frame| !frame.trim().is_empty());
    let mut chunks = Vec::new();
    let mut done = false;
    for frame in frames.by_ref() {
        assert!(!done, "SSE data after [DONE]: {body}");
        let data = frame.strip_prefix("data: ").expect("Chat SSE data frame");
        if data == "[DONE]" {
            done = true;
            continue;
        }
        let chunk: Value = serde_json::from_str(data).expect("valid Chat chunk JSON");
        assert_eq!(chunk["object"], "chat.completion.chunk");
        assert!(chunk["id"].is_string() && chunk["model"].is_string());
        assert!(chunk["created"].is_u64());
        assert_eq!(chunk["choices"].as_array().unwrap().len(), 1);
        assert_eq!(chunk["choices"][0]["index"], 0);
        assert!(chunk["choices"][0]["delta"].is_object());
        if let Some(first) = chunks.first() {
            let first: &Value = first;
            assert_eq!(chunk["id"], first["id"]);
            assert_eq!(chunk["model"], first["model"]);
            assert_eq!(chunk["created"], first["created"]);
        }
        chunks.push(chunk);
    }
    assert!(done, "missing [DONE]: {body}");
    assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
    assert_eq!(
        chunks.last().unwrap()["choices"][0]["finish_reason"],
        finish
    );
    assert!(chunks[..chunks.len() - 1]
        .iter()
        .all(|chunk| chunk["choices"][0]["finish_reason"].is_null()));
    chunks
}

#[test]
fn streaming_backpressure_preserves_chunks_and_can_be_cancelled() {
    for cancel_wait in [false, true] {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        sender.try_send(Ok("queued".into())).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let events = CompletionStream {
            sender,
            cancel: cancel.clone(),
            id: "test".into(),
            model: "test".into(),
            created: 1,
            started: false,
            native: false,
            previous: None,
            sequence: 0,
            text_started: false,
        };
        let worker = std::thread::spawn(move || events.send(Ok("next".into())));
        if cancel_wait {
            cancel.store(true, Ordering::Release);
            assert!(worker.join().unwrap().is_err());
        } else {
            assert_eq!(receiver.blocking_recv().unwrap().unwrap(), "queued");
            assert!(worker.join().unwrap().is_ok());
            assert_eq!(receiver.blocking_recv().unwrap().unwrap(), "next");
            assert!(!cancel.load(Ordering::Acquire));
        }
    }
}

#[test]
fn stalled_stream_releases_the_writer_even_when_receiver_stays_open() {
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    sender.try_send(Ok("queued".into())).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let events = CompletionStream {
        sender,
        cancel: cancel.clone(),
        id: "test".into(),
        model: "test".into(),
        created: 1,
        started: true,
        native: true,
        previous: None,
        sequence: 1,
        text_started: true,
    };
    let (finished, done) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _ = finished
            .send(events.send_with_stall_limit(Ok("next".into()), Duration::from_millis(50)));
    });
    let result = done.recv_timeout(Duration::from_secs(2));
    let cancelled = cancel.swap(true, Ordering::AcqRel);
    worker.join().unwrap();
    assert!(result.unwrap().unwrap_err().contains("stopped reading"));
    assert!(cancelled);
    assert_eq!(receiver.try_recv().unwrap().unwrap(), "queued");
    assert!(receiver.try_recv().is_err());
}

fn bridge_fixture() -> (tauri::App<tauri::test::MockRuntime>, PathBuf) {
    let app = tauri::test::mock_app();
    let state = AcpState::default();
    let mut pool = request_pool::PoolSettings::default();
    pool.queue_wait_ms = 0;
    state.request_pool.set_settings(pool);
    app.manage(state);
    let directory = crate::unique_test_temp_path("acp-enablement");
    prepare_profile(&directory).unwrap();
    mark_session(app.state::<AcpState>().inner(), &fake_session(), &directory).unwrap();
    (app, directory)
}

#[test]
fn fresh_and_existing_login_profiles_default_to_off() {
    let directory = crate::unique_test_temp_path("acp-default-off");
    assert!(!upstream_enabled(&directory).unwrap());
    prepare_profile(&directory).unwrap();
    std::fs::write(selected_path(&directory), br#""test-model""#).unwrap();
    assert!(!upstream_enabled(&directory).unwrap());
    assert!(!AcpState::default().snapshot().unwrap().upstream_enabled);
    assert!(!settings_path(&directory).exists());
    std::fs::write(settings_path(&directory), br#"{"port":12345}"#).unwrap();
    assert!(!upstream_enabled(&directory).unwrap());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn successful_login_refresh_relogin_and_account_switch_do_not_enable_api() {
    let directory = crate::unique_test_temp_path("acp-connect-off");
    prepare_profile(&directory).unwrap();
    let state = AcpState::default();
    let cancel = Arc::new(AtomicBool::new(false));
    for (login, relogin) in [(true, false), (false, false), (true, true)] {
        let mut client = spawn_fake(Path::new("unused"), &directory, "").unwrap();
        connect_session(&state, &directory, login, relogin, &cancel, &mut client).unwrap();
        let status = state.snapshot().unwrap();
        assert!(status.authenticated);
        assert!(!status.models.is_empty());
        assert!(!status.upstream_enabled);
        assert!(state.bridge.lock().unwrap().is_none());
        assert!(!upstream_enabled(&directory).unwrap());
    }
    accounts::set_active_email(&directory, Some("first@example.test".into())).unwrap();
    let mut pending = accounts::PendingAccount::new(&directory, "Second").unwrap();
    pending.commit(Some("second@example.test".into())).unwrap();
    let registry = pending.id.clone();
    let account = accounts::active(&directory).unwrap();
    assert_ne!(account, directory);
    save_settings(
        &account,
        &Settings {
            enabled: true,
            port: 0,
            account_pool: false,
            prompt_profile: PromptProfile::Append,
            ..Settings::default()
        },
    )
    .unwrap();
    let mut client = spawn_fake(Path::new("unused"), &account, "").unwrap();
    connect_session(&state, &directory, false, false, &cancel, &mut client).unwrap();
    assert!(state.snapshot().unwrap().authenticated);
    assert!(!state.snapshot().unwrap().upstream_enabled);
    assert!(!upstream_enabled(&directory).unwrap());
    assert_eq!(accounts::read(&directory).unwrap().active, registry);
    accounts::select(&directory, "default").unwrap();
    let mut client = spawn_fake(Path::new("unused"), &directory, "").unwrap();
    connect_session(&state, &directory, false, false, &cancel, &mut client).unwrap();
    assert!(state.bridge.lock().unwrap().is_none());
    assert!(!settings_path(&directory).exists());
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn disable_persists_off_removes_both_schemas_and_stops_the_listener() {
    for v8 in [false, true] {
        let (app, directory) = bridge_fixture();
        let config = directory.join("config.yaml");
        let original = if v8 {
            "config-version: 8\napi-keys:\n  openai-compatibility:\n    - name: other\n      base-url: https://example.test\n"
        } else {
            "openai-compatibility:\n  - name: other\n    base-url: https://example.test\n"
        };
        std::fs::write(&config, original).unwrap();
        let enabled = set_enabled(app.handle(), &directory, &config, true, false)
            .await
            .unwrap();
        assert!(enabled.upstream_enabled);
        assert!(read_settings(&directory).unwrap().enabled);
        let state = app.state::<AcpState>();
        let stop = state.bridge.lock().unwrap().as_ref().unwrap().stop.clone();
        let port = read_settings(&directory).unwrap().port;
        let disabled = set_enabled(app.handle(), &directory, &config, false, false)
            .await
            .unwrap();
        assert!(!disabled.upstream_enabled);
        assert!(disabled.upstream_url.is_none());
        assert!(!disabled.busy);
        assert!(!read_settings(&directory).unwrap().enabled);
        assert_eq!(read_settings(&directory).unwrap().port, port);
        assert!(state.bridge.lock().unwrap().is_none());
        assert!(stop.is_cancelled());
        let mut client = spawn_fake(Path::new("unused"), &directory, "").unwrap();
        connect_session(
            state.inner(),
            &directory,
            false,
            false,
            &Arc::new(AtomicBool::new(false)),
            &mut client,
        )
        .unwrap();
        assert!(!state.snapshot().unwrap().upstream_enabled);
        assert!(state.bridge.lock().unwrap().is_none());
        let actual: serde_norway::Value =
            serde_norway::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(
            actual,
            serde_norway::from_str::<serde_norway::Value>(original).unwrap()
        );
        let settings_before = std::fs::metadata(settings_path(&directory))
            .unwrap()
            .modified()
            .unwrap();
        let config_before = std::fs::metadata(&config).unwrap().modified().unwrap();
        set_enabled(app.handle(), &directory, &config, false, false)
            .await
            .unwrap();
        assert_eq!(
            settings_before,
            std::fs::metadata(settings_path(&directory))
                .unwrap()
                .modified()
                .unwrap()
        );
        assert_eq!(
            config_before,
            std::fs::metadata(&config).unwrap().modified().unwrap()
        );
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(listener) =
                    tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await
                {
                    drop(listener);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tokio::test]
async fn disable_is_safe_without_config_runtime_or_provider() {
    let (app, directory) = bridge_fixture();
    let config = directory.join("config.yaml");
    for content in [
        None,
        Some("unrelated: true\n"),
        Some("openai-compatibility: []\n"),
    ] {
        if let Some(content) = content {
            std::fs::write(&config, content).unwrap();
        }
        for _ in 0..2 {
            set_enabled(app.handle(), &directory, &config, false, false)
                .await
                .unwrap();
            assert!(!upstream_enabled(&directory).unwrap());
        }
        assert_eq!(std::fs::read_to_string(&config).ok().as_deref(), content);
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn disable_succeeds_after_the_kernel_configuration_is_deleted() {
    let (app, directory) = bridge_fixture();
    let config = directory.join("config.yaml");
    std::fs::write(&config, "openai-compatibility: []\n").unwrap();
    set_enabled(app.handle(), &directory, &config, true, false)
        .await
        .unwrap();
    std::fs::remove_file(&config).unwrap();
    set_enabled(app.handle(), &directory, &config, false, false)
        .await
        .unwrap();
    assert!(!upstream_enabled(&directory).unwrap());
    assert!(app.state::<AcpState>().bridge.lock().unwrap().is_none());
    assert!(!config.exists());
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn failed_provider_cleanup_cannot_leave_enabled_intent_or_a_live_runtime() {
    for invalid in ["openai-compatibility: not-a-list\n", "[invalid yaml"] {
        let (app, directory) = bridge_fixture();
        let config = directory.join("config.yaml");
        std::fs::write(&config, "openai-compatibility: []\n").unwrap();
        set_enabled(app.handle(), &directory, &config, true, false)
            .await
            .unwrap();
        let state = app.state::<AcpState>();
        let stop = state.bridge.lock().unwrap().as_ref().unwrap().stop.clone();
        std::fs::write(&config, invalid).unwrap();
        let error = set_enabled(app.handle(), &directory, &config, false, false)
            .await
            .err()
            .unwrap();
        assert!(
            error.contains("access is off, but provider cleanup failed"),
            "{error}"
        );
        assert!(!upstream_enabled(&directory).unwrap());
        assert!(!state.snapshot().unwrap().upstream_enabled);
        assert!(state.snapshot().unwrap().upstream_url.is_none());
        assert!(!state.snapshot().unwrap().busy);
        assert!(state.bridge.lock().unwrap().is_none());
        assert!(stop.is_cancelled());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), invalid);
        sync_models(state.inner()).unwrap();
        restore_if_enabled(&directory, || async {
            panic!("disabled access must not be restored")
        })
        .await
        .unwrap();
        assert!(
            !set_enabled(app.handle(), &directory, &config, true, true)
                .await
                .unwrap()
                .upstream_enabled
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tokio::test]
async fn failed_enable_registration_does_not_persist_enabled() {
    for content in [None, Some("openai-compatibility: not-a-list\n")] {
        let (app, directory) = bridge_fixture();
        let config = directory.join("config.yaml");
        if let Some(content) = content {
            std::fs::write(&config, content).unwrap();
        }
        assert!(set_enabled(app.handle(), &directory, &config, true, false)
            .await
            .is_err());
        assert!(!upstream_enabled(&directory).unwrap());
        let state = app.state::<AcpState>();
        assert!(!state.snapshot().unwrap().upstream_enabled);
        assert!(!state.snapshot().unwrap().busy);
        assert!(state.bridge.lock().unwrap().is_none());
        assert_eq!(std::fs::read_to_string(&config).ok().as_deref(), content);
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[tokio::test]
async fn failed_disable_persistence_leaves_the_previous_state_intact() {
    let (app, directory) = bridge_fixture();
    let config = directory.join("config.yaml");
    std::fs::write(&config, "openai-compatibility: []\n").unwrap();
    set_enabled(app.handle(), &directory, &config, true, false)
        .await
        .unwrap();
    let previous = std::fs::read(&config).unwrap();
    let state = app.state::<AcpState>();
    let stop = state.bridge.lock().unwrap().as_ref().unwrap().stop.clone();
    std::fs::create_dir(directory.join("bridge.json.tmp")).unwrap();
    assert!(set_enabled(app.handle(), &directory, &config, false, false)
        .await
        .is_err());
    assert!(upstream_enabled(&directory).unwrap());
    assert!(state.snapshot().unwrap().upstream_enabled);
    assert!(!state.snapshot().unwrap().busy);
    assert!(state.bridge.lock().unwrap().is_some());
    assert!(!stop.is_cancelled());
    assert_eq!(std::fs::read(&config).unwrap(), previous);
    std::fs::remove_dir(directory.join("bridge.json.tmp")).unwrap();
    set_enabled(app.handle(), &directory, &config, false, false)
        .await
        .unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn failed_enable_persistence_rolls_back_provider_registration() {
    let (app, directory) = bridge_fixture();
    let config = directory.join("config.yaml");
    std::fs::write(&config, "openai-compatibility: []\n").unwrap();
    std::fs::create_dir(directory.join("bridge.json.tmp")).unwrap();
    assert!(set_enabled(app.handle(), &directory, &config, true, false)
        .await
        .is_err());
    assert!(!upstream_enabled(&directory).unwrap());
    assert!(app.state::<AcpState>().bridge.lock().unwrap().is_none());
    assert!(!std::fs::read_to_string(&config).unwrap().contains(PROVIDER));
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn restore_only_runs_for_explicit_saved_enablement() {
    let directory = crate::unique_test_temp_path("acp-restore-off");
    restore_if_enabled(&directory, || async {
        panic!("fresh profile must not reconnect or register")
    })
    .await
    .unwrap();
    save_settings(
        &directory,
        &Settings {
            enabled: false,
            port: 12345,
            account_pool: false,
            prompt_profile: PromptProfile::Append,
            ..Settings::default()
        },
    )
    .unwrap();
    restore_if_enabled(&directory, || async {
        panic!("disabled profile must not reconnect or register")
    })
    .await
    .unwrap();
    save_settings(
        &directory,
        &Settings {
            enabled: true,
            port: 12345,
            account_pool: false,
            prompt_profile: PromptProfile::Append,
            ..Settings::default()
        },
    )
    .unwrap();
    let mut restored = false;
    restore_if_enabled(&directory, || async {
        restored = true;
        Ok(())
    })
    .await
    .unwrap();
    assert!(restored);
    assert!(upstream_enabled(&directory).unwrap());
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn disable_wins_over_a_restore_that_already_started_connecting() {
    let (app, directory) = bridge_fixture();
    let config = directory.join("config.yaml");
    std::fs::write(&config, "openai-compatibility: []\n").unwrap();
    save_settings(
        &directory,
        &Settings {
            enabled: true,
            port: 0,
            account_pool: false,
            prompt_profile: PromptProfile::Append,
            ..Settings::default()
        },
    )
    .unwrap();
    restore_if_enabled(&directory, || async {
        set_enabled(app.handle(), &directory, &config, false, false).await?;
        let status = set_enabled(app.handle(), &directory, &config, true, true).await?;
        assert!(!status.upstream_enabled);
        Ok(())
    })
    .await
    .unwrap();
    assert!(app.state::<AcpState>().bridge.lock().unwrap().is_none());
    assert!(!upstream_enabled(&directory).unwrap());
    assert!(!std::fs::read_to_string(&config).unwrap().contains(PROVIDER));
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn variant_levels_come_from_protocol_ids_without_replacing_models() {
    let models = models();
    assert_eq!(models.len(), 8);
    assert_eq!(models[1].name, "Test model (High)");
    for model in &models[..5] {
        assert_eq!(
            model.reasoning_levels,
            ["none", "low", "medium", "high", "xhigh"]
        );
        assert_eq!(model.reasoning_variants["low"], "test-model-low");
        assert_eq!(model.reasoning_variants["none"], "test-model");
    }
    assert!(models[5].reasoning_levels.is_empty());
    assert!(models[5].reasoning_variants.is_empty());
    assert_eq!(models[6].reasoning_levels, ["high", "max"]);
    assert!(!models[6].reasoning_variants.contains_key("none"));
    assert_eq!(
        serde_json::to_value(&models[0]).unwrap()["reasoningLevels"],
        json!(["none", "low", "medium", "high", "xhigh"])
    );
    let legacy: AcpModel = serde_json::from_value(json!({"id":"legacy","name":"Legacy"})).unwrap();
    assert!(legacy.reasoning_levels.is_empty());
}

#[test]
fn grouped_variants_preserve_account_scoped_selected_model_strings() {
    let directory = crate::unique_test_temp_path("acp-variant-selection");
    let state = AcpState::default();
    for (account, selected) in [
        ("first", "test-model-high"),
        ("second", "gemini-4-argon-max"),
    ] {
        let profile = directory.join(account);
        prepare_profile(&profile).unwrap();
        std::fs::write(
            selected_path(&profile),
            serde_json::to_vec(selected).unwrap(),
        )
        .unwrap();
        mark_session(&state, &fake_session(), &profile).unwrap();
        let status = state.snapshot().unwrap();
        assert_eq!(status.selected_model, selected);
        assert_eq!(status.profile, profile.to_string_lossy());
        assert_eq!(read_selected(&profile).unwrap(), selected);
        assert!(!status
            .models
            .iter()
            .find(|model| model.id == selected)
            .unwrap()
            .reasoning_levels
            .is_empty());
    }
    let session = json!({"models":{"currentModelId":"plain-model","availableModels":[{"modelId":"plain-model"}]}});
    mark_session(&state, &session, &directory.join("second")).unwrap();
    let status = state.snapshot().unwrap();
    assert_eq!(status.selected_model, "plain-model");
    assert!(status.models[0].reasoning_levels.is_empty());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn effort_resolves_only_to_advertised_family_variants() {
    for (control, expected) in [
        (json!({"reasoning_effort":"low"}), "test-model-low"),
        (
            json!({"reasoning":{"effort":"medium"}}),
            "test-model-medium",
        ),
        (json!({"thinking":{"effort":"xhigh"}}), "test-model-xhigh"),
        (json!({"reasoning_effort":"none"}), "test-model"),
        (
            json!({"reasoning_effort":"high","reasoning":{"effort":"high"}}),
            "test-model-high",
        ),
    ] {
        let mut value = request(false);
        value["model"] = json!("acp/test-model-high");
        value
            .as_object_mut()
            .unwrap()
            .extend(control.as_object().unwrap().clone());
        let completion = parse_completion(&value, &models()).unwrap();
        assert_eq!(completion.model, expected);
        assert_eq!(completion.alias, "acp/test-model-high");
    }
    let mut value = request(false);
    value["model"] = json!("acp/gemini-4-argon-high");
    value["reasoning_effort"] = json!("none");
    let error = parse_completion(&value, &models()).err().unwrap();
    assert!(error.contains("supported levels: high, max"), "{error}");
    value["model"] = json!("acp/plain-model");
    let error = parse_completion(&value, &models()).err().unwrap();
    assert!(
        error.contains("does not advertise reasoning levels"),
        "{error}"
    );
    value.as_object_mut().unwrap().remove("reasoning_effort");
    assert_eq!(
        parse_completion(&value, &models()).unwrap().model,
        "plain-model"
    );
}

#[test]
fn invalid_effort_controls_are_rejected_explicitly() {
    for (control, expected) in [
        (
            json!({"reasoning_effort":"extreme"}),
            "supported levels: none, low, medium, high, xhigh",
        ),
        (json!({"reasoning_effort":"max"}), "supported levels:"),
        (
            json!({"reasoning_effort":""}),
            "Unsupported reasoning effort",
        ),
        (
            json!({"reasoning_effort":null}),
            "reasoning_effort must be a string",
        ),
        (
            json!({"reasoning_effort":42}),
            "reasoning_effort must be a string",
        ),
        (
            json!({"reasoning_effort":true}),
            "reasoning_effort must be a string",
        ),
        (
            json!({"reasoning_effort":[]}),
            "reasoning_effort must be a string",
        ),
        (json!({"reasoning":null}), "reasoning must be an object"),
        (json!({"reasoning":"high"}), "reasoning must be an object"),
        (json!({"reasoning":{}}), "only reasoning.effort"),
        (
            json!({"reasoning":{"effort":false}}),
            "reasoning.effort must be a string",
        ),
        (
            json!({"reasoning":{"effort":"high","summary":"auto"}}),
            "only reasoning.effort",
        ),
        (
            json!({"thinking":{"budget_tokens":1024}}),
            "only thinking.effort",
        ),
        (
            json!({"thinking":{"effort":1024}}),
            "thinking.effort must be a string",
        ),
        (
            json!({"reasoning_effort":"high","reasoning":{"effort":"low"}}),
            "Conflicting",
        ),
        (
            json!({"reasoning":{"effort":"high"},"thinking":{"effort":"low"}}),
            "Conflicting",
        ),
        (
            json!({"service_tier":"auto"}),
            "does not advertise a service tier mapping",
        ),
        (
            json!({"unknown":true}),
            "does not support parameter 'unknown'",
        ),
    ] {
        let mut value = request(false);
        value
            .as_object_mut()
            .unwrap()
            .extend(control.as_object().unwrap().clone());
        let error = parse_completion(&value, &models()).err().unwrap();
        assert!(error.contains(expected), "{control}: {error}");
    }
}

#[test]
fn provider_registration_preserves_unrelated_routes_in_both_schemas() {
    for v8 in [false, true] {
        let existing = json!([{"name":"existing","base-url":"https://example.test"}]);
        let mut document: serde_norway::Value = serde_norway::to_value(if v8 {
            json!({"config-version":8,"api-keys":{"openai-compatibility":existing}})
        } else {
            json!({"openai-compatibility":existing})
        })
        .unwrap();
        let original = document.clone();
        let entry = provider_entry(
            "http://127.0.0.1:12345/v1",
            "private-test-key",
            &models(),
            v8,
        )
        .unwrap();
        assert!(patch_provider(&mut document, Some(entry.clone())).unwrap());
        assert!(!patch_provider(&mut document, Some(entry)).unwrap());
        let groups = if v8 {
            &document["api-keys"]["openai-compatibility"]
        } else {
            &document["openai-compatibility"]
        };
        assert_eq!(groups.as_sequence().unwrap().len(), 2);
        assert_eq!(groups[0]["name"].as_str(), Some("existing"));
        assert!(groups[1].get("proxy-url").is_none());
        assert_eq!(
            groups[1][if v8 { "keys" } else { "api-key-entries" }][0]["proxy-url"].as_str(),
            Some("direct")
        );
        assert_eq!(
            groups[1]["models"][0]["name"].as_str(),
            Some("acp/test-model")
        );
        assert_eq!(
            groups[1]["models"][0],
            serde_norway::to_value(json!({"name":"acp/test-model"})).unwrap()
        );
        assert!(groups[1]["models"]
            .as_sequence()
            .unwrap()
            .iter()
            .all(|model| model.get("alias").is_none() && model.get("thinking").is_none()));
        assert!(groups[1]
            .get(if v8 { "keys" } else { "api-key-entries" })
            .is_some());
        patch_provider(&mut document, None).unwrap();
        assert_eq!(document, original);
    }
}

#[test]
fn disable_removes_stale_provider_entries_from_both_paths_in_a_mixed_config() {
    let mut document = serde_norway::to_value(json!({
        "config-version": 8,
        "openai-compatibility": [{"name": PROVIDER}, {"name": "legacy-other"}],
        "api-keys": {"openai-compatibility": [{"name": PROVIDER}, {"name": "v8-other"}]}
    }))
    .unwrap();
    assert!(patch_provider(&mut document, None).unwrap());
    assert_eq!(
        document["openai-compatibility"][0]["name"].as_str(),
        Some("legacy-other")
    );
    assert_eq!(
        document["openai-compatibility"]
            .as_sequence()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        document["api-keys"]["openai-compatibility"][0]["name"].as_str(),
        Some("v8-other")
    );
    assert_eq!(
        document["api-keys"]["openai-compatibility"]
            .as_sequence()
            .unwrap()
            .len(),
        1
    );
    assert!(!patch_provider(&mut document, None).unwrap());
}

#[test]
fn unsupported_inputs_are_rejected_without_dropping_parameters() {
    assert!(parse_completion(&request(false), &models()).is_ok());
    for (key, value) in [
        ("tools", json!([{"type":"unsupported"}])),
        ("response_format", json!({"type":"json_object"})),
    ] {
        let mut value_request = request(false);
        value_request[key] = value;
        assert!(parse_completion(&value_request, &models()).is_err());
    }
    for messages in [
        json!([]),
        json!([{"role":"system","content":"x"}]),
        json!([{"role":"user","content":"x"},{"role":"tool","content":"y"}]),
        json!([{"role":"user","content":"x"},{"role":"function","content":"y"}]),
        json!([{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.test/image"}}]}]),
        json!([{"role":"user","content":""}]),
    ] {
        let mut value = request(false);
        value["messages"] = messages;
        assert!(parse_completion(&value, &models()).is_err());
    }
}

#[test]
fn prefixed_and_bare_names_resolve_to_the_same_acp_model() {
    for name in ["acp/test-model", "test-model"] {
        let mut value = request(false);
        value["model"] = json!(name);
        let completion = parse_completion(&value, &models()).unwrap();
        assert_eq!(completion.model, "test-model");
        assert_eq!(completion.alias, "acp/test-model");
    }
}

#[test]
fn single_user_message_is_passed_through_unchanged() {
    let completion = parse_completion(&request(false), &models()).unwrap();
    assert_eq!(completion.prompt[0].as_text(), Some("ping"));
    let mut value = request(false);
    value["messages"] =
        json!([{"role":"user","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}]);
    assert_eq!(
        parse_completion(&value, &models()).unwrap().prompt[0].as_text(),
        Some("ab")
    );
}

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yXxQAAAAASUVORK5CYII=";

fn image_part() -> Value {
    json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{PNG}")}})
}

#[test]
fn image_and_text_history_preserve_block_order_and_skip_reasoning_only_turns() {
    let mut value = request(false);
    let mut image = image_part();
    image["image_url"]["detail"] = json!("low");
    value["messages"] = json!([
        {"role":"user","content":[{"type":"text","text":"before"}, image, {"type":"text","text":"after"}]},
        {"role":"assistant","content":null,"reasoning_content":"private reasoning, not an assistant reply"},
        {"role":"assistant","content":"seen"},
        {"role":"user","content":[image_part()]}
    ]);
    let parsed = parse_completion(&value, &models()).unwrap();
    assert_eq!(parsed.ignored_parameters, ["image_url.detail"]);
    assert_eq!(
        json!(parsed.prompt),
        json!([
            {"type":"text","text":"User: before"},
            {"type":"image","mimeType":"image/png","data":PNG},
            {"type":"text","text":"after\n\nAssistant: seen\n\nUser: "},
            {"type":"image","mimeType":"image/png","data":PNG}
        ])
    );
}

#[test]
fn rejected_content_names_the_location_and_does_not_leak_urls() {
    for (content, reason) in [
        (Value::Null, "missing or null"),
        (json!(17), "must be a string or an array"),
        (json!([{"type":"text","text":7}]), "text must be a string"),
        (
            json!([{"type":"input_audio"}]),
            "does not support 'input_audio'",
        ),
        (json!([{"type":"file"}]), "does not support 'file'"),
        (
            json!([{"type":"image_url","image_url":"not-an-object"}]),
            "image_url must be an object",
        ),
        (
            json!([{"type":"image_url","image_url":{"url":"data:image/png;base64,%"}}]),
            "invalid base64",
        ),
        (
            json!([{"type":"image_url","image_url":{"url":"data:image/png;base64,"}}]),
            "does not match",
        ),
        (
            json!([{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,QUJD"}}]),
            "does not match",
        ),
        (
            json!([{"type":"image_url","image_url":{"url":"data:image/svg+xml;base64,QUJD"}}]),
            "must be PNG, JPEG",
        ),
    ] {
        let mut value = request(false);
        value["messages"][0]["content"] = content;
        let error = parse_completion(&value, &models()).err().unwrap();
        assert!(
            error.contains("messages[0]") && error.contains(reason),
            "{error}"
        );
    }
    for url in [
        "https://example.test/private-token",
        "file:///home/private-token",
        "/tmp/private-token",
    ] {
        let mut value = request(false);
        value["messages"][0]["content"] = json!([{"type":"image_url","image_url":{"url":url}}]);
        let error = parse_completion(&value, &models()).err().unwrap();
        assert!(
            error.contains("user content part 0") && error.contains("does not fetch URLs"),
            "{error}"
        );
        assert!(!error.contains("private-token"), "{error}");
    }
    let mut value = request(false);
    value["messages"] = json!([{"role":"assistant","content":null},{"role":"user","content":"hi"}]);
    let error = parse_completion(&value, &models()).err().unwrap();
    assert!(
        error.contains("assistant message content is missing or null"),
        "{error}"
    );
    value["messages"][0]["content"] = json!([image_part()]);
    assert!(parse_completion(&value, &models())
        .err()
        .unwrap()
        .contains("send image_url in a user message"));
}

#[test]
fn client_generation_options_are_validated_and_reported_as_unapplied() {
    let mut value = request(false);
    value["max_tokens"] = json!(1024);
    value["max_completion_tokens"] = json!(2048);
    value["temperature"] = json!(0.7);
    value["top_p"] = json!(1);
    let parsed = parse_completion(&value, &models()).unwrap();
    assert_eq!(parsed.prompt[0].as_text(), Some("ping"));
    assert_eq!(
        parsed.ignored_parameters,
        [
            "max_tokens",
            "max_completion_tokens",
            "temperature",
            "top_p"
        ]
    );
    for key in [
        "max_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
    ] {
        value[key] = Value::Null;
    }
    assert!(parse_completion(&value, &models())
        .unwrap()
        .ignored_parameters
        .is_empty());
    for (key, invalid) in [
        ("max_tokens", json!(0)),
        ("max_tokens", json!(-1)),
        ("max_tokens", json!(1.5)),
        ("max_completion_tokens", json!("1024")),
        ("temperature", json!(-0.1)),
        ("temperature", json!(2.1)),
        ("top_p", json!(1.1)),
        ("top_p", json!(false)),
    ] {
        let mut value = request(false);
        value[key] = invalid;
        let error = parse_completion(&value, &models()).err().unwrap();
        assert!(error.contains(key), "{key}: {error}");
    }
}

#[test]
fn text_clients_can_send_empty_tools_disabled_tools_and_metadata() {
    for control in [
        json!({"tools":[],"tool_choice":"auto","parallel_tool_calls":true}),
        json!({"tools":null,"tool_choice":null}),
        json!({"tools":[{"type":"function","function":{"name":"lookup"}}],"tool_choice":"none"}),
        json!({"n":1,"store":false,"user":"test-user","metadata":{"source":"test"},"response_format":{"type":"text"},"prompt_cache_key":"test-cache","safety_identifier":"test-id"}),
    ] {
        let mut value = request(false);
        value
            .as_object_mut()
            .unwrap()
            .extend(control.as_object().unwrap().clone());
        let parsed = parse_completion(&value, &models()).unwrap();
        assert_eq!(parsed.prompt[0].as_text(), Some("ping"));
    }
    for control in [
        json!({"tools":{}}),
        json!({"tool_choice":"required"}),
        json!({"tool_choice":{"type":"function","function":{"name":"lookup"}}}),
        json!({"parallel_tool_calls":"false"}),
        json!({"n":2}),
        json!({"store":true}),
        json!({"user":7}),
        json!({"metadata":[]}),
    ] {
        let mut value = request(false);
        value
            .as_object_mut()
            .unwrap()
            .extend(control.as_object().unwrap().clone());
        assert!(parse_completion(&value, &models()).is_err(), "{value}");
    }
}

#[test]
fn developer_instructions_are_delivered_through_the_official_session_field() {
    let mut value = request(false);
    value["messages"] = json!([
        {"role":"system","content":"be brief"},
        {"role":"developer","content":"use plain language"},
        {"role":"user","name":"test-user","content":"verify-system"}
    ]);
    let request = parse_completion(&value, &models()).unwrap();
    assert_eq!(request.prompt[0].as_text(), Some("verify-system"));
    assert_eq!(request.system, "be brief\n\nuse plain language");
    let cancel = Arc::new(AtomicBool::new(false));
    let mut client = spawn_fake(Path::new("unused"), Path::new("unused"), "").unwrap();
    let mut chunks = String::new();
    client.initialize(&cancel).unwrap();
    let output = complete(
        &mut client,
        Path::new("unused"),
        &request,
        &cancel,
        |part| chunks.push_str(part),
    )
    .unwrap();
    assert_eq!(output, "ACP_OK");
    assert_eq!(chunks, output);
}

#[test]
#[ignore = "requires officially authenticated ECPA_ACP_PROBE_PROFILE and ECPA_ACP_PROBE_CLI; makes one real request"]
fn official_cli_completes_a_chat_client_request_with_system_and_empty_tools() {
    let profile = PathBuf::from(std::env::var_os("ECPA_ACP_PROBE_PROFILE").expect("Set profile"));
    let executable = PathBuf::from(std::env::var_os("ECPA_ACP_PROBE_CLI").expect("Set CLI"));
    let cancel = Arc::new(AtomicBool::new(false));
    let mut discovery = rpc::Client::spawn(&executable, &profile, "").unwrap();
    discovery.initialize(&cancel).unwrap();
    let session = discovery.session(&profile, &cancel).unwrap();
    let models = model_list(&session);
    let model = models
        .iter()
        .find(|m| m.id == "gemini-3.8-flash-low")
        .unwrap_or(&models[0]);
    let marker = format!(
        "ACP_BRIDGE_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let value = json!({
        "model":format!("acp/{}",model.id),"tools":[],"tool_choice":"auto","stream":false,
        "messages":[{"role":"system","content":format!("The session check marker is {marker}. When asked for the session check marker, reply with it. Do not use tools.")},
            {"role":"developer","content":"Keep your response to the required marker."},
            {"role":"user","content":"Return the session check marker. Do not use tools."}]
    });
    let request = parse_completion(&value, &models).unwrap();
    drop(discovery);
    let mut client = rpc::Client::spawn(&executable, &profile, "").unwrap();
    client.initialize(&cancel).unwrap();
    let output = complete(&mut client, &profile, &request, &cancel, |_| {}).unwrap();
    assert!(
        output.contains(&marker),
        "Official system instructions were not applied"
    );
}

#[test]
fn native_responses_preserves_long_multipart_instructions_without_duplication() {
    let core = "Synthetic developer directions.\n".repeat(600);
    let parsed = responses::parse(
        &json!({
            "model":"acp/test-model",
            "instructions":"top-level instructions",
            "input":[
                {"type":"message","role":"developer","content":[
                    {"type":"input_text","text":core}, {"type":"input_text","text":"tail\n"}
                ]},
                {"type":"message","role":"user","content":"independent question"}
            ]
        }),
        &models(),
        None,
    )
    .unwrap();
    assert_eq!(
        parsed.system,
        format!("top-level instructions\n\n{core}tail\n")
    );
    assert_eq!(parsed.prompt.len(), 1);
    assert_eq!(parsed.prompt[0].as_text(), Some("independent question"));
}

#[test]
fn system_messages_are_separate_from_the_user_turn() {
    let mut value = request(false);
    value["messages"] = json!([
        {"role":"system","content":"be brief"},
        {"role":"system","content":[{"type":"text","text":"stay calm"}]},
        {"role":"user","content":"hello"},
    ]);
    let completion = parse_completion(&value, &models()).unwrap();
    assert_eq!(completion.prompt[0].as_text(), Some("hello"));
    assert_eq!(completion.system, "be brief\n\nstay calm");
}

#[test]
fn multi_turn_history_is_flattened_into_one_prompt() {
    let mut value = request(false);
    value["messages"] = json!([
        {"role":"system","content":"be brief"},
        {"role":"user","content":"hi"},
        {"role":"assistant","content":[{"type":"text","text":"hello"}]},
        {"role":"user","content":"again"},
    ]);
    assert_eq!(
        parse_completion(&value, &models()).unwrap().prompt[0].as_text(),
        Some("User: hi\n\nAssistant: hello\n\nUser: again")
    );
}

#[test]
fn history_must_end_with_a_user_turn() {
    let mut value = request(false);
    value["messages"] = json!([
        {"role":"user","content":"hi"},
        {"role":"assistant","content":"hello"},
    ]);
    let error = parse_completion(&value, &models()).err().unwrap();
    assert!(
        error.contains("the last message must be from the user"),
        "{error}"
    );
}

#[test]
fn unsupported_roles_name_the_role() {
    let mut value = request(false);
    value["messages"] = json!([
        {"role":"user","content":"hi"},
        {"role":"tool","content":"result"},
        {"role":"user","content":"again"},
    ]);
    let error = parse_completion(&value, &models()).err().unwrap();
    assert!(error.contains("role 'tool'"), "{error}");
}

#[test]
fn context_document_recognition_is_exact_and_role_scoped() {
    for prefix in ["\u{feff}", ACP_TEMPLATE_TITLE] {
        let document = format!("{prefix}{ACP_TEMPLATE}");
        let mut body = request(false);
        body["messages"] =
            json!([{"role":"system","content":document},{"role":"user","content":document}]);
        for policy in [PromptProfile::Append, PromptProfile::FirstTurnContext] {
            let mut req = parse_with_profile(&body, &models(), policy).unwrap();
            assert_eq!(req.system, document);
            req.frame_opening().unwrap();
            assert_eq!(
                req.prompt.last().unwrap().as_text(),
                Some(document.as_str())
            );
            if policy == PromptProfile::Append {
                assert_eq!(req.system, document);
            } else {
                assert_eq!(
                    req.prompt[0].as_text().unwrap(),
                    format!("Client context:\n{ACP_TEMPLATE}")
                );
            }
        }
        for other in [
            format!("{document} "),
            format!("{prefix}custom instruction"),
            format!("p{document}"),
            document.replace("concise", "precise"),
        ] {
            assert_eq!(context_text(&other), other);
        }
    }
}

#[test]
fn profile_normalizes_only_bridge_generated_history_separators() {
    assert_eq!(
        serde_json::from_str::<Settings>("{}")
            .unwrap()
            .prompt_profile,
        PromptProfile::Append
    );
    assert!(serde_json::from_str::<Settings>(r#"{"prompt_profile":"guess"}"#).is_err());
    let mut body = request(false);
    let literal = "do not change\n\nAssistant: literal\n\nUser: literal\r\n";
    body["messages"] = json!([{"role":"developer","content":literal},{"role":"user","content":literal},{"role":"assistant","content":"a"},{"role":"user","content":"b"}]);
    for (policy, sep) in [
        (PromptProfile::Append, "\n\n"),
        (PromptProfile::FirstTurnContext, "\n"),
    ] {
        let mut req = parse_with_profile(&body, &models(), policy).unwrap();
        req.frame_opening().unwrap();
        assert_eq!(
            req.prompt.last().unwrap().as_text().unwrap(),
            format!("User: {literal}{sep}Assistant: a{sep}User: b")
        );
        if policy == PromptProfile::Append {
            assert_eq!(req.system, literal);
            assert_eq!(req.prompt.len(), 1);
        } else {
            assert!(req.system.is_empty());
            assert_eq!(req.prompt.len(), 2);
            assert_eq!(
                req.prompt[0].as_text().unwrap(),
                format!("Client context:\n{literal}")
            );
        }
    }
    body["messages"] =
        json!([{"role":"system","content":"X".repeat(MAX_BODY-1)},{"role":"user","content":"a"}]);
    let mut req = parse_with_profile(&body, &models(), PromptProfile::FirstTurnContext).unwrap();
    assert!(req.frame_opening().unwrap_err().contains("1 MiB"));
}

#[test]
fn oversized_flattened_prompt_is_rejected() {
    let mut value = request(false);
    let big = "x".repeat(MAX_BODY - 8);
    value["messages"] = json!([
        {"role":"user","content":big},
        {"role":"assistant","content":big},
        {"role":"user","content":"tail"},
    ]);
    let error = parse_completion(&value, &models()).err().unwrap();
    assert!(error.contains("1 MiB"), "{error}");
}

#[test]
fn fake_official_server() {
    if std::env::var_os("ECPA_ACP_BRIDGE_TEST_HELPER").is_none() {
        return;
    }
    let mut selected = String::new();
    let mut system = String::new();
    let mut tool_config = Value::Null;
    let mut prompt_count = 0;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let result = match value["method"].as_str().unwrap_or("") {
            "initialize" => {
                let mut result = json!({"protocolVersion":1,"agentCapabilities":{"auth":{"logout":{}},"_meta":{"antigravity":{"systemPrompt":{"append":true}}}}});
                if std::env::var_os("ECPA_ACP_TEST_IMAGE").is_some() {
                    result["agentCapabilities"]["promptCapabilities"] = json!({"image":true});
                }
                result
            }
            "session/new" => {
                assert_eq!(prompt_count, 0, "unexpected ACP session recreation");
                tool_config = value["params"]["mcpServers"][0].clone();
                system = value["params"]["_meta"]["antigravity"]["systemPrompt"]["append"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                fake_session()
            }
            "session/set_model" => {
                selected = value["params"]["modelId"].as_str().unwrap().to_string();
                assert!(models().iter().any(|model| model.id == selected));
                json!({})
            }
            "logout" | "authenticate" => json!({}),
            "session/prompt" => {
                assert!(
                    !selected.is_empty(),
                    "explicit model selection must precede inference"
                );
                let context_mode = std::env::var("ECPA_TEST_CONTEXT").as_deref() == Ok("yes");
                let raw = &value["params"]["prompt"];
                let mut task = raw.clone();
                let mut framed = false;
                if context_mode
                    && raw[0]["text"]
                        .as_str()
                        .is_some_and(|t| t.starts_with("Client context:\n"))
                {
                    assert_eq!(prompt_count, 0, "context replayed on continuation");
                    assert_eq!(raw[0]["text"], "Client context:\nα\r\n第一条\n\n保持顺序\n");
                    assert!(!system.contains("第一条"));
                    assert!(if tool_config.is_null() {
                        system.is_empty()
                    } else {
                        system.contains("Do not use local built-in tools")
                    });
                    framed = true;
                    task.as_array_mut().unwrap().remove(0);
                }
                let blocks = &task;
                let prompt = blocks[0]["text"].as_str().unwrap_or("");
                prompt_count += 1;
                assert_eq!(value["params"]["sessionId"], "isolated-session");
                if matches!(
                    prompt,
                    "native-first" | "native-second" | "native-third" | "native-independent"
                ) {
                    let expected = match prompt {
                        "native-second" => 2,
                        "native-third" => 3,
                        _ => 1,
                    };
                    assert_eq!(
                        prompt_count, expected,
                        "native continuation did not reuse the process/session"
                    );
                    assert_eq!(
                        *blocks,
                        json!([{"type":"text","text":prompt}]),
                        "history was replayed"
                    );
                }
                if matches!(prompt, "mixed-first" | "mixed-next") {
                    if context_mode {
                        assert!(system.is_empty());
                        assert_eq!(framed, prompt_count == 1);
                    } else {
                        assert_eq!(system, "α\r\n第一条\n\n保持顺序\n");
                    }
                    assert_eq!(prompt_count, if prompt == "mixed-first" { 1 } else { 2 });
                    assert_eq!(*blocks, json!([{"type":"text","text":prompt}]));
                }
                if context_mode
                    && (prompt == "mixed-history-start" || prompt.contains("mixed-history-fresh"))
                {
                    assert!(framed);
                }
                if prompt.contains("mixed-history-fresh") {
                    assert_eq!(prompt_count, 1);
                    assert!(prompt.contains("mixed-history-start"));
                }
                if prompt == "mixed-history-delta" {
                    assert_eq!(prompt_count, 2);
                    if context_mode {
                        assert!(system.is_empty());
                        assert_eq!(framed, prompt_count == 1);
                    } else {
                        assert_eq!(system, "α\r\n第一条\n\n保持顺序\n");
                    }
                    assert_eq!(*blocks, json!([{"type":"text","text":prompt}]));
                }
                if prompt == "scoped-delta" {
                    assert_eq!(
                        prompt_count, 2,
                        "a full transcript should produce only the second ACP prompt delta"
                    );
                }
                if prompt.contains("scoped-divergent") || prompt.contains("scoped-other-key") {
                    assert_eq!(
                        prompt_count, 1,
                        "untrusted or divergent history must use a fresh ACP process"
                    );
                }
                if prompt == "account-route" {
                    let text = std::env::var("ECPA_ACP_TEST_ACCOUNT").unwrap();
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})
                    );
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","id":value["id"],"result":{"stopReason":"end_turn"}})
                    );
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                if prompt == "native-tools" {
                    assert!(tool_config.get("_meta").is_none());
                    assert_eq!(tool_config["name"], "api_client");
                    let mut helper = Command::new(tool_config["command"].as_str().unwrap());
                    for arg in tool_config["args"].as_array().unwrap() {
                        helper.arg(arg.as_str().unwrap());
                    }
                    for var in tool_config["env"].as_array().unwrap() {
                        helper.env(
                            var["name"].as_str().unwrap(),
                            var["value"].as_str().unwrap(),
                        );
                    }
                    let mut helper = helper
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::null())
                        .spawn()
                        .unwrap();
                    let mut input = helper.stdin.take().unwrap();
                    let mut replies =
                        std::io::BufReader::new(helper.stdout.take().unwrap()).lines();
                    let call = |input: &mut std::process::ChildStdin, id: u64, arg: &str| {
                        writeln!(input,"{}",json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"lookup","arguments":{"key":arg}}})).unwrap();
                    };
                    let mut read = || {
                        let reply = replies
                            .by_ref()
                            .find_map(|line| serde_json::from_str::<Value>(&line.unwrap()).ok())
                            .unwrap();
                        let id = reply["id"].as_u64().unwrap();
                        (
                            id,
                            reply["result"]["content"][0]["text"]
                                .as_str()
                                .unwrap()
                                .to_owned(),
                        )
                    };
                    call(&mut input, 11, "alpha");
                    call(&mut input, 12, "beta");
                    let results = BTreeMap::from([read(), read()]);
                    assert_eq!(results[&11], "RESULT-alpha");
                    assert_eq!(results[&12], "RESULT-beta");
                    call(&mut input, 13, "gamma");
                    assert_eq!(read(), (13, "RESULT-gamma".to_owned()));
                    drop(input);
                    assert!(helper.wait().unwrap().success());
                }
                if selected == "plain-model"
                    || ["inspect-image", "use-client-tool-with-image"].contains(&prompt)
                {
                    assert!(std::env::var_os("ECPA_ACP_TEST_IMAGE").is_some());
                    let image = json!({"type":"image","mimeType":"image/png","data":PNG});
                    if selected == "plain-model" {
                        assert_eq!(*blocks, json!([image]));
                    } else {
                        assert_eq!(
                            *blocks,
                            json!([{"type":"text","text":prompt}, image, {"type":"text","text":"after"}])
                        );
                    }
                }
                if matches!(
                    prompt,
                    "typed-upstream-permission"
                        | "typed-upstream-quota-after-text"
                        | "ordinary-upstream-words"
                ) {
                    if prompt != "typed-upstream-permission" {
                        let text = if prompt == "ordinary-upstream-words" {
                            "Example error codes: RESOURCE_EXHAUSTED and PERMISSION_DENIED."
                        } else {
                            "partial"
                        };
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})
                        );
                    }
                    if prompt == "ordinary-upstream-words" {
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","id":value["id"],"result":{"stopReason":"end_turn"}})
                        );
                    } else {
                        let status = if prompt == "typed-upstream-permission" {
                            "PERMISSION_DENIED"
                        } else {
                            "RESOURCE_EXHAUSTED"
                        };
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32603,"message":"private process detail with RESOURCE_EXHAUSTED and https://example.invalid/secret","data":{"status":status}}})
                        );
                    }
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                if prompt == "foreign-update-before-rejection" {
                    for session in [json!("unrelated-session"), Value::Null] {
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"not from this turn"}}}})
                        );
                    }
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32603,"message":"fixture","data":{"status":"PERMISSION_DENIED"}}})
                    );
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                if prompt == "empty-before-permission-error" {
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":""}}}})
                    );
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32603,"message":"private failure detail","data":{"status":"PERMISSION_DENIED"}}})
                    );
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                if prompt == "fail-before-output" || prompt == "fail-after-output" {
                    if prompt == "fail-after-output" {
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"partial"}}}})
                        );
                    }
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32603,"message":"simulated upstream failure"}})
                    );
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                if [
                    "use-client-tool",
                    "use-client-tool-with-image",
                    "mixed-context-tool",
                ]
                .contains(&prompt)
                {
                    if prompt == "mixed-context-tool" {
                        assert_eq!(framed, context_mode);
                    }
                    let env = tool_config["env"].as_array().unwrap();
                    let port: u16 = env
                        .iter()
                        .find(|v| v["name"] == "ECPA_ACP_TOOL_PORT")
                        .unwrap()["value"]
                        .as_str()
                        .unwrap()
                        .parse()
                        .unwrap();
                    let key = &env
                        .iter()
                        .find(|v| v["name"] == "ECPA_ACP_TOOL_KEY")
                        .unwrap()["value"];
                    let mut socket =
                        std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                            .unwrap();
                    writeln!(socket,"{}",json!({"key":key,"request":{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"lookup","arguments":{"key":"alpha"}}}})).unwrap();
                    let mut line = String::new();
                    std::io::BufReader::new(socket)
                        .read_line(&mut line)
                        .unwrap();
                    let result: Value = serde_json::from_str(&line).unwrap();
                    let text = result["result"]["content"][0]["text"].as_str().unwrap();
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})
                    );
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","id":value["id"],"result":{"stopReason":"end_turn"}})
                    );
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                if value["params"]["prompt"][0]["text"] == "verify-system" {
                    assert_eq!(system, "be brief\n\nuse plain language");
                }
                if let Some(expected) = value["params"]["prompt"][0]["text"]
                    .as_str()
                    .and_then(|text| text.strip_prefix("expect:"))
                {
                    assert_eq!(selected, expected);
                }
                if value["params"]["prompt"][0]["text"] == "wait" {
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"started"}}}})
                    );
                    std::io::stdout().flush().unwrap();
                    std::thread::sleep(Duration::from_secs(15));
                }
                if prompt == "short-wait" {
                    let account = std::env::var("ECPA_ACP_TEST_ACCOUNT")
                        .unwrap_or_else(|_| "default".into());
                    std::thread::sleep(Duration::from_millis(250));
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":account}}}})
                    );
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","id":value["id"],"result":{"stopReason":"end_turn"}})
                    );
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                if prompt == "proxy-echo" {
                    let account = std::env::var("ECPA_ACP_TEST_ACCOUNT")
                        .unwrap_or_else(|_| "default".into());
                    let proxy = std::env::var("ECPA_ACP_TEST_PROXY").unwrap_or_default();
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("account={account};proxy={proxy}")}}}})
                    );
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","id":value["id"],"result":{"stopReason":"end_turn"}})
                    );
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                if prompt == "failover-on-default" {
                    let account = std::env::var("ECPA_ACP_TEST_ACCOUNT")
                        .unwrap_or_else(|_| "default".into());
                    if account == "default" {
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32000,"message":"rate limited","data":{"status":"RESOURCE_EXHAUSTED"}}})
                        );
                    } else {
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("served-by:{account}")}}}})
                        );
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","id":value["id"],"result":{"stopReason":"end_turn"}})
                        );
                    }
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                if prompt == "failover-auth-on-default" {
                    let account = std::env::var("ECPA_ACP_TEST_ACCOUNT")
                        .unwrap_or_else(|_| "default".into());
                    if account == "default" {
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32000,"message":"auth expired","data":{"status":"UNAUTHENTICATED"}}})
                        );
                    } else {
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("served-by:{account}")}}}})
                        );
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","id":value["id"],"result":{"stopReason":"end_turn"}})
                        );
                    }
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                if prompt == "midstream-quota-on-default" {
                    let account = std::env::var("ECPA_ACP_TEST_ACCOUNT")
                        .unwrap_or_else(|_| "default".into());
                    if account == "default" {
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"partial-"}}}})
                        );
                        std::io::stdout().flush().unwrap();
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32000,"message":"quota midstream","data":{"status":"RESOURCE_EXHAUSTED"}}})
                        );
                    } else {
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("REPLAYED-BY:{account}")}}}})
                        );
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","id":value["id"],"result":{"stopReason":"end_turn"}})
                        );
                    }
                    std::io::stdout().flush().unwrap();
                    continue;
                }
                for text in ["ACP_", "OK"] {
                    println!(
                        "{}",
                        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"isolated-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})
                    );
                }
                json!({"stopReason":"end_turn"})
            }
            _ => panic!("Unexpected ACP method"),
        };
        println!(
            "{}",
            json!({"jsonrpc":"2.0","id":value["id"],"result":result})
        );
        std::io::stdout().flush().unwrap();
    }
}

fn spawn_fake(executable: &Path, profile: &Path, proxy: &str) -> Result<rpc::Client, String> {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "acp::bridge::tests::fake_official_server",
            "--nocapture",
        ])
        .env("ECPA_ACP_BRIDGE_TEST_HELPER", "1")
        .env("ECPA_ACP_TEST_PROXY", proxy)
        .env(
            "ECPA_ACP_TEST_ACCOUNT",
            if accounts::is_isolated_home(profile) {
                profile.parent().unwrap().file_name().unwrap()
            } else {
                std::ffi::OsStr::new("default")
            },
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command.env(
        "ECPA_TEST_CONTEXT",
        if executable == Path::new("fake-context-cli") {
            "yes"
        } else {
            "no"
        },
    );
    if executable == Path::new("fake-image-cli") || executable == Path::new("fake-context-cli") {
        command.env("ECPA_ACP_TEST_IMAGE", "1");
    } else {
        command.env_remove("ECPA_ACP_TEST_IMAGE");
    }
    crate::configure_background_command(&mut command);
    rpc::Client::spawn_command(command)
}

#[test]
fn reauthentication_uses_official_advertised_logout() {
    let mut client = spawn_fake(Path::new("unused"), Path::new("unused"), "").unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    client.initialize(&cancel).unwrap();
    client.logout(&cancel).unwrap();
}

#[test]
#[ignore = "requires official authenticated profile; verifies real client tool round trip"]
fn official_agent_waits_for_client_tool_and_continues() {
    let profile = PathBuf::from(std::env::var_os("ECPA_ACP_PROBE_PROFILE").expect("Set profile"));
    let executable = PathBuf::from(std::env::var_os("ECPA_ACP_PROBE_CLI").expect("Set CLI"));
    let cancel = Arc::new(AtomicBool::new(false));
    let mut discovery = rpc::Client::spawn(&executable, &profile, "").unwrap();
    discovery.initialize(&cancel).unwrap();
    let models = model_list(&discovery.session(&profile, &cancel).unwrap());
    let mut value = json!({"model":"acp/gemini-3.8-flash-high","messages":[{"role":"user","content":"Call lookup with key alpha. Wait for its returned secret and reply with the secret. Do not guess."}],"tools":[{"type":"function","function":{"name":"lookup","description":"Look up a secret. The API client executes this.","parameters":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}}}]});
    let request = parse_completion(&value, &models).unwrap();
    let identity = Identity {
        account: request_pool::AccountRoute {
            id: "test".into(),
            profile: profile.clone(),
        },
        model: request.model.clone(),
        system: request.system.clone(),
        instructions_bytes: request.instructions_bytes,
        tools: request.tools.clone(),
        protocol: Protocol::Chat,
        caller: None,
    };
    let sessions = super::super::agent::Sessions::default();
    let session = sessions
        .start(&request, identity.clone(), discovery)
        .unwrap();
    let output = sessions
        .collect(&session, &request, &cancel, false, |_| {})
        .unwrap();
    assert!(
        !output.calls.is_empty(),
        "Official Agent did not call provided tool; text: {}",
        output.text
    );
    assert_eq!(output.calls[0]["function"]["name"], "lookup");
    sessions.publish(&session, None, &output, &cancel).unwrap();
    let marker = format!(
        "TOOL_SECRET_{}",
        super::super::tool_transport::secret().unwrap()
    );
    value["messages"]
        .as_array_mut()
        .unwrap()
        .push(output.message());
    for call in &output.calls {
        value["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"tool","tool_call_id":call["id"],"content":marker}));
    }
    let request = parse_completion(&value, &models).unwrap();
    let session = sessions.resume(&request, &identity, None).unwrap().unwrap();
    let output = sessions
        .collect(&session, &request, &cancel, false, |_| {})
        .unwrap();
    assert!(
        output.calls.is_empty(),
        "Agent unexpectedly called another tool"
    );
    assert!(
        output.text.contains(&marker),
        "Agent did not receive client result"
    );
}

#[tokio::test]
async fn authenticated_http_bridge_lists_models_completes_streams_and_cancels_disconnects() {
    let app = tauri::test::mock_app();
    app.manage(AcpState::default());
    app.manage(crate::GuiConfigState::new(crate::GuiConfigFile::default()));
    let directory = crate::unique_test_temp_path("acp-http");
    std::fs::create_dir_all(&directory).unwrap();
    {
        let state = app.state::<AcpState>();
        let mut status = state.status.lock().unwrap();
        status.models = models();
        status.authenticated = true;
        status.upstream_enabled = true;
        status.executable = Some("fake-official-cli".into());
        status.profile = directory.to_string_lossy().into_owned();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        app.handle().clone(),
        listener,
        "internal-test-key".into(),
        stop.clone(),
        PromptProfile::Append,
        spawn_fake,
    ));
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert_eq!(
        http.get(format!("{base}/v1/models"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let listing: Value = http
        .get(format!("{base}/v1/models"))
        .bearer_auth("internal-test-key")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listing["data"][0]["id"], "acp/test-model");
    let advertised_model = listing["data"][0]["id"].as_str().unwrap();
    for (model, stream) in [
        (advertised_model, false),
        (advertised_model, true),
        ("test-model", false),
        ("test-model", true),
    ] {
        let mut payload = request(stream);
        payload["model"] = json!(model);
        payload["messages"][0]["content"] = json!("expect:test-model");
        payload["max_tokens"] = json!(1024);
        payload["temperature"] = json!(0.7);
        payload["top_p"] = json!(1);
        let response = http
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("internal-test-key")
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["x-ecpa-ignored-parameters"],
            "max_tokens, temperature, top_p"
        );
        if stream {
            assert_eq!(response.headers()["content-type"], "text/event-stream");
            let body = response.text().await.unwrap();
            let chunks = chat_stream(&body, "stop");
            let text: String = chunks
                .iter()
                .filter_map(|chunk| chunk["choices"][0]["delta"]["content"].as_str())
                .collect();
            assert_eq!(text, "ACP_OK");
        } else {
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["model"], advertised_model);
            assert_eq!(body["choices"][0]["message"]["content"], "ACP_OK");
        }
    }
    for after_output in [false, true] {
        let mut payload = request(true);
        payload["messages"][0]["content"] = json!(if after_output {
            "fail-after-output"
        } else {
            "fail-before-output"
        });
        let response = http
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("internal-test-key")
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), if after_output { 200 } else { 502 });
        let body = response.text().await.unwrap();
        assert!(body.contains("The upstream ACP agent returned an error"));
        assert!(!body.contains("simulated upstream failure"));
        assert!(
            !body.contains("[DONE]"),
            "a failed stream cannot finish successfully: {body}"
        );
        if after_output {
            assert!(body.contains("event: error\n"));
            assert!(body.contains("partial"));
            assert!(!body.contains("\"finish_reason\":\"stop\""));
        }
    }
    let mut waiting = request(true);
    waiting["messages"][0]["content"] = json!("wait");
    let mut response = http
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("internal-test-key")
        .json(&waiting)
        .send()
        .await
        .unwrap();
    assert!(response.chunk().await.unwrap().is_some());
    let busy_response = http
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("internal-test-key")
        .json(&request(false))
        .send()
        .await
        .unwrap();
    assert_eq!(busy_response.status(), 429);
    drop(response);
    tokio::time::timeout(Duration::from_secs(5), async {
        while app.state::<AcpState>().request_pool.active_count() > 0 {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("client disconnect must cancel and release the operation");
    for (enabled, authenticated) in [(false, true), (true, false)] {
        {
            let state = app.state::<AcpState>();
            let mut status = state.status.lock().unwrap();
            status.upstream_enabled = enabled;
            status.authenticated = authenticated;
        }
        let response = http
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("internal-test-key")
            .json(&request(false))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 503);
    }
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
#[ignore = "requires ECPA_ACP_TEST_CORE pointing to a CPA v8 executable; starts an isolated kernel"]
async fn real_cpa_lists_and_routes_registered_acp_models() {
    verify_real_cpa(false).await;
}

#[tokio::test]
#[ignore = "requires ECPA_ACP_TEST_CORE; checks provider removal via the isolated kernel watcher"]
async fn real_cpa_removes_registered_acp_models_on_hot_reload() {
    verify_real_cpa(true).await;
}

async fn verify_real_cpa(check_reload: bool) {
    let executable =
        PathBuf::from(std::env::var_os("ECPA_ACP_TEST_CORE").expect("Set ECPA_ACP_TEST_CORE"));
    let directory = crate::unique_test_temp_path("acp-cpa-contract");
    std::fs::create_dir_all(&directory).unwrap();
    let app = tauri::test::mock_app();
    app.manage(AcpState::default());
    app.manage(crate::GuiConfigState::new(crate::GuiConfigFile::default()));
    {
        let state = app.state::<AcpState>();
        let mut status = state.status.lock().unwrap();
        status.models = models();
        status.authenticated = true;
        status.upstream_enabled = true;
        status.executable = Some("fake-image-cli".into());
        status.profile = directory.to_string_lossy().into_owned();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bridge_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        app.handle().clone(),
        listener,
        "internal-test-key".into(),
        stop.clone(),
        PromptProfile::Append,
        spawn_fake,
    ));
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut document: serde_norway::Value = serde_norway::to_value(json!({
        "config-version":8,"server":{"host":"127.0.0.1","port":port},
        "management":{"disable-control-panel":true,"disable-auto-update-panel":true},
        "oauth":{"auth-dir":directory.join("auth")},"access":{"api-keys":["isolated-client-key"]},
        "logging":{"to-file":false},"requests":{"retry":0},
        "api-keys":{"openai-compatibility":[{"name":"unrelated-disabled","disabled":true,"base-url":"http://127.0.0.1:1/v1","keys":[{"api-key":"unused-test-key"}],"models":[{"name":"unused-test-model"}]}]}
    }))
    .unwrap();
    patch_provider(
        &mut document,
        Some(provider_entry(&bridge_url, "internal-test-key", &models(), true).unwrap()),
    )
    .unwrap();
    let config = directory.join("config.yaml");
    std::fs::write(&config, serde_norway::to_string(&document).unwrap()).unwrap();
    let mut command = Command::new(executable);
    command
        .arg("-config")
        .arg(&config)
        .current_dir(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            std::fs::File::create(directory.join("core.log")).unwrap(),
        ))
        .stderr(Stdio::null());
    crate::configure_background_command(&mut command);
    let mut child = crate::spawn_core_child(command).unwrap();
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let result: Result<(), String> = async {
        let mut listed = false;
        for _ in 0..80 {
            if let Ok(response) = http
                .get(format!("{base}/v1/models"))
                .bearer_auth("isolated-client-key")
                .send()
                .await
            {
                if let Ok(body) = response.json::<Value>().await {
                    if body["data"].as_array().is_some_and(|items| {
                        items.iter().any(|item| item["id"] == "acp/test-model")
                    }) {
                        listed = true;
                        break;
                    }
                }
            }
            if child.try_wait().unwrap().is_some() {
                return Err("Isolated CPA exited".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !listed {
            return Err("CPA did not advertise acp/test-model".into());
        }
        // Exercise both public protocols through the real kernel. The ACP
        // listener implements Chat Completions; Responses conversion belongs
        // to CPA and must not be duplicated in the desktop application.
        for responses in [false, true] {
            for (stream, with_image) in [(false, false), (true, false), (false, true), (true, true)] {
                let (path, mut payload) = if responses {
                    ("responses", json!({"model":"acp/test-model","input":[{"role":"developer","content":"use plain language"},{"role":"user","content":"verify-system"}],"instructions":"be brief","tools":[],"tool_choice":"auto","parallel_tool_calls":true,"stream":stream,"store":false,"max_output_tokens":1024,"temperature":0.7,"top_p":1}))
                } else {
                    let mut value = request(stream);
                    value["messages"] = json!([{"role":"system","content":"be brief"},{"role":"developer","content":"use plain language"},{"role":"user","content":"verify-system"}]);
                    value["tools"] = json!([]);
                    value["tool_choice"] = json!("auto");
                    value["max_tokens"] = json!(1024);
                    value["temperature"] = json!(0.7);
                    value["top_p"] = json!(1);
                    ("chat/completions", value)
                };
                if with_image {
                    if responses {
                        payload["input"][1]["content"] = json!([
                            {"type":"input_text","text":"inspect-image"},
                            {"type":"input_image","image_url":image_part()["image_url"]["url"]},
                            {"type":"input_text","text":"after"}
                        ]);
                    } else {
                        payload["messages"][2]["content"] = json!([
                            {"type":"text","text":"inspect-image"}, image_part(), {"type":"text","text":"after"}
                        ]);
                    }
                }
                let response = http
                    .post(format!("{base}/v1/{path}"))
                    .bearer_auth("isolated-client-key")
                    .json(&payload)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let status = response.status();
                let body = response.text().await.map_err(|e| e.to_string())?;
                if !status.is_success() {
                    return Err(format!("CPA {path} returned {status}: {body}"));
                }
                if stream {
                    if responses {
                        let events: Vec<Value> = body.lines()
                            .filter_map(|line| line.strip_prefix("data: "))
                            .filter_map(|data| serde_json::from_str(data).ok())
                            .collect();
                        let text: String = events.iter()
                            .filter(|event| event["type"] == "response.output_text.delta")
                            .filter_map(|event| event["delta"].as_str())
                            .collect();
                        let completed = events.iter().find(|event| event["type"] == "response.completed");
                        if text != "ACP_OK" || completed.is_none() {
                            return Err(format!("Incomplete CPA Responses SSE: {body}"));
                        }
                        if completed.unwrap()["response"]["status"] != "completed" {
                            return Err(format!("CPA Responses did not complete: {body}"));
                        }
                    } else {
                        let chunks = chat_stream(&body, "stop");
                        let text: String = chunks.iter().filter_map(|chunk|chunk["choices"][0]["delta"]["content"].as_str()).collect();
                        if text != "ACP_OK" { return Err(format!("Incomplete CPA Chat SSE: {body}")); }
                    }
                } else {
                    let body: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
                    if responses {
                        if body["object"] != "response" || body["status"] != "completed"
                            || body["output"][0]["content"][0]["text"] != "ACP_OK" {
                            return Err(format!("Unexpected CPA Responses response: {body}"));
                        }
                    } else if body["choices"][0]["message"]["content"] != "ACP_OK" {
                        return Err(format!("Unexpected CPA Chat response: {body}"));
                    }
                }
            }
        }
        // A real client round trip through both CPA public protocols. The
        // fake Agent blocks on the internal tool transport until the second
        // HTTP request supplies its result; no prompt restart is involved.
        for responses in [false, true] {
            for first_stream in [false, true] {
            for stream in [false, true] {
                let messages = json!([{"role":"user","content":"use-client-tool"}]);
                let function = json!({"name":"lookup","description":"Look up a value","parameters":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}});
                let (path, mut first) = if responses {
                    let mut tool = function.clone(); tool["type"] = json!("function");
                    ("responses",json!({"model":"acp/test-model","input":messages,"tools":[tool],"stream":first_stream,"store":false}))
                } else {
                    ("chat/completions",json!({"model":"acp/test-model","messages":messages,"tools":[{"type":"function","function":function}],"stream":first_stream}))
                };
                let reply = http.post(format!("{base}/v1/{path}")).bearer_auth("isolated-client-key").json(&first).send().await.map_err(|e|e.to_string())?;
                let status = reply.status(); let raw = reply.text().await.map_err(|e|e.to_string())?;
                if !status.is_success() { return Err(format!("Tool start {path}: {status}: {raw}")); }
                let body: Value = if first_stream {
                    if responses {
                        raw.lines().filter_map(|line|line.strip_prefix("data: ")).filter_map(|data|serde_json::from_str::<Value>(data).ok()).find(|event|event["type"] == "response.completed").ok_or_else(||format!("Tool stream did not complete: {raw}"))?["response"].clone()
                    } else {
                        let chunks = chat_stream(&raw, "tool_calls");
                        let mut calls = Vec::new();
                        let mut text = String::new();
                        for chunk in chunks {
                            let delta = &chunk["choices"][0]["delta"];
                            if let Some(part) = delta["content"].as_str() { text.push_str(part); }
                            if let Some(items) = delta["tool_calls"].as_array() {
                                for item in items {
                                    assert_eq!(item["index"], calls.len());
                                    let mut call = item.clone();
                                    call.as_object_mut().unwrap().remove("index");
                                    calls.push(call);
                                }
                            }
                        }
                        json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":if text.is_empty() {Value::Null} else {json!(text)},"tool_calls":calls}}]})
                    }
                } else { serde_json::from_str(&raw).map_err(|e|e.to_string())? };
                if responses {
                    let calls = body["output"].as_array().ok_or("Missing Responses output")?;
                    let call = calls.iter().find(|item|item["type"] == "function_call").ok_or_else(||format!("Missing function_call: {body}"))?;
                    if call["name"] != "lookup" { return Err(format!("Wrong Responses tool: {call}")); }
                    first["input"] = json!([
                        {"role":"user","content":"use-client-tool"},
                        call,
                        {"type":"function_call_output","call_id":call["call_id"],"output":"CLIENT_TOOL_OK"}
                    ]);
                } else {
                    if body["choices"][0]["finish_reason"] != "tool_calls" { return Err(format!("Missing tool finish: {body}")); }
                    let message = &body["choices"][0]["message"];
                    first["messages"] = json!([{"role":"user","content":"use-client-tool"},message,{"role":"tool","tool_call_id":message["tool_calls"][0]["id"],"content":"CLIENT_TOOL_OK"}]);
                }
                first["stream"] = json!(stream);
                let reply = http.post(format!("{base}/v1/{path}")).bearer_auth("isolated-client-key").json(&first).send().await.map_err(|e|e.to_string())?;
                let status = reply.status(); let body = reply.text().await.map_err(|e|e.to_string())?;
                if !status.is_success() || !body.contains("CLIENT_TOOL_OK") { return Err(format!("Tool resume {path}: {status}: {body}")); }
                if stream && !responses { chat_stream(&body, "stop"); }
            }
            }
        }
        // Verify CPA also handles bridge failures through its own translators.
        for responses in [false, true] {
            for after_output in [false, true] {
                // CPA cools down a model after an upstream error. Use distinct
                // advertised variants so failure cases remain independent.
                let model = match (responses, after_output) {
                    (false, false) => "acp/test-model-low",
                    (false, true) => "acp/test-model-medium",
                    (true, false) => "acp/test-model-high",
                    (true, true) => "acp/test-model-xhigh",
                };
                let prompt = if after_output { "fail-after-output" } else { "fail-before-output" };
                let (path, payload) = if responses {
                    ("responses", json!({"model":model,"input":prompt,"stream":true}))
                } else {
                    ("chat/completions", json!({"model":model,"messages":[{"role":"user","content":prompt}],"stream":true}))
                };
                let reply = http.post(format!("{base}/v1/{path}")).bearer_auth("isolated-client-key").json(&payload).send().await.map_err(|e|e.to_string())?;
                let status = reply.status();
                let body = reply.text().await.map_err(|e|e.to_string())?;
                if !body.contains("The upstream ACP agent returned an error") || body.contains("simulated upstream failure") || body.contains("response.completed") || (!after_output && status.as_u16() != 502) {
                    return Err(format!("CPA failure {path}: {status}: {body}"));
                }
            }
        }
        if !check_reload { return Ok(()); }
        register_at(&config, None, "", &[])?;
        for _ in 0..50 {
            let body: Value = http
                .get(format!("{base}/v1/models"))
                .bearer_auth("isolated-client-key")
                .send()
                .await
                .map_err(|e| e.to_string())?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            if !body["data"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["id"] == "acp/test-model"))
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("Removed ACP model remained listed after hot reload".into())
    }
    .await;
    let _ = crate::terminate_child(&mut child);
    drop(child);
    stop.cancel();
    server.await.unwrap();
    if let Err(error) = result {
        panic!(
            "{error}; kernel log: {}",
            std::fs::read_to_string(directory.join("core.log")).unwrap_or_default()
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn http_bridge_flattens_multi_turn_history_into_the_prompt() {
    let app = tauri::test::mock_app();
    app.manage(AcpState::default());
    app.manage(crate::GuiConfigState::new(crate::GuiConfigFile::default()));
    let directory = crate::unique_test_temp_path("acp-http-history");
    std::fs::create_dir_all(&directory).unwrap();
    {
        let state = app.state::<AcpState>();
        let mut status = state.status.lock().unwrap();
        status.models = models();
        status.authenticated = true;
        status.upstream_enabled = true;
        status.executable = Some("fake-official-cli".into());
        status.profile = directory.to_string_lossy().into_owned();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        app.handle().clone(),
        listener,
        "internal-test-key".into(),
        stop.clone(),
        PromptProfile::Append,
        spawn_fake,
    ));
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let mut value = request(false);
    value["messages"] = json!([
        {"role":"system","content":"be brief"},
        {"role":"user","content":"hi"},
        {"role":"assistant","content":[{"type":"text","text":"hello"}]},
        {"role":"user","content":"again"}
    ]);
    let response = http
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("internal-test-key")
        .json(&value)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], "ACP_OK");
    assert_eq!(body["model"], "acp/test-model");
    let mut rejected = value.clone();
    rejected["messages"] = json!([
        {"role":"user","content":"hi"},
        {"role":"tool","content":"x"}
    ]);
    let response = http
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("internal-test-key")
        .json(&rejected)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("role 'tool'"),
        "{body}"
    );
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

// Real Some(Runtime) with a task-local registration path. Never patch global
// config/env or assume a mock state's absent runtime exercises sync failure.
async fn damaged_account_runtime(
    kind: &str,
) -> (tauri::App<tauri::test::MockRuntime>, PathBuf, PathBuf) {
    let (app, root) = bridge_fixture();
    accounts::mark_saved(&root).unwrap();
    accounts::set_active_email(&root, Some("saved@example.test".into())).unwrap();
    let config_directory = root.join("owned-core");
    std::fs::create_dir(&config_directory).unwrap();
    let config = config_directory.join("config.yaml");
    std::fs::write(&config, "openai-compatibility: []\n").unwrap();
    set_enabled(app.handle(), &root, &config, true, false)
        .await
        .unwrap();
    assert!(app.state::<AcpState>().bridge.lock().unwrap().is_some());
    if kind == "malformed" {
        std::fs::write(&config, "openai-compatibility: not-a-list\n").unwrap();
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&config_directory, std::fs::Permissions::from_mode(0o500))
                .unwrap();
        }
        #[cfg(not(unix))]
        {
            std::fs::remove_file(&config).unwrap();
            std::fs::create_dir(&config).unwrap();
        }
    }
    (app, root, config)
}

fn cleanup_account_runtime_fixture(root: PathBuf) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            root.join("owned-core"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn provider_sync_failure_does_not_skip_official_logout_or_drop_saved_records() {
    for kind in ["malformed", "unwritable"] {
        let (app, root, _config) = damaged_account_runtime(kind).await;
        let calls = root.join("official-calls.log");
        let state = app.state::<AcpState>();
        let error = logout_session(
            state.inner(),
            &root,
            &Arc::new(AtomicBool::new(false)),
            &mut super::super::lifecycle_tests::tracked_client("ok", Some(&calls)),
        )
        .unwrap_err();
        assert_eq!(
            std::fs::read_to_string(&calls)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            ["initialize", "logout"]
        );
        assert!(
            error.contains("provider configuration sync failed"),
            "{error}"
        );
        assert_eq!(
            state.snapshot().unwrap().error.as_deref(),
            Some(error.as_str())
        );
        let registry = accounts::read(&root).unwrap();
        assert_eq!(registry.accounts.len(), 1);
        assert!(registry.accounts[0].saved);
        assert!(registry.accounts[0].email.is_none());
        let status = state.snapshot().unwrap();
        assert!(!status.authenticated);
        assert!(status.models.is_empty());
        assert!(status.selected_model.is_empty());
        assert!(status.upstream_enabled);
        assert!(upstream_enabled(&root).unwrap());
        assert!(state.bridge.lock().unwrap().is_some());
        let (url, key) = {
            let runtime = state.bridge.lock().unwrap();
            let runtime = runtime.as_ref().unwrap();
            (runtime.url.clone(), runtime.key.clone())
        };
        let reply = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("{url}/chat/completions"))
            .bearer_auth(key)
            .json(&request(false))
            .send()
            .await
            .unwrap();
        assert_eq!(
            reply.status().as_u16(),
            503,
            "live bridge must gate stale provider requests after logout"
        );
        drop(state);
        drop(app);
        cleanup_account_runtime_fixture(root);
    }
}

#[tokio::test]
async fn reauthorization_runs_after_successful_logout_despite_provider_error_but_never_after_logout_failure(
) {
    for (mode, expected) in [
        (
            "ok",
            vec!["initialize", "logout", "authenticate", "session/new"],
        ),
        ("logout-fails", vec!["initialize", "logout"]),
    ] {
        let (app, root, _) = damaged_account_runtime("malformed").await;
        let calls = root.join("reauth-calls.log");
        let state = app.state::<AcpState>();
        let error = connect_session(
            state.inner(),
            &root,
            true,
            true,
            &Arc::new(AtomicBool::new(false)),
            &mut super::super::lifecycle_tests::tracked_client(mode, Some(&calls)),
        )
        .unwrap_err();
        assert_eq!(
            std::fs::read_to_string(&calls)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            expected
        );
        assert!(
            error.contains("provider configuration sync failed"),
            "{error}"
        );
        if mode == "logout-fails" {
            assert!(error.contains("official logout failed"), "{error}");
        }
        let registry = accounts::read(&root).unwrap();
        assert_eq!(registry.accounts.len(), 1);
        assert!(registry.accounts[0].saved);
        let status = state.snapshot().unwrap();
        assert!(!status.authenticated);
        assert!(status.models.is_empty());
        assert!(status.upstream_enabled);
        assert!(upstream_enabled(&root).unwrap());
        drop(state);
        drop(app);
        cleanup_account_runtime_fixture(root);
    }
}

#[tokio::test]
async fn damaged_provider_does_not_prevent_selection_or_current_local_removal() {
    let (app, root, _) = damaged_account_runtime("malformed").await;
    accounts::set_active_email(&root, Some("first@example.test".into())).unwrap();
    let mut pending = accounts::PendingAccount::new(&root, "Second").unwrap();
    pending.commit(Some("second@example.test".into())).unwrap();
    accounts::select(&root, "default").unwrap();
    let state = app.state::<AcpState>();
    select_account_local(state.inner(), &root, &pending.id).unwrap();
    assert_eq!(accounts::read(&root).unwrap().active, pending.id);
    let error = connect_session(
        state.inner(),
        &root,
        false,
        false,
        &Arc::new(AtomicBool::new(false)),
        &mut super::super::lifecycle_tests::client("ok"),
    )
    .unwrap_err();
    assert!(error.contains("provider configuration sync failed"));
    assert_eq!(accounts::read(&root).unwrap().active, pending.id);
    let error = remove_account_local(state.inner(), &root, &pending.id).unwrap_err();
    assert!(error.contains("provider configuration sync failed"));
    let registry = accounts::read(&root).unwrap();
    assert_eq!(registry.active, "default");
    assert_eq!(registry.accounts.len(), 1);
    assert!(root.join("removed-accounts").is_dir());
    assert!(!state.snapshot().unwrap().authenticated);
    assert!(state.snapshot().unwrap().models.is_empty());
    assert!(state.snapshot().unwrap().upstream_enabled);
    assert!(upstream_enabled(&root).unwrap());
    drop(state);
    drop(app);
    cleanup_account_runtime_fixture(root);
}

#[tokio::test]
async fn http_image_capability_and_agent_continuation_work_in_both_modes() {
    let (app, directory) = bridge_fixture();
    app.manage(crate::GuiConfigState::new(crate::GuiConfigFile::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        app.handle().clone(),
        listener,
        "test-key".into(),
        stop.clone(),
        PromptProfile::Append,
        spawn_fake,
    ));
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(6))
        .build()
        .unwrap();
    let send = |payload: &Value| http.post(&url).bearer_auth("test-key").json(payload).send();
    for stream in [false, true] {
        for (cli, tool, image_only) in [
            ("fake-official-cli", false, false),
            ("fake-official-cli", true, false),
            ("fake-image-cli", false, false),
            ("fake-image-cli", false, true),
            ("fake-image-cli", true, false),
        ] {
            {
                let state = app.state::<AcpState>();
                let mut status = state.status.lock().unwrap();
                status.upstream_enabled = true;
                status.executable = Some(cli.into());
            }
            let mut payload = request(stream);
            let mut part = image_part();
            part["image_url"]["detail"] = json!("high");
            let content = if image_only {
                payload["model"] = json!("acp/plain-model");
                json!([part])
            } else {
                json!([{"type":"text","text":if tool {"use-client-tool-with-image"} else {"inspect-image"}}, part, {"type":"text","text":"after"}])
            };
            payload["messages"][0]["content"] = content;
            if tool {
                payload["tools"] = json!([{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]);
            }
            let response = send(&payload).await.unwrap();
            let status = response.status();
            if cli == "fake-official-cli" {
                assert_eq!(status, 400);
                let error: Value = response.json().await.unwrap();
                assert_eq!(error["error"]["type"], "invalid_request_error");
                assert!(error["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("does not advertise image input"));
                continue;
            }
            assert_eq!(status, 200);
            assert_eq!(
                response.headers()["x-ecpa-ignored-parameters"],
                "image_url.detail"
            );
            let body = response.text().await.unwrap();
            let reply = |body: &str, finish: &str| -> Value {
                if stream {
                    let chunks = chat_stream(body, finish);
                    let deltas = chunks.iter().map(|chunk| &chunk["choices"][0]["delta"]);
                    if finish == "tool_calls" {
                        let calls = deltas
                            .filter_map(|delta| delta.get("tool_calls"))
                            .next()
                            .unwrap();
                        json!({"role":"assistant","content":null,"tool_calls":calls})
                    } else {
                        let text: String = deltas
                            .filter_map(|delta| delta["content"].as_str())
                            .collect();
                        json!({"content":text})
                    }
                } else {
                    let body: Value = serde_json::from_str(body).unwrap();
                    assert_eq!(body["choices"][0]["finish_reason"], finish);
                    body["choices"][0]["message"].clone()
                }
            };
            if tool {
                let assistant = reply(&body, "tool_calls");
                let result = json!({"role":"tool","tool_call_id":assistant["tool_calls"][0]["id"],"content":[{"type":"text","text":"CLIENT_"},{"type":"text","text":"TOOL_OK"}]});
                let messages = payload["messages"].as_array_mut().unwrap();
                messages.push(assistant);
                messages.push(result);
                let mut media_result = payload.clone();
                media_result["messages"][2]["content"] = json!([image_part()]);
                assert_eq!(send(&media_result).await.unwrap().status(), 400);
                let mut changed = payload.clone();
                changed["messages"][0]["content"][1] = json!({"type":"text","text":"changed"});
                let reject = send(&changed).await.unwrap();
                assert_eq!(reject.status(), 400);
                assert!(reject
                    .text()
                    .await
                    .unwrap()
                    .contains("history does not match"));
                let response = send(&payload).await.unwrap();
                assert_eq!(response.status(), 200);
                assert_eq!(
                    reply(&response.text().await.unwrap(), "stop")["content"],
                    "CLIENT_TOOL_OK"
                );
            } else {
                assert_eq!(reply(&body, "stop")["content"], "ACP_OK");
            }
        }
    }
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

async fn native_listener(
    app: &tauri::App<tauri::test::MockRuntime>,
    directory: &Path,
) -> (String, CancellationToken, tokio::task::JoinHandle<()>) {
    app.manage(crate::GuiConfigState::new(crate::GuiConfigFile::default()));
    {
        let state = app.state::<AcpState>();
        let mut status = state.status.lock().unwrap();
        status.models = models();
        status.authenticated = true;
        status.upstream_enabled = true;
        status.executable = Some("fake-image-cli".into());
        status.profile = directory.to_string_lossy().into_owned();
        status.active_account = "default".into();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/responses", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        app.handle().clone(),
        listener,
        "internal-test-key".into(),
        stop.clone(),
        PromptProfile::Append,
        spawn_fake,
    ));
    (url, stop, server)
}

fn native_request(client: &reqwest::Client, url: &str, input: Value) -> reqwest::RequestBuilder {
    client
        .post(url)
        .bearer_auth("internal-test-key")
        .json(&input)
}

fn native_frames(body: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    for frame in body.split("\n\n").filter(|frame| !frame.is_empty()) {
        let (name, data) = frame.split_once("\ndata: ").unwrap();
        let event: Value = serde_json::from_str(data).unwrap();
        assert_eq!(name.strip_prefix("event: ").unwrap(), event["type"]);
        assert_eq!(event["sequence_number"], frames.len() + 1);
        frames.push(event);
    }
    frames
}

#[tokio::test]
async fn native_responses_reuses_only_explicit_live_context_and_emits_sse() {
    let (app, directory) = bridge_fixture();
    let (url, stop, server) = native_listener(&app, &directory).await;
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let create =
        |input| json!({"model":"acp/test-model","input":input,"instructions":"stay concise"});
    let initial = http
        .post(&url)
        .json(&create("native-first"))
        .send()
        .await
        .unwrap();
    assert_eq!(initial.status(), 401);
    let first: Value = native_request(&http, &url, create("native-first"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let previous = first["id"].as_str().unwrap();
    assert_eq!(previous.len(), "resp_acp_".len() + 48);
    assert_eq!(first["object"], "response");
    assert_eq!(first["output"][0]["content"][0]["text"], "ACP_OK");
    let mut second = create("native-second");
    second["previous_response_id"] = json!(previous);
    for (key, invalid) in [
        (
            "previous_response_id",
            json!("resp_acp_000000000000000000000000000000000000000000000000"),
        ),
        ("instructions", json!("changed")),
        ("model", json!("acp/test-model-low")),
        ("tools", json!([{"type":"function","name":"changed"}])),
        (
            "input",
            json!([{"role":"assistant","content":"modified historical reply"},{"role":"user","content":"native-second"}]),
        ),
    ] {
        let mut divergent = second.clone();
        divergent[key] = invalid;
        assert_eq!(
            native_request(&http, &url, divergent)
                .send()
                .await
                .unwrap()
                .status(),
            400,
            "{key} unexpectedly claimed the turn"
        );
    }
    // An unrelated request with the same model and instructions creates its
    // own process. It cannot implicitly append to the first caller's session.
    let independent: Value = native_request(&http, &url, create("native-independent"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(independent["id"], first["id"]);
    second["stream"] = json!(true);
    second.as_object_mut().unwrap().remove("instructions");
    let stream = native_request(&http, &url, second.clone())
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(stream.headers()["content-type"], "text/event-stream");
    let frames = native_frames(&stream.text().await.unwrap());
    assert_eq!(frames[0]["type"], "response.created");
    assert_eq!(frames[1]["type"], "response.in_progress");
    assert!(frames
        .iter()
        .any(|v| v["type"] == "response.output_text.delta" && v["delta"] == "ACP_"));
    let last = frames.last().unwrap();
    assert_eq!(last["type"], "response.completed");
    assert_eq!(last["response"]["previous_response_id"], previous);
    assert_ne!(last["response"]["id"], previous);
    assert_eq!(
        native_request(&http, &url, second)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let third: Value = native_request(&http, &url, json!({"model":"acp/test-model","previous_response_id":last["response"]["id"],"input":"native-third"})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(third["output"][0]["content"][0]["text"], "ACP_OK");
    let failed = native_request(
        &http,
        &url,
        json!({"model":"acp/test-model","input":"fail-after-output","stream":true}),
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap();
    let failed = native_frames(&failed.text().await.unwrap());
    assert_eq!(failed.last().unwrap()["type"], "error");
    assert!(failed
        .iter()
        .all(|frame| frame["type"] != "response.completed"));
    let state = app.state::<AcpState>();
    reset_account(&state).unwrap();
    state.status.lock().unwrap().authenticated = true;
    assert_eq!(
        native_request(
            &http,
            &url,
            json!({"model":"acp/test-model","previous_response_id":third["id"],"input":"unused"})
        )
        .send()
        .await
        .unwrap()
        .status(),
        400
    );
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn native_responses_keeps_parallel_and_consecutive_tool_batches_on_one_prompt() {
    let (app, directory) = bridge_fixture();
    let (url, stop, server) = native_listener(&app, &directory).await;
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let tools = json!([{"type":"function","name":"lookup","parameters":{"type":"object","properties":{"key":{"type":"string"}}}}]);
    let open = native_request(&http, &url, json!({"model":"acp/test-model","input":"native-tools","tools":tools,"parallel_tool_calls":true,"stream":true})).send().await.unwrap();
    let status = open.status();
    let body = open.text().await.unwrap();
    assert_eq!(status, 200, "{body}");
    let frames = native_frames(&body);
    let response = &frames.last().unwrap()["response"];
    assert_eq!(frames.last().unwrap()["type"], "response.completed");
    assert_eq!(
        frames
            .iter()
            .filter(|v| v["type"] == "response.function_call_arguments.delta")
            .count(),
        2
    );
    let calls = response["output"].as_array().unwrap();
    assert_eq!(calls.len(), 2);
    let output = |call: &Value| {
        let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
        json!({"type":"function_call_output","call_id":call["call_id"],"output":format!("RESULT-{}",args["key"].as_str().unwrap())})
    };
    let a = output(&calls[0]);
    let b = output(&calls[1]);
    let follow = |id, outputs: Vec<Value>| json!({"model":"acp/test-model","previous_response_id":id,"input":outputs});
    for input in [vec![a.clone()], vec![a.clone(), a.clone()]] {
        assert_eq!(
            native_request(&http, &url, follow(response["id"].clone(), input))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
    }
    assert_eq!(
        native_request(
            &http,
            &url,
            json!({"model":"acp/test-model","input":[a.clone(),b.clone()]})
        )
        .send()
        .await
        .unwrap()
        .status(),
        400
    );
    let middle: Value = native_request(&http, &url, follow(response["id"].clone(), vec![b, a]))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(middle["output"].as_array().unwrap().len(), 1);
    assert_eq!(middle["output"][0]["type"], "function_call");
    let gamma = output(&middle["output"][0]);
    assert_eq!(gamma["output"], "RESULT-gamma");
    let last: Value = native_request(
        &http,
        &url,
        follow(middle["id"].clone(), vec![gamma.clone()]),
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(last["output"][0]["content"][0]["text"], "ACP_OK");
    assert_eq!(
        native_request(&http, &url, follow(middle["id"].clone(), vec![gamma]))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    app.state::<AcpState>().agents.clear();
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn opt_in_pool_uses_distinct_accounts_and_keeps_continuation_sticky() {
    let (app, directory) = bridge_fixture();
    prepare_profile(&directory).unwrap();
    let mut saved =
        accounts::PendingAccount::new_isolated(&directory, "Synthetic alternate", false).unwrap();
    let alternate = saved.directory().unwrap();
    let token = accounts::isolated_token(&alternate);
    std::fs::create_dir_all(token.parent().unwrap()).unwrap();
    crate::write_codex_private_file(&token, b"synthetic non-credential").unwrap();
    saved
        .commit_replacing(Some("alternate@example.test".into()), None, false)
        .unwrap();
    let (url, stop, server) = native_listener(&app, &directory).await;
    let state = app.state::<AcpState>();
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let wait = || {
        native_request(
            &http,
            &url,
            json!({"model":"acp/test-model","input":"wait","stream":true}),
        )
    };
    let route = || {
        native_request(
            &http,
            &url,
            json!({"model":"acp/test-model","input":"account-route"}),
        )
    };
    let ready = || async {
        tokio::time::timeout(Duration::from_secs(4), async {
            while state.request_pool.active_count() > 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    };
    let mut legacy = wait().send().await.unwrap().error_for_status().unwrap();
    assert!(legacy.chunk().await.unwrap().is_some());
    assert_eq!(route().send().await.unwrap().status(), 429);
    drop(legacy);
    ready().await;
    {
        let mut pool = state.request_pool.settings();
        pool.account_pool = true;
        pool.routing_strategy = RoutingStrategy::FillFirst;
        state.request_pool.set_settings(pool);
        *state.request_pool.root.lock().unwrap() = Some(directory.clone());
    }
    let preferred: Value = route()
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(preferred["output"][0]["content"][0]["text"], "default");
    let mut primary = wait().send().await.unwrap().error_for_status().unwrap();
    assert!(primary.chunk().await.unwrap().is_some());
    let routed: Value = route()
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(routed["output"][0]["content"][0]["text"], saved.id);
    let mut secondary = wait().send().await.unwrap().error_for_status().unwrap();
    assert!(secondary.chunk().await.unwrap().is_some());
    let continue_routed = || {
        native_request(
            &http,
            &url,
            json!({"model":"acp/test-model","input":"account-route","previous_response_id":routed["id"]}),
        )
    };
    assert_eq!(continue_routed().send().await.unwrap().status(), 429);
    assert_eq!(route().send().await.unwrap().status(), 429);
    // Destructive exclusive locks on busy accounts must be rejected while API traffic is active.
    assert!(lock_account_exclusive(app.handle(), "default").is_err());
    assert!(lock_account_exclusive(app.handle(), &saved.id).is_err());
    state.cancel();
    drop(primary);
    drop(secondary);
    ready().await;
    state.request_pool.mark_running();
    let sticky: Value = continue_routed()
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sticky["output"][0]["content"][0]["text"], saved.id);
    assert_eq!(state.snapshot().unwrap().active_account, "default");
    state.agents.clear();
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn account_pool_opt_in_is_global_and_does_not_enable_access() {
    let (app, directory) = bridge_fixture();
    let config = directory.join("config.yaml");
    std::fs::write(&config, "openai-compatibility: []\n").unwrap();
    assert!(!read_settings(&directory).unwrap().account_pool);
    std::fs::write(
        settings_path(&directory),
        br#"{"account_pool":true,"prompt_profile":"first_turn_context"}"#,
    )
    .unwrap();
    assert!(!upstream_enabled(&directory).unwrap());
    set_enabled(app.handle(), &directory, &config, true, false)
        .await
        .unwrap();
    let state = app.state::<AcpState>();
    assert_eq!(
        state.request_pool.root.lock().unwrap().as_ref(),
        Some(&directory)
    );
    set_enabled(app.handle(), &directory, &config, false, false)
        .await
        .unwrap();
    assert!(state.request_pool.root.lock().unwrap().is_none());
    let settings = read_settings(&directory).unwrap();
    assert!(!settings.enabled);
    assert!(settings.account_pool);
    assert_eq!(settings.prompt_profile, PromptProfile::FirstTurnContext);
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
#[ignore = "requires pinned ECPA_ACP_TEST_CORE and built ECPA_ACP_TEST_NATIVE_PLUGIN; uses simulated ACP"]
async fn real_cpa_native_executor_reuses_acp_session_and_returns_tool_results() {
    real_cpa_native_profile(PromptProfile::Append).await
}

#[tokio::test]
#[ignore = "requires pinned CPA and native plugin; uses simulated ACP"]
async fn real_cpa_native_first_turn_context() {
    real_cpa_native_profile(PromptProfile::FirstTurnContext).await
}

async fn real_cpa_native_profile(policy: PromptProfile) {
    let core = PathBuf::from(std::env::var_os("ECPA_ACP_TEST_CORE").expect("set CPA executable"));
    let library = PathBuf::from(
        std::env::var_os("ECPA_ACP_TEST_NATIVE_PLUGIN").expect("set native plugin library"),
    );
    let (app, directory) = bridge_fixture();
    app.manage(crate::GuiConfigState::new(crate::GuiConfigFile::default()));
    {
        let state = app.state::<AcpState>();
        let mut status = state.status.lock().unwrap();
        status.upstream_enabled = true;
        status.executable = Some(
            if policy == PromptProfile::Append {
                "fake-image-cli"
            } else {
                "fake-context-cli"
            }
            .into(),
        );
    }
    let state = app.state::<AcpState>();
    let plugins = directory.join("plugins");
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        arch => arch,
    };
    let plugin_path = plugins.join(os).join(arch);
    std::fs::create_dir_all(&plugin_path).unwrap();
    std::fs::copy(
        &library,
        plugin_path.join(format!(
            "ecpa-acp-responses.{}",
            library.extension().unwrap().to_str().unwrap()
        )),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bridge_port = listener.local_addr().unwrap().port();
    let key = bridge_key(&directory).unwrap();
    save_settings(
        &directory,
        &Settings {
            enabled: true,
            port: bridge_port,
            account_pool: false,
            prompt_profile: policy,
            ..Settings::default()
        },
    )
    .unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn(serve(
        app.handle().clone(),
        listener,
        key.clone(),
        stop.clone(),
        read_settings(&directory).unwrap().prompt_profile,
        spawn_fake,
    ));
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut document: serde_norway::Value = serde_norway::to_value(json!({
        "config-version":8,"server":{"host":"127.0.0.1","port":port},
        "management":{"disable-control-panel":true,"disable-auto-update-panel":true},
        "oauth":{"auth-dir":directory.join("auth")},"access":{"api-keys":["internal-test-key","different-caller"]},
        "requests":{"retry":3},"streaming":{"bootstrap-retries":3},
        "plugins":{"enabled":true,"dir":plugins,"configs":{"ecpa-acp-responses":{"enabled":true,"bridge_profile":directory}}}
    })).unwrap();
    let upstream = format!("http://127.0.0.1:{bridge_port}/v1");
    patch_provider(
        &mut document,
        Some(provider_entry(&upstream, &key, &models(), true).unwrap()),
    )
    .unwrap();
    let config = directory.join("config.yaml");
    std::fs::write(&config, serde_norway::to_string(&document).unwrap()).unwrap();
    let log_path = directory.join("core.log");
    let mut command = Command::new(core);
    command
        .arg("-config")
        .arg(&config)
        .arg("--local-model")
        .current_dir(&directory)
        .env("HOME", &directory)
        .env("XDG_CONFIG_HOME", &directory)
        .stdin(Stdio::null())
        .stdout(Stdio::from(std::fs::File::create(&log_path).unwrap()))
        .stderr(Stdio::null());
    crate::configure_background_command(&mut command);
    let mut core = crate::spawn_core_child(command).unwrap();
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let url = format!("{base}/v1/responses");
    let create = |input: Value| json!({"model":"acp/test-model","input":input});
    let checked = |value: Value| async {
        let response = native_request(&http, &url, value)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let body = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("native response failed: {status} {body}"));
        }
        Ok(body)
    };
    let checked_json = |value| async {
        serde_json::from_str::<Value>(&checked(value).await?).map_err(|e| e.to_string())
    };
    let result: Result<(),String> = async {
        for _ in 0..80 {
            if let Ok(response) = http.get(format!("{base}/v1/models")).bearer_auth("internal-test-key").send().await {
                if response.text().await.is_ok_and(|body|body.contains("acp/test-model")) { break; }
            }
            if core.try_wait().map_err(|e|e.to_string())?.is_some() { return Err("isolated CPA exited".into()); }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
        let unauthorized = http.post(&url).json(&create(json!("native-first"))).send().await.map_err(|e|e.to_string())?;
        if unauthorized.status() != 401 { return Err("CPA authentication did not reject a missing client key".into()); }
        let top = "α\r\n第一条";
        let directive = "保持顺序\n";
        let mixed = |user: &str| json!({"model":"acp/test-model","instructions":top,"input":[{"role":"developer","content":directive},{"role":"user","content":user}]});
        let mixed_id = checked_json(mixed("mixed-first")).await?["id"].clone();
        let repeat = |instructions:Value| json!({"model":"acp/test-model","previous_response_id":mixed_id,"instructions":instructions,"input":"mixed-next"});
        for changed in [Value::Null,json!(""),json!(format!("{top}\n\n{directive}")),json!("changed")] {
            let invalid = native_request(&http,&url,repeat(changed)).send().await.map_err(|e|e.to_string())?;
            if invalid.status()!=400 {return Err("A changed or cleared top-level instruction claimed a mixed-source session".into());}
        }
        checked_json(repeat(json!(top))).await?;
        let history = checked_json(mixed("mixed-history-start")).await?;
        let next_history = |suffix: &str| json!([{"role":"user","content":"mixed-history-start"}, history["output"][0], {"role":"user","content":suffix}]);
        checked_json(json!({"model":"acp/test-model","instructions":format!("{top}\n\n{directive}"),"input":next_history("mixed-history-fresh")})).await?;
        let mut replay=next_history("mixed-history-delta");
        replay.as_array_mut().unwrap().insert(0,json!({"role":"developer","content":directive}));
        checked_json(json!({"model":"acp/test-model","instructions":top,"input":replay})).await?;
        let mut mixed_tool = mixed("mixed-context-tool");
        mixed_tool["tools"]=json!([{"type":"function","name":"lookup","parameters":{"type":"object"}}]);
        let tool = checked_json(mixed_tool).await?;
        let result = checked_json(json!({"model":"acp/test-model","previous_response_id":tool["id"],"instructions":top,"input":[{"type":"function_call_output","call_id":tool["output"][0]["call_id"],"output":"mixed tool reply"}]})).await?;
        if result["output"][0]["content"][0]["text"] != "mixed tool reply" {return Err("Mixed-source instructions did not retain the pending tool prompt".into());}

        let first = checked_json(create(json!("native-first"))).await?;
        let id = first["id"].as_str().filter(|id|id.starts_with("resp_acp_")).ok_or("first request did not use native ACP upstream")?;
        let mut spoof = create(json!("should not continue"));
        spoof["previous_response_id"] = json!(id);
        spoof["client_metadata"] = json!({"caller_scope":"internal-test-key"});
        let cross = http.post(&url).bearer_auth("different-caller")
            .header("X-Ecpa-Acp-Caller-Scope", "a".repeat(64)).json(&spoof)
            .send().await.map_err(|e|e.to_string())?;
        if cross.status() != 400 { return Err("different CPA client key could claim another caller's response".into()); }
        let mut second = create(json!("native-second"));
        second["previous_response_id"] = json!(id);
        second["stream"] = json!(true);
        let stream = checked(second).await?;
        let final_frame = stream.lines().filter_map(|line|line.strip_prefix("data: ")).filter_map(|data|serde_json::from_str::<Value>(data).ok()).find(|v|v["type"]=="response.completed").ok_or_else(||format!("native stream did not complete: {stream}"))?;
        if final_frame["response"]["previous_response_id"] != id { return Err("CPA lost native continuation ID".into()); }
        let mut third = create(json!("native-third"));
        third["previous_response_id"] = final_frame["response"]["id"].clone();
        if checked_json(third).await?["output"][0]["content"][0]["text"] != "ACP_OK" { return Err("native ACP session did not carry the third delta".into()); }
        let mut open = create(json!("use-client-tool"));
        open["tools"] = json!([{"type":"function","name":"lookup","parameters":{"type":"object"}}]);
        let open = checked_json(open).await?;
        let call = &open["output"][0];
        if call["type"] != "function_call" { return Err(format!("ACP did not return a native function item: {open}")); }
        let mut result = create(json!([{"type":"function_call_output","call_id":call["call_id"],"output":"ECPA_TOOL_RESULT"}]));
        result["previous_response_id"] = open["id"].clone();
        if checked_json(result.clone()).await?["output"][0]["content"][0]["text"] != "ECPA_TOOL_RESULT" { return Err("native tool result did not return to the original ACP prompt".into()); }
        if native_request(&http,&url,result).send().await.map_err(|e|e.to_string())?.status() != 400 { return Err("replayed native tool result was not rejected".into()); }
        let scoped_origin = checked_json(create(json!("scoped-first"))).await?;
        let scoped = |initial: &str, suffix: &str| create(json!([
            {"role":"user","content":initial},
            scoped_origin["output"][0],
            {"role":"user","content":suffix}
        ]));
        checked_json(scoped("edited-history", "scoped-divergent")).await?;
        let other = http.post(&url).bearer_auth("different-caller").json(&scoped("scoped-first", "scoped-other-key"))
            .send().await.map_err(|e|e.to_string())?;
        other.error_for_status().map_err(|e|e.to_string())?;
        checked_json(scoped("scoped-first", "scoped-delta")).await?;
        let permission = native_request(&http,&url,create(json!("typed-upstream-permission"))).send().await.map_err(|e|e.to_string())?;
        if permission.status()!=403 { return Err(format!("Incorrect typed HTTP status: {}",permission.status())); }
        let permission=permission.text().await.map_err(|e|e.to_string())?;
        if !permission.contains("denied permission")||permission.contains("example.invalid") {return Err("Typed HTTP response was not sanitized".into());}
        let mut stale=create(json!("foreign-update-before-rejection")); stale["stream"]=json!(true);
        let response=native_request(&http,&url,stale).send().await.map_err(|e|e.to_string())?;
        let status=response.status(); let body=response.text().await.map_err(|e|e.to_string())?;
        if status!=403 || body.contains("not from this turn") || body.contains("response.created") || !body.contains("denied permission") {return Err(format!("Unrelated session update committed the response: status={status}"));}
        let mut empty=create(json!("empty-before-permission-error"));
        empty["stream"]=json!(true);
        let empty=native_request(&http,&url,empty).send().await.map_err(|e|e.to_string())?;
        let empty_status=empty.status();
        let empty_body=empty.text().await.map_err(|e|e.to_string())?;
        if empty_status!=403 || empty_body.contains("response.created") || empty_body.contains("private failure detail") || !empty_body.contains("denied permission") {
            return Err(format!("Empty ACP text committed the stream before a rejection: {empty_status} {empty_body}"));
        }
        let mut quota=create(json!("typed-upstream-quota-after-text"));quota["stream"]=json!(true);
        let quota=checked(quota).await?;
        let terminal=quota.lines().filter_map(|line|line.strip_prefix("data: ")).filter_map(|line|serde_json::from_str::<Value>(line).ok()).find(|value|value["type"]=="error");
        if !quota.contains("partial") || quota.contains("response.completed") || quota.contains("example.invalid") || !terminal.is_some_and(|event|event["error"]["code"]=="rate_limit_error") { return Err(format!("Incorrect typed SSE termination: {quota}")); }
        let local_quota=http.post(format!("{upstream}/responses")).bearer_auth(&key)
            .json(&json!({"model":"acp/test-model","input":"typed-upstream-quota-after-text","stream":true}))
            .send().await.map_err(|e|e.to_string())?.error_for_status().map_err(|e|e.to_string())?.text().await.map_err(|e|e.to_string())?;
        let local_terminal=local_quota.lines().filter_map(|line|line.strip_prefix("data: ")).filter_map(|line|serde_json::from_str::<Value>(line).ok()).find(|value|value["type"]=="error");
        if !local_terminal.is_some_and(|event|event["code"]=="rate_limit_error"&&event["status"]==429) {return Err("Loopback Responses SSE omitted its error status".into());}
        let normal=checked_json(create(json!("ordinary-upstream-words"))).await?;
        if normal["output"][0]["content"][0]["text"]!="Example error codes: RESOURCE_EXHAUSTED and PERMISSION_DENIED." { return Err("ordinary assistant text was misclassified".into()); }
        let framed_chat = json!({"model":"acp/test-model","messages":[{"role":"system","content":top},{"role":"developer","content":directive},{"role":"user","content":"mixed-first"}]});
        let chat = http.post(format!("{base}/v1/chat/completions")).bearer_auth("internal-test-key").json(&framed_chat).send().await.map_err(|e|e.to_string())?;
        chat.error_for_status().map_err(|e|e.to_string())?;
        let legacy = http.post(format!("{base}/v1/chat/completions")).bearer_auth("internal-test-key").json(&request(false)).send().await.map_err(|e|e.to_string())?;
        let legacy: Value = legacy.error_for_status().map_err(|e|e.to_string())?.json().await.map_err(|e|e.to_string())?;
        if legacy["choices"][0]["message"]["content"] != "ACP_OK" { return Err("Chat fallback is not intact".into()); }
        Ok(())
    }.await;
    let _ = crate::terminate_child(&mut core);
    state.agents.clear();
    stop.cancel();
    server.await.unwrap();
    if let Err(error) = result {
        panic!(
            "{error}; isolated CPA log: {}",
            std::fs::read_to_string(log_path).unwrap_or_default()
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn high_concurrency_pool_parallel_slots_and_async_queue_wait() {
    let (app, directory) = bridge_fixture();
    prepare_profile(&directory).unwrap();
    accounts::mark_saved(&directory).unwrap();
    accounts::set_active_email(&directory, Some("primary@example.test".into())).unwrap();
    accounts::update_settings(
        &directory,
        "default",
        &accounts::AccountSettingsPatch {
            max_concurrency: Some(2),
            ..Default::default()
        },
    )
    .unwrap();
    let mut secondary =
        accounts::PendingAccount::new_isolated(&directory, "Pool B", false).unwrap();
    let token = accounts::isolated_token(&secondary.directory().unwrap());
    std::fs::create_dir_all(token.parent().unwrap()).unwrap();
    crate::write_codex_private_file(&token, b"synthetic-token").unwrap();
    secondary
        .commit_replacing(Some("secondary@example.test".into()), None, false)
        .unwrap();
    accounts::update_settings(
        &directory,
        &secondary.id,
        &accounts::AccountSettingsPatch {
            max_concurrency: Some(2),
            ..Default::default()
        },
    )
    .unwrap();

    let (url, stop, server) = native_listener(&app, &directory).await;
    let state = app.state::<AcpState>();
    {
        let mut pool = state.request_pool.settings();
        pool.account_pool = true;
        pool.routing_strategy = RoutingStrategy::RoundRobin;
        pool.max_global_concurrency = 4;
        pool.queue_wait_ms = 2500;
        state.request_pool.set_settings(pool);
        *state.request_pool.root.lock().unwrap() = Some(directory.clone());
    }

    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let started = std::time::Instant::now();
    // 5 concurrent requests across 4 parallel slots (2 accounts x 2 concurrency):
    // first 4 run concurrently (~250ms), 5th queues and succeeds once a slot releases.
    let mut handles = Vec::new();
    for _ in 0..5 {
        let http = http.clone();
        let url = url.clone();
        handles.push(tokio::spawn(async move {
            let reply: Value = native_request(
                &http,
                &url,
                json!({"model":"acp/test-model","input":"short-wait"}),
            )
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
            reply["output"][0]["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_string()
        }));
    }
    let mut served = Vec::new();
    for handle in handles {
        served.push(handle.await.unwrap());
    }
    let elapsed = started.elapsed();
    assert_eq!(served.len(), 5);
    assert!(
        served.iter().any(|id| id == "default") && served.iter().any(|id| id == &secondary.id),
        "round-robin pool should spread load across both accounts: {served:?}"
    );
    assert!(
        elapsed < Duration::from_secs(4),
        "5 requests over 4 slots should run in parallel + queue wakeup, took {elapsed:?}"
    );
    state.agents.clear();
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn pre_output_failover_records_cooldown_and_never_replays_midstream() {
    let (app, directory) = bridge_fixture();
    prepare_profile(&directory).unwrap();
    accounts::mark_saved(&directory).unwrap();
    accounts::set_active_email(&directory, Some("primary@example.test".into())).unwrap();
    let mut backup =
        accounts::PendingAccount::new_isolated(&directory, "Backup", false).unwrap();
    let token = accounts::isolated_token(&backup.directory().unwrap());
    std::fs::create_dir_all(token.parent().unwrap()).unwrap();
    crate::write_codex_private_file(&token, b"synthetic-token").unwrap();
    backup
        .commit_replacing(Some("backup@example.test".into()), None, false)
        .unwrap();

    let (url, stop, server) = native_listener(&app, &directory).await;
    let state = app.state::<AcpState>();
    {
        let mut pool = state.request_pool.settings();
        pool.account_pool = true;
        pool.routing_strategy = RoutingStrategy::FillFirst;
        pool.max_failover_attempts = 2;
        pool.cooldown_base_secs = 60;
        pool.cooldown_max_secs = 300;
        pool.queue_wait_ms = 0;
        state.request_pool.set_settings(pool);
        *state.request_pool.root.lock().unwrap() = Some(directory.clone());
    }
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    // 1. Pre-output Quota (429) on default transparently fails over to backup (non-stream).
    let non_stream: Value = native_request(
        &http,
        &url,
        json!({"model":"acp/test-model","input":"failover-on-default"}),
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        non_stream["output"][0]["content"][0]["text"],
        format!("served-by:{}", backup.id)
    );
    let cooldowns = state.request_pool.cooldowns_by_account();
    assert!(
        cooldowns.get("default").is_some_and(|list| list
            .iter()
            .any(|c| c.model.as_deref() == Some("test-model") && c.reason == "rate_limited")),
        "default account should record per-model quota cooldown: {cooldowns:?}"
    );

    // 2. Reset cooldown, then verify streaming pre-output failover ALSO succeeds seamlessly.
    state.reset_account_health(Some("default"));
    assert!(state.request_pool.cooldowns_by_account().is_empty());
    let stream_text = native_request(
        &http,
        &url,
        json!({"model":"acp/test-model","input":"failover-on-default","stream":true}),
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .text()
    .await
    .unwrap();
    assert!(
        stream_text.contains(&format!("served-by:{}", backup.id)),
        "streaming pre-output failure should fail over transparently: {stream_text}"
    );

    // 3. Pre-output Authentication (401) marks default AuthRequired and fails over to backup.
    state.reset_account_health(Some("default"));
    let auth_failover: Value = native_request(
        &http,
        &url,
        json!({"model":"acp/test-model","input":"failover-auth-on-default"}),
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        auth_failover["output"][0]["content"][0]["text"],
        format!("served-by:{}", backup.id)
    );
    assert_eq!(
        state.snapshot().unwrap().account_runtime["default"].auth_state,
        AccountAuthState::AuthRequired
    );

    // 4. Mid-stream failure AFTER first text chunk MUST NOT replay on backup!
    state.reset_account_health(Some("default"));
    let midstream = native_request(
        &http,
        &url,
        json!({"model":"acp/test-model","input":"midstream-quota-on-default","stream":true}),
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .text()
    .await
    .unwrap();
    assert!(
        midstream.contains("partial-"),
        "first chunk should arrive: {midstream}"
    );
    assert!(
        midstream.contains("rate_limit_error"),
        "midstream should emit SSE error: {midstream}"
    );
    assert!(
        !midstream.contains("REPLAYED-BY"),
        "midstream failure must NEVER replay on another account: {midstream}"
    );

    state.agents.clear();
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn per_account_proxy_aggregated_models_and_non_blocking_account_ops() {
    let (app, directory) = bridge_fixture();
    prepare_profile(&directory).unwrap();
    accounts::mark_saved(&directory).unwrap();
    accounts::set_active_email(&directory, Some("primary@example.test".into())).unwrap();
    accounts::update_settings(
        &directory,
        "default",
        &accounts::AccountSettingsPatch {
            proxy_url: Some("direct".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let mut second =
        accounts::PendingAccount::new_isolated(&directory, "Custom Proxy", false).unwrap();
    let token = accounts::isolated_token(&second.directory().unwrap());
    std::fs::create_dir_all(token.parent().unwrap()).unwrap();
    crate::write_codex_private_file(&token, b"synthetic-token").unwrap();
    second
        .commit_replacing(Some("second@example.test".into()), None, false)
        .unwrap();
    accounts::update_settings(
        &directory,
        &second.id,
        &accounts::AccountSettingsPatch {
            proxy_url: Some("http://127.0.0.1:18888".into()),
            ..Default::default()
        },
    )
    .unwrap();

    let (url, stop, server) = native_listener(&app, &directory).await;
    // Set global proxy to verify `direct` vs per-account override.
    let mut gui_cfg = app.state::<crate::GuiConfigState>().snapshot().unwrap();
    gui_cfg.proxy_url = "http://127.0.0.1:19999".into();
    app.state::<crate::GuiConfigState>()
        .replace_external(gui_cfg)
        .unwrap();
    let base = url.trim_end_matches("/responses").to_string();
    let state = app.state::<AcpState>();
    {
        let mut status = state.status.lock().unwrap();
        status.accounts = accounts::read(&directory).unwrap().accounts;
    }
    state.record_account_verified(
        &second.id,
        vec![
            AcpModel {
                id: "test-model".into(),
                name: "Test model".into(),
                reasoning_levels: Vec::new(),
                reasoning_variants: BTreeMap::new(),
            },
            AcpModel {
                id: "pool-exclusive-model".into(),
                name: "Pool Exclusive".into(),
                reasoning_levels: Vec::new(),
                reasoning_variants: BTreeMap::new(),
            },
        ],
    );
    {
        let mut pool = state.request_pool.settings();
        pool.account_pool = true;
        pool.routing_strategy = RoutingStrategy::FillFirst;
        pool.queue_wait_ms = 0;
        state.request_pool.set_settings(pool);
        *state.request_pool.root.lock().unwrap() = Some(directory.clone());
    }

    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    // 1. /v1/models aggregates models from all enabled verified pool accounts.
    let models_reply: Value = http
        .get(format!("{base}/models"))
        .bearer_auth("internal-test-key")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let advertised: Vec<&str> = models_reply["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    assert!(advertised.contains(&"acp/test-model"), "{advertised:?}");
    assert!(
        advertised.contains(&"acp/pool-exclusive-model"),
        "{advertised:?}"
    );

    // 2. Per-account proxy propagation (`direct` on default -> empty proxy; custom proxy on second).
    let primary_proxy: Value = native_request(
        &http,
        &url,
        json!({"model":"acp/test-model","input":"proxy-echo"}),
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        primary_proxy["output"][0]["content"][0]["text"],
        "account=default;proxy="
    );

    // Start a blocking request on default so second serves next request AND we test non-blocking ops.
    let mut blocking = native_request(
        &http,
        &url,
        json!({"model":"acp/test-model","input":"wait","stream":true}),
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap();
    assert!(blocking.chunk().await.unwrap().is_some());

    let second_proxy: Value = native_request(
        &http,
        &url,
        json!({"model":"acp/test-model","input":"proxy-echo"}),
    )
    .send()
    .await
    .unwrap()
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        second_proxy["output"][0]["content"][0]["text"],
        format!("account={};proxy=http://127.0.0.1:18888", second.id)
    );

    // 3. While default is serving an active API request:
    // - Mutating busy default is safely rejected.
    assert!(remove_account_local(state.inner(), &directory, "default").is_err());
    // - Updating or removing idle second account succeeds without blocking or killing default's request!
    accounts::update_settings(
        &directory,
        &second.id,
        &accounts::AccountSettingsPatch {
            weight: Some(4),
            ..Default::default()
        },
    )
    .unwrap();
    remove_account_local(state.inner(), &directory, &second.id).unwrap();
    assert_eq!(
        state.request_pool.active_for("default"),
        1,
        "removing idle secondary account must not cancel active primary request"
    );

    drop(blocking);
    tokio::time::timeout(Duration::from_secs(4), async {
        while state.request_pool.active_count() > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    state.agents.clear();
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
