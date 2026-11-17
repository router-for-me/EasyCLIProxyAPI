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
        assert_eq!(
            groups[1]["models"][0]["alias"].as_str(),
            Some("acp/test-model")
        );
        assert_eq!(
            groups[1]["models"][0],
            serde_norway::to_value(json!({"name":"test-model","alias":"acp/test-model"})).unwrap()
        );
        assert!(groups[1]["models"]
            .as_sequence()
            .unwrap()
            .iter()
            .all(|model| model.get("thinking").is_none()));
        assert!(groups[1]
            .get(if v8 { "keys" } else { "api-key-entries" })
            .is_some());
        patch_provider(&mut document, None).unwrap();
        assert_eq!(document, original);
    }
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
fn single_user_message_is_passed_through_unchanged() {
    let completion = parse_completion(&request(false), &models()).unwrap();
    assert_eq!(completion.text, "ping");
    let mut value = request(false);
    value["messages"] =
        json!([{"role":"user","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}]);
    assert_eq!(parse_completion(&value, &models()).unwrap().text, "ab");
}

#[test]
fn client_generation_options_are_validated_and_reported_as_unapplied() {
    let mut value = request(false);
    value["max_tokens"] = json!(1024);
    value["max_completion_tokens"] = json!(2048);
    value["temperature"] = json!(0.7);
    value["top_p"] = json!(1);
    let parsed = parse_completion(&value, &models()).unwrap();
    assert_eq!(parsed.text, "ping");
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
        assert_eq!(parsed.text, "ping");
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
    assert_eq!(request.text, "verify-system");
    assert_eq!(request.system, "be brief\n\nuse plain language");
    let cancel = Arc::new(AtomicBool::new(false));
    let mut client = spawn_fake(Path::new("unused"), Path::new("unused"), "").unwrap();
    let mut chunks = String::new();
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
    let output = complete(&mut client, &profile, &request, &cancel, |_| {}).unwrap();
    assert!(
        output.contains(&marker),
        "Official system instructions were not applied"
    );
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
    assert_eq!(completion.text, "hello");
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
        parse_completion(&value, &models()).unwrap().text,
        "User: hi\n\nAssistant: hello\n\nUser: again"
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
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let result = match value["method"].as_str().unwrap_or("") {
            "initialize" => {
                json!({"protocolVersion":1,"agentCapabilities":{"auth":{"logout":{}},"_meta":{"antigravity":{"systemPrompt":{"append":true}}}}})
            }
            "session/new" => {
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
            "logout" => json!({}),
            "session/prompt" => {
                assert!(
                    !selected.is_empty(),
                    "explicit model selection must precede inference"
                );
                if value["params"]["prompt"][0]["text"] == "use-client-tool" {
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
                    .unwrap()
                    .strip_prefix("expect:")
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

fn spawn_fake(_: &Path, _: &Path, _: &str) -> Result<rpc::Client, String> {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "acp::bridge::tests::fake_official_server",
            "--nocapture",
        ])
        .env("ECPA_ACP_BRIDGE_TEST_HELPER", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
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
    drop(discovery);
    let mut value = json!({"model":"acp/gemini-3.8-flash-high","messages":[{"role":"user","content":"Call lookup with key alpha. Wait for its returned secret and reply with the secret. Do not guess."}],"tools":[{"type":"function","function":{"name":"lookup","description":"Look up a secret. The API client executes this.","parameters":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}}}]});
    let request = parse_completion(&value, &models).unwrap();
    let identity = json!({"test":"native"});
    let sessions = super::super::agent::Sessions::default();
    let session = sessions
        .start(
            &request,
            identity.clone(),
            &executable,
            &profile,
            "",
            rpc::Client::spawn,
        )
        .unwrap();
    let output = sessions
        .collect(&session, &request, &cancel, |_| {})
        .unwrap();
    assert!(
        !output.calls.is_empty(),
        "Official Agent did not call provided tool; text: {}",
        output.text
    );
    assert_eq!(output.calls[0]["function"]["name"], "lookup");
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
    let session = sessions.resume(&request, &identity).unwrap().unwrap();
    let output = sessions
        .collect(&session, &request, &cancel, |_| {})
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
    for stream in [false, true] {
        let mut payload = request(stream);
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
            assert!(
                body.contains("ACP_")
                    && body.contains("OK")
                    && body.contains("[DONE]")
                    && body.contains("finish_reason")
            );
        } else {
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["choices"][0]["message"]["content"], "ACP_OK");
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
        while app.state::<AcpState>().snapshot().unwrap().busy {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("client disconnect must cancel and release the operation");
    stop.cancel();
    server.await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
#[ignore = "requires ECPA_ACP_TEST_CORE pointing to a CPA v8 executable; starts an isolated kernel"]
async fn real_cpa_lists_and_routes_registered_acp_models() {
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
        status.executable = Some("fake-official-cli".into());
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
        spawn_fake,
    ));
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut document: serde_norway::Value = serde_norway::to_value(json!({
        "config-version":8,"server":{"host":"127.0.0.1","port":port},
        "management":{"disable-control-panel":true,"disable-auto-update-panel":true},
        "auth":{"dir":directory.join("auth")},"access":{"api-keys":["isolated-client-key"]},
        "logging":{"to-file":false},"requests":{"retry":0}
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
            for stream in [false, true] {
                let (path, payload) = if responses {
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
                    } else if !body.contains("[DONE]") || !body.contains("ACP_") {
                        return Err(format!("Incomplete CPA Chat SSE: {body}"));
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
            for stream in [false, true] {
                let messages = json!([{"role":"user","content":"use-client-tool"}]);
                let function = json!({"name":"lookup","description":"Look up a value","parameters":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}});
                let (path, mut first) = if responses {
                    let mut tool = function.clone(); tool["type"] = json!("function");
                    ("responses",json!({"model":"acp/test-model","input":messages,"tools":[tool],"stream":false,"store":false}))
                } else {
                    ("chat/completions",json!({"model":"acp/test-model","messages":messages,"tools":[{"type":"function","function":function}],"stream":false}))
                };
                let reply = http.post(format!("{base}/v1/{path}")).bearer_auth("isolated-client-key").json(&first).send().await.map_err(|e|e.to_string())?;
                let status = reply.status(); let body: Value = reply.json().await.map_err(|e|e.to_string())?;
                if !status.is_success() { return Err(format!("Tool start {path}: {status}: {body}")); }
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
            }
        }
        patch_provider(&mut document, None)?;
        std::fs::write(&config, serde_norway::to_string(&document).unwrap())
            .map_err(|e| e.to_string())?;
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
