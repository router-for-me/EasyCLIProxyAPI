use serde_json::json;

use super::*;
fn record(model: &str, input: u64, output: u64) -> Value {
    json!({"request_id":"r1","timestamp":"2026-09-12T12:00:00Z","model":model,"provider":"openai","tokens":{"input_tokens":input,"output_tokens":output,"total_tokens":input+output}})
}
fn db(values: Vec<Value>) -> Connection {
    let mut c = Connection::open_in_memory().unwrap();
    initialize_usage_schema(&c).unwrap();
    let records = values
        .into_iter()
        .map(|v| normalize_usage_record(v, &GuiConfigFile::default()).unwrap())
        .collect::<Vec<_>>();
    insert_usage_records(&mut c, &records).unwrap();
    c
}
fn cost(values: Vec<Value>) -> f64 {
    let c = db(values);
    load_usage_pricing(&c, &UsageQuery::default())
        .unwrap()
        .total_cost
}
fn check(actual: f64, expected: f64) {
    println!("actual=${actual:.9} expected=${expected:.9}");
    assert!(
        (actual - expected).abs() < 1e-10,
        "actual={actual}, expected={expected}"
    );
}
#[test]
fn control_openai_cached_reasoning_subset() {
    let mut v = record("gpt-5.4", 10000, 1000);
    v["tokens"]["cache_read_tokens"] = json!(4000);
    v["tokens"]["reasoning_tokens"] = json!(600);
    check(cost(vec![v]), 0.031);
}
#[test]
fn control_claude_independent_cache() {
    let mut v = record("claude-sonnet-4-6", 1000, 1000);
    v["provider"] = json!("claude");
    v["tokens"]["cache_read_tokens"] = json!(4000);
    v["tokens"]["cache_creation_tokens"] = json!(2000);
    v["tokens"]["total_tokens"] = json!(8000);
    v["cache_creation_5m_tokens"] = json!(2000);
    check(cost(vec![v]), 0.0267);
}
#[test]
fn gemini_thinking_is_billable_output() {
    let mut v = record("gemini-2.5-pro", 10000, 1000);
    v["provider"] = json!("gemini");
    v["tokens"]["reasoning_tokens"] = json!(9000);
    v["tokens"]["total_tokens"] = json!(20000);
    check(cost(vec![v]), 0.1125);
}
#[test]
fn gpt41_has_no_long_context_surcharge() {
    check(cost(vec![record("gpt-4.1", 300000, 1000)]), 0.608);
}
#[test]
fn claude46_has_no_long_context_surcharge() {
    check(cost(vec![record("claude-sonnet-4-6", 300000, 1000)]), 0.915);
}
#[test]
fn gemini_pro_threshold_is_200k() {
    check(cost(vec![record("gemini-2.5-pro", 250000, 1000)]), 0.64);
}
#[test]
fn astra_fast_has_premium() {
    let mut v = record("gpt-6-astra", 10000, 1000);
    v["service_tier"] = json!("fast");
    check(cost(vec![v]), 0.3);
}
#[test]
fn gpt52_fast_has_premium() {
    let mut v = record("gpt-5.2", 10000, 1000);
    v["service_tier"] = json!("fast");
    check(cost(vec![v]), 0.063);
}
#[test]
fn sol_long_fast_has_premium() {
    let mut v = record("gpt-5.6-sol", 300000, 1000);
    v["service_tier"] = json!("fast");
    check(cost(vec![v]), 4.86);
}
#[test]
fn grouping_must_preserve_additivity() {
    let mut a = record("gpt-5.6-sol", 10000, 1000);
    a["service_tier"] = json!("fast");
    let mut b = record("gpt-5.6-sol", 300000, 1000);
    b["service_tier"] = json!("fast");
    b["request_id"] = json!("r2");
    check(
        cost(vec![a.clone(), b.clone()]),
        cost(vec![a]) + cost(vec![b]),
    );
}
#[test]
fn dated_model_must_not_inherit_different_snapshot_price() {
    check(cost(vec![record("gpt-4o-2024-05-13", 10000, 1000)]), 0.065);
}
#[test]
fn deepseek_flash_current_peak_price() {
    let mut v = record("deepseek-v4-flash", 10000, 1000);
    v["timestamp"] = json!("2026-09-14T02:00:00Z");
    check(cost(vec![v]), 0.0042);
}
#[test]
fn unknown_model_does_not_mean_zero_priced() {
    let c = db(vec![record("unlisted-model", 10000, 1000)]);
    let p = load_usage_pricing(&c, &UsageQuery::default()).unwrap();
    assert_eq!(p.priced_requests, 0);
    check(p.total_cost, 0.0);
}
#[test]
fn event_count_preserves_attempts_and_prewarm_under_one_request() {
    let mut a = record("gpt-5.4", 0, 0);
    a["generate"] = json!(false);
    let mut b = record("gpt-5.4", 0, 0);
    b["failed"] = json!(true);
    let c = db(vec![a, b, record("gpt-5.4", 100, 10)]);
    let p = load_usage_pricing(&c, &UsageQuery::default()).unwrap();
    assert_eq!(p.total_requests, 3);
    assert_eq!(
        c.query_row(
            "SELECT COUNT(DISTINCT request_id) FROM usage_events",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
#[test]
fn v2_breakdown_overrides_legacy_fields() {
    let mut v = record("gpt-5.4", 0, 0);
    v["tokens"]["total_tokens"] = json!(10000);
    v["accounting_version"] = json!(2);
    v["token_breakdown"] = json!({"schema_version":2,"quality":"complete","total_tokens":10000,"input":{"total_tokens":9000,"uncached_tokens":9000,"cache_read_tokens":0,"cache_write_tokens":0},"output":{"total_tokens":1000,"non_reasoning_tokens":1000,"reasoning_tokens":0},"unclassified_tokens":0});
    check(cost(vec![v]), 0.0375);
}

#[test]
fn grok_long_context_starts_at_200k() {
    check(cost(vec![record("grok-4.6", 250000, 1000)]), 1.012);
}
#[test]
fn grok_long_context_output_multiplier_is_two() {
    check(cost(vec![record("grok-4.6", 300000, 10000)]), 1.32);
}
#[test]
fn claude_hour_cache_write_rate() {
    let mut v = record("claude-sonnet-4-6", 0, 0);
    v["provider"] = json!("claude");
    v["tokens"]["cache_creation_tokens"] = json!(100000);
    v["tokens"]["total_tokens"] = json!(100000);
    v["cache_creation_1h_tokens"] = json!(100000);
    check(cost(vec![v]), 0.6);
}
#[test]
fn usage_with_only_total_must_not_be_marked_fully_priced() {
    let mut v = record("gpt-5.4", 0, 0);
    v["tokens"]["total_tokens"] = json!(10000);
    let c = db(vec![v]);
    assert_eq!(
        load_usage_pricing(&c, &UsageQuery::default())
            .unwrap()
            .priced_requests,
        0
    );
}
#[test]
fn replay_deduplicates_event_not_request() {
    let mut a = record("gpt-5.4", 100, 10);
    a["event_id"] = json!("event-a");
    let mut b = a.clone();
    b["event_id"] = json!("event-b");
    let c = db(vec![a.clone(), a, b]);
    assert_eq!(
        load_usage_pricing(&c, &UsageQuery::default())
            .unwrap()
            .total_requests,
        2
    );
    let p = load_usage_events(&c, &UsageQuery::default(), &GuiConfigFile::default()).unwrap();
    assert_ne!(p.items[0].id, p.items[1].id);
}
#[test]
fn provider_reported_cost_without_text_tokens_is_preserved() {
    let mut a = record("grok-imagine-video", 0, 0);
    a["provider"] = json!("xai");
    a["cost_usd"] = json!("0.0123456789");
    check(cost(vec![a]), 0.0123456789);
}
#[test]
fn unknown_cache_ttl_is_not_fully_priced() {
    let mut a = record("claude-sonnet-4-6", 0, 0);
    a["provider"] = json!("claude");
    a["tokens"]["cache_creation_tokens"] = json!(1000);
    let c = db(vec![a]);
    assert_eq!(
        load_usage_pricing(&c, &UsageQuery::default())
            .unwrap()
            .priced_requests,
        0
    );
}
#[test]
fn tariff_snapshot_survives_manual_price_change() {
    let c = db(vec![record("gpt-5.4", 10000, 1000)]);
    let before = load_usage_pricing(&c, &UsageQuery::default())
        .unwrap()
        .total_cost;
    let mut p = official_model_price("gpt-5.4").unwrap();
    p.source = "manual".into();
    p.prompt = 999.;
    upsert_model_price(&c, &p).unwrap();
    check(
        load_usage_pricing(&c, &UsageQuery::default())
            .unwrap()
            .total_cost,
        before,
    );
}
#[test]
fn media_variant_does_not_inherit_text_price() {
    assert!(official_model_price("gemini-2.5-flash-image").is_none());
}
#[test]
fn response_tier_overrides_requested_codex_tier() {
    let mut a = record("gpt-5.4", 10000, 1000);
    a["provider"] = json!("codex");
    a["service_tier"] = json!("priority");
    a["response_service_tier"] = json!("default");
    check(cost(vec![a]), 0.04);
}

#[test]
fn provider_and_upstream_prices_are_independent() {
    let mut c = Connection::open_in_memory().unwrap();
    initialize_usage_schema(&c).unwrap();
    let mut price = official_model_price("gpt-5.4").unwrap();
    price.source = "manual".into();
    price.provider = "gateway".into();
    price.base_url = "https://one.example/v1".into();
    price.prompt = 1.;
    price.completion = 2.;
    upsert_model_price(&c, &price).unwrap();
    let mut a = record("gpt-5.4", 10000, 1000);
    a["provider"] = json!("gateway");
    a["base_url"] = json!("https://one.example/v1");
    let mut b = a.clone();
    b["base_url"] = json!("https://two.example/v1");
    let config = GuiConfigFile::default();
    insert_usage_records(
        &mut c,
        &[
            normalize_usage_record(a, &config).unwrap(),
            normalize_usage_record(b, &config).unwrap(),
        ],
    )
    .unwrap();
    check(
        load_usage_pricing(&c, &UsageQuery::default())
            .unwrap()
            .total_cost,
        0.012 + 0.04,
    );
}
#[test]
fn repeated_video_polling_counts_only_incremental_charge() {
    let events = ["0.10", "0.10", "0.12"]
        .into_iter()
        .map(|cost| {
            let mut v = record("grok-video", 0, 0);
            v["provider"] = json!("xai");
            v["cost_usd"] = json!(cost);
            v["billing_id"] = json!("xai-video/job1");
            v["cost_scope"] = json!("operation");
            v
        })
        .collect();
    let c = db(events);
    let p = load_usage_pricing(&c, &UsageQuery::default()).unwrap();
    check(p.total_cost, 0.12);
    assert_eq!(p.total_requests, 3);
}
#[test]
fn context_threshold_boundaries_are_model_specific() {
    check(cost(vec![record("gemini-2.5-pro", 200000, 1000)]), 0.26);
    check(
        cost(vec![record("gemini-2.5-pro", 200001, 1000)]),
        0.5150025,
    );
    check(cost(vec![record("grok-4.6", 199999, 1000)]), 0.405998);
    check(cost(vec![record("grok-4.6", 200000, 1000)]), 0.812);
}
#[test]
fn endpoint_and_transport_filters_preserve_attempts() {
    let mut a = record("gpt-5.4", 100, 10);
    a["endpoint"] = json!("POST /v1/responses");
    a["stream"] = json!(true);
    a["kind"] = json!("attempt");
    let mut b = a.clone();
    b["executor_type"] = json!("CodexWebsocketsExecutor");
    let c = db(vec![a, b]);
    let query = UsageQuery {
        endpoint: Some("POST /v1/responses".into()),
        transport: Some("sse".into()),
        ..UsageQuery::default()
    };
    assert_eq!(
        load_usage_events(&c, &query, &GuiConfigFile::default())
            .unwrap()
            .total,
        1
    );
}

#[test]
fn image_tool_has_separate_text_and_image_rates() {
    let mut v = record("gpt-image-2", 100, 1000);
    v["raw_usage"] = json!({"input_tokens_details":{"text_tokens":20,"image_tokens":80},"input_tokens":100,"output_tokens":1000});
    check(cost(vec![v]), 0.03074);
}
#[test]
fn realtime_audio_text_and_cached_audio_are_separate() {
    let mut v = record("gpt-realtime", 100, 1000);
    v["tokens"]["cache_read_tokens"] = json!(30);
    v["raw_usage"] = json!({"input_token_details":{"text_tokens":20,"audio_tokens":80,"cached_tokens":30,"cached_tokens_details":{"text_tokens":10,"audio_tokens":20}},"output_token_details":{"text_tokens":100,"audio_tokens":900}});
    check(cost(vec![v]), 0.061172);
}
#[test]
fn image_tool_never_inherits_parent_text_tariff() {
    let mut v = record("future-image-model", 100, 1000);
    v["alias"] = json!("gpt-5.4");
    v["kind"] = json!("tool");
    let c = db(vec![v]);
    assert_eq!(
        load_usage_pricing(&c, &UsageQuery::default())
            .unwrap()
            .priced_requests,
        0
    );
}

#[test]
fn multimodal_with_unpriced_hosted_tools_is_not_fully_valued() {
    let mut v = record("gpt-image-2", 100, 1000);
    v["raw_usage"] = json!({"input_tokens_details":{"text_tokens":20,"image_tokens":80},"unpriced_server_tools":true});
    let c = db(vec![v]);
    assert_eq!(
        load_usage_pricing(&c, &UsageQuery::default())
            .unwrap()
            .priced_requests,
        0
    );
}
#[test]
fn hosted_file_search_and_claude_search_have_separate_fees() {
    let mut v = record("gpt-5.4", 10000, 1000);
    v["raw_usage"] = json!({"file_search_calls":2});
    check(cost(vec![v]), 0.045);
    let mut v = record("claude-sonnet-4-6", 1000, 1000);
    v["raw_usage"] = json!({"server_tool_use":{"web_search_requests":2}});
    check(cost(vec![v]), 0.038);
}
#[test]
fn gemini_flash_audio_input_uses_audio_price() {
    let mut v = record("gemini-2.5-flash", 1000, 100);
    v["raw_usage"] = json!({"promptTokensDetails":[{"modality":"TEXT","tokenCount":400},{"modality":"AUDIO","tokenCount":600}]});
    check(cost(vec![v]), 0.00097);
}

#[test]
fn fingerprinted_source_remains_readable_without_exposing_a_key() {
    assert_eq!(
        usage_source_display(
            &GuiConfigFile::default(),
            "openai",
            "sha256:123456789012abcdef"
        ),
        "sha256:123456789012"
    );
}

#[test]
fn inbox_does_not_persist_legacy_or_probe_credentials() {
    let mut c = Connection::open_in_memory().unwrap();
    initialize_usage_schema(&c).unwrap();
    let mut v = record("gpt-5.4", 100, 10);
    v["api_key"] = json!("test-downstream-secret");
    v["source"] = json!("test-upstream-secret");
    v["auth_type"] = json!("apikey");
    enqueue_usage_queue_items(&mut c, "desktop_health_check", vec![v]).unwrap();
    let raw: String = c
        .query_row("SELECT raw_message FROM usage_inbox", [], |row| row.get(0))
        .unwrap();
    assert!(!raw.contains("test-downstream-secret") && !raw.contains("test-upstream-secret"));
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["api_key_hash"], hash_text("test-downstream-secret"));
    assert_eq!(
        process_usage_inbox(&mut c, &GuiConfigFile::default()).unwrap(),
        1
    );
}

#[test]
fn accounting_migration_recovers_a_partially_added_schema() {
    let c = db(vec![record("gemini-2.5-pro", 100, 20)]);
    c.execute_batch("DROP INDEX idx_usage_event_id; ALTER TABLE usage_events DROP COLUMN event_id; UPDATE usage_events SET provider='gemini', output_tokens=10, reasoning_tokens=10;").unwrap();
    initialize_usage_schema(&c).unwrap();
    initialize_usage_schema(&c).unwrap();
    assert!(usage_table_columns(&c, "usage_events")
        .unwrap()
        .contains("event_id"));
    assert_eq!(
        c.query_row("SELECT output_tokens FROM usage_events", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        20
    );
}

#[test]
fn accounting_migration_rolls_back_columns_when_data_update_fails() {
    let c = db(vec![record("gemini-2.5-pro", 100, 20)]);
    c.execute_batch("DROP INDEX idx_usage_event_id; ALTER TABLE usage_events DROP COLUMN event_id; ALTER TABLE usage_events DROP COLUMN accounting_json; UPDATE usage_events SET provider='gemini', output_tokens=10, reasoning_tokens=10; CREATE TRIGGER fail_accounting_update BEFORE UPDATE OF output_tokens ON usage_events BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;").unwrap();
    assert!(initialize_usage_schema(&c).is_err());
    let columns = usage_table_columns(&c, "usage_events").unwrap();
    assert!(!columns.contains("accounting_json") && !columns.contains("event_id"));
    c.execute_batch("DROP TRIGGER fail_accounting_update;")
        .unwrap();
    initialize_usage_schema(&c).unwrap();
}

#[test]
fn claude_actual_speed_controls_the_tariff() {
    let mut v = record("claude-opus-5", 1000, 1000);
    v["raw_usage"] = json!({"speed":"fast"});
    check(cost(vec![v]), 0.06);
    let mut v = record("claude-opus-4-6", 1000, 1000);
    v["service_tier"] = json!("fast");
    v["raw_usage"] = json!({"speed":"standard"});
    check(cost(vec![v]), 0.03);
}
#[test]
fn claude_priority_commitment_does_not_use_fast_prices() {
    let mut v = record("claude-opus-5", 1000, 1000);
    v["response_service_tier"] = json!("priority");
    let c = db(vec![v]);
    assert_eq!(
        load_usage_pricing(&c, &UsageQuery::default())
            .unwrap()
            .priced_requests,
        0
    );
}
#[test]
fn regional_processing_uplift_excludes_storage_only_regions_and_manual_rates() {
    let mut v = record("gpt-5.6-sol", 1000, 1000);
    v["base_url"] = json!("https://eu.api.openai.com/v1");
    check(cost(vec![v.clone()]), 0.0264);
    v["base_url"] = json!("https://jp.api.openai.com/v1");
    check(cost(vec![v]), 0.024);
}

#[test]
fn durable_inbox_flushes_wal_before_acknowledgement() {
    let root = std::env::temp_dir().join(format!("usage-ack-durability-{}", unique_file_stamp()));
    let c = open_usage_database_at(&root).unwrap();
    let sync: i64 = c.query_row("PRAGMA synchronous", [], |r| r.get(0)).unwrap();
    drop(c);
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(sync, 2, "ACK requires synchronous FULL, not NORMAL");
}

#[test]
fn overview_distinguishes_events_from_billable_generation_groups() {
    let mut attempt = record("gpt-5.4", 100, 10);
    attempt["kind"] = json!("attempt");
    attempt["generation_id"] = json!("generation-1");
    let retry = attempt.clone();
    let mut tool = attempt.clone();
    tool["kind"] = json!("tool");
    let mut warm = attempt.clone();
    warm["kind"] = json!("prewarm");
    warm["generate"] = json!(false);
    warm["generation_id"] = json!("local-prewarm");
    let mut health = attempt.clone();
    health["kind"] = json!("health_check");
    health["generate"] = json!(false);
    let c = db(vec![attempt, retry, tool, warm, health]);
    let overview = load_usage_overview(&c, &UsageQuery::default()).unwrap();
    assert_eq!(overview.total_requests, 5);
    assert_eq!(overview.event_counts["attempt"], 2);
    assert_eq!(overview.event_counts["tool"], 1);
    assert_eq!(overview.event_counts["prewarm"], 1);
    assert_eq!(overview.event_counts["logical_generations"], 1);
}
