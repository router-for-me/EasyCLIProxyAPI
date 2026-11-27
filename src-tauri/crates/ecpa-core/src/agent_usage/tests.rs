use super::*;
use chrono::TimeZone;
use serde_json::json;
use std::fs::File;
use std::io::Write;

fn test_directory(name: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/test-tmp")
        .join(format!("cpa-agent-usage-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn local_timestamp(year: i32, month: u32, day: u32, hour: u32) -> String {
    Local
        .with_ymd_and_hms(year, month, day, hour, 0, 0)
        .unwrap()
        .to_rfc3339()
}

fn local_ms(year: i32, month: u32, day: u32, hour: u32) -> i64 {
    Local
        .with_ymd_and_hms(year, month, day, hour, 0, 0)
        .unwrap()
        .timestamp_millis()
}

fn delta_total(delta: &FileDelta) -> UsageCounter {
    let mut total = UsageCounter::default();
    for counter in delta.daily.values() {
        add_counter(&mut total, counter);
    }
    total
}

fn zstd_frame(bytes: &[u8]) -> Vec<u8> {
    zstd::stream::encode_all(bytes, 1).unwrap()
}

fn pb_varint(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if value == 0 {
            return bytes;
        }
    }
}

fn pb_len(field: u64, payload: &[u8]) -> Vec<u8> {
    let mut bytes = pb_varint((field << 3) | 2);
    bytes.extend(pb_varint(payload.len() as u64));
    bytes.extend_from_slice(payload);
    bytes
}

fn pb_u64(field: u64, value: u64) -> Vec<u8> {
    let mut bytes = pb_varint(field << 3);
    bytes.extend(pb_varint(value));
    bytes
}

fn pb_map_entry(key: &str, value: &str) -> Vec<u8> {
    let mut bytes = pb_len(1, key.as_bytes());
    bytes.extend(pb_len(2, value.as_bytes()));
    bytes
}

fn antigravity_gen_meta(model: &str, tiered: Option<&str>, step: Option<u64>) -> Vec<u8> {
    let mut inner = pb_len(19, model.as_bytes());
    if let Some(tiered) = tiered {
        inner.extend(pb_len(21, tiered.as_bytes()));
    }
    if let Some(step) = step {
        inner.extend(pb_len(
            20,
            &pb_map_entry("last_step_index", &step.to_string()),
        ));
    }
    pb_len(1, &inner)
}

fn antigravity_step_meta(gen_index: u64) -> Vec<u8> {
    let gen_ref = if gen_index == 0 {
        Vec::new()
    } else {
        pb_u64(3, gen_index)
    };
    pb_len(20, &gen_ref)
}

// ---------------------------------------------------------------------------
// Codex tests
// ---------------------------------------------------------------------------

#[test]
fn codex_deduplicates_rate_limit_reemissions_and_subtracts_cache_write() {
    let home = test_directory("codex-dedup");
    let path = home.join(".codex/sessions/2026/10/29/rollout-1.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let ts = local_timestamp(2026, 10, 29, 12);
    let snap = json!({
        "timestamp": ts,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "rate_limits": {"limit_id": "primary"},
            "info": {
                "total_token_usage": {"input_tokens": 1000, "cached_input_tokens": 600, "cache_write_input_tokens": 100, "output_tokens": 200, "reasoning_output_tokens": 50},
                "last_token_usage": {"input_tokens": 1000, "cached_input_tokens": 600, "cache_write_input_tokens": 100, "output_tokens": 200, "reasoning_output_tokens": 50}
            }
        }
    });
    let dup_other_lane = json!({
        "timestamp": ts,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "rate_limits": {"limit_id": "secondary"},
            "info": {
                "total_token_usage": {"input_tokens": 1000, "cached_input_tokens": 600, "cache_write_input_tokens": 100, "output_tokens": 200, "reasoning_output_tokens": 50},
                "last_token_usage": {"input_tokens": 1000, "cached_input_tokens": 600, "cache_write_input_tokens": 100, "output_tokens": 200, "reasoning_output_tokens": 50}
            }
        }
    });
    let settings = json!({
        "timestamp": ts,
        "type": "event_msg",
        "payload": {
            "type": "thread_settings_applied",
            "thread_settings": {"model": "openai/GPT-5.3-Codex-2026-08-01"}
        }
    });
    fs::write(&path, format!("{settings}\n{snap}\n{snap}\n{dup_other_lane}\n")).unwrap();

    let mut delta = FileDelta::default();
    read_usage_file(&path, "codex", &mut delta).unwrap();
    let total = delta_total(&delta);
    assert_eq!(total.samples, 1);
    assert_eq!(total.input_tokens, 300);
    assert_eq!(total.cache_read_tokens, 600);
    assert_eq!(total.cache_creation_tokens, 100);
    assert_eq!(total.output_tokens, 200);
    assert_eq!(total.reasoning_tokens, 50);
    assert_eq!(total.total_tokens, 1200);
    assert!(delta
        .daily
        .contains_key(&("2026-10-29".to_string(), "gpt-5.3-codex".to_string())));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn codex_strips_forked_parent_replay_and_recovers_token_usage_record() {
    let home = test_directory("codex-fork");
    let dir = home.join(".codex/sessions/2026/10/29");
    fs::create_dir_all(&dir).unwrap();
    let ts = local_timestamp(2026, 10, 29, 12);

    let parent_path = dir.join("rollout-parent.jsonl");
    let child_path = dir.join("rollout-child.jsonl");

    let parent_meta = json!({"type": "session_meta", "payload": {"id": "thread-parent"}});
    let child_meta = json!({"type": "session_meta", "payload": {"id": "thread-child", "forked_from_id": "thread-parent"}});
    let turn_ctx = json!({"type": "turn_context", "payload": {"info": {"model": "gpt-5.4"}}});
    let ev1 = json!({
        "timestamp": ts,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {"input_tokens": 500, "cached_input_tokens": 100, "output_tokens": 50},
                "last_token_usage": {"input_tokens": 500, "cached_input_tokens": 100, "output_tokens": 50}
            }
        }
    });
    let compaction_rec = json!({
        "timestamp": ts,
        "type": "event_msg",
        "payload": {
            "type": "token_usage_record",
            "token_usage": {"input_tokens": 200, "cached_input_tokens": 50, "output_tokens": 30}
        }
    });
    let zero_after_compaction = json!({
        "timestamp": ts,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {"input_tokens": 700, "cached_input_tokens": 150, "output_tokens": 80},
                "last_token_usage": {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
            }
        }
    });

    fs::write(&parent_path, format!("{parent_meta}\n{turn_ctx}\n{ev1}\n")).unwrap();
    fs::write(
        &child_path,
        format!("{child_meta}\n{turn_ctx}\n{ev1}\n{compaction_rec}\n{zero_after_compaction}\n"),
    )
    .unwrap();

    let all = vec![parent_path.clone(), child_path.clone()];
    let mut ctx = build_source_context("codex", &all, true);
    let mut child_delta = FileDelta::default();
    read_usage_file_with_context(&child_path, "codex", &mut ctx, &mut child_delta).unwrap();
    let total = delta_total(&child_delta);
    // Replayed ev1 (550) is stripped; only the post-fork compacted turn (150 fresh + 50 cached + 30 output = 230) remains.
    assert_eq!(total.samples, 1);
    assert_eq!(total.input_tokens, 150);
    assert_eq!(total.cache_read_tokens, 50);
    assert_eq!(total.output_tokens, 30);
    assert_eq!(total.total_tokens, 230);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn codex_reads_zst_rollouts_and_deduplicates_jsonl_sibling() {
    let home = test_directory("codex-zst");
    let dir = home.join(".codex/sessions/2026/10/29");
    fs::create_dir_all(&dir).unwrap();
    let ts = local_timestamp(2026, 10, 29, 12);
    let line = format!(
        "{}\n",
        json!({
            "timestamp": ts,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {"input_tokens": 200, "cached_input_tokens": 40, "output_tokens": 25}
                }
            }
        })
    );
    // Compressed-only rollout
    let zst_only = dir.join("rollout-old.jsonl.zst");
    fs::write(&zst_only, zstd_frame(line.as_bytes())).unwrap();
    // Sibling pair (.jsonl + .jsonl.zst)
    let plain = dir.join("rollout-both.jsonl");
    let zst_dup = dir.join("rollout-both.jsonl.zst");
    fs::write(&plain, &line).unwrap();
    fs::write(&zst_dup, zstd_frame(line.as_bytes())).unwrap();

    let files = source_files(&home, "codex");
    assert_eq!(files.len(), 2);
    assert!(files.contains(&zst_only));
    assert!(files.contains(&plain));
    assert!(!files.contains(&zst_dup));
    assert_eq!(
        logical_file_key("codex", &zst_only),
        "codex:rollout-old.jsonl"
    );

    let mut delta = FileDelta::default();
    read_usage_file(&zst_only, "codex", &mut delta).unwrap();
    let total = delta_total(&delta);
    assert_eq!(total.input_tokens, 160);
    assert_eq!(total.cache_read_tokens, 40);
    assert_eq!(total.output_tokens, 25);
    assert_eq!(total.total_tokens, 225);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn codex_prefers_last_token_usage_without_subagent_history_inflation() {
    let (counter, _) = codex::extract_single_token_count(&json!({
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {
                    "input_tokens": 800000000,
                    "output_tokens": 1000000,
                    "cached_input_tokens": 700000000,
                    "total_tokens": 801000000
                },
                "last_token_usage": {
                    "input_tokens": 500,
                    "output_tokens": 50,
                    "cached_input_tokens": 100,
                    "total_tokens": 550
                }
            }
        }
    }))
    .unwrap();
    assert_eq!(counter.input_tokens, 400);
    assert_eq!(counter.output_tokens, 50);
    assert_eq!(counter.cache_read_tokens, 100);
    assert_eq!(counter.total_tokens, 550);
}

#[test]
fn codex_uuid_named_fork_dedups_with_present_parent_and_survives_pruned_parent() {
    let home = test_directory("codex-uuid-fork");
    let dir = home.join(".codex/sessions/2026/10/29");
    fs::create_dir_all(&dir).unwrap();
    let ts = local_timestamp(2026, 10, 29, 12);

    let parent_id = "019a0000-0000-7000-8000-000000000001";
    let child_id = "019a0000-0000-7000-8000-000000000002";
    let orphan_id = "019a0000-0000-7000-8000-000000000003";
    let missing_parent_id = "019a0000-0000-7000-8000-000000000099";

    let parent_path = dir.join(format!("rollout-2026-10-29T12-00-00-{parent_id}.jsonl"));
    let child_path = dir.join(format!("rollout-2026-10-29T12-05-00-{child_id}.jsonl"));
    let orphan_path = dir.join(format!("rollout-2026-10-29T12-10-00-{orphan_id}.jsonl"));

    let turn_ctx = json!({"timestamp": ts, "type": "turn_context", "payload": {"model": "gpt-5.4"}});
    let ev1 = json!({
        "timestamp": ts,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {"input_tokens": 500, "cached_input_tokens": 100, "output_tokens": 50},
                "last_token_usage": {"input_tokens": 500, "cached_input_tokens": 100, "output_tokens": 50}
            }
        }
    });
    let ev2 = json!({
        "timestamp": ts,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {"input_tokens": 800, "cached_input_tokens": 200, "output_tokens": 90},
                "last_token_usage": {"input_tokens": 300, "cached_input_tokens": 100, "output_tokens": 40}
            }
        }
    });

    fs::write(
        &parent_path,
        format!(
            "{}\n{turn_ctx}\n{ev1}\n",
            json!({"timestamp": ts, "type": "session_meta", "payload": {"id": parent_id}})
        ),
    )
    .unwrap();
    fs::write(
        &child_path,
        format!(
            "{}\n{turn_ctx}\n{ev1}\n{ev2}\n",
            json!({"timestamp": ts, "type": "session_meta", "payload": {"id": child_id, "forked_from_id": parent_id}})
        ),
    )
    .unwrap();
    fs::write(
        &orphan_path,
        format!(
            "{}\n{turn_ctx}\n{ev2}\n",
            json!({"timestamp": ts, "type": "session_meta", "payload": {"id": orphan_id, "forked_from_id": missing_parent_id}})
        ),
    )
    .unwrap();

    let all = vec![parent_path.clone(), child_path.clone(), orphan_path.clone()];
    let mut ctx = build_source_context("codex", &all, true);

    let mut parent_delta = FileDelta::default();
    read_usage_file_with_context(&parent_path, "codex", &mut ctx, &mut parent_delta).unwrap();
    assert_eq!(delta_total(&parent_delta).total_tokens, 550);

    let mut child_delta = FileDelta::default();
    read_usage_file_with_context(&child_path, "codex", &mut ctx, &mut child_delta).unwrap();
    assert_eq!(delta_total(&child_delta).samples, 1);
    assert_eq!(delta_total(&child_delta).total_tokens, 340);

    let mut orphan_delta = FileDelta::default();
    read_usage_file_with_context(&orphan_path, "codex", &mut ctx, &mut orphan_delta).unwrap();
    assert_eq!(delta_total(&orphan_delta).samples, 1);
    assert_eq!(delta_total(&orphan_delta).total_tokens, 340);

    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// Claude Code tests
// ---------------------------------------------------------------------------

#[test]
fn claude_filters_assistant_dedups_by_stop_reason_and_extracts_1h_cache() {
    let home = test_directory("claude");
    let path = home.join(".claude/projects/proj/session.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let ts = local_timestamp(2026, 10, 29, 12);

    let lines = [
        // Non-assistant line with usage should be ignored
        json!({"type": "progress", "timestamp": ts, "message": {"id": "m0", "model": "claude-opus-4-6", "usage": {"input_tokens": 999, "output_tokens": 999}}}),
        // Streaming partial line without stop_reason (larger output shouldn't beat final with stop_reason)
        json!({"type": "assistant", "timestamp": ts, "message": {"id": "m1", "model": "claude-opus-4-6", "stop_reason": null, "usage": {"input_tokens": 100, "output_tokens": 5}}}),
        // Final line with stop_reason and 1h cache write
        json!({"type": "assistant", "timestamp": ts, "message": {"id": "m1", "model": "claude-opus-4-6", "stop_reason": "end_turn", "usage": {
            "input_tokens": 100,
            "output_tokens": 40,
            "cache_read_input_tokens": 500,
            "cache_creation_input_tokens": 1000,
            "cache_creation": {"ephemeral_5m_input_tokens": 400, "ephemeral_1h_input_tokens": 600}
        }}}),
        // Subagent line without stop_reason but non-zero tokens must still be counted
        json!({"type": "assistant", "timestamp": ts, "message": {"id": "m2", "model": "claude-haiku-4-5", "stop_reason": null, "usage": {"input_tokens": 20, "output_tokens": 10}}}),
    ];
    let content = lines
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, format!("{content}\n")).unwrap();

    let mut delta = FileDelta::default();
    read_usage_file(&path, "claude", &mut delta).unwrap();
    let opus = delta
        .daily
        .get(&("2026-10-29".to_string(), "claude-opus-4-6".to_string()))
        .unwrap();
    assert_eq!(opus.samples, 1);
    assert_eq!(opus.input_tokens, 100);
    assert_eq!(opus.output_tokens, 40);
    assert_eq!(opus.cache_read_tokens, 500);
    assert_eq!(opus.cache_creation_tokens, 1000);
    assert_eq!(opus.cache_creation_1h_tokens, 600);
    assert_eq!(opus.total_tokens, 1640);

    let haiku = delta
        .daily
        .get(&("2026-10-29".to_string(), "claude-haiku-4-5".to_string()))
        .unwrap();
    assert_eq!(haiku.total_tokens, 30);
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// Antigravity tests
// ---------------------------------------------------------------------------

#[test]
fn antigravity_filters_done_planner_responses_and_resolves_steps_native_db() {
    let home = test_directory("agy-native");
    let session = "11111111-1111-1111-1111-111111111111";
    let transcript = home
        .join(".gemini/antigravity/brain")
        .join(session)
        .join(".system_generated/logs/transcript.jsonl");
    fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    let ts = local_timestamp(2026, 11, 17, 3);

    let lines = [
        // User switches to Orchestrator (Carbon)
        json!({"step_index": 0, "type": "USER_INPUT", "source": "USER_EXPLICIT", "created_at": ts, "content": "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon). No need to comment.\n</USER_SETTINGS_CHANGE>"}),
        // Intermediate RUNNING snapshot for step 1 (must be replaced by DONE)
        json!({"step_index": 1, "type": "PLANNER_RESPONSE", "status": "RUNNING", "created_at": ts, "input_tokens": 50, "output_tokens": 5}),
        // Completed step 1 (planner -> gemini-pro-orchestrator => gemini-4-carbon)
        json!({"step_index": 1, "type": "PLANNER_RESPONSE", "status": "DONE", "created_at": ts, "input_tokens": 100, "output_tokens": 20}),
        // Non-planner CHECKPOINT must be ignored
        json!({"step_index": 2, "type": "CHECKPOINT", "status": "DONE", "created_at": ts, "input_tokens": 999, "output_tokens": 999}),
        // Completed step 3 (worker -> gemini-flash-worker-agy => gemini-4-hydrogen)
        json!({"step_index": 3, "type": "PLANNER_RESPONSE", "status": "DONE", "model": "gemini-flash-worker-agy", "created_at": ts, "input_tokens": 200, "output_tokens": 30}),
    ];
    fs::write(
        &transcript,
        lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();

    // Write native conversations/<id>.db with steps + gen_metadata tables
    let conv_dir = home.join(".gemini/antigravity/conversations");
    fs::create_dir_all(&conv_dir).unwrap();
    let db = Connection::open(conv_dir.join(format!("{session}.db"))).unwrap();
    db.execute_batch(
        "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
         CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);",
    )
    .unwrap();
    db.execute(
        "INSERT INTO steps VALUES (1, 15, ?1)",
        [antigravity_step_meta(0)],
    )
    .unwrap();
    db.execute(
        "INSERT INTO steps VALUES (3, 15, ?1)",
        [antigravity_step_meta(1)],
    )
    .unwrap();
    db.execute(
        "INSERT INTO gen_metadata VALUES (0, ?1)",
        [antigravity_gen_meta("gemini-pro-orchestrator", Some("Orchestrator (Carbon)"), None)],
    )
    .unwrap();
    db.execute(
        "INSERT INTO gen_metadata VALUES (1, ?1)",
        [antigravity_gen_meta("gemini-flash-worker-agy", Some("gemini-4-hydrogen-high"), None)],
    )
    .unwrap();
    drop(db);

    let mut delta = FileDelta::default();
    read_usage_file(&transcript, "antigravity", &mut delta).unwrap();
    let carbon = delta
        .daily
        .get(&("2026-11-17".to_string(), "gemini-4-carbon".to_string()))
        .unwrap();
    assert_eq!(carbon.input_tokens, 100);
    assert_eq!(carbon.output_tokens, 20);
    assert_eq!(carbon.samples, 1);

    let hydrogen = delta
        .daily
        .get(&("2026-11-17".to_string(), "gemini-4-hydrogen-high".to_string()))
        .unwrap();
    assert_eq!(hydrogen.input_tokens, 200);
    assert_eq!(hydrogen.output_tokens, 30);
    assert_eq!(hydrogen.samples, 1);
    assert_eq!(delta_total(&delta).total_tokens, 350);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn antigravity_discovers_acp_and_converts_display_labels() {
    assert_eq!(
        antigravity::model_id_of("Gemini 4 Neon (XHigh)"),
        "gemini-4-neon-xhigh"
    );
    assert_eq!(
        antigravity::model_id_of("Gemini 3.8 Flash (Dynamic)"),
        "gemini-3.8-flash-tiered"
    );
    assert_eq!(
        antigravity::model_id_of("Claude Sonnet 5.5 (Max)"),
        "claude-sonnet-5-5-max"
    );
    assert!(antigravity::parse_model_label("Unknown Model").is_none());

    let home = test_directory("agy-acp");
    let acp_transcript = home.join(
        ".gemini/antigravity-acp/brain/sess-acp/.system_generated/logs/transcript.jsonl",
    );
    fs::create_dir_all(acp_transcript.parent().unwrap()).unwrap();
    fs::write(&acp_transcript, "{}\n").unwrap();
    let files = source_files(&home, "antigravity");
    assert!(files.contains(&acp_transcript));
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// OpenCode tests
// ---------------------------------------------------------------------------

#[test]
fn opencode_merges_v1_v2_skips_incomplete_adds_reasoning_and_keeps_cost() {
    let home = test_directory("opencode");
    let db_path = home.join(".local/share/opencode/opencode.db");
    fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE message (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER, data TEXT);
         CREATE TABLE session_message (id TEXT PRIMARY KEY, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
    )
    .unwrap();
    let ts = local_ms(2026, 10, 29, 12);

    // V1 completed assistant (duplicate id 'm1', older than V2)
    conn.execute(
        "INSERT INTO message VALUES ('m1', ?1, ?2, ?3)",
        rusqlite::params![
            ts,
            ts + 100,
            json!({
                "role": "assistant",
                "modelID": "claude-sonnet-4-6",
                "time": {"created": ts, "completed": ts + 100},
                "tokens": {"input": 100, "output": 20, "reasoning": 0, "cache": {"read": 0, "write": 0}},
                "cost": 0.01
            })
            .to_string()
        ],
    )
    .unwrap();
    // V2 version of 'm1' with higher time_updated + reasoning + native cost
    conn.execute(
        "INSERT INTO session_message VALUES ('m1', 'assistant', ?1, ?2, ?3)",
        rusqlite::params![
            ts,
            ts + 200,
            json!({
                "modelID": "claude-sonnet-4-6",
                "time": {"created": ts, "completed": ts + 200},
                "tokens": {"input": 100, "output": 30, "reasoning": 15, "cache": {"read": 50, "write": 10}},
                "cost": 0.025
            })
            .to_string()
        ],
    )
    .unwrap();
    // V2 incomplete assistant (no time.completed -> must skip)
    conn.execute(
        "INSERT INTO session_message VALUES ('m2', 'assistant', ?1, ?2, ?3)",
        rusqlite::params![
            ts,
            ts + 200,
            json!({
                "modelID": "claude-sonnet-4-6",
                "time": {"created": ts},
                "tokens": {"input": 999, "output": 999}
            })
            .to_string()
        ],
    )
    .unwrap();
    // V2 completed compaction
    conn.execute(
        "INSERT INTO session_message VALUES ('m3', 'compaction', ?1, ?2, ?3)",
        rusqlite::params![
            ts,
            ts + 300,
            json!({
                "status": "completed",
                "modelID": "claude-haiku-4-5",
                "time": {"created": ts, "completed": ts + 300},
                "tokens": {"input": 40, "output": 10, "reasoning": 0, "cache": {"read": 0, "write": 0}},
                "cost": 0.002
            })
            .to_string()
        ],
    )
    .unwrap();
    drop(conn);

    let mut delta = FileDelta::default();
    read_usage_file(&db_path, "opencode", &mut delta).unwrap();
    let sonnet = delta
        .daily
        .get(&("2026-10-29".to_string(), "claude-sonnet-4-6".to_string()))
        .unwrap();
    assert_eq!(sonnet.samples, 1);
    assert_eq!(sonnet.input_tokens, 100);
    assert_eq!(sonnet.output_tokens, 45); // 30 output + 15 reasoning
    assert_eq!(sonnet.reasoning_tokens, 15);
    assert_eq!(sonnet.cache_read_tokens, 50);
    assert_eq!(sonnet.cache_creation_tokens, 10);
    assert_eq!(sonnet.total_tokens, 205);
    assert!((sonnet.reported_cost_usd - 0.025).abs() < 1e-9);
    assert_eq!(sonnet.reported_samples, 1);

    let haiku = delta
        .daily
        .get(&("2026-10-29".to_string(), "claude-haiku-4-5".to_string()))
        .unwrap();
    assert_eq!(haiku.total_tokens, 50);
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// MCode tests
// ---------------------------------------------------------------------------

#[test]
fn mcode_reads_runtime_sqlite_and_recovers_missing_model_from_pi_history() {
    let home = test_directory("mcode");
    let db_path = home.join(".minimax/v2/sqlite/runtime-state.sqlite");
    fs::create_dir_all(db_path.parent().unwrap()).unwrap();
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE local_runtime_token_usage (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL,
            model TEXT,
            ts INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            reasoning_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            cache_write_tokens INTEGER NOT NULL,
            cost_usd REAL
         );
         CREATE TABLE local_runtime_pi_history_rows (
            session_id TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            role TEXT NOT NULL,
            data_json TEXT NOT NULL
         );",
    )
    .unwrap();
    let ts = local_ms(2026, 10, 29, 14);
    conn.execute(
        "INSERT INTO local_runtime_token_usage VALUES (1, 's1', 'minimax/MiniMax-M2.7', ?1, 100, 40, 10, 20, 5, 0.012)",
        [ts],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO local_runtime_token_usage VALUES (2, 's1', NULL, ?1, 60, 20, 0, 10, 0, NULL)",
        [ts + 1000],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO local_runtime_pi_history_rows VALUES ('s1', ?1, 'assistant', ?2)",
        rusqlite::params![ts + 1000, json!({"model": "provider/minimax-m3"}).to_string()],
    )
    .unwrap();
    drop(conn);

    let files = source_files(&home, "mcode");
    assert!(files.contains(&db_path));

    let mut delta = FileDelta::default();
    read_usage_file(&db_path, "mcode", &mut delta).unwrap();
    let m27 = delta
        .daily
        .get(&("2026-10-29".to_string(), "MiniMax-M2.7".to_string()))
        .unwrap();
    assert_eq!(m27.input_tokens, 100);
    assert_eq!(m27.output_tokens, 50); // 40 + 10 reasoning
    assert_eq!(m27.total_tokens, 175);
    assert!((m27.reported_cost_usd - 0.012).abs() < 1e-9);

    let m3 = delta
        .daily
        .get(&("2026-10-29".to_string(), "minimax-m3".to_string()))
        .unwrap();
    assert_eq!(m3.total_tokens, 90);
    assert_eq!(m3.reported_samples, 0);
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// Copilot CLI tests
// ---------------------------------------------------------------------------

#[test]
fn copilot_parses_usage_record_token_details_and_deduplicates_events() {
    let home = test_directory("copilot");
    let path = home.join(".copilot/session-state/sess-1/events.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let ts = local_timestamp(2026, 10, 29, 12);

    let usage_event = json!({
        "id": "ev-1",
        "type": "session.usage_record",
        "timestamp": ts,
        "data": {
            "usage": {
                "model": "claude-sonnet-4-6",
                "inputTokens": 1000,
                "outputTokens": 80,
                "cacheReadTokens": 700,
                "cacheWriteTokens": 100,
                "copilotUsage": {
                    "tokenDetails": [
                        {"tokenType": "input", "tokenCount": 200},
                        {"tokenType": "cache_read", "tokenCount": 700},
                        {"tokenType": "cache_write", "tokenCount": 100},
                        {"tokenType": "output", "tokenCount": 80}
                    ]
                }
            }
        }
    });
    // Fallback without tokenDetails (must subtract cacheRead + cacheWrite from inputTokens)
    let fallback_event = json!({
        "type": "session.usage_record",
        "timestamp": ts,
        "data": {
            "usage": {
                "model": "gpt-5.4",
                "inputTokens": 500,
                "outputTokens": 50,
                "cacheReadTokens": 300,
                "cacheWriteTokens": 50,
                "accounting": {"sequence": 2}
            }
        }
    });
    // Non-usage event must be ignored
    let msg_event = json!({
        "id": "ev-3",
        "type": "assistant.message",
        "timestamp": ts,
        "data": {"usage": {"inputTokens": 9999, "outputTokens": 9999}}
    });

    fs::write(
        &path,
        format!("{usage_event}\n{usage_event}\n{fallback_event}\n{fallback_event}\n{msg_event}\n"),
    )
    .unwrap();

    let mut delta = FileDelta::default();
    read_usage_file(&path, "copilot", &mut delta).unwrap();
    let sonnet = delta
        .daily
        .get(&("2026-10-29".to_string(), "claude-sonnet-4-6".to_string()))
        .unwrap();
    assert_eq!(sonnet.samples, 1);
    assert_eq!(sonnet.input_tokens, 200);
    assert_eq!(sonnet.cache_read_tokens, 700);
    assert_eq!(sonnet.cache_creation_tokens, 100);
    assert_eq!(sonnet.output_tokens, 80);
    assert_eq!(sonnet.total_tokens, 1080);

    let gpt = delta
        .daily
        .get(&("2026-10-29".to_string(), "gpt-5.4".to_string()))
        .unwrap();
    assert_eq!(gpt.samples, 1);
    assert_eq!(gpt.input_tokens, 150);
    assert_eq!(gpt.total_tokens, 550);
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// Kimi Code tests
// ---------------------------------------------------------------------------

#[test]
fn kimi_resolves_real_model_and_never_double_counts_step_end_and_projection() {
    let home = test_directory("kimi");
    let wire = home.join(".kimi/sessions/ws/sess/agents/main/wire.jsonl");
    fs::create_dir_all(wire.parent().unwrap()).unwrap();
    let req_ms = local_ms(2026, 10, 29, 10);
    let commit_ms = local_ms(2026, 10, 29, 11);

    let lines = [
        json!({"type": "context.append_loop_event", "time": req_ms, "event": {"type": "step.begin", "uuid": "s1", "turnId": "t1", "step": 1}}),
        json!({"type": "llm.request", "time": req_ms, "kind": "loop", "turnStep": "t1.1", "model": "kimi-k2.7-code"}),
        json!({"type": "usage.record", "time": req_ms + 500, "model": "kimi-k2.7-code", "usage": {"inputOther": 100, "output": 40, "inputCacheRead": 60, "inputCacheCreation": 10}}),
        json!({"type": "context.append_loop_event", "time": req_ms + 1000, "event": {"type": "step.end", "uuid": "s1", "messageId": "msg-1", "llmFirstTokenLatencyMs": 200, "llmStreamDurationMs": 800, "usage": {"inputOther": 100, "output": 40, "inputCacheRead": 60, "inputCacheCreation": 10}}}),
        // Later batch-committed human projection carrying synthetic "agent-loop" model & same messageId
        json!({"type": "agent.message.appended", "time": commit_ms, "message": {"message": {"role": "assistant"}, "meta": {"messageId": "msg-1", "model": {"provider": "agent-loop", "model": "agent-loop"}, "usage": {"inputOther": 100, "output": 40, "inputCacheRead": 60, "inputCacheCreation": 10}}}}),
    ];
    fs::write(
        &wire,
        format!(
            "{}\n",
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .unwrap();

    let mut delta = FileDelta::default();
    read_usage_file(&wire, "kimi", &mut delta).unwrap();
    let total = delta_total(&delta);
    assert_eq!(total.samples, 1);
    assert_eq!(total.input_tokens, 100);
    assert_eq!(total.output_tokens, 40);
    assert_eq!(total.cache_read_tokens, 60);
    assert_eq!(total.cache_creation_tokens, 10);
    assert_eq!(total.total_tokens, 210);
    assert!(delta
        .daily
        .contains_key(&("2026-10-29".to_string(), "kimi-k2.7-code".to_string())));
    assert!(!delta
        .daily
        .keys()
        .any(|(_, model)| model == "agent-loop"));
    // Dated by request completion (hour 10), not batch commit (hour 11)
    assert!(delta
        .hourly
        .contains_key(&("2026-10-29".to_string(), 10, "kimi-k2.7-code".to_string())));
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// Gemini CLI tests
// ---------------------------------------------------------------------------

#[test]
fn gemini_skips_json_mirror_replays_jsonl_and_normalizes_tokens() {
    let home = test_directory("gemini");
    let chats = home.join(".gemini/tmp/proj/chats");
    fs::create_dir_all(&chats).unwrap();
    let ts = local_timestamp(2026, 10, 29, 12);

    let jsonl = chats.join("session-abc.jsonl");
    let json_mirror = chats.join("session-abc.json");
    fs::write(&json_mirror, r#"{"messages":[]}"#).unwrap();
    let lines = [
        json!({"id": "1", "type": "user", "timestamp": ts, "tokens": {"input": 999}}),
        json!({"id": "2", "type": "gemini", "timestamp": ts, "model": "gemini-2.5-pro", "tokens": {"input": 1000, "output": 50, "cached": 600, "thoughts": 30}}),
        // Upsert id "2" with final counts
        json!({"id": "2", "type": "gemini", "timestamp": ts, "model": "gemini-2.5-pro", "tokens": {"input": 1000, "output": 80, "cached": 600, "thoughts": 40}}),
        json!({"id": "3", "type": "gemini", "timestamp": ts, "model": "gemini-2.5-pro", "tokens": {"input": 500, "output": 10, "cached": 0, "thoughts": 0}}),
        // Rewind discards id "3"
        json!({"$rewindTo": "2"}),
    ];
    fs::write(
        &jsonl,
        format!(
            "{}\n",
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .unwrap();

    let files = source_files(&home, "gemini");
    assert_eq!(files, vec![jsonl.clone()]);

    let mut delta = FileDelta::default();
    read_usage_file(&jsonl, "gemini", &mut delta).unwrap();
    let total = delta_total(&delta);
    assert_eq!(total.samples, 1);
    assert_eq!(total.input_tokens, 400); // 1000 - 600
    assert_eq!(total.cache_read_tokens, 600);
    assert_eq!(total.output_tokens, 120); // 80 + 40 thoughts
    assert_eq!(total.reasoning_tokens, 40);
    assert_eq!(total.total_tokens, 1120);
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// Pi & Oh My Pi tests
// ---------------------------------------------------------------------------

#[test]
fn pi_skips_known_subagent_session_files_and_counts_embedded_subagents() {
    let home = test_directory("pi-subagent");
    let sessions = home.join(".pi/agent/sessions");
    fs::create_dir_all(&sessions).unwrap();
    let ts = local_timestamp(2026, 10, 29, 12);

    let child = sessions.join("child.jsonl");
    let parent = sessions.join("parent.jsonl");
    fs::write(
        &child,
        format!(
            "{}\n{}\n",
            json!({"type": "session", "id": "child"}),
            json!({"type": "message", "timestamp": ts, "message": {"role": "assistant", "model": "claude-sonnet-4-6", "usage": {"input": 100, "output": 20, "cacheRead": 50, "cacheWrite": 10, "cost": {"total": 0.005}}}})
        ),
    )
    .unwrap();
    fs::write(
        &parent,
        format!(
            "{}\n{}\n",
            json!({"type": "session", "id": "parent"}),
            json!({
                "type": "message",
                "timestamp": ts,
                "message": {
                    "role": "toolResult",
                    "toolName": "subagent",
                    "details": {
                        "mode": "parallel",
                        "results": [
                            // Linked to `child.jsonl` -> must be skipped to prevent double-counting
                            {"sessionFile": child.to_string_lossy(), "usage": {"input": 100, "output": 20, "cacheRead": 50, "cacheWrite": 10}},
                            // Embedded without separate file -> must be counted
                            {"messages": [{"role": "assistant", "model": "gpt-5.4", "usage": {"input": 40, "output": 10, "cost": {"total": 0.002}}}]}
                        ]
                    }
                }
            })
        ),
    )
    .unwrap();

    let all = source_files(&home, "pi");
    let mut ctx = build_source_context("pi", &all, false);
    let mut parent_delta = FileDelta::default();
    read_usage_file_with_context(&parent, "pi", &mut ctx, &mut parent_delta).unwrap();
    let total = delta_total(&parent_delta);
    assert_eq!(total.samples, 1);
    assert_eq!(total.input_tokens, 40);
    assert_eq!(total.output_tokens, 10);
    assert!((total.reported_cost_usd - 0.002).abs() < 1e-9);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn omp_parses_model_usage_compaction_and_response_model() {
    let home = test_directory("omp");
    let session = home.join(".omp/profiles/work/agent/sessions/s1.jsonl");
    fs::create_dir_all(session.parent().unwrap()).unwrap();
    let ts = local_timestamp(2026, 10, 29, 12);
    let lines = [
        json!({"type": "title", "title": "test"}),
        json!({"type": "model_usage", "timestamp": ts, "model": "alias", "responseModel": "claude-opus-4-6", "usage": {"input": 50, "output": 20, "cost": {"total": 0.004}}}),
        json!({"type": "compaction", "timestamp": ts, "model": "claude-haiku-4-5", "usage": {"input": 30, "output": 5}}),
    ];
    fs::write(
        &session,
        format!(
            "{}\n",
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .unwrap();

    let files = source_files(&home, "omp");
    assert!(files.contains(&session));
    let mut delta = FileDelta::default();
    read_usage_file(&session, "omp", &mut delta).unwrap();
    let opus = delta
        .daily
        .get(&("2026-10-29".to_string(), "claude-opus-4-6".to_string()))
        .unwrap();
    assert_eq!(opus.total_tokens, 70);
    assert!((opus.reported_cost_usd - 0.004).abs() < 1e-9);
    assert_eq!(delta_total(&delta).total_tokens, 105);
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// WorkBuddy & CodeBuddy tests
// ---------------------------------------------------------------------------

#[test]
fn workbuddy_and_codebuddy_parse_raw_usage_strip_custom_prefix_and_dedup() {
    let home = test_directory("buddies");
    let ts = local_ms(2026, 10, 29, 15);

    // WorkBuddy main + subagent
    let wb_sub = home.join(".workbuddy-ai/projects/proj/s1/subagents/agent-1.jsonl");
    fs::create_dir_all(wb_sub.parent().unwrap()).unwrap();
    let wb_lines = [
        json!({"id": "u1", "timestamp": ts, "type": "message", "role": "user", "providerData": {"rawUsage": {"prompt_tokens": 999}}}),
        json!({
            "id": "a1",
            "timestamp": ts,
            "type": "message",
            "role": "assistant",
            "providerData": {
                "requestModelId": "custom-local:deepseek-v4.1-flash",
                "rawUsage": {
                    "prompt_tokens": 1000,
                    "prompt_cache_hit_tokens": 600,
                    "cache_creation_input_tokens": 100,
                    "completion_tokens": 80,
                    "completion_thinking_tokens": 20,
                    "credit": 5.0
                }
            }
        }),
    ];
    fs::write(
        &wb_sub,
        format!(
            "{}\n",
            wb_lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .unwrap();

    let wb_files = source_files(&home, "workbuddy");
    assert!(wb_files.contains(&wb_sub));
    let mut wb_delta = FileDelta::default();
    read_usage_file(&wb_sub, "workbuddy", &mut wb_delta).unwrap();
    let wb = wb_delta
        .daily
        .get(&("2026-10-29".to_string(), "deepseek-v4.1-flash".to_string()))
        .unwrap();
    assert_eq!(wb.input_tokens, 300);
    assert_eq!(wb.cache_read_tokens, 600);
    assert_eq!(wb.cache_creation_tokens, 100);
    assert_eq!(wb.output_tokens, 80);
    assert_eq!(wb.reasoning_tokens, 20);
    assert_eq!(wb.reported_cost_usd, 0.0); // credit is not USD

    // CodeBuddy function_call + fallback usage + stepSeq dedup
    let cb_file = home.join(".codebuddy/projects/proj/s2.jsonl");
    fs::create_dir_all(cb_file.parent().unwrap()).unwrap();
    let cb_rec = json!({
        "id": "c1",
        "sessionId": "s2",
        "timestamp": ts,
        "type": "function_call",
        "providerData": {
            "messageId": "m1",
            "stepSeq": 1,
            "model": "custom-proxy:glm-5.3",
            "usage": {
                "inputTokens": 400,
                "outputTokens": 50,
                "inputTokensDetails": [{"cached_tokens": 150}],
                "outputTokensDetails": [{"reasoning_tokens": 10}]
            }
        }
    });
    fs::write(&cb_file, format!("{cb_rec}\n{cb_rec}\n")).unwrap();
    let cb_files = source_files(&home, "codebuddy");
    assert!(cb_files.contains(&cb_file));
    let mut cb_delta = FileDelta::default();
    read_usage_file(&cb_file, "codebuddy", &mut cb_delta).unwrap();
    let cb = cb_delta
        .daily
        .get(&("2026-10-29".to_string(), "glm-5.3".to_string()))
        .unwrap();
    assert_eq!(cb.samples, 1);
    assert_eq!(cb.input_tokens, 250);
    assert_eq!(cb.cache_read_tokens, 150);
    assert_eq!(cb.output_tokens, 50);
    assert_eq!(cb.reasoning_tokens, 10);
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// DeepSeek Harness (DSH) tests
// ---------------------------------------------------------------------------

#[test]
fn dsh_decodes_concatenated_zstd_frames_tolerates_torn_tail_and_strips_route() {
    let home = test_directory("dsh");
    let path = home.join(".dsh/sessions/proj/sess-1/session.v4.jsonl.zstd");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let ts = local_ms(2026, 10, 29, 16);

    let frame1 = format!(
        "{}\n",
        json!({
            "type": "assistant/message",
            "time": ts,
            "data": {
                "message": {"id": "dsh-m1", "source": {"model": "global:deepseek-v4.1-flash"}},
                "usage": {"inputTokens": 200, "outputTokens": 60, "cacheReadTokens": 800, "cacheWriteTokens": 0}
            }
        })
    );
    let frame2 = format!(
        "{}\n",
        json!({
            "type": "assistant/message",
            "time": ts + 1000,
            "data": {
                "message": {"id": "dsh-m2", "source": {"model": "deepseek-flash"}},
                "usage": {"inputTokens": 100, "outputTokens": 40, "cacheReadTokens": 0, "cacheWriteTokens": 0}
            }
        })
    );
    let mut blob = zstd_frame(frame1.as_bytes());
    blob.extend(zstd_frame(frame2.as_bytes()));
    // Append torn partial zstd frame header to verify resilience during active writes.
    blob.extend_from_slice(&[0x28, 0xB5, 0x2F, 0xFD, 0x04]);
    fs::write(&path, &blob).unwrap();

    let files = source_files(&home, "dsh");
    assert_eq!(files, vec![path.clone()]);

    let mut delta = FileDelta::default();
    read_usage_file(&path, "dsh", &mut delta).unwrap();
    let total = delta_total(&delta);
    assert_eq!(total.samples, 2);
    assert_eq!(total.input_tokens, 300);
    assert_eq!(total.output_tokens, 100);
    assert_eq!(total.cache_read_tokens, 800);
    assert_eq!(total.total_tokens, 1200);
    assert!(delta
        .daily
        .contains_key(&("2026-10-29".to_string(), "deepseek-v4.1-flash".to_string())));
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// Grok Build tests
// ---------------------------------------------------------------------------

#[test]
fn grokbuild_parses_turn_completed_model_usage_and_cost_ticks() {
    let home = test_directory("grokbuild");
    let path = home.join(".grok/sessions/proj/sess-1/updates.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let ts_secs = local_ms(2026, 10, 29, 17) / 1000;

    let turn_full = json!({
        "method": "_x.ai/session/update",
        "timestamp": ts_secs,
        "params": {
            "update": {
                "sessionUpdate": "turn_completed",
                "prompt_id": "p-1",
                "usage": {
                    "costIsPartial": false,
                    "modelUsage": {
                        "grok-4.6-build": {
                            "inputTokens": 1000,
                            "outputTokens": 200,
                            "cachedReadTokens": 400,
                            "reasoningTokens": 50,
                            "costUsdTicks": 25_000_000u64
                        }
                    }
                }
            }
        }
    });
    // Partial cost turn: should NOT mark reported_cost_usd so catalog pricing is used
    let turn_partial = json!({
        "method": "_x.ai/session/update",
        "timestamp": ts_secs + 10,
        "params": {
            "update": {
                "sessionUpdate": "turn_completed",
                "prompt_id": "p-2",
                "usage": {
                    "costIsPartial": true,
                    "modelUsage": {
                        "grok-4.7-build": {
                            "inputTokens": 500,
                            "outputTokens": 100,
                            "cachedReadTokens": 100,
                            "costUsdTicks": 1_000_000u64
                        }
                    }
                }
            }
        }
    });
    // Non-turn_completed snapshot must be ignored
    let intermediate = json!({
        "method": "_x.ai/session/update",
        "timestamp": ts_secs + 20,
        "params": {
            "update": {
                "sessionUpdate": "turn_progress",
                "usage": {"inputTokens": 9999, "outputTokens": 9999}
            }
        }
    });
    fs::write(
        &path,
        format!("{turn_full}\n{turn_full}\n{turn_partial}\n{intermediate}\n"),
    )
    .unwrap();

    let files = source_files(&home, "grokbuild");
    assert_eq!(files, vec![path.clone()]);

    let mut delta = FileDelta::default();
    read_usage_file(&path, "grokbuild", &mut delta).unwrap();
    let g46 = delta
        .daily
        .get(&("2026-10-29".to_string(), "grok-4.6-build".to_string()))
        .unwrap();
    assert_eq!(g46.samples, 1);
    assert_eq!(g46.input_tokens, 600);
    assert_eq!(g46.cache_read_tokens, 400);
    assert_eq!(g46.output_tokens, 200);
    assert_eq!(g46.reasoning_tokens, 50);
    assert!((g46.reported_cost_usd - 0.0025).abs() < 1e-12);
    assert_eq!(g46.reported_samples, 1);

    let g47 = delta
        .daily
        .get(&("2026-10-29".to_string(), "grok-4.7-build".to_string()))
        .unwrap();
    assert_eq!(g47.input_tokens, 400);
    assert_eq!(g47.reported_cost_usd, 0.0);
    assert_eq!(g47.reported_samples, 0);
    fs::remove_dir_all(home).unwrap();
}

// ---------------------------------------------------------------------------
// ZCode, Proxy fallback, and scheduler tests
// ---------------------------------------------------------------------------

#[test]
fn reads_zcode_sqlite_database_filtering_account_providers() {
    let root = test_directory("zcode-db");
    let path = root.join("db.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE model_usage (
                id TEXT PRIMARY KEY,
                started_at INTEGER NOT NULL,
                model_id TEXT,
                provider_id TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cache_read_input_tokens INTEGER,
                cache_creation_input_tokens INTEGER,
                reasoning_tokens INTEGER,
                computed_total_tokens INTEGER
            );",
        )
        .unwrap();
    let timestamp = local_ms(2026, 11, 2, 14);
    connection
        .execute(
            "INSERT INTO model_usage VALUES ('1', ?1, 'deepseek-v4.1-flash', 'cpa-gui', 100, 20, 30, 10, 5, 120);",
            [timestamp],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO model_usage VALUES ('2', ?1, 'GLM-5.3-Flash', 'account:bigmodel-start-plan', 500, 50, 0, 0, 0, 550);",
            [timestamp],
        )
        .unwrap();
    drop(connection);

    let mut delta = FileDelta::default();
    zcode::read_database(&path, &mut delta).unwrap();
    let total = delta_total(&delta);
    assert_eq!(total.total_tokens, 120);
    assert_eq!(total.output_tokens, 20);
    assert_eq!(total.cache_read_tokens, 30);
    assert_eq!(total.cache_creation_tokens, 10);
    assert_eq!(total.input_tokens, 70);
    assert_eq!(delta.daily.len(), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn discovers_zcode_custom_data_dir() {
    let home = test_directory("zcode-home");
    let v2 = home.join(".zcode").join("v2");
    fs::create_dir_all(&v2).unwrap();
    let custom = test_directory("zcode-custom");
    let custom_str = custom.to_string_lossy().replace('\\', "\\\\");
    fs::write(
        v2.join("setting.json"),
        format!(r#"{{"dataBaseDir": "{custom_str}"}}"#),
    )
    .unwrap();
    assert_eq!(zcode::read_custom_data_dir(&home), Some(custom.clone()));

    let cli_db = home.join(".zcode").join("cli").join("db").join("db.sqlite");
    fs::create_dir_all(cli_db.parent().unwrap()).unwrap();
    fs::write(&cli_db, b"").unwrap();
    let discovered = source_files(&home, "zcode");
    assert!(discovered.contains(&cli_db));

    fs::remove_dir_all(home).unwrap();
    fs::remove_dir_all(custom).unwrap();
}

#[test]
fn proxy_usage_fallback_only_counts_codex_executors_or_unambiguous_sources() {
    let path =
        std::env::temp_dir().join(format!("cpa-agent-usage-proxy-{}.db", std::process::id()));
    let _ = fs::remove_file(&path);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE usage_events (
                timestamp TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                model TEXT NOT NULL,
                response_model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                reasoning_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL,
                cache_creation_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT 'codex',
                executor_type TEXT NOT NULL DEFAULT 'CodexExecutor'
            );
            CREATE TABLE model_prices (
                model TEXT PRIMARY KEY,
                source_model_id TEXT NOT NULL,
                prompt_per_1m REAL NOT NULL,
                completion_per_1m REAL NOT NULL,
                cache_read_per_1m REAL NOT NULL,
                cache_creation_per_1m REAL NOT NULL
            );",
        )
        .unwrap();
    let timestamp = local_timestamp(2026, 10, 29, 12);
    let timestamp_ms = local_ms(2026, 10, 29, 12);
    connection
        .execute(
            "INSERT INTO usage_events VALUES (?1, ?2, 'gpt-5', '', 120, 40, 2, 20, 0, 160, 'codex', 'CodexExecutor')",
            rusqlite::params![timestamp, timestamp_ms],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO model_prices VALUES ('gpt-5', '', 1.0, 2.0, 0.5, 0.0)",
            [],
        )
        .unwrap();
    for (source, executor) in [
        ("claude", "ClaudeExecutor"),
        ("codex", "ClaudeExecutor"),
        ("claude", ""),
    ] {
        connection
            .execute(
                "INSERT INTO usage_events VALUES (?1, ?2, 'other', '', 1000, 1000, 0, 0, 0, 2000, ?3, ?4)",
                rusqlite::params![timestamp, timestamp_ms, source, executor],
            )
            .unwrap();
    }
    drop(connection);

    let delta = proxy_codex_delta(&path).unwrap();
    let total = delta_total(&delta);
    assert_eq!(total.total_tokens, 160);
    assert_eq!(total.cache_read_tokens, 20);
    assert!((total.cost_usd - 0.00019).abs() < 0.0000001);
    let _ = fs::remove_file(path);
}

#[test]
fn schedules_background_sync_and_sync_guard_exclusivity() {
    let mut preferences = BTreeMap::new();
    assert_eq!(background_interval_millis(&preferences), 300_000);
    preferences.insert(SYNC_INTERVAL_PREFERENCE.to_string(), "3600000".to_string());
    assert_eq!(background_interval_millis(&preferences), 3_600_000);
    preferences.insert(SYNC_INTERVAL_PREFERENCE.to_string(), "0".to_string());
    assert_eq!(background_interval_millis(&preferences), 0);
    assert!(!sync_due(0, 0, 1_000));
    assert!(sync_due(0, 300_000, 1_000));

    let flag = AtomicBool::new(false);
    let guard = SyncGuard::acquire(&flag).unwrap();
    assert!(SyncGuard::acquire(&flag).is_none());
    drop(guard);
    assert!(SyncGuard::acquire(&flag).is_some());
}

#[test]
fn malformed_lines_are_ignored_without_leaking_content() {
    let path = std::env::temp_dir().join(format!("cpa-agent-usage-{}.jsonl", std::process::id()));
    let mut file = File::create(&path).unwrap();
    writeln!(file, "not json").unwrap();
    writeln!(
        file,
        "{{\"usage\":{{\"input_tokens\":1,\"output_tokens\":2}},\"time\":\"2026-10-29T12:00:00Z\",\"model\":\"safe\",\"prompt\":\"private\"}}"
    )
    .unwrap();
    drop(file);
    let mut delta = FileDelta::default();
    read_usage_file(&path, "kimi", &mut delta).unwrap();
    assert_eq!(delta_total(&delta).total_tokens, 3);
    let output = serde_json::to_string(&delta.daily.keys().collect::<Vec<_>>()).unwrap();
    assert!(!output.contains("private"));
    let _ = fs::remove_file(path);
}
