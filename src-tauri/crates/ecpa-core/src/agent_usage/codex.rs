use chrono::{DateTime, Local};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::io::BufRead;
use std::path::{Path, PathBuf};

use super::zstd_frames::{is_zstd_path, open_jsonl_reader};
use super::{
    collect_files_under, contains_any_str, env_path, first_counter, record_sample, sample_time,
    sanitize_model_name, string_field, FileDelta, SourceSyncContext, UsageCounter,
    MAX_JSON_LINE_BYTES,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub(super) struct RawUsage {
    pub input: u64,
    pub cached: u64,
    pub cache_write: u64,
    pub output: u64,
    pub reasoning: u64,
}

impl RawUsage {
    fn is_zero(self) -> bool {
        self.input == 0
            && self.cached == 0
            && self.cache_write == 0
            && self.output == 0
            && self.reasoning == 0
    }

    fn monotonic_ge(self, prev: Self) -> bool {
        self.input >= prev.input
            && self.cached >= prev.cached
            && self.cache_write >= prev.cache_write
            && self.output >= prev.output
            && self.reasoning >= prev.reasoning
    }

    fn saturating_sub(self, prev: Self) -> Self {
        Self {
            input: self.input.saturating_sub(prev.input),
            cached: self.cached.saturating_sub(prev.cached),
            cache_write: self.cache_write.saturating_sub(prev.cache_write),
            output: self.output.saturating_sub(prev.output),
            reasoning: self.reasoning.saturating_sub(prev.reasoning),
        }
    }

    fn to_counter(self) -> UsageCounter {
        let cached = self.cached.min(self.input);
        let cache_write = self.cache_write.min(self.input.saturating_sub(cached));
        let fresh_input = self
            .input
            .saturating_sub(cached)
            .saturating_sub(cache_write);
        // OpenAI/Codex `output_tokens` already includes `reasoning_output_tokens`.
        let output = self.output;
        let total = fresh_input
            .saturating_add(output)
            .saturating_add(cached)
            .saturating_add(cache_write);
        UsageCounter {
            input_tokens: fresh_input,
            output_tokens: output,
            cache_creation_tokens: cache_write,
            cache_creation_1h_tokens: 0,
            cache_read_tokens: cached,
            reasoning_tokens: self.reasoning,
            total_tokens: total,
            cost_usd: 0.0,
            reported_cost_usd: 0.0,
            reported_samples: 0,
            samples: 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct SnapshotSignature {
    total: Option<RawUsage>,
    last: Option<RawUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ParentUsageEvent {
    pub total_sig: Option<RawUsage>,
    pub delta_sig: RawUsage,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, Default)]
pub(super) struct RolloutMeta {
    pub thread_id: Option<String>,
    pub parent_id: Option<String>,
    pub ordinal: Option<u64>,
}

#[derive(Debug, Default)]
pub(super) struct CodexSourceIndex {
    all_files: Vec<PathBuf>,
    /// Populated lazily only if filename-based parent lookup misses (e.g. non-UUID filenames).
    full_header_scan_done: bool,
    /// Maps `thread_id` -> list of rollout paths ordered oldest-first (by ordinal, path).
    by_thread: HashMap<String, Vec<PathBuf>>,
    /// Maps path -> cached rollout metadata.
    meta_by_path: HashMap<PathBuf, RolloutMeta>,
    /// Cached parent event timelines keyed by path.
    timeline_cache: HashMap<PathBuf, Vec<ParentUsageEvent>>,
}

impl CodexSourceIndex {
    pub(super) fn build(files: &[PathBuf]) -> Self {
        Self {
            all_files: files.to_vec(),
            ..Self::default()
        }
    }

    fn meta_for(&mut self, path: &Path) -> RolloutMeta {
        if let Some(meta) = self.meta_by_path.get(path) {
            return meta.clone();
        }
        let meta = read_rollout_meta(path);
        self.meta_by_path.insert(path.to_path_buf(), meta.clone());
        meta
    }

    fn ensure_full_header_scan(&mut self) {
        if self.full_header_scan_done {
            return;
        }
        self.full_header_scan_done = true;
        // Standard rollout filenames already contain their thread UUID; only non-UUID
        // filenames need a fallback header scan when filename matching misses.
        let paths: Vec<PathBuf> = self
            .all_files
            .iter()
            .filter(|p| !filename_contains_uuid(p))
            .cloned()
            .collect();
        for path in paths {
            let meta = self.meta_for(&path);
            if let Some(thread_id) = meta.thread_id {
                let entry = self.by_thread.entry(thread_id).or_default();
                if !entry.contains(&path) {
                    entry.push(path);
                }
            }
        }
        for paths in self.by_thread.values_mut() {
            paths.sort_by(|left, right| {
                let l_ord = self.meta_by_path.get(left).and_then(|m| m.ordinal);
                let r_ord = self.meta_by_path.get(right).and_then(|m| m.ordinal);
                l_ord.cmp(&r_ord).then_with(|| left.cmp(right))
            });
        }
    }

    fn find_paths_for_thread(&mut self, thread_id: &str) -> Vec<PathBuf> {
        if let Some(cached) = self.by_thread.get(thread_id) {
            return cached.clone();
        }
        // Fast path: Codex rollout filenames embed the thread UUID (e.g. `rollout-...-<uuid>.jsonl`).
        let mut matches: Vec<PathBuf> = self
            .all_files
            .iter()
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.contains(thread_id))
            })
            .cloned()
            .collect();
        if !matches.is_empty() {
            matches.sort_by(|left, right| {
                let l_ord = self.meta_for(left).ordinal;
                let r_ord = self.meta_for(right).ordinal;
                l_ord.cmp(&r_ord).then_with(|| left.cmp(right))
            });
            self.by_thread.insert(thread_id.to_string(), matches.clone());
            return matches;
        }
        // Fallback for non-standard filenames without the UUID in the filename.
        self.ensure_full_header_scan();
        self.by_thread.get(thread_id).cloned().unwrap_or_default()
    }

    /// Returns parent files whose replayed events may appear as a prefix in `path`.
    fn ancestor_paths(&mut self, path: &Path) -> Vec<PathBuf> {
        let meta = self.meta_for(path);
        let mut ancestors = Vec::new();
        if let Some(parent_id) = &meta.parent_id {
            for parent_file in self.find_paths_for_thread(parent_id) {
                if parent_file != path {
                    ancestors.push(parent_file);
                }
            }
        }
        // Check continuations sharing the same `thread_id` (only if >1 file matches the thread ID).
        if let Some(thread_id) = &meta.thread_id {
            let matches_by_name = self
                .all_files
                .iter()
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.contains(thread_id.as_str()))
                })
                .count();
            if matches_by_name > 1 || self.full_header_scan_done {
                for sibling in self.find_paths_for_thread(thread_id) {
                    if sibling == path {
                        break;
                    }
                    if !ancestors.contains(&sibling) {
                        ancestors.push(sibling);
                    }
                }
            }
        }
        ancestors
    }

    fn events_for_path(&mut self, path: &Path) -> &[ParentUsageEvent] {
        if !self.timeline_cache.contains_key(path) {
            let events = parse_rollout_events(path)
                .unwrap_or_default()
                .into_iter()
                .map(|e| ParentUsageEvent {
                    total_sig: e.total_sig,
                    delta_sig: e.raw_delta,
                    timestamp_ms: e.time.timestamp_millis(),
                })
                .collect();
            self.timeline_cache.insert(path.to_path_buf(), events);
        }
        self.timeline_cache
            .get(path)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
}

/// Returns true when the filename contains an embedded canonical 36-char UUID (`8-4-4-4-12`).
fn filename_contains_uuid(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let bytes = name.as_bytes();
    if bytes.len() < 36 {
        return false;
    }
    for i in 0..=bytes.len() - 36 {
        let s = &bytes[i..i + 36];
        if s[8] == b'-'
            && s[13] == b'-'
            && s[18] == b'-'
            && s[23] == b'-'
            && s[0..8].iter().all(u8::is_ascii_hexdigit)
            && s[9..13].iter().all(u8::is_ascii_hexdigit)
            && s[14..18].iter().all(u8::is_ascii_hexdigit)
            && s[19..23].iter().all(u8::is_ascii_hexdigit)
            && s[24..36].iter().all(u8::is_ascii_hexdigit)
        {
            return true;
        }
    }
    false
}

/// Strips `.zst` suffix so `rollout-a.jsonl` and compressed `rollout-a.jsonl.zst`
/// share one logical key.
pub(super) fn logical_filename(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(stripped) = name.strip_suffix(".zst") {
        stripped.to_string()
    } else if let Some(stripped) = name.strip_suffix(".zstd") {
        stripped.to_string()
    } else {
        name
    }
}

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let base = env_path("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
    let active_root = base.join("sessions");
    let archived_root = base.join("archived_sessions");

    let mut raw_files: Vec<(bool, PathBuf)> = Vec::new();
    for (is_active, root) in [(true, active_root), (false, archived_root)] {
        let mut found = Vec::new();
        collect_files_under(&root, &mut found, &|path| {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                return false;
            };
            name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")
        });
        for path in found {
            raw_files.push((is_active, path));
        }
    }

    // Deduplicate sibling `.jsonl` vs `.jsonl.zst` and active vs archived copies
    // of the same logical rollout filename.
    // Preference rank: (is_active, !is_zstd).
    let mut best: BTreeMap<String, (bool, bool, PathBuf)> = BTreeMap::new();
    for (is_active, path) in raw_files {
        let logical = logical_filename(&path);
        let uncompressed = !is_zstd_path(&path);
        match best.get(&logical) {
            Some((prev_active, prev_uncompressed, _))
                if (*prev_active, *prev_uncompressed) >= (is_active, uncompressed) => {}
            _ => {
                best.insert(logical, (is_active, uncompressed, path));
            }
        }
    }
    best.into_values().map(|(_, _, path)| path).collect()
}

pub(super) fn normalize_codex_model(raw: &str) -> String {
    let tail = raw
        .trim()
        .rsplit_once('/')
        .map(|(_, right)| right)
        .unwrap_or(raw.trim())
        .to_ascii_lowercase();
    let stripped = strip_codex_date_suffix(&tail).unwrap_or(tail);
    sanitize_model_name(&stripped)
}

fn strip_codex_date_suffix(model: &str) -> Option<String> {
    let bytes = model.as_bytes();
    if bytes.len() > 11 {
        let start = bytes.len() - 11;
        let s = &bytes[start..];
        if s[0] == b'-'
            && s[1..5].iter().all(|b| b.is_ascii_digit())
            && s[5] == b'-'
            && s[6..8].iter().all(|b| b.is_ascii_digit())
            && s[8] == b'-'
            && s[9..11].iter().all(|b| b.is_ascii_digit())
        {
            return Some(model[..start].to_string());
        }
    }
    let (base, suffix) = model.rsplit_once('-')?;
    if !base.is_empty() && suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
        return Some(base.to_string());
    }
    None
}

fn read_rollout_meta(path: &Path) -> RolloutMeta {
    let Ok(mut reader) = open_jsonl_reader(path) else {
        return RolloutMeta::default();
    };
    let mut buffer = Vec::new();
    for _ in 0..32 {
        buffer.clear();
        let Ok(bytes) = reader.read_until(b'\n', &mut buffer) else {
            break;
        };
        if bytes == 0 {
            break;
        }
        if buffer.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        if !contains_any_str(&buffer, &["session_meta"]) {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let Some(payload) = value.get("payload").and_then(Value::as_object) else {
            continue;
        };
        let thread_id = string_field(payload, &["id", "thread_id"]);
        let parent_id = string_field(payload, &["forked_from_id"]).or_else(|| {
            payload
                .get("source")
                .and_then(|s| s.pointer("/subagent/thread_spawn/parent_thread_id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
        let ordinal = payload.get("ordinal").and_then(Value::as_u64);
        return RolloutMeta {
            thread_id,
            parent_id,
            ordinal,
        };
    }
    RolloutMeta::default()
}

fn parse_raw_usage(map: &serde_json::Map<String, Value>) -> Option<RawUsage> {
    let input = first_counter(map, &["input_tokens", "inputTokens", "prompt_tokens"]);
    let output = first_counter(map, &["output_tokens", "outputTokens", "completion_tokens"]);
    let cached = first_counter(
        map,
        &[
            "cached_input_tokens",
            "cache_read_input_tokens",
            "cachedInputTokens",
            "cacheReadTokens",
        ],
    );
    let cache_write = first_counter(
        map,
        &[
            "cache_write_input_tokens",
            "cache_creation_input_tokens",
            "cacheWriteInputTokens",
            "cacheCreationTokens",
        ],
    );
    let reasoning = first_counter(
        map,
        &["reasoning_output_tokens", "reasoningOutputTokens", "reasoning_tokens"],
    );
    if input.is_none()
        && output.is_none()
        && cached.is_none()
        && cache_write.is_none()
        && reasoning.is_none()
    {
        return None;
    }
    Some(RawUsage {
        input: input.unwrap_or(0),
        cached: cached.unwrap_or(0),
        cache_write: cache_write.unwrap_or(0),
        output: output.unwrap_or(0),
        reasoning: reasoning.unwrap_or(0),
    })
}

fn model_from_record(value: &Value) -> Option<String> {
    let record_type = value.get("type").and_then(Value::as_str)?;
    let payload = value.get("payload")?.as_object()?;
    match record_type {
        "turn_context" => string_field(payload, &["model", "model_name", "modelName"])
            .or_else(|| {
                payload
                    .get("info")
                    .and_then(Value::as_object)
                    .and_then(|info| string_field(info, &["model", "model_name", "modelName"]))
            }),
        "event_msg" => match payload.get("type").and_then(Value::as_str) {
            Some("thread_settings_applied") => payload
                .get("thread_settings")
                .and_then(Value::as_object)
                .and_then(|s| string_field(s, &["model", "model_name", "modelName"])),
            Some("token_count") => payload
                .get("info")
                .and_then(Value::as_object)
                .and_then(|info| string_field(info, &["model", "model_name", "modelName"]))
                .or_else(|| string_field(payload, &["model", "model_name", "modelName"])),
            _ => None,
        },
        _ => None,
    }
    .map(|m| normalize_codex_model(&m))
    .filter(|m| !m.is_empty())
}

pub(super) struct ParsedCodexEvent {
    pub time: DateTime<Local>,
    pub model: Option<String>,
    pub total_sig: Option<RawUsage>,
    pub raw_delta: RawUsage,
    pub counter: UsageCounter,
}

fn parse_rollout_events(path: &Path) -> Result<Vec<ParsedCodexEvent>, ()> {
    let mut reader = open_jsonl_reader(path)?;
    let mut buffer = Vec::new();
    let mut events = Vec::new();
    let mut current_model: Option<String> = None;
    let mut pending_usage_record: Option<RawUsage> = None;
    let mut last_sig_by_lane: HashMap<String, SnapshotSignature> = HashMap::new();
    let mut previous_sig: Option<SnapshotSignature> = None;
    let mut previous_totals: Option<RawUsage> = None;

    loop {
        buffer.clear();
        let bytes = reader.read_until(b'\n', &mut buffer).map_err(|_| ())?;
        if bytes == 0 {
            break;
        }
        if buffer.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        if !contains_any_str(
            &buffer,
            &[
                "token_count",
                "turn_context",
                "thread_settings_applied",
                "token_usage_record",
            ],
        ) {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        if let Some(model) = model_from_record(&value) {
            current_model = Some(model);
        }
        let Some(payload) = value.get("payload").and_then(Value::as_object) else {
            continue;
        };
        match payload.get("type").and_then(Value::as_str) {
            Some("token_usage_record") => {
                let raw = payload
                    .get("token_usage")
                    .or_else(|| payload.get("usage"))
                    .and_then(Value::as_object)
                    .and_then(parse_raw_usage)
                    .or_else(|| parse_raw_usage(payload));
                if let Some(rec) = raw.filter(|r| !r.is_zero()) {
                    pending_usage_record = Some(rec);
                }
            }
            Some("token_count") => {
                let info = payload.get("info").and_then(Value::as_object);
                let total_usage = info
                    .and_then(|i| i.get("total_token_usage"))
                    .and_then(Value::as_object)
                    .and_then(parse_raw_usage);
                let last_usage = info
                    .and_then(|i| i.get("last_token_usage"))
                    .and_then(Value::as_object)
                    .and_then(parse_raw_usage);
                let fallback_usage = payload
                    .get("usage")
                    .and_then(Value::as_object)
                    .and_then(parse_raw_usage);

                if total_usage.is_none() && last_usage.is_none() && fallback_usage.is_none() {
                    continue;
                }

                let lane = payload
                    .get("rate_limits")
                    .and_then(|r| r.get("limit_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let sig = SnapshotSignature {
                    total: total_usage,
                    last: last_usage.or(fallback_usage),
                };

                // Rate-limit refreshes repeat the exact previous snapshot unchanged.
                if last_sig_by_lane.get(&lane) == Some(&sig) || previous_sig == Some(sig) {
                    continue;
                }
                last_sig_by_lane.insert(lane, sig);
                previous_sig = Some(sig);

                let delta = if let Some(last) = last_usage.filter(|u| !u.is_zero()) {
                    pending_usage_record = None;
                    Some(last)
                } else if last_usage.is_some_and(RawUsage::is_zero) {
                    // Remote compaction writes a token_usage_record followed by a zero last_token_usage.
                    pending_usage_record.take().or_else(|| {
                        let total = total_usage?;
                        match previous_totals {
                            Some(prev) if total.monotonic_ge(prev) => {
                                let diff = total.saturating_sub(prev);
                                (!diff.is_zero()).then_some(diff)
                            }
                            None if !total.is_zero() => Some(total),
                            _ => None,
                        }
                    })
                } else if let Some(total) = total_usage {
                    pending_usage_record = None;
                    match previous_totals {
                        Some(prev) if total.monotonic_ge(prev) => {
                            let diff = total.saturating_sub(prev);
                            (!diff.is_zero()).then_some(diff)
                        }
                        None if !total.is_zero() => Some(total),
                        _ => None,
                    }
                } else {
                    pending_usage_record = None;
                    fallback_usage.filter(|u| !u.is_zero())
                };

                if let Some(total) = total_usage {
                    previous_totals = Some(total);
                }

                let Some(raw_delta) = delta.filter(|u| !u.is_zero()) else {
                    continue;
                };
                let counter = raw_delta.to_counter();
                if counter.total_tokens == 0 {
                    continue;
                }
                let Some(time) = sample_time(&value, path) else {
                    continue;
                };
                let model = model_from_record(&value)
                    .or_else(|| {
                        info.and_then(|i| i.get("last_token_usage"))
                            .and_then(Value::as_object)
                            .and_then(|u| string_field(u, &["model", "modelName"]))
                            .map(|m| normalize_codex_model(&m))
                    })
                    .or_else(|| current_model.clone());
                events.push(ParsedCodexEvent {
                    time,
                    model,
                    total_sig: total_usage,
                    raw_delta,
                    counter,
                });
            }
            _ => {}
        }
    }
    Ok(events)
}

/// Strips a leading prefix of `child_events` that replays events already present
/// in any ancestor rollout timeline (parent thread on fork/subagent spawn, or
/// earlier continuation rollout of the same thread).
fn strip_replayed_prefix(
    child_events: Vec<ParsedCodexEvent>,
    ancestors: &[&[ParentUsageEvent]],
) -> Vec<ParsedCodexEvent> {
    if child_events.is_empty() || ancestors.is_empty() {
        return child_events;
    }
    let mut max_prefix = 0usize;
    for parent in ancestors {
        if parent.is_empty() {
            continue;
        }
        // Match the longest prefix of child events that aligns consecutively in `parent`
        // (either from index 0, or matching a contiguous slice starting where the first
        // child snapshot matches an ancestor snapshot).
        let first = &child_events[0];
        for start in 0..parent.len() {
            if !events_match(&parent[start], first) {
                continue;
            }
            let mut matched = 1usize;
            while matched < child_events.len() && start + matched < parent.len() {
                if events_match(&parent[start + matched], &child_events[matched]) {
                    matched += 1;
                } else {
                    break;
                }
            }
            if matched > max_prefix {
                max_prefix = matched;
            }
        }
    }
    child_events.into_iter().skip(max_prefix).collect()
}

fn events_match(parent: &ParentUsageEvent, child: &ParsedCodexEvent) -> bool {
    if parent.delta_sig != child.raw_delta {
        return false;
    }
    match (parent.total_sig, child.total_sig) {
        (Some(p_tot), Some(c_tot)) => p_tot == c_tot,
        _ => true,
    }
}

pub(super) fn read_file(
    path: &Path,
    ctx: &mut SourceSyncContext,
    delta: &mut FileDelta,
) -> Result<(), ()> {
    let events = parse_rollout_events(path)?;
    let events = if let Some(index) = ctx.codex_index.as_mut() {
        // Cache this file's parsed timeline so any descendant fork avoids re-parsing it.
        if !index.timeline_cache.contains_key(path) {
            let cached: Vec<ParentUsageEvent> = events
                .iter()
                .map(|e| ParentUsageEvent {
                    total_sig: e.total_sig,
                    delta_sig: e.raw_delta,
                    timestamp_ms: e.time.timestamp_millis(),
                })
                .collect();
            index.timeline_cache.insert(path.to_path_buf(), cached);
        }
        let ancestors = index.ancestor_paths(path);
        if ancestors.is_empty() {
            events
        } else {
            let mut ancestor_timelines: Vec<Vec<ParentUsageEvent>> =
                Vec::with_capacity(ancestors.len());
            for ancestor in ancestors {
                ancestor_timelines.push(index.events_for_path(&ancestor).to_vec());
            }
            let refs: Vec<&[ParentUsageEvent]> =
                ancestor_timelines.iter().map(Vec::as_slice).collect();
            strip_replayed_prefix(events, &refs)
        }
    } else {
        events
    };

    for event in events {
        record_sample(delta, event.time, event.model, event.counter);
    }
    Ok(())
}

/// Single-record helper retained for direct unit testing of Codex `token_count` parsing.
#[cfg(test)]
pub(super) fn extract_single_token_count(value: &Value) -> Option<(UsageCounter, Option<String>)> {
    let payload = value.get("payload")?.as_object()?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let info = payload.get("info").and_then(Value::as_object);
    let usage = info
        .and_then(|object| {
            object
                .get("last_token_usage")
                .and_then(Value::as_object)
                .or_else(|| object.get("total_token_usage").and_then(Value::as_object))
        })
        .or_else(|| payload.get("usage").and_then(Value::as_object))?;
    let raw = parse_raw_usage(usage)?;
    let counter = raw.to_counter();
    if counter.total_tokens == 0 {
        return None;
    }
    let model = model_from_record(value)
        .or_else(|| string_field(usage, &["model", "modelName"]).map(|m| normalize_codex_model(&m)));
    Some((counter, model))
}
