use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

fn request_timeout(method: &str) -> Duration {
    Duration::from_secs(match method {
        "authenticate" => 300,
        "session/prompt" => 120,
        _ => 30,
    })
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Rejection {
    InvalidRequest,
    Authentication,
    Permission,
    Quota,
    Overloaded,
    Timeout,
    Unknown,
}

#[derive(Debug)]
pub(super) enum RpcFailure {
    Local(String),
    Remote { kind: Rejection, message: String },
}

impl From<String> for RpcFailure {
    fn from(error: String) -> Self {
        Self::Local(error)
    }
}
impl From<&str> for RpcFailure {
    fn from(error: &str) -> Self {
        Self::Local(error.into())
    }
}
impl RpcFailure {
    fn remote(error: &Value) -> Self {
        // Only the matched JSON-RPC error envelope can supply a machine code.
        // The error message, assistant text, and progress updates are not codes.
        let data = &error["data"];
        let kind = match data["status"]
            .as_str()
            .or_else(|| data["error"]["status"].as_str())
        {
            Some("INVALID_ARGUMENT") => Rejection::InvalidRequest,
            Some("UNAUTHENTICATED") => Rejection::Authentication,
            Some("PERMISSION_DENIED") => Rejection::Permission,
            Some("RESOURCE_EXHAUSTED") => Rejection::Quota,
            Some("UNAVAILABLE") => Rejection::Overloaded,
            Some("DEADLINE_EXCEEDED") => Rejection::Timeout,
            // Unknown status must not be turned into a known rejection by text.
            Some(_) => Rejection::Unknown,
            None => match error["code"].as_i64() {
                // ACP's protocol-defined authentication error.
                Some(-32000) => Rejection::Authentication,
                Some(-32602) => Rejection::InvalidRequest,
                _ => Rejection::Unknown,
            },
        };
        Self::Remote {
            kind,
            message: error["message"]
                .as_str()
                .unwrap_or("ACP request failed")
                .into(),
        }
    }

    fn local_message(self) -> String {
        match self {
            Self::Local(message) | Self::Remote { message, .. } => message,
        }
    }
}

pub(super) struct Client {
    child: crate::CoreChild,
    input: mpsc::SyncSender<WriteRequest>,
    output: mpsc::Receiver<Result<Value, String>>,
    next_id: u64,
    supports_logout: bool,
    supports_prompt_images: bool,
    system_prompt: SystemPromptSupport,
    api_tools: Vec<String>,
    started: std::time::SystemTime,
}

type WriteRequest = (Value, mpsc::SyncSender<Result<(), String>>);

#[derive(Default)]
enum SystemPromptSupport {
    #[default]
    Unavailable,
    Standard,
    Antigravity,
}

pub(super) fn command(executable: &Path, profile: &Path, proxy: &str) -> Result<Command, String> {
    command_with_args(executable, profile, proxy, &[])
}

pub(super) fn command_with_args(
    executable: &Path,
    profile: &Path,
    proxy: &str,
    extra: &[&str],
) -> Result<Command, String> {
    let isolated = super::accounts::is_isolated_home(profile);
    let canonical;
    let profile = if isolated {
        canonical = super::accounts::checked_isolated_home(profile)?;
        canonical.as_path()
    } else {
        profile
    };
    let mut args = vec![std::ffi::OsString::from("acp")];
    // Standalone help and sign-in use the documented bare subcommand. Their
    // isolated HOME points to the same default storage as the runtime does.
    if extra.is_empty() {
        args.extend([
            "--gemini-dir".into(),
            profile.join(".gemini").into_os_string(),
        ]);
        args.extend(
            [
                "--app-data-dir",
                "antigravity-cli",
                "--disable-telemetry",
                "--include-default-customizations=false",
            ]
            .map(std::ffi::OsString::from),
        );
    }
    args.extend(extra.iter().map(std::ffi::OsString::from));
    #[cfg(windows)]
    let mut command = {
        let arguments = args
            .into_iter()
            .map(|arg| {
                arg.into_string()
                    .map_err(|_| "ACP argument is not valid Unicode")
            })
            .collect::<Result<Vec<_>, _>>()?;
        crate::windows_literal_cli_command(executable, &arguments)?
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(executable);
        command.args(args);
        command
    };
    command
        .current_dir(profile.join("workspace"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Never inherit the managed Antigravity-client route back into CPA.
    for (name, _) in std::env::vars_os() {
        let name = name.to_string_lossy();
        let normalized = if cfg!(windows) {
            name.to_ascii_uppercase()
        } else {
            name.to_string()
        };
        if ["GEMINI_", "GOOGLE_", "GCLOUD_", "VERTEX_", "CLIPROXYAPI_"]
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
        {
            command.env_remove(name.as_ref());
        }
    }
    command.env("GEMINI_CLI_HOME", profile);
    if isolated {
        command
            .env("HOME", profile)
            .env("SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 0")
            .env("XDG_CONFIG_HOME", profile.join(".config"))
            .env("XDG_DATA_HOME", profile.join(".local/share"))
            .env("XDG_CACHE_HOME", profile.join(".cache"));
        #[cfg(windows)]
        command
            .env("USERPROFILE", profile)
            .env("APPDATA", profile.join("AppData/Roaming"))
            .env("LOCALAPPDATA", profile.join("AppData/Local"));
    }
    crate::configure_networked_command(&mut command, proxy);
    crate::configure_background_command(&mut command);
    Ok(command)
}

impl Client {
    // ACP 1.0 does not expose identity. Only inspect this owned process's
    // official login-result log, never another profile or credential storage.
    pub(super) fn account_email(&self, profile: &Path) -> Option<String> {
        let directory = profile.join(".gemini/antigravity-cli/log");
        super::accounts::safe_path(&directory).ok()?;
        let suffix = format!("-{}.log", self.child.id());
        let path = std::fs::read_dir(directory)
            .ok()?
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with("acp-server-")
                    && name.ends_with(&suffix)
                    && entry.file_type().is_ok_and(|kind| kind.is_file())
                    && entry
                        .metadata()
                        .ok()
                        .and_then(|metadata| metadata.modified().ok())
                        .is_some_and(|modified| modified >= self.started)
            })
            .max_by_key(|entry| entry.file_name())?
            .path();
        super::accounts::safe_path(&path).ok()?;
        let mut file = std::fs::File::open(path).ok()?;
        let length = file.metadata().ok()?.len();
        file.seek(SeekFrom::Start(length.saturating_sub(512 * 1024)))
            .ok()?;
        let mut bytes = Vec::new();
        file.take(512 * 1024).read_to_end(&mut bytes).ok()?;
        email_from_auth_log(&String::from_utf8_lossy(&bytes))
    }

    pub(super) fn spawn(executable: &Path, profile: &Path, proxy: &str) -> Result<Self, String> {
        std::fs::create_dir_all(profile.join("workspace")).map_err(|e| e.to_string())?;
        Self::spawn_command(command(executable, profile, proxy)?)
    }

    pub(super) fn spawn_command(command: Command) -> Result<Self, String> {
        let started = std::time::SystemTime::now();
        let mut child = crate::spawn_core_child(command)?;
        let mut stdin = child.stdin.take().ok_or("ACP stdin unavailable")?;
        let (input, writes) = mpsc::sync_channel::<WriteRequest>(1);
        std::thread::spawn(move || {
            for (value, reply) in writes {
                let result = (|| {
                    serde_json::to_writer(&mut stdin, &value).map_err(|e| e.to_string())?;
                    stdin
                        .write_all(b"\n")
                        .and_then(|_| stdin.flush())
                        .map_err(|e| format!("ACP write failed: {e}"))
                })();
                let failed = result.is_err();
                if reply.send(result).is_err() || failed {
                    break;
                }
            }
        });
        let stdout = child.stdout.take().ok_or("ACP stdout unavailable")?;
        let (sender, output) = mpsc::sync_channel(128);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let result =
                    std::io::Read::take(&mut reader, 4 * 1024 * 1024).read_until(b'\n', &mut line);
                match result {
                    Ok(0) => {
                        let _ = sender.send(Err("ACP process closed its output".into()));
                        break;
                    }
                    Ok(_) if line.last() != Some(&b'\n') => {
                        let _ = sender.send(Err("ACP frame exceeds 4 MiB".into()));
                        break;
                    }
                    Ok(_) => {
                        if let Ok(value) = serde_json::from_slice(&line) {
                            if sender.send(Ok(value)).is_err() {
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(format!("ACP read failed: {error}")));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            input,
            output,
            next_id: 0,
            supports_logout: false,
            supports_prompt_images: false,
            system_prompt: SystemPromptSupport::default(),
            api_tools: Vec::new(),
            started,
        })
    }

    fn send(
        &self,
        value: Value,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
        deadline: Instant,
    ) -> Result<(), String> {
        let (reply, result) = mpsc::sync_channel(1);
        self.input
            .try_send((value, reply))
            .map_err(|_| "ACP input unavailable")?;
        loop {
            if cancel.load(std::sync::atomic::Ordering::Acquire) {
                return Err("ACP request cancelled".into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("ACP input write timed out".into());
            }
            match result.recv_timeout(remaining.min(Duration::from_millis(100))) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err("ACP input disconnected".into()),
            }
        }
    }

    pub(super) fn call<F>(
        &mut self,
        method: &str,
        params: Value,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
        update: F,
    ) -> Result<Value, String>
    where
        F: FnMut(Value),
    {
        self.call_with_timeout(method, params, cancel, request_timeout(method), update)
            .map_err(RpcFailure::local_message)
    }

    pub(super) fn agent_prompt<F: FnMut(Value)>(
        &mut self,
        params: Value,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
        waits_for_tools: bool,
        update: F,
    ) -> Result<Value, RpcFailure> {
        self.call_with_timeout(
            "session/prompt",
            params,
            cancel,
            if waits_for_tools {
                Duration::from_secs(720)
            } else {
                request_timeout("session/prompt")
            },
            update,
        )
    }

    fn call_with_timeout<F>(
        &mut self,
        method: &str,
        params: Value,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
        timeout: Duration,
        update: F,
    ) -> Result<Value, RpcFailure>
    where
        F: FnMut(Value),
    {
        let result = self.receive_response(method, params, cancel, timeout, update);
        // A timed-out/cancelled stream cannot be reused safely. Stop the owned
        // process before releasing the operation slot, even if the CLI is silent.
        if result.is_err() {
            if let Err(cleanup) = crate::terminate_child(&mut self.child) {
                return Err(format!("Failed to stop ACP process: {cleanup}").into());
            }
        }
        result
    }

    fn receive_response<F>(
        &mut self,
        method: &str,
        params: Value,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
        timeout: Duration,
        mut update: F,
    ) -> Result<Value, RpcFailure>
    where
        F: FnMut(Value),
    {
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err("ACP request cancelled".into());
        }
        let deadline = Instant::now() + timeout;
        let session = params["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        self.next_id += 1;
        let id = self.next_id;
        self.send(
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
            cancel,
            deadline,
        )?;
        loop {
            if cancel.load(std::sync::atomic::Ordering::Acquire) {
                return Err("ACP request cancelled".into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "ACP {method} timed out after {} seconds",
                    timeout.as_secs_f64()
                )
                .into());
            }
            let message = match self
                .output
                .recv_timeout(remaining.min(Duration::from_millis(100)))
            {
                Ok(value) => value?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("ACP output disconnected".into()),
            };
            if message.get("method").is_some() {
                let current_session = session
                    .as_deref()
                    .is_some_and(|id| message["params"]["sessionId"].as_str() == Some(id));
                if let Some(request_id) = message.get("id") {
                    let response = if message["method"] == "session/request_permission" {
                        let tool = &message["params"]["toolCall"];
                        let permitted = current_session
                            && method == "session/prompt"
                            && self.api_tools.iter().any(|name| {
                                [tool["name"].as_str(), tool["title"].as_str()]
                                    .into_iter()
                                    .flatten()
                                    .any(|label| {
                                        label == format!("api_client/{name}")
                                            || label == format!("api_client__{name}")
                                            || label == format!("mcp_api_client_{name}")
                                            || label == format!("mcp__api_client__{name}")
                                    })
                            });
                        let option = message["params"]["options"].as_array().and_then(|options| {
                            options
                                .iter()
                                .find(|option| permitted && option["kind"] == "allow_once")
                        });
                        let outcome = option.map(|option| json!({"outcome":"selected","optionId":option["optionId"]})).unwrap_or_else(||json!({"outcome":"cancelled"}));
                        json!({"jsonrpc":"2.0", "id":request_id, "result":{"outcome":outcome}})
                    } else {
                        json!({"jsonrpc":"2.0", "id":request_id, "error":{"code":-32601,"message":"ACP client capability disabled"}})
                    };
                    self.send(response, cancel, deadline)?;
                } else if current_session && message["method"] == "session/update" {
                    update(message["params"]["update"].clone());
                }
            } else if message["id"] == id {
                if let Some(error) = message.get("error") {
                    return Err(RpcFailure::remote(error));
                }
                return Ok(message["result"].clone());
            }
        }
    }

    pub(super) fn initialize(
        &mut self,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<(), String> {
        self.initialize_with_auth(cancel, false).map(|_| ())
    }

    pub(super) fn initialize_manual(
        &mut self,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<super::manual_auth::LoginAdvertisement, String> {
        let response = self.initialize_with_auth(cancel, true)?;
        Ok(super::manual_auth::TerminalLogin::advertised(&response))
    }

    fn initialize_with_auth(
        &mut self,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
        manual: bool,
    ) -> Result<Value, String> {
        let capabilities = if manual {
            json!({"auth":{"terminal":true}})
        } else {
            json!({})
        };
        let response = self.call("initialize", json!({"protocolVersion":1,"clientCapabilities":capabilities,"clientInfo":{"name":"EasyCLIProxyAPI","version":env!("CARGO_PKG_VERSION")}}), cancel, |_| {})?;
        self.supports_logout = response["agentCapabilities"]["auth"]
            .get("logout")
            .is_some_and(|value| value.is_object() || value == true);
        let capabilities = &response["agentCapabilities"];
        self.supports_prompt_images = capabilities["promptCapabilities"]["image"] == true;
        self.system_prompt = if capabilities["sessionCapabilities"]
            .get("systemPrompt")
            .is_some_and(Value::is_object)
        {
            SystemPromptSupport::Standard
        } else if capabilities["_meta"]["antigravity"]["systemPrompt"]["append"] == true {
            SystemPromptSupport::Antigravity
        } else {
            SystemPromptSupport::Unavailable
        };
        Ok(response)
    }

    pub(super) fn supports_prompt_images(&self) -> bool {
        self.supports_prompt_images
    }

    pub(super) fn logout(
        &mut self,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<(), String> {
        if !self.supports_logout {
            return Err("This official CLI does not support ACP logout. Update Antigravity CLI to sign out or authorize again; alternatively remove this app's local account record.".into());
        }
        self.call("logout", json!({}), cancel, |_| {})?;
        Ok(())
    }

    pub(super) fn session(
        &mut self,
        profile: &Path,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Value, String> {
        self.new_session(profile, "", &[], false, cancel)
    }

    pub(super) fn session_with_system(
        &mut self,
        profile: &Path,
        system: &str,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Value, String> {
        self.api_session(profile, system, &[], cancel)
    }

    pub(super) fn api_session(
        &mut self,
        profile: &Path,
        system: &str,
        servers: &[Value],
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Value, String> {
        self.new_session(profile, system, servers, true, cancel)
    }

    fn new_session(
        &mut self,
        profile: &Path,
        system: &str,
        servers: &[Value],
        restrict_tools: bool,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Value, String> {
        let mut params = json!({"cwd":profile.join("workspace"),"mcpServers":[]});
        if !system.is_empty() {
            match self.system_prompt {
                SystemPromptSupport::Standard => {
                    params["systemPrompt"] = json!({"mode":"append","content":[{"type":"text","text":system}]});
                }
                SystemPromptSupport::Antigravity => {
                    params["_meta"] = json!({"antigravity":{"systemPrompt":{"append":system}}});
                }
                SystemPromptSupport::Unavailable => return Err("The installed ACP CLI does not advertise system instructions support; update Antigravity CLI".into()),
            }
        }
        params["mcpServers"] = json!(servers);
        if restrict_tools {
            params["_meta"]["agy"]["disabledTools"] = json!([
                "list_directory",
                "search_directory",
                "find_file",
                "view_file",
                "create_file",
                "edit_file",
                "run_command",
                "ask_question",
                "start_subagent",
                "invoke_subagent",
                "generate_image",
                "search_web",
                "read_url_content"
            ]);
        }
        self.call("session/new", params, cancel, |_| {})
    }

    pub(super) fn allow_api_tools(&mut self, tools: &[Value]) {
        self.api_tools = tools
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_owned))
            .collect();
    }

    pub(super) fn model(
        &mut self,
        session: &Value,
        model: &str,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<(), String> {
        let available = session["models"]["availableModels"]
            .as_array()
            .ok_or("ACP did not return a model list")?;
        if !available.iter().any(|item| item["modelId"] == model) {
            return Err("Selected model is no longer available; refresh models".into());
        }
        if session["models"]["currentModelId"] != model {
            self.call(
                "session/set_model",
                json!({"sessionId":session["sessionId"],"modelId":model}),
                cancel,
                |_| {},
            )?;
        }
        Ok(())
    }
}

fn email_from_auth_log(log: &str) -> Option<String> {
    let line = log.lines().rev().find(|line| {
        line.contains("server_oauth.go:") && line.contains("] applyAuthResult: email=")
    })?;
    let email = line
        .split_once("] applyAuthResult: email=")?
        .1
        .split_once(',')?
        .0
        .trim();
    valid_account_email(email).map(str::to_owned)
}

pub(super) fn valid_account_email(email: &str) -> Option<&str> {
    let (local, domain) = email.split_once('@')?;
    if local.is_empty()
        || !domain.contains('.')
        || email.len() > 254
        || email
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"'))
        || domain.contains('@')
    {
        return None;
    }
    Some(email)
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = crate::terminate_child(&mut self.child);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn only_structured_error_fields_classify_a_remote_rejection() {
        for status in [
            "INVALID_ARGUMENT",
            "UNAUTHENTICATED",
            "PERMISSION_DENIED",
            "RESOURCE_EXHAUSTED",
            "UNAVAILABLE",
            "DEADLINE_EXCEEDED",
        ] {
            let failure = RpcFailure::remote(
                &json!({"code":-32603,"message":"not the status","data":{"error":{"status":status}}}),
            );
            assert!(
                matches!(failure, RpcFailure::Remote { kind, .. } if !matches!(kind, Rejection::Unknown))
            );
        }
        assert!(matches!(
            RpcFailure::remote(&json!({"code":-32603,"message":"UNAVAILABLE HTTP 503"})),
            RpcFailure::Remote {
                kind: Rejection::Unknown,
                ..
            }
        ));
        assert!(matches!(
            RpcFailure::remote(&json!({"code":-32000,"message":"only local UI detail"})),
            RpcFailure::Remote {
                kind: Rejection::Authentication,
                ..
            }
        ));
    }

    #[test]
    fn identity_uses_only_latest_official_auth_result() {
        let valid = "I1117 01:41:28.850018 98 server_oauth.go:224] applyAuthResult: email=person@example.test, authMethod=consumer, quotaProject=";
        assert_eq!(
            email_from_auth_log(valid).as_deref(),
            Some("person@example.test")
        );
        assert_eq!(
            email_from_auth_log(&format!("{valid}\nunrelated email=other@example.test")).as_deref(),
            Some("person@example.test")
        );
        assert!(
            email_from_auth_log("user said applyAuthResult: email=other@example.test,").is_none()
        );
        for email in ["", "unknown", "a@b@c.test", "person @example.test"] {
            let cleared = format!("{valid}\nI1117 server_oauth.go:224] applyAuthResult: email={email}, authMethod=consumer");
            assert!(email_from_auth_log(&cleared).is_none());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_isolated_launch_handles_absolute_and_verbatim_profile_paths() {
        use super::super::{accounts, prepare_profile};
        let root = crate::unique_test_temp_path("acp Windows profile with spaces");
        let home = root
            .join("accounts")
            .join("a".repeat(32))
            .join(accounts::ISOLATED_HOME);
        prepare_profile(&home).unwrap();
        for path in [&home, &home.canonicalize().unwrap()] {
            let command = command_with_args(Path::new("agy.exe"), path, "", &["--login"]).unwrap();
            let args = command.get_args().collect::<Vec<_>>();
            assert_eq!(args[0], "acp");
            assert_eq!(args.len(), 2);
            assert_eq!(args.last().copied(), Some(std::ffi::OsStr::new("--login")));
            assert!(command
                .get_envs()
                .any(|(key, value)| key == "USERPROFILE" && value == Some(path.as_os_str())));
            assert!(command
                .get_envs()
                .any(|(key, value)| key == "SSH_CONNECTION"
                    && value == Some(std::ffi::OsStr::new("127.0.0.1 0 127.0.0.1 0"))));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    // Executes real child processes on Windows; cross-compilation alone does not run it.
    #[cfg(windows)]
    #[test]
    fn windows_isolated_launch_runs_npm_shims() {
        use super::super::{accounts, prepare_profile};
        let root = crate::unique_test_temp_path("acp Windows & profile");
        let home = root
            .join("accounts")
            .join("a".repeat(32))
            .join(accounts::ISOLATED_HOME);
        prepare_profile(&home).unwrap();
        let script = root.join("probe.mjs");
        std::fs::write(
            script,
            r#"
import assert from 'node:assert/strict';
const root = process.env.USERPROFILE;
assert.equal(process.env.HOME, root);
assert.equal(process.env.GEMINI_CLI_HOME, root);
assert.equal(process.env.SSH_CONNECTION, '127.0.0.1 0 127.0.0.1 0');
assert.deepEqual(process.argv.slice(2), ['acp', '--login']);
console.log('ACP_WINDOWS_FIXTURE_OK');
"#,
        )
        .unwrap();
        for name in ["agy.cmd", "agy.bat"] {
            let shim = root.join(name);
            std::fs::write(&shim, "@echo off\r\nnode \"%dp0%\\probe.mjs\" %*\r\n").unwrap();
            let output = command_with_args(&shim, &home, "", &["--login"])
                .unwrap()
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap().trim(),
                "ACP_WINDOWS_FIXTURE_OK"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires checksum-verified official CLI and a private synthetic Secret Service"]
    fn official_isolated_credential_read_without_authorization() {
        use super::super::{accounts, prepare_profile};
        let executable =
            std::path::PathBuf::from(std::env::var_os("ECPA_ACP_UNAUTHORIZED_PROBE_CLI").unwrap());
        let root = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("ecpa-acp-integrated-"));
        assert_eq!(
            std::env::var_os("DBUS_SESSION_BUS_ADDRESS").unwrap(),
            format!("unix:path={}/bus", root.display()).as_str()
        );
        let control = std::env::var_os("ECPA_ACP_CONTROL_NO_SSH").is_some();
        for (id, marker) in [("a", "{"), ("b", "{}"), ("a", "{")] {
            let directory = root
                .join("accounts")
                .join(id.repeat(32))
                .join(accounts::ISOLATED_HOME);
            prepare_profile(&directory).unwrap();
            let token = accounts::isolated_token(&directory);
            std::fs::create_dir_all(token.parent().unwrap()).unwrap();
            std::fs::write(&token, marker).unwrap();
            let mut command = command(&executable, &directory, "").unwrap();
            if control {
                command.env_remove("SSH_CONNECTION");
            }
            let mut client = Client::spawn_command(command).unwrap();
            let cancel = Arc::new(AtomicBool::new(false));
            client.initialize(&cancel).unwrap();
            assert_eq!(
                client.session(&directory, &cancel).unwrap_err(),
                "Authentication required"
            );
            assert!(client.account_email(&directory).is_none());
        }
    }

    #[test]
    #[ignore]
    fn official_acp_email_probe() {
        let profile = std::path::PathBuf::from(
            std::env::var_os("ECPA_ACP_PROBE_PROFILE").expect("Set profile"),
        );
        let executable =
            std::path::PathBuf::from(std::env::var_os("ECPA_ACP_PROBE_CLI").expect("Set CLI"));
        let cancel = Arc::new(AtomicBool::new(false));
        let mut client = Client::spawn(&executable, &profile, "").unwrap();
        client.initialize(&cancel).unwrap();
        client.session(&profile, &cancel).unwrap();
        assert!(
            client.account_email(&profile).is_some(),
            "Official CLI did not expose an email in its process log"
        );
        println!("Official ACP email extraction passed; identity not printed, no model inference requested.");
    }

    #[test]
    fn unresponsive_server_helper() {
        let Some(mode) = std::env::var_os("ECPA_ACP_RPC_TEST_HELPER") else {
            return;
        };
        if mode == "no-read" {
            std::thread::sleep(Duration::from_secs(15));
            return;
        }
        let mut request = String::new();
        std::io::stdin().read_line(&mut request).unwrap();
        if mode == "permission-session" {
            let prompt: Value = serde_json::from_str(&request).unwrap();
            let mut outcomes = Vec::new();
            for (index, session) in [json!("other"), Value::Null, json!("test")]
                .into_iter()
                .enumerate()
            {
                let id = format!("permission-{index}");
                println!(
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,"method":"session/request_permission","params":{"sessionId":session,"toolCall":{"title":"api_client/lookup"},"options":[{"optionId":"once","kind":"allow_once"}]}})
                );
                std::io::stdout().flush().unwrap();
                let mut reply = String::new();
                std::io::stdin().read_line(&mut reply).unwrap();
                let reply: Value = serde_json::from_str(&reply).unwrap();
                assert_eq!(reply["id"], id);
                outcomes.push(reply["result"]["outcome"].clone());
            }
            println!(
                "{}",
                json!({"jsonrpc":"2.0","id":prompt["id"],"result":outcomes})
            );
            std::io::stdout().flush().unwrap();
            return;
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(15) {
            if mode == "updates" {
                println!(
                    "{}",
                    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"test","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"still working"}}}})
                );
                std::io::stdout().flush().unwrap();
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn unresponsive_client(mode: &str) -> Client {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "acp::rpc::tests::unresponsive_server_helper",
                "--nocapture",
            ])
            .env("ECPA_ACP_RPC_TEST_HELPER", mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::configure_background_command(&mut command);
        Client::spawn_command(command).unwrap()
    }

    #[test]
    fn only_the_active_prompt_can_request_its_declared_tool() {
        let mut client = unresponsive_client("permission-session");
        client.allow_api_tools(&[json!({"function":{"name":"lookup"}})]);
        let outcomes = client
            .call_with_timeout(
                "session/prompt",
                json!({"sessionId":"test"}),
                &Arc::new(AtomicBool::new(false)),
                Duration::from_secs(3),
                |_| {},
            )
            .unwrap();
        assert_eq!(
            outcomes,
            json!([{"outcome":"cancelled"},{"outcome":"cancelled"},{"outcome":"selected","optionId":"once"}])
        );
    }

    #[test]
    fn silent_server_times_out_and_is_reaped() {
        let mut client = unresponsive_client("silent");
        let cancel = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let error = client
            .call_with_timeout(
                "initialize",
                json!({}),
                &cancel,
                Duration::from_millis(100),
                |_| {},
            )
            .unwrap_err()
            .local_message();
        assert!(error.contains("initialize timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(client.child.try_wait().unwrap().is_some());
    }

    #[test]
    fn blocked_input_write_times_out_and_reaps_child() {
        let mut client = unresponsive_client("no-read");
        let cancel = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let error = client
            .call_with_timeout(
                "session/prompt",
                json!({"text":"x".repeat(2*1024*1024)}),
                &cancel,
                Duration::from_millis(150),
                |_| {},
            )
            .unwrap_err()
            .local_message();
        assert!(error.contains("write timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(client.child.try_wait().unwrap().is_some());
    }

    #[test]
    fn progress_updates_do_not_extend_request_deadline() {
        let mut client = unresponsive_client("updates");
        let cancel = Arc::new(AtomicBool::new(false));
        let mut updates = 0;
        let error = client
            .call_with_timeout(
                "session/prompt",
                json!({"sessionId":"test"}),
                &cancel,
                Duration::from_secs(1),
                |_| updates += 1,
            )
            .unwrap_err()
            .local_message();
        assert!(updates > 0);
        assert!(error.contains("session/prompt timed out"), "{error}");
        assert!(client.child.try_wait().unwrap().is_some());
    }

    #[test]
    fn cancellation_interrupts_wait_and_reaps_child() {
        let mut client = unresponsive_client("silent");
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let trigger = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            signal.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let error = client
            .call(
                "session/prompt",
                json!({"sessionId":"test"}),
                &cancel,
                |_| {},
            )
            .unwrap_err();
        trigger.join().unwrap();
        assert_eq!(error, "ACP request cancelled");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(client.child.try_wait().unwrap().is_some());
    }

    #[test]
    fn pre_cancelled_request_is_not_sent() {
        let mut client = unresponsive_client("silent");
        let cancel = Arc::new(AtomicBool::new(true));
        assert_eq!(
            client
                .call("initialize", json!({}), &cancel, |_| {})
                .unwrap_err(),
            "ACP request cancelled"
        );
        assert_eq!(client.next_id, 0);
        assert!(client.child.try_wait().unwrap().is_some());
    }
}
