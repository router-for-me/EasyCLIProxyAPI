use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::{
    collect_files_under, contains_any_str, copy_sqlite_snapshot, env_path, first_counter,
    is_non_empty_regular_file, is_transient_sqlite_error, record_sample, sample_time,
    sanitize_model_name, FileDelta, UsageCounter, MAX_JSON_LINE_BYTES, MAX_MODEL_NAME_CHARS,
};

pub(super) fn discover_files(home: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut roots: Vec<PathBuf> = vec![
        home.join(".gemini").join("antigravity"),
        home.join(".gemini").join("antigravity-cli"),
        home.join(".gemini").join("antigravity-ide"),
        home.join(".gemini").join("antigravity-acp"),
        home.join(".gemini").join("antigravity-backup"),
    ];
    // Include T3 Code embedded Antigravity ACP profiles.
    let t3_home = env_path("T3CODE_HOME").unwrap_or_else(|| home.join(".t3"));
    for env_sub in ["userdata", "dev"] {
        let providers_root = t3_home.join(env_sub).join("providers").join("antigravity");
        if let Ok(entries) = fs::read_dir(&providers_root) {
            for entry in entries.flatten() {
                let candidate = entry.path().join("antigravity-acp");
                if is_regular_dir(&candidate) {
                    roots.push(candidate);
                }
            }
        }
    }

    let mut sessions_by_id: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for root in roots {
        if !is_regular_dir(&root) {
            continue;
        }
        let brain = root.join("brain");
        if !is_regular_dir(&brain) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&brain) else {
            continue;
        };
        for entry in entries.flatten() {
            let session_dir = entry.path();
            if !is_regular_dir(&session_dir) {
                continue;
            }
            let Some(session_id) = session_dir
                .file_name()
                .and_then(|n| n.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            let logs = session_dir.join(".system_generated").join("logs");
            if !is_regular_dir(&logs) {
                continue;
            }
            sessions_by_id.entry(session_id).or_default().push(logs);
        }
    }

    for (_, log_dirs) in sessions_by_id {
        if let Some(selected) = select_canonical_session_files(&log_dirs) {
            files.extend(selected);
        }
    }

    // Legacy IDE log directory (no session-id hierarchy).
    let legacy = home.join(".antigravity-ide").join("logs");
    if is_regular_dir(&legacy) {
        collect_files_under(&legacy, &mut files, &|path| {
            path.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        });
    }
    files
}

fn is_regular_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_dir() && !meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn select_canonical_session_files(log_dirs: &[PathBuf]) -> Option<Vec<PathBuf>> {
    // Collect all mirror layouts across roots for this session first.
    let mut all_candidates: Vec<(u8, Vec<PathBuf>)> = Vec::new();
    for logs in log_dirs {
        let transcript = logs.join("transcript.jsonl");
        let transcript_full = logs.join("transcript_full.jsonl");
        if is_non_empty_regular_file(&transcript) {
            all_candidates.push((4, vec![transcript]));
        }
        if is_non_empty_regular_file(&transcript_full) {
            all_candidates.push((3, vec![transcript_full]));
        }
        let chunks_transcript = collect_chunk_files(&logs.join("chunks").join("transcript"));
        if !chunks_transcript.is_empty() {
            all_candidates.push((2, chunks_transcript));
        }
        let chunks_full = collect_chunk_files(&logs.join("chunks").join("transcript_full"));
        if !chunks_full.is_empty() {
            all_candidates.push((1, chunks_full));
        }
    }

    if all_candidates.is_empty() {
        return None;
    }
    // Fast path: when only a single layout exists for this session, skip scanning its lines.
    if all_candidates.len() == 1 {
        return all_candidates.into_iter().next().map(|(_, paths)| paths);
    }

    // Multiple mirrors exist: prefer the layout covering the most completed steps,
    // breaking ties by canonical layout priority.
    let mut best: Option<(usize, u8, Vec<PathBuf>)> = None;
    for (rank, paths) in all_candidates {
        let mut covered = BTreeSet::new();
        for p in &paths {
            if let Some(steps) = covered_steps(p) {
                covered.extend(steps);
            }
        }
        let count = covered.len();
        let replace = match &best {
            None => true,
            Some((best_count, best_rank, _)) => (count, rank) > (*best_count, *best_rank),
        };
        if replace {
            best = Some((count, rank, paths));
        }
    }

    best.map(|(_, _, paths)| paths)
}

fn collect_chunk_files(dir: &Path) -> Vec<PathBuf> {
    if !is_regular_dir(dir) {
        return Vec::new();
    }
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            is_non_empty_regular_file(path)
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
        })
        .collect();
    files.sort();
    files
}

pub(crate) fn session_root(path: &Path) -> Option<(PathBuf, String)> {
    let brain = path.ancestors().find(|candidate| {
        candidate
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("brain"))
    })?;
    let root = brain.parent()?.to_path_buf();
    let rest = path.strip_prefix(brain).ok()?;
    let session = rest
        .components()
        .next()?
        .as_os_str()
        .to_string_lossy()
        .to_string();
    Some((root, session))
}

pub(crate) fn session_id(path: &Path) -> Option<String> {
    session_root(path).map(|(_, session)| session)
}

pub(crate) fn session_database(path: &Path) -> Option<PathBuf> {
    let (root, session) = session_root(path)?;
    Some(root.join("conversations").join(format!("{session}.db")))
}

pub(crate) fn covered_steps(path: &Path) -> Option<BTreeSet<u64>> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut steps = BTreeSet::new();
    loop {
        buffer.clear();
        let bytes = reader.read_until(b'\n', &mut buffer).ok()?;
        if bytes == 0 {
            break;
        }
        if buffer.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        if !contains_any_str(&buffer, &["PLANNER_RESPONSE", "input_tokens", "inputTokens"]) {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&buffer) else {
            continue;
        };
        if !is_countable_record(&value) {
            continue;
        }
        if let Some(step) = value.get("step_index").and_then(Value::as_u64) {
            if extract_tokens(&value).is_some() {
                steps.insert(step);
            }
        }
    }
    Some(steps)
}

fn is_countable_record(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if let Some(kind) = object.get("type").and_then(Value::as_str) {
        if kind != "PLANNER_RESPONSE" {
            return false;
        }
    }
    if let Some(status) = object.get("status").and_then(Value::as_str) {
        if status != "DONE" {
            return false;
        }
    }
    true
}

fn extract_tokens(value: &Value) -> Option<UsageCounter> {
    let object = value.as_object()?;
    let map = object
        .get("usage")
        .or_else(|| object.get("usageMetadata"))
        .and_then(Value::as_object)
        .unwrap_or(object);
    let input = first_counter(map, &["input_tokens", "inputTokens"]).unwrap_or(0);
    let output = first_counter(map, &["output_tokens", "outputTokens"]).unwrap_or(0);
    let cache_read = first_counter(map, &["cache_read_tokens", "cacheReadTokens"]).unwrap_or(0);
    let cache_write = first_counter(
        map,
        &[
            "cache_write_tokens",
            "cacheWriteTokens",
            "cache_creation_tokens",
            "cacheCreationTokens",
        ],
    )
    .unwrap_or(0);
    let total = input
        .saturating_add(output)
        .saturating_add(cache_read)
        .saturating_add(cache_write);
    if total == 0 {
        return None;
    }
    // Antigravity exports fresh input (excludes cache reads) and output including thinking.
    Some(UsageCounter {
        input_tokens: input,
        output_tokens: output,
        cache_creation_tokens: cache_write,
        cache_creation_1h_tokens: 0,
        cache_read_tokens: cache_read,
        reasoning_tokens: 0,
        total_tokens: total,
        cost_usd: 0.0,
        reported_cost_usd: 0.0,
        reported_samples: 0,
        samples: 1,
    })
}

/// Converts display names (`Gemini 4 Neon (XHigh)`) to canonical model IDs
/// (`gemini-4-neon-xhigh`). Preserves IDs that already have no spaces.
pub(super) fn model_id_of(display: &str) -> String {
    let trimmed = display.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lowered = trimmed.to_ascii_lowercase();
    // Exact legacy display aliases whose canonical ID differs from plain slugification.
    if lowered == "gemini 3.8 flash (dynamic)" || lowered == "gemini 3.8 flash (tiered)" {
        return "gemini-3.8-flash-tiered".to_string();
    }
    if lowered == "gemini 3.8 flash lite" {
        return "gemini-3.5-flash-lite".to_string();
    }
    if lowered == "gemini 3.1 pro" {
        return "gemini-3.1-pro-preview".to_string();
    }
    if !trimmed.contains(' ') {
        return sanitize_model_name(trimmed);
    }
    let slug = lowered
        .replace(" (", "-")
        .replace(['(', ')'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    // Normalize dotted Claude versions produced from display names like `Claude Sonnet 5.5 (Max)`.
    let normalized = if slug.starts_with("claude-") && slug.contains('.') {
        slug.replace('.', "-")
    } else {
        slug
    };
    sanitize_model_name(&normalized)
}

fn orchestrator_mode(model: &str) -> Option<&'static str> {
    match model_id_of(model).to_ascii_lowercase().as_str() {
        "orchestrator" | "orchestrator-carbon" | "gemini-pro-orchestrator" => Some("carbon"),
        "orchestrator-argon"
        | "gemini-pro-orchestrator-argon"
        | "gemini-pro-orchestrator-g1-pro" => Some("argon"),
        "orchestrator-neon" | "gemini-pro-orchestrator-neon" => Some("neon"),
        _ => None,
    }
}

fn orchestrator_base_model(mode: &str) -> &'static str {
    match mode {
        "argon" => "gemini-4-argon",
        "neon" => "gemini-4-neon",
        _ => "gemini-4-carbon",
    }
}

fn is_orchestrator(model: &str) -> bool {
    orchestrator_mode(model).is_some()
}

fn is_orchestrator_worker(model: &str) -> bool {
    model_id_of(model).eq_ignore_ascii_case("gemini-flash-worker-agy")
}

fn is_unresolved_worker_target(model: &str) -> bool {
    let id = model_id_of(model);
    id.is_empty()
        || id.eq_ignore_ascii_case("unknown")
        || is_orchestrator(&id)
        || is_orchestrator_worker(&id)
        || id == "gemini-flash"
}

pub(super) fn is_valid_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_MODEL_NAME_CHARS
        && !value.eq_ignore_ascii_case("none")
        && !value.eq_ignore_ascii_case("unknown")
        && !value.starts_with("MODEL_PLACEHOLDER_")
        && value.chars().any(|c| c.is_ascii_alphabetic())
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '@')
        })
}

pub(super) fn parse_model_label(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("none")
        || trimmed.eq_ignore_ascii_case("unknown")
        || trimmed.eq_ignore_ascii_case("unknown model")
    {
        return None;
    }
    if trimmed.contains(' ') {
        let id = model_id_of(trimmed);
        return is_valid_model_id(&id).then_some(id);
    }
    is_valid_model_id(trimmed).then(|| sanitize_model_name(trimmed))
}

fn settings_scope(content: &str) -> Option<&str> {
    if let Some((_, tail)) = content.rsplit_once("<USER_SETTINGS_CHANGE>") {
        return Some(
            tail.split_once("</USER_SETTINGS_CHANGE>")
                .map(|(body, _)| body)
                .unwrap_or(tail),
        );
    }
    if content.contains("<USER_REQUEST>") {
        return None;
    }
    Some(content)
}

pub(super) fn extract_settings_model(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    let is_user = object
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|t| t == "USER_INPUT")
        || object
            .get("source")
            .and_then(Value::as_str)
            .is_some_and(|s| s.eq_ignore_ascii_case("USER_EXPLICIT"));
    if !is_user {
        return None;
    }
    let content = object.get("content")?.as_str()?;
    let scope = settings_scope(content)?;
    let marker = "changed setting `Model Selection` ";
    let position = scope.rfind(marker)?;
    let line = scope[position + marker.len()..].lines().next()?;
    let clause = line
        .split_once(". ")
        .map(|(head, _)| head)
        .unwrap_or(line)
        .trim()
        .trim_end_matches('.');
    let label = if let Some(target) = clause.strip_prefix("to ") {
        target
    } else if clause.starts_with("from ") {
        clause.rsplit_once(" to ").map(|(_, target)| target)?
    } else {
        return None;
    };
    parse_model_label(label)
}

fn sibling_settings_model(path: &Path) -> Option<String> {
    let mut logs_dir = path.parent()?;
    while logs_dir.file_name().is_some_and(|name| {
        name.eq_ignore_ascii_case("chunks")
            || name.eq_ignore_ascii_case("transcript")
            || name.eq_ignore_ascii_case("transcript_full")
    }) {
        logs_dir = logs_dir.parent()?;
    }
    if !logs_dir
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("logs"))
    {
        return None;
    }
    for name in ["transcript.jsonl", "transcript_full.jsonl"] {
        let sibling = logs_dir.join(name);
        if !sibling.is_file() || sibling == path {
            continue;
        }
        let Ok(file) = File::open(&sibling) else {
            continue;
        };
        let reader = BufReader::new(file);
        for line in reader.lines().flatten() {
            if line.len() > MAX_JSON_LINE_BYTES {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if let Some(model) = extract_settings_model(&value) {
                    return Some(model);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Native conversations/<id>.db protobuf decoding
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub(super) struct NativeModelIndex {
    /// Exact step -> resolved model ID from `steps` JOIN `gen_metadata`.
    exact_by_step: HashMap<u64, String>,
    /// Legacy fallback: `last_step_index` range lookup from `gen_metadata`.
    range_by_step: BTreeMap<u64, String>,
    /// Most frequent model in `gen_metadata` when no step mapping exists.
    default: Option<String>,
}

impl NativeModelIndex {
    fn model_for_step(&self, step: Option<u64>) -> Option<&str> {
        if let Some(step) = step {
            if let Some(model) = self.exact_by_step.get(&step) {
                return Some(model.as_str());
            }
            if let Some((_, model)) = self.range_by_step.range(..=step).next_back() {
                return Some(model.as_str());
            }
            if let Some((_, model)) = self.range_by_step.iter().next() {
                return Some(model.as_str());
            }
        }
        self.default.as_deref()
    }
}

fn load_native_model_index(path: &Path) -> Option<NativeModelIndex> {
    let database = session_database(path)?;
    if !is_non_empty_regular_file(&database) {
        return None;
    }
    match read_native_database(&database) {
        Ok(index) => index,
        Err(()) => {
            let snapshot = copy_sqlite_snapshot(&database, "cpa-agy-model")?;
            let index = read_native_database(&snapshot).ok().flatten();
            if let Some(dir) = snapshot.parent() {
                let _ = fs::remove_dir_all(dir);
            }
            index
        }
    }
}

fn read_native_database(database: &Path) -> Result<Option<NativeModelIndex>, ()> {
    let conn = match Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => conn,
        Err(error) if is_transient_sqlite_error(&error) => return Err(()),
        Err(_) => return Ok(None),
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(2));

    let has_gen_metadata: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gen_metadata')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !has_gen_metadata {
        return Ok(None);
    }

    // Load all generation blobs keyed by `idx`.
    let mut gen_models: HashMap<u64, String> = HashMap::new();
    let mut range_by_step: BTreeMap<u64, String> = BTreeMap::new();
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();

    {
        let mut stmt = match conn.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx") {
            Ok(stmt) => stmt,
            Err(error) if is_transient_sqlite_error(&error) => return Err(()),
            Err(_) => return Ok(None),
        };
        let rows = match stmt.query_map([], |row| {
            let idx = row.get::<_, i64>(0)?;
            let data = match row.get_ref(1)? {
                ValueRef::Blob(bytes) | ValueRef::Text(bytes) => bytes.to_vec(),
                _ => Vec::new(),
            };
            Ok((idx, data))
        }) {
            Ok(rows) => rows,
            Err(error) if is_transient_sqlite_error(&error) => return Err(()),
            Err(_) => return Ok(None),
        };
        for row in rows {
            let (idx, data) = match row {
                Ok(pair) => pair,
                Err(error) if is_transient_sqlite_error(&error) => return Err(()),
                Err(_) => continue,
            };
            let Some(meta) = parse_generation_blob(&data) else {
                continue;
            };
            if let Some(model) = meta.model {
                *counts.entry(model.clone()).or_default() += 1;
                if let Ok(u_idx) = u64::try_from(idx) {
                    gen_models.insert(u_idx, model.clone());
                }
                if let Some(last_step) = meta.last_step_index {
                    range_by_step.insert(last_step, model);
                }
            }
        }
    }

    // Primary step -> generation association via `steps` table (step_type = 15).
    let mut exact_by_step: HashMap<u64, String> = HashMap::new();
    let has_steps: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if has_steps {
        if let Ok(mut stmt) =
            conn.prepare("SELECT idx, metadata FROM steps WHERE step_type = 15 AND metadata IS NOT NULL")
        {
            if let Ok(rows) = stmt.query_map([], |row| {
                let idx = row.get::<_, i64>(0)?;
                let bytes = match row.get_ref(1)? {
                    ValueRef::Blob(b) => b.to_vec(),
                    _ => Vec::new(),
                };
                Ok((idx, bytes))
            }) {
                for row in rows.flatten() {
                    let (step_idx, bytes) = row;
                    let Ok(step) = u64::try_from(step_idx) else {
                        continue;
                    };
                    if let Some(gen_idx) = decode_step_generation_index(&bytes) {
                        if let Some(model) = gen_models.get(&gen_idx) {
                            exact_by_step.insert(step, model.clone());
                        }
                    }
                }
            }
        }
    }

    let default = counts
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| right.0.cmp(&left.0)))
        .map(|(model, _)| model);

    if exact_by_step.is_empty() && range_by_step.is_empty() && default.is_none() {
        return Ok(None);
    }
    Ok(Some(NativeModelIndex {
        exact_by_step,
        range_by_step,
        default,
    }))
}

#[derive(Debug, Default)]
pub(super) struct ParsedGenMeta {
    pub model: Option<String>,
    pub last_step_index: Option<u64>,
}

/// Decodes `StepMetadata.generation.index` (outer field 20 -> inner field 3 varint;
/// protobuf omits scalar field 3 when its value is 0).
fn decode_step_generation_index(data: &[u8]) -> Option<u64> {
    let mut cursor = 0;
    while cursor < data.len() {
        let (field, wire, payload, _) = read_pb_field(data, &mut cursor)?;
        if field == 20 && wire == 2 {
            let mut inner = 0;
            let mut gen_index = 0u64;
            while inner < payload.len() {
                let (ifield, iwire, _, varint) = read_pb_field(payload, &mut inner)?;
                if ifield == 3 && iwire == 0 {
                    gen_index = varint.unwrap_or(0);
                }
            }
            return Some(gen_index);
        }
    }
    None
}

/// Decodes `gen_metadata.data` (field 1 response -> field 21 tiered model ID,
/// field 19 base model, field 20 map entry `last_step_index`).
pub(super) fn parse_generation_blob(data: &[u8]) -> Option<ParsedGenMeta> {
    let mut base: Option<String> = None;
    let mut tiered: Option<String> = None;
    let mut last_step_index: Option<u64> = None;

    scan_gen_response(data, 0, &mut base, &mut tiered, &mut last_step_index);

    let orchestrator_mapped = match base.as_deref() {
        Some("gemini-pro-orchestrator") => Some("gemini-4-carbon"),
        Some("gemini-pro-orchestrator-argon" | "gemini-pro-orchestrator-g1-pro") => {
            Some("gemini-4-argon")
        }
        Some("gemini-pro-orchestrator-neon") => Some("gemini-4-neon"),
        Some("gemini-flash-worker-agy") => Some("gemini-4-hydrogen"),
        _ => None,
    };

    let tiered = tiered.filter(|m| {
        let id = model_id_of(m);
        !(orchestrator_mapped.is_some()
            && (is_orchestrator(&id)
                || matches!(id.as_str(), "gemini-flash" | "gemini-flash-worker-agy")))
    });

    let resolved = [
        tiered.map(|m| model_id_of(&m)),
        orchestrator_mapped.map(str::to_string),
        base.map(|m| model_id_of(&m)),
    ]
    .into_iter()
    .flatten()
    .find(|m| is_valid_model_id(m));

    if resolved.is_none() && last_step_index.is_none() {
        return None;
    }
    Some(ParsedGenMeta {
        model: resolved,
        last_step_index,
    })
}

fn scan_gen_response(
    data: &[u8],
    depth: usize,
    base: &mut Option<String>,
    tiered: &mut Option<String>,
    last_step_index: &mut Option<u64>,
) {
    if depth > 1 {
        return;
    }
    let mut cursor = 0;
    while cursor < data.len() {
        let Some((field, wire, payload, _)) = read_pb_field(data, &mut cursor) else {
            break;
        };
        if wire != 2 {
            continue;
        }
        match field {
            19 if base.is_none() => {
                if let Ok(text) = std::str::from_utf8(payload) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() && !trimmed.starts_with("MODEL_PLACEHOLDER_") {
                        *base = Some(trimmed.to_string());
                    }
                }
            }
            21 if tiered.is_none() => {
                if let Ok(text) = std::str::from_utf8(payload) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() && !trimmed.starts_with("MODEL_PLACEHOLDER_") {
                        *tiered = Some(trimmed.to_string());
                    }
                }
            }
            20 => {
                if let Some((k, v)) = parse_pb_map_entry(payload) {
                    if k == "last_step_index" {
                        *last_step_index = v.parse().ok();
                    }
                }
            }
            1 if depth == 0 => {
                scan_gen_response(payload, depth + 1, base, tiered, last_step_index);
            }
            _ => {}
        }
    }
}

fn parse_pb_map_entry(data: &[u8]) -> Option<(String, String)> {
    let mut key = None;
    let mut value = None;
    let mut cursor = 0;
    while cursor < data.len() {
        let (field, wire, payload, _) = read_pb_field(data, &mut cursor)?;
        if wire != 2 {
            continue;
        }
        if field == 1 {
            key = std::str::from_utf8(payload).ok().map(str::to_string);
        } else if field == 2 {
            value = std::str::from_utf8(payload).ok().map(str::to_string);
        }
    }
    Some((key?, value?))
}

fn read_pb_field<'a>(
    data: &'a [u8],
    cursor: &mut usize,
) -> Option<(u64, u8, &'a [u8], Option<u64>)> {
    let key = read_pb_varint(data, cursor)?;
    let field = key >> 3;
    let wire = (key & 0x07) as u8;
    match wire {
        0 => {
            let val = read_pb_varint(data, cursor)?;
            Some((field, wire, &[], Some(val)))
        }
        1 => {
            *cursor = (*cursor).checked_add(8)?;
            if *cursor > data.len() {
                return None;
            }
            Some((field, wire, &[], None))
        }
        2 => {
            let length = read_pb_varint(data, cursor)? as usize;
            let end = (*cursor).checked_add(length)?;
            let payload = data.get(*cursor..end)?;
            *cursor = end;
            Some((field, wire, payload, None))
        }
        5 => {
            *cursor = (*cursor).checked_add(4)?;
            if *cursor > data.len() {
                return None;
            }
            Some((field, wire, &[], None))
        }
        _ => None,
    }
}

fn read_pb_varint(data: &[u8], cursor: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0u32;
    while *cursor < data.len() && shift < 64 {
        let byte = data[*cursor];
        *cursor += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
    }
    None
}

// ---------------------------------------------------------------------------
// Transcript reader
// ---------------------------------------------------------------------------

pub(super) fn read_file(path: &Path, delta: &mut FileDelta) -> Result<(), ()> {
    let file = File::open(path).map_err(|_| ())?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();
    let mut raw_rows: Vec<(usize, Value)> = Vec::new();
    let mut line_index = 0usize;

    loop {
        buffer.clear();
        let bytes = reader.read_until(b'\n', &mut buffer).map_err(|_| ())?;
        if bytes == 0 {
            break;
        }
        line_index += 1;
        if buffer.len() > MAX_JSON_LINE_BYTES {
            continue;
        }
        if !contains_any_str(
            &buffer,
            &["PLANNER_RESPONSE", "Model Selection", "input_tokens", "inputTokens"],
        ) {
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&buffer) {
            raw_rows.push((line_index, value));
        }
    }

    // Track latest record per `step_index` for PLANNER_RESPONSE (in-place updates
    // such as RUNNING -> DONE or token revisions replace earlier snapshots), while
    // keeping USER_INPUT model-selection changes in step_index order.
    let mut selection_events: Vec<(u64, usize, String)> = Vec::new();
    let mut latest_by_step: BTreeMap<u64, (usize, Value)> = BTreeMap::new();
    let mut stepless_rows: Vec<(usize, Value)> = Vec::new();

    for (idx, row) in raw_rows {
        let step = row.get("step_index").and_then(Value::as_u64);
        if let Some(model) = extract_settings_model(&row) {
            selection_events.push((step.unwrap_or(0), idx, model));
        }
        if let Some(step) = step {
            if row.get("type").and_then(Value::as_str) == Some("PLANNER_RESPONSE")
                || row.get("type").is_none()
            {
                latest_by_step.insert(step, (idx, row));
            }
        } else if is_countable_record(&row) {
            stepless_rows.push((idx, row));
        }
    }

    selection_events.sort_by_key(|(step, idx, _)| (*step, *idx));
    let mut selection_by_step: BTreeMap<u64, String> = BTreeMap::new();
    for (step, _, model) in &selection_events {
        selection_by_step.insert(*step, model.clone());
    }
    let fallback_selection = if selection_by_step.is_empty() {
        sibling_settings_model(path)
    } else {
        None
    };

    let native_index = load_native_model_index(path);

    let ordered_records: Vec<(Option<u64>, Value)> = latest_by_step
        .into_iter()
        .map(|(step, (_, row))| (Some(step), row))
        .chain(stepless_rows.into_iter().map(|(_, row)| (None, row)))
        .collect();

    for (step, row) in ordered_records {
        if !is_countable_record(&row) {
            continue;
        }
        let Some(counter) = extract_tokens(&row) else {
            continue;
        };
        let Some(time) = sample_time(&row, path) else {
            continue;
        };

        let explicit_model = row
            .get("model")
            .and_then(Value::as_str)
            .and_then(parse_model_label);
        let selected_model = step
            .and_then(|s| selection_by_step.range(..=s).next_back().map(|(_, m)| m.clone()))
            .or_else(|| fallback_selection.clone());
        let native_model = native_index
            .as_ref()
            .and_then(|index| index.model_for_step(step))
            .map(str::to_string);

        let chosen = explicit_model.or(selected_model);
        let resolved_model = match chosen {
            Some(ref m) if is_orchestrator(m) => native_model.or_else(|| {
                orchestrator_mode(m).map(|mode| orchestrator_base_model(mode).to_string())
            }),
            Some(ref m) if is_orchestrator_worker(m) => native_model
                .filter(|nm| !is_unresolved_worker_target(nm))
                .or_else(|| Some("gemini-4-hydrogen".to_string())),
            Some(m) => Some(m),
            None => native_model,
        };

        record_sample(delta, time, resolved_model, counter);
    }

    Ok(())
}
