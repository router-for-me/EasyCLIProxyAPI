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

pub(super) struct Client {
    child: crate::CoreChild,
    input: mpsc::SyncSender<WriteRequest>,
    output: mpsc::Receiver<Result<Value, String>>,
    next_id: u64,
    supports_logout: bool,
    started: std::time::SystemTime,
}

type WriteRequest = (Value, mpsc::SyncSender<Result<(), String>>);

pub(super) fn command(executable: &Path, profile: &Path, proxy: &str) -> Command {
    let mut command = Command::new(executable);
    command
        .args(["acp", "--gemini-dir"])
        .arg(profile.join(".gemini"))
        .args([
            "--app-data-dir",
            "antigravity-cli",
            "--disable-telemetry",
            "--include-default-customizations=false",
        ])
        .current_dir(profile.join("workspace"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Never inherit the managed Antigravity-client route back into CPA.
    for (name, _) in std::env::vars_os() {
        let name = name.to_string_lossy();
        if ["GEMINI_", "GOOGLE_", "GCLOUD_", "VERTEX_", "CLIPROXYAPI_"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            command.env_remove(name.as_ref());
        }
    }
    command.env("GEMINI_CLI_HOME", profile);
    crate::configure_networked_command(&mut command, proxy);
    crate::configure_background_command(&mut command);
    command
}

impl Client {
    // ACP 1.0 does not expose identity. Only inspect this owned process's
    // official login-result log, never another profile or credential storage.
    pub(super) fn account_email(&self, profile: &Path) -> Option<String> {
        let directory = profile.join(".gemini/antigravity-cli/log");
        let suffix = format!("-{}.log", self.child.id());
        let path = std::fs::read_dir(directory)
            .ok()?
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with("acp-server-")
                    && name.ends_with(&suffix)
                    && entry
                        .metadata()
                        .ok()
                        .and_then(|metadata| metadata.modified().ok())
                        .is_some_and(|modified| modified >= self.started)
            })
            .max_by_key(|entry| entry.file_name())?
            .path();
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
        Self::spawn_command(command(executable, profile, proxy))
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
    }

    fn call_with_timeout<F>(
        &mut self,
        method: &str,
        params: Value,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
        timeout: Duration,
        update: F,
    ) -> Result<Value, String>
    where
        F: FnMut(Value),
    {
        let result = self.receive_response(method, params, cancel, timeout, update);
        // A timed-out/cancelled stream cannot be reused safely. Stop the owned
        // process before releasing the operation slot, even if the CLI is silent.
        if let Err(error) = &result {
            crate::terminate_child(&mut self.child)
                .map_err(|cleanup| format!("{error}; failed to stop ACP process: {cleanup}"))?;
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
    ) -> Result<Value, String>
    where
        F: FnMut(Value),
    {
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err("ACP request cancelled".into());
        }
        let deadline = Instant::now() + timeout;
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
                ));
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
                if let Some(request_id) = message.get("id") {
                    let response = if message["method"] == "session/request_permission" {
                        json!({"jsonrpc":"2.0", "id":request_id, "result":{"outcome":{"outcome":"cancelled"}}})
                    } else {
                        json!({"jsonrpc":"2.0", "id":request_id, "error":{"code":-32601,"message":"ACP client capability disabled"}})
                    };
                    self.send(response, cancel, deadline)?;
                } else if message["method"] == "session/update" {
                    update(message["params"]["update"].clone());
                }
            } else if message["id"] == id {
                if let Some(error) = message.get("error") {
                    return Err(error["message"]
                        .as_str()
                        .unwrap_or("ACP request failed")
                        .to_string());
                }
                return Ok(message["result"].clone());
            }
        }
    }

    pub(super) fn initialize(
        &mut self,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<(), String> {
        let response = self.call("initialize", json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"EasyCLIProxyAPI","version":env!("CARGO_PKG_VERSION")}}), cancel, |_| {})?;
        self.supports_logout = response["agentCapabilities"]["auth"]
            .get("logout")
            .is_some_and(|value| !value.is_null());
        Ok(())
    }

    pub(super) fn logout(
        &mut self,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<(), String> {
        if !self.supports_logout {
            return Err("This official CLI does not support ACP logout; update Antigravity CLI to switch accounts".into());
        }
        self.call("logout", json!({}), cancel, |_| {})?;
        Ok(())
    }

    pub(super) fn session(
        &mut self,
        profile: &Path,
        cancel: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Value, String> {
        self.call(
            "session/new",
            json!({"cwd":profile.join("workspace"),"mcpServers":[]}),
            cancel,
            |_| {},
        )
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
    Some(email.to_string())
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
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(15) {
            if mode == "updates" {
                println!(
                    "{}",
                    json!({"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"still working"}}}})
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
            .unwrap_err();
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
            .unwrap_err();
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
            .unwrap_err();
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
