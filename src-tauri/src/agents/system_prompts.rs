use super::*;
use crate::core_config::{
    core_config_uses_v8, core_tls_settings_from_value, lock_core_config_file,
    managed_core_tls_enabled, read_core_config_document,
};
use crate::GuiConfigState;
use flate2::read::GzDecoder;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, HOST};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tokio::sync::oneshot;

type UpstreamClient =
    Client<hyper_rustls::HttpsConnector<HttpConnector>, BoxBody<Bytes, hyper::Error>>;

const AGENT_SYSTEM_PROMPTS_DIR: &str = "agent-prompts";
const AGENT_SYSTEM_PROMPTS_FILE: &str = "agent-system-prompts.json";
const STORAGE_VERSION: u32 = 1;
const BASE_PROXY_PORT: u16 = 18320;
const MAX_PROMPT_BYTES: usize = 262_144;
const MAX_REWRITE_BODY_BYTES: usize = 32 * 1024 * 1024;
/// The loopback prompt endpoint only speaks plain HTTP; enabling rewriting against a TLS
/// kernel would downgrade the client connection, so both activation paths refuse it.
const TLS_LOOPBACK_UNSUPPORTED: &str = "Custom system prompts need the loopback prompt proxy, which only listens over plain HTTP. Turn off TLS for the local kernel first, then save the prompt again.";

pub(crate) const SYSTEM_PROMPT_CLIENTS: [&str; 15] = [
    "claude-code",
    "claude-desktop",
    "deepseek-harness",
    "opencode",
    "omp",
    "pi",
    "grok-build",
    "copilot-cli",
    "vscode-copilot",
    "antigravity-cli",
    "workbuddy",
    "zcode",
    "kimi-code",
    "openclaw",
    "hermes",
];

const ZCODE_DEFAULT_SYSTEM_PROMPT: &str = "\
You are ZCode, an interactive agent

You are an agent working with the user toward their goals, using your own judgment along the way.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.

# Harness
 - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.
 - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
 - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.
 - Reference code as `file_path:line_number` — it's clickable.";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PromptRewriteMode {
    #[default]
    Replace,
    Prepend,
    Append,
}

fn default_preserve_dynamic() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSystemPromptRule {
    pub prompt: String,
    #[serde(default)]
    pub mode: PromptRewriteMode,
    #[serde(default = "default_preserve_dynamic")]
    pub preserve_dynamic_context: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedClientPromptConfig {
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    default_rule: Option<AgentSystemPromptRule>,
    #[serde(default)]
    models: BTreeMap<String, AgentSystemPromptRule>,
    #[serde(default)]
    observed_default_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    overrides_enabled: Option<bool>,
}

impl SavedClientPromptConfig {
    fn normalize_for_client(&mut self, client_id: &str) {
        if !supports_override_switch(client_id) {
            self.overrides_enabled = None;
        }
    }

    fn has_active_rules(&self) -> bool {
        self.overrides_enabled != Some(false) && self.has_saved_rules()
    }

    fn has_saved_rules(&self) -> bool {
        self.default_rule
            .as_ref()
            .is_some_and(|rule| !rule.prompt.trim().is_empty())
            || self
                .models
                .values()
                .any(|rule| !rule.prompt.trim().is_empty())
    }

    fn resolve_rule(&self, model: Option<&str>) -> Option<&AgentSystemPromptRule> {
        if self.overrides_enabled == Some(false) {
            return None;
        }
        if let Some(raw_model) = model.map(str::trim).filter(|m| !m.is_empty()) {
            for candidate in candidate_model_ids(raw_model) {
                if let Some(rule) = self.models.get(candidate) {
                    if !rule.prompt.trim().is_empty() {
                        return Some(rule);
                    }
                }
            }
        }
        self.default_rule
            .as_ref()
            .filter(|rule| !rule.prompt.trim().is_empty())
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedAgentSystemPromptsFile {
    version: u32,
    #[serde(default)]
    clients: BTreeMap<String, SavedClientPromptConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSystemPromptEditorModel {
    pub id: String,
    pub customized: bool,
    pub prompt: String,
    pub default_prompt: String,
    pub mode: PromptRewriteMode,
    pub preserve_dynamic_context: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSystemPromptEditorSnapshot {
    pub client: String,
    pub default_prompt: String,
    pub builtin_default_prompt: String,
    pub default_source: String,
    pub default_customized: bool,
    pub default_mode: PromptRewriteMode,
    pub default_preserve_dynamic_context: bool,
    pub overrides_enabled: Option<bool>,
    pub proxy_active: bool,
    pub proxy_port: Option<u16>,
    /// The loopback listener is plaintext HTTP; a TLS-enabled kernel must not be downgraded
    /// silently, so the editor blocks saving until TLS is turned off.
    pub core_tls_enabled: bool,
    pub models: Vec<AgentSystemPromptEditorModel>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSystemPromptModelSaveItem {
    pub id: String,
    pub customized: bool,
    pub prompt: String,
    #[serde(default)]
    pub mode: PromptRewriteMode,
    #[serde(default = "default_preserve_dynamic")]
    pub preserve_dynamic_context: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSystemPromptEditorSaveRequest {
    pub client: String,
    #[serde(default)]
    pub overrides_enabled: Option<bool>,
    pub default_customized: bool,
    pub default_prompt: String,
    #[serde(default)]
    pub default_mode: PromptRewriteMode,
    #[serde(default = "default_preserve_dynamic")]
    pub default_preserve_dynamic_context: bool,
    #[serde(default)]
    pub models: Vec<AgentSystemPromptModelSaveItem>,
}

struct RunningClientListener {
    port: u16,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl RunningClientListener {
    fn is_alive(&self) -> bool {
        !self.task.is_finished()
    }

    fn stop(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.task.abort();
    }
}

#[derive(Default)]
struct GlobalPromptState {
    storage_path: Option<PathBuf>,
    clients: BTreeMap<String, SavedClientPromptConfig>,
    active_ports: HashMap<String, u16>,
}

static PROMPT_STATE: LazyLock<Mutex<GlobalPromptState>> =
    LazyLock::new(|| Mutex::new(GlobalPromptState::default()));

static PROMPT_LISTENERS: LazyLock<Mutex<HashMap<String, RunningClientListener>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static PROMPT_PROXY_OP_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

fn normalize_prompt_client_id(client: &str) -> Result<&'static str, String> {
    let trimmed = client.trim().to_ascii_lowercase();
    SYSTEM_PROMPT_CLIENTS
        .iter()
        .copied()
        .find(|candidate| *candidate == trimmed)
        .ok_or_else(|| format!("Unsupported agent client for system prompt editing: {client}"))
}

fn supports_override_switch(client_id: &str) -> bool {
    matches!(client_id, "claude-code" | "claude-desktop")
}

fn preferred_proxy_port(client_id: &str) -> u16 {
    let index = SYSTEM_PROMPT_CLIENTS
        .iter()
        .position(|candidate| *candidate == client_id)
        .unwrap_or(0) as u16;
    BASE_PROXY_PORT + index
}

fn candidate_model_ids(raw: &str) -> Vec<&str> {
    let trimmed = raw.trim();
    let mut out = vec![trimmed];
    if let Some(rest) = trimmed.strip_prefix("cpa-gui/") {
        if !rest.is_empty() && !out.contains(&rest) {
            out.push(rest);
        }
    }
    if let Some(rest) = trimmed.strip_prefix("CPA:") {
        if !rest.is_empty() && !out.contains(&rest) {
            out.push(rest);
        }
    }
    if let Some(base) = trimmed.strip_suffix("[1m]") {
        if !base.is_empty() && !out.contains(&base) {
            out.push(base);
        }
    }
    out
}

fn validate_prompt_text(prompt: &str) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("System prompt cannot be empty".to_string());
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err("System prompt exceeds the 256 KiB limit".to_string());
    }
    if prompt.contains('\0') {
        return Err("System prompt cannot contain null characters".to_string());
    }
    Ok(prompt.replace("\r\n", "\n"))
}

fn validate_model_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() || trimmed.len() > 512 || trimmed.chars().any(char::is_control) {
        return Err("Invalid model identifier".to_string());
    }
    Ok(trimmed.to_string())
}

pub(crate) fn agent_system_prompts_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to get application data directory: {error}"))?;
    Ok(app_data
        .join(AGENT_SYSTEM_PROMPTS_DIR)
        .join(AGENT_SYSTEM_PROMPTS_FILE))
}

pub(crate) fn load_agent_system_prompts(app: &tauri::AppHandle) -> Result<(), String> {
    let path = agent_system_prompts_path(app)?;
    load_agent_system_prompts_from_path(&path)
}

fn load_agent_system_prompts_from_path(path: &Path) -> Result<(), String> {
    let mut parsed = match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str::<SavedAgentSystemPromptsFile>(&content)
            .map_err(|error| format!("Invalid agent system prompts file: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => SavedAgentSystemPromptsFile {
            version: STORAGE_VERSION,
            clients: BTreeMap::new(),
        },
        Err(error) => {
            return Err(format!("Failed to read agent system prompts file: {error}"));
        }
    };

    let mut active_ports = HashMap::new();
    for (client, cfg) in &mut parsed.clients {
        cfg.normalize_for_client(client);
        if cfg.has_active_rules() {
            let port = cfg
                .port
                .filter(|p| *p > 0)
                .unwrap_or_else(|| preferred_proxy_port(client));
            active_ports.insert(client.clone(), port);
        }
    }

    let mut guard = PROMPT_STATE
        .lock()
        .map_err(|_| "Agent system prompt state lock is poisoned".to_string())?;
    guard.storage_path = Some(path.to_path_buf());
    guard.clients = parsed.clients;
    guard.active_ports = active_ports;
    Ok(())
}

fn persist_prompt_state_locked(state: &GlobalPromptState) -> Result<(), String> {
    let Some(path) = state.storage_path.as_ref() else {
        return Ok(());
    };
    let payload = SavedAgentSystemPromptsFile {
        version: STORAGE_VERSION,
        clients: state.clients.clone(),
    };
    let mut bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|error| format!("Failed to serialize agent system prompts: {error}"))?;
    bytes.push(b'\n');
    crate::core_config::write_bytes_atomically(path, &bytes)
}

pub(crate) fn agent_effective_loopback_origin(client_id: &str, core_port: u16) -> String {
    if let Ok(origin) = crate::remote_cpa::AGENT_ORIGIN.try_with(Clone::clone) { return origin; }
    let normalized = client_id.trim().to_ascii_lowercase();
    if let Ok(guard) = PROMPT_STATE.lock() {
        if let Some(&proxy_port) = guard.active_ports.get(&normalized) {
            if proxy_port > 0 {
                return format!("http://127.0.0.1:{proxy_port}");
            }
        }
    }
    managed_core_loopback_origin(core_port)
}

pub(crate) fn restore_agent_prompt_proxies(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _op = PROMPT_PROXY_OP_LOCK.lock().await;
        // Start-up restoration must obey the same rule as the editor: a TLS kernel never gets
        // a plaintext loopback. Deactivate the persisted overrides and point the clients back
        // at the kernel instead of silently downgrading them.
        if managed_core_tls_enabled() {
            // Fail closed: without readable state assume every known client may hold rules.
            let clients: Vec<String> = match PROMPT_STATE.lock() {
                Ok(guard) => guard
                    .clients
                    .iter()
                    .filter(|(_, cfg)| cfg.has_active_rules())
                    .map(|(client, _)| client.clone())
                    .collect(),
                Err(_) => SYSTEM_PROMPT_CLIENTS.iter().map(|c| c.to_string()).collect(),
            };
            for client in clients {
                if let Err(error) = deactivate_prompt_overrides_for_tls(&app, &client) {
                    eprintln!("Failed to disable system prompt proxy for {client}: {error}");
                }
            }
            return;
        }
        let targets: Vec<(String, u16)> = {
            let Ok(guard) = PROMPT_STATE.lock() else {
                return;
            };
            guard
                .clients
                .iter()
                .filter(|(_, cfg)| cfg.has_active_rules())
                .map(|(client, cfg)| {
                    let port = cfg
                        .port
                        .filter(|p| *p > 0)
                        .unwrap_or_else(|| preferred_proxy_port(client));
                    (client.clone(), port)
                })
                .collect()
        };

        for (client, preferred) in targets {
            if let Err(error) = ensure_client_proxy_listener(&client, preferred, Some(&app)).await {
                eprintln!("Failed to restore system prompt proxy for {client}: {error}");
            }
        }
    });
}

/// Stops the plaintext listener and restores the kernel origin. Claude rules can be
/// retained in a paused state; clients without a switch keep the existing clearing behavior.
fn deactivate_prompt_overrides_for_tls(
    app: &tauri::AppHandle,
    client_id: &str,
) -> Result<(), String> {
    let Some(gui_config) = app
        .try_state::<GuiConfigState>()
        .and_then(|state| state.snapshot().ok())
    else {
        return Err("GUI configuration is unavailable".to_string());
    };
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Failed to get user directory".to_string())?;
    let proxy_origin = PROMPT_STATE
        .lock()
        .ok()
        .and_then(|guard| guard.active_ports.get(client_id).copied())
        .filter(|port| *port > 0)
        .map(|port| format!("http://127.0.0.1:{port}"))
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", preferred_proxy_port(client_id)));

    // Resolve the kernel origin before the active port is cleared: while the entry is still
    // active this helper would report the proxy itself.
    let kernel_origin = managed_core_loopback_origin(gui_config.port);
    // The plaintext listener must go down no matter what happens to the client config, so the
    // rewrite error is reported after the shutdown rather than short-circuiting it.
    let rewrite_result = {
        let file_guard = crate::AGENT_CONFIG_FILE_LOCK.lock();
        match file_guard {
            Ok(_file_guard) => {
                sync_configured_agent_origin(client_id, &home, &proxy_origin, &kernel_origin)
            }
            Err(_) => Err("Agent configuration file lock is poisoned".to_string()),
        }
    };

    let cleared = {
        match PROMPT_STATE.lock() {
            Ok(mut guard) => {
                let entry = guard.clients.entry(client_id.to_string()).or_default();
                if supports_override_switch(client_id) {
                    entry.overrides_enabled = Some(false);
                } else {
                    entry.default_rule = None;
                    entry.models.clear();
                }
                guard.active_ports.remove(client_id);
                persist_prompt_state_locked(&guard)
            }
            Err(_) => Err("Agent system prompt state lock is poisoned".to_string()),
        }
    };
    stop_client_proxy_listener(client_id);

    rewrite_result?;
    cleared?;
    Ok(())
}

fn builtin_template_for_client(client_id: &str) -> &'static str {
    match client_id {
        "zcode" => ZCODE_DEFAULT_SYSTEM_PROMPT,
        "claude-code" => "\
You are Claude Code, an interactive CLI coding agent that helps users with software engineering tasks.
Use the available file, search, and execution tools carefully, ground claims in observed repository evidence, keep edits minimal and idiomatic, and verify changes when appropriate.",
        "claude-desktop" => "\
You are Claude, a helpful, accurate, and thoughtful AI assistant.
Respond clearly, follow the user's instructions carefully, and state assumptions or uncertainties transparently.",
        "opencode" => "\
You are OpenCode, an interactive CLI coding agent.
Inspect files before editing, follow repository conventions, prefer concise and direct responses, and validate changes with targeted checks.",
        "deepseek-harness" => "\
You are DeepSeek Harness, an autonomous software engineering agent.
Understand the codebase before making edits, use tools methodically, keep changes focused on the root cause, and report verified outcomes.",
        "omp" => "\
You are Oh My Pi, an interactive coding agent.
Use the provided tools to read, search, edit, and run commands safely while keeping explanations concise and accurate.",
        "pi" => "\
You are Pi, a minimal and capable terminal coding agent.
Solve tasks directly using your tools, respect existing project structure and conventions, and verify your work.",
        "grok-build" => "\
You are Grok Build, a coding agent focused on fast, accurate software development.
Inspect relevant files, apply clean minimal fixes, and verify results.",
        "copilot-cli" => "\
You are GitHub Copilot CLI, a terminal-based AI coding assistant.
Help the user inspect, edit, debug, and run commands safely and concisely.",
        "vscode-copilot" => "\
You are GitHub Copilot in Visual Studio Code, an AI pair programmer.
Provide accurate, idiomatic code changes and concise technical explanations.",
        "antigravity-cli" => "\
You are Antigravity, an agentic coding assistant.
Explore the workspace methodically, follow project conventions, make surgical edits, and verify outcomes from real evidence.",
        "workbuddy" => "\
You are WorkBuddy, an AI coding and productivity assistant.
Help users understand codebases, implement clean solutions, and solve technical problems step by step.",
        "kimi-code" => "\
You are Kimi Code, an interactive coding agent in the terminal.
Read context carefully, use tools accurately, and deliver clean, well-verified code changes.",
        "openclaw" => "\
You are OpenClaw, an autonomous AI assistant and coding agent.
Use your configured tools and workspace context to complete tasks accurately and concisely.",
        "hermes" => "\
You are Hermes Agent, an autonomous AI agent.
Execute tasks methodically using available tools, verify results, and communicate concisely.",
        _ => "You are a helpful AI coding assistant.",
    }
}

fn extract_js_string_literal_after(haystack: &str, needle: &str) -> Option<String> {
    let idx = haystack.find(needle)?;
    let rest = &haystack[idx + needle.len()..];
    let mut chars = rest.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let mut out = String::new();
    let mut escaped = false;
    for ch in chars {
        if escaped {
            match ch {
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                '\\' => out.push('\\'),
                '"' => out.push('"'),
                '\'' => out.push('\''),
                other => {
                    out.push('\\');
                    out.push(other);
                }
            }
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
        } else if ch == quote {
            return Some(out);
        } else {
            out.push(ch);
            if out.len() > 16_384 {
                return None;
            }
        }
    }
    None
}

fn try_extract_zcode_installed_prompt(home: &Path) -> Option<String> {
    let exe = find_zcode_desktop_executable(home)?;
    let resources = exe
        .parent()?
        .join("resources")
        .join("glm")
        .join("zcode.cjs");
    if !resources.is_file() {
        return None;
    }
    let content = fs::read_to_string(&resources).ok()?;
    let prefix_pos = content.find("\"You are ZCode, an interactive agent\"")?;
    let window_start = prefix_pos.saturating_sub(256);
    let window_end = (prefix_pos + 4096).min(content.len());
    let slice = &content[window_start..window_end];

    let cli_prefix = extract_js_string_literal_after(slice, "sJa=")
        .unwrap_or_else(|| "You are ZCode, an interactive agent".to_string());
    let identity = extract_js_string_literal_after(slice, "aJa=")?;
    let security = extract_js_string_literal_after(slice, "eWo=").unwrap_or_default();

    let mut assembled = format!("{cli_prefix}\n\n{identity}");
    if !security.is_empty() {
        assembled.push_str("\n\n");
        assembled.push_str(&security);
    }
    assembled.push_str(
        "\n\n# Harness\n - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n - Tools run behind a user-selected permission mode; a denied call means the user declined it \u{2014} adjust, don't retry verbatim.\n - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n - Reference code as `file_path:line_number` \u{2014} it's clickable.",
    );
    Some(assembled)
}

fn resolve_builtin_default_prompt(
    client_id: &str,
    home: &Path,
    observed: Option<&str>,
) -> (String, &'static str) {
    if let Some(obs) = observed.map(str::trim).filter(|s| !s.is_empty()) {
        return (obs.to_string(), "observed");
    }
    if client_id == "zcode" {
        if let Some(installed) = try_extract_zcode_installed_prompt(home) {
            return (installed, "installed");
        }
    }
    (
        builtin_template_for_client(client_id).to_string(),
        "template",
    )
}

pub(crate) fn zcode_model_system_prompts_for_editor(
    home: &Path,
) -> (String, BTreeMap<String, String>) {
    let (default_rule, models, observed) = {
        let Ok(guard) = PROMPT_STATE.lock() else {
            return (ZCODE_DEFAULT_SYSTEM_PROMPT.to_string(), BTreeMap::new());
        };
        let cfg = guard.clients.get("zcode").cloned().unwrap_or_default();
        (cfg.default_rule, cfg.models, cfg.observed_default_prompt)
    };
    let (builtin_default, _) = resolve_builtin_default_prompt("zcode", home, observed.as_deref());
    let effective_default = default_rule
        .filter(|r| !r.prompt.trim().is_empty())
        .map(|r| r.prompt)
        .unwrap_or(builtin_default);
    let overrides = models
        .into_iter()
        .filter(|(_, rule)| !rule.prompt.trim().is_empty())
        .map(|(id, rule)| (id, rule.prompt))
        .collect();
    (effective_default, overrides)
}

pub(crate) async fn sync_zcode_catalog_model_prompts(
    app: &tauri::AppHandle,
    home: &Path,
    core_port: u16,
    model_prompts: Vec<(String, Option<String>)>,
) -> Result<(), String> {
    let _op = PROMPT_PROXY_OP_LOCK.lock().await;
    let old_origin = agent_effective_loopback_origin("zcode", core_port);
    let (effective_default, _) = zcode_model_system_prompts_for_editor(home);

    let wants_active = model_prompts
        .iter()
        .any(|(_, prompt)| prompt.as_deref().is_some_and(|p| !p.trim().is_empty()));
    if wants_active && managed_core_tls_enabled() {
        return Err(TLS_LOOPBACK_UNSUPPORTED.to_string());
    }

    let (has_active, preferred_port) = {
        let mut guard = PROMPT_STATE
            .lock()
            .map_err(|_| "Agent system prompt state lock is poisoned".to_string())?;
        if guard.storage_path.is_none() {
            guard.storage_path = Some(agent_system_prompts_path(app)?);
        }
        let entry = guard.clients.entry("zcode".to_string()).or_default();
        for (model_id, maybe_prompt) in model_prompts {
            let model_id = validate_model_id(&model_id)?;
            match maybe_prompt {
                Some(prompt) => {
                    let normalized = validate_prompt_text(&prompt)?;
                    if normalized.trim() == effective_default.trim() {
                        entry.models.remove(&model_id);
                    } else {
                        let existing_mode = entry
                            .models
                            .get(&model_id)
                            .map(|r| r.mode)
                            .unwrap_or(PromptRewriteMode::Replace);
                        let existing_preserve = entry
                            .models
                            .get(&model_id)
                            .map(|r| r.preserve_dynamic_context)
                            .unwrap_or(true);
                        entry.models.insert(
                            model_id,
                            AgentSystemPromptRule {
                                prompt: normalized,
                                mode: existing_mode,
                                preserve_dynamic_context: existing_preserve,
                            },
                        );
                    }
                }
                None => {
                    entry.models.remove(&model_id);
                }
            }
        }
        let has_active = entry.has_active_rules();
        let port = entry
            .port
            .filter(|p| *p > 0)
            .unwrap_or_else(|| preferred_proxy_port("zcode"));
        if !has_active {
            guard.active_ports.remove("zcode");
        }
        persist_prompt_state_locked(&guard)?;
        (has_active, port)
    };

    if has_active && managed_core_tls_enabled() {
        return Err(TLS_LOOPBACK_UNSUPPORTED.to_string());
    }

    if has_active {
        ensure_client_proxy_listener("zcode", preferred_port, Some(app)).await?;
    } else {
        stop_client_proxy_listener("zcode");
    }

    let new_origin = agent_effective_loopback_origin("zcode", core_port);
    if old_origin != new_origin {
        let _guard = crate::AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "Agent configuration file lock is poisoned".to_string())?;
        sync_configured_agent_origin("zcode", home, &old_origin, &new_origin)?;
    }
    Ok(())
}

fn record_observed_prompt(client_id: &str, observed: &str) {
    let trimmed = observed.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_PROMPT_BYTES {
        return;
    }
    let Ok(mut guard) = PROMPT_STATE.lock() else {
        return;
    };
    let entry = guard.clients.entry(client_id.to_string()).or_default();
    if entry.observed_default_prompt.as_deref() == Some(trimmed) {
        return;
    }
    entry.observed_default_prompt = Some(trimmed.to_string());
    let _ = persist_prompt_state_locked(&guard);
}

fn is_dynamic_context_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("<env>")
        || trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("Here is useful information about the environment")
        || trimmed.starts_with("# Environment\n")
        || trimmed.starts_with("# Environment\r\n")
        || trimmed.starts_with("# Memory\n")
        || trimmed.starts_with("# Memory\r\n")
        || trimmed.starts_with("# ZCode Desktop Context")
        || trimmed.starts_with("Current date:")
        || trimmed.starts_with("Today's date is ")
        || trimmed.starts_with("gitStatus:")
        || trimmed.starts_with("<system-reminder>")
}

fn split_inline_dynamic_tail(text: &str) -> (&str, Option<&str>) {
    for marker in [
        "\n\n<env>",
        "\n<env>",
        "\n\n<environment_context>",
        "\n\nHere is useful information about the environment",
        "\n\n# Environment\n",
        "\n\n# Memory\n",
    ] {
        if let Some(idx) = text.find(marker) {
            if idx > 0 {
                let tail_start = idx + if marker.starts_with("\n\n") { 2 } else { 1 };
                return (&text[..idx], Some(&text[tail_start..]));
            }
        }
    }
    (text, None)
}

fn apply_rule_text(existing_base: &str, rule: &AgentSystemPromptRule) -> String {
    let custom = rule.prompt.trim();
    match rule.mode {
        PromptRewriteMode::Replace => custom.to_string(),
        PromptRewriteMode::Prepend => {
            if existing_base.trim().is_empty() {
                custom.to_string()
            } else {
                format!("{custom}\n\n{}", existing_base.trim_start())
            }
        }
        PromptRewriteMode::Append => {
            if existing_base.trim().is_empty() {
                custom.to_string()
            } else {
                format!("{}\n\n{custom}", existing_base.trim_end())
            }
        }
    }
}

fn is_utility_system_prompt(text: &str) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    lower.starts_with("you are an assistant for performing a web search")
        || lower.starts_with("generate a concise")
        || lower.starts_with("extract a concise")
        || lower.starts_with("write a concise")
        || lower.starts_with("summarize this coding conversation")
        || lower.starts_with("you are a helpful ai assistant tasked with summarizing")
}

/// System prompts of helper calls that only reshape content: web search, titles, summaries.
/// They are recognised by their instruction ("Name this chat", "Generate a concise ...") rather
/// than by size, because a short user turn looks identical on the wire.
fn is_helper_task_system_prompt(text: Option<&str>) -> bool {
    let Some(text) = text else {
        return false;
    };
    let lower = text.trim().to_ascii_lowercase();
    if lower.is_empty() || lower.len() > 2048 {
        return false;
    }
    is_utility_system_prompt(&lower)
        || lower.starts_with("name this chat")
        || lower.starts_with("name the conversation")
        || lower.starts_with("suggest a title")
        || lower.starts_with("create a title")
        || lower.starts_with("generate a title")
        || lower.contains("generate a short title")
        || lower.contains("concise title for this conversation")
        || lower.contains("rewrite the prompt")
        || lower.contains("improve the following prompt")
}

fn is_short_toolless_helper_call(client_id: &str, root: &Map<String, Value>) -> bool {
    if client_id == "claude-desktop" {
        return false;
    }
    // A short tool-less request is either a side-channel helper call or a brief user turn.
    // Helper calls name the job they do ("Name this chat"), so only a system prompt that
    // asks for one of those tasks is skipped; an ordinary chat keeps the custom prompt.
    if !is_helper_task_system_prompt(primary_system_text(root).as_deref()) {
        return false;
    }
    let has_tools = root
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty());
    if has_tools {
        return false;
    }
    let max_tokens = root
        .get("max_tokens")
        .or_else(|| root.get("max_completion_tokens"))
        .or_else(|| root.get("max_output_tokens"))
        .and_then(Value::as_u64);
    max_tokens.is_some_and(|limit| limit > 0 && limit <= 256)
}

fn primary_system_text(root: &Map<String, Value>) -> Option<String> {
    // Responses puts the instructions in a top-level string rather than in a message list.
    if let Some(instructions) = root.get("instructions").and_then(Value::as_str) {
        return Some(instructions.to_string());
    }
    if let Some(system) = root.get("system") {
        if let Some(text) = system.as_str() {
            return Some(text.to_string());
        }
        if let Some(items) = system.as_array() {
            return Some(
                items
                    .iter()
                    .filter_map(|item| {
                        item.get("text")
                            .and_then(Value::as_str)
                            .or_else(|| item.as_str())
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n"),
            );
        }
        return None;
    }
    let collect = |items: &Vec<Value>| -> Option<String> {
        let mut parts = Vec::new();
        for item in items {
            let role = item.get("role").and_then(Value::as_str).unwrap_or("");
            let is_system = matches!(role, "system" | "developer");
            if !is_system {
                break;
            }
            parts.push(extract_message_content_text(
                item.get("content").unwrap_or(&Value::Null),
            ));
        }
        (!parts.is_empty()).then(|| parts.join("\n\n"))
    };
    if let Some(messages) = root.get("messages").and_then(Value::as_array) {
        if let Some(text) = collect(messages) {
            return Some(text);
        }
    }
    root.get("input")
        .and_then(Value::as_array)
        .and_then(collect)
}

fn rewrite_anthropic_messages_json(
    client_id: &str,
    cfg: &SavedClientPromptConfig,
    root: &mut Map<String, Value>,
) -> Option<Option<String>> {
    if is_short_toolless_helper_call(client_id, root) {
        return None;
    }
    let model = root
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut static_parts: Vec<String> = Vec::new();
    let mut dynamic_blocks: Vec<Value> = Vec::new();
    let mut saw_dynamic = false;
    let mut preserved_cache_control: Option<Value> = None;
    let mut was_array = false;

    match root.get("system") {
        Some(Value::String(s)) => {
            if is_utility_system_prompt(s) {
                return None;
            }
            let (base, tail) = split_inline_dynamic_tail(s);
            static_parts.push(base.to_string());
            if let Some(tail_text) = tail {
                dynamic_blocks.push(json!({ "type": "text", "text": tail_text }));
            }
        }
        Some(Value::Array(items)) => {
            was_array = true;
            for (index, item) in items.iter().enumerate() {
                let text = item
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| item.as_str())
                    .unwrap_or("");
                if index == 0 && is_utility_system_prompt(text) {
                    return None;
                }
                if !saw_dynamic && index >= 1 && is_dynamic_context_text(text) {
                    saw_dynamic = true;
                }
                if saw_dynamic {
                    dynamic_blocks.push(item.clone());
                } else {
                    if preserved_cache_control.is_none() {
                        if let Some(cc) = item
                            .get("cache_control")
                            .or_else(|| item.get("cacheControl"))
                        {
                            preserved_cache_control = Some(cc.clone());
                        }
                    }
                    if !text.is_empty() {
                        static_parts.push(text.to_string());
                    }
                }
            }
        }
        _ => {}
    }

    let observed_base = static_parts.join("\n\n");
    let rule = cfg.resolve_rule(model.as_deref())?;
    let rewritten_base = apply_rule_text(&observed_base, rule);

    let keep_dynamic = match rule.mode {
        PromptRewriteMode::Replace => rule.preserve_dynamic_context,
        PromptRewriteMode::Prepend | PromptRewriteMode::Append => true,
    };

    if was_array || (keep_dynamic && !dynamic_blocks.is_empty()) {
        let mut base_block = Map::new();
        base_block.insert("type".to_string(), Value::String("text".to_string()));
        base_block.insert("text".to_string(), Value::String(rewritten_base));
        // Only carry a cache breakpoint that the client already declared. Adding one
        // unconditionally creates a fresh ephemeral breakpoint on every request and can
        // exceed Anthropic's per-request breakpoint limit.
        if let Some(cache_control) = preserved_cache_control {
            base_block.insert("cache_control".to_string(), cache_control);
        }
        let mut new_blocks = vec![Value::Object(base_block)];
        if keep_dynamic {
            new_blocks.extend(dynamic_blocks);
        }
        root.insert("system".to_string(), Value::Array(new_blocks));
    } else {
        root.insert("system".to_string(), Value::String(rewritten_base));
    }

    Some((!observed_base.trim().is_empty()).then_some(observed_base))
}

fn extract_message_content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn rewrite_openai_chat_json(
    client_id: &str,
    cfg: &SavedClientPromptConfig,
    root: &mut Map<String, Value>,
) -> Option<Option<String>> {
    if is_short_toolless_helper_call(client_id, root) {
        return None;
    }
    let model = root
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let messages = root.get_mut("messages")?.as_array_mut()?;

    let mut sys_indices: Vec<usize> = Vec::new();
    let mut primary_role = "system".to_string();
    for (idx, msg) in messages.iter().enumerate() {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "system" || role == "developer" {
            if sys_indices.is_empty() {
                primary_role = role.to_string();
            }
            sys_indices.push(idx);
        } else {
            break;
        }
    }

    let mut static_parts = Vec::new();
    let mut dynamic_messages = Vec::new();
    let mut inline_dynamic_tail: Option<String> = None;
    let mut saw_dynamic = false;

    for (pos, &msg_idx) in sys_indices.iter().enumerate() {
        let text = messages[msg_idx]
            .get("content")
            .map(extract_message_content_text)
            .unwrap_or_default();
        if pos == 0 && is_utility_system_prompt(&text) {
            return None;
        }
        if !saw_dynamic && pos >= 1 && is_dynamic_context_text(&text) {
            saw_dynamic = true;
        }
        if saw_dynamic {
            dynamic_messages.push(messages[msg_idx].clone());
        } else if pos == 0 && sys_indices.len() == 1 {
            let (base, tail) = split_inline_dynamic_tail(&text);
            static_parts.push(base.to_string());
            if let Some(t) = tail {
                inline_dynamic_tail = Some(t.to_string());
            }
        } else if !text.is_empty() {
            static_parts.push(text);
        }
    }

    let observed_base = static_parts.join("\n\n");
    let rule = cfg.resolve_rule(model.as_deref())?;
    let mut rewritten = apply_rule_text(&observed_base, rule);

    let keep_dynamic = match rule.mode {
        PromptRewriteMode::Replace => rule.preserve_dynamic_context,
        PromptRewriteMode::Prepend | PromptRewriteMode::Append => true,
    };

    if keep_dynamic {
        if let Some(tail) = inline_dynamic_tail {
            rewritten = format!("{rewritten}\n\n{tail}");
        }
    }

    for &idx in sys_indices.iter().rev() {
        messages.remove(idx);
    }

    let mut inserted = vec![json!({
        "role": primary_role,
        "content": rewritten,
    })];
    if keep_dynamic {
        inserted.extend(dynamic_messages);
    }
    for (offset, item) in inserted.into_iter().enumerate() {
        messages.insert(offset, item);
    }

    Some((!observed_base.trim().is_empty()).then_some(observed_base))
}

fn rewrite_openai_responses_json(
    client_id: &str,
    cfg: &SavedClientPromptConfig,
    root: &mut Map<String, Value>,
) -> Option<Option<String>> {
    if is_short_toolless_helper_call(client_id, root) {
        return None;
    }
    let model = root
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);

    if root.contains_key("instructions") || !root.contains_key("input") {
        let existing = root
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if is_utility_system_prompt(&existing) {
            return None;
        }
        let rule = cfg.resolve_rule(model.as_deref())?;
        let (base, tail) = split_inline_dynamic_tail(&existing);
        let mut rewritten = apply_rule_text(base, rule);
        if (rule.mode != PromptRewriteMode::Replace || rule.preserve_dynamic_context)
            && tail.is_some()
        {
            rewritten = format!("{rewritten}\n\n{}", tail.unwrap());
        }
        root.insert("instructions".to_string(), Value::String(rewritten));
        return Some((!base.trim().is_empty()).then_some(base.to_string()));
    }

    let rule = cfg.resolve_rule(model.as_deref())?;
    if let Some(Value::Array(items)) = root.get_mut("input") {
        if let Some(first) = items.first_mut() {
            let role = first.get("role").and_then(Value::as_str).unwrap_or("");
            if role == "developer" || role == "system" {
                let existing = first
                    .get("content")
                    .map(extract_message_content_text)
                    .unwrap_or_default();
                if is_utility_system_prompt(&existing) {
                    return None;
                }
                let (base, tail) = split_inline_dynamic_tail(&existing);
                let mut rewritten = apply_rule_text(base, rule);
                if (rule.mode != PromptRewriteMode::Replace || rule.preserve_dynamic_context)
                    && tail.is_some()
                {
                    rewritten = format!("{rewritten}\n\n{}", tail.unwrap());
                }
                if let Some(obj) = first.as_object_mut() {
                    obj.insert("content".to_string(), Value::String(rewritten));
                }
                return Some((!base.trim().is_empty()).then_some(base.to_string()));
            }
        }
    }

    root.insert(
        "instructions".to_string(),
        Value::String(rule.prompt.trim().to_string()),
    );
    Some(None)
}

fn extract_gemini_model_from_path(path: &str) -> Option<String> {
    let marker = "/models/";
    let idx = path.find(marker)?;
    let rest = &path[idx + marker.len()..];
    let model = rest.split([':', '/']).next()?.trim();
    (!model.is_empty()).then(|| model.to_string())
}

fn rewrite_gemini_json(
    path: &str,
    cfg: &SavedClientPromptConfig,
    root: &mut Map<String, Value>,
) -> Option<Option<String>> {
    let model = root
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| extract_gemini_model_from_path(path));

    let field_key = if root.contains_key("system_instruction") {
        "system_instruction"
    } else {
        "systemInstruction"
    };

    let existing = root
        .get(field_key)
        .and_then(|si| si.get("parts"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default();

    if is_utility_system_prompt(&existing) {
        return None;
    }

    let rule = cfg.resolve_rule(model.as_deref())?;
    let (base, tail) = split_inline_dynamic_tail(&existing);
    let mut rewritten = apply_rule_text(base, rule);
    if (rule.mode != PromptRewriteMode::Replace || rule.preserve_dynamic_context) && tail.is_some()
    {
        rewritten = format!("{rewritten}\n\n{}", tail.unwrap());
    }

    root.insert(
        field_key.to_string(),
        json!({
            "parts": [{ "text": rewritten }]
        }),
    );

    Some((!base.trim().is_empty()).then_some(base.to_string()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InferenceWireKind {
    AnthropicMessages,
    OpenAiChatCompletions,
    OpenAiResponses,
    GeminiGenerateContent,
}

fn detect_inference_wire_kind(path: &str) -> Option<InferenceWireKind> {
    let clean = path.trim_end_matches('/');
    if clean.ends_with("/v1/messages") || clean == "/messages" {
        return Some(InferenceWireKind::AnthropicMessages);
    }
    if clean.ends_with("/v1/chat/completions") || clean.ends_with("/chat/completions") {
        return Some(InferenceWireKind::OpenAiChatCompletions);
    }
    if clean.ends_with("/v1/responses") || clean == "/responses" {
        return Some(InferenceWireKind::OpenAiResponses);
    }
    if clean.contains(":generateContent") || clean.contains(":streamGenerateContent") {
        return Some(InferenceWireKind::GeminiGenerateContent);
    }
    None
}

pub(crate) fn rewrite_inference_body_bytes(
    client_id: &str,
    path: &str,
    body: &[u8],
) -> Option<Vec<u8>> {
    let kind = detect_inference_wire_kind(path)?;
    let cfg = {
        let guard = PROMPT_STATE.lock().ok()?;
        guard.clients.get(client_id)?.clone()
    };
    if !cfg.has_active_rules() {
        return None;
    }
    rewrite_inference_body_with_config(client_id, kind, path, &cfg, body).map(
        |(rewritten, observed)| {
            if let Some(obs) = observed {
                record_observed_prompt(client_id, &obs);
            }
            rewritten
        },
    )
}

fn rewrite_inference_body_with_config(
    client_id: &str,
    kind: InferenceWireKind,
    path: &str,
    cfg: &SavedClientPromptConfig,
    body: &[u8],
) -> Option<(Vec<u8>, Option<String>)> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    let root = value.as_object_mut()?;
    let observed = match kind {
        InferenceWireKind::AnthropicMessages => {
            rewrite_anthropic_messages_json(client_id, cfg, root)
        }
        InferenceWireKind::OpenAiChatCompletions => rewrite_openai_chat_json(client_id, cfg, root),
        InferenceWireKind::OpenAiResponses => rewrite_openai_responses_json(client_id, cfg, root),
        InferenceWireKind::GeminiGenerateContent => rewrite_gemini_json(path, cfg, root),
    }?;
    let encoded = serde_json::to_vec(&value).ok()?;
    Some((encoded, observed))
}

fn resolve_upstream_core_target(
    app: Option<&tauri::AppHandle>,
) -> Result<(UpstreamClient, bool, u16), String> {
    let mut roots = rustls::RootCertStore::empty();
    let mut tls_enabled = false;
    let mut core_port = app
        .and_then(|handle| handle.try_state::<GuiConfigState>())
        .and_then(|state| state.snapshot().ok())
        .map(|cfg| cfg.port)
        .filter(|p| *p > 0);

    if let Ok(_guard) = lock_core_config_file() {
        if let Ok(install_dir) = crate::core_runtime::core_install_dir() {
            if install_dir.join(crate::CORE_CONFIG_FILE).is_file() {
                if let Ok((_, document)) = read_core_config_document() {
                    if core_port.is_none() {
                        let port_val = if core_config_uses_v8(&document) {
                            document.get("server").and_then(|s| s.get("port"))
                        } else {
                            document.get("port")
                        };
                        core_port = port_val
                            .and_then(|v| v.as_u64())
                            .and_then(|p| u16::try_from(p).ok())
                            .filter(|p| *p > 0);
                    }
                    if let Ok(tls) = core_tls_settings_from_value(&document) {
                        tls_enabled = tls.enabled;
                        if tls_enabled {
                            let cert_path = install_dir.join(&tls.cert);
                            if let Ok(file) = File::open(&cert_path) {
                                for cert in
                                    rustls_pemfile::certs(&mut BufReader::new(file)).flatten()
                                {
                                    let _ = roots.add(cert);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let port = core_port.unwrap_or(8317);
    let _ = rustls::crypto::ring::default_provider().install_default();
    let tls_cfg = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = hyper_rustls::HttpsConnectorBuilder::new()
        .with_tls_config(tls_cfg)
        .https_or_http()
        .enable_http1()
        .build();
    Ok((
        Client::builder(TokioExecutor::new()).build(connector),
        tls_enabled,
        port,
    ))
}

fn prepare_proxy_request_headers(
    original: &hyper::HeaderMap,
    target_port: u16,
    body_rewritten: bool,
    new_len: Option<usize>,
) -> hyper::HeaderMap {
    let mut out = hyper::HeaderMap::new();
    for (name, value) in original.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "connection"
                | "keep-alive"
                | "expect"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "te"
                | "trailer"
                | "upgrade"
        ) {
            continue;
        }
        if body_rewritten
            && matches!(
                name.as_str(),
                "content-length" | "transfer-encoding" | "content-encoding"
            )
        {
            continue;
        }
        if name.as_str() == "host" {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    if let Ok(host_val) = hyper::header::HeaderValue::from_str(&format!("127.0.0.1:{target_port}"))
    {
        out.insert(HOST, host_val);
    }
    if body_rewritten {
        if let Some(len) = new_len {
            if let Ok(len_val) = hyper::header::HeaderValue::from_str(&len.to_string()) {
                out.insert(CONTENT_LENGTH, len_val);
            }
        }
    }
    out
}

fn maybe_gunzip(bytes: &[u8], headers: &hyper::HeaderMap) -> Option<Vec<u8>> {
    let is_gzip = headers
        .get(CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|enc| enc.trim().eq_ignore_ascii_case("gzip"));
    if !is_gzip {
        return Some(bytes.to_vec());
    }
    let mut decoder = GzDecoder::new(bytes);
    let mut decoded = Vec::new();
    decoder.read_to_end(&mut decoded).ok()?;
    if decoded.len() > MAX_REWRITE_BODY_BYTES {
        return None;
    }
    Some(decoded)
}

async fn handle_prompt_proxy_request(
    client_id: String,
    req: Request<Incoming>,
    upstream_override: Option<u16>,
    app: Option<tauri::AppHandle>,
) -> Result<Response<BoxBody<Bytes, hyper::Error>>, Infallible> {
    let (upstream_client, target_tls, detected_port) =
        match resolve_upstream_core_target(app.as_ref()) {
            Ok(tuple) => tuple,
            Err(error) => {
                return Ok(plain_error_response(
                    StatusCode::BAD_GATEWAY,
                    &format!("Prompt proxy failed to resolve kernel target: {error}"),
                ));
            }
        };
    let target_port = upstream_override.unwrap_or(detected_port);
    let scheme = if target_tls && upstream_override.is_none() {
        "https"
    } else {
        "http"
    };

    let (parts, incoming_body) = req.into_parts();
    let path = parts.uri.path().to_string();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target_uri_str = if path_and_query.starts_with('/') {
        format!("{scheme}://127.0.0.1:{target_port}{path_and_query}")
    } else {
        format!("{scheme}://127.0.0.1:{target_port}/{path_and_query}")
    };
    let Ok(target_uri) = target_uri_str.parse::<hyper::Uri>() else {
        return Ok(plain_error_response(
            StatusCode::BAD_REQUEST,
            "Invalid request URI",
        ));
    };

    // Existing keep-alive connections can outlive a listener shutdown. For paused
    // Claude clients, stream even those bodies unchanged rather than buffering them.
    let rewrite_enabled = !supports_override_switch(&client_id)
        || PROMPT_STATE.lock().is_ok_and(|state| {
            state
                .clients
                .get(&client_id)
                .is_some_and(SavedClientPromptConfig::has_active_rules)
        });
    let should_inspect_json = rewrite_enabled
        && parts.method == Method::POST
        && detect_inference_wire_kind(&path).is_some()
        && parts
            .headers
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.to_ascii_lowercase().contains("json"))
            .unwrap_or(true);

    let (outbound_body, rewritten_len) = if should_inspect_json {
        match Limited::new(incoming_body, MAX_REWRITE_BODY_BYTES)
            .collect()
            .await
        {
            Ok(collected) => {
                let raw_bytes = collected.to_bytes();
                if let Some(plain_bytes) = maybe_gunzip(&raw_bytes, &parts.headers) {
                    if let Some(rewritten) =
                        rewrite_inference_body_bytes(&client_id, &path, &plain_bytes)
                    {
                        let len = rewritten.len();
                        (
                            Full::new(Bytes::from(rewritten))
                                .map_err(|e| match e {})
                                .boxed(),
                            Some(len),
                        )
                    } else {
                        (Full::new(raw_bytes).map_err(|e| match e {}).boxed(), None)
                    }
                } else {
                    (Full::new(raw_bytes).map_err(|e| match e {}).boxed(), None)
                }
            }
            Err(_) => {
                return Ok(plain_error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Request payload exceeds 32 MiB prompt proxy limit",
                ));
            }
        }
    } else {
        (incoming_body.boxed(), None)
    };

    let forwarded_headers = prepare_proxy_request_headers(
        &parts.headers,
        target_port,
        rewritten_len.is_some(),
        rewritten_len,
    );

    let mut builder = Request::builder().method(parts.method).uri(target_uri);
    if let Some(headers_mut) = builder.headers_mut() {
        *headers_mut = forwarded_headers;
    }
    let Ok(forwarded_req) = builder.body(outbound_body) else {
        return Ok(plain_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to construct forwarded request",
        ));
    };

    match upstream_client.request(forwarded_req).await {
        Ok(upstream_resp) => {
            let (resp_parts, resp_body) = upstream_resp.into_parts();
            let mut resp_builder = Response::builder().status(resp_parts.status);
            if let Some(headers_mut) = resp_builder.headers_mut() {
                *headers_mut = crate::reverse_proxy::prepare_response_headers(&resp_parts.headers);
            }
            Ok(resp_builder.body(resp_body.boxed()).unwrap())
        }
        Err(error) => Ok(plain_error_response(
            StatusCode::BAD_GATEWAY,
            &format!("Upstream CPA kernel connection failed: {error}"),
        )),
    }
}

fn plain_error_response(
    status: StatusCode,
    message: &str,
) -> Response<BoxBody<Bytes, hyper::Error>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(
            Full::new(Bytes::from(message.to_string()))
                .map_err(|e| match e {})
                .boxed(),
        )
        .unwrap()
}

async fn spawn_listener_for_client(
    client_id: &str,
    preferred_port: u16,
    upstream_override: Option<u16>,
    app: Option<tauri::AppHandle>,
) -> Result<(u16, RunningClientListener), String> {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", preferred_port)).await {
        Ok(bound) => bound,
        Err(_) if preferred_port != 0 => tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("Failed to bind local prompt proxy listener: {error}"))?,
        Err(error) => {
            return Err(format!(
                "Failed to bind local prompt proxy listener: {error}"
            ));
        }
    };
    let bound_port = listener
        .local_addr()
        .map_err(|error| format!("Failed to inspect local prompt proxy port: {error}"))?
        .port();

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let client_owned = client_id.to_string();

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    break;
                }
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    };
                    let _ = stream.set_nodelay(true);
                    let cid = client_owned.clone();
                    let app_clone = app.clone();
                    tokio::spawn(async move {
                        let io = TokioIo::new(stream);
                        let service = hyper::service::service_fn(move |req| {
                            handle_prompt_proxy_request(
                                cid.clone(),
                                req,
                                upstream_override,
                                app_clone.clone(),
                            )
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .preserve_header_case(true)
                            .title_case_headers(true)
                            .serve_connection(io, service)
                            .await;
                    });
                }
            }
        }
    });

    Ok((
        bound_port,
        RunningClientListener {
            port: bound_port,
            shutdown_tx: Some(shutdown_tx),
            task,
        },
    ))
}

async fn ensure_client_proxy_listener(
    client_id: &str,
    preferred_port: u16,
    app: Option<&tauri::AppHandle>,
) -> Result<u16, String> {
    {
        let mut listeners = PROMPT_LISTENERS
            .lock()
            .map_err(|_| "Prompt proxy listener lock is poisoned".to_string())?;
        if let Some(existing) = listeners.get(client_id) {
            if existing.is_alive() {
                let port = existing.port;
                drop(listeners);
                update_bound_port_in_state(client_id, port)?;
                return Ok(port);
            }
        }
        if let Some(dead) = listeners.remove(client_id) {
            dead.stop();
        }
    }

    let (bound_port, running) =
        spawn_listener_for_client(client_id, preferred_port, None, app.cloned()).await?;
    {
        let mut listeners = PROMPT_LISTENERS
            .lock()
            .map_err(|_| "Prompt proxy listener lock is poisoned".to_string())?;
        listeners.insert(client_id.to_string(), running);
    }
    update_bound_port_in_state(client_id, bound_port)?;
    Ok(bound_port)
}

fn update_bound_port_in_state(client_id: &str, bound_port: u16) -> Result<(), String> {
    let mut guard = PROMPT_STATE
        .lock()
        .map_err(|_| "Agent system prompt state lock is poisoned".to_string())?;
    let entry = guard.clients.entry(client_id.to_string()).or_default();
    let port_changed = entry.port != Some(bound_port);
    entry.port = Some(bound_port);
    if entry.has_active_rules() {
        guard.active_ports.insert(client_id.to_string(), bound_port);
    }
    if port_changed {
        persist_prompt_state_locked(&guard)?;
    }
    Ok(())
}

fn stop_client_proxy_listener(client_id: &str) {
    if let Ok(mut listeners) = PROMPT_LISTENERS.lock() {
        if let Some(running) = listeners.remove(client_id) {
            running.stop();
        }
    }
    if let Ok(mut guard) = PROMPT_STATE.lock() {
        guard.active_ports.remove(client_id);
    }
}

fn replace_exact_or_v1_url(current: &str, old_origin: &str, new_origin: &str) -> Option<String> {
    let trimmed = current.trim().trim_end_matches('/');
    let old_clean = old_origin.trim_end_matches('/');
    let new_clean = new_origin.trim_end_matches('/');
    if trimmed == old_clean {
        return Some(new_clean.to_string());
    }
    if trimmed == format!("{old_clean}/v1") {
        return Some(format!("{new_clean}/v1"));
    }
    if trimmed == format!("{old_clean}/v1/chat/completions") {
        return Some(format!("{new_clean}/v1/chat/completions"));
    }
    None
}

fn sync_configured_agent_origin(
    client_id: &str,
    home: &Path,
    old_origin: &str,
    new_origin: &str,
) -> Result<bool, String> {
    if old_origin == new_origin {
        return Ok(false);
    }

    if client_id == PI_AGENT_ID {
        let paths = config_paths(PI_AGENT_ID, home)?;
        if !paths[0].is_file() {
            return Ok(false);
        }
        let before = config_images(&paths)?;
        let Some(raw) = before[0]
            .1
            .as_deref()
            .and_then(|b| std::str::from_utf8(b).ok())
        else {
            return Ok(false);
        };
        let Ok(mut doc) = serde_json::from_str::<Value>(raw) else {
            return Ok(false);
        };
        let Some(base_str) = doc.get("baseUrl").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(updated_url) = replace_exact_or_v1_url(base_str, old_origin, new_origin) else {
            return Ok(false);
        };
        doc["baseUrl"] = Value::String(updated_url);
        let mut rendered = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
        rendered.push('\n');
        let mut after = before.clone();
        after[0].1 = Some(rendered.into_bytes());
        commit_config(PI_AGENT_ID, &paths, &before, &after, "update", None)?;
        return Ok(true);
    }

    let parsed = AgentClient::parse(client_id)?;
    if !parsed.supported_platform() {
        return Ok(false);
    }
    let raw_paths = agent_config_paths(parsed, home);
    if !agent_has_managed_marker(parsed, &raw_paths).unwrap_or(false) {
        return Ok(false);
    }

    let record_paths = config_paths(client_id, home)?;
    let before = config_images(&record_paths)?;
    let mut after = before.clone();
    let mut any_changed = false;

    match parsed {
        AgentClient::ClaudeCode => {
            if let Some(bytes) = before.first().and_then(|(_, b)| b.as_deref()) {
                if let Ok(mut root) = serde_json::from_slice::<Value>(bytes) {
                    if let Some(cur) = root
                        .pointer("/env/ANTHROPIC_BASE_URL")
                        .and_then(Value::as_str)
                    {
                        if let Some(next_url) = replace_exact_or_v1_url(cur, old_origin, new_origin)
                        {
                            root["env"]["ANTHROPIC_BASE_URL"] = Value::String(next_url);
                            let mut out =
                                serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
                            out.push('\n');
                            after[0].1 = Some(out.into_bytes());
                            any_changed = true;
                        }
                    }
                }
            }
        }
        AgentClient::ClaudeDesktop => {
            if after.len() >= 3 {
                if let Some(bytes) = before.get(2).and_then(|(_, b)| b.as_deref()) {
                    if let Ok(mut root) = serde_json::from_slice::<Value>(bytes) {
                        if let Some(cur) =
                            root.get("inferenceGatewayBaseUrl").and_then(Value::as_str)
                        {
                            if let Some(next_url) =
                                replace_exact_or_v1_url(cur, old_origin, new_origin)
                            {
                                root["inferenceGatewayBaseUrl"] = Value::String(next_url);
                                let mut out = serde_json::to_string_pretty(&root)
                                    .map_err(|e| e.to_string())?;
                                out.push('\n');
                                after[2].1 = Some(out.into_bytes());
                                any_changed = true;
                            }
                        }
                    }
                }
            }
        }
        AgentClient::ZCode => {
            if let Some(bytes) = before.first().and_then(|(_, b)| b.as_deref()) {
                if let Ok(mut root) = serde_json::from_slice::<Value>(bytes) {
                    if let Some(rules) = root
                        .pointer_mut("/config/providerConfigRules/providerRules")
                        .and_then(Value::as_array_mut)
                    {
                        for rule in rules {
                            if rule.get("providerId").and_then(Value::as_str)
                                == Some(MANAGED_AGENT_PROVIDER_ID)
                            {
                                if let Some(cur) =
                                    rule.pointer("/config/api/baseUrl").and_then(Value::as_str)
                                {
                                    let trimmed = cur.trim().trim_end_matches('/');
                                    let old_clean = old_origin.trim_end_matches('/');
                                    if trimmed == old_clean || trimmed == format!("{old_clean}/v1")
                                    {
                                        rule["config"]["api"]["baseUrl"] = Value::String(format!(
                                            "{}/v1",
                                            new_origin.trim_end_matches('/')
                                        ));
                                        any_changed = true;
                                    }
                                }
                            }
                        }
                    }
                    if any_changed {
                        let mut out =
                            serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
                        out.push('\n');
                        after[0].1 = Some(out.into_bytes());
                    }
                }
            }
        }
        AgentClient::OpenCode => {
            if let Some(bytes) = before.first().and_then(|(_, b)| b.as_deref()) {
                if let Ok(text) = std::str::from_utf8(bytes) {
                    if let Ok(mut root) = super::transactions::parse_json_or_json5(text) {
                        if let Some(cur) = root
                            .pointer(&format!(
                                "/provider/{MANAGED_AGENT_PROVIDER_ID}/options/baseURL"
                            ))
                            .and_then(Value::as_str)
                        {
                            if let Some(next_url) =
                                replace_exact_or_v1_url(cur, old_origin, new_origin)
                            {
                                root["provider"][MANAGED_AGENT_PROVIDER_ID]["options"]["baseURL"] =
                                    Value::String(next_url);
                                let mut out = serde_json::to_string_pretty(&root)
                                    .map_err(|e| e.to_string())?;
                                out.push('\n');
                                after[0].1 = Some(out.into_bytes());
                                any_changed = true;
                            }
                        }
                    }
                }
            }
        }
        AgentClient::OpenClaw => {
            if let Some(bytes) = before.first().and_then(|(_, b)| b.as_deref()) {
                if let Ok(text) = std::str::from_utf8(bytes) {
                    if let Ok(mut root) = super::transactions::parse_json_or_json5(text) {
                        if let Some(cur) = root
                            .pointer(&format!(
                                "/models/providers/{MANAGED_AGENT_PROVIDER_ID}/baseUrl"
                            ))
                            .and_then(Value::as_str)
                        {
                            if let Some(next_url) =
                                replace_exact_or_v1_url(cur, old_origin, new_origin)
                            {
                                root["models"]["providers"][MANAGED_AGENT_PROVIDER_ID]["baseUrl"] =
                                    Value::String(next_url);
                                let mut out = serde_json::to_string_pretty(&root)
                                    .map_err(|e| e.to_string())?;
                                out.push('\n');
                                after[0].1 = Some(out.into_bytes());
                                any_changed = true;
                            }
                        }
                    }
                }
            }
        }
        AgentClient::AntigravityCli => {
            if after.len() >= 2 {
                if let Some(bytes) = before.get(1).and_then(|(_, b)| b.as_deref()) {
                    if let Ok(mut root) = serde_json::from_slice::<Value>(bytes) {
                        if let Some(cur) = root.get("baseUrl").and_then(Value::as_str) {
                            if let Some(next_url) =
                                replace_exact_or_v1_url(cur, old_origin, new_origin)
                            {
                                root["baseUrl"] = Value::String(next_url);
                                let mut out = serde_json::to_string_pretty(&root)
                                    .map_err(|e| e.to_string())?;
                                out.push('\n');
                                after[1].1 = Some(out.into_bytes());
                                any_changed = true;
                            }
                        }
                    }
                }
            }
        }
        AgentClient::CopilotCli => {
            if let Some(bytes) = before.first().and_then(|(_, b)| b.as_deref()) {
                if let Ok(mut root) = serde_json::from_slice::<Value>(bytes) {
                    if let Some(cur) = root.get("baseUrl").and_then(Value::as_str) {
                        if let Some(next_url) = replace_exact_or_v1_url(cur, old_origin, new_origin)
                        {
                            root["baseUrl"] = Value::String(next_url);
                            let mut out =
                                serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
                            out.push('\n');
                            after[0].1 = Some(out.into_bytes());
                            any_changed = true;
                        }
                    }
                }
            }
        }
        AgentClient::VscodeCopilot => {
            if let Some(bytes) = before.first().and_then(|(_, b)| b.as_deref()) {
                if let Ok(mut root) = serde_json::from_slice::<Value>(bytes) {
                    let old_v1 = format!("{}/v1/", old_origin.trim_end_matches('/'));
                    let new_v1 = format!("{}/v1/", new_origin.trim_end_matches('/'));
                    if let Some(groups) = root.as_array_mut() {
                        for group in groups {
                            if group.get("vendor").and_then(Value::as_str) == Some("customendpoint")
                                && group.get("name").and_then(Value::as_str)
                                    == Some("CPA (EasyCLIProxyAPI)")
                            {
                                if let Some(models) =
                                    group.get_mut("models").and_then(Value::as_array_mut)
                                {
                                    for m in models {
                                        if let Some(url) = m.get("url").and_then(Value::as_str) {
                                            if let Some(suffix) = url.strip_prefix(&old_v1) {
                                                m["url"] =
                                                    Value::String(format!("{new_v1}{suffix}"));
                                                any_changed = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if any_changed {
                        let mut out =
                            serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
                        out.push('\n');
                        after[0].1 = Some(out.into_bytes());
                    }
                }
            }
        }
        AgentClient::WorkBuddy => {
            if let Some(bytes) = before.first().and_then(|(_, b)| b.as_deref()) {
                if let Ok(mut root) = serde_json::from_slice::<Value>(bytes) {
                    let mut update_list = |arr: &mut Vec<Value>| {
                        for entry in arr {
                            if workbuddy_managed_model(entry) {
                                if let Some(cur) = entry.get("url").and_then(Value::as_str) {
                                    if let Some(next_url) =
                                        replace_exact_or_v1_url(cur, old_origin, new_origin)
                                    {
                                        entry["url"] = Value::String(next_url);
                                        any_changed = true;
                                    }
                                }
                            }
                        }
                    };
                    if let Some(arr) = root.as_array_mut() {
                        update_list(arr);
                    } else if let Some(arr) = root.get_mut("models").and_then(Value::as_array_mut) {
                        update_list(arr);
                    }
                    if any_changed {
                        let mut out =
                            serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
                        out.push('\n');
                        after[0].1 = Some(out.into_bytes());
                    }
                }
            }
        }
        AgentClient::Hermes | AgentClient::DeepSeekHarness | AgentClient::Omp => {
            if let Some(bytes) = before.first().and_then(|(_, b)| b.as_deref()) {
                if let Ok(text) = std::str::from_utf8(bytes) {
                    let old_v1 = format!("{}/v1", old_origin.trim_end_matches('/'));
                    let new_v1 = format!("{}/v1", new_origin.trim_end_matches('/'));
                    let replaced = if text.contains(&old_v1) {
                        text.replace(&old_v1, &new_v1)
                    } else if text.contains(old_origin) {
                        text.replace(old_origin, new_origin)
                    } else {
                        text.to_string()
                    };
                    if replaced != text {
                        after[0].1 = Some(replaced.into_bytes());
                        any_changed = true;
                    }
                }
            }
        }
        AgentClient::KimiCode | AgentClient::GrokBuild => {
            if let Some(bytes) = before.first().and_then(|(_, b)| b.as_deref()) {
                if let Ok(text) = std::str::from_utf8(bytes) {
                    let old_v1 = format!("{}/v1", old_origin.trim_end_matches('/'));
                    let new_v1 = format!("{}/v1", new_origin.trim_end_matches('/'));
                    if text.contains(&old_v1) {
                        let replaced = text.replace(&old_v1, &new_v1);
                        if replaced != text {
                            after[0].1 = Some(replaced.into_bytes());
                            any_changed = true;
                        }
                    }
                }
            }
        }
        AgentClient::Codex => {}
    }

    if !any_changed {
        return Ok(false);
    }
    commit_config(client_id, &record_paths, &before, &after, "update", None)?;
    Ok(true)
}

async fn fetch_models_for_prompt_editor(
    client_id: &str,
    gui_config: &crate::GuiConfigFile,
) -> Vec<AgentModelOption> {
    if client_id == PI_AGENT_ID {
        let api_key = effective_agent_api_key(gui_config);
        return fetch_agent_models(gui_config.port, api_key)
            .await
            .unwrap_or_default();
    }
    let Ok(parsed) = AgentClient::parse(client_id) else {
        return Vec::new();
    };
    fetch_prepared_agent_models(parsed, gui_config)
        .await
        .map(|prepared| prepared.models)
        .unwrap_or_default()
}

fn build_editor_snapshot(
    client_id: &str,
    home: &Path,
    available_models: &[AgentModelOption],
) -> Result<AgentSystemPromptEditorSnapshot, String> {
    let (cfg, active_port) = {
        let guard = PROMPT_STATE
            .lock()
            .map_err(|_| "Agent system prompt state lock is poisoned".to_string())?;
        let cfg = guard.clients.get(client_id).cloned().unwrap_or_default();
        let active_port = guard.active_ports.get(client_id).copied();
        (cfg, active_port)
    };

    let (builtin_default_prompt, default_source) =
        resolve_builtin_default_prompt(client_id, home, cfg.observed_default_prompt.as_deref());

    let (default_customized, default_prompt, default_mode, default_preserve_dynamic_context) =
        if let Some(ref rule) = cfg
            .default_rule
            .as_ref()
            .filter(|r| !r.prompt.trim().is_empty())
        {
            (
                true,
                rule.prompt.clone(),
                rule.mode,
                rule.preserve_dynamic_context,
            )
        } else {
            (
                false,
                builtin_default_prompt.clone(),
                PromptRewriteMode::Replace,
                true,
            )
        };

    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();

    // ZCode can also edit managed manual models that are no longer in the core's list.
    let zcode_catalog = (client_id == "zcode")
        .then(|| zcode_editor_snapshot(home, available_models).ok())
        .flatten();
    let ids: Vec<_> = match &zcode_catalog {
        Some(catalog) => catalog.models.iter().map(|model| &model.id).collect(),
        None => available_models.iter().map(|model| &model.name).collect(),
    };
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(rule) = cfg
            .models
            .get(id)
            .filter(|r| !r.prompt.trim().is_empty())
        {
            models.push(AgentSystemPromptEditorModel {
                id: id.clone(),
                customized: true,
                prompt: rule.prompt.clone(),
                default_prompt: default_prompt.clone(),
                mode: rule.mode,
                preserve_dynamic_context: rule.preserve_dynamic_context,
            });
        } else {
            models.push(AgentSystemPromptEditorModel {
                id: id.clone(),
                customized: false,
                prompt: default_prompt.clone(),
                default_prompt: default_prompt.clone(),
                mode: PromptRewriteMode::Replace,
                preserve_dynamic_context: true,
            });
        }
    }

    for (saved_id, rule) in &cfg.models {
        if !rule.prompt.trim().is_empty() && seen.insert(saved_id.clone()) {
            models.push(AgentSystemPromptEditorModel {
                id: saved_id.clone(),
                customized: true,
                prompt: rule.prompt.clone(),
                default_prompt: default_prompt.clone(),
                mode: rule.mode,
                preserve_dynamic_context: rule.preserve_dynamic_context,
            });
        }
    }

    Ok(AgentSystemPromptEditorSnapshot {
        client: client_id.to_string(),
        default_prompt,
        builtin_default_prompt,
        default_source: default_source.to_string(),
        default_customized,
        default_mode,
        default_preserve_dynamic_context,
        overrides_enabled: cfg.overrides_enabled,
        proxy_active: active_port.is_some(),
        proxy_port: active_port,
        core_tls_enabled: managed_core_tls_enabled(),
        models,
    })
}

#[tauri::command]
pub(crate) async fn get_agent_system_prompt_editor(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    client: String,
    config_directories: Option<AgentConfigDirectories>,
) -> Result<AgentSystemPromptEditorSnapshot, String> {
    let client_id = normalize_prompt_client_id(&client)?;
    let directories = validate_agent_config_directories(config_directories)?;
    let gui_config = gui_config_state.snapshot()?;
    let models = fetch_models_for_prompt_editor(client_id, &gui_config).await;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Failed to get user directory".to_string())?;
    AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
        build_editor_snapshot(client_id, &home, &models)
    })
}

// The caller holds PROMPT_PROXY_OP_LOCK. Keep the old listener available until
// the managed route and persisted settings both succeed. A new listener is bound
// before moving the route, but does not rewrite until the state is published.
async fn save_claude_prompt_config(
    app: &tauri::AppHandle,
    client_id: &str,
    home: &Path,
    directories: AgentConfigDirectories,
    core_port: u16,
    mut next: SavedClientPromptConfig,
) -> Result<(), String> {
    let old_origin = agent_effective_loopback_origin(client_id, core_port);
    let (new_port, pending_listener) = if next.has_active_rules() {
        let existing_port = PROMPT_LISTENERS
            .lock()
            .map_err(|_| "Prompt proxy listener lock is poisoned".to_string())?
            .get(client_id)
            .filter(|listener| listener.is_alive())
            .map(|listener| listener.port);
        if let Some(port) = existing_port {
            (Some(port), None)
        } else {
            let preferred = next
                .port
                .filter(|port| *port > 0)
                .unwrap_or_else(|| preferred_proxy_port(client_id));
            let (port, listener) =
                spawn_listener_for_client(client_id, preferred, None, Some(app.clone())).await?;
            (Some(port), Some(listener))
        }
    } else {
        (None, None)
    };
    if let Some(port) = new_port {
        next.port = Some(port);
    }
    let new_origin = new_port
        .map(|port| format!("http://127.0.0.1:{port}"))
        .unwrap_or_else(|| managed_core_loopback_origin(core_port));

    let result = AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || -> Result<(), String> {
        let _file_guard = crate::AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "Agent configuration file lock is poisoned".to_string())?;
        if new_port.is_some() && managed_core_tls_enabled() {
            return Err(TLS_LOOPBACK_UNSUPPORTED.to_string());
        }
        let moved = sync_configured_agent_origin(client_id, home, &old_origin, &new_origin)?;
        let persisted = (|| {
            let mut guard = PROMPT_STATE
                .lock()
                .map_err(|_| "Agent system prompt state lock is poisoned".to_string())?;
            if let Some(current) = guard.clients.get(client_id) {
                next.observed_default_prompt = current.observed_default_prompt.clone();
            }
            let previous = guard.clients.insert(client_id.to_string(), next);
            if let Err(error) = persist_prompt_state_locked(&guard) {
                if let Some(previous) = previous {
                    guard.clients.insert(client_id.to_string(), previous);
                } else {
                    guard.clients.remove(client_id);
                }
                return Err(error);
            }
            if let Some(port) = new_port {
                guard.active_ports.insert(client_id.to_string(), port);
            } else {
                guard.active_ports.remove(client_id);
            }
            Ok(())
        })();
        if let Err(error) = persisted {
            if moved {
                sync_configured_agent_origin(client_id, home, &new_origin, &old_origin).map_err(
                    |rollback| {
                        format!("{error}; failed to restore previous agent route: {rollback}")
                    },
                )?;
            }
            return Err(error);
        }
        Ok(())
    });
    if let Some(listener) = pending_listener {
        if result.is_ok() {
            if let Some(previous) = PROMPT_LISTENERS
                .lock()
                .map_err(|_| "Prompt proxy listener lock is poisoned".to_string())?
                .insert(client_id.to_string(), listener)
            {
                previous.stop();
            }
        } else {
            listener.stop();
        }
    } else if result.is_ok() && new_port.is_none() {
        stop_client_proxy_listener(client_id);
    }
    result
}

#[tauri::command]
pub(crate) async fn save_agent_system_prompt_editor(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    status_cache: tauri::State<'_, AgentConfigStatusCache>,
    request: AgentSystemPromptEditorSaveRequest,
    config_directories: Option<AgentConfigDirectories>,
) -> Result<AgentSystemPromptEditorSnapshot, String> {
    let client_id = normalize_prompt_client_id(&request.client)?;
    let directories = validate_agent_config_directories(config_directories)?;
    let gui_config = gui_config_state.snapshot()?;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Failed to get user directory".to_string())?;

    let validated_default = if request.default_customized {
        Some(AgentSystemPromptRule {
            prompt: validate_prompt_text(&request.default_prompt)?,
            mode: request.default_mode,
            preserve_dynamic_context: request.default_preserve_dynamic_context,
        })
    } else {
        None
    };

    let mut validated_models = BTreeMap::new();
    for item in &request.models {
        if !item.customized {
            continue;
        }
        let id = validate_model_id(&item.id)?;
        if validated_models.contains_key(&id) {
            return Err(format!("Duplicate model system prompt rule: {id}"));
        }
        validated_models.insert(
            id,
            AgentSystemPromptRule {
                prompt: validate_prompt_text(&item.prompt)?,
                mode: item.mode,
                preserve_dynamic_context: item.preserve_dynamic_context,
            },
        );
    }

    let _op = PROMPT_PROXY_OP_LOCK.lock().await;
    if supports_override_switch(client_id) {
        let previous = {
            let mut guard = PROMPT_STATE
                .lock()
                .map_err(|_| "Agent system prompt state lock is poisoned".to_string())?;
            if guard.storage_path.is_none() {
                guard.storage_path = Some(agent_system_prompts_path(&app)?);
            }
            guard.clients.get(client_id).cloned().unwrap_or_default()
        };
        let previously_active = previous.has_active_rules();
        let next = SavedClientPromptConfig {
            default_rule: validated_default,
            models: validated_models,
            // Older callers cannot accidentally resume an explicitly paused client.
            overrides_enabled: request.overrides_enabled.or(previous.overrides_enabled),
            ..previous
        };
        if next.has_active_rules() && managed_core_tls_enabled() {
            if previously_active {
                AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
                    deactivate_prompt_overrides_for_tls(&app, client_id)
                })?;
            }
            return Err(TLS_LOOPBACK_UNSUPPORTED.to_string());
        }
        save_claude_prompt_config(
            &app,
            client_id,
            &home,
            directories.clone(),
            gui_config.port,
            next,
        )
        .await?;
        let _ = status_cache.clear();
        let models = fetch_models_for_prompt_editor(client_id, &gui_config).await;
        return AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
            build_editor_snapshot(client_id, &home, &models)
        });
    }
    // Refuse before touching the stored rules: a rejected save must not leave changed rules
    // armed behind a plaintext proxy the caller was told does not exist.
    let wants_active = validated_default.is_some() || !validated_models.is_empty();
    if managed_core_tls_enabled() {
        let already_active = PROMPT_STATE
            .lock()
            .map(|guard| {
                guard
                    .clients
                    .get(client_id)
                    .is_some_and(|cfg| cfg.has_active_rules())
            })
            .unwrap_or(true);
        // A rejected save must not leave changed rules armed. When overrides were already
        // active, shut the plaintext proxy down instead of keeping it running.
        if already_active {
            // Scoped so the (non-Send) lock guard never lives across an await point.
            {
                let _file_guard = crate::AGENT_CONFIG_FILE_LOCK
                    .lock()
                    .map_err(|_| "Agent configuration file lock is poisoned".to_string())?;
            }
            deactivate_prompt_overrides_for_tls(&app, client_id)?;
        }
        if wants_active {
            return Err(TLS_LOOPBACK_UNSUPPORTED.to_string());
        }
        let models = fetch_models_for_prompt_editor(client_id, &gui_config).await;
        return AGENT_CONFIG_DIRECTORIES
            .sync_scope(directories, || build_editor_snapshot(client_id, &home, &models));
    }
    let old_origin = agent_effective_loopback_origin(client_id, gui_config.port);

    let (has_active, preferred_port) = {
        let mut guard = PROMPT_STATE
            .lock()
            .map_err(|_| "Agent system prompt state lock is poisoned".to_string())?;
        if guard.storage_path.is_none() {
            guard.storage_path = Some(agent_system_prompts_path(&app)?);
        }
        let entry = guard.clients.entry(client_id.to_string()).or_default();
        entry.default_rule = validated_default;
        entry.models = validated_models;
        let has_active = entry.has_active_rules();
        let port = entry
            .port
            .filter(|p| *p > 0)
            .unwrap_or_else(|| preferred_proxy_port(client_id));
        if !has_active {
            guard.active_ports.remove(client_id);
        }
        persist_prompt_state_locked(&guard)?;
        (has_active, port)
    };

    if has_active && managed_core_tls_enabled() {
        return Err(TLS_LOOPBACK_UNSUPPORTED.to_string());
    }

    if has_active {
        ensure_client_proxy_listener(client_id, preferred_port, Some(&app)).await?;
    } else {
        stop_client_proxy_listener(client_id);
    }

    let new_origin = agent_effective_loopback_origin(client_id, gui_config.port);
    let dirs_for_sync = directories.clone();
    let home_for_sync = home.clone();
    AGENT_CONFIG_DIRECTORIES.sync_scope(dirs_for_sync, || -> Result<(), String> {
        let _file_guard = crate::AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "Agent configuration file lock is poisoned".to_string())?;
        sync_configured_agent_origin(client_id, &home_for_sync, &old_origin, &new_origin)?;
        Ok(())
    })?;

    let _ = status_cache.clear();

    let models = fetch_models_for_prompt_editor(client_id, &gui_config).await;
    AGENT_CONFIG_DIRECTORIES.sync_scope(directories, || {
        build_editor_snapshot(client_id, &home, &models)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    use std::sync::Arc;

    fn sample_cfg(
        default_prompt: Option<(&str, PromptRewriteMode, bool)>,
        model_rules: &[(&str, &str, PromptRewriteMode, bool)],
    ) -> SavedClientPromptConfig {
        let mut models = BTreeMap::new();
        for &(id, prompt, mode, preserve) in model_rules {
            models.insert(
                id.to_string(),
                AgentSystemPromptRule {
                    prompt: prompt.to_string(),
                    mode,
                    preserve_dynamic_context: preserve,
                },
            );
        }
        SavedClientPromptConfig {
            port: None,
            default_rule: default_prompt.map(|(p, mode, preserve)| AgentSystemPromptRule {
                prompt: p.to_string(),
                mode,
                preserve_dynamic_context: preserve,
            }),
            models,
            observed_default_prompt: None,
            overrides_enabled: None,
        }
    }

    #[test]
    fn rewrites_zcode_three_block_anthropic_system_and_preserves_dynamic_context() {
        let cfg = sample_cfg(
            Some((
                "Custom ZCode System Prompt",
                PromptRewriteMode::Replace,
                true,
            )),
            &[],
        );
        let body = serde_json::to_vec(&json!({
            "model": "glm-5.3",
            "max_tokens": 16384,
            "tools": [{"name": "Bash"}, {"name": "Read"}],
            "system": [
                { "type": "text", "text": "You are ZCode, an interactive agent" },
                { "type": "text", "text": "You are an agent working with the user.\n# Harness", "cache_control": { "type": "ephemeral" } },
                { "type": "text", "text": "# Memory\nPersistent memory at ~/.zcode\n\n# Environment\ncwd: /repo", "cache_control": { "type": "ephemeral" } }
            ],
            "messages": [{ "role": "user", "content": "hello" }]
        }))
        .unwrap();

        let (rewritten, observed) = rewrite_inference_body_with_config(
            "zcode",
            InferenceWireKind::AnthropicMessages,
            "/v1/messages",
            &cfg,
            &body,
        )
        .unwrap();

        assert!(observed
            .unwrap()
            .contains("You are ZCode, an interactive agent"));
        let parsed: Value = serde_json::from_slice(&rewritten).unwrap();
        let sys = parsed["system"].as_array().unwrap();
        assert_eq!(sys.len(), 2);
        assert_eq!(sys[0]["text"], "Custom ZCode System Prompt");
        assert_eq!(sys[0]["cache_control"]["type"], "ephemeral");
        assert!(sys[1]["text"].as_str().unwrap().starts_with("# Memory\n"));
    }

    #[test]
    fn skips_internal_utility_and_title_requests() {
        let cfg = sample_cfg(
            Some(("Custom Prompt", PromptRewriteMode::Replace, true)),
            &[],
        );
        let web_helper = serde_json::to_vec(&json!({
            "model": "glm-5.3",
            "max_tokens": 4096,
            "tools": [{"name": "web_search"}],
            "system": "You are an assistant for performing a web search tool use.",
            "messages": [{ "role": "user", "content": "query" }]
        }))
        .unwrap();
        assert!(rewrite_inference_body_with_config(
            "zcode",
            InferenceWireKind::AnthropicMessages,
            "/v1/messages",
            &cfg,
            &web_helper,
        )
        .is_none());

        let title_call = serde_json::to_vec(&json!({
            "model": "glm-5.3",
            "max_tokens": 64,
            "system": "Name this chat",
            "messages": [{ "role": "user", "content": "hi" }]
        }))
        .unwrap();
        assert!(rewrite_inference_body_with_config(
            "zcode",
            InferenceWireKind::AnthropicMessages,
            "/v1/messages",
            &cfg,
            &title_call,
        )
        .is_none());
    }

    #[test]
    fn short_user_conversation_keeps_custom_prompt() {
        let cfg = sample_cfg(
            Some(("Custom Prompt", PromptRewriteMode::Replace, true)),
            &[],
        );
        let body = serde_json::to_vec(&json!({
            "model": "glm-5.3",
            "max_tokens": 64,
            "system": [{ "type": "text", "text": "You are ZCode, an interactive agent" }],
            "messages": [{ "role": "user", "content": "hi" }]
        }))
        .unwrap();
        let (rewritten, _) = rewrite_inference_body_with_config(
            "zcode",
            InferenceWireKind::AnthropicMessages,
            "/v1/messages",
            &cfg,
            &body,
        )
        .expect("a short chat turn must still be rewritten");
        let parsed: Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(parsed["system"][0]["text"], "Custom Prompt");
    }

    #[test]
    fn skips_responses_instruction_helpers() {
        let cfg = sample_cfg(
            Some(("Custom Prompt", PromptRewriteMode::Replace, true)),
            &[],
        );
        let helper = serde_json::to_vec(&json!({
            "model": "glm-5.3",
            "max_output_tokens": 64,
            "instructions": "Name this chat",
            "input": [{ "role": "user", "content": "hi" }]
        }))
        .unwrap();
        assert!(rewrite_inference_body_with_config(
            "opencode",
            InferenceWireKind::OpenAiResponses,
            "/v1/responses",
            &cfg,
            &helper,
        )
        .is_none());
    }

    #[test]
    fn anthropic_array_system_without_cache_control_stays_unmarked() {
        let cfg = sample_cfg(
            Some(("Custom Prompt", PromptRewriteMode::Replace, false)),
            &[],
        );
        let body = serde_json::to_vec(&json!({
            "model": "glm-5.3",
            "system": [{ "type": "text", "text": "You are ZCode, an interactive agent" }],
            "messages": [{ "role": "user", "content": "hello there" }]
        }))
        .unwrap();
        let (rewritten, _) = rewrite_inference_body_with_config(
            "zcode",
            InferenceWireKind::AnthropicMessages,
            "/v1/messages",
            &cfg,
            &body,
        )
        .unwrap();
        let parsed: Value = serde_json::from_slice(&rewritten).unwrap();
        assert!(parsed["system"][0].get("cache_control").is_none());
    }

    #[test]
    fn model_specific_rule_overrides_default_and_strips_cpa_prefixes() {
        let cfg = sample_cfg(
            Some(("Agent Default Prompt", PromptRewriteMode::Replace, true)),
            &[(
                "deepseek-v4",
                "DeepSeek V4 Custom Prompt",
                PromptRewriteMode::Append,
                true,
            )],
        );
        let body = serde_json::to_vec(&json!({
            "model": "cpa-gui/deepseek-v4",
            "tools": [{"name": "read"}, {"name": "edit"}],
            "messages": [
                { "role": "system", "content": "Original OpenCode Prompt\n\n<env>\ncwd=/tmp\n</env>" },
                { "role": "user", "content": "test" }
            ]
        }))
        .unwrap();

        let (rewritten, observed) = rewrite_inference_body_with_config(
            "opencode",
            InferenceWireKind::OpenAiChatCompletions,
            "/v1/chat/completions",
            &cfg,
            &body,
        )
        .unwrap();

        assert_eq!(observed.as_deref(), Some("Original OpenCode Prompt"));
        let parsed: Value = serde_json::from_slice(&rewritten).unwrap();
        let content = parsed["messages"][0]["content"].as_str().unwrap();
        assert_eq!(
            content,
            "Original OpenCode Prompt\n\nDeepSeek V4 Custom Prompt\n\n<env>\ncwd=/tmp\n</env>"
        );
    }

    #[test]
    fn rewrites_responses_and_gemini_system_instructions() {
        let cfg = sample_cfg(
            Some(("Replaced Prompt", PromptRewriteMode::Replace, false)),
            &[],
        );

        let responses_body = serde_json::to_vec(&json!({
            "model": "gpt-5.4",
            "tools": [{"name": "bash"}],
            "instructions": "Original Pi Prompt",
            "input": [{"role": "user", "content": "hi"}]
        }))
        .unwrap();
        let (rewritten_resp, obs_resp) = rewrite_inference_body_with_config(
            "pi",
            InferenceWireKind::OpenAiResponses,
            "/v1/responses",
            &cfg,
            &responses_body,
        )
        .unwrap();
        assert_eq!(obs_resp.as_deref(), Some("Original Pi Prompt"));
        let resp_json: Value = serde_json::from_slice(&rewritten_resp).unwrap();
        assert_eq!(resp_json["instructions"], "Replaced Prompt");

        let gemini_body = serde_json::to_vec(&json!({
            "systemInstruction": {
                "parts": [{ "text": "Original Antigravity Prompt\n\n<env>\ncwd=/app\n</env>" }]
            },
            "contents": [{ "role": "user", "parts": [{ "text": "hi" }] }]
        }))
        .unwrap();
        let (rewritten_gem, obs_gem) = rewrite_inference_body_with_config(
            "antigravity-cli",
            InferenceWireKind::GeminiGenerateContent,
            "/v1beta/models/gemini-3.1-pro:streamGenerateContent",
            &cfg,
            &gemini_body,
        )
        .unwrap();
        assert_eq!(obs_gem.as_deref(), Some("Original Antigravity Prompt"));
        let gem_json: Value = serde_json::from_slice(&rewritten_gem).unwrap();
        assert_eq!(
            gem_json["systemInstruction"]["parts"][0]["text"],
            "Replaced Prompt"
        );
    }

    #[test]
    fn claude_switch_preserves_legacy_rules_and_round_trips_explicit_pause() {
        let legacy = r#"{"defaultRule":{"prompt":"Default","mode":"append"},"models":{"one":{"prompt":"Model","mode":"prepend","preserveDynamicContext":false}}}"#;
        for client in ["claude-code", "claude-desktop"] {
            let mut cfg: SavedClientPromptConfig = serde_json::from_str(legacy).unwrap();
            assert!(cfg.has_active_rules());
            assert!(!SavedClientPromptConfig::default().has_active_rules());
            let original = cfg.clone();
            cfg.overrides_enabled = Some(false);
            let mut restored: SavedClientPromptConfig =
                serde_json::from_slice(&serde_json::to_vec(&cfg).unwrap()).unwrap();
            restored.normalize_for_client(client);
            assert!(restored.has_saved_rules());
            assert!(!restored.has_active_rules());
            assert!(restored.resolve_rule(Some("one")).is_none());
            assert!(restored.resolve_rule(Some("other")).is_none());
            assert_eq!(restored.default_rule, original.default_rule);
            assert_eq!(restored.models, original.models);
            restored.overrides_enabled = Some(true);
            assert!(restored.has_active_rules());
            assert_eq!(
                restored.resolve_rule(Some("one")),
                original.resolve_rule(Some("one"))
            );
            assert_eq!(
                restored.resolve_rule(Some("other")),
                original.resolve_rule(Some("other"))
            );
        }
        let mut other: SavedClientPromptConfig = serde_json::from_str(legacy).unwrap();
        other.overrides_enabled = Some(false);
        other.normalize_for_client("zcode");
        assert!(other.has_active_rules());
    }

    #[tokio::test]
    async fn paused_claude_proxy_forwards_original_bytes_and_resumes_each_mode() {
        for client in ["claude-code", "claude-desktop"] {
            let upstream = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let port = upstream.local_addr().unwrap().port();
            let echo = tokio::spawn(async move {
                loop {
                    let (stream, _) = upstream.accept().await.unwrap();
                    tokio::spawn(async move {
                        let svc = hyper::service::service_fn(|req: Request<Incoming>| async move {
                            let bytes = req.into_body().collect().await.unwrap().to_bytes();
                            Ok::<_, Infallible>(Response::new(Full::new(bytes)))
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(TokioIo::new(stream), svc)
                            .await;
                    });
                }
            });
            let (port, listener) = spawn_listener_for_client(client, 0, Some(port), None)
                .await
                .unwrap();
            let http = reqwest::Client::builder().no_proxy().build().unwrap();
            let payload = "{ \"model\": \"one\", \"system\": \"Original\", \"messages\": [] }";
            let request = || {
                http.post(format!("http://127.0.0.1:{port}/v1/messages"))
                    .header("content-type", "application/json")
                    .body(payload)
            };
            for (mode, expected) in [
                (PromptRewriteMode::Replace, "Model"),
                (PromptRewriteMode::Prepend, "Model\n\nOriginal"),
                (PromptRewriteMode::Append, "Original\n\nModel"),
            ] {
                let mut cfg = sample_cfg(
                    Some(("Default", mode, false)),
                    &[("one", "Model", mode, false)],
                );
                cfg.overrides_enabled = Some(false);
                PROMPT_STATE
                    .lock()
                    .unwrap()
                    .clients
                    .insert(client.to_string(), cfg);
                let original = request()
                    .send()
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap();
                assert_eq!(original.as_ref(), payload.as_bytes());
                PROMPT_STATE
                    .lock()
                    .unwrap()
                    .clients
                    .get_mut(client)
                    .unwrap()
                    .overrides_enabled = Some(true);
                let rewritten: Value = request()
                    .send()
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                assert_eq!(rewritten["system"], expected);
            }
            listener.stop();
            echo.abort();
            PROMPT_STATE.lock().unwrap().clients.remove(client);
        }
    }

    #[tokio::test]
    async fn loopback_proxy_decompresses_gzip_rewrites_prompt_and_streams_sse() {
        let upstream_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let upstream_port = upstream_listener.local_addr().unwrap().port();
        let (captured_tx, captured_rx) = oneshot::channel::<Value>();
        let captured_tx = Arc::new(Mutex::new(Some(captured_tx)));

        tokio::spawn(async move {
            let (stream, _) = upstream_listener.accept().await.unwrap();
            let io = TokioIo::new(stream);
            let tx = captured_tx.clone();
            let svc = hyper::service::service_fn(move |req: Request<Incoming>| {
                let tx = tx.clone();
                async move {
                    let bytes = req.into_body().collect().await.unwrap().to_bytes();
                    let json_val: Value = serde_json::from_slice(&bytes).unwrap();
                    if let Some(sender) = tx.lock().unwrap().take() {
                        let _ = sender.send(json_val);
                    }
                    let sse = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n";
                    let response: Response<BoxBody<Bytes, Infallible>> = Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, "text/event-stream")
                        .body(Full::new(Bytes::from(sse)).map_err(|e| match e {}).boxed())
                        .unwrap();
                    Ok::<_, Infallible>(response)
                }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, svc)
                .await;
        });

        {
            let mut guard = PROMPT_STATE.lock().unwrap();
            guard.clients.insert(
                "zcode-test-isolated".to_string(),
                sample_cfg(
                    Some((
                        "Proxy Injected System Prompt",
                        PromptRewriteMode::Replace,
                        true,
                    )),
                    &[],
                ),
            );
        }

        let (proxy_port, running) =
            spawn_listener_for_client("zcode-test-isolated", 0, Some(upstream_port), None)
                .await
                .unwrap();

        let payload = serde_json::to_vec(&json!({
            "model": "glm-5.3",
            "max_tokens": 4096,
            "tools": [{"name": "Bash"}, {"name": "Read"}],
            "system": "Original ZCode System",
            "messages": [{"role": "user", "content": "ping"}]
        }))
        .unwrap();
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&payload).unwrap();
        let compressed = gz.finish().unwrap();

        let resp = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("http://127.0.0.1:{proxy_port}/v1/messages"))
            .header("content-type", "application/json")
            .header("content-encoding", "gzip")
            .body(compressed)
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        let text = resp.text().await.unwrap();
        assert!(text.contains("message_start"));

        let captured = captured_rx.await.unwrap();
        assert_eq!(captured["system"], "Proxy Injected System Prompt");

        running.stop();
        {
            let mut guard = PROMPT_STATE.lock().unwrap();
            guard.clients.remove("zcode-test-isolated");
            guard.active_ports.remove("zcode-test-isolated");
        }
    }
}
