use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    collect_files_under, env_path, first_counter, local_from_epoch_ms, record_sample, sample_time,
    sanitize_model_name, FileDelta, SourceSyncContext, UsageCounter, MAX_JSON_LINE_BYTES,
};

type UsageKey = (u64, u64, u64, u64);

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let mut roots: std::collections::BTreeSet<PathBuf> = std::collections::BTreeSet::new();
    let share_base = env_path("KIMI_SHARE_DIR").unwrap_or_else(|| home.join(".kimi"));
    roots.insert(share_base.join("sessions"));
    let code_base = env_path("KIMI_CODE_HOME").unwrap_or_else(|| home.join(".kimi-code"));
    roots.insert(code_base.join("sessions"));
    let mut files = Vec::new();
    for sessions_root in roots {
        collect_files_under(&sessions_root, &mut files, &|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("wire.jsonl"))
        });
    }
    files
}

fn agent_id_from_path(path: &Path) -> String {
    let mut components = path.components().rev();
    // Expect `.../agents/<agent>/wire.jsonl`
    let _file = components.next();
    let Some(agent) = components.next() else {
        return "main".to_string();
    };
    let Some(parent) = components.next() else {
        return "main".to_string();
    };
    if parent.as_os_str().eq_ignore_ascii_case("agents") {
        agent.as_os_str().to_string_lossy().into_owned()
    } else {
        "main".to_string()
    }
}

fn timestamp_ms(value: &Value) -> Option<i64> {
    if let Some(time) = value
        .as_f64()
        .filter(|time| time.is_finite() && *time > 0.0)
    {
        let millis = if time < 1e12 { time * 1000.0 } else { time };
        return (millis < i64::MAX as f64).then_some(millis as i64);
    }
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis())
}

fn valid_model_name(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !matches!(*name, "agent-loop" | "unknown"))
}

fn duration_ms(value: &Value) -> Option<i64> {
    let v = value.as_f64()?;
    (v.is_finite() && (0.0..=3_600_000.0).contains(&v)).then_some(v.round() as i64)
}

#[derive(Debug, Default)]
struct RequestInfo {
    model: Option<String>,
    latency_ms: i64,
    request_ms: Option<i64>,
}

#[derive(Default)]
struct ActiveStep {
    uuid: String,
    turn_step: Option<String>,
    model: Option<String>,
    request_ms: Option<i64>,
    response_ms: Option<i64>,
    has_tools: bool,
}

#[derive(Default)]
struct RequestIndex {
    agent: String,
    step: Option<ActiveStep>,
    messages: HashMap<String, RequestInfo>,
}

impl RequestIndex {
    fn for_agent(agent: &str) -> Self {
        Self {
            agent: agent.to_string(),
            ..Default::default()
        }
    }

    fn observe(&mut self, record: &Value) {
        if record["agentId"]
            .as_str()
            .is_some_and(|id| id != self.agent)
        {
            return;
        }
        match record["type"].as_str() {
            Some("agent.switched" | "agent.turn.started") => self.step = None,
            Some("llm.request") => {
                if record["kind"].as_str().is_some_and(|k| k != "loop") {
                    return;
                }
                if let Some(step) = &mut self.step {
                    if let (Some(expected), Some(actual)) =
                        (step.turn_step.as_deref(), record["turnStep"].as_str())
                    {
                        if expected != actual {
                            return;
                        }
                    }
                    step.model = valid_model_name(&record["model"]).map(str::to_owned);
                    step.request_ms = timestamp_ms(&record["time"]);
                    step.response_ms = None;
                    step.has_tools = false;
                }
            }
            Some("context.append_loop_event") => {
                let event = &record["event"];
                match event["type"].as_str() {
                    Some("step.begin") => {
                        self.step = event["uuid"].as_str().map(|uuid| ActiveStep {
                            uuid: uuid.into(),
                            turn_step: event["turnId"]
                                .as_str()
                                .zip(event["step"].as_u64())
                                .map(|(turn, step)| format!("{turn}.{step}")),
                            ..Default::default()
                        });
                    }
                    Some("content.part" | "tool.call") => {
                        if let Some(step) = &mut self.step {
                            if event["stepUuid"].as_str() != Some(step.uuid.as_str()) {
                                return;
                            }
                            if event["type"] == "tool.call" {
                                step.has_tools = true;
                            } else {
                                step.response_ms =
                                    step.response_ms.max(timestamp_ms(&record["time"]));
                            }
                        }
                    }
                    Some("step.end") => {
                        if self
                            .step
                            .as_ref()
                            .is_some_and(|s| event["uuid"].as_str() != Some(s.uuid.as_str()))
                        {
                            return;
                        }
                        let step = self.step.take().unwrap_or_default();
                        let Some(id) = event["messageId"].as_str().filter(|id| !id.is_empty())
                        else {
                            return;
                        };
                        let first_token = duration_ms(&event["llmFirstTokenLatencyMs"]);
                        let native_latency = first_token
                            .zip(duration_ms(&event["llmStreamDurationMs"]))
                            .map(|(f, s)| f.saturating_add(s))
                            .filter(|ms| *ms > 0);
                        let end_ms = step.response_ms.or_else(|| {
                            (!step.has_tools)
                                .then(|| timestamp_ms(&record["time"]))
                                .flatten()
                        });
                        let est_latency = step
                            .request_ms
                            .zip(end_ms)
                            .and_then(|(s, e)| (e > s && e - s <= 3_600_000).then_some(e - s));
                        let latency_ms = native_latency.or(est_latency).unwrap_or(0);
                        let info = self.messages.entry(id.into()).or_default();
                        info.model = step.model.or_else(|| info.model.take());
                        info.request_ms = step.request_ms.or(info.request_ms);
                        if latency_ms > 0 {
                            info.latency_ms = latency_ms;
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn get(&self, meta: &Value) -> Option<&RequestInfo> {
        self.messages.get(meta["messageId"].as_str()?)
    }

    fn model<'a>(&'a self, meta: &'a Value) -> Option<&'a str> {
        self.get(meta)
            .and_then(|info| info.model.as_deref())
            .or_else(|| valid_model_name(&meta["model"]["model"]))
            .or_else(|| valid_model_name(&meta["model"]))
    }
}

fn usage_key(usage: &Value) -> UsageKey {
    let map = usage.as_object();
    let get = |keys: &[&str]| {
        map.and_then(|m| first_counter(m, keys)).unwrap_or(0)
    };
    (
        get(&["inputOther", "input_other", "input_tokens", "inputTokens"]),
        get(&["output", "output_tokens", "outputTokens"]),
        get(&["inputCacheRead", "input_cache_read", "cache_read_tokens"]),
        get(&[
            "inputCacheCreation",
            "input_cache_creation",
            "cache_creation_tokens",
        ]),
    )
}

fn completed_ms(started: i64, latency: i64, committed: i64) -> i64 {
    let finished = started.saturating_add(latency.max(0));
    if committed > 0 {
        finished.min(committed)
    } else {
        finished
    }
}

struct PendingKimi {
    dedup_key: String,
    meta: Value,
    usage: UsageKey,
    committed_ms: Option<i64>,
    fallback_record: Value,
}

pub(super) fn read_file(
    path: &Path,
    ctx: &mut SourceSyncContext,
    delta: &mut FileDelta,
) -> Result<(), ()> {
    let file = File::open(path).map_err(|_| ())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let agent = agent_id_from_path(path);
    let is_main = agent == "main";
    let mut requests = RequestIndex::for_agent(&agent);
    let mut usage_models: HashMap<UsageKey, VecDeque<Option<String>>> = HashMap::new();
    let mut pending: Vec<PendingKimi> = Vec::new();

    loop {
        buffer.clear();
        let bytes = reader.read_until(b'\n', &mut buffer).map_err(|_| ())?;
        if bytes == 0 {
            break;
        }
        if buffer.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        if record["agentId"].as_str().is_some_and(|id| id != agent) {
            continue;
        }

        // Reset unmatched usage.record queue on turn/step boundaries so interrupted steps
        // never leak models into subsequent steps with identical token counts.
        match record["type"].as_str() {
            Some("agent.switched" | "agent.turn.started") => usage_models.clear(),
            Some("context.append_loop_event") if record["event"]["type"] == "step.begin" => {
                usage_models.clear();
            }
            _ => {}
        }

        if record["type"].as_str() == Some("usage.record") {
            let model = valid_model_name(&record["model"]).map(str::to_owned);
            usage_models
                .entry(usage_key(&record["usage"]))
                .or_default()
                .push_back(model);
            continue;
        }

        requests.observe(&record);

        let record_type = record["type"].as_str();
        let (meta, usage_val) = match record_type {
            Some("agent.message.appended" | "human.agent.message.appended") if is_main => {
                if record
                    .pointer("/message/message/role")
                    .and_then(Value::as_str)
                    != Some("assistant")
                {
                    continue;
                }
                let meta = record["message"]["meta"].clone();
                let Some(usage) = meta.get("usage").cloned() else {
                    continue;
                };
                (meta, usage)
            }
            Some("context.append_loop_event") => {
                let event = &record["event"];
                if event["type"].as_str() != Some("step.end") {
                    continue;
                }
                let mut step_models = std::mem::take(&mut usage_models);
                let Some(usage) = event.get("usage").cloned() else {
                    continue;
                };
                let model = step_models
                    .get_mut(&usage_key(&usage))
                    .and_then(VecDeque::pop_front)
                    .flatten();
                let provider = if is_main { "agent-loop" } else { "subagent" };
                let meta = serde_json::json!({
                    "messageId": event["messageId"],
                    "model": { "provider": provider, "model": model },
                });
                (meta, usage)
            }
            None => {
                // Flat legacy record without wire envelope (e.g. `{"time":..., "model":..., "usage":{...}}`).
                let Some(usage) = record
                    .get("usage")
                    .or_else(|| record.get("token_usage"))
                    .cloned()
                else {
                    continue;
                };
                let meta = serde_json::json!({
                    "messageId": record["messageId"],
                    "model": { "provider": "legacy", "model": record["model"] },
                });
                (meta, usage)
            }
            _ => continue,
        };

        let counts = usage_key(&usage_val);
        if counts == (0, 0, 0, 0) {
            continue;
        }
        let identity = meta
            .get("messageId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{:x}", Sha256::digest(record.to_string().as_bytes())));
        let provider = meta
            .pointer("/model/provider")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let dedup_key = format!("kimi:{provider}:{identity}");
        pending.push(PendingKimi {
            dedup_key,
            meta,
            usage: counts,
            committed_ms: timestamp_ms(&record["time"]),
            fallback_record: record,
        });
    }

    // Deduplicate within file AND across files (legacy projection vs step.end share the same key).
    let mut file_seen: HashSet<String> = HashSet::new();
    for item in pending {
        if !file_seen.insert(item.dedup_key.clone()) {
            continue;
        }
        if ctx.seen_ids.contains(&item.dedup_key) {
            continue;
        }
        ctx.seen_ids.insert(item.dedup_key.clone());
        delta.claimed_ids.push(item.dedup_key);

        let info = requests.get(&item.meta);
        let model = requests
            .model(&item.meta)
            .map(sanitize_model_name)
            .filter(|m| !m.is_empty());

        let time = match (info.and_then(|i| i.request_ms), item.committed_ms) {
            (Some(started), Some(committed)) => {
                let latency = info.map_or(0, |i| i.latency_ms);
                local_from_epoch_ms(completed_ms(started, latency, committed))
            }
            (Some(started), None) => local_from_epoch_ms(started),
            (None, Some(committed)) => local_from_epoch_ms(committed),
            (None, None) => sample_time(&item.fallback_record, path),
        };
        let Some(time) = time else {
            continue;
        };

        let (input, output, cache_read, cache_creation) = item.usage;
        let total = input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_creation);
        let counter = UsageCounter {
            input_tokens: input,
            output_tokens: output,
            cache_creation_tokens: cache_creation,
            cache_creation_1h_tokens: 0,
            cache_read_tokens: cache_read,
            reasoning_tokens: 0,
            total_tokens: total,
            cost_usd: 0.0,
            reported_cost_usd: 0.0,
            reported_samples: 0,
            samples: 1,
        };
        record_sample(delta, time, model, counter);
    }

    Ok(())
}
